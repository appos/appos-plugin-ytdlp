/**
 * Library panel webview application.
 *
 * Displays completed downloads with metadata, thumbnails, and actions.
 * Supports grid/list view toggle, search (debounced 250ms), sort, and
 * favorites-only filtering.
 *
 * Virtualization scope (v1):
 *   - List mode: windowed render when filtered list > 200 items.
 *     Uses fixed row height (49px) with 10-row buffer above/below.
 *     Spacer heights driven by CSS custom properties on the container,
 *     referenced by rules in the external stylesheet (CSP-compliant).
 *   - Grid mode: relies on CSS `content-visibility: auto` on cards.
 *     No explicit window math because grid cards have variable heights
 *     (long titles wrap). If grid exceeds 500 items in practice,
 *     add dedicated grid virtualization in v1.1.
 *   - List mode below threshold also uses content-visibility: auto.
 *
 * Thumbnails: Remote HTTPS URLs load directly via <img src>. file://
 * thumbnails may be blocked by CSP -- the UI falls back to a placeholder.
 * Host-side caching via cache.set('ytdlp:thumb:...') is a v1.1 optimization.
 *
 * CSP: All JS loaded as <script type="module"> -- no inline scripts.
 * All styling via CSS classes. Virtualization spacer heights driven by
 * CSS custom properties on the container, referenced by external stylesheet.
 *
 * @module webview/library/app
 */

import { bridge } from '../shared/bridge.js';
import { msg, validateInbound } from '../shared/messages.js';
import { renderDegradedBanner } from '../shared/degraded-banner.js';
import { debouncedInput, renderList, escapeHtml } from '../shared/ui-helpers.js';

/** @typedef {import('../../src/types/plugin-state').LibraryEntry} LibraryEntry */

// ── Constants ─────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 250;

// ── DOM refs ──────────────────────────────────────────────────────

const bannerSlot = /** @type {HTMLElement} */ (document.getElementById('degraded-banner'));
const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
const sortSelect = /** @type {HTMLSelectElement} */ (document.getElementById('sort-select'));
const viewBtns = /** @type {NodeListOf<HTMLButtonElement>} */ (
    document.querySelectorAll('[data-view]')
);
const favsCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('favs-checkbox'));
const container = /** @type {HTMLElement} */ (document.getElementById('library-container'));
const emptyState = /** @type {HTMLElement} */ (document.getElementById('empty-state'));
const deleteDialog = /** @type {HTMLDialogElement} */ (document.getElementById('delete-confirm-dialog'));
const deleteMsg = /** @type {HTMLElement} */ (document.getElementById('delete-confirm-msg'));
const deleteCancelBtn = /** @type {HTMLElement} */ (document.getElementById('delete-confirm-cancel'));
const deleteOkBtn = /** @type {HTMLElement} */ (document.getElementById('delete-confirm-ok'));

// ── State ─────────────────────────────────────────────────────────

/** @type {LibraryEntry[]} */
let items = [];
let view = 'grid';
let sort = 'newest';
let search = '';
let favsOnly = false;

/**
 * Pending delete-from-disk item ID
 * @type {string | null}
 */
let pendingDeleteId = null;

/**
 * Fingerprint of the last rendered library snapshot.
 * Used to skip redundant re-renders when library-update broadcasts
 * carry unchanged data (e.g. queue-only state mutations).
 */
let lastLibraryFingerprint = '';

/**
 * Compute a collision-safe fingerprint of library items covering every
 * field that affects filtering, sorting, or rendering.
 *
 * Uses JSON.stringify with a fixed key tuple per item so delimiter
 * characters inside metadata values (titles, URLs) cannot cause
 * false matches between different states.
 *
 * @param {LibraryEntry[]} arr
 * @returns {string}
 */
