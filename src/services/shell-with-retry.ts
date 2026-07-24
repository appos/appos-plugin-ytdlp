/**
 * Shell-with-retry helper — 120-second cap mitigation via resume-loop.
 *
 * The AppOS host enforces a hard 120-second timeout on all shell processes
 * (Foundation.Process → SIGTERM after timeout, SIGKILL after 5s grace).
 * This module wraps any shell-like async runner (`ctx.shell.execute` or
 * `ctx.ui.pipeShellToWebPanel`) with timeout-aware retry logic so that
 * long-running yt-dlp downloads can survive beyond the 2-minute cap.
 *
 * ## Generic-executor design
 *
 * The caller provides a `ShellExecutor` closure that captures `ctx` internally.
 * This module never touches `ctx` — cleaner separation, easier testing.
 *
 * ## Step-0 gate findings (pipeShellToWebPanel visibility)
 *
 * **Confirmed: Path A** — `pipeShellToWebPanel` DOES surface plugin-side `onData`.
 * The host preserves the caller's `onData` handler: it wraps it in a new
 * function that first posts chunks to the webview, then calls the original
 * `onData`. This means the downloader can use a single yt-dlp invocation via
 * `ctx.ui.pipeShellToWebPanel(PANELS.DOWNLOAD, opts)` with an `onData` handler
 * for plugin-side progress parsing. The host streams chunks to the webview in
 * parallel automatically.
 *
 * ## Exit-code behavior on timeout
 *
 * The host's ProcessRunner uses Foundation.Process `terminationStatus`:
 * - SIGTERM (timeout) → exit code 143 (128 + 15)
 * - SIGKILL (grace expired) → exit code 137 (128 + 9)
 * No wrapper codes — raw `terminationStatus` is passed through.
 *
 * ## pipeShellToWebPanel namespace
 *
 * Confirmed on `ctx.ui` (UIAPI, plugin-api.d.ts:1374), NOT `ctx.shell`.
 *
 * @module shell-with-retry
 */

import type { ShellExecuteOptions, ShellExecuteResult } from '@appos.space/plugin-types';

import { PROCESS_TIMEOUT_SECONDS, PROGRESS_REGEX } from '../constants';

// ── Exit-code constants ────────────────────────────────────────────────

/**
 * Cancellation sentinel exit code.
 * Returned when `isAborted()` fires before any attempt runs. Not a real
 * process exit code — call sites should check `isAborted` / their own
 * abort flag rather than relying on this value.
 */
export const EXIT_CANCELLED = -999;

/**
 * SIGTERM exit code (128 + 15).
 * Observed from host ProcessRunner: `Process.terminationStatus` after SIGTERM.
 */
const EXIT_SIGTERM = 143;

/**
 * SIGKILL exit code (128 + 9).
 * Observed from host ProcessRunner: sent after 5s grace when SIGTERM didn't stop process.
 */
const EXIT_SIGKILL = 137;

// ── Accumulated buffer cap ─────────────────────────────────────────────

/**
 * Maximum characters to keep per accumulated stream across retry attempts.
 * Tail-preserving: drops oldest characters, keeps newest so `after_move:filepath:`
 * and final `ERROR:` lines are retained.
 *
 * Character-based (UTF-16 code units), not byte-based. For yt-dlp's
 * predominantly ASCII output this is effectively ~1MB per stream.
 */
const MAX_ACCUMULATED_CHARS = 1024 * 1024; // ~1M chars

// ── Public types ───────────────────────────────────────────────────────

/** Async function that runs a shell op and returns its result. */
export type ShellExecutor = (options: ShellExecuteOptions) => Promise<ShellExecuteResult>;

/** Retry strategy for `shellWithRetry`. */
export type RetryStrategy = 'none' | 'single' | 'progress-aware';

/** Options controlling retry behavior. */
export interface RetryOptions {
    /** Which retry strategy to use. */
    retry: RetryStrategy;

    /**
     * Extract progress (0..1) from accumulated output.
     * Required for `progress-aware` strategy; ignored otherwise.
     */
    progressOf?: (accumulated: { stdout: string; stderr: string }) => number;

