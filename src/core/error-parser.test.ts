/**
 * Unit tests for the yt-dlp error parser.
 * Run via: tsx src/core/error-parser.test.ts
 */

import assert from 'node:assert/strict';
import { parseYtDlpError, isRecoverable, extractErrorLine } from './error-parser.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        console.error(`FAIL: ${name}`, e.message);
    }
}

// ── parseYtDlpError: category mapping ──────────────────────────────

test('DRM protected content', () => {
    const result = parseYtDlpError('ERROR: This video is DRM protected');
    assert.equal(result.category, 'drm');
    assert.equal(result.recoverable, false);
});

test('DRM purchased content', () => {
    const result = parseYtDlpError('ERROR: This is purchased content');
    assert.equal(result.category, 'drm');
});

test('geo-restricted content', () => {
    const result = parseYtDlpError('ERROR: The video is not available in your country');
    assert.equal(result.category, 'geo');
    assert.equal(result.recoverable, false);
});

test('geo blocked in your region', () => {
    const result = parseYtDlpError('ERROR: Video blocked in your region');
    assert.equal(result.category, 'geo');
});

test('auth: sign in required', () => {
    const result = parseYtDlpError('ERROR: Sign in to confirm your age');
    assert.equal(result.category, 'auth');
    assert.equal(result.recoverable, false);
});

test('auth: login required', () => {
    const result = parseYtDlpError('ERROR: login required to access this content');
    assert.equal(result.category, 'auth');
});

test('auth: cookies', () => {
    const result = parseYtDlpError('ERROR: Use --cookies to provide cookies');
    assert.equal(result.category, 'auth');
});

test('rate_limit: HTTP 429', () => {
    const result = parseYtDlpError('ERROR: HTTP Error 429: Too Many Requests');
    assert.equal(result.category, 'rate_limit');
    assert.equal(result.recoverable, true);
});

test('rate_limit: explicit rate limit', () => {
    const result = parseYtDlpError('ERROR: rate limit exceeded');
    assert.equal(result.category, 'rate_limit');
});

test('network: connection error', () => {
    const result = parseYtDlpError('ERROR: Unable to download: connection refused');
    assert.equal(result.category, 'network');
    assert.equal(result.recoverable, true);
});

test('network: timeout', () => {
    const result = parseYtDlpError('ERROR: timed out waiting for response');
    assert.equal(result.category, 'network');
});

test('network: DNS', () => {
    const result = parseYtDlpError('ERROR: DNS resolution failed');
    assert.equal(result.category, 'network');
});

test('network: SSL', () => {
    const result = parseYtDlpError('ERROR: SSL certificate verify failed');
    assert.equal(result.category, 'network');
});

test('disk_full: no space left', () => {
    const result = parseYtDlpError('ERROR: No space left on device');
    assert.equal(result.category, 'disk_full');
    assert.equal(result.recoverable, false);
});

test('disk_full: ENOSPC', () => {
    const result = parseYtDlpError('ERROR: [Errno 28] ENOSPC');
    assert.equal(result.category, 'disk_full');
});

test('partial: already been downloaded (nonzero exit)', () => {
    const result = parseYtDlpError('WARNING: has already been recorded in archive', { exitCode: 1 });
    // No match on partial pattern — "already been recorded" vs "has already been recorded"
    // Actually let's test the exact pattern
    const result2 = parseYtDlpError('[download] Video already been downloaded', { exitCode: 1 });
    assert.equal(result2.category, 'partial');
    assert.equal(result2.recoverable, true);
});

test('partial: skipped when exit code is 0', () => {
    const result = parseYtDlpError('[download] Video already been downloaded', { exitCode: 0 });
    // Should NOT match partial — exit 0 means successful resume
    assert.notEqual(result.category, 'partial');
});

test('partial: skipped when no exit code', () => {
    const result = parseYtDlpError('[download] Video already been downloaded');
    assert.notEqual(result.category, 'partial');
});

test('invalid_url: Unsupported URL', () => {
    const result = parseYtDlpError('ERROR: Unsupported URL: https://example.com');
    assert.equal(result.category, 'invalid_url');
    assert.equal(result.recoverable, false);
});

test('invalid_url: not a valid URL', () => {
    const result = parseYtDlpError('ERROR: "foo" is not a valid URL');
    assert.equal(result.category, 'invalid_url');
});

