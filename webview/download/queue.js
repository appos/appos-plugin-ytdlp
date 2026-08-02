/**
 * Queue view controller — renders the download queue with keyed diffing.
 *
 * Listens for `state-update`, `queue-update`, `download-progress`, and
 * `download-status` messages from the plugin and keeps the queue view
 * in sync. Uses `renderList` for keyed DOM diffing so only changed rows
 * are touched on bulk updates. Progress ticks update inline (no full
 * re-render) to keep 10 Hz updates smooth.
 *
 * Playlist entries are grouped into native `<details>` elements by
 * `groupTag` — auto-expanded when any child is active.
 *
 * @module webview/download/queue
 */

import { bridge } from '../shared/bridge.js';
import { msg } from '../shared/messages.js';
import { renderList, escapeHtml, focusNextAfterRemoval } from '../shared/ui-helpers.js';

/** @typedef {import('../shared/messages.js').PanelOutboundMessage} PanelOutboundMessage */

// ── DOM references ──────────────────────────────────────────────────

const queueSection = document.getElementById('view-queue');

// ── State ───────────────────────────────────────────────────────────

/** @type {Array<Record<string, any>>} */
let entries = [];

// ── Status helpers ──────────────────────────────────────────────────

/** @type {Record<string, string>} */
const STATUS_ICONS = {
    queued: '\u23F3',       // hourglass
    downloading: '\u2B07\uFE0F', // down arrow
    extracting: '\u2699\uFE0F',  // gear
    complete: '\u2705',     // check
    failed: '\u274C',       // cross
    cancelled: '\u26D4',    // no entry
    paused: '\u23F8\uFE0F',     // pause
};

/**
 * Status label for display — extracting shows "Merging..." to match
 * what users see when ffmpeg is combining audio+video streams.
 * @param {string} status
 * @returns {string}
 */
function statusLabel(status) {
    if (status === 'extracting') return 'Merging...';
    return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Whether an entry is in an active (in-flight) state.
 * @param {string | null} status
 * @returns {boolean}
 */
function isActive(status) {
    return status === 'downloading' || status === 'extracting' || status === 'queued';
}

// ── Queue tab badge ─────────────────────────────────────────────────

const queueTab = document.querySelector('[data-view="queue"]');

function updateTabBadge() {
    if (!queueTab) return;
    queueTab.textContent = `Queue (${entries.length})`;
}

// ── Bulk controls ───────────────────────────────────────────────────

/**
 * Build bulk action buttons using safe DOM construction (no innerHTML).
 */
function buildBulkControls() {
    const header = document.createElement('div');
    header.className = 'yt-queue__bulk';

    const actions = [
        { action: 'pause-all', label: 'Pause All' },
        { action: 'resume-all', label: 'Resume All' },
        { action: 'clear-completed', label: 'Clear Completed' },
    ];

    for (const { action, label } of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'yt-button yt-button--secondary yt-button--sm';
        btn.setAttribute('data-action', action);
        btn.textContent = label;
        header.appendChild(btn);
    }

    header.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'pause-all') bridge.send(msg('pause-queue'));
        else if (action === 'resume-all') bridge.send(msg('resume-queue'));
        else if (action === 'clear-completed') bridge.send(msg('clear-completed'));
    });

    return header;
}

// ── Row rendering ───────────────────────────────────────────────────

/**
 * Create a button element safely (no innerHTML).
 * @param {string} label
 * @param {string} action
 * @returns {HTMLButtonElement}
 */
function createActionButton(label, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yt-button yt-button--secondary yt-button--sm';
    btn.setAttribute('data-action', action);
    btn.textContent = label;
    return btn;
}

/**
 * Render a single queue entry row. When `el` is non-null, update it
 * in place (keyed diff). When null, create a new element.
 *
 * Teaching comment: `renderList` calls this for every item on each update.
 * The keyed-diff pattern works because `renderList` matches elements by
 * their `data-key` attribute — existing elements get updated in place
 * (avoiding full DOM teardown), while new keys create fresh elements.
 * This keeps the DOM stable for CSS transitions and focus state.
 * @param {Record<string, any>} entry
 * @param {HTMLElement | null} el
 * @returns {HTMLElement}
 */
