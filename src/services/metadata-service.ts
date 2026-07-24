/**
 * Metadata extraction service.
 *
 * Probes URLs with `yt-dlp --dump-json` to extract media metadata and
 * available formats. Detects playlist URLs via heuristic (before spawning
 * yt-dlp) and via the `_type` field in the JSON response. Uses
 * `shellWithRetry` with `'single'` strategy for transient-failure resilience.
 *
 * @module metadata-service
 */

import type { PluginContext } from '@appos.space/plugin-types';
import type { MediaMetadata, FormatInfo, ParsedError, RawYtDlpJson } from '../types';

import { isValidMediaUrl } from '../core/security';
import { parseYtDlpError } from '../core/error-parser';
import { validateOutputDir, ensureOutputDir } from '../core/paths';
import { shellWithRetry } from './shell-with-retry';

// ── ProbeResult discriminated union ───────────────────────────────

/** Successful single-video probe result. */
export interface ProbeVideo {
    kind: 'video';
    metadata: MediaMetadata;
    formats: FormatInfo[];
}

/** URL resolved to a playlist (delegate to playlist service). */
export interface ProbePlaylist {
    kind: 'playlist';
    playlistUrl: string;
    estimatedCount: number;
}

/** Probe failed with a categorised error. */
export interface ProbeError {
    kind: 'error';
    error: ParsedError;
}

/**
 * Discriminated union returned by `probeUrl`.
 *
 * - `video` — single video with metadata and format list
 * - `playlist` — detected playlist URL; caller should delegate to the playlist service
 * - `error` — categorised error (invalid URL, DRM, network, etc.)
 */
export type ProbeResult = ProbeVideo | ProbePlaylist | ProbeError;

// ── Playlist URL heuristics ───────────────────────────────────────
//
// Detects obvious playlist URLs BEFORE spawning yt-dlp. The heuristic
// only fires when the URL is unambiguously a playlist:
//   - YouTube: `list=` present AND `v=` absent
//   - Twitch `/videos` listings
//   - Vimeo `/channels/`
//   - SoundCloud `/sets/`
//
// Ambiguous cases (YouTube `list=` + `v=`) fall through to yt-dlp
// with `--no-playlist`, which resolves to the single video.

/**
 * Non-YouTube playlist heuristics keyed by hostname suffix → path matcher.
 * Matched against `parsed.hostname` and `parsed.pathname` only — never the
 * full URL string — to avoid false positives from query/redirect URLs.
 */
const NON_YT_PLAYLIST_RULES: Array<{
    hostSuffix: string;
    pathMatch: (pathname: string) => boolean;
}> = [
    // twitch.tv/<user>/videos — path ends with /videos
    { hostSuffix: 'twitch.tv', pathMatch: (p) => /\/videos\/?$/.test(p) },
    // vimeo.com/channels/<name> — path starts with /channels/
    { hostSuffix: 'vimeo.com', pathMatch: (p) => p.startsWith('/channels/') },
    // soundcloud.com/<user>/sets/<name> — /sets/ segment anywhere in path
    { hostSuffix: 'soundcloud.com', pathMatch: (p) => /\/sets\//.test(p) },
];

/** Check if hostname ends with (or equals) the given suffix. */
function hostMatches(hostname: string, suffix: string): boolean {
    return hostname === suffix || hostname.endsWith('.' + suffix);
}

/**
 * Test whether a URL is unambiguously a playlist.
 *
 * Returns the playlist URL if detected, or `null` to fall through to yt-dlp.
 * YouTube URLs with both `list=` and `v=` are AMBIGUOUS and return `null`
 * — yt-dlp handles them with `--no-playlist`.
 *
 * Only the canonical `/playlist?list=...` form (no video ID in path) is
 * short-circuited. `youtu.be/<id>?list=...`, `/shorts/<id>?list=...`,
 * and `/live/<id>?list=...` carry a video ID in the path and are treated
 * as ambiguous so yt-dlp resolves them with `--no-playlist`.
 */
function detectPlaylistUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();

        // ── YouTube ───────────────────────────────────────────────
        if (hostMatches(host, 'youtube.com') || hostMatches(host, 'youtu.be')) {
            const hasList = parsed.searchParams.has('list');
            if (!hasList) return null;

            // Only short-circuit when the URL is the canonical playlist page
            // (youtube.com/playlist?list=...) — no video ID anywhere.
            const hasV = parsed.searchParams.has('v');
            const isPlaylistPath = parsed.pathname === '/playlist';

            if (!hasV && isPlaylistPath) return url;

            // youtu.be/<id>?list=, /shorts/<id>?list=, /live/<id>?list=,
            // /watch?v=...&list= → all ambiguous; let yt-dlp handle it.
            return null;
        }

        // ── Non-YouTube sites ─────────────────────────────────────
        // Match against parsed hostname + pathname only (not full URL).
        for (const rule of NON_YT_PLAYLIST_RULES) {
            if (!hostMatches(host, rule.hostSuffix)) continue;
            if (rule.pathMatch(parsed.pathname)) return url;
        }
    } catch {
        // Malformed URL — let isValidMediaUrl reject it downstream
    }

    return null;
}

// ── Metadata / format parsers ─────────────────────────────────────