function libraryFingerprint(arr) {
    return JSON.stringify(arr.map((item) => [
        item.id,
        item.favorite,
        item.title,
        item.uploader,
        item.thumbnailUrl,
        item.fileSize,
        item.duration,
        item.downloadedAt,
    ]));
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Format seconds to mm:ss or hh:mm:ss.
 * @param {number|undefined} secs
 * @returns {string}
 */
function formatDuration(secs) {
    if (secs == null || secs <= 0) return '';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Format bytes to human-readable size.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

/**
 * Format ISO date string to short display.
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return '';
    }
}

// ── Filter + Sort ─────────────────────────────────────────────────

/**
 * Filter and sort library items based on current UI state.
 * @returns {LibraryEntry[]}
 */
function getFilteredItems() {
    let result = items;

    // Favorites filter
    if (favsOnly) {
        result = result.filter((item) => item.favorite);
    }

    // Search filter (case-insensitive on title + uploader)
    if (search) {
        const q = search.toLowerCase();
        result = result.filter((item) => {
            const title = (item.title || '').toLowerCase();
            const uploader = (item.uploader || '').toLowerCase();
            return title.includes(q) || uploader.includes(q);
        });
    }

    // Sort
    result = [...result];
    switch (sort) {
        case 'newest':
            result.sort((a, b) => (b.downloadedAt || '').localeCompare(a.downloadedAt || ''));
            break;
        case 'title':
            result.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
            break;
        case 'size':
            result.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0));
            break;
        case 'duration':
            result.sort((a, b) => (b.duration || 0) - (a.duration || 0));
            break;
    }

    return result;
}

// ── Context menu ──────────────────────────────────────────────────

/**
 * Create a context menu (details/summary disclosure widget) for a library item.
 * Menu items reachable via Tab; closes on blur/outside-click.
 *
 * @param {LibraryEntry} item
 * @returns {HTMLDetailsElement}
 */
function createContextMenu(item) {
    const details = document.createElement('details');
    details.className = 'yt-ctx-menu';

    const summary = document.createElement('summary');
    summary.textContent = '\u22EF'; // horizontal ellipsis
    summary.setAttribute('aria-label', 'Actions for ' + (item.title || 'item'));
    details.appendChild(summary);

    const list = document.createElement('ul');
    list.className = 'yt-ctx-menu__list';

    const actions = [
        { label: 'Play', type: 'play-file' },
        { label: 'Show in Files pane', type: 'reveal-file' },
        { label: 'Copy source URL', type: 'copy-url' },
        { label: 'Download again', type: 'redownload' },
        { label: item.favorite ? 'Remove from favorites' : 'Add to favorites', type: 'toggle-favorite' },
        { divider: true },
        { label: 'Remove from library', type: 'delete-item', destructive: false },
        { label: 'Delete from disk', type: 'delete-item-disk', destructive: true },
    ];

    for (const action of actions) {
        if (action.divider) {
            const div = document.createElement('li');
            div.className = 'yt-ctx-menu__divider';
            div.setAttribute('aria-hidden', 'true');
            list.appendChild(div);
            continue;
        }

        const li = document.createElement('li');
        li.className = 'yt-ctx-menu__item' + (action.destructive ? ' yt-ctx-menu__item--danger' : '');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'yt-ctx-menu__btn';
        btn.textContent = action.label ?? '';

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            details.open = false;

            if (action.type === 'delete-item-disk') {
                showDeleteConfirm(item);
            } else if (action.type === 'delete-item') {
                bridge.send(msg('delete-item', { id: item.id }));
            } else {
                bridge.send(msg(action.type ?? '', { id: item.id }));
            }
        });

        li.appendChild(btn);
        list.appendChild(li);
    }

    details.appendChild(list);

    // Close on outside click, focusout, and Escape
    const closeOnOutside = (/** @type {MouseEvent} */ e) => {
        if (!details.contains(/** @type {Node | null} */ (e.target))) {
            details.open = false;
        }
    };

    let focusOutFrame = 0;

    const closeOnFocusOut = () => {
        // Cancel any pending frame to avoid stacking
        if (focusOutFrame) cancelAnimationFrame(focusOutFrame);
        focusOutFrame = requestAnimationFrame(() => {
            focusOutFrame = 0;
            if (!details.contains(document.activeElement)) {
                details.open = false;
            }
        });
    };

    const closeOnEscape = (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Escape') {
            details.open = false;
            // Return focus to the summary trigger
            summary.focus();
        }
    };

    let openFrame = 0;

    details.addEventListener('toggle', () => {
        if (details.open) {
            // Defer to avoid catching the opening click
            openFrame = requestAnimationFrame(() => {
                openFrame = 0;
                document.addEventListener('click', closeOnOutside, { capture: true });
            });
            details.addEventListener('focusout', closeOnFocusOut);
            details.addEventListener('keydown', closeOnEscape);
        } else {
            // Cancel pending frames to prevent leaked listeners
            if (openFrame) { cancelAnimationFrame(openFrame); openFrame = 0; }
            if (focusOutFrame) { cancelAnimationFrame(focusOutFrame); focusOutFrame = 0; }
            document.removeEventListener('click', closeOnOutside, { capture: true });
            details.removeEventListener('focusout', closeOnFocusOut);
            details.removeEventListener('keydown', closeOnEscape);
        }
    });

    return details;
}

