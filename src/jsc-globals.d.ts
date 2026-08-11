// src/jsc-globals.d.ts — ambient globals of the AppOS JavaScriptCore plugin
// runtime. JSC ships a native console; the host injects NO timers, so the
// timer globals are typed `| undefined` — an unguarded setTimeout(...) is a
// type error (TS2722) while a `typeof setTimeout === 'function'`-narrowed
// call compiles. Do not add DOM globals here: document/window/browser fetch
// do not exist in the plugin runtime (use ctx.network.fetch).
declare const console: {
    log(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    trace(...args: unknown[]): void;
};
declare const setTimeout: ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => number) | undefined;
declare const clearTimeout: ((id: number | undefined) => void) | undefined;
declare const setInterval: ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => number) | undefined;
declare const clearInterval: ((id: number | undefined) => void) | undefined;
