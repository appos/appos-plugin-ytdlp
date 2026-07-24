/**
 * Download execution service — the core download engine.
 *
 * Sequential queue processor using `ctx.ui.pipeShellToWebPanel` (UIAPI,
 * confirmed in plugin-api.d.ts:1374) as the primary path when the download
 * panel is open, or `ctx.shell.execute` as the fallback. Integrates
 * `shell-with-retry` `progress-aware` mode via a generic executor closure
 * to survive the 120s host cap.
 *
 * ## Resume-loop strategy
 *
 * Each download is wrapped in `shellWithRetry` with `retry: 'progress-aware'`,
 * `maxAttempts: 20`, and `maxStalls: 3`. The host kills yt-dlp processes after
 * 119s (our timeout), but `--continue` + `--download-archive` mean yt-dlp
 * picks up where it left off on the next attempt.
 *
 * ## Generic executor
 *
 * The caller provides a `ShellExecutor` closure — either wrapping
 * `ctx.ui.pipeShellToWebPanel` (Path A, pipes to webview + surfaces onData)
 * or `ctx.shell.execute` (fallback). This module never touches `ctx` directly
 * for shell execution.
 *
 * ## pipeShellToWebPanel — Path A (confirmed)
 *
 * `pipeShellToWebPanel` is confirmed to surface plugin-side `onData`.
 * The host wraps the caller's onData to also stream to the webview.
 * We use a single yt-dlp process per entry — no dual invocation.
 *
 * ## Cancel-race fix
 *
 * After the executor resolves (success or failure), we re-check
 * `active.abortRequested`. If abort was requested during the attempt, the
 * entry is marked `cancelled` (not `complete`) and is NOT added to the
 * library. User intent wins over late success.
 *
 * ## ffmpeg fallback
 *
 * When `state.isFfmpegAvailable()` is false and the selected format requires
 * ffmpeg (merge or transcode), `buildYtdlpArgs` auto-downgrades to a
 * pre-muxed fallback selector. The substitution is logged.
 *
 * ## Ownership: downloadPanelOpen
 *
 * `setDownloadPanelOpen(open)` lives here. Downloader owns the flag.
 * `main.ts` calls `setDownloadPanelOpen(true)` during activation.
 * v1 has no true panel-close signal, so the flag is effectively always `true`
 * after activation.
 *
 * ## Invariant: queueEntry.id === libraryEntry.id
 *
 * The downloader reuses the queue entry's `id` as the `LibraryEntry.id` so
 * downstream lookups (reveal-file, redownload) can cross-reference without
 * a separate mapping.
 *
 * ## Smart-folder fallback: Branch A (closures work)
 *
 * `state.toggleFavorite` uses closures — no file annotation hooks needed.
 * The completion hook is a no-op.
 *
 * ## Known limitations
 *
 * - Cancel is best-effort: exits at next attempt boundary (shell processes
 *   cannot be killed mid-flight from the plugin layer).
 * - ffmpeg merge interrupts rely on `--continue` recovery.
 * - ffmpeg subprocess orphans: yt-dlp may spawn ffmpeg; the host's
 *   `Process.terminate()` only signals the direct child.
 * - Throttle requires `setTimeout` — when timers are not available in the
 *   JSC runtime, every chunk fires unthrottled. The webview still gets
 *   updates, just at full rate.
 *
 * @module downloader
 */

import type {
    PluginContext,
    ShellExecuteOptions,
    ShellExecuteResult,
    ShellDataChunk,
} from '@appos.space/plugin-types';
import type {
    QueueEntry,
    LibraryEntry,
    QueueRequestSnapshot,
} from '../types/plugin-state';
import { pathToUrl, fileExtension } from '@appos.space/plugin-utils';

import {
    PANELS,
    PROCESS_TIMEOUT_SECONDS,
    PROGRESS_REGEX,
    QUEUE_UPDATE_THROTTLE_MS,
} from '../constants';
import { parseYtDlpError } from '../core/error-parser';
import { sanitizeYtDlpArgs, sanitizeFilenameTemplate, isValidMediaUrl } from '../core/security';
import { validateOutputDir, ensureOutputDir, archivePathFor, tempDirFor } from '../core/paths';
import * as state from '../core/state';
import {
    shellWithRetry,
    buildYtDlpResumeArgs,
    parseYtDlpPercent,
} from './shell-with-retry';
import type { ShellExecutor, RetryOptions } from './shell-with-retry';

// ── Public types ──────────────────────────────────────────────────────

/** Options passed to `enqueueAndProcess`. */
export interface EnqueueOptions {
    format: string;
    quality: string;
    /** Human-readable media title from probe results. Falls back to URL if absent. */
    title?: string;
    groupTag?: string;
    /** Human-readable playlist label; persisted on QueueEntry.groupLabel for queue-view reconstruction. */
    groupLabel?: string;
    outputDir: string;
    proxyUrl?: string;
    filenameTemplate: string;
    /** Already sanitized via `security.sanitizeYtDlpArgs`. */
    advancedArgs?: string[];
}

/**
 * Plain request shape for `buildYtdlpArgs` — NOT a QueueEntry — so
 * the CLI preview can call it before any entry exists.
 */
export interface YtDlpArgRequest {
    url: string;
    format: string;
    quality: string;
}

