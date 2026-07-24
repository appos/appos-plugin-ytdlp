/**
 * Unit tests for the security module.
 * Run via: tsx src/core/security.test.ts
 */

import assert from 'node:assert/strict';
import { sanitizeYtDlpArgs, isValidMediaUrl, sanitizeFilenameTemplate } from './security.ts';

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

// ── sanitizeYtDlpArgs: denied flags ────────────────────────────────

const DENIED = [
    '--exec', '--exec-before-download',
    '--postprocessor-args', '--ppa',
    '--config-location',
    '--batch-file', '-a',
    '--external-downloader', '--downloader',
    '--load-info-json',
    '--parse-metadata', '--replace-in-metadata',
    '--paths', '-P',
    '--cookies-from-browser',
    '-o', '--output',
    '--no-continue', '--download-archive', '--continue',
];

for (const flag of DENIED) {
    test(`rejects denied flag: ${flag}`, () => {
        const result = sanitizeYtDlpArgs([flag]);
        assert.equal(result.ok, false);
        assert.ok(result.rejected.includes(flag));
    });
}

// ── sanitizeYtDlpArgs: --flag=value form ───────────────────────────

test('rejects --exec=cmd in equals form', () => {
    const result = sanitizeYtDlpArgs(['--exec=echo hello']);
    assert.equal(result.ok, false);
    assert.ok(result.rejected.includes('--exec'));
});

test('rejects --paths=/tmp in equals form', () => {
    const result = sanitizeYtDlpArgs(['--paths=/tmp']);
    assert.equal(result.ok, false);
    assert.ok(result.rejected.includes('--paths'));
});

test('rejects --output=template in equals form', () => {
    const result = sanitizeYtDlpArgs(['--output=%(title)s.%(ext)s']);
    assert.equal(result.ok, false);
    assert.ok(result.rejected.includes('--output'));
});

// ── sanitizeYtDlpArgs: short flags with attached values ────────────

test('rejects -o with attached value (-otemplate)', () => {
    const result = sanitizeYtDlpArgs(['-o%(title)s.%(ext)s']);
    assert.equal(result.ok, false);
    assert.ok(result.rejected.includes('-o'));
});

test('rejects -P with attached value (-P/tmp)', () => {
    const result = sanitizeYtDlpArgs(['-P/tmp/downloads']);
    assert.equal(result.ok, false);
    assert.ok(result.rejected.includes('-P'));
});

test('rejects -a with attached value (-aurls.txt)', () => {
    const result = sanitizeYtDlpArgs(['-aurls.txt']);
    assert.equal(result.ok, false);
    assert.ok(result.rejected.includes('-a'));
});

test('does not false-positive on unrelated short flags', () => {
    // -f is not in the deny-list, even with attached value
    const result = sanitizeYtDlpArgs(['-fbestvideo']);
    assert.equal(result.ok, true);
});

// ── sanitizeYtDlpArgs: multiple denied flags ───────────────────────

test('rejects multiple denied flags and lists all', () => {
    const result = sanitizeYtDlpArgs(['--exec', '--batch-file', 'some-file']);
    assert.equal(result.ok, false);
    assert.ok(result.rejected.includes('--exec'));
    assert.ok(result.rejected.includes('--batch-file'));
});

// ── sanitizeYtDlpArgs: allowed flags (deny-list, not allow-list) ──

test('passes safe flags through', () => {
    const result = sanitizeYtDlpArgs(['--no-playlist', '--write-thumbnail', '--embed-subs']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ['--no-playlist', '--write-thumbnail', '--embed-subs']);
});

test('passes unknown/custom flags through (deny-list behavior)', () => {
    const result = sanitizeYtDlpArgs(['--some-future-flag', '--custom-thing=value']);
    assert.equal(result.ok, true);
});

test('passes empty args array', () => {
    const result = sanitizeYtDlpArgs([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, []);
});

test('passes value arguments that happen to contain denied flag text', () => {
    // A value like "exec" shouldn't be rejected — only the flag itself
    const result = sanitizeYtDlpArgs(['--format', 'bestvideo+bestaudio']);
    assert.equal(result.ok, true);
});

// ── isValidMediaUrl: accepted URLs ─────────────────────────────────

test('accepts http URL', () => {
    assert.equal(isValidMediaUrl('http://example.com/video').ok, true);
});

test('accepts https URL', () => {
    assert.equal(isValidMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').ok, true);
});

test('accepts URL with query string', () => {
    assert.equal(isValidMediaUrl('https://example.com/video?quality=hd&t=120').ok, true);
});

test('accepts URL with fragment', () => {
    assert.equal(isValidMediaUrl('https://example.com/video#section').ok, true);
});

test('accepts URL with percent-encoding', () => {
    assert.equal(isValidMediaUrl('https://example.com/video%20name').ok, true);
});

// ── isValidMediaUrl: rejected URLs ─────────────────────────────────

test('rejects empty string', () => {
    const result = isValidMediaUrl('');
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('empty'));
});

test('rejects whitespace-only string', () => {
    const result = isValidMediaUrl('   ');
    assert.equal(result.ok, false);
});

test('rejects leading dash', () => {
    const result = isValidMediaUrl('-http://evil.com');
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('dash'));
});