// ── Delete confirmation dialog ────────────────────────────────────

/**
 * Show the native dialog to confirm "delete from disk".
 * @param {LibraryEntry} item
 */
function showDeleteConfirm(item) {
    pendingDeleteId = item.id;
    deleteMsg.textContent = 'Permanently delete "' + (item.title || 'this file') + '" from disk?';
    deleteDialog.showModal();
}

deleteCancelBtn.addEventListener('click', () => {
    pendingDeleteId = null;
    deleteDialog.close();
});

deleteOkBtn.addEventListener('click', () => {
    if (pendingDeleteId) {
        bridge.send(msg('delete-item', { id: pendingDeleteId, deleteFromDisk: true }));
        pendingDeleteId = null;
    }
    deleteDialog.close();
});

// Close dialog on ESC (native behavior for <dialog>)
deleteDialog.addEventListener('cancel', () => {
    pendingDeleteId = null;
});

// ── Grid card rendering ───────────────────────────────────────────

/**
 * Create a grid card element for a library item.
 * @param {LibraryEntry} item
 * @returns {HTMLElement}
 */
function createGridCard(item) {
    const card = document.createElement('div');
    card.className = 'yt-lib-card';
    card.setAttribute('data-key', item.id);
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', item.title || 'Library item');

    // Thumbnail
    const thumbDiv = document.createElement('div');
    thumbDiv.className = 'yt-lib-card__thumb';

    if (item.thumbnailUrl) {
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            img.remove();
            const ph = document.createElement('div');
            ph.className = 'yt-lib-card__thumb-placeholder';
            ph.textContent = '\uD83C\uDFA5'; // film camera emoji
            thumbDiv.appendChild(ph);
        });
        thumbDiv.appendChild(img);
    } else {
        const ph = document.createElement('div');
        ph.className = 'yt-lib-card__thumb-placeholder';
        ph.textContent = '\uD83C\uDFA5';
        thumbDiv.appendChild(ph);
    }

    // Duration badge
    const dur = formatDuration(item.duration);
    if (dur) {
        const badge = document.createElement('span');
        badge.className = 'yt-lib-card__duration';
        badge.textContent = dur;
        thumbDiv.appendChild(badge);
    }

    card.appendChild(thumbDiv);

    // Body: title
    const body = document.createElement('div');
    body.className = 'yt-lib-card__body';

    const titleEl = document.createElement('div');
    titleEl.className = 'yt-lib-card__title';
    titleEl.textContent = item.title || 'Untitled';
    body.appendChild(titleEl);

    card.appendChild(body);

    // Footer: favorite + menu
    const footer = document.createElement('div');
    footer.className = 'yt-lib-card__footer';

    const favBtn = document.createElement('button');
    favBtn.className = 'yt-lib-card__fav' + (item.favorite ? ' yt-lib-card__fav--active' : '');
    favBtn.type = 'button';
    favBtn.setAttribute('aria-label', item.favorite ? 'Remove from favorites' : 'Add to favorites');
    favBtn.textContent = item.favorite ? '\u2605' : '\u2606'; // filled/empty star
    favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        bridge.send(msg('toggle-favorite', { id: item.id }));
    });
    footer.appendChild(favBtn);

    const menu = createContextMenu(item);
    footer.appendChild(menu);

    card.appendChild(footer);

    // Card click -> play
    card.addEventListener('click', (e) => {
        // Don't trigger play if user clicked a button or the context menu
        const target = /** @type {HTMLElement} */ (e.target);
        if (target.closest('button') || target.closest('.yt-ctx-menu')) return;
        bridge.send(msg('play-file', { id: item.id }));
    });

    // Keyboard: Enter/Space on card -> play
    card.addEventListener('keydown', (e) => {
        if (e.target !== card) return; // only when card itself is focused
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            bridge.send(msg('play-file', { id: item.id }));
        }
    });

    return card;
}

