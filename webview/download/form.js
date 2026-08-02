/**
 * Download form view controller.
 *
 * Wires URL input with debounced probe, format/quality selects populated
 * from manifest presets, playlist manager with selection, collapsible
 * advanced options, and live CLI preview. Sends `request-state` on
 * DOM-ready as the canonical initialization contract.
 *
 * @module webview/download/form
 */

import { bridge } from '../shared/bridge.js';
import { msg, validateInbound } from '../shared/messages.js';
import { renderDegradedBanner } from '../shared/degraded-banner.js';
import { debouncedInput, escapeHtml } from '../shared/ui-helpers.js';

/** @typedef {import('../shared/messages.js').PanelOutboundMessage} PanelOutboundMessage */

// ── DOM references ──────────────────────────────────────────────────

const bannerEl = /** @type {HTMLElement} */ (document.getElementById('degraded-banner'));
const urlInput = /** @type {HTMLInputElement} */ (document.getElementById('url-input'));
const probeStatus = /** @type {HTMLElement} */ (document.getElementById('probe-status'));
const metadataDisplay = /** @type {HTMLElement} */ (document.getElementById('metadata-display'));
const metadataThumb = /** @type {HTMLElement} */ (document.getElementById('metadata-thumb'));
const metadataTitle = /** @type {HTMLElement} */ (document.getElementById('metadata-title'));
const metadataUploader = /** @type {HTMLElement} */ (document.getElementById('metadata-uploader'));
const metadataDuration = /** @type {HTMLElement} */ (document.getElementById('metadata-duration'));
const formatSelect = /** @type {HTMLSelectElement} */ (document.getElementById('format-select'));
const qualitySelect = /** @type {HTMLSelectElement} */ (document.getElementById('quality-select'));
const playlistContainer = /** @type {HTMLElement} */ (document.getElementById('playlist-container'));
const playlistTitleEl = /** @type {HTMLElement} */ (document.getElementById('playlist-title'));
const playlistSelectAll = /** @type {HTMLElement} */ (document.getElementById('playlist-select-all'));
const playlistDeselectAll = /** @type {HTMLElement} */ (document.getElementById('playlist-deselect-all'));
const playlistCount = /** @type {HTMLElement} */ (document.getElementById('playlist-count'));
const playlistEntries = /** @type {HTMLElement} */ (document.getElementById('playlist-entries'));
const proxyInput = /** @type {HTMLInputElement} */ (document.getElementById('proxy-input'));
const templateInput = /** @type {HTMLInputElement} */ (document.getElementById('template-input'));
const argsInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('args-input'));
const cliPreview = /** @type {HTMLElement} */ (document.getElementById('cli-preview'));
const enqueueBtn = /** @type {HTMLButtonElement} */ (document.getElementById('enqueue-btn'));

// ── State ───────────────────────────────────────────────────────────

/** @type {{ id: string, url: string, title: string, unresolved?: boolean }[] | null} */
let currentPlaylistEntries = null;

/** @type {string | null} */
let currentPlaylistUrl = null;

/** @type {string} */
let currentGroupTag = '';

/** @type {string} */
let currentGroupLabel = '';

/** @type {string[]} */
let ffmpegMissingFormats = [];

/** Whether the user has manually changed the format/quality selects. */
let userChangedFormat = false;
let userChangedQuality = false;

/**
 * Formats that require ffmpeg for transcoding or merging.
 * - mp3/m4a: audio extraction needs ffmpeg transcode
 * - mp4/webm: preferred merge path needs ffmpeg (downloader auto-downgrades
 *   to pre-muxed fallback without ffmpeg, but quality may be lower)
 */
const FFMPEG_REQUIRED_FORMATS = ['mp3', 'm4a', 'mp4', 'webm'];

/** Last known queue length from state-update/queue-update broadcasts. */
let lastKnownQueueLength = 0;

/**
 * Probe lifecycle state.
 * - 'idle': no probe in flight, submit allowed
 * - 'pending': probe request sent, awaiting response — submit disabled
 * - 'resolved': probe completed (video or playlist), submit allowed
 */
