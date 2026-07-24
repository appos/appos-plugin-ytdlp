/**
 * Playlist probe and selection service.
 *
 * Probes playlist URLs with `yt-dlp --dump-single-json --flat-playlist`
 * for lightweight enumeration (no per-video metadata resolution, ~10x
 * faster than full probe). Normalizes entry URLs, generates canonical
 * `groupTag` / `groupLabel`, and provides an ephemeral selection API for
 * the download panel form.
 *
 * ## Why `--dump-single-json` over `--dump-json`
 *
 * `--dump-json` emits one JSON object *per entry* (N lines), requiring
 * NDJSON parsing and risking 10MB output cap on large playlists.
 * `--dump-single-json` aggregates all entries into a single JSON object
 * with an `entries[]` array — one parse, one object, predictable size.
 *
 * ## Why 500 is the default cap
 *
 * The host enforces a 120s hard timeout on shell processes. Flat-playlist
 * enumeration for YouTube takes ~10-30s for 100 entries, so 500 is a safe
 * cap that stays well under 120s for most extractors. Users needing more
 * can pass `maxEntries` explicitly (v1.1 will add `--playlist-start` for
 * follow-up pages).
 *
 * @module playlist-service
 */

import type { PluginContext } from '@appos.space/plugin-types';
import type { PlaylistEntry, ParsedError } from '../types';

import { simpleHash } from '@appos.space/plugin-utils';
import { isValidMediaUrl } from '../core/security';
import { parseYtDlpError } from '../core/error-parser';
import { validateOutputDir, ensureOutputDir } from '../core/paths';
import { shellWithRetry } from './shell-with-retry';

// ── Default cap ────────────────────────────────────────────────────

/** Default maximum entries to enumerate (see module header for rationale). */
const DEFAULT_MAX_ENTRIES = 500;

// ── Raw flat-playlist entry shape ──────────────────────────────────

/** Loose typing for a single entry in flat-playlist JSON output. */
interface RawPlaylistEntry {
    id?: string;
    url?: string;
    webpage_url?: string;
    original_url?: string;
    ie_key?: string;
    title?: string;
    duration?: number | null;
}

// ── Known extractor URL synthesizers ───────────────────────────────

/**
 * Map of known `ie_key` values to URL synthesis functions.
 * Used when `webpage_url` and `original_url` are absent and the `url`
 * field is a bare extractor ID.
 */
const EXTRACTOR_URL_BUILDERS: Record<string, (id: string) => string> = {
    Youtube: (id) => `https://www.youtube.com/watch?v=${id}`,
    Vimeo: (id) => `https://vimeo.com/${id}`,
};

// ── URL normalization ──────────────────────────────────────────────

/**
 * Normalize a flat-playlist entry's URL to a full webpage URL.
 *
 * With `--flat-playlist`, yt-dlp often returns entries where the `url`
 * field is an extractor-specific ID (e.g., bare YouTube video ID like
 * `dQw4w9WgXcQ`), not a full URL. Queueing such entries later fails
 * because the downloader passes them as the URL argv to yt-dlp.
 *
 * Resolution order:
 *   1. `webpage_url` (full URL, most reliable)
 *   2. `original_url` (fallback from some extractors)
 *   3. Synthesize from `(ie_key, id)` for known extractors
 *   4. Fall back to raw `url` and flag as `unresolved`
 *
 * @param entry - Raw flat-playlist entry from yt-dlp JSON.
 * @returns Tuple of `[normalizedUrl, unresolved]`.
 */
function normalizeEntryUrl(entry: RawPlaylistEntry): [string, boolean] {
    // Prefer full URLs from yt-dlp
    if (entry.webpage_url && looksLikeUrl(entry.webpage_url)) {
        return [entry.webpage_url, false];
    }
    if (entry.original_url && looksLikeUrl(entry.original_url)) {
        return [entry.original_url, false];
    }

    // If entry.url is already a full URL, use it directly
    if (entry.url && looksLikeUrl(entry.url)) {
        return [entry.url, false];
    }

    // Synthesize from known extractor + bare id. entry.url is safe here because
    // the full-URL check above already returned for http(s) URLs.
    const bareId = entry.id ?? entry.url ?? '';
    const ieKey = entry.ie_key ?? '';
    const builder = EXTRACTOR_URL_BUILDERS[ieKey];
    if (builder && bareId) {
        return [builder(bareId), false];
    }

    // Last resort: bare url/id — flag as unresolved
    const fallback = entry.url ?? entry.id ?? '';
    return [fallback, true];
}

