/**
 * Download WebPanel — plugin-side registration and message handlers.
 *
 * Registers the download panel with the host, wires up the message handler
 * that validates inbound messages via `parseInbound` and routes them to
 * form-side handlers (probe, enqueue, CLI preview, dependency recheck)
 * and queue-side handlers (cancel, retry, pause/resume, clear, reveal).
 *
 * A `state.subscribe` listener broadcasts throttled `queue-update` messages
 * at 10 Hz so the webview queue view stays reactive during downloads.
 *
 * Returns a disposer that tears down every subscription this module creates.
 *
 * @module download-panel
 */

import type { PluginContext } from '@appos.space/plugin-types';
import type { PanelInboundMessage } from '../types/webview-messages';

import { PANELS } from '../constants';
import { parseInbound } from '../types/webview-messages';
import { isValidMediaUrl, sanitizeYtDlpArgs, sanitizeFilenameTemplate } from '../core/security';
import { validateOutputDir, archivePathFor, tempDirFor } from '../core/paths';
import * as state from '../core/state';
import * as metadataService from '../services/metadata-service';
import * as playlistService from '../services/playlist-service';
import * as downloader from '../services/downloader';

// ── Shared pre-validation ─────────────────────────────────────────

/**
 * Pre-validate webview-supplied download options at the panel boundary.
 *
 * Runs the same sanitization pipeline used by CLI preview so denied flags,
 * invalid templates, and bad URLs are caught identically in both paths.
 * Returns sanitized values on success, or an error string on failure.
 *
 * Note: `enqueueAndProcess` also validates internally (defense in depth),
 * but pre-validating here ensures the panel boundary never passes raw
 * untrusted input downstream, and provides consistent error messaging.
 */
function preValidateEnqueueArgs(
    ctx: PluginContext,
    url: string,
    opts: {
        filenameTemplate: string;
        advancedArgs?: string[];
    },
): { ok: true; template: string; args: string[] } | { ok: false; error: string } {
    const urlCheck = isValidMediaUrl(url);
    if (!urlCheck.ok) {
        return { ok: false, error: 'Invalid URL' };
    }

    const argsResult = sanitizeYtDlpArgs(opts.advancedArgs ?? []);
    if (!argsResult.ok) {
        return { ok: false, error: `Blocked flags: ${argsResult.rejected.join(', ')}` };
    }

    const templateResult = sanitizeFilenameTemplate(opts.filenameTemplate);
    if (!templateResult.ok) {
        return { ok: false, error: `Invalid filename template: ${templateResult.reason}` };
    }

    return { ok: true, template: templateResult.template, args: argsResult.args };
}

/**
 * Register the download panel and wire form-side message handlers.
 *
 * @param ctx - The plugin context provided by the host.
 * @returns A disposer that cleans up every subscription created.
 */
