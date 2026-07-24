/**
 * Error parser for yt-dlp stderr output.
 *
 * Maps raw yt-dlp error strings to the canonical `ParsedError` shape defined
 * in `types/plugin-state`. This is a pure-function module — no host API
 * imports — so it can be unit-tested under `tsx` without a mock `ctx`.
 *
 * The regex table is the battle-tested pattern set from the original plugin,
 * remapped to the canonical `ParsedErrorCategory` union.
 *
 * @module error-parser
 */

import type { ParsedError, ParsedErrorCategory } from '../types/plugin-state';

// ── Pattern table ──────────────────────────────────────────────────
//
// Each entry maps a yt-dlp stderr pattern to a canonical category.
// First match wins. The `message` is user-facing (non-technical).
// The `suggestion` is a next-step hint for the UI.

/**
 * Pattern entry. `recoverable` is NOT stored here — it is derived from
 * `isRecoverable(category)` at runtime so there is a single source of truth.
 */
interface ErrorPattern {
    pattern: RegExp;
    category: ParsedErrorCategory;
    message: string;
    suggestion: string | null;
}

const ERROR_PATTERNS: ErrorPattern[] = [
    // ── DRM ────────────────────────────────────────────────────────
    // yt-dlp emits "DRM protected" or "purchased content" when the
    // source encrypts the stream with Widevine/FairPlay.
    {
        pattern: /DRM\s*protect|purchased\s+content/i,
        category: 'drm',
        message: 'This content uses DRM protection and cannot be downloaded.',
        suggestion: 'This is a limitation of the source, not a bug.',
    },

    // ── Geo-restriction ────────────────────────────────────────────
    // Emitted when the IP is outside the allowed region. Includes
    // "geo-restricted", "not available in your country", "blocked in your region".
    {
        pattern: /geo[- ]?restrict|not available in your country|blocked in your region/i,
        category: 'geo',
        message: 'This content is not available in your region.',
        suggestion: 'Try enabling geo-bypass in Advanced settings, or configure a proxy.',
    },

    // ── Authentication ─────────────────────────────────────────────
    // Emitted when the video requires login, cookies, or OAuth.
    {
        pattern: /sign\s+in|authenticat|login\s+required|cookies/i,
        category: 'auth',
        message: 'This content requires authentication.',
        suggestion: 'Authentication support coming in a future update.',
    },

    // ── Rate limiting ──────────────────────────────────────────────
    // HTTP 429, explicit "rate limit", or "too many requests" from the source.
    {
        pattern: /429|rate\s*limit|too many requests/i,
        category: 'rate_limit',
        message: 'The source site is rate-limiting requests.',
        suggestion: 'Wait a few minutes and try again. The download will auto-retry.',
    },

    // ── Network ────────────────────────────────────────────────────
    // Connection failures, DNS, SSL, timeouts.
    {
        pattern: /network|connection|timed?\s*out|DNS|SSL|ENETUNREACH|ECONNREFUSED/i,
        category: 'network',
        message: 'Network error — check your internet connection.',
        suggestion: 'Check your connection and retry.',
    },

    // ── Disk full ──────────────────────────────────────────────────
    // POSIX ENOSPC, "No space left", "disk full".
    {
        pattern: /No space left|disk full|ENOSPC/i,
        category: 'disk_full',
        message: 'Not enough disk space to complete the download.',
        suggestion: 'Free up disk space and retry.',
    },

    // ── Partial download ───────────────────────────────────────────
    // Detected when stderr mentions partial/resume state. The `partial`
    // category is only set when `exitCode` is nonzero (handled in
    // parseYtDlpError logic below), otherwise it indicates a normal resume.
    {
        pattern: /already been downloaded|has already been recorded|Resuming download/i,
        category: 'partial',
        message: 'Download was partially completed.',
        suggestion: 'The download can be resumed automatically.',
    },

    // ── Invalid URL ────────────────────────────────────────────────
    // "Unsupported URL", "is not a valid URL", "no suitable InfoExtractor".
    // Legacy "unsupported" maps here — the URL itself is the problem.
    {
        pattern: /Unsupported URL|is not a valid URL|no suitable InfoExtractor/i,
        category: 'invalid_url',
        message: 'This URL is not supported by yt-dlp.',
        suggestion: 'Check the supported sites list at https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md',
    },

    // ── Unavailable / private ──────────────────────────────────────
    // "unavailable", "private video", "removed by uploader", "no longer available".
    // No dedicated category — maps to `unknown` as a catch-all (unless a
    // geo hint is present, which would match the geo pattern first).
    {
        pattern: /unavailable|private video|removed by uploader|video is no longer available/i,
        category: 'unknown',
        message: 'This video is unavailable or has been removed.',
        suggestion: null,
    },

    // ── Dependency missing ─────────────────────────────────────────
    // "command not found", "No such file", or host-injected DEPENDENCY_MISSING marker.
    {
        pattern: /command not found|No such file|DEPENDENCY_MISSING/i,
        category: 'dependency_missing',
        message: 'A required tool is not installed.',
        suggestion: 'Check the Dependencies panel in the sidebar.',
    },
];

