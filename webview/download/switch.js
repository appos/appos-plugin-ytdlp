/**
 * Tab switching controller for the download panel's form/queue views.
 *
 * Wires tab button clicks and keyboard navigation (ArrowLeft, ArrowRight,
 * Enter, Space) to toggle `aria-selected` and `hidden` attributes on the
 * two `<section>` tabpanels. Moves focus to the first focusable element
 * in the newly-visible view on switch.
 *
 * Auto-switch rule: on the first `queue-update` with a non-empty queue
 * while the form view is active, automatically switches to the queue view
 * so users see download progress immediately. Tracked per session to
 * avoid fighting the user if they manually switch back.
 *
 * @module webview/download/switch
 */

import { bridge } from '../shared/bridge.js';
import { msg } from '../shared/messages.js';

// ── DOM references ──────────────────────────────────────────────────

const tabs = /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll('.yt-tabs [role="tab"]')
);
const formPanel = document.getElementById('view-form');
const queuePanel = document.getElementById('view-queue');

// ── State ───────────────────────────────────────────────────────────

/** Track whether we've already auto-switched this session. */
let hasAutoSwitched = false;

// ── Switch logic ────────────────────────────────────────────────────

/**
 * Switch to the given view ('form' or 'queue').
 * Updates ARIA attributes, toggles panel visibility, moves focus,
 * and notifies the plugin.
 *
 * @param {'form' | 'queue'} view
 */
function switchTo(view) {
    for (const tab of tabs) {
        const isSelected = tab.getAttribute('data-view') === view;
        tab.setAttribute('aria-selected', String(isSelected));
        tab.setAttribute('tabindex', isSelected ? '0' : '-1');
    }

    if (formPanel) formPanel.hidden = view !== 'form';
    if (queuePanel) queuePanel.hidden = view !== 'queue';

    // Move focus to the first focusable element in the visible panel
    const activePanel = view === 'form' ? formPanel : queuePanel;
    if (activePanel) {
        const focusable = activePanel.querySelector(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable && typeof focusable.focus === 'function') {
            focusable.focus();
        }
    }

    // Notify plugin (fire-and-forget for telemetry/logging)
    bridge.send(msg('toggle-view', { view }));
}

/** Get the currently active view. */
function activeView() {
    if (formPanel && !formPanel.hidden) return 'form';
    return 'queue';
}

// ── Tab click handler ───────────────────────────────────────────────

for (const tab of tabs) {
    tab.addEventListener('click', () => {
        const view = tab.getAttribute('data-view');
        if (view === 'form' || view === 'queue') {
            switchTo(view);
        }
    });
}

// ── Keyboard navigation ─────────────────────────────────────────────

const tabList = document.querySelector('.yt-tabs[role="tablist"]');
if (tabList) {
    tabList.addEventListener('keydown', (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        const tabArray = Array.from(tabs);
        const currentIndex = tabArray.findIndex(
            (t) => t.getAttribute('aria-selected') === 'true',
        );

        let newIndex = -1;
        if (key === 'ArrowLeft') {
            newIndex = currentIndex > 0 ? currentIndex - 1 : tabArray.length - 1;
        } else if (key === 'ArrowRight') {
            newIndex = currentIndex < tabArray.length - 1 ? currentIndex + 1 : 0;
        } else if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            const view = tabArray[currentIndex]?.getAttribute('data-view');
            if (view === 'form' || view === 'queue') {
                switchTo(view);
            }
            return;
        }

        if (newIndex >= 0) {
            e.preventDefault();
            const view = tabArray[newIndex]?.getAttribute('data-view');
            if (view === 'form' || view === 'queue') {
                tabArray[newIndex].focus();
                switchTo(view);
            }
        }
    });
}

// ── Auto-switch on first enqueue ────────────────────────────────────

bridge.onMessage((data) => {
    // Auto-switch to queue view when the first non-empty queue arrives
    // while the form is still visible. Only fires once per session.
    if (
        !hasAutoSwitched &&
        activeView() === 'form' &&
        (data.type === 'queue-update' || data.type === 'state-update')
    ) {
        const queueEntries = data.type === 'queue-update' ? data.entries : data.queue;
        if (Array.isArray(queueEntries) && queueEntries.length > 0) {
            hasAutoSwitched = true;
            switchTo('queue');
        }
    }
});
