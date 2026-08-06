/**
 * Library WebPanel -- plugin-side registration and message handlers.
 *
 * Registers the library panel with the host, wires up the message handler
 * that validates inbound messages via `parseInbound` and routes them to
 * library-specific handlers (play, reveal, delete, copy URL, redownload,
 * toggle favorite).
 *
 * A `state.subscribe` listener broadcasts throttled `library-update` messages
 * at 10 Hz so the webview library view stays reactive.
 *
 * Returns a disposer that tears down every subscription this module creates.
 *
 * @module library-panel
 */

import type { PluginContext } from '@appos.space/plugin-types';
import type { PanelInboundMessage } from '../types/webview-messages';

import { PANELS } from '../constants';
import { parseInbound } from '../types/webview-messages';
import * as state from '../core/state';
import * as downloader from '../services/downloader';

/**
 * Register the library panel and wire message handlers.
 *
 * @param ctx - The plugin context provided by the host.
 * @returns A disposer that cleans up every subscription created.
 */
export async function registerLibraryPanel(
    ctx: PluginContext,
): Promise<() => void> {
    // Step 1: Register the panel with the host
    ctx.ui.registerWebPanel(PANELS.LIBRARY, {
        title: 'Library',
        icon: 'books.vertical',
        htmlPath: 'webview/library/index.html',
        allowNavigation: false,
    });

    // Step 2: Register for state broadcasts (Branch A -- panel-ID fan-out)
    state.registerPanelForBroadcast(PANELS.LIBRARY);

    // Step 3: Message handlers -- library-side routing.
    // Uses typed record dispatch on PanelInboundMessage.type (not
    // createActionRouter, which parses "prefix:arg" strings — our
    // messages are typed discriminated unions).
    const handlers: Record<string, (msg: PanelInboundMessage) => void | Promise<void>> = {
        'request-state': () => {
            state.emitStateUpdate();
        },

        'play-file': (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id !== 'string' || !m.id) return;

            const entry = state.getLibrary().find((e) => e.id === m.id);
            if (!entry) return;

            ctx.ui.openInPane(entry.fileUrl);
        },

        'reveal-file': (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id !== 'string' || !m.id) return;

            const entry = state.getLibrary().find((e) => e.id === m.id);
            if (!entry) return;

            // Derive parent directory URL from the file URL or path.
            // "Show in Files pane" -- opens the parent directory in the
            // right pane's file browser (NOT macOS "Reveal in Finder").
            let parentUrl: string | null = null;

            // URL is typed `| undefined` (absent in bare JSC — see
            // src/types/jsc-url.d.ts): skipping this block falls through to
            // the path-based approach, matching the former
            // ReferenceError-into-catch path when the constructor is missing.
            if (entry.fileUrl && typeof URL === 'function') {
                try {
                    const fileUrl = new URL(entry.fileUrl);
                    if (fileUrl.protocol === 'file:') {
                        const pathParts = fileUrl.pathname.split('/');
                        pathParts.pop(); // remove filename
                        fileUrl.pathname = pathParts.join('/');
                        parentUrl = fileUrl.href;
                    }
                } catch {
                    // Malformed URL -- fall through to path-based approach
                }
            }

            if (!parentUrl && entry.filePath) {
                // Build a properly-encoded file:// URL from the raw POSIX path.
                // Per-segment encodeURIComponent handles #, ?, %, and other
                // characters that encodeURI leaves unescaped.
                const lastSlash = entry.filePath.lastIndexOf('/');
                const parentDir = lastSlash > 0 ? entry.filePath.slice(0, lastSlash) : '/';
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

        'delete-item': async (msg) => {
            const m = msg as PanelInboundMessage & { id: string; deleteFromDisk?: boolean };
            if (typeof m.id !== 'string' || !m.id) return;

            const entry = state.getLibrary().find((e) => e.id === m.id);
            if (!entry) return;

            if (m.deleteFromDisk) {
                // Two-step delete: plugin-side destructive confirmation.
                // The spec references `feedback.confirm` as the permission name
                // in plugin.json. The SDK implements this via `feedback.alert()`
                // which shows an NSAlert and returns the 0-based button index.
                // There is no separate `feedback.confirm()` method in the SDK;
                // `feedback.alert` with `style: 'critical'` and explicit button
                // labels IS the confirmation dialog backed by that permission.
                const btnIndex = await ctx.feedback.alert(
                    'Delete file from disk?',
                    {
                        informativeText: `This will permanently delete "${entry.title}" from your disk. This cannot be undone.`,
                        buttons: ['Delete', 'Cancel'],
                        style: 'critical',
                    },
                );

                // Button 0 = "Delete" (confirmed), 1 = "Cancel"
                if (btnIndex !== 0) return;

                // Delete file from disk FIRST. If it fails, do NOT touch state.
                try {
                    await ctx.fileOps.delete([entry.fileUrl]);
                } catch (err) {
                    const errName = err instanceof Error ? err.constructor.name : 'Error';
                    console.error('[yt-dlp] fileOps.delete failed:', errName);
                    ctx.feedback.toast('Failed to delete file — check permissions and try again.', { kind: 'error' });
                    return;
                }

                // Only remove from library after successful disk delete.
                state.removeFromLibrary(m.id);
            } else {
                // Non-destructive: remove from library index only, file stays on disk.
                state.removeFromLibrary(m.id);
            }
        },

        'copy-url': (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id !== 'string' || !m.id) return;

            const entry = state.getLibrary().find((e) => e.id === m.id);
            if (!entry) return;

            ctx.clipboard.write(entry.sourceUrl);
            ctx.feedback.toast('URL copied', { kind: 'success' });
        },

        'redownload': async (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id !== 'string' || !m.id) return;

            const entry = state.getLibrary().find((e) => e.id === m.id);
            if (!entry || !entry.request) return;

            // Rebuild EnqueueOptions from the persisted QueueRequestSnapshot.
            // Honors the exact format, quality, template, proxy, and args
            // the user originally chose -- NOT current settings defaults.
            let ids: string[];
            try {
                ids = await downloader.enqueueAndProcess(entry.sourceUrl, {
                    format: entry.request.format,
                    quality: entry.request.quality,
                    outputDir: entry.request.outputDir,
                    filenameTemplate: entry.request.filenameTemplate,
                    proxyUrl: entry.request.proxyUrl,
                    advancedArgs: entry.request.advancedArgs,
                });
            } catch (err) {
                // Log redacted error class only -- err.message may contain
                // source URLs, proxy credentials, or custom args.
                const errName = err instanceof Error ? err.constructor.name : 'unknown';
                console.error(`[yt-dlp] Redownload failed (${errName})`);
                ctx.feedback.toast('Re-download failed \u2014 please try again', { kind: 'error' });
                return;
            }

            if (ids.length === 0) {
                ctx.feedback.toast('Failed to re-enqueue download', { kind: 'error' });
            } else {
                ctx.feedback.toast('Re-downloading...', { kind: 'success' });
            }
        },

        'toggle-favorite': (msg) => {
            const m = msg as PanelInboundMessage & { id: string };
            if (typeof m.id !== 'string' || !m.id) return;

            state.toggleFavorite(m.id);
        },

        'recheck-dependencies': () => {
            ctx.lifecycle.recheckDependencies();
        },
    };

    // Step 4: Throttled library-update broadcast via state.subscribe
    // Broadcasts { v:1, type:'library-update', entries } throttled at 100ms.
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
                ctx.ui.postToWebPanel(PANELS.LIBRARY, {
                    v: 1,
                    type: 'library-update',
                    entries: [...state.getLibrary()],
                });
            } else {
                throttleTimer = setTimeout(() => {
                    lastBroadcast = Date.now();
                    ctx.ui.postToWebPanel(PANELS.LIBRARY, {
                        v: 1,
                        type: 'library-update',
                        entries: [...state.getLibrary()],
                    });
                }, remaining);
            }
        };
    } else {
        // No timers -- synchronous broadcast on every state change
        throttledBroadcast = () => {
            ctx.ui.postToWebPanel(PANELS.LIBRARY, {
                v: 1,
                type: 'library-update',
                entries: [...state.getLibrary()],
            });
        };
    }

    const unsubscribeLibrary = state.subscribe(throttledBroadcast);

    // Step 5: Wire message handler
    // `onWebPanelMessage` returns void (no unsubscribe handle in the SDK).
    // Guard against double-fire after deactivate by checking a disposed flag.
    let disposed = false;

    ctx.ui.onWebPanelMessage(PANELS.LIBRARY, (envelope) => {
        if (disposed) return;

        const parsed = parseInbound(envelope.data);
        if (!parsed) {
            // parseInbound already logs a redacted summary (keys only, no values)
            return;
        }

        const handler = handlers[parsed.type];
        if (handler) {
            Promise.resolve().then(() => handler(parsed)).catch((err) => {
                // Log redacted summary -- never include raw error which may
                // contain user URLs, proxy credentials, or custom args
                const errName = err instanceof Error ? err.constructor.name : 'unknown';
                console.error(`[yt-dlp] Library handler "${parsed.type}" failed (${errName})`);
            });
        }
    });

    // Return disposer -- clean up the library-update subscription and
    // disable the message handler. onWebPanelMessage has no SDK-level
    // unsubscribe (returns void), so we use the `disposed` flag to
    // no-op incoming messages after teardown.
    return () => {
        disposed = true;
        if (typeof clearTimeout === 'function' && throttleTimer !== undefined) {
            clearTimeout(throttleTimer);
        }
        unsubscribeLibrary();
    };
}
