/**
 * Unit tests for paths.ts.
 * Run via: tsx src/core/paths.test.ts
 */

import assert from 'node:assert/strict';
import {
    initPaths,
    expandPath,
    validateOutputDir,
    ensureOutputDir,
    archivePathFor,
    tempDirFor,
} from './paths.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
    } catch (e: any) {
        failed++;
        console.error(`FAIL: ${name}`, e.message);
    }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
    } catch (e: any) {
        failed++;
        console.error(`FAIL: ${name}`, e.message);
    }
}

// In the test environment process.env.HOME is available, so initPaths
// will resolve homeDir from it. This matches the runtime probe behavior.
const expectedHome = process.env.HOME ?? null;

(async () => {

    // ── initPaths ──────────────────────────────────────────────────

    const mockCtx: any = {
        fileOps: {
            createDirectory: async (_parentUrl: string, _name: string) => 'file:///created',
        },
    };

    await testAsync('initPaths completes without error', async () => {
        await initPaths(mockCtx);
    });

    // ── expandPath: absolute path unchanged ────────────────────────

    test('expandPath returns absolute path unchanged', () => {
        const result = expandPath('/already/absolute');
        assert.equal(result, '/already/absolute');
    });

    test('expandPath returns path with spaces unchanged', () => {
        const result = expandPath('/Users/me/My Downloads');
        assert.equal(result, '/Users/me/My Downloads');
    });

    // ── expandPath: tilde expansion ───────────────────────────────
    // In test env, process.env.HOME is available so ~ resolves.

    if (expectedHome) {
        test('expandPath with ~/Downloads resolves to home + /Downloads', () => {
            const result = expandPath('~/Downloads');
            assert.equal(result, `${expectedHome}/Downloads`);
        });

        test('expandPath with bare ~ resolves to home directory', () => {
            const result = expandPath('~');
            assert.equal(result, expectedHome);
        });

        test('validateOutputDir with ~/Downloads returns ok:true', () => {
            const result = validateOutputDir('~/Downloads');
            assert.equal(result.ok, true);
            if (result.ok) {
                assert.equal(result.resolved, `${expectedHome}/Downloads`);
            }
        });
    } else {
        // Fallback: no HOME available (sandbox), tilde throws
        test('expandPath with ~ prefix throws home directory not available', () => {
            assert.throws(
                () => expandPath('~/Downloads'),
                { message: /home directory not available/ },
            );
        });

        test('expandPath with bare ~ throws', () => {
            assert.throws(
                () => expandPath('~'),
                { message: /home directory not available/ },
            );
        });

        test('validateOutputDir with ~ returns ok:false (no home dir)', () => {
            const result = validateOutputDir('~/Downloads');
            assert.equal(result.ok, false);
        });
    }

    // ── expandPath: ~otheruser rejected ───────────────────────────

    test('expandPath with ~otheruser throws unsupported tilde syntax', () => {
        assert.throws(
            () => expandPath('~otheruser/Downloads'),
            { message: /unsupported tilde syntax/ },
        );
    });

    // ── validateOutputDir ──────────────────────────────────────────

    test('validateOutputDir with empty string returns ok:false', () => {
        const result = validateOutputDir('');
        assert.equal(result.ok, false);
    });

    test('validateOutputDir with whitespace-only returns ok:false', () => {
        const result = validateOutputDir('   ');
        assert.equal(result.ok, false);
    });

    test('validateOutputDir with absolute path returns ok:true', () => {
        const result = validateOutputDir('/absolute/path');
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.resolved, '/absolute/path');
        }
    });

    test('validateOutputDir with relative path returns ok:false', () => {
        const result = validateOutputDir('relative/path');
        assert.equal(result.ok, false);
    });

    // ── ensureOutputDir ────────────────────────────────────────────

    await testAsync('ensureOutputDir calls createDirectory and returns POSIX path', async () => {
        const calls: Array<{ parentUrl: string; name: string }> = [];
        const spyCtx: any = {
            fileOps: {
                createDirectory: async (parentUrl: string, name: string) => {
                    calls.push({ parentUrl, name });
                    return `${parentUrl}/${name}`;
                },
            },
        };

        const result = await ensureOutputDir(spyCtx, '/Users/test/Downloads');
        assert.equal(result, '/Users/test/Downloads');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'Downloads');
        assert.ok(
            calls[0].parentUrl.startsWith('file:///'),
            `Expected file URL, got: ${calls[0].parentUrl}`,
        );
    });

    await testAsync('ensureOutputDir strips trailing slashes', async () => {
        const calls: Array<{ parentUrl: string; name: string }> = [];
        const spyCtx: any = {
            fileOps: {
                createDirectory: async (parentUrl: string, name: string) => {
                    calls.push({ parentUrl, name });
                    return `${parentUrl}/${name}`;
                },
            },
        };

        const result = await ensureOutputDir(spyCtx, '/Users/test/Downloads/');
        assert.equal(result, '/Users/test/Downloads');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'Downloads');
    });

    await testAsync('ensureOutputDir handles root path as no-op', async () => {
        let called = false;
        const spyCtx: any = {
            fileOps: {
                createDirectory: async () => {
                    called = true;
                    return 'file:///';
                },
            },
        };

        const result = await ensureOutputDir(spyCtx, '/');
        assert.equal(result, '/');
        assert.equal(called, false, 'createDirectory should not be called for root');
    });

    await testAsync('ensureOutputDir normalizes all-slashes to root no-op', async () => {
        let called = false;
        const spyCtx: any = {
            fileOps: {
                createDirectory: async () => { called = true; return 'file:///'; },
            },
        };

        const result = await ensureOutputDir(spyCtx, '///');
        assert.equal(result, '/');
        assert.equal(called, false, 'createDirectory should not be called for all-slash input');
    });

    await testAsync('ensureOutputDir rejects relative path', async () => {
        const spyCtx: any = {
            fileOps: { createDirectory: async () => 'file:///x' },
        };

        try {
            await ensureOutputDir(spyCtx, 'relative/path');
            assert.fail('expected ensureOutputDir to throw for relative path');
        } catch (err: any) {
            assert.ok(err.message.includes('absolute path'), `Expected absolute path error, got: ${err.message}`);
        }
    });

    await testAsync('ensureOutputDir rejects empty string', async () => {
        const spyCtx: any = {
            fileOps: { createDirectory: async () => 'file:///x' },
        };

        try {
            await ensureOutputDir(spyCtx, '');
            assert.fail('expected ensureOutputDir to throw for empty string');
        } catch (err: any) {
            assert.ok(err.message.includes('outputDir'), `Expected outputDir error, got: ${err.message}`);
        }
    });

    // ── archivePathFor ─────────────────────────────────────────────

    test('archivePathFor returns correct path', () => {
        assert.equal(archivePathFor('/out'), '/out/.ytdlp-archive');
    });

    // ── tempDirFor ─────────────────────────────────────────────────

    test('tempDirFor returns correct path', () => {
        assert.equal(tempDirFor('/out'), '/out/.ytdlp-temp');
    });

    // ── Summary ────────────────────────────────────────────────────

    console.log(`\npaths.test: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);

})();
