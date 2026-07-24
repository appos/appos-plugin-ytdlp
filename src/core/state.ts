/**
 * Central state manager for the yt-dlp plugin.
 *
 * Persistence uses the Cache API with four sharded keys, each backed by
 * its own debounced writer (500 ms). The pub/sub layer notifies in-process
 * subscribers on every mutation AND fans out `state-update` messages to
 * all registered WebView panels so they always have fresh state.
 *
 * Shard layout (three eagerly loaded, one lazy):
 *   `ytdlp:queue`       — QueueEntry[]         (eager — loaded in initState)
 *   `ytdlp:library`     — LibraryEntry[]        (eager — loaded in initState)
 *   `ytdlp:history`     — string[]              (eager — loaded in initState)
 *   `ytdlp:initialized` — boolean               (lazy  — read via isFirstRun())
 *
 * The `initialized` flag is intentionally lazy-loaded because it is only
 * checked once during the activation sequence and never read again. It
 * does not participate in `flushPersistedState` because its write path
 * (`markFirstRunComplete`) is always immediate (no debounce).
 *
 * Branch choice: **Branch A** — `toggleFavorite` uses closures; no file
 * annotation hooks (the SDK does not expose a `fileAnnotation` API).
 *
 * @module state
 */

import type { PluginContext, DependencyStatus } from '@appos.space/plugin-types';
import type {
    QueueEntry,
    LibraryEntry,
    PluginState,
    SettingsSnapshot,
} from '../types/plugin-state';
import type { PanelOutboundMessage } from '../types/webview-messages';
import { debounce } from '@appos.space/plugin-utils';
import { generateId } from '@appos.space/plugin-utils';

// ── Constants ──────────────────────────────────────────────────────

const SHARD_QUEUE = 'ytdlp:queue';
const SHARD_LIBRARY = 'ytdlp:library';
const SHARD_HISTORY = 'ytdlp:history';
const SHARD_INIT = 'ytdlp:initialized';

const HISTORY_CAP = 100;
const DEBOUNCE_MS = 500;

// ── Module-level state ─────────────────────────────────────────────

type Listener = () => void;

let ctx: PluginContext | null = null;
let queue: QueueEntry[] = [];
let library: LibraryEntry[] = [];
let history: string[] = [];
let dependencyStatuses: DependencyStatus[] = [];
const subscribers = new Set<Listener>();
const panelIds = new Set<string>();

/**
 * Init-generation token. Incremented on every `initState()` call.
 * Debounced callbacks capture the generation at creation time and
 * no-op if the generation has changed, preventing stale writes
 * from landing against a newer context.
 */
let initGeneration = 0;

// Debounced writer references — assigned during initState.
let persistQueue: (() => void) | null = null;
let persistLibrary: (() => void) | null = null;
let persistHistory: (() => void) | null = null;

// Direct (non-debounced) writer references for flushPersistedState.
let writeQueue: (() => Promise<true>) | null = null;
let writeLibrary: (() => Promise<true>) | null = null;
let writeHistory: (() => Promise<true>) | null = null;

// ── Internal helpers ───────────────────────────────────────────────

/**
 * Notify all in-process subscribers and broadcast `state-update` to
 * all registered WebView panels. This is the single fan-out point for
 * every state mutation.
 */
function notify(): void {
    notifySubscribers();

    // Fan out canonical state-update to all registered panels so they
    // never go stale. The payload includes settings + dependency info.
    emitStateUpdate();
}

/**
 * Notify in-process subscribers only, WITHOUT emitting the full
 * `state-update` broadcast to WebView panels. Used by lightweight
 * progress-only mutations to keep subscriber contracts intact while
 * avoiding O(state size) panel traffic on high-frequency ticks.
 */
function notifySubscribers(): void {
    for (const listener of subscribers) {
        try {
            listener();
        } catch (err) {
            console.error('[yt-dlp] Subscriber threw:', err);
        }
    }
}

/**
 * Check whether `setTimeout` is available in this runtime.
 * The debounce utility from plugin-utils relies on `setTimeout`.
 */