/** Quick check whether a string looks like a full URL (starts with http). */
function looksLikeUrl(s: string): boolean {
    return s.startsWith('http://') || s.startsWith('https://');
}

// ── Public types ───────────────────────────────────────────────────

/** Successful playlist probe result. */
export interface PlaylistProbeResult {
    /** Playlist ID from yt-dlp. */
    playlistId: string;
    /** Playlist title (may be a fallback). */
    playlistTitle: string;
    /** Uploader name, if available. */
    uploader?: string;
    /** Total entry count reported by yt-dlp (`playlist_count`). */
    totalCount: number;
    /** Number of entries actually fetched (capped by `maxEntries`). */
    fetchedCount: number;
    /** Normalized playlist entries. */
    entries: PlaylistEntry[];
    /** Machine-readable group ID: `playlist:${id}:${hash}:${timestamp}`. */
    groupTag: string;
    /** Human-readable label for queue view section headers. */
    groupLabel: string;
}

/**
 * Discriminated outcome of a playlist probe.
 *
 * - `ok` — probe succeeded with entries
 * - `error` — probe failed with a categorized error
 */
export type PlaylistProbeOutcome =
    | { kind: 'ok'; result: PlaylistProbeResult }
    | { kind: 'error'; error: ParsedError };

// ── probePlaylist ──────────────────────────────────────────────────

/**
 * Probe a playlist URL for entries via `yt-dlp --flat-playlist`.
 *
 * Validates the URL, resolves the output directory, spawns yt-dlp with
 * `--dump-single-json --flat-playlist`, parses the JSON, normalizes
 * entry URLs, and builds canonical `groupTag` / `groupLabel`.
 *
 * @param ctx - Plugin context for shell execution and settings.
 * @param playlistUrl - The playlist URL to probe.
 * @param options - Optional cap on entries to enumerate (default 500).
 * @returns Discriminated `PlaylistProbeOutcome`.
 */
