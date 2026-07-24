/**
 * Tests for shell-with-retry — 9 scenarios covering all retry strategies.
 *
 * Run: tsx src/services/shell-with-retry.test.ts
 */

import assert from 'node:assert/strict';
import { shellWithRetry, buildYtDlpResumeArgs, parseYtDlpPercent } from './shell-with-retry.ts';
import type { ShellExecuteOptions, ShellExecuteResult } from '@appos.space/plugin-types';

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a scripted fake executor from an array of responses. */
function fakeExecutor(responses: ShellExecuteResult[]) {
    let callIndex = 0;
    const calls: ShellExecuteOptions[] = [];
    const executor = async (options: ShellExecuteOptions): Promise<ShellExecuteResult> => {
        calls.push({ ...options });
        if (callIndex >= responses.length) {
            throw new Error(`fakeExecutor: no response for call index ${callIndex}`);
        }
        return responses[callIndex++];
    };
    return { executor, calls };
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err: any) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
    console.log('shell-with-retry tests\n');

    // 1. retry: 'none' → single call
    await test('retry none — single call', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 0, stdout: 'ok', stderr: '' },
        ]);
        const result = await shellWithRetry(executor, { command: 'echo', args: ['hi'] }, { retry: 'none' });
        assert.equal(calls.length, 1);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'ok');
    });

    // 2. retry: 'single' + first-call timeout → two calls, second returned
    await test('retry single — retries once on timeout', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 143, stdout: '', stderr: '' },
            { exitCode: 0, stdout: 'done', stderr: '' },
        ]);
        const result = await shellWithRetry(executor, { command: 'yt-dlp' }, { retry: 'single' });
        assert.equal(calls.length, 2);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'done');
    });

    // 3. retry: 'single' + first-call success → one call
    await test('retry single — no retry on success', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 0, stdout: 'fast', stderr: '' },
        ]);
        const result = await shellWithRetry(executor, { command: 'yt-dlp' }, { retry: 'single' });
        assert.equal(calls.length, 1);
        assert.equal(result.stdout, 'fast');
    });

    // 4. retry: 'progress-aware' + timeouts with increasing percent → loops, eventually exit 0
    await test('progress-aware — loops with advancing progress', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 143, stdout: '[download]  30.0% of 100.0MiB at 5.0MiB/s ETA 00:14', stderr: '' },
            { exitCode: 143, stdout: '[download]  60.0% of 100.0MiB at 5.0MiB/s ETA 00:08', stderr: '' },
            { exitCode: 0, stdout: '[download] 100.0% of 100.0MiB at 5.0MiB/s ETA 00:00', stderr: '' },
        ]);
        const result = await shellWithRetry(
            executor,
            { command: 'yt-dlp' },
            {
                retry: 'progress-aware',
                progressOf: (acc) => parseYtDlpPercent(acc.stdout),
                maxAttempts: 10,
            },
        );
        assert.equal(calls.length, 3);
        assert.equal(result.exitCode, 0);
        assert.ok(result.stdout.includes('30.0%'));
        assert.ok(result.stdout.includes('100.0%'));
    });

    // 5. retry: 'progress-aware' + flat percent → stops at maxStalls
    await test('progress-aware — stops after maxStalls', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 143, stdout: '[download]  10.0% of 50.0MiB at 1.0MiB/s ETA 00:45', stderr: '' },
            { exitCode: 143, stdout: '', stderr: '' },
            { exitCode: 143, stdout: '', stderr: '' },
            { exitCode: 143, stdout: '', stderr: '' },
            { exitCode: 143, stdout: '', stderr: '' }, // should never reach
        ]);
        const result = await shellWithRetry(
            executor,
            { command: 'yt-dlp' },
            {
                retry: 'progress-aware',
                progressOf: (acc) => parseYtDlpPercent(acc.stdout),
                maxStalls: 3,
                maxAttempts: 10,
            },
        );
        // First attempt: progress goes 0 → 0.1 (not a stall)
        // Attempts 2,3,4: progress stays at 0.1 (3 stalls → stop)
        assert.equal(calls.length, 4);
        assert.equal(result.exitCode, 143);
    });

    // 6. retry: 'progress-aware' + non-timeout error → returns immediately
    await test('progress-aware — returns immediately on non-timeout error', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 1, stdout: '', stderr: 'ERROR: Unsupported URL' },
            { exitCode: 0, stdout: 'never', stderr: '' }, // should never reach
        ]);
        const result = await shellWithRetry(
            executor,
            { command: 'yt-dlp' },
            {
                retry: 'progress-aware',
                progressOf: (acc) => parseYtDlpPercent(acc.stdout),
            },
        );
        assert.equal(calls.length, 1);
        assert.equal(result.exitCode, 1);
        assert.ok(result.stderr.includes('Unsupported URL'));
    });

    // 7. onAttempt fires with correct (n, max) values
    await test('onAttempt fires with correct values', async () => {
        const attempts: { n: number; max: number }[] = [];
        const { executor } = fakeExecutor([
            { exitCode: 143, stdout: '[download]  50.0% of 10.0MiB at 1.0MiB/s ETA 00:05', stderr: '' },
            { exitCode: 0, stdout: '[download] 100.0% of 10.0MiB at 1.0MiB/s ETA 00:00', stderr: '' },
        ]);
        await shellWithRetry(
            executor,
            { command: 'yt-dlp' },
            {
                retry: 'progress-aware',
                progressOf: (acc) => parseYtDlpPercent(acc.stdout),
                maxAttempts: 5,
                onAttempt: (n, max) => attempts.push({ n, max }),
            },
        );
        assert.deepEqual(attempts, [
            { n: 1, max: 5 },
            { n: 2, max: 5 },
        ]);
    });

    // 8. Timeout clamping: caller passes timeout: 999, executor receives 119
    await test('timeout clamping — 999 → 119', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 0, stdout: '', stderr: '' },
        ]);
        await shellWithRetry(executor, { command: 'yt-dlp', timeout: 999 }, { retry: 'none' });
        assert.equal(calls[0].timeout, 119);
    });

    // 9. Accumulated buffer cap: 2MB across attempts → stays at 1MB (tail-preserved)
    await test('accumulated buffer cap — tail-preserving 1MB cap', async () => {
        const bigChunk = 'X'.repeat(800_000); // 800KB
        const tailMarker = 'TAIL_MARKER_END';
        const { executor } = fakeExecutor([
            { exitCode: 143, stdout: bigChunk, stderr: '' },
            { exitCode: 143, stdout: bigChunk + tailMarker, stderr: '' },
            { exitCode: 0, stdout: 'final', stderr: '' },
        ]);
        const result = await shellWithRetry(
            executor,
            { command: 'yt-dlp' },
            {
                retry: 'progress-aware',
                progressOf: () => 0.5, // always advancing to avoid stall
                maxAttempts: 10,
            },
        );
        // Total would be ~1.6MB + 'final', but cap is 1MB
        assert.ok(result.stdout.length <= 1024 * 1024, `stdout length ${result.stdout.length} exceeds 1MB`);
        // Tail marker should be preserved (tail-preserving)
        assert.ok(result.stdout.includes(tailMarker), 'tail marker should be preserved');
        assert.ok(result.stdout.includes('final'), 'final chunk should be in output');
    });

    // 10. progress-aware throws when progressOf is missing
    await test('progress-aware — throws without progressOf', async () => {
        const { executor } = fakeExecutor([
            { exitCode: 0, stdout: '', stderr: '' },
        ]);
        await assert.rejects(
            () => shellWithRetry(executor, { command: 'yt-dlp' }, { retry: 'progress-aware' }),
            { message: /progressOf callback is required/ },
        );
    });

    // 11. maxAttempts clamped to 1 when 0
    await test('progress-aware — maxAttempts 0 clamped to 1', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 0, stdout: 'ok', stderr: '' },
        ]);
        const result = await shellWithRetry(
            executor,
            { command: 'yt-dlp' },
            {
                retry: 'progress-aware',
                progressOf: () => 0,
                maxAttempts: 0,
            },
        );
        assert.equal(calls.length, 1);
        assert.equal(result.exitCode, 0);
    });

    // 12. maxStalls clamped to 1 when 0
    await test('progress-aware — maxStalls 0 clamped to 1', async () => {
        const { executor, calls } = fakeExecutor([
            { exitCode: 143, stdout: '', stderr: '' },
            { exitCode: 143, stdout: '', stderr: '' }, // should never reach
        ]);
        const result = await shellWithRetry(
            executor,
            { command: 'yt-dlp' },
            {
                retry: 'progress-aware',
                progressOf: () => 0,
                maxStalls: 0,
                maxAttempts: 10,
            },
        );
        // maxStalls clamped to 1 — one stall then stop
        assert.equal(calls.length, 1);
        assert.equal(result.exitCode, 143);
    });

    // ── yt-dlp convenience tests ───────────────────────────────────────

    console.log('\nyt-dlp convenience tests\n');

    await test('buildYtDlpResumeArgs appends flags', async () => {
        const args = buildYtDlpResumeArgs(['--format', 'best', 'https://example.com'], { archivePath: '/tmp/archive.txt' });
        assert.ok(args.includes('--continue'));
        assert.ok(args.includes('--download-archive'));
        assert.ok(args.includes('/tmp/archive.txt'));
    });

    await test('buildYtDlpResumeArgs is idempotent', async () => {
        const first = buildYtDlpResumeArgs(['--format', 'best'], { archivePath: '/tmp/a.txt' });
        const second = buildYtDlpResumeArgs(first, { archivePath: '/tmp/a.txt' });
        assert.deepEqual(first, second);
    });

    await test('parseYtDlpPercent extracts last match', async () => {
        const output = [
            '[download]  10.0% of 100.0MiB at 5.0MiB/s ETA 00:18',
            '[download]  45.5% of 100.0MiB at 5.0MiB/s ETA 00:11',
        ].join('\n');
        const pct = parseYtDlpPercent(output);
        assert.ok(Math.abs(pct - 0.455) < 0.001, `expected ~0.455, got ${pct}`);
    });

    await test('parseYtDlpPercent returns 0 on no match', async () => {
        assert.equal(parseYtDlpPercent('no progress here'), 0);
    });

    // ── Summary ────────────────────────────────────────────────────────

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main();
