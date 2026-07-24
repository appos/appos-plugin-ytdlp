/**
 * Shared path helpers for the yt-dlp plugin.
 *
 * Centralises home-directory expansion, output-directory validation,
 * and directory creation so every shell-using task resolves paths
 * through a single code path.
 *
 * `initPaths(ctx)` must be called by main.ts during activation.
 *
 * @module paths
 */

import type { PluginContext } from '@appos.space/plugin-types';
import { pathToUrl } from '@appos.space/plugin-utils';

// Node's `process` may or may not exist in the plugin sandbox.
// Declare it loosely to avoid requiring @types/node.
declare const process: { env?: Record<string, string | undefined> } | undefined;

// ── Module state ───────────────────────────────────────────────────

/** Whether `initPaths` has been called. */
let initialised = false;

/**
 * Resolved home directory, or `null` when the SDK provides no API.
 * Currently always `null` (no home-directory API in the SDK).
 */
let homeDir: string | null = null;

// ── Public API ─────────────────────────────────────────────────────

/**
 * One-time initialiser. Must be called during plugin activation.
 *
 * Probes three sources for the user's home directory:
 *   1. `ctx.fileOps.home?.()` — future SDK API (duck-typed probe)
 *   2. `process.env.HOME` — available in some runtimes
 *   3. Falls back to `null` when both are unavailable
 *
 * As of SDK v2.4 / plugin-types, PluginContext does NOT expose a
 * home-directory method. `process.env.HOME` is also typically
 * sandboxed away. When `homeDir` is `null`, `expandPath` throws a
 * clear error for `~`-prefixed paths, forcing the user to provide
 * an absolute `outputDir` in settings.
 *
 * @param ctx - Plugin context (probed for home-dir API).
 */
export async function initPaths(ctx: PluginContext): Promise<void> {
    homeDir = null;

    // Probe 1: duck-type check for a future SDK home-directory API
    try {
        const fileOps = ctx.fileOps as unknown as Record<string, unknown>;
        if (typeof fileOps.home === 'function') {
            const result = await (fileOps.home as () => Promise<string>)();
            if (typeof result === 'string' && result.startsWith('/')) {
                homeDir = result;
            }
        }
    } catch {
        // API not available or threw — fall through
    }

    // Probe 2: process.env.HOME (may be sandboxed)
    if (homeDir === null) {
        try {
            const envHome = (typeof process !== 'undefined' && process.env?.HOME) || null;
            if (typeof envHome === 'string' && envHome.startsWith('/')) {
                homeDir = envHome;
            }
        } catch {
            // Sandboxed — fall through
        }
    }

    initialised = true;

    if (homeDir !== null) {
        console.info('[yt-dlp] Home directory resolved successfully');
    } else {
        console.warn(
            '[yt-dlp] No home-directory API in SDK — ' +
            '~ expansion unavailable. Users must provide absolute outputDir.',
        );
    }
}

/**
 * Expand a path, replacing a leading `~` with the home directory.
 *
 * Synchronous and pure once `initPaths` has run. Throws if:
 * - `initPaths` has not been called.
 * - The input starts with `~` and `homeDir` is `null`.
 *
 * @param pathOrUrl - A filesystem path (not a `file://` URL).
 * @returns Absolute POSIX path.
 */
export function expandPath(pathOrUrl: string): string {
    if (!initialised) {
        throw new Error(
            '[yt-dlp] expandPath called before initPaths — call initPaths(ctx) during activation',
        );
    }

    // Only expand exact `~` or `~/...` — reject `~otheruser` forms
    if (pathOrUrl === '~' || pathOrUrl.startsWith('~/')) {
        if (homeDir === null) {
            throw new Error(
                'home directory not available \u2014 please provide an absolute path in settings',
            );
        }
        return pathOrUrl === '~' ? homeDir : homeDir + pathOrUrl.slice(1);
    }

    // Reject unsupported tilde syntax like ~otheruser/...
    if (pathOrUrl.startsWith('~')) {
        throw new Error(
            `unsupported tilde syntax "${pathOrUrl}" \u2014 only ~ and ~/... are supported`,
        );
    }

    return pathOrUrl;
}

/**
 * Validate that `dir` resolves to a non-empty absolute POSIX path.
 *
 * Does NOT create the directory (that is `ensureOutputDir`'s job).
 *
 * @param dir - Raw setting value for `outputDir`.
 * @returns Typed success with `resolved` path, or typed error with `reason`.
 */
export function validateOutputDir(
    dir: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
    if (!dir || dir.trim() === '') {
        return { ok: false, reason: 'outputDir is not set — please configure it in plugin settings' };
    }

    let resolved: string;
    try {
        resolved = expandPath(dir);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: message };
    }

    if (!resolved.startsWith('/')) {
        return { ok: false, reason: `outputDir must be an absolute path (got "${resolved}")` };
    }

    return { ok: true, resolved };
}

/**
 * Ensure the output directory exists, creating it if necessary.
 *
 * Validates via `validateOutputDir`, converts to a `file://` URL, and
 * calls `ctx.fileOps.createDirectory(parentUrl, name)` idempotently.
 *
 * @param ctx  - Plugin context for `fileOps.createDirectory`.
 * @param dir  - Raw or absolute path string.
 * @returns The absolute POSIX path (for use in shell commands).
 * @throws If the path is empty, relative, or contains unresolvable `~`.
 */
export async function ensureOutputDir(
    ctx: PluginContext,
    dir: string,
): Promise<string> {
    const validation = validateOutputDir(dir);
    if (!validation.ok) {
        throw new Error(`[yt-dlp] ensureOutputDir: ${validation.reason}`);
    }

    // Normalize: collapse all-slash inputs to "/" and strip trailing slashes
    const resolved = /^\/+$/.test(validation.resolved)
        ? '/'
        : validation.resolved.replace(/\/+$/, '');

    // Root directory always exists — nothing to create
    if (resolved === '/') {
        return resolved;
    }

    // Split into parent and leaf for the createDirectory(parentUrl, name) API
    const lastSlash = resolved.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? resolved.slice(0, lastSlash) : '/';
    const name = resolved.slice(lastSlash + 1);

    const parentUrl = pathToUrl(parentPath);
    await ctx.fileOps.createDirectory(parentUrl, name);

    return resolved;
}

/**
 * Path to the yt-dlp download archive file within the output directory.
 * Used by the downloader's `--download-archive` flag.
 *
 * @param outputDir - Resolved absolute output directory.
 */
export function archivePathFor(outputDir: string): string {
    return `${outputDir}/.ytdlp-archive`;
}

/**
 * Path to the temporary directory within the output directory.
 * Used by yt-dlp's `-P temp:` option.
 *
 * @param outputDir - Resolved absolute output directory.
 */
export function tempDirFor(outputDir: string): string {
    return `${outputDir}/.ytdlp-temp`;
}
