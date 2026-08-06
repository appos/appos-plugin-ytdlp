// src/types/jsc-url.d.ts — WHATWG-URL surface as seen from the AppOS
// JavaScriptCore plugin runtime. A bare JSContext ships NO URL constructor
// and the host injects none (probed 2026-08-06: JSContext().evaluateScript
//("typeof URL") → "undefined"), so the global is typed `| undefined`: every
// use must be `typeof URL === 'function'`-guarded and take the same fallback
// path the former ReferenceError-into-catch produced. Only the members this
// plugin actually reads/writes are declared — this is NOT a full lib.dom URL.
interface JscUrlSearchParams {
    has(name: string): boolean;
    get(name: string): string | null;
}

interface JscUrl {
    protocol: string;
    hostname: string;
    pathname: string;
    href: string;
    readonly searchParams: JscUrlSearchParams;
}

declare const URL: (new (url: string, base?: string) => JscUrl) | undefined;
