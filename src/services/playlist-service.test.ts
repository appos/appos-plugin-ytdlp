/**
 * Tests for playlist-service.ts — probePlaylist and PlaylistSelection.
 *
 * Runs via `tsx`. Uses a fake `ctx` with stub `shell.execute`, `settings`,
 * and `fileOps` to test all PlaylistProbeOutcome branches without hitting
 * the network. Also exercises the PlaylistSelection class.
 *
 * @module playlist-service.test
 */

import assert from 'node:assert/strict';
import { probePlaylist, PlaylistSelection } from './playlist-service';
import { initPaths } from '../core/paths';

// ── Helpers ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  \u2713 ${name}`);
    } catch (err) {
        failed++;
        console.error(`  \u2717 ${name}`);
        console.error(`    ${err}`);
    }
}

/** Build a fake PluginContext with configurable shell.execute stub. */
function makeCtx(shellStub, overrides = {}) {
    return {
        shell: { execute: shellStub },
        settings: {
            get(key) {
                if (key === 'outputDir') return overrides.outputDir ?? '/tmp/ytdlp-test';
                return '';
            },
        },
        fileOps: {
            createDirectory: async () => {},
        },
    };
}

// ── Canned JSON ──────────────────────────────────────────────────

/** Normal YouTube playlist with entries. */
const CANNED_PLAYLIST_JSON = JSON.stringify({
    id: 'PLabc123',
    title: 'My Favorite Videos',
    uploader: 'TestUser',
    playlist_count: 3,
    entries: [
        {
            id: 'vid1',
            url: 'vid1',
            webpage_url: 'https://www.youtube.com/watch?v=vid1',
            title: 'Video One',
            duration: 120,
            ie_key: 'Youtube',
        },
        {
            id: 'vid2',
            url: 'vid2',
            webpage_url: 'https://www.youtube.com/watch?v=vid2',
            title: 'Video Two',
            duration: 240,
            ie_key: 'Youtube',
        },
        {
            id: 'vid3',
            url: 'vid3',
            webpage_url: 'https://www.youtube.com/watch?v=vid3',
            title: 'Video Three',
            ie_key: 'Youtube',
        },
    ],
});

/** Empty playlist. */
const CANNED_EMPTY_PLAYLIST_JSON = JSON.stringify({
    id: 'PLempty',
    title: 'Empty Playlist',
    playlist_count: 0,
    entries: [],
});

/** Playlist with missing title (yt-dlp issue #11234). */
const CANNED_NO_TITLE_JSON = JSON.stringify({
    id: 'PLnotitle',
    playlist_count: 1,
    entries: [{ id: 'x1', url: 'x1', title: 'Entry', ie_key: 'Youtube' }],
});

/** Playlist with bare-id URLs (YouTube ie_key). */
const CANNED_BARE_ID_YOUTUBE_JSON = JSON.stringify({
    id: 'PLbare',
    title: 'Bare IDs',
    playlist_count: 2,
    entries: [
        { id: 'abc123', url: 'abc123', ie_key: 'Youtube', title: 'YT bare' },
        { id: '12345', url: '12345', ie_key: 'Vimeo', title: 'Vimeo bare' },
    ],
});

/** Playlist with null entries (deleted/unavailable videos). */
const CANNED_NULL_ENTRIES_JSON = JSON.stringify({
    id: 'PLnulls',
    title: 'Has Nulls',
    playlist_count: 3,
    entries: [
        { id: 'ok1', url: 'ok1', webpage_url: 'https://www.youtube.com/watch?v=ok1', title: 'OK', ie_key: 'Youtube' },
        null,
        { id: 'ok2', url: 'ok2', webpage_url: 'https://www.youtube.com/watch?v=ok2', title: 'Also OK', ie_key: 'Youtube' },
    ],
});

/** Playlist where entry.url is a full URL but webpage_url is missing. */
const CANNED_FULL_URL_IN_URL_FIELD_JSON = JSON.stringify({
    id: 'PLfull',
    title: 'Full URLs',
    playlist_count: 1,
    entries: [
        { id: 'vid1', url: 'https://example.com/video/vid1', title: 'Full URL entry' },
    ],
});

/** Playlist with duplicate video IDs. */
const CANNED_DUPLICATE_IDS_JSON = JSON.stringify({
    id: 'PLdupes',
    title: 'Duplicates',
    playlist_count: 3,
    entries: [
        { id: 'same', url: 'same', webpage_url: 'https://www.youtube.com/watch?v=same', title: 'First', ie_key: 'Youtube' },
        { id: 'unique', url: 'unique', webpage_url: 'https://www.youtube.com/watch?v=unique', title: 'Middle', ie_key: 'Youtube' },
        { id: 'same', url: 'same', webpage_url: 'https://www.youtube.com/watch?v=same', title: 'First Again', ie_key: 'Youtube' },
    ],
});