let probeState = 'idle';

// ── Probe state management ──────────────────────────────────────────

/**
 * Clear all probe-derived UI state. Called immediately on URL input
 * to prevent stale metadata/playlist from being actionable while
 * the debounced probe is in flight.
 */
function clearProbeState() {
    metadataDisplay.hidden = true;
    playlistContainer.hidden = true;
    currentPlaylistEntries = null;
    currentPlaylistUrl = null;
    enqueueBtn.textContent = 'Download';
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Format duration in seconds to a human-readable string.
 * @param {number | null} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    if (seconds == null || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Parse custom args textarea: one argv element per line.
 * @returns {string[]}
 */
function parseCustomArgs() {
    return argsInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * POSIX-quote a single shell argument for display.
 * Wraps in single-quotes if it contains shell-significant characters.
 * @param {string} arg
 * @returns {string}
 */
function posixQuote(arg) {
    if (!arg) return "''";
    if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg)) return arg;
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** Tracks the most recent CLI preview request so stale responses are ignored. */
let activePreviewId = '';

/**
 * Build and send a CLI preview request (debounced externally).
 */
function requestCliPreview() {
    const url = urlInput.value.trim();
    if (!url) {
        cliPreview.textContent = '';
        activePreviewId = '';
        return;
    }
    const pvId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    activePreviewId = pvId;
    bridge.send(msg('request-cli-preview', {
        previewId: pvId,
        url,
        format: formatSelect.value,
        quality: qualitySelect.value,
        advancedArgs: parseCustomArgs(),
        proxyUrl: proxyInput.value.trim() || undefined,
        filenameTemplate: templateInput.value.trim() || undefined,
    }));
}

/**
 * Update the selected count display for playlist entries.
 */
function updatePlaylistCount() {
    if (!playlistEntries) return;
    const checks = playlistEntries.querySelectorAll('input[type="checkbox"]');
    const checked = playlistEntries.querySelectorAll('input[type="checkbox"]:checked');
    playlistCount.textContent = `${checked.length} of ${checks.length} selected`;
}

/**
 * Update format option disabled states based on ffmpeg availability.
 * @param {boolean} ffmpegAvailable
 */
function updateFfmpegDependentOptions(ffmpegAvailable) {
    ffmpegMissingFormats = ffmpegAvailable ? [] : FFMPEG_REQUIRED_FORMATS;

    for (const option of formatSelect.options) {
        if (FFMPEG_REQUIRED_FORMATS.includes(option.value)) {
            option.disabled = !ffmpegAvailable;
            option.title = ffmpegAvailable ? '' : 'Requires ffmpeg (not installed)';
        }
    }

    // If current selection requires ffmpeg and it's unavailable, force fallback
    if (!ffmpegAvailable && FFMPEG_REQUIRED_FORMATS.includes(formatSelect.value)) {
        formatSelect.value = 'best';
        debouncedCliPreview();
    }
}

// ── Debounced CLI preview ───────────────────────────────────────────

let cliPreviewTimer = 0;
function debouncedCliPreview() {
    clearTimeout(cliPreviewTimer);
    // Invalidate immediately so stale responses arriving during the debounce
    // window are rejected by handleCliPreview's strict correlation check.
    activePreviewId = '';
    cliPreviewTimer = window.setTimeout(requestCliPreview, 300);
}

// ── URL probe ───────────────────────────────────────────────────────

/** Tracks the most recent probe request so stale/foreign responses are ignored. */
let activeProbeId = '';

/**
 * Update submit button enabled state based on probe lifecycle.
 */
function updateSubmitState() {
    enqueueBtn.disabled = probeState === 'pending' || !urlInput.value.trim();
}

// Clear probe-derived state immediately on every keystroke so stale
// metadata/playlist is not actionable during the debounce window.
// Set pending immediately (not after debounce) to close the bypass window.
// Invalidate activeProbeId so in-flight responses are rejected.
urlInput.addEventListener('input', () => {
    clearProbeState();
    activeProbeId = '';
    const hasUrl = !!urlInput.value.trim();
    probeState = hasUrl ? 'pending' : 'idle';
    probeStatus.textContent = '';
    probeStatus.className = 'yt-probe-status';
    updateSubmitState();
});

const cleanupUrlDebounce = debouncedInput(urlInput, 500, (url) => {
    if (!url.trim()) return;
    // probeState is already 'pending' from the input handler
    const pbId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'pb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    activeProbeId = pbId;
    probeStatus.textContent = 'Probing\u2026';
    probeStatus.className = 'yt-probe-status';
    bridge.send(msg('probe-url', { probeId: pbId, url: url.trim() }));
});

// ── Message handlers ────────────────────────────────────────────────

bridge.onMessage((data) => {
    switch (data.type) {
        case 'state-update':
            handleStateUpdate(data);
            break;
        case 'queue-update':
            if (Array.isArray(data.entries)) {
                lastKnownQueueLength = data.entries.length;
            }
            break;
        case 'enqueue-ack':
            // Strict correlation: only clear guard if requestId matches this
            // instance's active request. Missing/empty IDs are rejected.
            if (data.requestId && activeRequestId && data.requestId === activeRequestId) {
                clearSubmitGuard();
            }
            break;
        case 'probe-result':
            handleProbeResult(data);
            break;
        case 'probe-error':
            handleProbeError(data);
            break;
        case 'playlist-data':
            handlePlaylistData(data);
            break;
        case 'cli-preview':
            handleCliPreview(data);
            break;
        case 'dependency-banner':
        case 'dependency-status':
            handleDependencyUpdate(data);
            break;
        case 'settings-update':
            handleSettingsUpdate(data);
            break;
    }
});

/**
 * @param {Extract<PanelOutboundMessage, { type: 'state-update' }>} data
 */
function handleStateUpdate(data) {
    if (Array.isArray(data.queue)) {
        lastKnownQueueLength = data.queue.length;
    }
    const settings = data.settings;
    if (settings) {
        if (settings.defaultFormat && !userChangedFormat) {
            formatSelect.value = settings.defaultFormat;
        }
        if (settings.defaultQuality && !userChangedQuality) {
            qualitySelect.value = settings.defaultQuality;
        }
        if (settings.filenameTemplate && !templateInput.value) {
            templateInput.value = settings.filenameTemplate;
        }
        if (settings.proxyUrl && !proxyInput.value) {
            proxyInput.value = settings.proxyUrl;
        }
    }

    if (data.dependencyStatuses) {
        renderDegradedBanner(bannerEl, data.dependencyStatuses, {
            onRecheck: () => bridge.send(msg('recheck-dependencies')),
        });
        const ffmpegOk = data.dependencyStatuses.some(
            (s) => s.name === 'ffmpeg' && s.satisfied,
        );
        updateFfmpegDependentOptions(ffmpegOk);
    }
}

/**
 * @param {Extract<PanelOutboundMessage, { type: 'probe-result' }>} data
 */
function handleProbeResult(data) {
    // Strict correlation: ignore responses with missing or non-matching probeId
    if (!data.probeId || !activeProbeId || data.probeId !== activeProbeId) return;

    probeState = 'resolved';
    probeStatus.textContent = '';
    probeStatus.className = 'yt-probe-status';
    clearProbeState();
    updateSubmitState();

    const meta = data.metadata;
    if (!meta) return;

    metadataDisplay.hidden = false;

    metadataTitle.textContent = meta.title || '';
    metadataUploader.textContent = meta.uploader || '';
    metadataDuration.textContent = formatDuration(meta.duration);

    // Thumbnail — use safe DOM methods
    while (metadataThumb.firstChild) metadataThumb.firstChild.remove();
    if (meta.thumbnail) {
        const img = document.createElement('img');
        img.src = meta.thumbnail;
        img.alt = meta.title || 'Thumbnail';
        img.className = 'yt-metadata__img';
        metadataThumb.appendChild(img);
    }
}

/**
 * @param {Extract<PanelOutboundMessage, { type: 'probe-error' }>} data
 */
function handleProbeError(data) {
    // Strict correlation: ignore responses with missing or non-matching probeId
    if (!data.probeId || !activeProbeId || data.probeId !== activeProbeId) return;

    probeState = 'resolved';
    probeStatus.textContent = data.error?.message || 'Probe failed';
    probeStatus.className = 'yt-probe-status yt-probe-status--error';
    clearProbeState();
    updateSubmitState();
}

/**
 * @param {Extract<PanelOutboundMessage, { type: 'playlist-data' }>} data
 */
function handlePlaylistData(data) {
    // Strict correlation: ignore responses with missing or non-matching probeId
    if (!data.probeId || !activeProbeId || data.probeId !== activeProbeId) return;

    probeState = 'resolved';
    probeStatus.textContent = '';
    probeStatus.className = 'yt-probe-status';
    metadataDisplay.hidden = true;
    updateSubmitState();

    currentPlaylistUrl = data.playlistUrl;
    currentPlaylistEntries = data.entries || [];
    currentGroupTag = data.groupTag || '';
    currentGroupLabel = data.groupLabel || '';

    playlistTitleEl.textContent = data.playlistTitle || 'Playlist';
    playlistContainer.hidden = false;

    // Clear and rebuild entries
    while (playlistEntries.firstChild) playlistEntries.firstChild.remove();

    currentPlaylistEntries.forEach((entry, idx) => {
        const row = document.createElement('label');
        row.className = 'yt-playlist__entry';
        row.setAttribute('role', 'listitem');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.index = String(idx);
        cb.addEventListener('change', updatePlaylistCount);

        const titleSpan = document.createElement('span');
        titleSpan.className = 'yt-playlist__entry-title';
        titleSpan.textContent = entry.title || entry.url;

        row.appendChild(cb);
        row.appendChild(titleSpan);

        if (entry.unresolved) {
            const warn = document.createElement('span');
            warn.className = 'yt-playlist__unresolved';
            warn.textContent = '(unresolved URL)';
            warn.title = 'This entry\'s URL could not be fully resolved and may fail to download';
            row.appendChild(warn);
        }

        playlistEntries.appendChild(row);
    });

    updatePlaylistCount();
    enqueueBtn.textContent = 'Download Playlist';
}

/**
 * @param {Extract<PanelOutboundMessage, { type: 'cli-preview' }>} data
 */
function handleCliPreview(data) {
    // Strict correlation: ignore responses with missing, empty, or non-matching previewId
    if (!data.previewId || !activePreviewId || data.previewId !== activePreviewId) return;

    if (data.error) {
        cliPreview.textContent = `Error: ${data.error}`;
        cliPreview.className = 'yt-cli-preview yt-cli-preview--error';
    } else if (data.args) {
        cliPreview.textContent = 'yt-dlp ' + data.args.map(posixQuote).join(' ');
        cliPreview.className = 'yt-cli-preview';
    }
}

/**
 * @param {Extract<PanelOutboundMessage, { type: 'dependency-banner' | 'dependency-status' }>} data
 */
function handleDependencyUpdate(data) {
    const statuses = data.statuses;
    if (statuses) {
        renderDegradedBanner(bannerEl, statuses, {
            onRecheck: () => bridge.send(msg('recheck-dependencies')),
        });
        const ffmpegOk = statuses.some((s) => s.name === 'ffmpeg' && s.satisfied);
        updateFfmpegDependentOptions(ffmpegOk);
    }
}

/**
 * @param {Extract<PanelOutboundMessage, { type: 'settings-update' }>} data
 */
function handleSettingsUpdate(data) {
    const settings = data.settings;
    if (settings) {
        if (settings.filenameTemplate) {
            templateInput.placeholder = settings.filenameTemplate;
        }
        if (settings.proxyUrl) {
            proxyInput.placeholder = settings.proxyUrl;
        }
    }
}

// ── Event wiring ────────────────────────────────────────────────────

// Playlist select/deselect all
playlistSelectAll.addEventListener('click', () => {
    playlistEntries.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        /** @type {HTMLInputElement} */ (cb).checked = true;
    });
    updatePlaylistCount();
});