function hasTimers(): boolean {
    return typeof setTimeout === 'function';
}

/**
 * Validate a persisted QueueRequestSnapshot for completeness and safety.
 *
 * All six fields must be non-empty strings. Path fields (`outputDir`,
 * `archivePath`, `tempDir`) must be absolute POSIX paths (start with `/`)
 * to ensure raw `~` or relative paths never reach the shell.
 */
function isValidRequestSnapshot(req: unknown): boolean {
    if (!req || typeof req !== 'object') return false;
    const r = req as Record<string, unknown>;
    return (
        typeof r.format === 'string' && r.format !== '' &&
        typeof r.quality === 'string' && r.quality !== '' &&
        typeof r.outputDir === 'string' && r.outputDir !== '' && (r.outputDir as string).startsWith('/') &&
        typeof r.filenameTemplate === 'string' && r.filenameTemplate !== '' &&
        typeof r.archivePath === 'string' && r.archivePath !== '' && (r.archivePath as string).startsWith('/') &&
        typeof r.tempDir === 'string' && r.tempDir !== '' && (r.tempDir as string).startsWith('/')
    );
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Initialise state from the Cache API.
 *
 * Loads the three mutable shards (queue, library, history) in parallel,
 * transitions any `downloading` entries to `paused` (so
 * `resumeInterruptedQueue` can re-enqueue them), and wires debounced
 * writers. The `initialized` shard is lazy-loaded via `isFirstRun()`.
 *
 * @param pluginCtx - The plugin context provided by the host.
 */
export async function initState(pluginCtx: PluginContext): Promise<void> {
    // Bump generation so any pending debounced writes from a previous
    // init cycle become no-ops and cannot land against the new context.
    const gen = ++initGeneration;

    ctx = pluginCtx;

    // Reset runtime-only state from any previous init cycle so stale
    // panels, subscribers, and dependency data do not leak across.
    dependencyStatuses = [];
    panelIds.clear();
    subscribers.clear();

    // Load all shards in parallel
    const [rawQueue, rawLibrary, rawHistory] = await Promise.all([
        ctx.cache.get(SHARD_QUEUE),
        ctx.cache.get(SHARD_LIBRARY),
        ctx.cache.get(SHARD_HISTORY),
    ]);

    const rawQueueArr = Array.isArray(rawQueue) ? (rawQueue as QueueEntry[]) : [];
    const rawLibraryArr = Array.isArray(rawLibrary) ? (rawLibrary as LibraryEntry[]) : [];
    history = Array.isArray(rawHistory) ? (rawHistory as string[]) : [];

    // ── Queue migration ─────────────────────────────────────────────
    // Drop entries that lack a fully valid QueueRequestSnapshot.
    // The downloader's `runOne()` reads all snapshot fields to build argv
    // — a partially-migrated or tilde-prefixed row would produce broken
    // yt-dlp invocations. Only entries with absolute paths and all
    // required fields are safe to resume.
    const validEntries: QueueEntry[] = [];
    let droppedCount = 0;
    for (const entry of rawQueueArr) {
        if (
            entry &&
            typeof entry === 'object' &&
            entry.request &&
            typeof entry.request === 'object' &&
            isValidRequestSnapshot(entry.request)
        ) {
            validEntries.push(entry);
        } else {
            droppedCount++;
        }
    }
    if (droppedCount > 0) {
        console.warn(
            `[yt-dlp] Dropped ${droppedCount} stale queue entries missing valid request snapshot`,
        );
    }
    queue = validEntries;

    // ── Library migration ─────────────────────────────────────────────
    // Drop entries missing required display fields (filePath, fileUrl,
    // sourceUrl). For entries that pass display validation, ensure the
    // `request` snapshot is valid — backfill or repair from filePath
    // when missing or malformed so redownload works.
    const validLibEntries: LibraryEntry[] = [];
    let droppedLibCount = 0;
    for (const entry of rawLibraryArr) {
        if (
            entry &&
            typeof entry === 'object' &&
            typeof entry.id === 'string' &&
            typeof entry.filePath === 'string' && entry.filePath.startsWith('/') &&
            typeof entry.fileUrl === 'string' &&
            typeof entry.sourceUrl === 'string'
        ) {
            // Validate or rebuild request snapshot from filePath parent dir.
            // filePath is guaranteed absolute (validated above), so the
            // derived outputDir will also be absolute.
            if (
                !entry.request ||
                typeof entry.request !== 'object' ||
                !isValidRequestSnapshot(entry.request)
            ) {
                const lastSlash = entry.filePath.lastIndexOf('/');
                const derivedDir = lastSlash > 0 ? entry.filePath.slice(0, lastSlash) : '/';
                (entry as LibraryEntry).request = {
                    format: (entry.request as any)?.format || 'best',
                    quality: (entry.request as any)?.quality || 'best',
                    outputDir: derivedDir,
                    filenameTemplate: (entry.request as any)?.filenameTemplate || '%(title)s.%(ext)s',
                    archivePath: `${derivedDir}/.ytdlp-archive`,
                    tempDir: `${derivedDir}/.ytdlp-temp`,
                };
            }
            validLibEntries.push(entry);
        } else {
            droppedLibCount++;
        }
    }
    if (droppedLibCount > 0) {
        console.warn(
            `[yt-dlp] Dropped ${droppedLibCount} stale library entries missing required fields`,
        );
    }
    library = validLibEntries;

    // Transition any in-flight downloads to paused for restart recovery
    for (const entry of queue) {
        if (entry.status === 'downloading') {
            entry.status = 'paused';
        }
    }

    // Wire writers — bound to the init-local pluginCtx so they always
    // write to the correct cache instance.
    const localCtx = pluginCtx;
    writeQueue = () => localCtx.cache.set(SHARD_QUEUE, queue, { persist: true });
    writeLibrary = () => localCtx.cache.set(SHARD_LIBRARY, library, { persist: true });
    writeHistory = () => localCtx.cache.set(SHARD_HISTORY, history, { persist: true });

    // Debounced writer wrapper: catch rejected promises and guard
    // against stale generation writes.
    const safeWrite = (writer: () => Promise<true>, shard: string): void => {
        if (gen !== initGeneration) return; // stale — skip
        void writer().catch((err) => {
            console.error(`[yt-dlp] Failed to persist shard "${shard}":`, err);
        });
    };

    if (hasTimers()) {
        persistQueue = debounce(() => { safeWrite(writeQueue!, SHARD_QUEUE); }, DEBOUNCE_MS);
        persistLibrary = debounce(() => { safeWrite(writeLibrary!, SHARD_LIBRARY); }, DEBOUNCE_MS);
        persistHistory = debounce(() => { safeWrite(writeHistory!, SHARD_HISTORY); }, DEBOUNCE_MS);
    } else {
        console.warn('[yt-dlp] setTimeout unavailable — using synchronous cache writes');
        persistQueue = () => { safeWrite(writeQueue!, SHARD_QUEUE); };
        persistLibrary = () => { safeWrite(writeLibrary!, SHARD_LIBRARY); };
        persistHistory = () => { safeWrite(writeHistory!, SHARD_HISTORY); };
    }

    // Persist the paused transitions if any occurred
    if (queue.some((e) => e.status === 'paused')) {
        persistQueue();
    }
}

/**
 * Returns the full plugin state as a readonly snapshot.
 */
export function getState(): Readonly<PluginState> {
    return { queue, library, history };
}

/**
 * Returns the current download queue.
 */
export function getQueue(): readonly QueueEntry[] {
    return queue;
}

/**
 * Returns the current library entries.
 */
export function getLibrary(): readonly LibraryEntry[] {
    return library;
}

/**
 * Add a new entry to the download queue.
 *
 * Generates a unique ID, appends the entry, persists, and notifies.
 *
 * @param entry - Queue entry fields without the `id`.
 * @returns The generated entry ID.
 */
export function enqueue(entry: Omit<QueueEntry, 'id'>): string {
    const id = generateId();
    queue.push({ ...entry, id });
    persistQueue?.();
    notify();
    return id;
}

/**
 * Patch fields on an existing queue entry.
 *
 * @param id    - The entry ID to update.
 * @param patch - Partial fields to merge.
 */
export function updateQueueEntry(id: string, patch: Partial<QueueEntry>): void {
    const entry = queue.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    persistQueue?.();
    notify();
}

/**
 * Lightweight progress-only update for a queue entry.
 *
 * Updates progress fields in memory WITHOUT triggering `notify()` or the
 * full `state-update` broadcast. This avoids O(state size) UI traffic on
 * every 100ms progress tick during long downloads.
 *
 * Use this for high-frequency progress updates. Structural changes
 * (status transitions, enqueue, completion) should still use
 * `updateQueueEntry()` for full fan-out.
 *
 * @param id    - The entry ID to update.
 * @param patch - Progress-related fields only.
 */
export function updateQueueProgress(
    id: string,
    patch: Pick<Partial<QueueEntry>, 'progress' | 'speed' | 'eta' | 'lastKnownPercent' | 'attempt'>,
): void {
    const entry = queue.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    // Notify in-process subscribers but skip full state-update broadcast.
    // Progress is ephemeral (recovered via resume-loop), so no persist.
    notifySubscribers();
}

/**
 * Remove an entry from the download queue by ID.
 *
 * @param id - The entry ID to remove.
 */
export function removeQueueEntry(id: string): void {
    const idx = queue.findIndex((e) => e.id === id);
    if (idx === -1) return;
    queue.splice(idx, 1);
    persistQueue?.();
    notify();
}

/**
 * Add a completed download to the library.
 *
 * @param entry - The library entry to add.
 */
export function addToLibrary(entry: LibraryEntry): void {
    library.push(entry);
    persistLibrary?.();
    notify();
}

/**
 * Remove a library entry by ID.
 *
 * @param id - The library entry ID to remove.
 */
export function removeFromLibrary(id: string): void {
    const idx = library.findIndex((e) => e.id === id);
    if (idx === -1) return;
    library.splice(idx, 1);
    persistLibrary?.();
    notify();
}

/**
 * Toggle the `favorite` flag on a library entry.
 *
 * Branch A: no annotation hooks (closures work, no SDK API needed).
 *
 * @param id - The library entry ID.
 * @returns The new `favorite` value, or `false` if entry not found.
 */
export function toggleFavorite(id: string): boolean {
    const entry = library.find((e) => e.id === id);
    if (!entry) return false;
    entry.favorite = !entry.favorite;
    persistLibrary?.();
    notify();
    return entry.favorite;
}

/**
 * Add a URL to the recently-used history.
 *
 * Prepends, deduplicates, and caps at 100 entries.
 *
 * @param url - The URL to record.
 */
export function addToHistory(url: string): void {
    // Remove duplicates first, then prepend
    history = [url, ...history.filter((u) => u !== url)].slice(0, HISTORY_CAP);
    persistHistory?.();
    notify();
}

/**
 * Subscribe to state changes.
 *
 * @param listener - Callback invoked on every state mutation.
 * @returns An unsubscribe function.
 */
export function subscribe(listener: () => void): () => void {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
}

/**
 * Register a WebView panel ID for state broadcasts.
 *
 * `postToWebPanel` fans out by panelId — no instance tracking needed.
 *
 * @param id - The panel ID to register.
 */
export function registerPanelForBroadcast(id: string): void {
    panelIds.add(id);
}

/**
 * Send a message to all registered WebView panels.
 *
 * Wraps each `postToWebPanel` call in try/catch so one dead panel
 * does not prevent delivery to the others. Dead panels are pruned
 * from the set on first failure to avoid unbounded growth.
 *
 * @param message - The outbound message to broadcast.
 */
export function broadcastToWebPanels(message: PanelOutboundMessage): void {
    if (!ctx) return;
    for (const panelId of panelIds) {
        try {
            ctx.ui.postToWebPanel(panelId, message);
        } catch (err) {
            console.warn(`[yt-dlp] postToWebPanel("${panelId}") failed — removing dead panel:`, err);
            panelIds.delete(panelId);
        }
    }
}

/**
 * Immediately flush all pending debounced writes to the Cache API.
 *
 * Writes the three mutable shards (queue, library, history). The
 * `initialized` shard is excluded because `markFirstRunComplete`
 * always writes immediately (no debounce to flush).
 *
 * Called by `deactivate` and `app.willQuit` to ensure nothing is lost.
 */
export async function flushPersistedState(): Promise<void> {
    if (!ctx) return;
    await Promise.all([
        writeQueue?.() ?? Promise.resolve(true as const),
        writeLibrary?.() ?? Promise.resolve(true as const),
        writeHistory?.() ?? Promise.resolve(true as const),
    ]);
}

/**
 * Check whether this is the plugin's first run.
 *
 * @returns `true` if the `ytdlp:initialized` flag has NOT been set.
 */
export async function isFirstRun(): Promise<boolean> {
    if (!ctx) return true;
    const val = await ctx.cache.get(SHARD_INIT);
    return val !== true;
}

/**
 * Mark first-run setup as complete.
 */
export async function markFirstRunComplete(): Promise<void> {
    if (!ctx) return;
    await ctx.cache.set(SHARD_INIT, true, { persist: true });
}

/**
 * Store the latest dependency statuses (in-memory only) and broadcast
 * a fresh `state-update` so panels receive the updated dependency
 * snapshot immediately.
 *
 * Called by main.ts whenever `onDependencyStatusChanged` fires.
 *
 * @param statuses - The current dependency status array.
 */
export function setDependencyStatuses(statuses: DependencyStatus[]): void {
    dependencyStatuses = statuses;
    emitStateUpdate();
}

/**
 * Returns the last-known dependency status snapshot.
 */
export function getDependencyStatuses(): readonly DependencyStatus[] {
    return dependencyStatuses;
}

/**
 * Convenience: check whether yt-dlp is available.
 */
export function isYtDlpAvailable(): boolean {
    return dependencyStatuses.some(
        (s) => s.name === 'yt-dlp' && s.satisfied === true,
    );
}

/**
 * Convenience: check whether ffmpeg is available.
 */
export function isFfmpegAvailable(): boolean {
    return dependencyStatuses.some(
        (s) => s.name === 'ffmpeg' && s.satisfied === true,
    );
}

/**
 * Read current plugin settings and return a typed snapshot.
 *
 * @returns A `SettingsSnapshot` with all canonical setting values.
 */
export function getSettingsSnapshot(): SettingsSnapshot {
    if (!ctx) {
        return {
            outputDir: '',
            proxyUrl: '',
            filenameTemplate: '',
            defaultFormat: 'best',
            defaultQuality: 'best',
            metadataDepth: 'basic',
        };
    }

    return {
        outputDir: (ctx.settings.get('outputDir') as string) ?? '',
        proxyUrl: (ctx.settings.get('proxyUrl') as string) ?? '',
        filenameTemplate: (ctx.settings.get('filenameTemplate') as string) ?? '',
        defaultFormat: (ctx.settings.get('defaultFormat') as string) ?? 'best',
        defaultQuality: (ctx.settings.get('defaultQuality') as string) ?? 'best',
        metadataDepth: (ctx.settings.get('metadataDepth') as string) ?? 'basic',
    };
}

/**
 * Broadcast the canonical `state-update` message to all registered panels.
 *
 * Builds a full snapshot including queue, library, history, settings,
 * and dependency statuses. Called internally by `notify()` on every
 * mutation so panels never go stale.
 */
export function emitStateUpdate(): void {
    if (panelIds.size === 0) return;
    broadcastToWebPanels({
        v: 1,
        type: 'state-update',
        queue,
        library,
        history,
        settings: getSettingsSnapshot(),
        dependencyStatuses: [...dependencyStatuses],
    });
}

/**
 * Broadcast a `settings-update` message to all registered panels.
 *
 * Reads a fresh snapshot and sends `{ v:1, type:'settings-update', settings }`.
 * Called from main.ts when a settings change is detected.
 */
export function emitSettingsUpdate(): void {
    const settings = getSettingsSnapshot();
    broadcastToWebPanels({ v: 1, type: 'settings-update', settings });
}
