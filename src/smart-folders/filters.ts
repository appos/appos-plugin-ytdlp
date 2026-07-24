/**
 * Smart folder filter registration for the yt-dlp plugin.
 *
 * Registers four filter types with the host's SmartFoldersAPI:
 *
 * - **Videos** — matches files with video extensions (mp4, webm, mkv, etc.)
 * - **Audio** — matches files with audio extensions (mp3, m4a, ogg, etc.)
 * - **Favorites** — matches files the user has favorited in the library
 * - **Recent** — matches files downloaded within the last 7 days
 *
 * Videos and Audio use the file URL extension for classification. Extension
 * sets cover formats that yt-dlp commonly outputs — exotic or container-only
 * formats are intentionally excluded because they would never appear in the
 * library.
 *
 * Favorites and Recent use **Branch A (closures)**: `evaluate` closures
 * capture registration-scoped lookup tables that are rebuilt on every state
 * change via `subscribe()`. This works because the host invokes `evaluate`
 * in the plugin's own JS context (same JSC isolate). No file annotation
 * API is needed.
 *
 * The Recent filter stores `downloadedAt` timestamps (not a precomputed
 * boolean set) so that `evaluate` compares against `Date.now()` at call
 * time. This ensures entries naturally expire without requiring a state
 * mutation to trigger a rebuild.
 *
 * The host automatically prefixes filter IDs with `{pluginId}.filter.` —
 * the `id` field here is the short suffix only.
 *
 * Cleanup: the host does not expose an `unregisterFilterType` API. Filters
 * are auto-cleaned when the plugin unloads. The returned disposer tears
 * down the state subscription so stale rebuilds stop, and sets a disposed
 * flag so any in-flight `evaluate` calls that arrive after teardown return
 * `false` safely.
 *
 * All mutable state (lookup tables, disposed flag) is scoped to each
 * `registerSmartFolders` invocation so multiple calls (e.g. reactivation)
 * cannot interfere with each other.
 *
 * @module smart-folders/filters
 */

import type { PluginContext } from '@appos.space/plugin-types';
import { fileExtension } from '@appos.space/plugin-utils';
import { getLibrary, subscribe } from '../core/state';

// ── Extension sets ────────────────────────────────────────────────────
// Covers formats yt-dlp commonly outputs. Kept minimal — exotic
// container-only formats (ts, m2ts, 3gp) are excluded because yt-dlp
// post-processes them into the formats below by default.

/** Video file extensions produced by yt-dlp. */
const VIDEO_EXTS = new Set([
    'mp4', 'webm', 'mkv', 'mov', 'avi', 'flv', 'm4v', 'ogv',
]);

/** Audio file extensions produced by yt-dlp. */
const AUDIO_EXTS = new Set([
    'mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav', 'aac', 'wma',
]);

// ── Recent window ─────────────────────────────────────────────────────

/** Duration in milliseconds defining "recent" downloads (7 days). */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── Public API ────────────────────────────────────────────────────────

/**
 * Register all smart folder filter types with the host.
 *
 * All mutable state (lookup tables, disposed flag) is scoped to this
 * invocation so multiple registrations do not interfere.
 *
 * @param ctx - The plugin context provided by the host.
 * @returns A disposer function that tears down the state subscription.
 */
export async function registerSmartFolders(ctx: PluginContext): Promise<() => void> {
    // ── Registration-scoped state ─────────────────────────────────────
    // Isolated per invocation so reactivation or hot-reload cannot
    // corrupt a previous registration's lookups or disposed flag.

    /** URL → favorite boolean. Rebuilt on every state mutation. */
    let favoritesByUrl = new Map<string, boolean>();

    /**
     * URL → downloadedAt epoch (ms). Timestamps are stored instead of a
     * precomputed Set so that `evaluate` can compare against `Date.now()`
     * at call time — entries expire naturally without needing a state
     * mutation to trigger a rebuild.
     */
    let recentByUrl = new Map<string, number>();

    let disposed = false;

    /**
     * Rebuild the favorites and recent lookup tables from current
     * library state. O(n) over the library, called on every state
     * mutation via `subscribe()`.
     */
    function rebuildLookups(): void {
        if (disposed) return;

        const lib = getLibrary();

        const nextFavorites = new Map<string, boolean>();
        const nextRecent = new Map<string, number>();

        for (const entry of lib) {
            nextFavorites.set(entry.fileUrl, entry.favorite);
            const ts = new Date(entry.downloadedAt).getTime();
            if (!Number.isNaN(ts)) {
                nextRecent.set(entry.fileUrl, ts);
            }
        }

        favoritesByUrl = nextFavorites;
        recentByUrl = nextRecent;
    }

    // All resource acquisition (subscribe, rebuild, register) is inside
    // a single try/catch so any failure cleans up everything acquired so
    // far — no leaked subscriptions or stale lookup tables.
    let unsubState: (() => void) | undefined;
    try {
        // Subscribe first so no mutations are missed between the initial
        // rebuild and the first evaluate call.
        unsubState = subscribe(rebuildLookups);

        // Build initial lookup tables so the first evaluate calls have data.
        rebuildLookups();

        // Register all four filter types in parallel.
        await Promise.all([
            ctx.smartFolders.registerFilterType({
                id: 'videos',
                displayName: 'yt-dlp Videos',
                evaluate: ({ url }) => {
                    if (disposed) return false;
                    const ext = fileExtension(url);
                    return ext !== null && VIDEO_EXTS.has(ext);
                },
            }),
            ctx.smartFolders.registerFilterType({
                id: 'audio',
                displayName: 'yt-dlp Audio',
                evaluate: ({ url }) => {
                    if (disposed) return false;
                    const ext = fileExtension(url);
                    return ext !== null && AUDIO_EXTS.has(ext);
                },
            }),
            ctx.smartFolders.registerFilterType({
                id: 'favorites',
                displayName: 'yt-dlp Favorites',
                evaluate: ({ url }) => {
                    if (disposed) return false;
                    return favoritesByUrl.get(url) === true;
                },
            }),
            ctx.smartFolders.registerFilterType({
                id: 'recent',
                displayName: 'yt-dlp Recent (7 days)',
                evaluate: ({ url }) => {
                    if (disposed) return false;
                    const ts = recentByUrl.get(url);
                    return ts !== undefined && (Date.now() - ts) <= RECENT_WINDOW_MS;
                },
            }),
        ]);
    } catch (err) {
        // Clean up on any failure (subscribe, rebuild, or registration)
        // so the subscription and lookup tables do not leak.
        disposed = true;
        unsubState?.();
        favoritesByUrl = new Map();
        recentByUrl = new Map();
        throw err;
    }

    // Capture for the disposer — guaranteed defined here because we
    // only reach this point after the try block succeeds.
    const unsub = unsubState!;
    return () => {
        disposed = true;
        unsub();
        // Clear lookup tables to release references.
        favoritesByUrl = new Map();
        recentByUrl = new Map();
    };
}
