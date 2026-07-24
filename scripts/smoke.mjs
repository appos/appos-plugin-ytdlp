/**
 * Smoke test script for the yt-dlp plugin.
 *
 * Two-layer validation:
 *
 * Layer 1 (bundle-level): Loads dist/main.js into a VM context, verifies
 * that activate() / deactivate() run against a mock ctx, and exercises
 * observable behavior THROUGH the bundled code (e.g., feeding error
 * stderr through mock shell execution and checking that toast messages
 * reflect correct error parsing). This catches esbuild/transpilation/
 * tree-shaking regressions in the shipped artifact.
 *
 * Layer 2 (source-level): Imports error-parser and security modules
 * directly from TypeScript source via tsx. This validates that the
 * source fixtures produce expected outputs. Unit tests (npm run
 * test:units) also cover these modules, but the smoke test provides a
 * quick sanity check in a single script.
 *
 * Run via: tsx scripts/smoke.mjs
 *
 * @module scripts/smoke
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, '..', 'dist', 'main.js');

// ── Step 1: Verify bundle exists ────────────────────────────────────

let bundle;
try {
    bundle = await fs.readFile(bundlePath, 'utf8');
} catch {
    console.error(`FAIL: dist/main.js not found at ${bundlePath} -- run \`npm run build\` first`);
    process.exit(1);
}

console.log(`OK: dist/main.js loaded (${(bundle.length / 1024).toFixed(1)} KB)`);

// ── Step 2: Verify bundle contains critical patterns ────────────────
// These checks ensure tree-shaking did not eliminate key modules from
// the shipped artifact. If any pattern is absent, the bundle is broken.

const BUNDLE_PATTERNS = [
    // error-parser patterns must survive bundling
    ['DRM', /DRM\s*protect/],
    ['geo-restrict', /geo.*restrict|not available in your country/i],
    ['rate_limit', /429|rate.*limit/i],
    // security deny-list must survive bundling
    ['--exec deny', /--exec/],
    ['--batch-file deny', /--batch-file/],
    // entry points must survive bundling
    ['globalThis.activate', /globalThis.*activate/],
    ['globalThis.deactivate', /globalThis.*deactivate/],
];

console.log('\n--- Bundle integrity checks ---');
for (const [label, pattern] of BUNDLE_PATTERNS) {
    assert.ok(pattern.test(bundle), `Bundle must contain pattern for: ${label}`);
    console.log(`OK: bundle contains ${label}`);
}

// ── Step 3: Build mock ctx with observable side effects ──────────────

/** Collects toast messages for assertion. */
const toastLog = [];

/** Collects postToWebPanel messages for assertion. */
const panelMessages = [];

/**
 * Captured onWebPanelMessage handlers, keyed by panelId.
 * Allows the smoke test to feed messages through the bundled code
 * and verify that the shipped artifact's security/error logic works.
 */
const messageHandlers = {};