/**
 * Parse raw yt-dlp JSON into the canonical `MediaMetadata` shape.
 *
 * Maps yt-dlp's snake_case fields to camelCase, null-coalescing optional
 * fields. The `formats` array is parsed separately via `extractFormats`.
 */
function parseMetadataJson(raw: RawYtDlpJson): MediaMetadata {
    return {
        id: raw.id,
        title: raw.title || 'Untitled',
        url: raw.webpage_url,
        thumbnail: raw.thumbnail ?? null,
        duration: raw.duration ?? null,
        uploader: raw.channel ?? raw.uploader ?? null,
        uploadDate: raw.upload_date ?? null,
        description: raw.description ?? null,
        viewCount: raw.view_count ?? null,
        likeCount: raw.like_count ?? null,
        formats: extractFormats(raw.formats ?? []),
        playlistIndex: raw.playlist_index ?? null,
        playlistTitle: raw.playlist_title ?? null,
    };
}

/** Raw format entry shape — loose typing for the fields we read. */
interface RawFormat {
    format_id?: string;
    ext?: string;
    height?: number;
    resolution?: string | null;
    fps?: number | null;
    vcodec?: string | null;
    acodec?: string | null;
    filesize?: number | null;
    filesize_approx?: number | null;
    tbr?: number | null;
    abr?: number | null;
}

/**
 * Convert raw yt-dlp format entries into `FormatInfo[]`.
 *
 * Builds a human-readable `label` from resolution, extension, and
 * audio/video codec presence.
 */
function extractFormats(rawFormats: RawFormat[]): FormatInfo[] {
    return rawFormats.map((raw) => {
        const resolution = raw.height ? `${raw.height}p` : (raw.resolution ?? null);
        const ext = raw.ext || '?';
        const hasVideo = raw.vcodec != null && raw.vcodec !== 'none';
        const hasAudio = raw.acodec != null && raw.acodec !== 'none';

        let label = resolution || 'unknown';
        if (hasVideo && hasAudio) label += ` ${ext}`;
        else if (hasAudio && !hasVideo) label = `audio ${ext}`;
        else if (hasVideo && !hasAudio) label += ` ${ext} (video only)`;

        return {
            formatId: raw.format_id || 'unknown',
            ext,
            resolution,
            fps: raw.fps ?? null,
            vcodec: hasVideo ? raw.vcodec! : null,
            acodec: hasAudio ? raw.acodec! : null,
            filesize: raw.filesize ?? null,
            filesizeApprox: raw.filesize_approx ?? null,
            tbr: raw.tbr ?? null,
            abr: raw.abr ?? null,
            label,
        };
    });
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Probe a URL for metadata and available formats.
 *
 * 1. Validates the URL via `isValidMediaUrl`
 * 2. Checks playlist heuristics (returns `playlist` branch without CLI call)
 * 3. Validates and ensures the output directory
 * 4. Spawns `yt-dlp --dump-json` via `shellWithRetry` (single retry)
 * 5. Parses JSON into `MediaMetadata` + `FormatInfo[]`
 *
 * The 500 ms probe debounce is the caller's responsibility (download panel).
 *
 * @param ctx - Plugin context for shell execution and settings
 * @param url - The media URL to probe
 * @returns Discriminated `ProbeResult` union
 */
export async function probeUrl(ctx: PluginContext, url: string): Promise<ProbeResult> {
    // Step 1: URL validation
    const urlCheck = isValidMediaUrl(url);
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

    // Step 2: Playlist heuristic (no CLI call)
    const playlistUrl = detectPlaylistUrl(url);
    if (playlistUrl !== null) {
        return {
            kind: 'playlist',
            playlistUrl,
            estimatedCount: -1,
        };
    }

    // Step 3: Resolve output directory (pre-shell gate)
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

    // Step 4: Build args and spawn yt-dlp
    // argv array — passed directly to the process, no shell interpolation,
    // so URLs with special characters (unicode, &, etc.) are safe.
    const args = [
        '--ignore-config', // Neutralise ambient ~/.config/yt-dlp/config (security)
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        url,
    ];

    const exec = (opts: Parameters<typeof ctx.shell.execute>[0]) => ctx.shell.execute(opts);

    const result = await shellWithRetry(
        exec,
        { command: 'yt-dlp', args, cwd, timeout: 30 },
        { retry: 'single' },
    );

    // Step 5: Handle non-zero exit
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
                message: 'Failed to parse yt-dlp output as JSON',
                category: 'unknown',
                raw: result.stdout.slice(0, 200),
                recoverable: false,
            },
        };
    }

    // Step 7: Playlist detection via _type field
    if (json._type === 'playlist') {
        const estimatedCount =
            (typeof json.playlist_count === 'number' ? json.playlist_count : null) ??
            (Array.isArray(json.entries) ? json.entries.length : -1);

        return {
            kind: 'playlist',
            playlistUrl: (typeof json.webpage_url === 'string' ? json.webpage_url : url),
            estimatedCount,
        };
    }

    // Step 8: Normal video — parse metadata and formats
    const metadata = parseMetadataJson(json as unknown as RawYtDlpJson);
    return {
        kind: 'video',
        metadata,
        formats: metadata.formats,
    };
}
