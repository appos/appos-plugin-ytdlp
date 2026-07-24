/**
 * yt-dlp Media Downloader -- AppOS Plugin Entry Point
 *
 * Flagship "CLI-to-GUI" showcase plugin that turns yt-dlp into a polished,
 * non-programmer-friendly media downloader. First title in the AppOS Plugin Store.
 *
 * ## Activation order
 *
 * The sequence is carefully ordered to avoid startup races:
 *
 * 1. `state.initState` -- restore persisted queue/library/history from cache
 * 2. `initPaths` -- resolve home dir before anything resolves paths
 * 3. `initDownloader` + `setDownloadPanelOpen(true)` -- wire the download
 *    engine BEFORE panels register, so message handlers can safely call
 *    downloader APIs the moment the first webview message arrives
 * 4. `registerDownloadPanel` + `registerLibraryPanel` -- register both
 *    webview panels and their message handlers
 * 5. `registerWorkspace` -- register the dual-pane workspace template
 * 6. `registerMenubar` -- register the menu bar icon + badge
 * 7. `registerSmartFolders` -- register Videos/Audio/Favorites/Recent filters
 * 8. Register commands (recheck-dependencies, open-download-panel, etc.)
 * 9. Wire `onDependencyStatusChanged` BEFORE initial `getDependencyStatus`
 *    query so we never miss an in-flight update
 * 10. Initial dependency snapshot, broadcast to panels; if yt-dlp is
 *     available, handleDependencyStatus triggers resume (single resume point)
 * 11. First-run workspace auto-apply
 * 12. Wire `app.willQuit` for final state flush
 * 13. Wire `settings.onChange` for live settings broadcasts
 *
 * ## Disposable pattern
 *
 * Every subscription/registration that returns a cleanup handle is
 * normalized into `() => void | Promise<void>` and pushed onto a single
 * `disposables[]` array. On `deactivate`, the array is drained in reverse
 * order with per-item try/catch so one bad dispose never blocks the rest.
 *
 * @module main
 */

import type { PluginContext, DependencyStatus } from '@appos.space/plugin-types';

import * as state from './core/state';
import { initPaths, validateOutputDir } from './core/paths';
import {
    initDownloader,
    setDownloadPanelOpen,
    resumeInterruptedQueue,
    enqueueAndProcess,
} from './services/downloader';
import { registerActions } from './actions/register-actions';
import { registerDownloadPanel } from './panels/download-panel';
import { registerLibraryPanel } from './panels/library-panel';
import { registerWorkspace, applyIfFirstRun, WORKSPACE_ID } from './workspace/template';
import { registerMenubar } from './menubar/menubar';
import { registerSmartFolders } from './smart-folders/filters';
import { isValidMediaUrl } from './core/security';
import { PANELS } from './constants';

// ── Module-level disposable array ───────────────────────────────────

/**
 * All cleanup handles collected during activation. Drained in reverse
 * order on deactivate. Each entry is a function (sync or async) that
 * tears down one subscription/registration.
 */
const disposables: Array<() => void | Promise<void>> = [];

/**
 * Track whether yt-dlp was available at last check, so we can detect
 * the "just became available" transition in handleDependencyStatus.
 */
let wasYtDlpAvailable = false;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Check whether yt-dlp is satisfied in a dependency status array.
 *
 * @param statuses - Dependency status snapshot from the host.
 * @returns `true` if the yt-dlp entry exists and is satisfied.
 */
function isYtDlpSatisfied(statuses: DependencyStatus[]): boolean {
    return statuses.some((s) => s.name === 'yt-dlp' && s.satisfied === true);
}

/**
 * Handle a dependency status update: store in state, broadcast to
 * panels, and kick resume if yt-dlp just became available.
 *
 * @param ctx - Plugin context for broadcasting.
 * @param statuses - The latest dependency status array.
 */
