/**
 * Security module for the yt-dlp plugin.
 *
 * Provides a CVE-driven deny-list for dangerous yt-dlp arguments, URL
 * validation for media sources, and filename template sanitization.
 *
 * This is a pure-function module — no host API imports — so it can be
 * unit-tested under `tsx` without a mock `ctx`.
 *
 * **Security model — DENY-LIST ONLY.** The module rejects a specific,
 * enumerated list of dangerous yt-dlp flags. Any flag NOT in the deny-list
 * is allowed through. If a user typos a denied flag (e.g. `--exec-before-dl`),
 * it WILL pass through — we block known dangerous flags, not fuzzy matches.
 *
 * @module security
 */

// ── Denied yt-dlp flags ────────────────────────────────────────────
//
// Each entry has a CVE or rationale comment. The deny-list applies ONLY
// to user-supplied `advancedArgs`. The downloader itself uses `-P` and
// `-o` in its own argv construction — that's fine because the downloader
// controls those values.

/**
 * Denied short flags that accept attached values (e.g. `-otemplate`, `-P/tmp`).
 * yt-dlp's CLI parser allows `-Xvalue` as equivalent to `-X value`, so we
 * must check if a token starts with any of these short flags.
 */
const DENIED_SHORT_FLAGS: ReadonlyArray<string> = ['-a', '-P', '-o'];

const DENIED_FLAGS: ReadonlySet<string> = new Set([
    // CVE-2023-40581 / CVE-2024-22423 / CVE-2025-54072 — arbitrary command exec
    '--exec',
    '--exec-before-download',

    // Can reach ffmpeg args that write arbitrary files
    '--postprocessor-args',
    '--ppa',

    // Arbitrary config file load
    '--config-location',

    // Reads URLs from arbitrary file (FS traversal)
    '--batch-file',
    '-a', // Short alias for --batch-file

    // Arbitrary external binary
    '--external-downloader',
    '--downloader',

    // Loads arbitrary info-json
    '--load-info-json',

    // Regex-backref chaining exploit
    '--parse-metadata',
    '--replace-in-metadata',

    // Changes output dir out from under us
    '--paths',
    '-P', // Short alias for --paths (deny user-supplied path overrides)

    // Touches browser keychain (deferred to v1.1 feature with explicit UX)
    '--cookies-from-browser',

    // Plugin-controlled output routing; user cannot override
    '-o',
    '--output',

    // Plugin-controlled resume semantics; user cannot disable/toggle
    '--no-continue',
    '--download-archive',
    '--continue',
]);

// ── Public API: sanitizeYtDlpArgs ──────────────────────────────────

/** Successful sanitization result — all args passed the deny-list. */
export interface SanitizeArgsOk {
    ok: true;
    args: string[];
}

/** Failed sanitization result — one or more args were denied. */
export interface SanitizeArgsFail {
    ok: false;
    rejected: string[];
}

/**
 * Validate user-supplied yt-dlp arguments against the deny-list.
 *
 * Checks each argument against:
 * 1. Exact flag match (e.g. `--exec`)
 * 2. Long `--flag=value` form (split at `=`, e.g. `--exec=cmd`)
 * 3. Short `-Xvalue` attached form (e.g. `-otemplate`, `-P/tmp`, `-aurls.txt`)
 *
 * If any denied flag is present, returns `{ ok: false, rejected }` with the
 * full list of rejected flags for UI display. Otherwise returns
 * `{ ok: true, args }` with the original args passed through.
 *
 * @param userArgs - Array of user-supplied CLI arguments
 * @returns Sanitization result with either the clean args or the rejected flags
 */
export function sanitizeYtDlpArgs(userArgs: string[]): SanitizeArgsOk | SanitizeArgsFail {
    const rejected: string[] = [];

    for (const arg of userArgs) {
        // 1. Long flags: extract `--flag` from `--flag=value`
        const flag = arg.includes('=') ? arg.split('=')[0] : arg;

        if (DENIED_FLAGS.has(flag)) {
            rejected.push(flag);
            continue;
        }

        // 2. Short flags with attached values: `-otemplate` → `-o`
        // Only check single-dash args that are longer than 2 chars (the flag itself)
        // and don't start with `--` (long flags handled above).
        if (arg.length > 2 && arg[0] === '-' && arg[1] !== '-') {
            const shortFlag = arg.slice(0, 2);
            if (DENIED_SHORT_FLAGS.includes(shortFlag)) {
                rejected.push(shortFlag);
            }
        }
    }

    if (rejected.length > 0) {
        return { ok: false, rejected };
    }

    return { ok: true, args: userArgs };
}

