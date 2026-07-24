/**
 * Workspace template registration for the yt-dlp plugin.
 *
 * Registers a dual-pane workspace layout optimised for media downloading:
 *
 * **Left pane:**
 *   - Download panel (primary interaction surface)
 *   - Terminal (shows where yt-dlp runs — useful for debugging)
 *
 * **Right pane:**
 *   - Library panel (completed downloads)
 *   - File browser (anchored to outputDir when valid, so users can browse
 *     their downloads folder directly — uses the SDK `fileBrowser` tab's
 *     `path` field)
 *   - Web browser (lets users browse and paste URLs from within AppOS)
 *
 * **SDK limitations documented:**
 *   - `SettingsAPI.onKeyChange(key, handler)` is used to re-register the
 *     workspace when `outputDir` changes. If the SDK method is unavailable
 *     at runtime, a notice is logged and the listener is skipped.
 *   - The `fileBrowser` tab slot accepts a `path` field per the SDK types.
 *     When `outputDir` is unset or unresolvable (no home-directory API),
 *     the `path` field is omitted and the file browser opens to the host
 *     default directory.
 *
 * @module workspace/template
 */

import type { PluginContext, WorkspaceTemplate } from '@appos.space/plugin-types';
import { PANELS } from '../constants';
import { isFirstRun, markFirstRunComplete } from '../core/state';
import { validateOutputDir } from '../core/paths';

/** Workspace template ID — consumed by main.ts and menubar. */
export const WORKSPACE_ID = 'ytdlp-dual-pane';

/**
 * Build the workspace template object with the SDK-correct shape.
 *
 * Anchors the file browser tab to `outputDir` when valid, otherwise
 * omits the `path` field for graceful degradation.
 */
function buildTemplate(ctx: PluginContext): Partial<WorkspaceTemplate> & { id: string; name: string } {
    const outputDir = (ctx.settings.get('outputDir') as string) ?? '';
    const validation = validateOutputDir(outputDir);

    // Build file browser tab — anchor to outputDir if valid
    const fileBrowserTab: { type: 'fileBrowser'; path?: string } = {
        type: 'fileBrowser',
    };
    if (validation.ok) {
        fileBrowserTab.path = validation.resolved;
    } else {
        // outputDir unset or unresolvable — file browser opens to host default
        console.info(
            `[yt-dlp] Workspace file browser not anchored: ${validation.reason}`,
        );
    }

    return {
        schemaVersion: 1,
        id: WORKSPACE_ID,
        name: 'yt-dlp Downloader',
        source: { type: 'plugin', pluginId: ctx.pluginId },
        leftPane: {
            tabs: [
                // Primary download UI
                { type: 'pluginPanel', panelId: PANELS.DOWNLOAD },
                // Terminal for debugging yt-dlp invocations
                { type: 'terminal' },
            ],
            activeTab: 0,
        },
        rightPane: {
            tabs: [
                // Completed downloads library
                { type: 'pluginPanel', panelId: PANELS.LIBRARY },
                // File browser for browsing the output directory
                fileBrowserTab,
                // Web browser for in-app URL discovery
                { type: 'webBrowser' },
            ],
            activeTab: 0,
        },
    };
}

/**
 * Register the workspace template and wire an outputDir change listener.
 *
 * Returns a disposer that cleans up the settings listener. The host
 * auto-cleans workspace registrations on plugin unload, so no explicit
 * `workspaces.unregister` call is needed (the SDK does not expose one).
 *
 * @param ctx - Plugin context.
 * @returns Disposer function for cleanup during deactivation.
 */
export async function registerWorkspace(ctx: PluginContext): Promise<() => void> {
    // Register the initial template
    try {
        await ctx.workspaces.register(buildTemplate(ctx));
    } catch (err) {
        console.error('[yt-dlp] Failed to register workspace template:', err);
        return () => {}; // no-op disposer
    }

    // Best-effort: wire settings listener to re-register on outputDir change.
    // SDK SettingsAPI.onKeyChange returns a token string; the matching
    // remover is SettingsAPI.offChange(token). If the runtime returns a
    // disposer function instead, we store that directly.
    let unsubscribe: (() => void) | null = null;
    try {
        const result = ctx.settings.onKeyChange('outputDir', () => {
            // Re-register with updated file browser path
            void ctx.workspaces.register(buildTemplate(ctx)).catch((err) => {
                console.error('[yt-dlp] Failed to re-register workspace on outputDir change:', err);
            });
        });
        if (typeof result === 'function') {
            unsubscribe = result as unknown as () => void;
        } else if (typeof result === 'string') {
            unsubscribe = () => { ctx.settings.offChange(result); };
        }
    } catch {
        console.info(
            '[yt-dlp] settings.onKeyChange not available at runtime — ' +
            'workspace will not auto-update when outputDir changes',
        );
    }

    return () => {
        if (unsubscribe !== null) {
            try {
                unsubscribe();
            } catch {
                // best effort — host may have already cleaned up
            }
        }
    };
}

/**
 * Apply the workspace layout on first run.
 *
 * Checks the `ytdlp:initialized` cache flag. If this is the first
 * activation, applies the workspace immediately so users see the
 * plugin's dual-pane UI without needing to discover the workspace
 * switcher. Marks first run as complete afterwards.
 *
 * @param ctx - Plugin context.
 * @returns Resolves when the first-run check (and optional apply) completes.
 */
export async function applyIfFirstRun(ctx: PluginContext): Promise<void> {
    try {
        if (await isFirstRun()) {
            await ctx.workspaces.apply(WORKSPACE_ID);
            await markFirstRunComplete();
        }
    } catch (err) {
        console.error('[yt-dlp] First-run workspace apply failed:', err);
    }
}
