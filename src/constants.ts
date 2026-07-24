/**
 * Constants and configuration for the yt-dlp plugin.
 *
 * Error patterns, panel IDs, timing thresholds, supported formats.
 * Error pattern `category` values match the canonical
 * `ParsedError['category']` union from `./types/plugin-state`.
 */

import type { ParsedErrorCategory } from './types/plugin-state';

export const PLUGIN_ID = 'space.appos.ytdlp';
export const PLUGIN_NAME = 'yt-dlp Media Downloader';
export const DEFAULT_OUTPUT_DIR = '~/Downloads/yt-dlp/';
export const CACHE_NAMESPACE = 'ytdlp';
export const MAX_CACHE_SIZE_MB = 50;

/** Panel IDs for webview registration — download and library only. */
export const PANELS = {
    DOWNLOAD: 'download',
    LIBRARY: 'library',
} as const;

/** Workspace template ID */
export const WORKSPACE_TEMPLATE_ID = 'ytdlp-workspace';

/** MenuBar item ID */
export const MENUBAR_ITEM_ID = 'ytdlp-menubar';

// ── Timing thresholds ───────────────────────────────────────────────

/**
 * Shell timeout cap — 1 second less than the host-enforced 120 s hard cap
 * so the resume-loop can detect timeout vs. genuine failure.
 */
export const PROCESS_TIMEOUT_SECONDS = 119;

/** Throttle interval for queue-update messages to the webview (10 Hz). */
export const QUEUE_UPDATE_THROTTLE_MS = 100;

/** Debounce interval for persisting state to the Cache API. */
export const STATE_PERSIST_DEBOUNCE_MS = 500;

/** Debounce interval for URL probe requests from the webview. */
export const PROBE_DEBOUNCE_MS = 500;

// ── Error patterns ──────────────────────────────────────────────────

/**
 * yt-dlp stderr patterns mapped to human-readable errors.
 * Each pattern is tested against stderr output; first match wins.
 *
 * The `category` field uses the canonical `ParsedErrorCategory` union.
 */
export const ERROR_PATTERNS: Array<{
    pattern: RegExp;
    category: ParsedErrorCategory;
    message: string;
    recoverable: boolean;
    suggestion: string | null;
}> = [
    {
        pattern: /ERROR:.*DRM/i,
        category: 'drm',
        message: 'This content uses DRM protection and cannot be downloaded.',
        recoverable: false,
        suggestion: 'This is a limitation of the source, not a bug.',
    },
    {
        pattern: /ERROR:.*(?:geo[- ]?restrict|not available in your country)/i,
        category: 'geo',
        message: 'This content is not available in your region.',
        recoverable: true,
        suggestion: 'Try enabling geo-bypass in Advanced settings, or configure a proxy.',
    },
    {
        pattern: /ERROR:.*(?:Sign in|login|authenticate)/i,
        category: 'auth',
        message: 'This content requires authentication.',
        recoverable: false,
        suggestion: 'Authentication support coming in a future update.',
    },
    {
        pattern: /ERROR:.*(?:Unsupported URL|not a valid URL)/i,
        category: 'invalid_url',
        message: 'This URL is not supported by yt-dlp.',
        recoverable: false,
        suggestion: 'Check the supported sites list at https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md',
    },
    {
        pattern: /ERROR:.*(?:HTTP Error 429|Too Many Requests|rate limit)/i,
        category: 'rate_limit',
        message: 'The source site is rate-limiting requests.',
        recoverable: true,
        suggestion: 'Wait a few minutes and try again. The download will auto-retry.',
    },
    {
        pattern: /ERROR:.*(?:No space left|disk full|ENOSPC)/i,
        category: 'disk_full',
        message: 'Not enough disk space to complete the download.',
        recoverable: true,
        suggestion: 'Free up disk space and retry.',
    },
    {
        pattern: /ERROR:.*(?:network|connection|timed? ?out|ENETUNREACH|ECONNREFUSED)/i,
        category: 'network',
        message: 'Network error — check your internet connection.',
        recoverable: true,
        suggestion: 'Check your connection and retry.',
    },
    {
        pattern: /ERROR:.*(?:Private video|Video unavailable)/i,
        category: 'invalid_url',
        message: 'This video is private or has been removed.',
        recoverable: false,
        suggestion: null,
    },
];

/** yt-dlp progress line regex — matches lines like: [download]  42.3% of 100.2MiB at 2.5MiB/s ETA 00:30 */
export const PROGRESS_REGEX = /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+(\S+)/;

/** Fragment progress regex — matches: [download] Downloading fragment 5 of 20 */
export const FRAGMENT_REGEX = /\[download\]\s+Downloading\s+fragment\s+(\d+)\s+of\s+(\d+)/;

/** Supported quality presets */
export const QUALITY_PRESETS = {
    'best': 'bestvideo+bestaudio/best',
    '2160p': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
    '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
    '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
    '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]',
    'audio-only': 'bestaudio',
} as const;

/** Smart folder filter IDs */
export const SMART_FOLDER_FILTERS = {
    VIDEOS: 'ytdlp-videos',
    AUDIO: 'ytdlp-audio',
    FAVORITES: 'ytdlp-favorites',
    RECENT: 'ytdlp-recent',
} as const;