playlistDeselectAll.addEventListener('click', () => {
    playlistEntries.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        /** @type {HTMLInputElement} */ (cb).checked = false;
    });
    updatePlaylistCount();
});

// Track user changes to format/quality so settings don't overwrite
formatSelect.addEventListener('change', () => { userChangedFormat = true; });
qualitySelect.addEventListener('change', () => { userChangedQuality = true; });

// CLI preview on form changes (including URL)
urlInput.addEventListener('input', debouncedCliPreview);
formatSelect.addEventListener('change', debouncedCliPreview);
qualitySelect.addEventListener('change', debouncedCliPreview);
proxyInput.addEventListener('input', debouncedCliPreview);
templateInput.addEventListener('input', debouncedCliPreview);
argsInput.addEventListener('input', debouncedCliPreview);

// Enqueue button — guarded against double-submit.
// Each submit generates a unique requestId. The plugin echoes it in `enqueue-ack`
// so the webview only clears the guard for its own request (multi-instance safe).
// The fallback timeout is a dead-man switch for lost messages.
let isSubmitting = false;

/** @type {string} */
let activeRequestId = '';

/**
 * Generate a globally unique request ID across all panel instances.
 * Uses crypto.randomUUID() (available in WebKit) for collision resistance.
 * @returns {string}
 */
function nextRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback: instance ID + sequence + timestamp + random suffix
    const ctx = bridge.getContext();
    const prefix = ctx ? ctx.instanceId : '';
    return prefix + '-' + (++requestSeq) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}
let requestSeq = 0;

enqueueBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url || isSubmitting) return;

    const reqId = nextRequestId();

    // Playlist mode: currentPlaylistEntries !== null means URL was classified as playlist
    if (currentPlaylistEntries !== null) {
        if (currentPlaylistEntries.length === 0) {
            // Empty playlist — nothing to enqueue
            return;
        }

        // Snapshot the narrowed (non-null) entries so the forEach closure
        // keeps the narrowing (TS resets `let` narrowing across closures).
        const entriesSnapshot = currentPlaylistEntries;
        const checks = playlistEntries.querySelectorAll('input[type="checkbox"]');
        /** @type {{ id: string, url: string, title: string }[]} */
        const selected = [];
        checks.forEach((cb, idx) => {
            if (/** @type {HTMLInputElement} */ (cb).checked && entriesSnapshot[idx]) {
                const entry = entriesSnapshot[idx];
                selected.push({ id: entry.id, url: entry.url, title: entry.title });
            }
        });

        if (selected.length === 0) return;

        isSubmitting = true;
        activeRequestId = reqId;
        enqueueBtn.disabled = true;

        bridge.send(msg('queue-playlist', {
            requestId: reqId,
            playlistUrl: currentPlaylistUrl,
            selectedEntries: selected,
            format: formatSelect.value,
            quality: qualitySelect.value,
            groupTag: currentGroupTag,
            groupLabel: currentGroupLabel,
            advancedArgs: parseCustomArgs(),
            proxyUrl: proxyInput.value.trim() || undefined,
            filenameTemplate: templateInput.value.trim() || undefined,
        }));
    } else {
        isSubmitting = true;
        activeRequestId = reqId;
        enqueueBtn.disabled = true;

        bridge.send(msg('queue-download', {
            requestId: reqId,
            url,
            format: formatSelect.value,
            quality: qualitySelect.value,
            advancedArgs: parseCustomArgs(),
            proxyUrl: proxyInput.value.trim() || undefined,
            filenameTemplate: templateInput.value.trim() || undefined,
        }));
    }

    // Fallback timeout: dead-man switch if enqueue-ack is lost.
    submitGuardTimeout = window.setTimeout(clearSubmitGuard, 5000);
});

/** @type {number} */
let submitGuardTimeout = 0;

function clearSubmitGuard() {
    if (!isSubmitting) return;
    clearTimeout(submitGuardTimeout);
    submitGuardTimeout = 0;
    isSubmitting = false;
    activeRequestId = '';
    updateSubmitState();
}

// ── Initialization ──────────────────────────────────────────────────

// Canonical initialization: request state on DOM-ready
bridge.send(msg('request-state'));
