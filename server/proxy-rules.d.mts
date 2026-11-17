// Types for proxy-rules.mjs (plain ESM so Node runs it directly).
export declare const PROXY_PREFIX: '/proxy/';
export declare const ALLOWED_HOSTS: ReadonlySet<string>;
export declare const MAX_BYTES: number;
export declare const MAX_REDIRECTS: number;
export declare const PASS_HEADERS: readonly string[];

export type Target = { url: URL; error?: undefined } | { url?: undefined; error: string };
export type Fetched = { up: Response; url: URL; error?: undefined } | { up?: undefined; error: string; status: number };

export declare function checkTarget(raw: string, base?: string | URL): Target;
export declare function proxyTarget(pathAndQuery: string): Target;
export declare function fetchValidated(target: URL, init: RequestInit, fetchImpl?: (url: string, init: RequestInit) => Promise<Response>): Promise<Fetched>;
