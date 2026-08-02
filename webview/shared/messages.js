/**
 * WebView message helpers — plain JS consumed by webview panels.
 *
 * Provides typed JSDoc references to the canonical message contract defined in
 * `../../src/types/webview-messages.ts` and runtime envelope utilities for
 * building outbound messages and validating inbound ones.
 *
 * @module webview/shared/messages
 */

/**
 * @typedef {import('../../src/types/webview-messages').PanelOutboundMessage} PanelOutboundMessage
 * @typedef {import('../../src/types/webview-messages').PanelInboundMessage} PanelInboundMessage
 */

/**
 * Build an outbound message (webview → plugin) with the v:1 envelope.
 *
 * @param {string} type - Message type discriminant (e.g. 'probe-url', 'queue-download')
 * @param {Record<string, unknown>} [payload={}] - Message payload fields
 * @returns {{ v: 1, type: string } & Record<string, unknown>}
 */
export function msg(type, payload = {}) {
    return { ...payload, v: 1, type };
}

/**
 * Validate an inbound message envelope (plugin → webview).
 *
 * Performs envelope-only validation: checks for `v: 1` and a string `type`.
 * Does NOT validate individual payload shapes — that is the responsibility
 * of each panel's message handler.
 *
 * **Host envelope handling**: The AppOS host wraps webview messages in
 * `{ data, instanceId, windowId, paneId }`. This function accepts either
 * the raw host envelope (auto-unwraps `.data`) or the inner payload directly,
 * so callers can safely pass `event.data` without manual unwrapping.
 *
 * @param {unknown} raw - Raw message from the host (either the host envelope or the inner payload)
 * @returns {PanelOutboundMessage | null} The validated message, or null if malformed
 */
export function validateInbound(raw) {
    // Unwrap host envelope if present: { data, instanceId, windowId, paneId }
    let payload = raw;
    if (
        typeof raw === 'object' &&
        raw !== null &&
        'data' in raw &&
        'instanceId' in raw
    ) {
        payload = raw.data;
    }

    const m = /** @type {{ v?: unknown, type?: unknown } | null} */ (payload);
    if (
        typeof m === 'object' &&
        m !== null &&
        m.v === 1 &&
        typeof m.type === 'string'
    ) {
        return /** @type {PanelOutboundMessage} */ (m);
    }

    // Log only top-level keys to avoid leaking sensitive payload fields
    const keys = (typeof raw === 'object' && raw !== null) ? Object.keys(raw).join(',') : typeof raw;
    console.warn('[yt-dlp webview] Dropped malformed inbound message (keys: ' + keys + ')');
    return null;
}