function renderRow(entry, el) {
    const isNew = !el;
    if (!el) {
        // Const alias so the listener closures see a non-null element
        // (TS resets narrowing of the mutable `el` param inside closures).
        const row = document.createElement('div');
        row.className = 'yt-queue__row';
        row.setAttribute('tabindex', '0');

        // Inline button click handler — delegated to the row
        row.addEventListener('click', (e) => {
            const btn = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            const id = row.getAttribute('data-id');
            if (!id) return;
            if (action === 'cancel') bridge.send(msg('cancel-download', { id }));
            else if (action === 'retry') bridge.send(msg('retry-download', { id }));
            else if (action === 'reveal') bridge.send(msg('reveal-file', { id }));
        });

        // Keyboard shortcuts on the row — only when the row itself has focus,
        // not when focus is on an interactive descendant (button). This prevents
        // double-firing when Enter is pressed on the Retry button (native click
        // + row keydown). Also ignore held-key repeats.
        row.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            if (e.target !== row) return; // ignore events bubbling from buttons
            const id = row.getAttribute('data-id');
            if (!id) return;
            if (e.key === 'Delete') {
                const status = row.getAttribute('data-status');
                if (isActive(status)) {
                    bridge.send(msg('cancel-download', { id }));
                    focusNextAfterRemoval(row);
                }
            } else if (e.key === 'Enter') {
                const status = row.getAttribute('data-status');
                if (status === 'failed' || status === 'cancelled') {
                    bridge.send(msg('retry-download', { id }));
                }
            }
        });

        el = row;
    }

    el.setAttribute('data-key', entry.id);
    el.setAttribute('data-id', entry.id);
    el.setAttribute('data-status', entry.status);

    const percent = Math.round(entry.progress || 0);

    // Build DOM structure safely — all user content goes through textContent
    if (isNew || !el.querySelector('.yt-queue__icon')) {
        el.textContent = '';

        // Icon
        const iconSpan = document.createElement('span');
        iconSpan.className = 'yt-queue__icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.textContent = STATUS_ICONS[entry.status] || '';
        el.appendChild(iconSpan);

        // Info container
        const info = document.createElement('div');
        info.className = 'yt-queue__info';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'yt-queue__title';
        titleSpan.textContent = entry.title || entry.url || 'Unknown';
        info.appendChild(titleSpan);

        const progressRow = document.createElement('div');
        progressRow.className = 'yt-queue__progress-row';

        const progress = document.createElement('progress');
        progress.className = 'yt-queue__progress';
        progress.value = percent;
        progress.max = 100;
        progressRow.appendChild(progress);

        const percentSpan = document.createElement('span');
        percentSpan.className = 'yt-queue__percent';
        percentSpan.textContent = `${percent}%`;
        progressRow.appendChild(percentSpan);

        info.appendChild(progressRow);

        const meta = document.createElement('span');
        meta.className = 'yt-queue__meta';

        const statusSpan = document.createElement('span');
        statusSpan.className = 'yt-queue__status';
        statusSpan.textContent = statusLabel(entry.status);
        meta.appendChild(statusSpan);

        const speedSpan = document.createElement('span');
        speedSpan.className = 'yt-queue__speed';
        speedSpan.textContent = entry.speed || '';
        meta.appendChild(speedSpan);

        const etaSpan = document.createElement('span');
        etaSpan.className = 'yt-queue__eta';
        etaSpan.textContent = entry.eta ? `ETA: ${entry.eta}` : '';
        meta.appendChild(etaSpan);

        const attemptSpan = document.createElement('span');
        attemptSpan.className = 'yt-queue__attempt';
        attemptSpan.textContent = entry.attempt && entry.attempt > 1
            ? `attempt ${entry.attempt} / 20`
            : '';
        meta.appendChild(attemptSpan);

        info.appendChild(meta);
        el.appendChild(info);

        // Actions container
        const actions = document.createElement('div');
        actions.className = 'yt-queue__actions';
        el.appendChild(actions);
    }

    // Update mutable fields on existing elements
    const iconEl = el.querySelector('.yt-queue__icon');
    if (iconEl) iconEl.textContent = STATUS_ICONS[entry.status] || '';

    const titleEl = el.querySelector('.yt-queue__title');
    if (titleEl) titleEl.textContent = entry.title || entry.url || 'Unknown';

    const progressEl = /** @type {HTMLProgressElement | null} */ (el.querySelector('.yt-queue__progress'));
    if (progressEl) progressEl.value = percent;

    const percentEl = el.querySelector('.yt-queue__percent');
    if (percentEl) percentEl.textContent = `${percent}%`;

    const statusEl = el.querySelector('.yt-queue__status');
    if (statusEl) statusEl.textContent = statusLabel(entry.status);

    const speedEl = el.querySelector('.yt-queue__speed');
    if (speedEl) speedEl.textContent = entry.speed || '';

    const etaEl = el.querySelector('.yt-queue__eta');
    if (etaEl) etaEl.textContent = entry.eta ? `ETA: ${entry.eta}` : '';

    const attemptEl = el.querySelector('.yt-queue__attempt');
    if (attemptEl) {
        attemptEl.textContent = entry.attempt && entry.attempt > 1
            ? `attempt ${entry.attempt} / 20`
            : '';
    }

    // Update action buttons based on status
    const actionsEl = el.querySelector('.yt-queue__actions');
    if (actionsEl) {
        actionsEl.textContent = '';
        if (isActive(entry.status)) {
            actionsEl.appendChild(createActionButton('Cancel', 'cancel'));
        } else if (entry.status === 'failed' || entry.status === 'cancelled') {
            actionsEl.appendChild(createActionButton('Retry', 'retry'));
        } else if (entry.status === 'complete') {
            actionsEl.appendChild(createActionButton('Show in Files pane', 'reveal'));
        }
    }

    return el;
}