/** Playlist with bare ID in url field only (no id field), known extractor. */
const CANNED_NO_ID_FIELD_KNOWN_EXTRACTOR_JSON = JSON.stringify({
    id: 'PLnoid',
    title: 'No ID Field',
    playlist_count: 1,
    entries: [
        { url: 'abc123', ie_key: 'Youtube', title: 'ID only in url' },
    ],
});

/** Playlist with bare-id URLs for unknown ie_key → unresolved. */
const CANNED_UNKNOWN_EXTRACTOR_JSON = JSON.stringify({
    id: 'PLunknown',
    title: 'Unknown Extractor',
    playlist_count: 1,
    entries: [
        { id: 'xyz789', url: 'xyz789', ie_key: 'SomeObscureSite', title: 'Unknown entry' },
    ],
});

// ── Main ──────────────────────────────────────────────────────────

(async () => {
    // initPaths needs to run before validateOutputDir / expandPath work.
    await initPaths({ fileOps: {} });

    console.log('playlist-service tests\n');

    // ── probePlaylist tests ──────────────────────────────────────

    // 1. Normal YouTube playlist → { kind: 'ok' } with correct groupTag format
    await test('normal playlist returns ok with correct fields and groupTag', async () => {
        let capturedOpts = null;
        const shellStub = async (opts) => {
            capturedOpts = opts;
            return { exitCode: 0, stdout: CANNED_PLAYLIST_JSON, stderr: '' };
        };
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://www.youtube.com/playlist?list=PLabc123');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            const r = outcome.result;
            assert.equal(r.playlistId, 'PLabc123');
            assert.equal(r.playlistTitle, 'My Favorite Videos');
            assert.equal(r.uploader, 'TestUser');
            assert.equal(r.totalCount, 3);
            assert.equal(r.fetchedCount, 3);
            assert.equal(r.entries.length, 3);
            assert.equal(r.entries[0].id, 'vid1');
            assert.equal(r.entries[0].url, 'https://www.youtube.com/watch?v=vid1');
            assert.equal(r.entries[0].title, 'Video One');
            assert.equal(r.entries[0].duration, 120);
            assert.equal(r.entries[0].selectionKey, 'vid1:0');
            assert.equal(r.entries[1].selectionKey, 'vid2:1');
            assert.equal(r.entries[2].duration, undefined);
            assert.ok(r.groupTag.startsWith('playlist:PLabc123:'));
            assert.equal(r.groupLabel, 'Playlist: My Favorite Videos');
        }

        // Verify shell args
        assert.ok(capturedOpts, 'shell.execute should have been called');
        assert.equal(capturedOpts.command, 'yt-dlp');
        assert.equal(capturedOpts.timeout, 60);
        const args = capturedOpts.args;
        assert.ok(args.includes('--ignore-config'));
        assert.ok(args.includes('--dump-single-json'));
        assert.ok(args.includes('--flat-playlist'));
        assert.ok(args.includes('--no-warnings'));
        assert.ok(args.includes('--playlist-end'));
        assert.ok(args.includes('500'), 'default maxEntries should be 500');
    });

    // 2. Empty playlist → ok with entries: []
    await test('empty playlist returns ok with entries: []', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_EMPTY_PLAYLIST_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://www.youtube.com/playlist?list=PLempty');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            assert.equal(outcome.result.entries.length, 0);
            assert.equal(outcome.result.fetchedCount, 0);
        }
    });

    // 3. Missing title field → fallback to id
    await test('missing title falls back to id', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_NO_TITLE_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://www.youtube.com/playlist?list=PLnotitle');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            assert.equal(outcome.result.playlistTitle, 'PLnotitle');
            assert.equal(outcome.result.groupLabel, 'Playlist: PLnotitle');
        }
    });

    // 4. Entries with bare-id URLs (YouTube/Vimeo) → normalized full URLs
    await test('bare-id URLs for known extractors are normalized', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_BARE_ID_YOUTUBE_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://www.youtube.com/playlist?list=PLbare');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            assert.equal(outcome.result.entries[0].url, 'https://www.youtube.com/watch?v=abc123');
            assert.equal(outcome.result.entries[0].unresolved, undefined);
            assert.equal(outcome.result.entries[1].url, 'https://vimeo.com/12345');
            assert.equal(outcome.result.entries[1].unresolved, undefined);
        }
    });

    // 5. Entries with bare-id URLs for unknown ie_key → unresolved: true
    await test('bare-id URLs for unknown extractor set unresolved: true', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_UNKNOWN_EXTRACTOR_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://example.com/playlist/PLunknown');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            assert.equal(outcome.result.entries[0].url, 'xyz789');
            assert.equal(outcome.result.entries[0].unresolved, true);
        }
    });

    // 6. Malformed JSON → error with category 'unknown'
    await test('malformed JSON returns error with category unknown', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: 'NOT JSON {{{', stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://example.com/playlist/test');

        assert.equal(outcome.kind, 'error');
        if (outcome.kind === 'error') {
            assert.equal(outcome.error.category, 'unknown');
            assert.ok(outcome.error.message.includes('JSON'));
        }
    });

    // 7. Non-zero exit → error via parseYtDlpError
    await test('non-zero exit returns error via parseYtDlpError', async () => {
        const shellStub = async () => ({
            exitCode: 1,
            stdout: '',
            stderr: 'ERROR: This video is DRM protected and cannot be downloaded',
        });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://example.com/playlist/drm');

        assert.equal(outcome.kind, 'error');
        if (outcome.kind === 'error') {
            assert.equal(outcome.error.category, 'drm');
        }
    });

    // 8. Invalid URL → error without CLI call
    await test('invalid URL returns error without CLI call', async () => {
        let shellCalled = false;
        const shellStub = async () => { shellCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; };
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'file:///etc/passwd');

        assert.equal(outcome.kind, 'error');
        if (outcome.kind === 'error') {
            assert.equal(outcome.error.category, 'invalid_url');
        }
        assert.equal(shellCalled, false);
    });

    // 9. Empty outputDir → error without CLI call
    await test('empty outputDir returns error without CLI call', async () => {
        let shellCalled = false;
        const shellStub = async () => { shellCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; };
        const ctx = makeCtx(shellStub, { outputDir: '' });
        const outcome = await probePlaylist(ctx, 'https://example.com/playlist/test');

        assert.equal(outcome.kind, 'error');
        if (outcome.kind === 'error') {
            assert.ok(outcome.error.message.includes('outputDir'));
        }
        assert.equal(shellCalled, false);
    });

    // 10. Custom maxEntries passed through to --playlist-end
    await test('custom maxEntries passed to --playlist-end', async () => {
        let capturedOpts = null;
        const shellStub = async (opts) => {
            capturedOpts = opts;
            return { exitCode: 0, stdout: CANNED_EMPTY_PLAYLIST_JSON, stderr: '' };
        };
        const ctx = makeCtx(shellStub);
        await probePlaylist(ctx, 'https://example.com/playlist/test', { maxEntries: 50 });

        assert.ok(capturedOpts);
        const args = capturedOpts.args;
        const endIdx = args.indexOf('--playlist-end');
        assert.ok(endIdx >= 0);
        assert.equal(args[endIdx + 1], '50');
    });

    // 11. Null entries in playlist JSON are filtered out
    await test('null entries in playlist JSON are filtered out', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_NULL_ENTRIES_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://www.youtube.com/playlist?list=PLnulls');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            assert.equal(outcome.result.entries.length, 2);
            assert.equal(outcome.result.entries[0].id, 'ok1');
            assert.equal(outcome.result.entries[1].id, 'ok2');
        }
    });

    // 12. entry.url is a full URL (no webpage_url) → resolved without synthesis
    await test('entry.url with full URL is used directly (not synthesized)', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_FULL_URL_IN_URL_FIELD_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://example.com/playlist/PLfull');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            assert.equal(outcome.result.entries[0].url, 'https://example.com/video/vid1');
            assert.equal(outcome.result.entries[0].unresolved, undefined);
        }
    });

    // 13. Duplicate video IDs get unique selectionKeys
    await test('duplicate video IDs produce unique selectionKeys', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_DUPLICATE_IDS_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://www.youtube.com/playlist?list=PLdupes');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            const entries = outcome.result.entries;
            assert.equal(entries.length, 3);
            assert.equal(entries[0].id, 'same');
            assert.equal(entries[2].id, 'same');
            // selectionKeys must be unique even for duplicate media IDs
            assert.equal(entries[0].selectionKey, 'same:0');
            assert.equal(entries[1].selectionKey, 'unique:1');
            assert.equal(entries[2].selectionKey, 'same:2');
            assert.notEqual(entries[0].selectionKey, entries[2].selectionKey);

            // PlaylistSelection should track each occurrence independently
            const sel = new PlaylistSelection(entries.map(e => e.selectionKey));
            assert.equal(sel.getSelectedCount(), 3);
            sel.toggle(entries[0].selectionKey);
            assert.equal(sel.isSelected(entries[0].selectionKey), false);
            assert.equal(sel.isSelected(entries[2].selectionKey), true); // other 'same' still selected
            assert.equal(sel.getSelectedCount(), 2);
        }
    });

    // 14. Known extractor entry with bare ID only in url field (no id field)
    await test('known extractor with bare ID in url (no id field) synthesizes URL', async () => {
        const shellStub = async () => ({ exitCode: 0, stdout: CANNED_NO_ID_FIELD_KNOWN_EXTRACTOR_JSON, stderr: '' });
        const ctx = makeCtx(shellStub);
        const outcome = await probePlaylist(ctx, 'https://www.youtube.com/playlist?list=PLnoid');

        assert.equal(outcome.kind, 'ok');
        if (outcome.kind === 'ok') {
            assert.equal(outcome.result.entries[0].url, 'https://www.youtube.com/watch?v=abc123');
            assert.equal(outcome.result.entries[0].unresolved, undefined);
        }
    });

    // ── PlaylistSelection tests ─────────────────────────────────

    console.log('\nPlaylistSelection tests\n');

    // 15. Constructor selects all
    await test('constructor selects all entries', async () => {
        const sel = new PlaylistSelection(['a', 'b', 'c']);
        assert.equal(sel.getSelectedCount(), 3);
        assert.deepEqual(sel.getSelectedIds(), ['a', 'b', 'c']);
    });

    // 12. toggle
    await test('toggle deselects then reselects', async () => {
        const sel = new PlaylistSelection(['a', 'b', 'c']);
        sel.toggle('b');
        assert.equal(sel.isSelected('b'), false);
        assert.equal(sel.getSelectedCount(), 2);
        assert.deepEqual(sel.getSelectedIds(), ['a', 'c']);

        sel.toggle('b');
        assert.equal(sel.isSelected('b'), true);
        assert.equal(sel.getSelectedCount(), 3);
    });

    // 13. deselectAll then selectAll
    await test('deselectAll then selectAll', async () => {
        const sel = new PlaylistSelection(['a', 'b', 'c']);
        sel.deselectAll();
        assert.equal(sel.getSelectedCount(), 0);
        assert.deepEqual(sel.getSelectedIds(), []);

        sel.selectAll();
        assert.equal(sel.getSelectedCount(), 3);
        assert.deepEqual(sel.getSelectedIds(), ['a', 'b', 'c']);
    });

    // 14. setSelected
    await test('setSelected replaces selection', async () => {
        const sel = new PlaylistSelection(['a', 'b', 'c', 'd']);
        sel.setSelected(['b', 'd']);
        assert.equal(sel.getSelectedCount(), 2);
        assert.deepEqual(sel.getSelectedIds(), ['b', 'd']);
        assert.equal(sel.isSelected('a'), false);
        assert.equal(sel.isSelected('b'), true);
    });

    // 15. isSelected for non-existent id
    await test('isSelected returns false for unknown ids', async () => {
        const sel = new PlaylistSelection(['a']);
        assert.equal(sel.isSelected('z'), false);
    });

    // 16. getSelectedIds preserves original order
    await test('getSelectedIds preserves original order', async () => {
        const sel = new PlaylistSelection(['c', 'a', 'b']);
        sel.deselectAll();
        sel.toggle('b');
        sel.toggle('c');
        // Order should match allIds: c, b (not toggle order)
        assert.deepEqual(sel.getSelectedIds(), ['c', 'b']);
    });

    // 17. toggle ignores unknown IDs
    await test('toggle ignores unknown IDs', async () => {
        const sel = new PlaylistSelection(['a', 'b']);
        sel.toggle('z'); // unknown — should be ignored
        assert.equal(sel.getSelectedCount(), 2);
        assert.deepEqual(sel.getSelectedIds(), ['a', 'b']);
    });

    // 18. setSelected ignores unknown IDs
    await test('setSelected ignores unknown IDs', async () => {
        const sel = new PlaylistSelection(['a', 'b', 'c']);
        sel.setSelected(['a', 'z', 'c']);
        assert.equal(sel.getSelectedCount(), 2);
        assert.deepEqual(sel.getSelectedIds(), ['a', 'c']);
    });

    // Summary
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
})();
