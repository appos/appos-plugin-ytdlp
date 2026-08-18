/**
 * Public Action Fabric registration.
 *
 * Projects the plugin's user-facing verbs into the typed action catalog
 * so they gain schema validation, ActionReceipt audit rows, rate
 * limiting, Settings → Actions browsing, and cross-plugin/agent
 * invocability — see the public SDK docs at https://docs.appos.space.
 *
 * ## Strategy
 *
 * - The 5 existing palette commands stay registered on the permanent
 *   `commands.register` surface (main.ts step 8) and are BRIDGED via
 *   `actions.registerFromCommand(...)` — the sanctioned migration helper
 *   that dispatches into the legacy command handler without duplicating
 *   it. `metadata.risk` is required by the bridge; `displayName` falls
 *   back to the live command title.
 * - One NEW native action, `downloadUrl`, wraps `enqueueAndProcess`
 *   with a typed input schema (`{url, format?, quality?}`). It carries
 *   `agent` visibility so the host projects a ToolSpec and CLIChat /
 *   LLM agents can trigger downloads — the highest-value addition for
 *   a downloader plugin.
 *
 * ## Host compatibility
 *
 * `ctx.actions` is declared non-optional by `@appos.space/plugin-types`
 * v3 (host 1.0.0 launch baseline), but the runtime guard below is kept
 * so the plugin degrades gracefully on a pre-1.0 host: registration is
 * skipped silently and the legacy command surface keeps working
 * unchanged.
 *
 * @module actions/register-actions
 */

import type { PluginContext } from '@appos.space/plugin-types';

import * as state from '../core/state';
import { isValidMediaUrl } from '../core/security';
import { enqueueAndProcess } from '../services/downloader';

/** Manifest settings enums, mirrored for the downloadUrl input schema. */
const FORMAT_VALUES = ['best', 'mp4', 'webm', 'mp3', 'm4a', 'bestaudio'] as const;
const QUALITY_VALUES = ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p'] as const;

/**
 * Validated input shape for the `downloadUrl` action.
 *
 * MUST stay a `type` alias (not an `interface`): the handler narrows
 * `exec.input` — typed `AnyJSONValue` by SDK v3 — with
 * `as DownloadUrlInput`, and interfaces get no implicit index
 * signature, so an interface target is not comparable to
 * `AnyJSONValue`'s object arm (TS2352). Pinned by the SDK's own
 * `actions.typetest.ts`.
 */
type DownloadUrlInput = {
    url: string;
    format?: string;
    quality?: string;
};

/**
 * Register all public actions. Returns disposers that unregister the
 * action handle tokens (registrations also auto-cancel on plugin
 * deactivation per ADR-002 — explicit unregister keeps the disposable
 * drain symmetrical with every other registration in main.ts).
 *
 * Each registration is individually try/caught so one failure never
 * blocks the rest (same per-item resilience as the command
 * registrations in main.ts).
 *
 * @param ctx - Plugin context (must be the same context commands were
 *   registered on, so registerFromCommand can resolve them).
 * @returns Array of async disposers for successfully registered actions.
 */
