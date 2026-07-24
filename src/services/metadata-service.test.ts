/**
 * Tests for metadata-service.ts — probeUrl function.
 *
 * Runs via `tsx`. Uses a fake `ctx` with stub `shell.execute`, `settings`,
 * and `fileOps` to test all ProbeResult branches without hitting the network.
 *
 * @module metadata-service.test
 */

import assert from 'node:assert/strict';
import { probeUrl } from './metadata-service';
import { initPaths } from '../core/paths';

// ── Helpers ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err}`);
    }
}

/** Build a fake PluginContext with configurable shell.execute stub. */
function makeCtx(
    shellStub: (...args: unknown[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
    overrides: { outputDir?: string } = {},
) {
    return {
        shell: { execute: shellStub },
        settings: {
            get(key: string) {
                if (key === 'outputDir') return overrides.outputDir ?? '/tmp/ytdlp-test';
                return '';
            },
        },
        fileOps: {
            createDirectory: async () => {},
        },
    };
}

/** Canned yt-dlp --dump-json output for a normal video. */
const CANNED_VIDEO_JSON = JSON.stringify({
    id: 'abc123',
    title: 'Test Video',
    webpage_url: 'https://www.youtube.com/watch?v=abc123',
    thumbnail: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg',
    duration: 120,
    uploader: 'TestChannel',
    channel: 'TestChannel',
    upload_date: '20240101',
    description: 'A test video',
    view_count: 1000,
    like_count: 50,
    formats: [
        {
            format_id: '22',
            ext: 'mp4',
            height: 720,
            fps: 30,
            vcodec: 'avc1.64001F',
            acodec: 'mp4a.40.2',
            filesize: 50000000,
            filesize_approx: null,
            tbr: 2500,
            abr: 128,
        },
    ],
    playlist_index: null,
    playlist_title: null,
});

/** Canned yt-dlp JSON for a playlist-type response. */
const CANNED_PLAYLIST_JSON = JSON.stringify({
    _type: 'playlist',
    id: 'PLtest',
    title: 'Test Playlist',
    webpage_url: 'https://www.youtube.com/playlist?list=PLtest',
    playlist_count: 12,
    entries: [],
});

// ── Main ──────────────────────────────────────────────────────────

(async () => {
    // initPaths needs to run before validateOutputDir / expandPath work.
    await initPaths({ fileOps: {} } as never);

    console.log('metadata-service tests\n');

    // 1. Normal video URL → { kind: 'video' } + assert shell args
    await test('normal video URL returns video branch with correct shell args', async () => {
        let capturedOpts: Record<string, unknown> | null = null;
        const shellStub = async (opts: Record<string, unknown>) => {
            capturedOpts = opts;
            return { exitCode: 0, stdout: CANNED_VIDEO_JSON, stderr: '' };
        };
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'https://www.youtube.com/watch?v=abc123');

        assert.equal(result.kind, 'video');
        if (result.kind === 'video') {
            assert.equal(result.metadata.id, 'abc123');
            assert.equal(result.metadata.title, 'Test Video');
            assert.equal(result.metadata.url, 'https://www.youtube.com/watch?v=abc123');
            assert.equal(result.formats.length, 1);
            assert.equal(result.formats[0].formatId, '22');
            assert.equal(result.formats[0].label, '720p mp4');
        }

        // Assert shell was called with options-object (not positional args)
        assert.ok(capturedOpts, 'shell.execute should have been called');
        assert.equal(capturedOpts!.command, 'yt-dlp');
        assert.equal(capturedOpts!.timeout, 30);
        assert.equal(capturedOpts!.cwd, '/tmp/ytdlp-test');
        const args = capturedOpts!.args as string[];
        assert.ok(args.includes('--ignore-config'), 'args must include --ignore-config');
        assert.ok(args.includes('--dump-json'), 'args must include --dump-json');
        assert.ok(args.includes('--no-playlist'), 'args must include --no-playlist');
        assert.ok(args.includes('--skip-download'), 'args must include --skip-download');
        assert.ok(args.includes('https://www.youtube.com/watch?v=abc123'), 'args must include the URL');
    });

    // 2. list= without v= → { kind: 'playlist' } with NO CLI call
    await test('YouTube list= without v= returns playlist (no CLI call)', async () => {
        let shellCalled = false;
        const shellStub = async () => { shellCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; };
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'https://www.youtube.com/playlist?list=PLtest123');

        assert.equal(result.kind, 'playlist');
        assert.equal(shellCalled, false, 'Shell should NOT have been called for heuristic playlist');
        if (result.kind === 'playlist') {
            assert.equal(result.estimatedCount, -1);
            assert.ok(result.playlistUrl.includes('PLtest123'));
        }
    });

    // 3. list= AND v= (ambiguous) → spawns yt-dlp, returns video branch
    await test('YouTube list= + v= (ambiguous) spawns yt-dlp, returns video', async () => {
        let shellCalled = false;
        const shellStub = async () => {
            shellCalled = true;
            return { exitCode: 0, stdout: CANNED_VIDEO_JSON, stderr: '' };
        };
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(
            ctx as never,
            'https://www.youtube.com/watch?v=abc123&list=PLtest',
        );

        assert.equal(shellCalled, true, 'Shell SHOULD have been called for ambiguous URL');
        assert.equal(result.kind, 'video');
    });

    // 4. Malformed JSON → { kind: 'error', category: 'unknown' }
    await test('malformed JSON returns error with category unknown', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: 'NOT JSON {{{', stderr: '' });
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'https://example.com/video');

        assert.equal(result.kind, 'error');
        if (result.kind === 'error') {
            assert.equal(result.error.category, 'unknown');
            assert.ok(result.error.message.includes('JSON'));
        }
    });

    // 5. yt-dlp DRM stderr → { kind: 'error', category: 'drm' }
    await test('DRM stderr returns error with category drm', async () => {
        const shellStub = async () => ({
            exitCode: 1,
            stdout: '',
            stderr: 'ERROR: This video is DRM protected and cannot be downloaded',
        });
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'https://example.com/drm-video');

        assert.equal(result.kind, 'error');
        if (result.kind === 'error') {
            assert.equal(result.error.category, 'drm');
        }
    });

    // 6. file:// URL → { kind: 'error', category: 'invalid_url' } with NO CLI call
    await test('file:// URL returns invalid_url error (no CLI call)', async () => {
        let shellCalled = false;
        const shellStub = async () => { shellCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; };
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'file:///etc/passwd');

        assert.equal(result.kind, 'error');
        if (result.kind === 'error') {
            assert.equal(result.error.category, 'invalid_url');
        }
        assert.equal(shellCalled, false, 'Shell should NOT have been called for file:// URL');
    });

    // 7. _type === 'playlist' in JSON response → playlist branch
    await test('_type=playlist in JSON returns playlist branch via yt-dlp', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_PLAYLIST_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'https://example.com/some-playlist');

        assert.equal(result.kind, 'playlist');
        if (result.kind === 'playlist') {
            assert.equal(result.estimatedCount, 12);
        }
    });

    // 8. Invalid outputDir → error without CLI call
    await test('empty outputDir returns error without CLI call', async () => {
        let shellCalled = false;
        const shellStub = async () => { shellCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; };
        const ctx = makeCtx(shellStub, { outputDir: '' });
        const result = await probeUrl(ctx as never, 'https://example.com/video');

        assert.equal(result.kind, 'error');
        if (result.kind === 'error') {
            assert.ok(result.error.message.includes('outputDir'));
        }
        assert.equal(shellCalled, false, 'Shell should NOT have been called with invalid outputDir');
    });

    // 9. Non-YouTube playlist patterns (Twitch, Vimeo, SoundCloud)
    await test('non-YouTube playlist patterns detected', async () => {
        const urls = [
            'https://www.twitch.tv/someuser/videos',
            'https://vimeo.com/channels/staffpicks',
            'https://soundcloud.com/artist/sets/albumname',
        ];
        for (const testUrl of urls) {
            let shellCalled = false;
            const shellStub = async () => { shellCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; };
            const ctx = makeCtx(shellStub);
            const result = await probeUrl(ctx as never, testUrl);
            assert.equal(result.kind, 'playlist', `Expected playlist for ${testUrl}`);
            assert.equal(shellCalled, false, `Shell should NOT be called for ${testUrl}`);
        }
    });

    // 10. youtu.be/<id>?list=... is NOT treated as playlist (ambiguous — spawns yt-dlp)
    await test('youtu.be/<id>?list= is ambiguous, spawns yt-dlp', async () => {
        let shellCalled = false;
        const shellStub = async () => {
            shellCalled = true;
            return { exitCode: 0, stdout: CANNED_VIDEO_JSON, stderr: '' };
        };
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'https://youtu.be/abc123?list=PLtest');

        assert.equal(shellCalled, true, 'Shell SHOULD be called for youtu.be/<id>?list=');
        assert.equal(result.kind, 'video');
    });

    // 11. /shorts/<id>?list=... is NOT treated as playlist (ambiguous)
    await test('YouTube /shorts/<id>?list= is ambiguous, spawns yt-dlp', async () => {
        let shellCalled = false;
        const shellStub = async () => {
            shellCalled = true;
            return { exitCode: 0, stdout: CANNED_VIDEO_JSON, stderr: '' };
        };
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(ctx as never, 'https://www.youtube.com/shorts/abc123?list=PLtest');

        assert.equal(shellCalled, true, 'Shell SHOULD be called for /shorts/<id>?list=');
        assert.equal(result.kind, 'video');
    });

    // 12. Non-YouTube playlist false positive prevention (redirect URL in query)
    await test('redirect URL containing playlist host is NOT a false positive', async () => {
        let shellCalled = false;
        const shellStub = async () => {
            shellCalled = true;
            return { exitCode: 0, stdout: CANNED_VIDEO_JSON, stderr: '' };
        };
        const ctx = makeCtx(shellStub);
        const result = await probeUrl(
            ctx as never,
            'https://example.com/redirect?next=https://soundcloud.com/a/sets/b',
        );

        // Should NOT match SoundCloud pattern — the hostname is example.com
        assert.equal(shellCalled, true, 'Shell SHOULD be called (not a real SoundCloud URL)');
        assert.equal(result.kind, 'video');
    });

    // Summary
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
})();
