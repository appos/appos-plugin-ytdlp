/**
 * Unit tests for state.ts.
 * Run via: tsx src/core/state.test.ts
 */

import assert from 'node:assert/strict';
import {
    initState,
    getState,
    getQueue,
    getLibrary,
    enqueue,
    updateQueueEntry,
    removeQueueEntry,
    addToLibrary,
    removeFromLibrary,
    toggleFavorite,
    addToHistory,
    subscribe,
    registerPanelForBroadcast,
    broadcastToWebPanels,
    flushPersistedState,
    isFirstRun,
    markFirstRunComplete,
    setDependencyStatuses,
    getDependencyStatuses,
    isYtDlpAvailable,
    isFfmpegAvailable,
    getSettingsSnapshot,
    emitStateUpdate,
} from './state.ts';

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

/** Small delay helper for debounce tests. */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Mock ctx factory ───────────────────────────────────────────────

function createMockCtx(initial: Record<string, unknown> = {}): any {
    const store = new Map(Object.entries(initial));
    const postCalls: Array<{ panelId: string; message: unknown }> = [];
    const settingsMap = new Map<string, unknown>([
        ['outputDir', '/tmp/downloads'],
        ['proxyUrl', ''],
        ['filenameTemplate', '%(title)s.%(ext)s'],
        ['defaultFormat', 'best'],
        ['defaultQuality', '1080p'],
        ['metadataDepth', 'basic'],
    ]);

    return {
        cache: {
            get: async (key: string) => store.get(key) ?? null,
            set: async (key: string, value: unknown, _opts?: unknown) => {
                store.set(key, value);
                return true as const;
            },
            remove: async (key: string) => { store.delete(key); return true as const; },
            has: async (key: string) => store.has(key),
            keys: async () => [...store.keys()],
            clear: async () => { store.clear(); return true as const; },
        },
        ui: {
            postToWebPanel: (panelId: string, message: unknown) => {
                postCalls.push({ panelId, message });
            },
        },
        settings: {
            get: (key: string) => settingsMap.get(key) ?? null,
            onChange: () => 'token-1',
        },
        _store: store,
        _postCalls: postCalls,
    };
}

// ── Queue entry helper ─────────────────────────────────────────────

function makeQueueFields(url: string): any {
    return {
        url,
        status: 'queued',
        progress: 0,
        speed: null,
        eta: null,
        errorCode: null,
        errorMessage: null,
        groupTag: null,
        groupLabel: null,
        attempt: 0,
        lastKnownPercent: null,
        createdAt: new Date().toISOString(),
        finalFilePath: null,
        finalFileUrl: null,
        libraryId: null,
        request: {
            format: 'best',
            quality: 'best',
            outputDir: '/tmp',
            filenameTemplate: '%(title)s.%(ext)s',
            archivePath: '/tmp/.ytdlp-archive',
            tempDir: '/tmp/.ytdlp-temp',
        },
    };
}

// ── Run all tests in an async IIFE ─────────────────────────────────

