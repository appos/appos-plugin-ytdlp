/**
 * WebView ↔ Plugin bridge — thin wrapper over the host-injected `window.twopanez` object.
 *
 * The AppOS host injects `window.twopanez` at document start (before any module runs).
 * This module wraps it in a stable API so panel scripts don't depend on the raw global.
 *
 * Host bridge shape (from PluginWebViewBridge.swift):
 *   window.twopanez.send(msg)       — fire-and-forget (WKScriptMessageHandler "twopanez")
 *   window.twopanez.request(msg)    — async reply (WKScriptMessageHandlerWithReply "twopanezReply")
 *   window.twopanez.onMessage(fn)   — subscribe to inbound messages via _emit()
 *   window.twopanez.instanceId      — read-only, per-WKWebView UUID
 *   window.twopanez.windowId        — read-only, app window ID
 *   window.twopanez.paneId          — read-only, "left" or "right"
 *
 * Protocol: fire-and-forget only in v1. No request/response correlation in the bridge
 * (correlation is application-level via message types, e.g., probe-url → probe-result).
 *
 * Shell chunks: pipeShellToWebPanel sends chunks through _emit() alongside regular
 * messages. Chunks have { stream, data, bytesTotal } shape (no `v` or `type` field).
 * onShellChunk() filters for these; onMessage() filters them OUT.
 *
 * CSP: All JS loaded as external modules via <script type="module"> — no inline scripts.
 *
 * @module webview/shared/bridge
 */

const PROTOCOL_VERSION = 1;

/** @typedef {import('../../src/types/webview-messages').PanelOutboundMessage} PanelOutboundMessage */
/** @typedef {{ stream: string, data: string, bytesTotal: number }} ShellChunk */

/**
 * @param {unknown} data
 * @returns {data is ShellChunk}
 */
function isShellChunk(data) {
    return (
        typeof data === 'object' &&
        data !== null &&
        'stream' in data &&
        'data' in data &&
        !('v' in data)
    );
}

/**
 * Envelope-only guard (v + string type) — payload shapes are validated by
 * each panel's handler, mirroring `validateInbound` in messages.js.
 * @param {unknown} data
 * @returns {data is PanelOutboundMessage}
 */
function isProtocolMessage(data) {
    const m = /** @type {{ v?: unknown, type?: unknown } | null} */ (data);
    return (
        typeof m === 'object' &&
        m !== null &&
        m.v === PROTOCOL_VERSION &&
        typeof m.type === 'string'
    );
}

/** @type {Array<(chunk: ShellChunk) => void>} */
const _shellListeners = [];

/** @type {Array<(msg: PanelOutboundMessage) => void>} */
const _messageListeners = [];

// Wire up once — split _emit traffic between shell chunks and protocol messages.
if (window.twopanez) {
    window.twopanez.onMessage((data) => {
        if (isShellChunk(data)) {
            for (const fn of [..._shellListeners]) {
                try { fn(data); } catch (e) { console.error('[yt-dlp bridge] shell listener error:', e); }
            }
            return;
        }

        // Version + type guard: drop malformed messages
        if (!isProtocolMessage(data)) {
            console.warn('[yt-dlp bridge] Dropped malformed inbound (missing v:' + PROTOCOL_VERSION + ' or type)', typeof data);
            return;
        }

        for (const fn of [..._messageListeners]) {
            try { fn(data); } catch (e) { console.error('[yt-dlp bridge] message listener error:', e); }
        }
    });
}

export const bridge = {
    /**
     * Send a fire-and-forget message from webview to plugin.
     * @param {object} message — should be built with msg() from messages.js
     */
    send(message) {
        if (window.twopanez) {
            window.twopanez.send(message);
        } else {
            console.warn('[yt-dlp bridge] Bridge not available — running outside AppOS?');
        }
    },

    /**
     * Subscribe to inbound protocol messages (all types, v:1 only).
     * Shell chunks are excluded — use onShellChunk() for those.
     * @param {(msg: PanelOutboundMessage) => void} handler
     * @returns {() => void} Unsubscribe function
     */
    onMessage(handler) {
        _messageListeners.push(handler);
        return () => {
            const idx = _messageListeners.indexOf(handler);
            if (idx !== -1) _messageListeners.splice(idx, 1);
        };
    },

    /**
     * Subscribe to streaming shell chunks from pipeShellToWebPanel.
     * @param {(chunk: ShellChunk) => void} handler
     * @returns {() => void} Unsubscribe function
     */
    onShellChunk(handler) {
        _shellListeners.push(handler);
        return () => {
            const idx = _shellListeners.indexOf(handler);
            if (idx !== -1) _shellListeners.splice(idx, 1);
        };
    },

    /**
     * Returns context info injected by the host.
     * @returns {{ instanceId: string, windowId: string, paneId: string } | null}
     */
    getContext() {
        if (!window.twopanez) return null;
        return {
            instanceId: window.twopanez.instanceId,
            windowId: window.twopanez.windowId,
            paneId: window.twopanez.paneId,
        };
    },
};
