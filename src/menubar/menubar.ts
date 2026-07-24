/**
 * MenuBar integration for the yt-dlp plugin.
 *
 * Registers an NSStatusItem (menu bar icon) via `ctx.menubar.register()`,
 * wires a reactive badge that reflects the count of active work items
 * (queued + downloading + extracting), and handles click-to-open via the
 * host's `menubar.clicked` event.
 *
 * **Badge semantics:** The badge count represents entries in any of the
 * three "active work" states: `queued`, `downloading`, or `extracting`.
 * These are the states where the plugin is either about to do work or
 * actively doing work. When the count drops to zero the host hides the
 * badge automatically.
 *
 * **SDK shape verified against `@appos.space/plugin-types` namespaces.d.ts:**
 *   - `menubar.register({ icon: SFSymbolName })` → `Promise<true>`
 *   - `menubar.setBadge(count: number)` → `Promise<true>`
 *   - `menubar.remove()` → `Promise<true>`
 *   - `events.subscribe(eventName, handler)` → `string` (token)
 *   - `events.unsubscribe(token)` → `void`
 *
 * No discrepancies found between the assumed shape and the SDK types.
 *
 * @module menubar/menubar
 */

import type { PluginContext } from '@appos.space/plugin-types';
import { WORKSPACE_ID } from '../workspace/template';
import { subscribe as subscribeState, getQueue } from '../core/state';

/** The set of queue entry statuses that count as "active work". */
const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'extracting']);

/**
 * Compute the number of active work items in the queue.
 *
 * Counts entries whose status is `queued`, `downloading`, or `extracting`.
 */
function computeActiveBadgeCount(): number {
    let count = 0;
    for (const entry of getQueue()) {
        if (ACTIVE_STATUSES.has(entry.status)) {
            count++;
        }
    }
    return count;
}

/**
 * Register the menubar status item and wire reactive badge + click handler.
 *
 * The returned disposer:
 *   1. Unsubscribes from state changes (badge updates).
 *   2. Unsubscribes from the `menubar.clicked` event.
 *   3. Removes the NSStatusItem via `menubar.remove()`.
 *
 * @param ctx - Plugin context.
 * @returns A disposer function for cleanup during deactivation.
 */
export async function registerMenubar(ctx: PluginContext): Promise<() => void> {
    // 1. Register the menubar icon (icon-only for v1, no label).
    await ctx.menubar.register({ icon: 'arrow.down.circle' });

    // 2. Wire badge updates and click handler with transactional rollback.
    //    If any step after register() throws, clean up already-acquired
    //    resources before rethrowing so nothing leaks on partial init.
    let stateDispose: (() => void) | null = null;
    let clickToken: string | null = null;

    try {
        // 2a. Wire badge updates from state changes.
        const updateBadge = (): void => {
            const count = computeActiveBadgeCount();
            void ctx.menubar.setBadge(count).catch((err) => {
                console.error('[yt-dlp] menubar.setBadge failed:', err);
            });
        };

        stateDispose = subscribeState(updateBadge);

        // Set initial badge value.
        updateBadge();

        // 2b. Wire click-to-open-workspace via host event.
        clickToken = ctx.events.subscribe('menubar.clicked', async () => {
            try {
                await ctx.workspaces.apply(WORKSPACE_ID);
            } catch (err) {
                console.error('[yt-dlp] Failed to apply workspace on menubar click:', err);
            }
        });
    } catch (err) {
        // Rollback: clean up any resources acquired before the failure.
        if (stateDispose) {
            try { stateDispose(); } catch { /* best effort */ }
        }
        if (clickToken) {
            try { ctx.events.unsubscribe(clickToken); } catch { /* best effort */ }
        }
        void ctx.menubar.remove().catch(() => { /* best effort */ });
        throw err;
    }

    // 3. Return composite disposer — each step is independently guarded
    //    so one failure cannot prevent the remaining cleanup steps.
    return () => {
        try { stateDispose!(); } catch { /* best effort */ }

        try {
            ctx.events.unsubscribe(clickToken!);
        } catch {
            // best effort — host may have already cleaned up
        }

        void ctx.menubar.remove().catch((err) => {
            console.error('[yt-dlp] menubar.remove failed during cleanup:', err);
        });
    };
}