function handleDependencyStatus(
    ctx: PluginContext,
    statuses: DependencyStatus[],
): void {
    // Store the snapshot so downloader/panels can read it via state API
    state.setDependencyStatuses(statuses);

    // Broadcast to both panels (setDependencyStatuses already emits
    // a state-update via emitStateUpdate; also send explicit messages
    // for the degraded-state banner and fine-grained status)
    state.broadcastToWebPanels({
        v: 1,
        type: 'dependency-banner',
        statuses: [...statuses],
    });
    state.broadcastToWebPanels({
        v: 1,
        type: 'dependency-status',
        statuses: [...statuses],
    });

    // If yt-dlp just became available (was previously unavailable),
    // kick the resume queue so paused entries can start downloading.
    const nowAvailable = isYtDlpSatisfied(statuses);
    if (nowAvailable && !wasYtDlpAvailable) {
        void resumeInterruptedQueue().catch((err) => {
            console.warn('[yt-dlp] resumeInterruptedQueue failed:', err);
        });
    }
    wasYtDlpAvailable = nowAvailable;
}

/**
 * Normalize any subscription/registration return value into a disposer
 * and push onto the disposables array. Handles:
 * - `void` / `undefined` / `null` → no-op (host auto-cleans)
 * - Function → push directly
 * - String token → wrap with a provided cleanup callback
 *
 * @param result - Return value from a register/subscribe call.
 * @param tokenCleanup - Optional callback to invoke with a string token on dispose.
 */
function trackDisposable(
    result: unknown,
    tokenCleanup?: (token: string) => void,
): void {
    if (typeof result === 'function') {
        disposables.push(result as () => void);
    } else if (typeof result === 'string' && tokenCleanup) {
        disposables.push(() => { tokenCleanup(result); });
    }
    // void/undefined/null → host auto-cleans, nothing to track
}

// ── Activation ──────────────────────────────────────────────────────