// ── Playlist grouping ───────────────────────────────────────────────

/**
 * Group entries by `groupTag` and render playlist groups as `<details>`.
 * Ungrouped entries (null groupTag) render as flat rows.
 */
function renderQueue() {
    if (!queueSection) return;

    if (entries.length === 0) {
        queueSection.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'yt-empty-state';
        const title = document.createElement('p');
        title.className = 'yt-empty-state__title';
        title.textContent = 'No downloads yet.';
        const hint = document.createElement('p');
        hint.textContent = 'Use the Download tab to add a URL.';
        empty.appendChild(title);
        empty.appendChild(hint);
        queueSection.appendChild(empty);
        updateTabBadge();
        return;
    }

    // Ensure bulk controls exist
    let bulkEl = queueSection.querySelector('.yt-queue__bulk');
    if (!bulkEl) {
        queueSection.textContent = '';
        bulkEl = buildBulkControls();
        queueSection.appendChild(bulkEl);
    }

    // Separate grouped vs ungrouped
    /** @type {Map<string, Array<Record<string, any>>>} */
    const groups = new Map();
    /** @type {Array<Record<string, any>>} */
    const ungrouped = [];

    for (const entry of entries) {
        if (entry.groupTag) {
            let group = groups.get(entry.groupTag);
            if (!group) {
                group = [];
                groups.set(entry.groupTag, group);
            }
            group.push(entry);
        } else {
            ungrouped.push(entry);
        }
    }

    // Get or create list container (after bulk controls)
    let listEl = queueSection.querySelector('.yt-queue__list');
    if (!listEl) {
        listEl = document.createElement('div');
        listEl.className = 'yt-queue__list';
        queueSection.appendChild(listEl);
    }

    // Track which group elements exist
    const existingGroups = new Map();
    for (const child of Array.from(listEl.children)) {
        const tag = child.getAttribute('data-group');
        if (tag) existingGroups.set(tag, child);
    }

    // Remove stale groups
    for (const [tag, el] of existingGroups) {
        if (!groups.has(tag)) {
            el.remove();
            existingGroups.delete(tag);
        }
    }

    // Render groups
    for (const [tag, groupEntries] of groups) {
        let details = existingGroups.get(tag);
        const hasActive = groupEntries.some((e) => isActive(e.status));
        const completeCount = groupEntries.filter((e) => e.status === 'complete').length;
        const label = groupEntries[0]?.groupLabel || `Playlist: ${tag}`;

        if (!details) {
            details = document.createElement('details');
            details.className = 'yt-queue__group';
            details.setAttribute('data-group', tag);
            details.setAttribute('data-key', `group-${tag}`);
            const summary = document.createElement('summary');
            summary.className = 'yt-queue__group-summary';
            details.appendChild(summary);
            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'yt-queue__group-items';
            details.appendChild(itemsContainer);
            listEl.appendChild(details);
        }

        // Auto-expand if any entry is active
        if (hasActive) details.open = true;

        const summary = details.querySelector('.yt-queue__group-summary');
        if (summary) {
            summary.textContent = `${label} \u2014 ${completeCount} / ${groupEntries.length} complete`;
        }

        const itemsContainer = details.querySelector('.yt-queue__group-items');
        if (itemsContainer) {
            renderList(itemsContainer, groupEntries, {
                getKey: (e) => e.id,
                render: renderRow,
            });
        }
    }

    // Render ungrouped entries in a dedicated container
    let ungroupedEl = /** @type {HTMLElement | null} */ (listEl.querySelector('.yt-queue__ungrouped'));
    if (ungrouped.length > 0) {
        if (!ungroupedEl) {
            ungroupedEl = document.createElement('div');
            ungroupedEl.className = 'yt-queue__ungrouped';
            listEl.insertBefore(ungroupedEl, listEl.firstChild);
        }
        renderList(ungroupedEl, ungrouped, {
            getKey: (e) => e.id,
            render: renderRow,
        });
    } else if (ungroupedEl) {
        ungroupedEl.remove();
    }

    updateTabBadge();
}