// ── Module-level state ────────────────────────────────────────────────

/** Plugin context — set by `initDownloader`. */
let ctx: PluginContext | null = null;

/** Whether the download panel is open (owns this flag). */
let downloadPanelOpen = false;

/** Whether queue processing is paused. */
let queuePaused = false;

/**
 * Currently active download. `abortRequested` is the cancel signal.
 * Null when no download is running.
 */
let active: { id: string; abortRequested: boolean } | null = null;

/** Whether `runLoop` is currently executing (re-entrancy guard). */
let loopRunning = false;

// ── Outbound notifications ────────────────────────────────────────────

/**
 * Emit a routable notification for a terminal download event
 * (complete / failed). Best-effort and non-blocking: on older
 * hosts `ctx.notifications` is absent and this is a no-op; emit
 * rejections are logged and swallowed. Panel toasts / status broadcasts
 * are unaffected (local surfaces stay unchanged; this is
 * the parallel user-routable surface: Notification Center, webhook,
 * quiet hours, dedupe, delivery log).
 *
 * Cancelled downloads are deliberately NOT notified (user-initiated).
 *
 * @param kind - Terminal outcome kind.
 * @param body - Human-readable detail (title / error), clamped to the
 *   host's 4096-char notification body cap.
 */
function notifyDownloadTerminal(kind: 'complete' | 'failed', body: string): void {
    const notifications = ctx?.notifications;
    if (!notifications) return;
    const clamped = body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
    void notifications
        .emit({
            level: kind === 'complete' ? 'info' : 'warning',
            title: kind === 'complete' ? 'Download complete' : 'Download failed',
            body: clamped,
            category: kind === 'complete' ? 'download.complete' : 'download.failed',
            threadIdentifier: 'space.appos.ytdlp.downloads',
        })
        .catch((err: unknown) => {
            console.info('[yt-dlp] notifications.emit failed (non-fatal):', err);
        });
}

// ── Audio-only format set ─────────────────────────────────────────────

/** Formats that use audio extraction (`-x --audio-format`). */
const AUDIO_EXTRACTION_FORMATS = new Set(['mp3', 'm4a']);

// ── Throttle helper ───────────────────────────────────────────────────

/** Handle returned by `safeThrottle` for cleanup. */
interface ThrottleHandle<A extends unknown[]> {
    /** Throttled invocation — call with same args as the original function. */
    call: (...args: A) => void;
    /**
     * Cancel any pending trailing timer. After this, no further deferred
     * invocations will fire. Call before writing terminal state.
     */
    cancel: () => void;
}

/**
 * Create a throttled version of `fn` if `setTimeout` exists in this runtime.
 * Falls back to passthrough (every call fires immediately) when timers are
 * unavailable. Returns a handle with `call` (the throttled function) and
 * `cancel` (kills any pending trailing timer to prevent stale writes after
 * terminal state transitions).
 *
 * Uses a manual timestamp check instead of the SDK `throttle` utility because
 * the SDK's generic constraint (`(...args: unknown[]) => void`) does not
 * accept strongly-typed callbacks without unsafe casts.
 */