export async function registerActions(
    ctx: PluginContext,
): Promise<Array<() => void | Promise<void>>> {
    const actions = ctx.actions;
    if (!actions) {
        console.info('[yt-dlp] context.actions unavailable — skipping public action registration (older host)');
        return [];
    }

    const disposers: Array<() => void | Promise<void>> = [];

    /** Track a handle token as an idempotent unregister disposer. */
    const track = (token: string): void => {
        disposers.push(async () => {
            try {
                await actions.unregister(token);
            } catch { /* best effort — auto-cancelled on deactivate anyway */ }
        });
    };

    // ── Bridge the 5 legacy palette commands (registerFromCommand) ──
    // Metadata mirrors the manifest `actions.definition` contributions
    // in plugin.json (two-tier discovery: manifest rows surface in the
    // palette before JS runs; these calls bind the executable handler).

    const bridged: Array<{
        commandId: string;
        metadata: Parameters<typeof actions.registerFromCommand>[1];
    }> = [
        {
            commandId: 'recheck-dependencies',
            metadata: {
                displayName: 'Re-check Dependencies',
                description: 'Re-probe yt-dlp and ffmpeg availability and versions.',
                visibility: ['palette', 'automation'],
                risk: 'read',
                approval: 'auto',
                icon: 'arrow.triangle.2.circlepath',
                tags: ['yt-dlp', 'dependencies'],
            },
        },
        {
            commandId: 'open-download-panel',
            metadata: {
                displayName: 'Open yt-dlp Downloader',
                description: 'Apply the yt-dlp workspace and show the download panel.',
                visibility: ['palette'],
                risk: 'read',
                approval: 'auto',
                icon: 'arrow.down.circle',
                tags: ['yt-dlp', 'download'],
            },
        },
        {
            commandId: 'open-library-panel',
            metadata: {
                displayName: 'Open yt-dlp Library',
                description: 'Apply the yt-dlp workspace and show the library panel.',
                visibility: ['palette'],
                risk: 'read',
                approval: 'auto',
                icon: 'books.vertical',
                tags: ['yt-dlp', 'library'],
            },
        },
        {
            commandId: 'clear-completed',
            metadata: {
                displayName: 'Clear Completed Downloads',
                description: 'Remove complete, failed, and cancelled entries from the download queue.',
                visibility: ['palette', 'automation'],
                risk: 'write',
                approval: 'auto',
                icon: 'xmark.circle',
                tags: ['yt-dlp', 'queue'],
            },
        },
        {
            commandId: 'paste-and-download',
            metadata: {
                displayName: 'Paste & Download',
                description: 'Read a media URL from the clipboard and download it with default settings.',
                visibility: ['palette', 'api', 'agent', 'automation'],
                risk: 'external',
                approval: 'auto',
                icon: 'doc.on.clipboard',
                tags: ['yt-dlp', 'download', 'clipboard'],
            },
        },
    ];

    for (const { commandId, metadata } of bridged) {
        try {
            const token = await actions.registerFromCommand(commandId, metadata);
            track(token);
        } catch (err) {
            console.warn(`[yt-dlp] actions.registerFromCommand(${commandId}) failed:`, err);
        }
    }

    // ── New typed action: downloadUrl ────────────────────────────────
    // The programmatic download surface: cross-plugin callable (api),
    // ToolSpec-projected for LLM agents (agent), and schedulable /
    // recipe-callable (automation). Not palette-visible — the palette
    // flow already has Paste & Download and the download panel form.

    try {
        const token = await actions.register(
            {
                id: 'downloadUrl',
                displayName: 'Download Media URL',
                description:
                    'Download a media URL with yt-dlp into the configured output directory. '
                    + 'Optional format/quality override; defaults come from plugin settings.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'Media page URL (http/https) supported by yt-dlp.',
                        },
                        format: {
                            type: 'string',
                            enum: [...FORMAT_VALUES],
                            description: 'Container/format override. Defaults to the defaultFormat setting.',
                        },
                        quality: {
                            type: 'string',
                            enum: [...QUALITY_VALUES],
                            description: 'Quality cap override. Defaults to the defaultQuality setting.',
                        },
                    },
                    required: ['url'],
                    additionalProperties: false,
                },
                outputSchema: {
                    type: 'object',
                    properties: {
                        enqueuedIds: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Queue entry ids created for this request.',
                        },
                    },
                    required: ['enqueuedIds'],
                },
                visibility: ['api', 'agent', 'automation'],
                risk: 'external',
                approval: 'auto',
                icon: 'arrow.down.circle',
                tags: ['yt-dlp', 'download', 'media'],
            },
            async (exec) => {
                const input = exec.input as DownloadUrlInput;
                const url = input.url.trim();

                const urlResult = isValidMediaUrl(url);
                if (!urlResult.ok) {
                    throw new Error(`Invalid media URL: ${urlResult.reason}`);
                }

                const settings = state.getSettingsSnapshot();
                const enqueuedIds = await enqueueAndProcess(url, {
                    format: input.format ?? settings.defaultFormat,
                    quality: input.quality ?? settings.defaultQuality,
                    outputDir: settings.outputDir,
                    filenameTemplate: settings.filenameTemplate || '%(title)s.%(ext)s',
                    proxyUrl: settings.proxyUrl || undefined,
                });

                if (enqueuedIds.length === 0) {
                    // enqueueAndProcess surfaces the specific reason via toast;
                    // fail the receipt with an actionable message.
                    throw new Error(
                        'URL was not enqueued — check that the download directory is set in plugin settings and the URL is valid.',
                    );
                }

                return { enqueuedIds };
            },
        );
        track(token);
    } catch (err) {
        console.warn('[yt-dlp] actions.register(downloadUrl) failed:', err);
    }

    return disposers;
}
