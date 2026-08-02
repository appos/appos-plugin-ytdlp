/**
 * Small vanilla-JS UI helpers shared by both download and library panels.
 *
 * No external dependencies. All helpers are pure functions or thin wrappers.
 *
 * CSP: Loaded as <script type="module"> — no inline scripts.
 *
 * @module webview/shared/ui-helpers
 */

/**
 * Debounce text input events on an element.
 *
 * @param {HTMLInputElement} el - Input element to observe
 * @param {number} ms - Debounce delay in milliseconds
 * @param {(value: string) => void} onValue - Callback with the current value
 * @returns {() => void} Cleanup function that removes the listener
 *
 * @example
 * const cleanup = debouncedInput(urlInput, 300, (val) => {
 *     bridge.send(msg('probe-url', { url: val }));
 * });
 */
export function debouncedInput(el, ms, onValue) {
    let timer = 0;
    const handler = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => onValue(el.value), ms);
    };
    el.addEventListener('input', handler);
    return () => {
        clearTimeout(timer);
        el.removeEventListener('input', handler);
    };
}

/**
 * Throttle rapid function calls — at most one invocation per `ms` milliseconds.
 *
 * @param {number} ms - Minimum interval between calls
 * @param {(...args: any[]) => void} fn - Function to throttle
 * @returns {(...args: any[]) => void} Throttled function
 *
 * @example
 * const throttled = throttleEmit(100, (progress) => {
 *     updateProgressBar(progress);
 * });
 */
export function throttleEmit(ms, fn) {
    let last = 0;
    let timer = 0;
    return (...args) => {
        const now = Date.now();
        const remaining = ms - (now - last);
        clearTimeout(timer);
        if (remaining <= 0) {
            last = now;
            fn(...args);
        } else {
            timer = window.setTimeout(() => {
                last = Date.now();
                fn(...args);
            }, remaining);
        }
    };
}

/**
 * Keyed list rendering with add/remove/update diffing.
 *
 * Each item must have a unique key (via `getKey`). On re-render:
 * - New keys get elements appended
 * - Removed keys get elements removed
 * - Existing keys get their elements updated in place via `render`
 *
 * @param {HTMLElement} container - Parent element for list items
 * @param {T[]} items - Array of data items
 * @param {{ getKey: (item: T) => string, render: (item: T, el: HTMLElement | null) => HTMLElement }} options
 *   - `getKey(item)` — return a unique string key
 *   - `render(item, existingEl)` — return the element to display.
 *     If `existingEl` is non-null, update it in place and return it.
 *     If null, create a new element.
 * @template T
 *
 * @example
 * renderList(queueContainer, entries, {
 *     getKey: (e) => e.id,
 *     render: (entry, el) => {
 *         if (!el) { el = document.createElement('div'); }
 *         el.textContent = entry.title;
 *         return el;
 *     },
 * });
 */
export function renderList(container, items, { getKey, render }) {
    // Build a map of existing keyed elements for O(1) lookup
    const existingByKey = new Map();
    for (const child of Array.from(container.children)) {
        const key = child.getAttribute('data-key');
        if (key) existingByKey.set(key, child);
    }

    const newKeys = new Set(items.map(getKey));

    // Remove elements whose keys are gone
    for (const [key, child] of existingByKey) {
        if (!newKeys.has(key)) {
            child.remove();
            existingByKey.delete(key);
        }
    }

    // Add, update, and reorder to match items array
    let nextSibling = null;
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const key = getKey(item);
        const existing = existingByKey.get(key) || null;
        const el = render(item, existing);
        el.setAttribute('data-key', key);

        // insertBefore(el, null) === appendChild — works for new and reordered nodes
        if (el !== nextSibling) {
            container.insertBefore(el, nextSibling);
        }
        nextSibling = el;
    }
}

/**
 * After removing an element from a list, move focus to the next logical element.
 *
 * Tries the next sibling, then the previous sibling, then the parent.
 *
 * @param {HTMLElement} removedEl - The element that was (or will be) removed
 *
 * @example
 * focusNextAfterRemoval(listItem);
 * listItem.remove();
 */
export function focusNextAfterRemoval(removedEl) {
    const next = /** @type {HTMLElement | null} */ (
        removedEl.nextElementSibling || removedEl.previousElementSibling || removedEl.parentElement
    );
    if (next && typeof next.focus === 'function') {
        next.focus();
    }
}

/**
 * Escape a string for safe insertion into HTML.
 *
 * Uses DOM text node serialization to safely escape all HTML special characters.
 * Prefer `el.textContent = str` when possible — this is for cases where
 * HTML interpolation is unavoidable.
 *
 * @param {string} str - Raw string to escape
 * @returns {string} HTML-safe string
 *
 * @example
 * // Safe: input is escaped via DOM textContent before reading back as HTML
 * const safe = escapeHtml(userInput);
 */
export function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;  // safe: textContent→innerHTML round-trip escapes all HTML entities
}