test('invalid_url: no suitable InfoExtractor', () => {
    const result = parseYtDlpError('ERROR: no suitable InfoExtractor for URL');
    assert.equal(result.category, 'invalid_url');
});

test('unavailable: private video maps to unknown', () => {
    const result = parseYtDlpError('ERROR: private video');
    assert.equal(result.category, 'unknown');
    assert.equal(result.recoverable, false);
});

test('unavailable: removed by uploader maps to unknown', () => {
    const result = parseYtDlpError('ERROR: Video removed by uploader');
    assert.equal(result.category, 'unknown');
});

test('dependency_missing: command not found', () => {
    const result = parseYtDlpError('yt-dlp: command not found');
    assert.equal(result.category, 'dependency_missing');
    assert.equal(result.recoverable, true);
});

test('dependency_missing: No such file', () => {
    const result = parseYtDlpError('bash: /usr/local/bin/yt-dlp: No such file or directory');
    assert.equal(result.category, 'dependency_missing');
});

test('dependency_missing: DEPENDENCY_MISSING marker', () => {
    const result = parseYtDlpError('DEPENDENCY_MISSING: yt-dlp');
    assert.equal(result.category, 'dependency_missing');
});

test('unknown: unrecognized error', () => {
    const result = parseYtDlpError('Something completely unexpected happened');
    assert.equal(result.category, 'unknown');
    assert.equal(result.recoverable, false);
});

// ── parseYtDlpError: opts pass-through ─────────────────────────────

test('opts.tool is set on result', () => {
    const result = parseYtDlpError('ERROR: DRM protected', { tool: 'yt-dlp' });
    assert.equal(result.tool, 'yt-dlp');
});

test('opts.exitCode is set on result', () => {
    const result = parseYtDlpError('ERROR: DRM protected', { tool: 'yt-dlp', exitCode: 1 });
    assert.equal(result.exitCode, 1);
});

test('opts not set when not provided', () => {
    const result = parseYtDlpError('ERROR: DRM protected');
    assert.equal(result.tool, undefined);
    assert.equal(result.exitCode, undefined);
});

test('opts on fallback unknown error', () => {
    const result = parseYtDlpError('totally unexpected', { tool: 'ffmpeg', exitCode: 2 });
    assert.equal(result.category, 'unknown');
    assert.equal(result.tool, 'ffmpeg');
    assert.equal(result.exitCode, 2);
});

// ── isRecoverable ──────────────────────────────────────────────────

test('isRecoverable: network → true', () => assert.equal(isRecoverable('network'), true));
test('isRecoverable: rate_limit → true', () => assert.equal(isRecoverable('rate_limit'), true));
test('isRecoverable: partial → true', () => assert.equal(isRecoverable('partial'), true));
test('isRecoverable: dependency_missing → true', () => assert.equal(isRecoverable('dependency_missing'), true));
test('isRecoverable: drm → false', () => assert.equal(isRecoverable('drm'), false));
test('isRecoverable: geo → false', () => assert.equal(isRecoverable('geo'), false));
test('isRecoverable: auth → false', () => assert.equal(isRecoverable('auth'), false));
test('isRecoverable: invalid_url → false', () => assert.equal(isRecoverable('invalid_url'), false));
test('isRecoverable: disk_full → false', () => assert.equal(isRecoverable('disk_full'), false));
test('isRecoverable: unknown → false', () => assert.equal(isRecoverable('unknown'), false));

// ── extractErrorLine ───────────────────────────────────────────────

test('extractErrorLine: returns last ERROR line', () => {
    const stderr = 'WARNING: first warning\nERROR: first error\nERROR: second error';
    assert.equal(extractErrorLine(stderr), 'ERROR: second error');
});

test('extractErrorLine: returns last WARNING when no ERROR', () => {
    const stderr = 'WARNING: something happened\nWARNING: another thing';
    assert.equal(extractErrorLine(stderr), 'WARNING: another thing');
});

test('extractErrorLine: returns empty string when no match', () => {
    assert.equal(extractErrorLine('just normal output'), '');
});

test('extractErrorLine: trims whitespace', () => {
    assert.equal(extractErrorLine('  ERROR: with spaces  '), 'ERROR: with spaces');
});

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