export async function probePlaylist(
    ctx: PluginContext,
    playlistUrl: string,
    options?: { maxEntries?: number },
): Promise<PlaylistProbeOutcome> {
    // Step 1: URL validation
    const urlCheck = isValidMediaUrl(playlistUrl);
    if (!urlCheck.ok) {
        return {
            kind: 'error',
            error: {
                message: urlCheck.reason,
                category: 'invalid_url',
                raw: '',
                recoverable: false,
            },
        };
    }

    // Step 2: Build args
    const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const args = [
        '--ignore-config',       // Neutralise ambient ~/.config/yt-dlp/config (security)
        '--dump-single-json',    // Single JSON blob, not N lines (see module header)
        '--flat-playlist',       // Skip per-video metadata resolution (~10x faster)
        '--no-warnings',
        '--playlist-end', String(maxEntries),
        playlistUrl,
    ];

    // Step 3: Resolve cwd via outputDir validation then ensureOutputDir
    const outputDirSetting = ctx.settings.get('outputDir') as string || '';
    const dirValidation = validateOutputDir(outputDirSetting);
    if (!dirValidation.ok) {
        return {
            kind: 'error',
            error: {
                message: dirValidation.reason,
                category: 'unknown',
                raw: '',
                recoverable: false,
            },
        };
    }

    let cwd: string;
    try {
        cwd = await ensureOutputDir(ctx, dirValidation.resolved);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            kind: 'error',
            error: { message, category: 'unknown', raw: '', recoverable: false },
        };
    }

    // Step 4: Build executor closure
    const exec = (opts: Parameters<typeof ctx.shell.execute>[0]) => ctx.shell.execute(opts);

    // Step 5: Execute with single retry (60s timeout)
    const result = await shellWithRetry(
        exec,
        { command: 'yt-dlp', args, cwd, timeout: 60 },
        { retry: 'single' },
    );

    // Non-zero exit → error
    if (result.exitCode !== 0) {
        return {
            kind: 'error',
            error: parseYtDlpError(result.stderr, {
                tool: 'yt-dlp',
                exitCode: result.exitCode,
            }),
        };
    }

    // Step 6: Parse JSON
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(result.stdout);
    } catch {
        return {
            kind: 'error',
            error: {
                message: 'Failed to parse yt-dlp playlist output as JSON',
                category: 'unknown',
                raw: result.stdout.slice(0, 200),
                recoverable: false,
            },
        };
    }

    // Step 7: Extract top-level fields
    const playlistId = String(json.id ?? 'unknown');
    // Missing title is a known yt-dlp issue (#11234) — fall back to id or generic
    const playlistTitle = (typeof json.title === 'string' && json.title)
        ? json.title
        : (playlistId !== 'unknown' ? playlistId : 'Playlist');
    const uploader = typeof json.uploader === 'string' ? json.uploader : undefined;
    const totalCount = typeof json.playlist_count === 'number'
        ? json.playlist_count
        : (Array.isArray(json.entries) ? json.entries.length : 0);

    // Step 8: Map entries with URL normalization
    // Filter out null/non-object entries — yt-dlp can emit null placeholders
    // for unavailable/deleted videos in playlist JSON output.
    const rawEntries: RawPlaylistEntry[] = Array.isArray(json.entries)
        ? (json.entries as unknown[]).filter(
            (e): e is RawPlaylistEntry => typeof e === 'object' && e !== null,
        )
        : [];
    const entries: PlaylistEntry[] = rawEntries.map((raw, index) => {
        const [url, unresolved] = normalizeEntryUrl(raw);
        const id = String(raw.id ?? raw.url ?? '');
        const entry: PlaylistEntry = {
            id,
            url,
            title: raw.title ?? 'Untitled',
            // Stable per-occurrence key — unique even when the same media ID
            // appears multiple times in a playlist (e.g. duplicated videos).
            selectionKey: `${id}:${index}`,
            ...(raw.duration != null ? { duration: raw.duration } : {}),
            ...(unresolved ? { unresolved: true } : {}),
        };
        return entry;
    });

    // Step 9: Build groupTag and groupLabel
    const groupTag = `playlist:${playlistId}:${simpleHash(playlistTitle)}:${Date.now()}`;
    const groupLabel = `Playlist: ${playlistTitle}`;

    // Step 10: Return success
    return {
        kind: 'ok',
        result: {
            playlistId,
            playlistTitle,
            ...(uploader ? { uploader } : {}),
            totalCount,
            fetchedCount: entries.length,
            entries,
            groupTag,
            groupLabel,
        },
    };
}

// ── PlaylistSelection ──────────────────────────────────────────────

/**
 * Ephemeral selection state for playlist entries.
 *
 * Used by the download panel form to track which playlist
 * entries the user wants to download. Not persisted — lives only for
 * the duration of a panel session.
 */
export class PlaylistSelection {
    private readonly _allIds: readonly string[];
    private readonly _allIdSet: ReadonlySet<string>;
    private readonly _selected: Set<string>;

    /** Create a selection initialized with all entries selected. */
    constructor(allIds: readonly string[]) {
        this._allIds = allIds;
        this._allIdSet = new Set(allIds);
        this._selected = new Set(allIds);
    }

    /** Toggle an entry's selection state. Ignores unknown IDs. */
    toggle(id: string): void {
        if (!this._allIdSet.has(id)) return;
        if (this._selected.has(id)) {
            this._selected.delete(id);
        } else {
            this._selected.add(id);
        }
    }

    /** Select all entries. */
    selectAll(): void {
        for (const id of this._allIds) {
            this._selected.add(id);
        }
    }

    /** Deselect all entries. */
    deselectAll(): void {
        this._selected.clear();
    }

    /** Replace the current selection with the given IDs. Ignores unknown IDs. */
    setSelected(ids: Iterable<string>): void {
        this._selected.clear();
        for (const id of ids) {
            if (this._allIdSet.has(id)) {
                this._selected.add(id);
            }
        }
    }

    /** Check whether a specific entry is selected. */
    isSelected(id: string): boolean {
        return this._selected.has(id);
    }

    /** Get all currently selected IDs (order matches original `allIds`). */
    getSelectedIds(): string[] {
        return this._allIds.filter((id) => this._selected.has(id));
    }

    /** Get the count of currently selected entries. */
    getSelectedCount(): number {
        return this._selected.size;
    }
}