test('rejects file:// scheme', () => {
    const result = isValidMediaUrl('file:///etc/passwd');
    assert.equal(result.ok, false);
});

test('rejects javascript: scheme', () => {
    const result = isValidMediaUrl('javascript:alert(1)');
    assert.equal(result.ok, false);
});

test('rejects data: scheme', () => {
    const result = isValidMediaUrl('data:text/html,<h1>hi</h1>');
    assert.equal(result.ok, false);
});

test('rejects ftp:// scheme', () => {
    const result = isValidMediaUrl('ftp://files.example.com/video.mp4');
    assert.equal(result.ok, false);
});

test('rejects URL with newline', () => {
    const result = isValidMediaUrl('https://example.com/video\nhttps://evil.com');
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('control'));
});

test('rejects URL with null byte', () => {
    const result = isValidMediaUrl('https://example.com/\x00video');
    assert.equal(result.ok, false);
});

test('rejects URL with tab', () => {
    const result = isValidMediaUrl('https://example.com/\tvideo');
    assert.equal(result.ok, false);
});

test('rejects URL over 2048 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2040);
    const result = isValidMediaUrl(longUrl);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('2048'));
});

test('rejects URL without scheme', () => {
    const result = isValidMediaUrl('example.com/video');
    assert.equal(result.ok, false);
});

test('rejects mailto: scheme', () => {
    const result = isValidMediaUrl('mailto:user@example.com');
    assert.equal(result.ok, false);
});

test('rejects malformed https URL (scheme only)', () => {
    const result = isValidMediaUrl('https://');
    assert.equal(result.ok, false);
});

test('rejects malformed http URL with spaces', () => {
    const result = isValidMediaUrl('https://exa mple.com');
    assert.equal(result.ok, false);
});

// ── sanitizeFilenameTemplate: accepted templates ───────────────────

test('accepts canonical default template', () => {
    const result = sanitizeFilenameTemplate('%(title)s [%(id)s].%(ext)s');
    assert.equal(result.ok, true);
    assert.equal(result.template, '%(title)s [%(id)s].%(ext)s');
});

test('accepts template with only %(id)s', () => {
    const result = sanitizeFilenameTemplate('%(id)s.%(ext)s');
    assert.equal(result.ok, true);
});

test('accepts template with only %(title)s', () => {
    const result = sanitizeFilenameTemplate('%(title)s.%(ext)s');
    assert.equal(result.ok, true);
});

test('returns template unchanged (no mutation)', () => {
    const tpl = '%(title)s - %(uploader)s [%(id)s].%(ext)s';
    const result = sanitizeFilenameTemplate(tpl);
    assert.equal(result.ok, true);
    assert.equal(result.template, tpl);
});

// ── sanitizeFilenameTemplate: rejected templates ───────────────────

test('rejects empty template', () => {
    const result = sanitizeFilenameTemplate('');
    assert.equal(result.ok, false);
});

test('rejects whitespace-only template', () => {
    const result = sanitizeFilenameTemplate('   ');
    assert.equal(result.ok, false);
});

test('rejects template with $', () => {
    const result = sanitizeFilenameTemplate('$(whoami)_%(title)s.%(ext)s');
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('metacharacter'));
});

test('rejects template with backtick', () => {
    const result = sanitizeFilenameTemplate('`id`_%(title)s.%(ext)s');
    assert.equal(result.ok, false);
});

test('rejects template with newline', () => {
    const result = sanitizeFilenameTemplate('%(title)s\n%(id)s.%(ext)s');
    assert.equal(result.ok, false);
});

test('rejects template with forward slash', () => {
    const result = sanitizeFilenameTemplate('subdir/%(title)s.%(ext)s');
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('path separator'));
});

test('rejects template with backslash', () => {
    const result = sanitizeFilenameTemplate('subdir\\%(title)s.%(ext)s');
    assert.equal(result.ok, false);
});

test('rejects template with path traversal', () => {
    const result = sanitizeFilenameTemplate('..%(title)s.%(ext)s');
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('traversal'));
});

test('rejects template with leading tilde', () => {
    const result = sanitizeFilenameTemplate('~/%(title)s.%(ext)s');
    assert.equal(result.ok, false);
});

test('rejects template missing both %(title)s and %(id)s', () => {
    const result = sanitizeFilenameTemplate('%(uploader)s.%(ext)s');
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('%(title)s') || result.reason.includes('%(id)s'));
});

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