export async function registerDownloadPanel(
    ctx: PluginContext,
): Promise<() => void> {
    // Step 1: Register the panel with the host
    ctx.ui.registerWebPanel(PANELS.DOWNLOAD, {
        title: 'Downloads',
        icon: 'arrow.down.circle',
        htmlPath: 'webview/download/index.html',
        allowNavigation: false,
    });

    // Step 2: Register for state broadcasts (Branch A — panel-ID fan-out)
    state.registerPanelForBroadcast(PANELS.DOWNLOAD);

    // Step 3: Message handler — form-side routing.
    // Uses typed record dispatch on PanelInboundMessage.type (not
    // createActionRouter, which is designed for string-based "prefix:arg"
    // action routing — our messages are typed discriminated unions).
    const formHandlers: Record<string, (msg: PanelInboundMessage) => void | Promise<void>> = {
        'request-state': () => {
            state.emitStateUpdate();
        },

        'probe-url': async (msg) => {
            const m = msg as PanelInboundMessage & { probeId: string; url: string };
            const pbId = m.probeId;
            if (typeof pbId !== 'string' || !pbId) return;

            const result = await metadataService.probeUrl(ctx, m.url);

            if (result.kind === 'video') {
                ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                    v: 1,
                    type: 'probe-result',
                    probeId: pbId,
                    url: m.url,
                    metadata: result.metadata,
                    formats: result.formats,
                });
            } else if (result.kind === 'playlist') {
                // Detected a playlist — also probe for entries
                const plResult = await playlistService.probePlaylist(ctx, result.playlistUrl);
                if (plResult.kind === 'ok') {
                    ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                        v: 1,
                        type: 'playlist-data',
                        probeId: pbId,
                        playlistUrl: m.url,
                        playlistTitle: plResult.result.playlistTitle,
                        entries: plResult.result.entries,
                        groupTag: plResult.result.groupTag,
                        groupLabel: plResult.result.groupLabel,
                        totalCount: plResult.result.totalCount,
                    });
                } else {
                    ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                        v: 1,
                        type: 'probe-error',
                        probeId: pbId,
                        url: m.url,
                        error: plResult.error,
                    });
                }
            } else {
                ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                    v: 1,
                    type: 'probe-error',
                    probeId: pbId,
                    url: m.url,
                    error: result.error,
                });
            }
        },

        'queue-download': async (msg) => {
            const m = msg as PanelInboundMessage & {
                requestId: string;
                url: string;
                format: string;
                quality: string;
                advancedArgs?: string[];
                proxyUrl?: string;
                filenameTemplate?: string;
            };

            const reqId = m.requestId;
            if (typeof reqId !== 'string' || !reqId) return;
            const settings = state.getSettingsSnapshot();
            const template = m.filenameTemplate || settings.filenameTemplate || '%(title)s.%(ext)s';

            const validation = preValidateEnqueueArgs(ctx, m.url, {
                filenameTemplate: template,
                advancedArgs: m.advancedArgs,
            });
            if (!validation.ok) {
                ctx.feedback.toast(validation.error, { kind: 'error' });
                ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                    v: 1,
                    type: 'enqueue-ack',
                    requestId: reqId,
                    ok: false,
                    count: 0,
                    error: validation.error,
                });
                return;
            }

            const ids = await downloader.enqueueAndProcess(m.url, {
                format: m.format,
                quality: m.quality,
                outputDir: settings.outputDir,
                filenameTemplate: validation.template,
                proxyUrl: m.proxyUrl || settings.proxyUrl,
                advancedArgs: validation.args,
            });

            if (ids.length > 0) {
                state.addToHistory(m.url);
            }

            ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                v: 1,
                type: 'enqueue-ack',
                requestId: reqId,
                ok: ids.length > 0,
                count: ids.length,
                ...(ids.length === 0 ? { error: 'No items could be enqueued' } : {}),
            });
        },

        'queue-playlist': async (msg) => {
            const m = msg as PanelInboundMessage & {
                requestId: string;
                playlistUrl: string;
                selectedEntries: { id: string; url: string; title: string }[];
                format: string;
                quality: string;
                groupTag: string;
                groupLabel: string;
                advancedArgs?: string[];
                proxyUrl?: string;
                filenameTemplate?: string;
            };

            const reqId = m.requestId;
            if (typeof reqId !== 'string' || !reqId) return;

            const settings = state.getSettingsSnapshot();
            const template = m.filenameTemplate || settings.filenameTemplate || '%(title)s.%(ext)s';

            // Pre-validate using playlist URL (per-entry URLs validated by enqueueAndProcess)
            const validation = preValidateEnqueueArgs(ctx, m.playlistUrl, {
                filenameTemplate: template,
                advancedArgs: m.advancedArgs,
            });
            if (!validation.ok) {
                ctx.feedback.toast(validation.error, { kind: 'error' });
                ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                    v: 1,
                    type: 'enqueue-ack',
                    requestId: reqId,
                    ok: false,
                    count: 0,
                    error: validation.error,
                });
                return;
            }

            const urls = m.selectedEntries.map((e) => e.url);
            const ids = await downloader.enqueueAndProcess(urls, {
                format: m.format,
                quality: m.quality,
                outputDir: settings.outputDir,
                filenameTemplate: validation.template,
                proxyUrl: m.proxyUrl || settings.proxyUrl,
                advancedArgs: validation.args,
                groupTag: m.groupTag,
                groupLabel: m.groupLabel,
            });

            if (ids.length > 0) {
                state.addToHistory(m.playlistUrl);
            }

            ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                v: 1,
                type: 'enqueue-ack',
                requestId: reqId,
                ok: ids.length > 0,
                count: ids.length,
                ...(ids.length === 0 ? { error: 'No items could be enqueued' } : {}),
            });
        },

        'request-cli-preview': async (msg) => {
            const m = msg as PanelInboundMessage & {
                previewId: string;
                url: string;
                format: string;
                quality: string;
                advancedArgs?: string[];
                proxyUrl?: string;
                filenameTemplate?: string;
            };

            const pvId = m.previewId;

            // Reject requests without a valid previewId — prevents uncorrelated
            // broadcast responses that bypass multi-instance isolation.
            if (typeof pvId !== 'string' || !pvId) return;

            // Shared validation — same pipeline as enqueue handlers
            const settings = state.getSettingsSnapshot();
            const template = m.filenameTemplate || settings.filenameTemplate || '%(title)s.%(ext)s';

            const validation = preValidateEnqueueArgs(ctx, m.url, {
                filenameTemplate: template,
                advancedArgs: m.advancedArgs,
            });
            if (!validation.ok) {
                ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                    v: 1,
                    type: 'cli-preview',
                    previewId: pvId,
                    error: validation.error,
                });
                return;
            }

            // Validate output directory
            const dirResult = validateOutputDir(settings.outputDir);
            if (!dirResult.ok) {
                ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                    v: 1,
                    type: 'cli-preview',
                    previewId: pvId,
                    error: 'Output directory not set \u2014 check plugin settings',
                });
                return;
            }

            // Build args using downloader's buildYtdlpArgs with validated values
            const args = downloader.buildYtdlpArgs(
                { url: m.url, format: m.format, quality: m.quality },
                {
                    format: m.format,
                    quality: m.quality,
                    outputDir: dirResult.resolved,
                    filenameTemplate: validation.template,
                    proxyUrl: m.proxyUrl || settings.proxyUrl,
                    advancedArgs: validation.args,
                },
            );

            ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                v: 1,
                type: 'cli-preview',
                previewId: pvId,
                args,
            });
        },

        'recheck-dependencies': () => {
            ctx.lifecycle.recheckDependencies();
        },
    };

    // Step 4: Queue-side handlers — actions on existing queue entries
    const queueHandlers: Record<string, (msg: PanelInboundMessage) => void | Promise<void>> = {
        'cancel-download': async (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id === 'string' && m.id) {
                await downloader.cancelDownload(m.id);
            }
        },

        'retry-download': (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id === 'string' && m.id) {
                downloader.retryDownload(m.id);
            }
        },

        'pause-queue': () => {
            downloader.setQueuePaused(true);
        },

        'resume-queue': () => {
            downloader.setQueuePaused(false);
            downloader.processQueue();
        },

        'clear-completed': () => {
            // Snapshot IDs first — removeQueueEntry mutates the live array,
            // so iterating and removing in the same pass can skip entries.
            const ids = state.getQueue()
                .filter((e) => e.status === 'complete' || e.status === 'failed' || e.status === 'cancelled')
                .map((e) => e.id);
            for (const id of ids) {
                state.removeQueueEntry(id);
            }
        },

        'toggle-view': () => {
            // Ack only — the webview owns view state. Useful for telemetry.
        },

        'reveal-file': (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id !== 'string' || !m.id) return;

            // Prefer finalFileUrl (already a well-formed file:// URL) from the
            // queue entry, falling back to constructing one from finalFilePath.
            const entry = state.getQueue().find((e) => e.id === m.id);
            if (!entry) return;

            let parentUrl: string | null = null;

            // URL is typed `URLConstructor | undefined` by the SDK globals
            // subpath (absent on pre-injection hosts / menu-bar contexts /
            // host kill switch): skipping this block falls through to the
            // path-based approach, matching the former
            // ReferenceError-into-catch path when the constructor is missing.
            if (entry.finalFileUrl && typeof URL === 'function') {
                // Derive parent from the canonical file URL (handles encoding).
                // Only trust file: protocol — other schemes must not reach openInPane.
                try {
                    const fileUrl = new URL(entry.finalFileUrl);
                    if (fileUrl.protocol === 'file:') {
                        // The host-injected URL's accessors are READONLY
                        // (assignment is a no-op / TypeError), so build the
                        // parent URL from the percent-encoded pathname
                        // instead of mutating `pathname` and re-reading
                        // `href`. Root-level files (empty parent) fall
                        // through to the path-based approach.
                        const pathParts = fileUrl.pathname.split('/');
                        pathParts.pop(); // remove filename
                        const parentPath = pathParts.join('/');
                        if (parentPath) parentUrl = 'file://' + parentPath;
                    }
                } catch {
                    // Malformed URL — fall through to path-based approach
                }
            }

            if (!parentUrl && entry.finalFilePath) {
                // Build a properly-encoded file:// URL from the raw POSIX path.
                // Per-segment encodeURIComponent handles #, ?, %, and other
                // characters that encodeURI leaves unescaped.
                const lastSlash = entry.finalFilePath.lastIndexOf('/');
                const parentDir = lastSlash > 0 ? entry.finalFilePath.slice(0, lastSlash) : '/';
                const encoded = parentDir
                    .split('/')
                    .map((seg) => (seg ? encodeURIComponent(seg) : ''))
                    .join('/');
                parentUrl = 'file://' + encoded;
            }

            if (parentUrl) {
                ctx.ui.openInPane(parentUrl, { pane: 'right' });
            }
        },
    };

    // Step 5: Throttled queue-update broadcast via state.subscribe
    // Broadcasts { v:1, type:'queue-update', entries } at 10 Hz so the
    // webview queue view stays reactive during rapid progress ticks.
    // NOTE: Hand-rolled throttle (not @appos.space/plugin-utils throttle)
    // because the SDK utility requires setTimeout unconditionally — JSC
    // runtimes may not provide timers, so we need the no-timer fallback.
    let throttledBroadcast: (() => void) | null = null;
    // Plain `number`: setTimeout is typed `| undefined` in the JSC env
    // (src/jsc-globals.d.ts), so ReturnType<typeof setTimeout> no longer
    // satisfies the (...args) => any constraint.
    let throttleTimer: number | undefined;

    if (typeof setTimeout === 'function') {
        let lastBroadcast = 0;
        throttledBroadcast = () => {
            const now = Date.now();
            const remaining = 100 - (now - lastBroadcast);
            clearTimeout?.(throttleTimer);
            if (remaining <= 0) {
                lastBroadcast = now;
                ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                    v: 1,
                    type: 'queue-update',
                    entries: [...state.getQueue()],
                });
            } else {
                throttleTimer = setTimeout(() => {
                    lastBroadcast = Date.now();
                    ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                        v: 1,
                        type: 'queue-update',
                        entries: [...state.getQueue()],
                    });
                }, remaining);
            }
        };
    } else {
        // No timers — synchronous broadcast on every state change
        throttledBroadcast = () => {
            ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                v: 1,
                type: 'queue-update',
                entries: [...state.getQueue()],
            });
        };
    }

    const unsubscribeQueue = state.subscribe(throttledBroadcast);

    // Step 6: Wire message handler — onWebPanelMessage returns void (no unsubscribe).
    // Guard against double-fire after deactivate by checking a disposed flag.
    let disposed = false;

    ctx.ui.onWebPanelMessage(PANELS.DOWNLOAD, (envelope) => {
        if (disposed) return;

        const parsed = parseInbound(envelope.data);
        if (!parsed) {
            // parseInbound already logs a redacted summary (keys only, no values)
            return;
        }

        const handler = formHandlers[parsed.type] ?? queueHandlers[parsed.type];
        if (handler) {
            Promise.resolve().then(() => handler(parsed)).catch((err) => {
                // Log redacted summary — never include raw error which may
                // contain user URLs, proxy credentials, or custom args
                const errName = err instanceof Error ? err.constructor.name : 'unknown';
                console.error(`[yt-dlp] Handler "${parsed.type}" failed (${errName})`);

                // Send fallback error payloads so the webview recovers visibly
                if (parsed.type === 'probe-url') {
                    // Cast: type narrowing already checked parsed.type but the
                    // catch block loses union narrowing — runtime-checked below
                    const pbId = (parsed as any).probeId;
                    if (typeof pbId === 'string' && pbId) {
                        const url = (parsed as any).url ?? '';
                        ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                            v: 1,
                            type: 'probe-error',
                            probeId: pbId,
                            url,
                            error: { message: 'Internal error during probe', category: 'unknown' as const, raw: '', recoverable: false },
                        });
                    }
                } else if (parsed.type === 'request-cli-preview') {
                    // Cast: same catch-block narrowing loss — runtime-checked below
                    const pvId = (parsed as any).previewId;
                    if (typeof pvId === 'string' && pvId) {
                        ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                            v: 1,
                            type: 'cli-preview',
                            previewId: pvId,
                            error: 'Internal error generating preview',
                        });
                    }
                } else if (parsed.type === 'queue-download' || parsed.type === 'queue-playlist') {
                    ctx.feedback.toast(
                        'Download failed to enqueue \u2014 please try again',
                        { kind: 'error' },
                    );
                    // Cast: same catch-block narrowing loss — runtime-checked below
                    const reqId = (parsed as any).requestId;
                    if (typeof reqId === 'string' && reqId) {
                        ctx.ui.postToWebPanel(PANELS.DOWNLOAD, {
                            v: 1,
                            type: 'enqueue-ack',
                            requestId: reqId,
                            ok: false,
                            count: 0,
                            error: 'Internal error during enqueue',
                        });
                    }
                }
            });
        }
    });

    // Return disposer — clean up the queue-update subscription and
    // disable the message handler. onWebPanelMessage has no SDK-level
    // unsubscribe (returns void), so we use the `disposed` flag to
    // no-op incoming messages after teardown.
    return () => {
        disposed = true;
        if (typeof clearTimeout === 'function' && throttleTimer !== undefined) {
            clearTimeout(throttleTimer);
        }
        unsubscribeQueue();
    };
}