(async () => {

    // ── Test: initState loads four shards in parallel ──────────────

    await testAsync('initState loads three mutable shards in parallel (initialized is lazy)', async () => {
        const ctx = createMockCtx({
            'ytdlp:queue': [
                { id: 'q1', url: 'https://example.com', status: 'queued', progress: 0, request: { format: 'best', quality: 'best', outputDir: '/tmp', filenameTemplate: '%(title)s.%(ext)s', archivePath: '/tmp/.ytdlp-archive', tempDir: '/tmp/.ytdlp-temp' } },
            ],
            'ytdlp:library': [
                { id: 'l1', sourceUrl: 'https://example.com', fileUrl: 'file:///tmp/test.mp4', filePath: '/tmp/test.mp4', title: 'Test', favorite: false },
            ],
            'ytdlp:history': ['https://example.com'],
        });

        await initState(ctx);

        assert.equal(getQueue().length, 1);
        assert.equal(getLibrary().length, 1);
        // Library entries missing 'request' get it backfilled from filePath
        const libReq = getLibrary()[0].request;
        assert.ok(libReq != null, 'library entry has backfilled request');
        assert.equal(libReq.outputDir, '/tmp', 'outputDir derived from filePath parent dir');
        assert.equal(libReq.archivePath, '/tmp/.ytdlp-archive', 'archivePath follows canonical layout');
        assert.equal(libReq.tempDir, '/tmp/.ytdlp-temp', 'tempDir follows canonical layout');
        assert.equal(getState().history.length, 1);
    });

    // ── Test: downloading entries transition to paused on load ─────

    await testAsync('downloading entries transition to paused on load', async () => {
        const reqSnap = { format: 'best', quality: 'best', outputDir: '/tmp', filenameTemplate: '%(title)s.%(ext)s', archivePath: '/tmp/.ytdlp-archive', tempDir: '/tmp/.ytdlp-temp' };
        const ctx = createMockCtx({
            'ytdlp:queue': [
                { id: 'q1', url: 'https://a.com', status: 'downloading', progress: 50, request: reqSnap },
                { id: 'q2', url: 'https://b.com', status: 'queued', progress: 0, request: reqSnap },
                { id: 'q3', url: 'https://c.com', status: 'downloading', progress: 75, request: reqSnap },
            ],
        });

        await initState(ctx);

        const q = getQueue();
        assert.equal(q[0].status, 'paused');
        assert.equal(q[1].status, 'queued');
        assert.equal(q[2].status, 'paused');
    });

    // ── Test: stale queue entries without request are dropped ─────

    await testAsync('stale queue entries missing request snapshot are dropped on load', async () => {
        const ctx = createMockCtx({
            'ytdlp:queue': [
                { id: 'old1', url: 'https://old.com', status: 'queued', progress: 0 },
                { id: 'new1', url: 'https://new.com', status: 'queued', progress: 0, request: { format: 'best', quality: 'best', outputDir: '/tmp', filenameTemplate: '%(title)s.%(ext)s', archivePath: '/tmp/.ytdlp-archive', tempDir: '/tmp/.ytdlp-temp' } },
            ],
        });

        await initState(ctx);

        const q = getQueue();
        assert.equal(q.length, 1, 'only valid entry survives migration');
        assert.equal(q[0].id, 'new1');
    });

    // ── Test: stale library entries missing required fields are dropped ─

    await testAsync('stale library entries missing filePath/fileUrl/sourceUrl are dropped', async () => {
        const ctx = createMockCtx({
            'ytdlp:library': [
                { id: 'old-lib', title: 'No paths' },
                { id: 'good-lib', sourceUrl: 'https://example.com', fileUrl: 'file:///tmp/test.mp4', filePath: '/tmp/test.mp4', title: 'Good', favorite: false },
            ],
        });

        await initState(ctx);

        const lib = getLibrary();
        assert.equal(lib.length, 1, 'only valid library entry survives');
        assert.equal(lib[0].id, 'good-lib');
    });

    // ── Test: queue entries with ~/relative outputDir are dropped ──

    await testAsync('queue entries with tilde or relative outputDir are dropped', async () => {
        const ctx = createMockCtx({
            'ytdlp:queue': [
                { id: 'tilde', url: 'https://t.com', status: 'queued', progress: 0, request: { format: 'best', quality: 'best', outputDir: '~/Downloads', filenameTemplate: '%(title)s.%(ext)s', archivePath: '~/Downloads/.ytdlp-archive', tempDir: '~/Downloads/.ytdlp-temp' } },
                { id: 'relative', url: 'https://r.com', status: 'queued', progress: 0, request: { format: 'best', quality: 'best', outputDir: 'downloads', filenameTemplate: '%(title)s.%(ext)s', archivePath: 'downloads/.ytdlp-archive', tempDir: 'downloads/.ytdlp-temp' } },
                { id: 'absolute', url: 'https://a.com', status: 'queued', progress: 0, request: { format: 'best', quality: 'best', outputDir: '/tmp', filenameTemplate: '%(title)s.%(ext)s', archivePath: '/tmp/.ytdlp-archive', tempDir: '/tmp/.ytdlp-temp' } },
            ],
        });

        await initState(ctx);

        const q = getQueue();
        assert.equal(q.length, 1, 'only absolute-path entry survives');
        assert.equal(q[0].id, 'absolute');
    });

    // ── Test: library entries with malformed existing request are repaired ─

    await testAsync('library entries with malformed existing request get repaired from filePath', async () => {
        const ctx = createMockCtx({
            'ytdlp:library': [
                {
                    id: 'bad-req', sourceUrl: 'https://example.com', fileUrl: 'file:///data/vids/test.mp4',
                    filePath: '/data/vids/test.mp4', title: 'Bad Request', favorite: false,
                    request: { format: 'mp4', quality: '1080p', outputDir: '', filenameTemplate: '', archivePath: '', tempDir: '' },
                },
            ],
        });

        await initState(ctx);

        const lib = getLibrary();
        assert.equal(lib.length, 1, 'entry survives with repaired request');
        const req = lib[0].request;
        assert.equal(req.outputDir, '/data/vids', 'outputDir derived from filePath');
        assert.equal(req.archivePath, '/data/vids/.ytdlp-archive');
        assert.equal(req.tempDir, '/data/vids/.ytdlp-temp');
        // Preserves original format/quality from the existing request
        assert.equal(req.format, 'mp4', 'preserves original format');
        assert.equal(req.quality, '1080p', 'preserves original quality');
    });

    // ── Test: library entries with relative filePath are dropped ────

    await testAsync('library entries with relative filePath are dropped', async () => {
        const ctx = createMockCtx({
            'ytdlp:library': [
                { id: 'rel-path', sourceUrl: 'https://example.com', fileUrl: 'file:///test.mp4', filePath: 'downloads/test.mp4', title: 'Relative', favorite: false },
                { id: 'abs-path', sourceUrl: 'https://example.com', fileUrl: 'file:///tmp/test.mp4', filePath: '/tmp/test.mp4', title: 'Absolute', favorite: false },
            ],
        });

        await initState(ctx);

        const lib = getLibrary();
        assert.equal(lib.length, 1, 'only absolute filePath entry survives');
        assert.equal(lib[0].id, 'abs-path');
    });

    // ── Test: enqueue appends and notifies subscribers ─────────────

    await testAsync('enqueue appends and notifies subscribers', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        let notified = false;
        const unsub = subscribe(() => { notified = true; });

        const id = enqueue(makeQueueFields('https://example.com/video'));

        assert.ok(typeof id === 'string' && id.length > 0, 'enqueue returns an ID');
        assert.ok(notified, 'subscriber was notified');
        assert.equal(getQueue().length, 1);
        assert.equal(getQueue()[0].id, id);

        unsub();
    });

    // ── Test: enqueue broadcasts state-update to registered panels ─

    await testAsync('enqueue broadcasts state-update with settings and deps to panels', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        const broadcasts: Array<{ panelId: string; message: any }> = [];
        ctx.ui.postToWebPanel = (panelId: string, message: unknown) => {
            broadcasts.push({ panelId, message: message as any });
        };

        registerPanelForBroadcast('test-panel');

        setDependencyStatuses([
            { name: 'yt-dlp', satisfied: true } as any,
        ]);

        enqueue(makeQueueFields('https://example.com/broadcast-test'));

        // Should have broadcast a state-update
        const stateUpdates = broadcasts.filter((b) => b.message?.type === 'state-update');
        assert.ok(stateUpdates.length >= 1, 'state-update was broadcast');

        const msg = stateUpdates[0].message;
        assert.equal(msg.v, 1);
        assert.equal(msg.type, 'state-update');
        assert.ok(Array.isArray(msg.queue), 'state-update includes queue');
        assert.ok(Array.isArray(msg.library), 'state-update includes library');
        assert.ok(Array.isArray(msg.history), 'state-update includes history');
        assert.ok(msg.settings != null, 'state-update includes settings');
        assert.ok(Array.isArray(msg.dependencyStatuses), 'state-update includes dependencyStatuses');
        assert.equal(msg.dependencyStatuses.length, 1);
    });

    // ── Test: updateQueueEntry patches fields ──────────────────────

    await testAsync('updateQueueEntry patches fields', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        const id = enqueue(makeQueueFields('https://example.com/vid'));

        updateQueueEntry(id, { progress: 42, speed: '1.5MiB/s' });

        const entry = getQueue().find((e) => e.id === id);
        assert.equal(entry?.progress, 42);
        assert.equal(entry?.speed, '1.5MiB/s');
    });

    // ── Test: debounced writer fires once after 500ms ──────────────

    // Drain any pending debounced writes from prior tests
    await delay(600);

    await testAsync('debounced writer fires once after 500ms despite rapid mutations', async () => {
        const ctx = createMockCtx();
        let queueSetCalls = 0;
        const originalSet = ctx.cache.set;
        ctx.cache.set = async (key: string, value: unknown, opts?: unknown) => {
            if (key === 'ytdlp:queue') queueSetCalls++;
            return originalSet(key, value, opts);
        };

        await initState(ctx);

        // Reset counter after init (init may persist paused transitions)
        queueSetCalls = 0;

        // Rapid mutations
        enqueue(makeQueueFields('https://a.com'));
        enqueue(makeQueueFields('https://b.com'));
        enqueue(makeQueueFields('https://c.com'));

        // Immediately after rapid mutations, no writes should have happened
        const callsBeforeDelay = queueSetCalls;

        // Wait for debounce to fire
        await delay(600);

        // Only ONE write should have fired for the queue shard
        const callsAfterDelay = queueSetCalls;
        assert.ok(
            callsAfterDelay - callsBeforeDelay <= 1,
            `Expected at most 1 debounced write for queue shard, got ${callsAfterDelay - callsBeforeDelay}`,
        );
    });

    // ── Test: flushPersistedState writes all shards immediately ────

    await testAsync('flushPersistedState writes all three mutable shards immediately', async () => {
        const ctx = createMockCtx();
        const written = new Set<string>();
        ctx.cache.set = async (key: string, value: unknown, _opts?: unknown) => {
            written.add(key);
            ctx._store.set(key, value);
            return true as const;
        };

        await initState(ctx);
        written.clear();

        await flushPersistedState();

        assert.ok(written.has('ytdlp:queue'), 'queue shard written');
        assert.ok(written.has('ytdlp:library'), 'library shard written');
        assert.ok(written.has('ytdlp:history'), 'history shard written');
    });

    // ── Test: registerPanelForBroadcast + broadcastToWebPanels ─────

    await testAsync('broadcastToWebPanels prunes dead panel and delivers to live panel', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        // Override postToWebPanel to throw on the dead panel
        const deliveredIds: string[] = [];
        ctx.ui.postToWebPanel = (panelId: string, _message: unknown) => {
            if (panelId === 'dead-panel') {
                throw new Error('Panel not found');
            }
            deliveredIds.push(panelId);
        };

        registerPanelForBroadcast('dead-panel');
        registerPanelForBroadcast('live-panel');

        // First broadcast: dead-panel fails and gets pruned
        broadcastToWebPanels({ v: 1, type: 'state-update' } as any);
        assert.ok(deliveredIds.includes('live-panel'), 'live panel received message');

        // Second broadcast: dead-panel should NOT be retried
        deliveredIds.length = 0;
        let deadPanelRetried = false;
        ctx.ui.postToWebPanel = (panelId: string, _message: unknown) => {
            if (panelId === 'dead-panel') {
                deadPanelRetried = true;
            }
            deliveredIds.push(panelId);
        };

        broadcastToWebPanels({ v: 1, type: 'state-update' } as any);
        assert.equal(deadPanelRetried, false, 'dead panel was pruned and not retried');
        assert.ok(deliveredIds.includes('live-panel'), 'live panel still receives messages');
    });

    // ── Test: settings snapshot ────────────────────────────────────

    await testAsync('getSettingsSnapshot reads from ctx.settings', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        const snapshot = getSettingsSnapshot();
        assert.equal(snapshot.outputDir, '/tmp/downloads');
        assert.equal(snapshot.defaultQuality, '1080p');
        assert.equal(snapshot.defaultFormat, 'best');
    });

    // ── Test: dependency statuses ──────────────────────────────────

    await testAsync('setDependencyStatuses stores and broadcasts to panels', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        const broadcasts: Array<{ panelId: string; message: any }> = [];
        ctx.ui.postToWebPanel = (panelId: string, message: unknown) => {
            broadcasts.push({ panelId, message: message as any });
        };

        registerPanelForBroadcast('dep-panel');

        setDependencyStatuses([
            { name: 'yt-dlp', satisfied: true } as any,
            { name: 'ffmpeg', satisfied: false } as any,
        ]);

        const statuses = getDependencyStatuses();
        assert.equal(statuses.length, 2);
        assert.equal(isYtDlpAvailable(), true);
        assert.equal(isFfmpegAvailable(), false);

        // Should have broadcast a state-update with the new statuses
        const stateUpdates = broadcasts.filter((b) => b.message?.type === 'state-update');
        assert.ok(stateUpdates.length >= 1, 'state-update was broadcast on dependency change');
        const msg = stateUpdates[0].message;
        assert.equal(msg.dependencyStatuses.length, 2);
        assert.equal(msg.dependencyStatuses[0].name, 'yt-dlp');
    });

    // ── Test: addToHistory deduplicates and caps ───────────────────

    await testAsync('addToHistory deduplicates and caps at 100', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        addToHistory('https://example.com/1');
        addToHistory('https://example.com/2');
        addToHistory('https://example.com/1'); // duplicate — should move to front

        const state = getState();
        assert.equal(state.history[0], 'https://example.com/1');
        assert.equal(state.history[1], 'https://example.com/2');
        assert.equal(state.history.length, 2);
    });

    // ── Test: toggleFavorite ───────────────────────────────────────

    await testAsync('toggleFavorite toggles and returns new value', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        addToLibrary({
            id: 'lib1',
            sourceUrl: 'https://example.com',
            fileUrl: 'file:///test.mp4',
            filePath: '/test.mp4',
            title: 'Test',
            fileExt: 'mp4',
            fileSize: 1000,
            downloadedAt: new Date().toISOString(),
            favorite: false,
            request: {
                format: 'best',
                quality: 'best',
                outputDir: '/tmp',
                filenameTemplate: '%(title)s.%(ext)s',
                archivePath: '/tmp/.ytdlp-archive',
                tempDir: '/tmp/.ytdlp-temp',
            },
        });

        const result1 = toggleFavorite('lib1');
        assert.equal(result1, true);

        const result2 = toggleFavorite('lib1');
        assert.equal(result2, false);

        // Non-existent ID returns false
        const result3 = toggleFavorite('nonexistent');
        assert.equal(result3, false);
    });

    // ── Test: removeFromLibrary ────────────────────────────────────

    await testAsync('removeFromLibrary removes entry', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        addToLibrary({
            id: 'rm1',
            sourceUrl: 'https://example.com',
            fileUrl: 'file:///test.mp4',
            filePath: '/test.mp4',
            title: 'Remove Me',
            fileExt: 'mp4',
            fileSize: 100,
            downloadedAt: new Date().toISOString(),
            favorite: false,
            request: { format: 'best', quality: 'best', outputDir: '/tmp', filenameTemplate: '%(title)s.%(ext)s', archivePath: '/tmp/.ytdlp-archive', tempDir: '/tmp/.ytdlp-temp' },
        });

        assert.equal(getLibrary().some((e) => e.id === 'rm1'), true);
        removeFromLibrary('rm1');
        assert.equal(getLibrary().some((e) => e.id === 'rm1'), false);
    });

    // ── Test: removeQueueEntry ─────────────────────────────────────

    await testAsync('removeQueueEntry removes entry', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        const id = enqueue(makeQueueFields('https://example.com/rm'));

        assert.ok(getQueue().some((e) => e.id === id));
        removeQueueEntry(id);
        assert.ok(!getQueue().some((e) => e.id === id));
    });

    // ── Test: isFirstRun / markFirstRunComplete ────────────────────

    await testAsync('isFirstRun returns true initially, false after markFirstRunComplete', async () => {
        const ctx = createMockCtx();
        await initState(ctx);

        assert.equal(await isFirstRun(), true);
        await markFirstRunComplete();
        assert.equal(await isFirstRun(), false);
    });

    // ── Test: re-init clears runtime-only state ─────────────────────

    await testAsync('re-init clears stale panels, subscribers, and dependency statuses', async () => {
        const ctx1 = createMockCtx();
        await initState(ctx1);

        // Set up runtime state in first init cycle
        registerPanelForBroadcast('stale-panel');
        setDependencyStatuses([{ name: 'yt-dlp', satisfied: true } as any]);
        let subscriberCalled = false;
        subscribe(() => { subscriberCalled = true; });

        // Re-init with a new context
        const ctx2 = createMockCtx();
        await initState(ctx2);

        // Stale dependency statuses should be cleared
        assert.equal(getDependencyStatuses().length, 0, 'dependency statuses cleared on re-init');

        // Stale subscriber should NOT fire on new mutations
        subscriberCalled = false;
        enqueue(makeQueueFields('https://re-init-test.com'));
        assert.equal(subscriberCalled, false, 'stale subscriber not called after re-init');

        // Stale panel should NOT receive broadcasts
        const broadcasts: string[] = [];
        ctx2.ui.postToWebPanel = (panelId: string, _msg: unknown) => {
            broadcasts.push(panelId);
        };
        broadcastToWebPanels({ v: 1, type: 'state-update' } as any);
        assert.ok(!broadcasts.includes('stale-panel'), 'stale panel not in broadcast set after re-init');
    });

    // ── Summary ────────────────────────────────────────────────────

    // Wait for any pending debounce timers
    await delay(600);

    console.log(`\nstate.test: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);

})();