    /** Maximum retry attempts (default 20 ≈ ~40 min at 119s each). */
    maxAttempts?: number;

    /** Max consecutive non-advancing attempts before giving up (default 3). */
    maxStalls?: number;

    /** Called before each attempt with 1-based attempt number and max. */
    onAttempt?: (attempt: number, max: number) => void;

    /**
     * Optional abort check. When provided, called before each new attempt.
     * If it returns `true`, the retry loop exits immediately with the last
     * result (or a synthetic `EXIT_CANCELLED` sentinel if no attempt ran yet).
     * Call sites should check their own abort flag rather than relying on the
     * exit code. This allows external cancellation to stop the loop at attempt
     * boundaries without waiting for the full maxAttempts cycle.
     */
    isAborted?: () => boolean;
}

/** Options for building yt-dlp resume-friendly args. */
export interface YtDlpResumeOptions {
    /** Path to the download-archive file. */
    archivePath: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Returns true if the exit code indicates a host-enforced timeout. */
function isTimeoutExit(exitCode: number): boolean {
    return exitCode === EXIT_SIGTERM || exitCode === EXIT_SIGKILL;
}

/**
 * Returns true if stderr contains a host-specific process timeout message.
 *
 * Narrowed to host ProcessRunner markers to avoid conflating network-level
 * timeouts (e.g. "ERROR: timed out waiting for response") with the 120s
 * host-enforced process cap. Network timeouts surface their own error
 * category via the error-parser and should NOT trigger automatic retries here.
 */
function hasTimeoutMessage(stderr: string): boolean {
    return /process\s+timed?\s*out|execution\s+timed?\s*out|shell\s+timed?\s*out/i.test(stderr);
}

/**
 * Tail-preserving append: keep the newest `MAX_ACCUMULATED_CHARS` characters.
 * Drops from the start so that completion markers at the end are retained.
 *
 * Note: cap is character-based (UTF-16 code units), not byte-based.
 * For yt-dlp output (predominantly ASCII) this is effectively equivalent.
 */
function cappedAppend(existing: string, chunk: string): string {
    const combined = existing + chunk;
    if (combined.length <= MAX_ACCUMULATED_CHARS) return combined;
    return combined.slice(combined.length - MAX_ACCUMULATED_CHARS);
}

/** Clamp timeout to the safe maximum (1s below host cap). */
function clampOptions(options: ShellExecuteOptions): ShellExecuteOptions {
    return {
        ...options,
        timeout: Math.min(options.timeout ?? PROCESS_TIMEOUT_SECONDS, PROCESS_TIMEOUT_SECONDS),
    };
}

// ── Core function ──────────────────────────────────────────────────────

/**
 * Execute a shell command with timeout-aware retry.
 *
 * Wraps any `ShellExecutor` (shell.execute or pipeShellToWebPanel) with
 * configurable retry logic to work around the host's 120-second process cap.
 *
 * @param executor - Async function that runs the shell command.
 * @param options - Shell execution options (timeout will be clamped to 119s).
 * @param retry - Retry strategy and options.
 * @returns The final `ShellExecuteResult` from the last attempt.
 */
export async function shellWithRetry(
    executor: ShellExecutor,
    options: ShellExecuteOptions,
    retry: RetryOptions,
): Promise<ShellExecuteResult> {
    const clamped = clampOptions(options);

    if (retry.retry === 'none') {
        return executor(clamped);
    }

    if (retry.retry === 'single') {
        return retrySingle(executor, clamped, retry);
    }

    if (!retry.progressOf) {
        throw new Error('shellWithRetry: progressOf callback is required for progress-aware strategy');
    }

    return retryProgressAware(executor, clamped, retry);
}

// ── Strategy: single ───────────────────────────────────────────────────

async function retrySingle(
    executor: ShellExecutor,
    options: ShellExecuteOptions,
    retry: RetryOptions,
): Promise<ShellExecuteResult> {
    // Check abort before first attempt — consistent with progress-aware strategy
    if (retry.isAborted?.()) {
        return { exitCode: EXIT_CANCELLED, stdout: '', stderr: '' };
    }

    retry.onAttempt?.(1, 2);
    const first = await executor(options);

    if (first.exitCode === 0) return first;
    if (!isTimeoutExit(first.exitCode) && !hasTimeoutMessage(first.stderr)) return first;

    // Check abort before launching second attempt
    if (retry.isAborted?.()) return first;

    retry.onAttempt?.(2, 2);
    return executor(options);
}

// ── Strategy: progress-aware ───────────────────────────────────────────

async function retryProgressAware(
    executor: ShellExecutor,
    options: ShellExecuteOptions,
    retry: RetryOptions,
): Promise<ShellExecuteResult> {
    const maxAttempts = Math.max(1, retry.maxAttempts ?? 20);
    const maxStalls = Math.max(1, retry.maxStalls ?? 3);
    const progressOf = retry.progressOf!;

    const accumulated = { stdout: '', stderr: '' };
    let stallCount = 0;
    let lastResult: ShellExecuteResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Check abort before launching a new attempt — stops the loop at
        // attempt boundaries when external cancellation is requested.
        if (retry.isAborted?.()) {
            if (lastResult) {
                return { ...lastResult, stdout: accumulated.stdout, stderr: accumulated.stderr };
            }
            // No attempt ran yet — return a synthetic cancellation sentinel.
            // Call sites should check their own abort flag rather than this code.
            return { exitCode: EXIT_CANCELLED, stdout: accumulated.stdout, stderr: accumulated.stderr };
        }

        const previousPercent = progressOf(accumulated);
        retry.onAttempt?.(attempt, maxAttempts);

        const result = await executor(options);
        lastResult = result;

        accumulated.stdout = cappedAppend(accumulated.stdout, result.stdout);
        accumulated.stderr = cappedAppend(accumulated.stderr, result.stderr);

        // Success — done.
        if (result.exitCode === 0) {
            return { ...result, stdout: accumulated.stdout, stderr: accumulated.stderr };
        }

        // Non-timeout error — real failure, return immediately.
        if (!isTimeoutExit(result.exitCode) && !hasTimeoutMessage(result.stderr)) {
            return { ...result, stdout: accumulated.stdout, stderr: accumulated.stderr };
        }

        // Timeout — check progress.
        const currentPercent = progressOf(accumulated);
        if (currentPercent > previousPercent) {
            stallCount = 0;
        } else {
            stallCount++;
        }

        if (stallCount >= maxStalls) {
            return { ...result, stdout: accumulated.stdout, stderr: accumulated.stderr };
        }
    }