// ── List row rendering ────────────────────────────────────────────

/**
 * Create a list row element for a library item.
 * @param {LibraryEntry} item
 * @returns {HTMLElement}
 */
function createListRow(item) {
    const row = document.createElement('div');
    row.className = 'yt-lib-row';
    row.setAttribute('data-key', item.id);
    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', item.title || 'Library item');

    // Thumbnail
    const thumbDiv = document.createElement('div');
    thumbDiv.className = 'yt-lib-row__thumb';

    if (item.thumbnailUrl) {
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => { img.remove(); });
        thumbDiv.appendChild(img);
    }

    row.appendChild(thumbDiv);

    // Info
    const info = document.createElement('div');
    info.className = 'yt-lib-row__info';

    const titleEl = document.createElement('div');
    titleEl.className = 'yt-lib-row__title';
    titleEl.textContent = item.title || 'Untitled';
    info.appendChild(titleEl);

    const parts = [];
    if (item.uploader) parts.push(item.uploader);
    if (item.fileSize) parts.push(formatSize(item.fileSize));
    if (item.downloadedAt) parts.push(formatDate(item.downloadedAt));
    if (parts.length > 0) {
        const metaEl = document.createElement('div');
        metaEl.className = 'yt-lib-row__meta';
        metaEl.textContent = parts.join(' \u00B7 ');
        info.appendChild(metaEl);
    }

    row.appendChild(info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'yt-lib-row__actions';

    const favBtn = document.createElement('button');
    favBtn.className = 'yt-lib-card__fav' + (item.favorite ? ' yt-lib-card__fav--active' : '');
    favBtn.type = 'button';
    favBtn.setAttribute('aria-label', item.favorite ? 'Remove from favorites' : 'Add to favorites');
    favBtn.textContent = item.favorite ? '\u2605' : '\u2606';
    favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        bridge.send(msg('toggle-favorite', { id: item.id }));
    });
    actions.appendChild(favBtn);

    const menu = createContextMenu(item);
    actions.appendChild(menu);

    row.appendChild(actions);

    // Row click -> play (same guard as grid)
    row.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target.closest('button') || target.closest('.yt-ctx-menu')) return;
        bridge.send(msg('play-file', { id: item.id }));
    });

    row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            bridge.send(msg('play-file', { id: item.id }));
        }
    });

    return row;
}

// ── Render ────────────────────────────────────────────────────────

/**
 * Track scroll listener for virtualization teardown.
 * @type {(() => void) | null}
 */
let scrollCleanup = null;

/** Threshold for windowed list virtualization (item count). */
const VIRTUAL_THRESHOLD = 200;
/** Buffer rows above/below the visible viewport window. */
const VIRTUAL_BUFFER = 10;
/** Must match .yt-lib-row { block-size } in styles.css (49px). */
const LIST_ROW_HEIGHT = 49;

/**
 * Main render function -- updates the library container.
 * Called on data changes (state-update, library-update) without
 * resetting scroll position to preserve the user's place.
 */
/**
 * Close any open context menus before DOM mutations. Ensures document-level
 * listeners attached by `<details>` toggle handlers are properly cleaned up
 * even when the owning DOM node is about to be removed by rerender.
 */
