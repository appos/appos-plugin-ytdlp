// webview/twopanez.d.ts — ambient declaration for the host-injected bridge global.
// The AppOS host injects window.twopanez at document start; the published
// @appos.space/plugin-types package does not type it (WebView code is a
// separate compilation world). Authoritative copy:
// appos-plugin-dev/reference/extension-api.md § "WebView-side bridge (window.twopanez)".
interface TwopanezBridge {
    send(message: unknown): void;
    request(message: unknown): Promise<unknown>;
    onMessage(handler: (message: unknown) => void): void;
    readonly instanceId: string;
    readonly windowId: string;
    readonly paneId: 'left' | 'right';
}
declare global {
    interface Window { readonly twopanez: TwopanezBridge; }
}
export {};