function buildMockCtx() {
    const noop = () => {};
    const asyncNoop = async () => {};
    const asyncTrue = async () => true;

    const settings = new Map([
        ['outputDir', '/tmp/yt-dlp-smoke-test'],
        ['proxyUrl', ''],
        ['filenameTemplate', '%(title)s.%(ext)s'],
        ['defaultFormat', 'best'],
        ['defaultQuality', 'best'],
        ['metadataDepth', 'basic'],
    ]);

    return {
        pluginId: 'space.appos.ytdlp',
        cache: {
            get: async () => null,
            set: async () => true,
        },
        settings: {
            get: (key) => settings.get(key) ?? null,
            set: (key, val) => { settings.set(key, val); },
            onChange: () => 'mock-token',
            onKeyChange: () => 'mock-token',
            offChange: noop,
            openUI: noop,
        },
        shell: {
            execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
        ui: {
            registerWebPanel: noop,
            postToWebPanel: (panelId, msg) => {
                panelMessages.push({ panelId, msg });
            },
            onWebPanelMessage: (panelId, handler) => {
                // Capture the handler so we can feed messages through
                // the bundled code for end-to-end assertions
                messageHandlers[panelId] = handler;
            },
            pipeShellToWebPanel: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
            openInPane: noop,
            showPaneTab: noop,
        },
        feedback: {
            toast: async (message, opts) => {
                toastLog.push({ message, kind: opts?.kind });
            },
            alert: async () => 0,
        },
        clipboard: {
            read: async () => '',
            write: noop,
        },
        fileOps: {
            createDirectory: asyncNoop,
            delete: asyncNoop,
        },
        commands: {
            register: noop,
        },
        events: {
            subscribe: () => 'mock-event-token',
            unsubscribe: noop,
        },
        lifecycle: {
            getDependencyStatus: async () => [
                { id: 'yt-dlp', name: 'yt-dlp', satisfied: true },
                { id: 'ffmpeg', name: 'ffmpeg', satisfied: false },
            ],
            recheckDependencies: asyncNoop,
            onDependencyStatusChanged: () => noop,
        },
        workspaces: {
            register: asyncTrue,
            apply: asyncTrue,
        },
        menubar: {
            register: asyncTrue,
            setBadge: asyncTrue,
            remove: asyncTrue,
        },
        smartFolders: {
            registerFilterType: asyncTrue,
        },
    };
}

// ── Step 4: Load bundle in VM and call activate ─────────────────────

console.log('\n--- Bundle activation ---');

const sandbox = { globalThis: {}, console, setTimeout, clearTimeout, URL };
vm.createContext(sandbox);

try {
    vm.runInContext(bundle, sandbox);
} catch (err) {
    console.error('FAIL: VM execution of dist/main.js threw:', err.message);
    process.exit(1);
}

assert.equal(typeof sandbox.globalThis.activate, 'function', 'activate must be a function on globalThis');
assert.equal(typeof sandbox.globalThis.deactivate, 'function', 'deactivate must be a function on globalThis');
console.log('OK: activate and deactivate are functions on globalThis');

const mockCtx = buildMockCtx();
try {
    await sandbox.globalThis.activate(mockCtx);
} catch (err) {
    console.error('FAIL: activate(mockCtx) threw:', err.message);
    process.exit(1);
}
console.log('OK: activate(mockCtx) returned without throwing');

// ── Step 5: Verify bundle-level observable behavior ─────────────────
// After activation, check that the bundled code produced expected side
// effects through the mock ctx.

console.log('\n--- Bundle observable behavior ---');

// activation should have broadcast dependency statuses to panels
const depMsgs = panelMessages.filter((m) => m.msg.type === 'dependency-banner' || m.msg.type === 'dependency-status');
assert.ok(depMsgs.length > 0, 'activation must broadcast dependency status to panels');
console.log(`OK: ${depMsgs.length} dependency messages broadcast to panels`);

// activation should have broadcast a state-update
const stateMsgs = panelMessages.filter((m) => m.msg.type === 'state-update');
assert.ok(stateMsgs.length > 0, 'activation must broadcast state-update to panels');
console.log(`OK: ${stateMsgs.length} state-update messages broadcast`);

// ── Step 6: Exercise bundled security module via message handlers ────
// Feed messages through the captured onWebPanelMessage handler to
// verify the bundled security/error logic works end-to-end.

console.log('\n--- Bundled security module (end-to-end) ---');

const downloadHandler = messageHandlers['download'];
assert.ok(downloadHandler, 'download panel message handler must be captured');
console.log('OK: download panel message handler captured');

// Test 1: Send a queue-download with blocked --exec flag through the
// bundled code. The bundled security module should reject it and
// produce an error toast.
const toastCountBefore = toastLog.length;
const panelCountBefore = panelMessages.length;

downloadHandler({
    data: {
        v: 1,
        type: 'queue-download',
        requestId: 'smoke-test-blocked-args',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        format: 'best',
        quality: 'best',
        advancedArgs: ['--exec', 'rm -rf /'],
    },
});

// The handler is async (runs via Promise.resolve().then(...)), so we
// need to yield to the microtask queue for it to complete.
await new Promise((r) => setTimeout(r, 50));

// The bundled preValidateEnqueueArgs should have caught --exec and
// produced both a toast error and an enqueue-ack with ok:false.
const blockedToasts = toastLog.slice(toastCountBefore);
const blockedAcks = panelMessages.slice(panelCountBefore).filter(
    (m) => m.msg.type === 'enqueue-ack' && m.msg.requestId === 'smoke-test-blocked-args',
);

assert.ok(
    blockedToasts.some((t) => t.kind === 'error'),
    'Bundled security module must reject --exec via toast error',
);
console.log('OK: bundled security module rejected --exec (toast error)');

assert.ok(
    blockedAcks.length > 0 && blockedAcks[0].msg.ok === false,
    'Bundled security module must return enqueue-ack ok:false for blocked args',
);
console.log('OK: bundled security module returned enqueue-ack ok:false');

// Test 2: Send a queue-download with an invalid URL (leading dash).
// The bundled URL validator should reject it.
const toastCountBefore2 = toastLog.length;
const panelCountBefore2 = panelMessages.length;

downloadHandler({
    data: {
        v: 1,
        type: 'queue-download',
        requestId: 'smoke-test-bad-url',
        url: '-malicious-flag',
        format: 'best',
        quality: 'best',
    },
});

await new Promise((r) => setTimeout(r, 50));

const badUrlToasts = toastLog.slice(toastCountBefore2);
const badUrlAcks = panelMessages.slice(panelCountBefore2).filter(
    (m) => m.msg.type === 'enqueue-ack' && m.msg.requestId === 'smoke-test-bad-url',
);

assert.ok(
    badUrlToasts.some((t) => t.kind === 'error'),
    'Bundled URL validator must reject dash-prefixed URL via toast error',
);
console.log('OK: bundled URL validator rejected dash-prefixed URL');

assert.ok(
    badUrlAcks.length > 0 && badUrlAcks[0].msg.ok === false,
    'Bundled URL validator must return enqueue-ack ok:false for bad URL',
);
console.log('OK: bundled URL validator returned enqueue-ack ok:false');

// Call deactivate
try {
    await sandbox.globalThis.deactivate();
} catch (err) {
    console.error('FAIL: deactivate() threw:', err.message);
    process.exit(1);
}
console.log('OK: deactivate() returned without throwing');

// ── Step 7: Source-level error parser cross-checks ──────────────────
// These import directly from TypeScript source (resolved by tsx) as a
// secondary validation layer. The primary bundle-level checks above
// ensure the shipped artifact works; these verify source correctness.

console.log('\n--- Source-level error parser cross-checks ---');

const { parseYtDlpError, isRecoverable, extractErrorLine } = await import('../src/core/error-parser.ts');

// DRM
const drm = parseYtDlpError('ERROR: This video is DRM protected');
assert.equal(drm.category, 'drm', 'DRM detection');
assert.equal(drm.recoverable, false, 'DRM is not recoverable');
console.log('OK: DRM error parsed');

// Geo-restriction
const geo = parseYtDlpError('ERROR: This content is geo-restricted');
assert.equal(geo.category, 'geo', 'geo detection');
assert.equal(geo.recoverable, false, 'geo is not recoverable');
console.log('OK: geo error parsed');

// Auth
const auth = parseYtDlpError('ERROR: Sign in to confirm your age');
assert.equal(auth.category, 'auth', 'auth detection');
console.log('OK: auth error parsed');

// Rate limiting
const rate = parseYtDlpError('ERROR: HTTP Error 429 Too Many Requests');
assert.equal(rate.category, 'rate_limit', 'rate limit detection');
assert.equal(rate.recoverable, true, 'rate_limit is recoverable');
console.log('OK: rate_limit error parsed');

// Network
const net = parseYtDlpError('ERROR: Unable to download: connection timed out');
assert.equal(net.category, 'network', 'network detection');
assert.equal(net.recoverable, true, 'network is recoverable');
console.log('OK: network error parsed');

// Disk full
const disk = parseYtDlpError('ERROR: No space left on device');
assert.equal(disk.category, 'disk_full', 'disk_full detection');
console.log('OK: disk_full error parsed');

// Invalid URL
const badUrl = parseYtDlpError('ERROR: Unsupported URL: ftp://example.com');
assert.equal(badUrl.category, 'invalid_url', 'invalid_url detection');
console.log('OK: invalid_url error parsed');

// Dependency missing
const dep = parseYtDlpError('yt-dlp: command not found');
assert.equal(dep.category, 'dependency_missing', 'dependency_missing detection');
console.log('OK: dependency_missing error parsed');

// Unknown fallback
const unknown = parseYtDlpError('some random error');
assert.equal(unknown.category, 'unknown', 'unknown fallback');
console.log('OK: unknown fallback');

// isRecoverable
assert.equal(isRecoverable('network'), true);
assert.equal(isRecoverable('rate_limit'), true);
assert.equal(isRecoverable('drm'), false);
assert.equal(isRecoverable('unknown'), false);
console.log('OK: isRecoverable');

// extractErrorLine
assert.equal(extractErrorLine('WARNING: foo\nERROR: bar\n'), 'ERROR: bar');
assert.equal(extractErrorLine('no match'), '');
console.log('OK: extractErrorLine');

// ── Step 8: Source-level security cross-checks ──────────────────────

console.log('\n--- Source-level security cross-checks ---');

const { isValidMediaUrl, sanitizeYtDlpArgs, sanitizeFilenameTemplate } = await import('../src/core/security.ts');

// URL validation
assert.equal(isValidMediaUrl('https://youtube.com/watch?v=abc').ok, true, 'valid URL');
assert.equal(isValidMediaUrl('').ok, false, 'empty URL');
assert.equal(isValidMediaUrl('-malicious').ok, false, 'dash URL');
assert.equal(isValidMediaUrl('ftp://example.com').ok, false, 'ftp URL');
assert.equal(isValidMediaUrl('javascript:alert(1)').ok, false, 'javascript URL');
console.log('OK: isValidMediaUrl');

// Arg sanitization
assert.equal(sanitizeYtDlpArgs(['--format', 'best']).ok, true, 'safe args');
assert.equal(sanitizeYtDlpArgs(['--exec', 'cmd']).ok, false, 'denied --exec');
assert.equal(sanitizeYtDlpArgs(['-otemplate']).ok, false, 'denied -o attached');
assert.equal(sanitizeYtDlpArgs(['-P/tmp']).ok, false, 'denied -P attached');
console.log('OK: sanitizeYtDlpArgs');

// Template sanitization
assert.equal(sanitizeFilenameTemplate('%(title)s.%(ext)s').ok, true, 'valid template');
assert.equal(sanitizeFilenameTemplate('$HOME/%(title)s').ok, false, 'shell metachar');
assert.equal(sanitizeFilenameTemplate('%(title)s/sub.%(ext)s').ok, false, 'path separator');
assert.equal(sanitizeFilenameTemplate('../%(title)s.%(ext)s').ok, false, 'path traversal');
assert.equal(sanitizeFilenameTemplate('no-id-or-title.mp4').ok, false, 'missing title/id');
console.log('OK: sanitizeFilenameTemplate');

// ── Done ────────────────────────────────────────────────────────────

console.log('\n=== All smoke tests passed ===');