    // Exhausted all attempts — return last result with accumulated output.
    return { ...lastResult!, stdout: accumulated.stdout, stderr: accumulated.stderr };
}

// ── yt-dlp integration conveniences ────────────────────────────────────

/**
 * Append `--continue` and `--download-archive <path>` to yt-dlp args if not already present.
 *
 * Idempotent — calling multiple times with the same args is safe.
 *
 * @param baseArgs - The existing yt-dlp argument array.
 * @param opts - Resume options including the archive file path.
 * @returns A new args array with resume flags appended (or the original if already present).
 */
export function buildYtDlpResumeArgs(baseArgs: string[], opts: YtDlpResumeOptions): string[] {
    const args = [...baseArgs];
    if (!args.includes('--continue')) {
        args.push('--continue');
    }
    if (!args.includes('--download-archive')) {
        args.push('--download-archive', opts.archivePath);
    }
    return args;
}

/**
 * Parse the last yt-dlp progress percentage from combined output.
 *
 * Uses the canonical `PROGRESS_REGEX` from constants.ts. Returns the last
 * match's percentage as a 0..1 float. Returns 0 if no match found.
 *
 * @param combinedOutput - Accumulated stdout/stderr from yt-dlp.
 * @returns Progress as a fraction (0..1).
 */
export function parseYtDlpPercent(combinedOutput: string): number {
    const globalRegex = new RegExp(PROGRESS_REGEX.source, 'g');
    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = globalRegex.exec(combinedOutput)) !== null) {
        lastMatch = match;
    }
    if (!lastMatch) return 0;
    const pct = parseFloat(lastMatch[1]);
    if (Number.isNaN(pct)) return 0;
    return Math.min(pct / 100, 1);
}