function safeThrottle<A extends unknown[]>(
    fn: (...args: A) => void,
    ms: number,
): ThrottleHandle<A> {
    if (typeof setTimeout !== 'function') {
        return { call: fn, cancel: () => { /* no-op */ } };
    }
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const call = (...args: A): void => {
        const now = Date.now();
        const remaining = ms - (now - last);
        clearTimeout(timer);
        if (remaining <= 0) {
            last = now;
            fn(...args);
        } else {
            // Trailing call ensures final tick is always emitted
            timer = setTimeout(() => {
                last = Date.now();
                fn(...args);
            }, remaining);
        }
    };
    const cancel = (): void => {
        clearTimeout(timer);
        timer = undefined;
    };
    return { call, cancel };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Initialise the downloader service.
 *
 * Must be called during plugin activation. Stores the context
 * reference used for shell operations and UI operations.
 *
 * @param pluginCtx - The plugin context provided by the host.
 */
export function initDownloader(pluginCtx: PluginContext): void {
    ctx = pluginCtx;
    downloadPanelOpen = false;
    queuePaused = false;
    active = null;
    loopRunning = false;
}

/**
 * Set whether the download panel is open.
 *
 * Owned by this module. `main.ts` calls `setDownloadPanelOpen(true)` during
 * activation. When true, the downloader prefers `pipeShellToWebPanel` for
 * automatic webview streaming.
 *
 * @param open - Whether the download panel is currently open.
 */
export function setDownloadPanelOpen(open: boolean): void {
    downloadPanelOpen = open;
}

/**
 * Set queue-level pause state.
 *
 * When paused, `processQueue` will NOT pop the next queued entry. The
 * currently-active download runs to completion (or its 119s boundary),
 * then the loop checks `queuePaused` and stops.
 *
 * Does NOT affect the currently-active download.
 *
 * @param paused - Whether to pause queue processing.
 */
export function setQueuePaused(paused: boolean): void {
    queuePaused = paused;
    if (!paused) {
        processQueue();
    }
}

/**
 * Validate, enqueue, and begin processing one or more URLs.
 *
 * Performs pre-enqueue validation: output directory, filename template,
 * advanced args deny-list, and URL validation. Partial success: for
 * multi-URL inputs, each URL is validated independently. Failed URLs are
 * skipped with a toast; the returned array contains only successfully
 * enqueued IDs.
 *
 * @param urlOrList - A single URL or array of URLs to download.
 * @param opts - Enqueue options (format, quality, output dir, etc.).
 * @returns Array of successfully enqueued entry IDs.
 */
export async function enqueueAndProcess(
    urlOrList: string | string[],
    opts: EnqueueOptions,
): Promise<string[]> {
    if (!ctx) {
        console.error('[yt-dlp] enqueueAndProcess called before initDownloader');
        return [];
    }

    // Step 1: Validate output directory
    const dirResult = validateOutputDir(opts.outputDir);
    if (!dirResult.ok) {
        ctx.feedback.toast(
            'Output directory is not set \u2014 check plugin settings',
            { kind: 'error' },
        );
        return [];
    }

    let resolvedDir: string;
    try {
        resolvedDir = await ensureOutputDir(ctx, dirResult.resolved);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.feedback.toast(msg, { kind: 'error' });
        return [];
    }

    // Step 2: Validate filename template
    const templateResult = sanitizeFilenameTemplate(opts.filenameTemplate);
    if (!templateResult.ok) {
        ctx.feedback.toast(
            `Invalid filename template: ${templateResult.reason}`,
            { kind: 'error' },
        );
        return [];
    }

    // Step 3: Sanitize advanced args
    const argsResult = sanitizeYtDlpArgs(opts.advancedArgs ?? []);
    if (!argsResult.ok) {
        ctx.feedback.toast(
            `Blocked flags in advanced options: ${argsResult.rejected.join(', ')}`,
            { kind: 'error' },
        );
        return [];
    }

    // Step 4: Build the QueueRequestSnapshot
    const snapshot: QueueRequestSnapshot = {
        format: opts.format,
        quality: opts.quality,
        outputDir: resolvedDir,
        filenameTemplate: templateResult.template,
        proxyUrl: opts.proxyUrl || undefined,
        advancedArgs: argsResult.args.length > 0 ? argsResult.args : undefined,
        archivePath: archivePathFor(resolvedDir),
        tempDir: tempDirFor(resolvedDir),
    };

    // Step 5: Validate and enqueue each URL
    const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
    const enqueuedIds: string[] = [];

    for (const url of urls) {
        const urlResult = isValidMediaUrl(url);
        if (!urlResult.ok) {
            ctx.feedback.toast(
                `Skipped invalid URL: ${urlResult.reason}`,
                { kind: 'warning' },
            );
            continue;
        }

        const entry: Omit<QueueEntry, 'id'> = {
            url,
            title: opts.title ?? undefined,
            status: 'queued',
            progress: 0,
            speed: null,
            eta: null,
            errorCode: null,
            errorMessage: null,
            groupTag: opts.groupTag ?? null,
            groupLabel: opts.groupLabel ?? null,
            attempt: 0,
            lastKnownPercent: null,
            createdAt: new Date().toISOString(),
            finalFilePath: null,
            finalFileUrl: null,
            libraryId: null,
            request: snapshot,
        };

        const id = state.enqueue(entry);
        enqueuedIds.push(id);
    }

    if (enqueuedIds.length > 0) {
        processQueue();
    }

    return enqueuedIds;
}

/**
 * Cancel a download by ID.
 *
 * If the download is currently active, sets the abort flag. The cancel takes
 * effect at the next attempt boundary (best-effort). If the entry is still
 * `queued`, it is removed immediately.
 *
 * @param id - The queue entry ID to cancel.
 */
export async function cancelDownload(id: string): Promise<void> {
    // Active download — set abort flag
    if (active && active.id === id) {
        active.abortRequested = true;
        state.updateQueueEntry(id, { status: 'cancelled' });
        state.broadcastToWebPanels({
            v: 1,
            type: 'download-status',
            id,
            status: 'cancelled',
        });
        return;
    }

    // Queued entry — remove immediately
    const queue = state.getQueue();
    const entry = queue.find((e) => e.id === id);
    if (!entry) return;

    // Only cancel entries that are still in-progress. Terminal states
    // (complete, failed, cancelled) must not be corrupted by late cancel events.
    if (entry.status === 'queued') {
        state.removeQueueEntry(id);
        state.broadcastToWebPanels({
            v: 1,
            type: 'download-status',
            id,
            status: 'cancelled',
        });
    } else if (entry.status === 'downloading' || entry.status === 'extracting' || entry.status === 'paused') {
        state.updateQueueEntry(id, { status: 'cancelled' });
        state.broadcastToWebPanels({
            v: 1,
            type: 'download-status',
            id,
            status: 'cancelled',
        });
    }
    // Terminal states (complete, failed, cancelled) — no-op
}

/**
 * Retry a failed or cancelled download.
 *
 * Resets the entry to `queued`, clears error fields (preserving `request`),
 * and triggers queue processing.
 *
 * Refuses retry when the entry is the currently active download (abort is
 * still in flight). The caller should wait until the abort boundary is
 * reached and the entry transitions to a true terminal state.
 *
 * @param id - The queue entry ID to retry.
 */
export function retryDownload(id: string): void {
    const queue = state.getQueue();
    const entry = queue.find((e) => e.id === id);
    if (!entry) return;

    if (entry.status !== 'failed' && entry.status !== 'cancelled') return;

    // Refuse retry if this is the currently active download — the abort
    // is still in flight and runOne will overwrite state at the attempt
    // boundary. Wait until the entry is no longer active.
    if (active && active.id === id) return;

    state.updateQueueEntry(id, {
        status: 'queued',
        progress: 0,
        speed: null,
        eta: null,
        errorCode: null,
        errorMessage: null,
        attempt: 0,
        lastKnownPercent: null,
        finalFilePath: null,
        finalFileUrl: null,
        libraryId: null,
    });

    processQueue();
}

/**
 * Transition `paused` entries back to `queued` and kick processing.
 *
 * Called by main.ts after dependency check succeeds on launch.
 */
export async function resumeInterruptedQueue(): Promise<void> {
    const queue = state.getQueue();
    for (const entry of queue) {
        if (entry.status === 'paused') {
            state.updateQueueEntry(entry.id, { status: 'queued' });
        }
    }
    processQueue();
}

/**
 * Start or resume the sequential queue processing loop.
 *
 * No-op if the loop is already running or if `queuePaused` is set.
 * Uses an iterative async while-loop — NO `setTimeout`. The epic forbids
 * assuming timers exist in JSC.
 */
export function processQueue(): void {
    if (loopRunning || active !== null) return;
    void runLoop();
}

// ── Build yt-dlp args ─────────────────────────────────────────────────

/**
 * Build the yt-dlp argument array for a download.
 *
 * Implements the canonical format-to-argv mapping table. This is the single
 * source of truth used by both CLI preview and actual execution.
 *
 * @param req - Plain request shape with url, format, quality.
 * @param opts - Enqueue options with outputDir, filenameTemplate, proxyUrl, etc.
 * @returns Array of yt-dlp CLI arguments.
 */
export function buildYtdlpArgs(req: YtDlpArgRequest, opts: EnqueueOptions): string[] {
    const args: string[] = [];

    // --ignore-config MUST be first — neutralizes ambient yt-dlp config
    // which is an attack surface for --exec/--paths/--cookies-from-browser injection
    args.push('--ignore-config');

    // ── Format / quality mapping ──────────────────────────────────────

    const ffmpegAvailable = state.isFfmpegAvailable();
    const format = req.format;
    const quality = req.quality;

    if (AUDIO_EXTRACTION_FORMATS.has(format)) {
        // mp3, m4a — audio extraction requires ffmpeg
        if (ffmpegAvailable) {
            args.push('-x', '--audio-format', format);
        } else {
            // Auto-downgrade: fall back to bestaudio (no transcode needed)
            console.warn(
                `[yt-dlp] ffmpeg unavailable — downgrading "${format}" to bestaudio`,
            );
            args.push('-f', 'bestaudio', '--no-post-overwrites');
        }
    } else if (format === 'bestaudio') {
        // bestaudio — native container, no transcode
        args.push('-f', 'bestaudio', '--no-post-overwrites');
    } else {
        // Video formats: best, mp4, webm
        const heightFilter = buildHeightFilter(quality);

        if (format === 'best') {
            if (!ffmpegAvailable) {
                // No ffmpeg — select pre-muxed streams only to avoid merge failure.
                // "best" picks the highest-quality single-file stream.
                console.warn(
                    '[yt-dlp] ffmpeg unavailable — downgrading "best" to pre-muxed selector',
                );
                if (heightFilter) {
                    args.push('-f', `best[height<=${heightFilter}]`);
                } else {
                    args.push('-f', 'best');
                }
            } else if (heightFilter) {
                // Default mode with quality cap — merge path preferred,
                // trailing /best fallback for pre-muxed when merge streams absent
                args.push(
                    '-f',
                    `bestvideo[height<=${heightFilter}]+bestaudio/best[height<=${heightFilter}]/best`,
                );
            } else {
                args.push('-f', 'bestvideo+bestaudio/best');
            }
        } else if (format === 'mp4') {
            if (ffmpegAvailable) {
                if (heightFilter) {
                    args.push(
                        '-f',
                        `bestvideo[height<=${heightFilter}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]`,
                    );
                } else {
                    args.push(
                        '-f',
                        'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]',
                    );
                }
            } else {
                // Auto-downgrade: fall back to pre-muxed mp4
                console.warn(
                    '[yt-dlp] ffmpeg unavailable — downgrading "mp4" to best[ext=mp4]/best',
                );
                args.push('-f', 'best[ext=mp4]/best');
            }
        } else if (format === 'webm') {
            if (ffmpegAvailable) {
                if (heightFilter) {
                    args.push(
                        '-f',
                        `bestvideo[height<=${heightFilter}][ext=webm]+bestaudio[ext=webm]/best[ext=webm]`,
                    );
                } else {
                    args.push(
                        '-f',
                        'bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]',
                    );
                }
            } else {
                // Auto-downgrade: fall back to pre-muxed webm
                console.warn(
                    '[yt-dlp] ffmpeg unavailable — downgrading "webm" to best[ext=webm]/best',
                );
                args.push('-f', 'best[ext=webm]/best');
            }
        } else {
            // Unknown video format — use default best strategy
            args.push('-f', 'bestvideo+bestaudio/best');
        }
    }

    // ── Output template and paths ─────────────────────────────────────

    // Output template — two argv elements, NO surrounding quotes
    args.push('-o', opts.filenameTemplate);

    // ASCII-only safe filename substitution (v1 default)
    args.push('--restrict-filenames');

    // Output directory and temp directory — each is a single argv element
    args.push('-P', 'home:' + opts.outputDir);
    args.push('-P', 'temp:' + tempDirFor(opts.outputDir));

    // ── Behavioural flags ─────────────────────────────────────────────

    // Force single video even if URL contains list=
    args.push('--no-playlist');

    // One progress line per tick (required for line-by-line parsing)
    args.push('--newline');

    // Strip ANSI escape codes
    args.push('--no-colors');

    // Print final path AFTER merges/postprocessing — reliable for LibraryEntry.filePath
    // Two argv elements, NO surrounding quotes
    args.push('--print', 'after_move:filepath:%(filepath)s');

    // ── Resume flags ──────────────────────────────────────────────────

    // --continue + --download-archive for resume-loop strategy
    // buildYtDlpResumeArgs is idempotent and returns a new array
    const withResume = buildYtDlpResumeArgs(args, {
        archivePath: archivePathFor(opts.outputDir),
    });

    // ── Optional flags ────────────────────────────────────────────────

    // Proxy (if configured)
    if (opts.proxyUrl) {
        withResume.push('--proxy', opts.proxyUrl);
    }

    // Advanced args (caller has already run sanitizeYtDlpArgs)
    if (opts.advancedArgs && opts.advancedArgs.length > 0) {
        withResume.push(...opts.advancedArgs);
    }

    // URL is always the LAST argv element
    withResume.push(req.url);

    return withResume;
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Extract the numeric height value from a quality preset string.
 * Returns the number (e.g. 1080 from "1080p") or null if quality is "best".
 */
function buildHeightFilter(quality: string): number | null {
    if (quality === 'best') return null;
    const match = quality.match(/^(\d+)p$/);
    if (match) return parseInt(match[1], 10);
    return null;
}

/**
 * Parse a progress line from yt-dlp default output format.
 *
 * Matches: `[download]  42.3% of 100.2MiB at 2.5MiB/s ETA 00:30`
 *
 * @returns Parsed progress fields, or null if line doesn't match.
 */
function parseProgress(line: string): {
    percent: number;
    totalSize: string;
    speed: string;
    eta: string;
} | null {
    const match = PROGRESS_REGEX.exec(line);
    if (!match) return null;

    const percent = parseFloat(match[1]);
    if (Number.isNaN(percent)) return null;

    return {
        percent: Math.min(percent, 100),
        totalSize: match[2],
        speed: match[3],
        eta: match[4],
    };
}

/**
 * Run a single download entry through yt-dlp with shell-with-retry.
 *
 * Reads EVERYTHING from `entry.request` — never references current settings.
 * This ensures resume-after-restart is deterministic.
 */
async function runOne(entry: QueueEntry): Promise<void> {
    if (!ctx) return;

    const req = entry.request;

    // Transition to downloading
    state.updateQueueEntry(entry.id, {
        status: 'downloading',
        attempt: 1,
    });
    state.broadcastToWebPanels({
        v: 1,
        type: 'download-status',
        id: entry.id,
        status: 'downloading',
    });

    // Re-sanitize persisted request snapshot before execution.
    // Fresh enqueue paths are sanitized, but resumed queue entries and
    // library redownloads trust entry.request from cache. Legacy or
    // tampered cache data could bypass the deny-list without this check.
    // Use the sanitized OUTPUTS (not raw inputs) for arg building.
    const templateCheck = sanitizeFilenameTemplate(req.filenameTemplate);
    if (!templateCheck.ok) {
        const errorMessage = `Invalid cached filename template: ${templateCheck.reason}`;
        state.updateQueueEntry(entry.id, { status: 'failed', errorMessage });
        state.broadcastToWebPanels({ v: 1, type: 'download-status', id: entry.id, status: 'failed', errorMessage });
        return;
    }
    let sanitizedAdvancedArgs: string[] | undefined;
    if (req.advancedArgs && req.advancedArgs.length > 0) {
        const reSanitized = sanitizeYtDlpArgs(req.advancedArgs);
        if (!reSanitized.ok) {
            const errorMessage = `Blocked flags in cached request: ${reSanitized.rejected.join(', ')}`;
            state.updateQueueEntry(entry.id, { status: 'failed', errorMessage });
            state.broadcastToWebPanels({ v: 1, type: 'download-status', id: entry.id, status: 'failed', errorMessage });
            return;
        }
        sanitizedAdvancedArgs = reSanitized.args;
    }

    // Build args from the persisted request snapshot, using sanitized outputs
    const argRequest: YtDlpArgRequest = {
        url: entry.url,
        format: req.format,
        quality: req.quality,
    };
    const argOpts: EnqueueOptions = {
        format: req.format,
        quality: req.quality,
        outputDir: req.outputDir,
        filenameTemplate: templateCheck.template,
        proxyUrl: req.proxyUrl,
        advancedArgs: sanitizedAdvancedArgs,
    };
    const args = buildYtdlpArgs(argRequest, argOpts);

    // Track state for onData parsing
    let finalFilePath: string | null = null;
    let alreadyInArchive = false;
    let accumulatedStderr = '';

    // Throttled progress broadcaster — returns a handle with cancel() to
    // prevent stale trailing callbacks after terminal state transitions.
    const progressThrottle = safeThrottle(
        (percent: number, speed: string | null, eta: string | null, attempt: number, maxAttempts: number) => {
            // Lightweight progress-only update — no full state-update fan-out.
            // Avoids O(state size) broadcast on every 100ms progress tick.
            state.updateQueueProgress(entry.id, {
                progress: percent,
                speed,
                eta,
                lastKnownPercent: percent,
            });
            state.broadcastToWebPanels({
                v: 1,
                type: 'download-progress',
                id: entry.id,
                percent,
                speed: speed ?? undefined,
                eta: eta ?? undefined,
                attempt,
                maxAttempts,
            });
        },
        QUEUE_UPDATE_THROTTLE_MS,
    );
    const broadcastProgress = progressThrottle.call;

    // Track current attempt for onData context
    let currentAttempt = 1;
    let currentMaxAttempts = 20;

    // Partial-line buffers — stream chunks have arbitrary boundaries, so
    // we must carry over incomplete lines between onData calls. Only
    // complete lines (terminated by \n) are parsed.
    let stdoutPartial = '';
    let stderrPartial = '';

    /** Process a single complete stdout line. */
    const processStdoutLine = (line: string): void => {
        // Suppress state/progress mutations once abort is requested —
        // prevents late markers from overwriting the cancelled state.
        const aborted = active?.abortRequested === true;

        const progress = parseProgress(line);
        if (progress && !aborted) {
            broadcastProgress(
                progress.percent,
                progress.speed,
                progress.eta,
                currentAttempt,
                currentMaxAttempts,
            );
        }

        // Track final file path from --print after_move
        if (line.includes('after_move:filepath:')) {
            const idx = line.indexOf('after_move:filepath:');
            finalFilePath = line.slice(idx + 'after_move:filepath:'.length).trim();
        }

        // Track destination path as fallback
        const destMatch = line.match(/\[download\]\s+Destination:\s+(.+)/);
        if (destMatch && !finalFilePath) {
            finalFilePath = destMatch[1].trim();
        }

        // Parse "already been downloaded" — yt-dlp emits:
        //   [download] <path> has already been downloaded
        // Extract the path so archive-skip completions have a concrete file.
        // Also mark the archive-skip flag so the success path can avoid
        // creating a duplicate library entry.
        const alreadyMatch = line.match(/\[download\]\s+(.+)\s+has already been downloaded/);
        if (alreadyMatch) {
            finalFilePath = alreadyMatch[1].trim();
            alreadyInArchive = true;
        }

        // "has already been recorded in the archive" — no path available
        if (line.includes('has already been recorded')) {
            alreadyInArchive = true;
        }

        // Post-processing state transitions: [Merger], [ExtractAudio], [PostProcess]
        // Suppressed when abort requested to avoid overwriting cancelled state.
        if (
            !aborted && (
                line.includes('[Merger]') ||
                line.includes('[ExtractAudio]') ||
                line.includes('[PostProcess]')
            )
        ) {
            state.updateQueueEntry(entry.id, { status: 'extracting' });
            state.broadcastToWebPanels({
                v: 1,
                type: 'download-status',
                id: entry.id,
                status: 'extracting',
            });
        }
    };

    // onData handler — processes both stdout and stderr chunks.
    // Uses partial-line buffering to handle arbitrary chunk boundaries.
    const onData = (chunk: ShellDataChunk): void => {
        if (chunk.stream === 'stdout') {
            const data = stdoutPartial + chunk.data;
            const lines = data.split('\n');
            // Last element is either '' (data ended with \n) or an incomplete line
            stdoutPartial = lines.pop() ?? '';
            for (const line of lines) {
                processStdoutLine(line);
            }
        } else {
            // stderr — accumulate for error parsing on failure
            accumulatedStderr += chunk.data;

            // Parse complete stderr lines for real-time tracking.
            // Some extractors and post-processing tools (ffmpeg) emit
            // markers like [Merger], [ExtractAudio], [PostProcess] on stderr,
            // and some progress lines may also arrive here.
            const data = stderrPartial + chunk.data;
            const lines = data.split('\n');
            stderrPartial = lines.pop() ?? '';
            for (const line of lines) {
                processStdoutLine(line);
            }
        }
    };

    // Build shell options
    const shellOpts: ShellExecuteOptions = {
        command: 'yt-dlp',
        args,
        cwd: req.outputDir,
        timeout: PROCESS_TIMEOUT_SECONDS,
        onData,
    };

    // Build executor — Path A: prefer pipeShellToWebPanel when panel open.
    // Exactly ONE yt-dlp process per entry — no dual invocation.
    const localCtx = ctx;
    const executor: ShellExecutor = (opts: ShellExecuteOptions) => {
        if (downloadPanelOpen) {
            // Pipe path — single yt-dlp process, streams to webview automatically.
            // On failure (no panel instance, CSP rejection), fall back to direct shell.
            // This substitution happens within the same attempt, NOT a second process.
            return localCtx.ui.pipeShellToWebPanel(PANELS.DOWNLOAD, opts).catch(() => {
                return localCtx.shell.execute(opts);
            });
        }
        return localCtx.shell.execute(opts);
    };

    // Retry options
    const retryOpts: RetryOptions = {
        retry: 'progress-aware',
        progressOf: (accumulated) => parseYtDlpPercent(accumulated.stdout + accumulated.stderr),
        maxAttempts: 20,
        maxStalls: 3,
        onAttempt: (attempt, max) => {
            currentAttempt = attempt;
            currentMaxAttempts = max;
            state.updateQueueEntry(entry.id, { attempt });
            state.broadcastToWebPanels({
                v: 1,
                type: 'download-progress',
                id: entry.id,
                percent: entry.lastKnownPercent ?? 0,
                attempt,
                maxAttempts: max,
            });
        },
        // Thread cancellation into retry loop — checked before each new attempt
        isAborted: () => active?.abortRequested === true,
    };

    // Run with retry
    let result: ShellExecuteResult;
    try {
        result = await shellWithRetry(executor, shellOpts, retryOpts);
    } catch (err) {
        // Cancel pending throttled callbacks before writing terminal state
        progressThrottle.cancel();

        // Cancel-race check: user intent wins even in exception path
        if (active?.abortRequested) {
            state.updateQueueEntry(entry.id, { status: 'cancelled' });
            state.broadcastToWebPanels({
                v: 1,
                type: 'download-status',
                id: entry.id,
                status: 'cancelled',
            });
            return;
        }

        // Unexpected error (not a shell exit code failure)
        const msg = err instanceof Error ? err.message : String(err);
        state.updateQueueEntry(entry.id, {
            status: 'failed',
            errorMessage: `yt-dlp failed: ${msg}`,
        });
        state.broadcastToWebPanels({
            v: 1,
            type: 'download-status',
            id: entry.id,
            status: 'failed',
            errorMessage: `yt-dlp failed: ${msg}`,
        });
        notifyDownloadTerminal('failed', `${entry.title ?? entry.url} — yt-dlp failed: ${msg}`);
        return;
    }

    // Use result.stderr directly for error parsing — shellWithRetry already
    // accumulates across all retry attempts with a 1MB cap. The onData-local
    // `accumulatedStderr` is NOT used here to avoid double-counting and
    // unbounded memory growth on noisy retries.

    // Cancel pending throttled callbacks before any terminal state write —
    // prevents stale progress from overwriting terminal state fields.
    progressThrottle.cancel();

    // ── Cancel race check ─────────────────────────────────────────────
    // AFTER executor resolves, re-check abort flag. User intent wins
    // over late success.
    if (active?.abortRequested) {
        state.updateQueueEntry(entry.id, { status: 'cancelled' });
        state.broadcastToWebPanels({
            v: 1,
            type: 'download-status',
            id: entry.id,
            status: 'cancelled',
        });
        return;
    }

    // ── Success path ──────────────────────────────────────────────────
    if (result.exitCode === 0) {
        // Flush any remaining partial stdout line (may contain after_move marker)
        if (stdoutPartial) {
            processStdoutLine(stdoutPartial);
            stdoutPartial = '';
        }

        // Parse final file path from accumulated output if not already captured
        if (!finalFilePath) {
            const afterMoveMatch = result.stdout.match(/after_move:filepath:(.+)/);
            if (afterMoveMatch) {
                finalFilePath = afterMoveMatch[1].trim();
            }
        }

        if (!finalFilePath) {
            // Fallback: try [Merger] line
            const mergerMatch = result.stdout.match(/\[Merger\]\s+Merging formats into "(.+)"/);
            if (mergerMatch) {
                finalFilePath = mergerMatch[1].trim();
            }
        }

        if (!finalFilePath) {
            // Fallback: try [download] Destination
            const destMatch = result.stdout.match(/\[download\]\s+Destination:\s+(.+)/);
            if (destMatch) {
                finalFilePath = destMatch[1].trim();
            }
        }

        if (!finalFilePath) {
            // Fallback: parse "already been downloaded" from accumulated output
            const alreadyMatch = result.stdout.match(
                /\[download\]\s+(.+)\s+has already been downloaded/,
            );
            if (alreadyMatch) {
                finalFilePath = alreadyMatch[1].trim();
                alreadyInArchive = true;
            }
        }

        // Also detect archive-recorded in accumulated output
        if (!alreadyInArchive) {
            alreadyInArchive =
                result.stdout.includes('has already been recorded') ||
                result.stdout.includes('has already been downloaded');
        }

        // ── Archive-skip handling ─────────────────────────────────────
        // When yt-dlp reports the file is already in the download archive,
        // do NOT create a duplicate library entry. Prefer matching by
        // filePath (exact artifact) when available; fall back to sourceUrl
        // only when it is unique in the library to avoid ambiguous matches.
        if (alreadyInArchive) {
            const lib = state.getLibrary();

            // Prefer exact file path match when we have a concrete path
            let existingLib = finalFilePath
                ? lib.find((l) => l.filePath === finalFilePath)
                : undefined;

            // Fall back to sourceUrl match only when unambiguous
            if (!existingLib) {
                const urlMatches = lib.filter((l) => l.sourceUrl === entry.url);
                if (urlMatches.length === 1) {
                    existingLib = urlMatches[0];
                }
                // If multiple matches, do not auto-link (ambiguous)
            }

            if (existingLib) {
                // Already in library — mark queue entry complete, link to existing
                state.updateQueueEntry(entry.id, {
                    status: 'complete',
                    progress: 100,
                    finalFilePath: existingLib.filePath,
                    finalFileUrl: existingLib.fileUrl,
                    libraryId: existingLib.id,
                });
                state.broadcastToWebPanels({
                    v: 1,
                    type: 'download-status',
                    id: entry.id,
                    status: 'complete',
                    finalFilePath: existingLib.filePath,
                    finalFileUrl: existingLib.fileUrl,
                });
                return;
            }

            // Not in library — only proceed to add if we have a valid file path
            if (!finalFilePath) {
                const errorMessage =
                    'File already in download archive \u2014 delete .ytdlp-archive in the output directory and retry to re-download';
                console.warn(
                    `[yt-dlp] archive skip without file path for ${entry.id}`,
                );
                state.updateQueueEntry(entry.id, {
                    status: 'failed',
                    errorMessage,
                });
                state.broadcastToWebPanels({
                    v: 1,
                    type: 'download-status',
                    id: entry.id,
                    status: 'failed',
                    errorMessage,
                });
                return;
            }
            // Fall through to normal library creation with the captured path
        }

        // Guard: do NOT create a LibraryEntry without a concrete file path.
        if (!finalFilePath) {
            const errorMessage = 'Download completed but file path could not be determined';
            console.warn(`[yt-dlp] exit 0 but no file path for ${entry.id} (parser miss)`);
            state.updateQueueEntry(entry.id, {
                status: 'failed',
                errorMessage,
            });
            state.broadcastToWebPanels({
                v: 1,
                type: 'download-status',
                id: entry.id,
                status: 'failed',
                errorMessage,
            });
            return;
        }

        // Compute file URL using pathToUrl (no hand-concatenation of file://)
        const fileUrl = pathToUrl(finalFilePath);
        const ext = fileExtension(finalFilePath) ?? '';

        // Emit final progress tick (100%) synchronously — ensures the UI
        // shows completion (throttle is already cancelled above).
        state.broadcastToWebPanels({
            v: 1,
            type: 'download-progress',
            id: entry.id,
            percent: 100,
            attempt: currentAttempt,
            maxAttempts: currentMaxAttempts,
        });

        // Get file size via getFileInfo if available
        let fileSize = 0;
        try {
            const info = await localCtx.fileOps.getFileInfo(fileUrl);
            fileSize = info.size ?? 0;
        } catch {
            // getFileInfo may fail for various reasons — use 0
        }

        // Build LibraryEntry — reuse queue entry ID as library ID (invariant)
        const libraryEntry: LibraryEntry = {
            id: entry.id,
            sourceUrl: entry.url,
            fileUrl,
            filePath: finalFilePath,
            title: entry.title ?? entry.url,
            duration: undefined,
            fileExt: ext,
            fileSize,
            downloadedAt: new Date().toISOString(),
            favorite: false,
            groupTag: entry.groupTag ?? undefined,
            request: req,
        };

        state.addToLibrary(libraryEntry);

        // Update queue entry with completion details
        state.updateQueueEntry(entry.id, {
            status: 'complete',
            progress: 100,
            finalFilePath,
            finalFileUrl: fileUrl,
            libraryId: entry.id,
        });

        state.broadcastToWebPanels({
            v: 1,
            type: 'download-status',
            id: entry.id,
            status: 'complete',
            finalFilePath,
            finalFileUrl: fileUrl,
        });

        notifyDownloadTerminal('complete', libraryEntry.title);

        return;
    }

    // ── Error path ────────────────────────────────────────────────────
    const parsed = parseYtDlpError(result.stderr, {
        tool: 'yt-dlp',
        exitCode: result.exitCode,
    });

    // Error message MUST name the tool and exit code per epic acceptance criteria
    const errorMessage = `yt-dlp exited with ${result.exitCode}: ${parsed.message}`;

    state.updateQueueEntry(entry.id, {
        status: 'failed',
        errorCode: parsed.category,
        errorMessage,
    });

    state.broadcastToWebPanels({
        v: 1,
        type: 'download-status',
        id: entry.id,
        status: 'failed',
        errorMessage,
    });

    notifyDownloadTerminal('failed', `${entry.title ?? entry.url} — ${errorMessage}`);
}

/**
 * Iterative async queue processing loop — NO setTimeout.
 *
 * Runs while there are queued entries and `queuePaused` is false.
 * Re-entrancy is guarded by `loopRunning`.
 */
async function runLoop(): Promise<void> {
    if (loopRunning) return;
    loopRunning = true;

    try {
        while (!queuePaused) {
            const next = state.getQueue().find((e) => e.status === 'queued');
            if (!next) break;

            active = { id: next.id, abortRequested: false };
            try {
                await runOne(next);
            } finally {
                active = null;
            }
        }
    } finally {
        loopRunning = false;
    }
}
