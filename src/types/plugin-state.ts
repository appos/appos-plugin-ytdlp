/**
 * Canonical plugin state shapes for the yt-dlp plugin.
 *
 * Defines the runtime data structures persisted via the Cache API and
 * shared across core, services, and panel modules. Every field is
 * documented with its role in the download lifecycle.
 *
 * @module plugin-state
 */

import type { DependencyStatus } from '@appos.space/plugin-types';

// ── Download lifecycle ──────────────────────────────────────────────

/**
 * Download status lifecycle.
 *
 * State machine:
 *   queued → downloading → (extracting) → complete | failed | cancelled
 *
 * `paused` is a **restart-recovery-only** state in v1: `initState`
 * transitions `downloading → paused` on plugin load so
 * `resumeInterruptedQueue` can find and re-enqueue them.
 * No live user action produces the `paused` status on an individual entry.
 * Queue-wide `pause-queue` / `resume-queue` controls the `queuePaused` flag
 * (stops dequeuing new entries) but does NOT transition active entries to `paused`.
 *
 * The `extracting` state represents the post-download ffmpeg merge/transcode/embed
 * phase; distinct because it can take meaningful time and may trigger its own
 * resume-loop cycles.
 */
export type DownloadStatus =
    | 'queued'
    | 'downloading'
    | 'extracting'
    | 'paused'
    | 'complete'
    | 'failed'
    | 'cancelled';

// ── Request snapshot ────────────────────────────────────────────────

/**
 * Persisted execution snapshot — everything the downloader needs to rebuild
 * the exact yt-dlp command after a restart.
 *
 * `outputDir` MUST be the resolved ABSOLUTE POSIX path (`~` expanded),
 * NOT a raw setting value.
 * `advancedArgs` is a ready-to-append string array, not a raw text field —
 * tokenization happens at enqueue time.
 */
export interface QueueRequestSnapshot {
    format: string;
    quality: string;
    outputDir: string;
    filenameTemplate: string;
    proxyUrl?: string;
    advancedArgs?: string[];
    archivePath: string;
    tempDir: string;
}

// ── Queue entry ─────────────────────────────────────────────────────

/**
 * A single item in the download queue.
 *
 * `groupTag` is the machine-readable playlist group ID.
 * `groupLabel` is the human-readable label rendered in the queue view
 * (e.g., `Playlist: {playlistTitle}`) — persisted so the queue view can
 * reconstruct group headers after a restart.
 *
 * `finalFilePath` / `finalFileUrl` are populated by the downloader on success
 * and let the queue view's Reveal action find the downloaded file without a
 * separate library lookup.
 *
 * `libraryId` mirrors the `LibraryEntry.id` created on success; by invariant
 * the downloader reuses the queue entry's `id` as the library ID, but this
 * field makes the link explicit.
 */
export interface QueueEntry {
    id: string;
    url: string;
    title?: string;
    status: DownloadStatus;
    progress: number;
    speed: string | null;
    eta: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    groupTag: string | null;
    groupLabel: string | null;
    attempt: number;
    lastKnownPercent: number | null;
    createdAt: string;
    finalFilePath: string | null;
    finalFileUrl: string | null;
    libraryId: string | null;
    request: QueueRequestSnapshot;
}

// ── Library entry ───────────────────────────────────────────────────

/**
 * A completed download with file reference, persisted in the library.
 *
 * The `request` snapshot is carried over from the `QueueEntry` at completion
 * so "Download again" in the library panel can reuse the exact original options
 * (format, quality, template, proxy, advancedArgs) without depending on
 * current settings.
 */
export interface LibraryEntry {
    id: string;
    sourceUrl: string;
    fileUrl: string;
    filePath: string;
    title: string;
    uploader?: string;
    duration?: number;
    fileExt: string;
    fileSize: number;
    thumbnailUrl?: string;
    downloadedAt: string;
    favorite: boolean;
    groupTag?: string;
    request: QueueRequestSnapshot;
}

// ── Parsed error ────────────────────────────────────────────────────

/**
 * Human-readable error with context, produced by the error parser.
 *
 * `category` is the canonical error classification used across the plugin.
 * The optional `tool` (e.g. `'yt-dlp'`) and `exitCode` fields are populated
 * by the caller (downloader/metadata/playlist services) so error surfaces
 * can render messages like `"yt-dlp exited with 1: HTTP 429 rate limited"`.
 */
export interface ParsedError {
    message: string;
    category: ParsedErrorCategory;
    raw: string;
    recoverable: boolean;
    tool?: string;
    exitCode?: number;
}

/** Canonical error categories for `ParsedError.category`. */
export type ParsedErrorCategory =
    | 'drm'
    | 'geo'
    | 'invalid_url'
    | 'auth'
    | 'rate_limit'
    | 'network'
    | 'disk_full'
    | 'partial'
    | 'dependency_missing'
    | 'unknown';

// ── Settings snapshot ───────────────────────────────────────────────

/**
 * Canonical type for the `settings` field inside `state-update` and
 * `settings-update` messages. `state.getSettingsSnapshot()` returns it,
 * and panels consume it for rendering defaults.
 *
 * Defined here (not in `webview-messages.ts`) because it is a plugin-state
 * shape that also happens to be serialized into messages.
 */
export interface SettingsSnapshot {
    outputDir: string;
    proxyUrl: string;
    filenameTemplate: string;
    defaultFormat: string;
    defaultQuality: string;
    metadataDepth: string;
}

// ── Top-level state ─────────────────────────────────────────────────

/** Plugin state persisted via Cache API. */
export interface PluginState {
    queue: QueueEntry[];
    library: LibraryEntry[];
    history: string[];
}

// Re-export DependencyStatus for downstream convenience
export type { DependencyStatus };
