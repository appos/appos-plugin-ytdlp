/**
 * yt-dlp JSON type subset.
 *
 * Types that model the JSON output produced by `yt-dlp --dump-json`,
 * `--flat-playlist`, and stderr progress lines. Kept in a dedicated module
 * so plugin-state types stay free of yt-dlp specifics.
 *
 * @module yt-dlp
 */

// ── Raw JSON output ─────────────────────────────────────────────────

/**
 * Subset of the raw JSON blob produced by `yt-dlp --dump-json`.
 * Only the fields the plugin actually reads are typed here.
 */
export interface RawYtDlpJson {
    id: string;
    title: string;
    webpage_url: string;
    thumbnail?: string | null;
    duration?: number | null;
    uploader?: string | null;
    channel?: string | null;
    upload_date?: string | null;
    description?: string | null;
    view_count?: number | null;
    like_count?: number | null;
    formats?: RawFormatJson[];
    playlist_index?: number | null;
    playlist_title?: string | null;
    ext?: string;
    filesize?: number | null;
    filesize_approx?: number | null;
}

/** Raw format entry from yt-dlp JSON. */
interface RawFormatJson {
    format_id: string;
    ext: string;
    resolution?: string | null;
    fps?: number | null;
    vcodec?: string | null;
    acodec?: string | null;
    filesize?: number | null;
    filesize_approx?: number | null;
    tbr?: number | null;
    abr?: number | null;
}

// ── Plugin-level metadata ───────────────────────────────────────────

/**
 * Metadata extracted and normalized from `RawYtDlpJson`.
 * This is the shape the UI layer consumes — human-readable field names,
 * null-coalesced.
 */
export interface MediaMetadata {
    id: string;
    title: string;
    url: string;
    thumbnail: string | null;
    duration: number | null;
    uploader: string | null;
    uploadDate: string | null;
    description: string | null;
    viewCount: number | null;
    likeCount: number | null;
    formats: FormatInfo[];
    playlistIndex: number | null;
    playlistTitle: string | null;
}

/**
 * A single format option derived from yt-dlp format list.
 */
export interface FormatInfo {
    formatId: string;
    ext: string;
    resolution: string | null;
    fps: number | null;
    vcodec: string | null;
    acodec: string | null;
    filesize: number | null;
    filesizeApprox: number | null;
    tbr: number | null;
    abr: number | null;
    label: string;
}

// ── Playlist ────────────────────────────────────────────────────────

/**
 * A single entry inside a playlist as returned by `--flat-playlist`.
 *
 * The `unresolved` flag is set by the playlist service when URL normalization falls
 * through to a bare extractor ID; the download form UI surfaces a warning
 * on unresolved entries.
 */
export interface PlaylistEntry {
    id: string;
    url: string;
    title: string;
    duration?: number;
    unresolved?: boolean;
    /**
     * Stable per-occurrence selection key, unique even when the same media ID
     * appears multiple times in a playlist. Format: `${id}:${index}`.
     * Used by `PlaylistSelection` — callers should pass these keys (not raw
     * media `id`) to selection methods.
     */
    selectionKey: string;
}

// ── Progress ────────────────────────────────────────────────────────

/**
 * A single progress tick parsed from yt-dlp stderr.
 * Matched against `PROGRESS_REGEX` in constants.
 */
export interface ProgressTick {
    percent: number;
    total: string;
    speed: string;
    eta: string;
}