// ── Options type ───────────────────────────────────────────────────

/** Optional context the caller provides to enrich the ParsedError. */
export interface ParseErrorOpts {
    /** The tool that produced the stderr (e.g. `'yt-dlp'`). */
    tool?: string;
    /** The process exit code, used to disambiguate partial downloads. */
    exitCode?: number;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Parse yt-dlp stderr output into a canonical `ParsedError`.
 *
 * First matching pattern wins. Falls back to `unknown` if no match.
 * The optional `opts` parameter lets callers attach `tool` and `exitCode`
 * so error surfaces can render messages like
 * `"yt-dlp exited with 1: HTTP 429 rate limited"`.
 *
 * @param stderr - Raw stderr output from yt-dlp process
 * @param opts - Optional tool name and exit code for richer error context
 * @returns Canonical `ParsedError` with human-readable message
 */
export function parseYtDlpError(stderr: string, opts?: ParseErrorOpts): ParsedError {
    const safeRaw = extractErrorLine(stderr);

    for (const pattern of ERROR_PATTERNS) {
        if (pattern.pattern.test(stderr)) {
            // Special handling for partial: only classify as `partial` when
            // exit code is nonzero (indicating an actual failure, not a
            // successful resume).
            if (pattern.category === 'partial') {
                const exitCode = opts?.exitCode;
                if (exitCode === undefined || exitCode === 0) {
                    // Successful resume — not an error, but still report it
                    // as unknown with the partial message for informational purposes
                    continue;
                }
            }

            return {
                category: pattern.category,
                message: pattern.message,
                raw: safeRaw,
                recoverable: isRecoverable(pattern.category),
                ...(opts?.tool !== undefined ? { tool: opts.tool } : {}),
                ...(opts?.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
            };
        }
    }

    // Fallback: generic error with the extracted error line
    return {
        category: 'unknown',
        message: 'Download failed. Check the terminal output for details.',
        raw: safeRaw,
        recoverable: false,
        ...(opts?.tool !== undefined ? { tool: opts.tool } : {}),
        ...(opts?.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    };
}

/**
 * Check whether an error category is recoverable (eligible for auto-retry).
 *
 * Recoverable categories: `network`, `rate_limit`, `partial`, `dependency_missing`.
 * All others are permanent failures.
 *
 * @param category - A `ParsedErrorCategory` value
 * @returns `true` if the error is eligible for retry
 */
export function isRecoverable(category: ParsedErrorCategory): boolean {
    switch (category) {
        case 'network':
        case 'rate_limit':
        case 'partial':
        case 'dependency_missing':
            return true;
        default:
            return false;
    }
}

/**
 * Extract the last `ERROR:` or `WARNING:` line from yt-dlp stderr output.
 *
 * Returns the last matching line (not first) because yt-dlp often emits
 * multiple warnings before the final error. Returns empty string if no
 * matching line is found.
 *
 * Only returns the matched line (not the full stderr buffer) to avoid
 * leaking local paths, proxy URLs, or other sensitive CLI context across
 * the plugin-to-webview boundary.
 *
 * @param stderr - Raw stderr output
 * @returns The last ERROR:/WARNING: line, or empty string
 */
export function extractErrorLine(stderr: string): string {
    const lines = stderr.split('\n');
    let lastMatch = '';

    for (const line of lines) {
        if (/ERROR:|WARNING:/.test(line)) {
            lastMatch = line.trim();
        }
    }

    return lastMatch;
}