// ── Inline progress update (no full re-render) ─────────────────────

/**
 * Handle `download-progress` by updating just the relevant row's
 * progress bar, percent text, speed, ETA, and attempt counter.
 * Avoids full renderQueue() to keep 10 Hz ticks fast.
 * @param {Extract<PanelOutboundMessage, { type: 'download-progress' }>} data
 */
function handleProgress(data) {
    if (!queueSection) return;
    const row = queueSection.querySelector(`[data-id="${CSS.escape(data.id)}"]`);
    if (!row) return;

    const percent = Math.round(data.percent || 0);

    const progress = /** @type {HTMLProgressElement | null} */ (row.querySelector('.yt-queue__progress'));
    if (progress) progress.value = percent;

    const percentEl = row.querySelector('.yt-queue__percent');
    if (percentEl) percentEl.textContent = `${percent}%`;

    const speedEl = row.querySelector('.yt-queue__speed');
    if (speedEl) speedEl.textContent = data.speed || '';

    const etaEl = row.querySelector('.yt-queue__eta');
    if (etaEl) etaEl.textContent = data.eta ? `ETA: ${data.eta}` : '';

    const attemptEl = row.querySelector('.yt-queue__attempt');
    if (attemptEl) {
        attemptEl.textContent = data.attempt && data.attempt > 1
            ? `attempt ${data.attempt} / ${data.maxAttempts || 20}`
            : '';
    }

    // Also update in-memory entry for consistency on next full render
    const entry = entries.find((e) => e.id === data.id);
    if (entry) {
        entry.progress = data.percent;
        entry.speed = data.speed || null;
        entry.eta = data.eta || null;
        if (data.attempt) entry.attempt = data.attempt;
    }
}

// ── Inline status update ────────────────────────────────────────────

/**
 * Handle `download-status` by updating the row's icon, status label,
 * and button visibility. Re-renders the affected row to toggle
 * Cancel/Retry/Reveal buttons correctly.
 * @param {Extract<PanelOutboundMessage, { type: 'download-status' }>} data
 */
function handleStatus(data) {
    const entry = entries.find((e) => e.id === data.id);
    if (entry) {
        entry.status = data.status;
        if (data.finalFilePath) entry.finalFilePath = data.finalFilePath;
        if (data.finalFileUrl) entry.finalFileUrl = data.finalFileUrl;
        if (data.errorMessage) entry.errorMessage = data.errorMessage;
    }

    if (!queueSection) return;
    const row = /** @type {HTMLElement | null} */ (queueSection.querySelector(`[data-id="${CSS.escape(data.id)}"]`));
    if (row && entry) {
        renderRow(entry, row);
    }

    updateTabBadge();
}

// ── Message listener ────────────────────────────────────────────────

bridge.onMessage((data) => {
    if (data.type === 'state-update' || data.type === 'queue-update') {
        const newEntries = data.type === 'state-update' ? data.queue : data.entries;
        if (Array.isArray(newEntries)) {
            entries = newEntries;
            renderQueue();
        }
    } else if (data.type === 'download-progress') {
        handleProgress(data);
    } else if (data.type === 'download-status') {
        handleStatus(data);
    }
});
