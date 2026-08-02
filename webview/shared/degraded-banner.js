/**
 * Degraded-state banner — renders a dismissible warning when yt-dlp or
 * other required dependencies are missing or outdated.
 *
 * Consumes DependencyStatus[] from the plugin's dependency-status message.
 * Hides automatically when all required deps report satisfied.
 *
 * Accessibility: role="status" aria-live="polite" so screen readers
 * announce changes without interrupting the user.
 *
 * CSP: Loaded as <script type="module"> — no inline scripts.
 *
 * @module webview/shared/degraded-banner
 */

/**
 * Canonical dependency-status shape — what the plugin actually broadcasts
 * (`ctx.lifecycle.getDependencyStatus()` rows, see src/main.ts). The install
 * hint field on the wire is `installHint`, NOT `hint`.
 * @typedef {import('../../src/types/plugin-state').DependencyStatus} DependencyStatus
 */

/**
 * Render (or update) a degraded-state banner inside a container element.
 *
 * If all statuses are satisfied, the banner is hidden. If any are missing,
 * it shows which deps are unavailable and provides an "I installed it, re-check" button.
 *
 * @param {HTMLElement} container - Parent element to render the banner into
 * @param {DependencyStatus[]} statuses - Current dependency statuses
 * @param {{ onRecheck: () => void }} options - Callback when user clicks re-check
 *
 * @example
 * import { renderDegradedBanner } from '../shared/degraded-banner.js';
 * renderDegradedBanner(document.getElementById('banner-slot'), statuses, {
 *     onRecheck: () => bridge.send(msg('recheck-dependencies')),
 * });
 */
export function renderDegradedBanner(container, statuses, { onRecheck }) {
    const missing = statuses.filter((s) => !s.satisfied);

    // Find or create the banner element
    let banner = /** @type {HTMLElement | null} */ (container.querySelector('.yt-degraded-banner'));

    if (missing.length === 0) {
        if (banner) banner.hidden = true;
        return;
    }

    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'yt-degraded-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        container.prepend(banner);
    }

    banner.hidden = false;

    // Clear previous content safely
    while (banner.firstChild) banner.firstChild.remove();

    // Build content using safe DOM methods (no raw innerHTML)
    const contentDiv = document.createElement('div');
    contentDiv.className = 'yt-degraded-banner__content';

    const strong = document.createElement('strong');
    const depNames = missing.map((d) => d.name).join(', ');
    strong.textContent = 'Missing: ' + depNames;
    contentDiv.appendChild(strong);

    // Wire field is `installHint` (canonical DependencyStatus) — the previous
    // `d.hint` read did not exist on the broadcast payload, so hints never
    // rendered. Caught by strict checkJs (fn-180).
    const hints = missing.map((d) => d.installHint).filter((h) => h !== undefined);
    if (hints.length > 0) {
        const p = document.createElement('p');
        p.className = 'yt-degraded-banner__hints';
        hints.forEach((hint, i) => {
            if (i > 0) p.appendChild(document.createElement('br'));
            p.appendChild(document.createTextNode(hint));
        });
        contentDiv.appendChild(p);
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'yt-degraded-banner__actions';

    const recheckBtn = document.createElement('button');
    recheckBtn.className = 'yt-button yt-button--secondary yt-degraded-banner__recheck';
    recheckBtn.type = 'button';
    recheckBtn.textContent = 'I installed it \u2014 re-check';
    recheckBtn.addEventListener('click', onRecheck);

    actionsDiv.appendChild(recheckBtn);
    contentDiv.appendChild(actionsDiv);
    banner.appendChild(contentDiv);
}