// ── Public API: isValidMediaUrl ────────────────────────────────────

/** Successful URL validation result. */
export interface UrlValidOk {
    ok: true;
}

/** Failed URL validation result with reason. */
export interface UrlValidFail {
    ok: false;
    reason: string;
}

/**
 * Validate a URL for use as a media source in yt-dlp.
 *
 * Rejects:
 * - Empty strings
 * - URLs starting with `-` (would be parsed as a CLI flag)
 * - URLs containing newlines or control characters
 * - Non-http(s) schemes (file://, javascript:, data:, ftp://, etc.)
 * - URLs longer than 2048 characters
 *
 * @param url - The URL string to validate
 * @returns Validation result with reason on failure
 */
export function isValidMediaUrl(url: string): UrlValidOk | UrlValidFail {
    // Empty check
    if (!url || url.trim().length === 0) {
        return { ok: false, reason: 'URL is empty' };
    }

    // Leading dash — would be parsed as a CLI flag by yt-dlp
    if (url.startsWith('-')) {
        return { ok: false, reason: 'URL must not start with a dash' };
    }

    // Length cap
    if (url.length > 2048) {
        return { ok: false, reason: 'URL exceeds maximum length of 2048 characters' };
    }

    // Control characters and newlines (U+0000–U+001F, U+007F)
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(url)) {
        return { ok: false, reason: 'URL contains control characters' };
    }

    // Scheme check — only http and https are allowed.
    // Use the URL constructor for robust parsing. If it throws, the URL
    // is malformed and should be rejected (not accepted via a fallback).
    try {
        const parsed = new URL(url);
        const scheme = parsed.protocol.toLowerCase();
        if (scheme !== 'http:' && scheme !== 'https:') {
            return { ok: false, reason: `Unsupported URL scheme: ${scheme.replace(/:$/, '')}` };
        }
    } catch {
        return { ok: false, reason: 'Invalid URL' };
    }

    return { ok: true };
}

// ── Public API: sanitizeFilenameTemplate ───────────────────────────

/** Successful template validation result. */
export interface TemplateValidOk {
    ok: true;
    template: string;
}

/** Failed template validation result with reason. */
export interface TemplateValidFail {
    ok: false;
    reason: string;
}

/**
 * Validate a yt-dlp filename template.
 *
 * Validation-only in v1 — returns the template unchanged on success.
 * Does NOT mutate the template to add byte-limit modifiers (mutation
 * can generate invalid yt-dlp template syntax).
 *
 * Rejects:
 * - Shell metacharacters (`$`, backticks, newlines)
 * - Path separators (`/`, `\`) — template must produce a single filename
 * - `..` segments (path traversal)
 * - Leading `~` or absolute paths (starts with `/`)
 * - Empty or missing both `%(title)s` and `%(id)s`
 *
 * @param template - The yt-dlp output template string
 * @returns Validation result with the template unchanged on success
 */
export function sanitizeFilenameTemplate(template: string): TemplateValidOk | TemplateValidFail {
    // Empty check
    if (!template || template.trim().length === 0) {
        return { ok: false, reason: 'Template is empty' };
    }

    // Shell metacharacters — `$` and backtick enable command substitution
    if (/[$`]/.test(template)) {
        return { ok: false, reason: 'Template contains shell metacharacters ($ or backtick)' };
    }

    // Newlines — could break CLI argument parsing
    if (/[\n\r]/.test(template)) {
        return { ok: false, reason: 'Template contains newline characters' };
    }

    // Path separators — template must produce a single filename, not a subpath
    if (/[/\\]/.test(template)) {
        return { ok: false, reason: 'Template must not contain path separators (/ or \\)' };
    }

    // Path traversal
    if (template.includes('..')) {
        return { ok: false, reason: 'Template must not contain path traversal (..)' };
    }

    // Leading tilde — would escape outputDir via shell expansion
    if (template.startsWith('~')) {
        return { ok: false, reason: 'Template must not start with ~ (would escape output directory)' };
    }

    // Must include at least one of %(title)s or %(id)s for uniqueness
    if (!template.includes('%(title)s') && !template.includes('%(id)s')) {
        return { ok: false, reason: 'Template must include %(title)s or %(id)s for unique filenames' };
    }

    return { ok: true, template };
}