function closeOpenMenus() {
    const openMenus = /** @type {NodeListOf<HTMLDetailsElement>} */ (
        container.querySelectorAll('details.yt-ctx-menu[open]')
    );
    for (const menu of openMenus) {
        menu.open = false;
    }
}

function render() {
    // Close open context menus to tear down their document-level listeners
    closeOpenMenus();

    // Clean up previous virtualization scroll listener
    if (scrollCleanup) {
        scrollCleanup();
        scrollCleanup = null;
    }

    const filtered = getFilteredItems();

    // Empty state
    if (filtered.length === 0) {
        container.hidden = true;
        emptyState.hidden = false;
        return;
    }

    container.hidden = false;
    emptyState.hidden = true;

    if (view === 'grid') {
        renderGrid(filtered);
    } else {
        renderListMode(filtered);
    }
}

/**
 * Render with scroll reset -- called when the user changes search,
 * sort, view mode, or favorites filter. Passive data updates (e.g.
 * toggling a favorite, background library-update) call render()
 * without reset so the user's scroll position is preserved.
 */
function renderWithReset() {
    container.scrollTop = 0;
    render();
}

/**
 * Render grid view using keyed renderList for add/remove/reorder diffing.
 * Cards use CSS `content-visibility: auto` for soft virtualization.
 *
 * Always creates fresh cards rather than partial in-place updates, because
 * library entries have many display fields (thumbnail, duration, title,
 * uploader, metadata) and partial reconciliation risks leaving stale data.
 * renderList handles keyed add/remove/reorder efficiently; the per-item
 * cost of recreating a card is low (no network requests -- thumbnails
 * reload from cache on re-render).
 *
 * @param {LibraryEntry[]} filtered
 */
function renderGrid(filtered) {
    container.className = 'yt-library-container yt-library-container--grid';

    renderList(container, filtered, {
        getKey: (item) => item.id,
        render: (item, _existing) => createGridCard(item),
    });
}

/**
 * Render list view. Uses keyed renderList for small lists; switches
 * to windowed virtualization above VIRTUAL_THRESHOLD items.
 *
 * Like renderGrid, always creates fresh rows to ensure full
 * reconciliation of all displayed fields.
 *
 * @param {LibraryEntry[]} filtered
 */
function renderListMode(filtered) {
    container.className = 'yt-library-container yt-library-container--list';

    if (filtered.length > VIRTUAL_THRESHOLD) {
        renderVirtualList(filtered);
        return;
    }

    // Non-windowed keyed render for small lists. Rows use CSS
    // content-visibility: auto for soft virtualization.
    renderList(container, filtered, {
        getKey: (item) => item.id,
        render: (item, _existing) => createListRow(item),
    });
}

/**
 * Windowed list render for large datasets (> 200 items).
 *
 * Uses fixed row height with spacer divs above/below the visible window.
 * Buffer: VIRTUAL_BUFFER rows above and below the viewport. Spacer
 * heights are driven by CSS custom properties on the container element,
 * referenced by rules in the external stylesheet (CSP-compliant -- no
 * dynamic <style> injection or inline style= attributes).
 *
 * @param {LibraryEntry[]} filtered
 */