async function activate(ctx: PluginContext): Promise<void> {
    // Reset transition tracker for fresh activation
    wasYtDlpAvailable = false;

    // ── Steps 1-3: Non-blocking init ──────────────────────────────────
    // State loading (cache.get) can HANG indefinitely — the host cache
    // API sometimes never resolves, which previously blocked activate()
    // from ever reaching workspace apply. Fire init as a background
    // promise and let activate() race through to the UI steps.
    //
    // initDownloader / setDownloadPanelOpen are synchronous variable
    // assignments — always safe inline.
    initDownloader(ctx);
    setDownloadPanelOpen(true);

    // Background init: state + paths. Panels will show empty state until
    // this completes, which is acceptable — visible-but-empty beats
    // invisible-because-hung.
    void (async () => {
        try {
            await state.initState(ctx);
        } catch (err) {
            console.error('[yt-dlp] initState failed (empty state):', err);
            try {
                void ctx.feedback.toast(
                    `yt-dlp cache load failed: ${err instanceof Error ? err.message : String(err)}`,
                    { kind: 'error' },
                );
            } catch { /* best effort */ }
        }
        try {
            await initPaths(ctx);
        } catch (err) {
            console.error('[yt-dlp] initPaths failed:', err);
        }
    })();
    // ── Step 3b: Validate output directory ──────────────────────────
    try {
        let outputDir = (ctx.settings.get('outputDir') as string | null)?.trim() || '';

        // Migrate from legacy key if current is empty
        if (!outputDir) {
            const legacyDir = (ctx.settings.get('outputDirectory') as string | null)?.trim() || '';
            if (legacyDir) {
                outputDir = legacyDir;
            }
        }

        const dirResult = validateOutputDir(outputDir);
        if (dirResult.ok) {
            ctx.settings.set('outputDir', dirResult.resolved);
        } else if (outputDir) {
            ctx.settings.set('outputDir', '');
            // void — never await toast during activation (host may never resolve)
            void ctx.feedback.toast(
                'Download directory is invalid \u2014 please set an absolute path in plugin settings.',
                { kind: 'warning' },
            );
            ctx.settings.openUI();
        } else {
            // void — never await toast during activation (host may never resolve)
            void ctx.feedback.toast(
                'Please set your download directory in plugin settings before downloading.',
                { kind: 'warning' },
            );
            ctx.settings.openUI();
        }
    } catch (err) {
        console.warn('[yt-dlp] Output directory validation failed:', err);
        // Non-fatal -- user can configure later
    }

    // ── Step 4: Register webview panels ─────────────────────────────
    // Each returns a disposer. Downloader is already ready.
    try {
        disposables.push(await registerDownloadPanel(ctx));
    } catch (err) {
        console.error('[yt-dlp] registerDownloadPanel failed:', err);
        // Continue -- library panel and other modules can still function
    }

    try {
        disposables.push(await registerLibraryPanel(ctx));
    } catch (err) {
        console.error('[yt-dlp] registerLibraryPanel failed:', err);
    }

    // ── Step 5: Register workspace template ─────────────────────────
    try {
        disposables.push(await registerWorkspace(ctx));
    } catch (err) {
        console.error('[yt-dlp] registerWorkspace failed:', err);
    }

    // ── Step 6: Register menubar ────────────────────────────────────
    try {
        disposables.push(await registerMenubar(ctx));
    } catch (err) {
        console.error('[yt-dlp] registerMenubar failed:', err);
    }

    // ── Step 7: Register smart folders ──────────────────────────────
    try {
        disposables.push(await registerSmartFolders(ctx));
    } catch (err) {
        console.error('[yt-dlp] registerSmartFolders failed:', err);
    }

    // ── Step 8: Register commands ───────────────────────────────────
    // commands.register() returns void per the SDK type contract
    // (CommandsAPI.register → void). The host auto-cleans plugin commands
    // on unload. We still normalize any unexpected return value into
    // disposables[] defensively, in case a future SDK version returns
    // an unregister handle.

    try {
        const r1 = ctx.commands.register('recheck-dependencies', {
            title: 'Re-check Dependencies',
            icon: 'arrow.triangle.2.circlepath',
            handler: async () => {
                await ctx.lifecycle.recheckDependencies();
            },
        });
        trackDisposable(r1);
    } catch (err) {
        console.warn('[yt-dlp] Failed to register recheck-dependencies command:', err);
    }

    try {
        const r2 = ctx.commands.register('open-download-panel', {
            title: 'Open yt-dlp Downloader',
            icon: 'arrow.down.circle',
            handler: async () => {
                // Apply the yt-dlp workspace first so the pluginPanel tab
                // exists in the current layout. Without this, showPaneTab
                // targets a tab that doesn't exist and silently no-ops
                // when the user has a different workspace selected.
                try {
                    await ctx.workspaces.apply(WORKSPACE_ID);
                } catch (err) {
                    console.warn('[yt-dlp] workspaces.apply failed in open-download-panel:', err);
                }
                try {
                    ctx.ui.showPaneTab(PANELS.DOWNLOAD, { title: 'Downloads', pane: 'left' });
                } catch {
                    // Best effort — workspace apply already surfaced the panel
                }
            },
        });
        trackDisposable(r2);
    } catch (err) {
        console.warn('[yt-dlp] Failed to register open-download-panel command:', err);
    }

    try {
        const r3 = ctx.commands.register('open-library-panel', {
            title: 'Open yt-dlp Library',
            icon: 'books.vertical',
            handler: async () => {
                // Apply the yt-dlp workspace first so the pluginPanel tab
                // exists in the current layout (same reasoning as the
                // download-panel command above).
                try {
                    await ctx.workspaces.apply(WORKSPACE_ID);
                } catch (err) {
                    console.warn('[yt-dlp] workspaces.apply failed in open-library-panel:', err);
                }
                try {
                    ctx.ui.showPaneTab(PANELS.LIBRARY, { title: 'Library', pane: 'right' });
                } catch {
                    // Best effort — workspace apply already surfaced the panel
                }
            },
        });
        trackDisposable(r3);
    } catch (err) {
        console.warn('[yt-dlp] Failed to register open-library-panel command:', err);
    }

    try {
        const r4 = ctx.commands.register('clear-completed', {
            title: 'Clear Completed Downloads',
            icon: 'xmark.circle',
            handler: () => {
                const queue = state.getQueue();
                // Snapshot IDs first, then remove in a second pass
                // (never iterate a live array while mutating via remove calls)
                const idsToRemove = queue
                    .filter((e) => e.status === 'complete' || e.status === 'failed' || e.status === 'cancelled')
                    .map((e) => e.id);
                for (const id of idsToRemove) {
                    state.removeQueueEntry(id);
                }
            },
        });
        trackDisposable(r4);
    } catch (err) {
        console.warn('[yt-dlp] Failed to register clear-completed command:', err);
    }

    try {
        const r5 = ctx.commands.register('paste-and-download', {
            title: 'Paste & Download',
            icon: 'doc.on.clipboard',
            // shortcut deferred to v1.1 (epic scope: no keyboard shortcuts in v1)
            handler: async () => {
                try {
                    const clipText = await ctx.clipboard.read();
                    if (!clipText) {
                        await ctx.feedback.toast('Clipboard is empty.', { kind: 'warning' });
                        return;
                    }
                    const urlResult = isValidMediaUrl(clipText.trim());
                    if (!urlResult.ok) {
                        await ctx.feedback.toast(
                            `Clipboard does not contain a valid media URL: ${urlResult.reason}`,
                            { kind: 'warning' },
                        );
                        return;
                    }
                    // Enqueue directly with default settings (power-user shortcut)
                    const settings = state.getSettingsSnapshot();
                    const ids = await enqueueAndProcess(clipText.trim(), {
                        format: settings.defaultFormat,
                        quality: settings.defaultQuality,
                        outputDir: settings.outputDir,
                        filenameTemplate: settings.filenameTemplate || '%(title)s.%(ext)s',
                    });
                    if (ids.length > 0) {
                        await ctx.feedback.toast('Download started from clipboard.', { kind: 'info' });
                    }
                } catch (err) {
                    console.warn('[yt-dlp] paste-and-download failed:', err);
                    await ctx.feedback.toast('Failed to read clipboard.', { kind: 'warning' });
                }
            },
        });
        trackDisposable(r5);
    } catch (err) {
        console.warn('[yt-dlp] Failed to register paste-and-download command:', err);
    }

    // ── Step 8b: Register public actions ────────────────────────────
    // Bridges the 5 palette commands above into the typed action catalog
    // (registerFromCommand) and registers the new downloadUrl action.
    // No-op on hosts without context.actions. Must run AFTER step 8 so
    // the bridged commands resolve in the host CommandRegistry.
    try {
        const actionDisposers = await registerActions(ctx);
        disposables.push(...actionDisposers);
    } catch (err) {
        console.warn('[yt-dlp] public action registration failed:', err);
    }

    // ── Step 9: Wire dependency status subscription ─────────────────
    // Subscribe BEFORE querying so we catch any in-flight updates.
    try {
        const depDispose = ctx.lifecycle.onDependencyStatusChanged((statuses) => {
            handleDependencyStatus(ctx, statuses);
        });
        // The API may return a disposer function or a string token
        if (typeof depDispose === 'function') {
            disposables.push(depDispose);
        } else if (typeof depDispose === 'string') {
            // Token-based unsubscription -- wrap for uniform cleanup
            disposables.push(() => {
                try {
                    (ctx.lifecycle as any).offDependencyStatusChanged?.(depDispose);
                } catch { /* best effort */ }
            });
        }
    } catch (err) {
        console.warn('[yt-dlp] onDependencyStatusChanged not available:', err);
    }

    // ── Step 10: Initial dependency snapshot ─────────────────────────
    // Query initial deps and broadcast to panels, but DO NOT resume
    // the queue yet -- first-run workspace apply must complete first
    // (step 11) so the UI is visible before downloads start.
    let initialYtDlpAvailable = false;
    try {
        const initialDeps = await ctx.lifecycle.getDependencyStatus();
        // Store + broadcast without triggering resume (wasYtDlpAvailable
        // is false, so handleDependencyStatus would resume -- we skip it
        // and handle resume explicitly in step 12).
        state.setDependencyStatuses(initialDeps);
        state.broadcastToWebPanels({
            v: 1,
            type: 'dependency-banner',
            statuses: [...initialDeps],
        });
        state.broadcastToWebPanels({
            v: 1,
            type: 'dependency-status',
            statuses: [...initialDeps],
        });
        initialYtDlpAvailable = isYtDlpSatisfied(initialDeps);
        wasYtDlpAvailable = initialYtDlpAvailable;
    } catch (err) {
        console.warn('[yt-dlp] getDependencyStatus() failed -- dependency state unknown:', err);
    }

    // ── Step 11: First-run workspace apply ──────────────────────────
    // Apply the yt-dlp workspace ONLY on first run (ytdlp:initialized
    // cache flag). Force-applying on every launch clobbered whatever
    // workspace the user had selected. Discoverability on subsequent
    // launches is preserved by the menubar icon and the open-download-
    // panel / open-library-panel palette verbs, both of which apply the
    // workspace on demand before showing their tab.
    try {
        await applyIfFirstRun(ctx);
    } catch (err) {
        console.warn('[yt-dlp] first-run workspace apply failed:', err);
    }

    // ── Step 12: Resume interrupted queue ────────────────────────────
    // Now that the workspace is applied and panels are visible, resume
    // any interrupted downloads if yt-dlp is available.
    if (initialYtDlpAvailable) {
        void resumeInterruptedQueue().catch((err) => {
            console.warn('[yt-dlp] resumeInterruptedQueue failed:', err);
        });
    }

    // ── Step 13: Flush state on app quit ─────────────────────────────
    // events.subscribe returns a string token.
    try {
        const quitToken = ctx.events.subscribe('app.willQuit', async () => {
            await state.flushPersistedState();
        });
        if (typeof quitToken === 'string') {
            disposables.push(() => { ctx.events.unsubscribe(quitToken); });
        } else if (typeof quitToken === 'function') {
            disposables.push(quitToken as () => void);
        }
    } catch (err) {
        console.warn('[yt-dlp] Failed to subscribe to app.willQuit:', err);
    }

    // ── Step 14: Settings change listener ───────────────────────────
    // Broadcasts settings-update to all panels when any setting changes.
    try {
        const settingsResult = ctx.settings.onChange((_key, _newValue, _oldValue) => {
            state.emitSettingsUpdate();
        });
        // Normalize: SDK declares string token return, but handle function
        // defensively (same pattern as lifecycle/events subscriptions).
        if (typeof settingsResult === 'function') {
            disposables.push(settingsResult as () => void);
        } else if (typeof settingsResult === 'string') {
            disposables.push(() => { ctx.settings.offChange(settingsResult); });
        }
    } catch (err) {
        // SDK may not support onChange at runtime -- log once and continue.
        // Panels will still receive settings via the initial state-update;
        // subsequent changes require re-opening the plugin (acceptable for v1).
        console.info('[yt-dlp] settings.onChange not available -- panels will use initial settings only');
    }
}

// ── Deactivation ────────────────────────────────────────────────────

async function deactivate(): Promise<void> {
    // Drain all disposables in reverse order with per-item try/catch
    // so one bad dispose never blocks the rest
    while (disposables.length) {
        const d = disposables.pop();
        try {
            await d?.();
        } catch (err) {
            console.error('[yt-dlp] Dispose error:', err);
        }
    }

    // Final state flush -- ensures any pending debounced writes land
    try {
        await state.flushPersistedState();
    } catch (err) {
        console.error('[yt-dlp] Final flushPersistedState failed:', err);
    }
}

// ── globalThis assignment ───────────────────────────────────────────
// The plugin runtime expects activate/deactivate on globalThis, NOT as
// named exports. The leading semicolons prevent ASI hazards when the
// preceding statement lacks a semicolon.

;(globalThis as any).activate = activate;
;(globalThis as any).deactivate = deactivate;