function renderVirtualList(filtered) {
    /**
     * Render the visible window based on current scroll position.
     */
    function renderWindow() {
        closeOpenMenus();
        const scrollTop = container.scrollTop;
        const viewportHeight = container.clientHeight;

        const maxIdx = Math.max(0, filtered.length - 1);
        const firstVisible = Math.min(Math.floor(scrollTop / LIST_ROW_HEIGHT), maxIdx);
        const lastVisible = Math.min(
            Math.ceil((scrollTop + viewportHeight) / LIST_ROW_HEIGHT),
            filtered.length,
        );

        const startIdx = Math.max(0, firstVisible - VIRTUAL_BUFFER);
        const endIdx = Math.min(filtered.length, lastVisible + VIRTUAL_BUFFER);

        // Compute spacer heights
        const topHeight = startIdx * LIST_ROW_HEIGHT;
        const bottomHeight = Math.max(0, (filtered.length - endIdx) * LIST_ROW_HEIGHT);

        // Set spacer sizes via CSS custom properties on the container.
        // The external stylesheet references --yt-spacer-top/--yt-spacer-bottom
        // on .yt-list-spacer--top/--bottom (no <style> injection needed).
        container.style.setProperty('--yt-spacer-top', topHeight + 'px');
        container.style.setProperty('--yt-spacer-bottom', bottomHeight + 'px');

        // Clear and rebuild
        while (container.firstChild) container.firstChild.remove();

        // Top spacer
        if (topHeight > 0) {
            const topSpacer = document.createElement('div');
            topSpacer.className = 'yt-list-spacer yt-list-spacer--top';
            container.appendChild(topSpacer);
        }

        // Visible rows
        const fragment = document.createDocumentFragment();
        for (let i = startIdx; i < endIdx; i++) {
            fragment.appendChild(createListRow(filtered[i]));
        }
        container.appendChild(fragment);

        // Bottom spacer
        if (bottomHeight > 0) {
            const bottomSpacer = document.createElement('div');
            bottomSpacer.className = 'yt-list-spacer yt-list-spacer--bottom';
            container.appendChild(bottomSpacer);
        }
    }

    renderWindow();

    // Throttled scroll handler via rAF
    let rafId = 0;
    const onScroll = () => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(renderWindow);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    scrollCleanup = () => {
        container.removeEventListener('scroll', onScroll);
        cancelAnimationFrame(rafId);
        // Clear custom properties when exiting windowed mode
        container.style.removeProperty('--yt-spacer-top');
        container.style.removeProperty('--yt-spacer-bottom');
    };
}

// ── View toggle ───────────────────────────────────────────────────

for (const btn of viewBtns) {
    btn.addEventListener('click', () => {
        const newView = btn.getAttribute('data-view');
        // null guard is type-level only: viewBtns are selected BY [data-view]
        if (newView === null || newView === view) return;
        view = newView;

        for (const b of viewBtns) {
            const isActive = b.getAttribute('data-view') === view;
            b.classList.toggle('yt-view-btn--active', isActive);
            b.setAttribute('aria-checked', String(isActive));
        }

        renderWithReset();
    });
}

// ── Sort ──────────────────────────────────────────────────────────

sortSelect.addEventListener('change', () => {
    sort = sortSelect.value;
    renderWithReset();
});

// ── Search (debounced 250ms) ──────────────────────────────────────

debouncedInput(searchInput, SEARCH_DEBOUNCE_MS, (value) => {
    search = value;
    renderWithReset();
});

// ── Favorites toggle ──────────────────────────────────────────────

favsCheckbox.addEventListener('change', () => {
    favsOnly = favsCheckbox.checked;
    renderWithReset();
});

// ── Message handling ──────────────────────────────────────────────

bridge.onMessage((raw) => {
    const validated = validateInbound(raw);
    if (!validated) return;

    switch (validated.type) {
        case 'state-update': {
            const newItems = validated.library || [];
            const fp = libraryFingerprint(newItems);
            if (fp !== lastLibraryFingerprint) {
                items = newItems;
                lastLibraryFingerprint = fp;
                render();
            }
            // Always render degraded banner (dependency data may change
            // even when library is unchanged)
            if (validated.dependencyStatuses) {
                renderDegradedBanner(bannerSlot, validated.dependencyStatuses, {
                    onRecheck: () => bridge.send(msg('recheck-dependencies')),
                });
            }
            break;
        }

        case 'library-update': {
            const newItems = validated.entries || [];
            const fp = libraryFingerprint(newItems);
            if (fp !== lastLibraryFingerprint) {
                items = newItems;
                lastLibraryFingerprint = fp;
                render();
            }
            break;
        }

        case 'dependency-status':
        case 'dependency-banner':
            if (validated.statuses) {
                renderDegradedBanner(bannerSlot, validated.statuses, {
                    onRecheck: () => bridge.send(msg('recheck-dependencies')),
                });
            }
            break;
    }
});

// ── Init: request state on DOM-ready ──────────────────────────────

bridge.send(msg('request-state'));
