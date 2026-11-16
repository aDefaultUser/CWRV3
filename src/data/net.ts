// Network access: loopback proxy routing for non-CORS public hosts, Cache API persistence for immutable
// archive objects, in-flight de-duplication and download progress accounting. Usable in workers.
import { DATA_CACHE, cachesReady } from '../app/persist';

/** Hosts reached through the app-owned loopback proxy (server/proxy.mjs) because they send no CORS headers. */
export const PROXY_HOSTS = new Set([
  'tgftp.nws.noaa.gov', 'mesonet-nexrad.agron.iastate.edu', 'mrms.ncep.noaa.gov', 'nomads.ncep.noaa.gov', 'www2.census.gov', 'naciscdn.org',
  'www.weather.gov', 'aviationweather.gov', 'www.ndbc.noaa.gov', 'madis-data.ncep.noaa.gov', 'ftp.wpc.ncep.noaa.gov', 'ftp-wpc.ncep.noaa.gov',
  'ftp.cpc.ncep.noaa.gov', 'ftp.nhc.noaa.gov', 'www.nhc.noaa.gov', 'firms.modaps.eosdis.nasa.gov', 'droughtmonitor.unl.edu',
]);
/** Vendor and licensing hosts that must never be contacted. */
const FORBIDDEN = /(^|\.)wsv3\.com$|wsv3[\w-]*\.s3\.amazonaws\.com$|^52\.201\.19\.154$|execute-api\.us-east-1\.amazonaws\.com$|wyday\.com$|limelm\.com$|xrad3d\.net$/i;

const CACHE_NAME = DATA_CACHE;

export function routeUrl(url: string): string {
  const u = new URL(url);
  if (FORBIDDEN.test(u.hostname) || (u.hostname === 's3.amazonaws.com' && /^\/wsv3/i.test(u.pathname))) throw new Error(`blocked vendor host: ${u.hostname}`);
  if (PROXY_HOSTS.has(u.hostname)) {
    const origin = typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:5173';
    return `${origin}/proxy/${u.hostname}${u.pathname}${u.search}`;
  }
  return url;
}

export interface FetchOpts {
  cache?: 'immutable' | 'none';
  /** Inclusive byte range. A 206 must start at range[0]; a 200 (range ignored) is sliced while streaming. */
  range?: [number, number];
  signal?: AbortSignal;
  maxBytes?: number;
  /** Whole-request time limit (default 90 s). */
  timeoutMs?: number;
}

type ProgressFn = (active: number, received: number, total: number) => void;
let active = 0, received = 0, total = 0;
const progressListeners = new Set<ProgressFn>();
export function onProgress(fn: ProgressFn) { progressListeners.add(fn); return () => progressListeners.delete(fn); }
function report() { for (const f of progressListeners) f(active, received, total); }

/** One network request shared by every caller asking for the same key; aborted only when all callers abort. */
interface Shared { promise: Promise<Uint8Array>; ctl: AbortController; waiters: number }
const inflight = new Map<string, Shared>();
/** Cancels every download in flight in this context (TFrmDownloader "Cancel download(s)"); returns the count. */
export function abortAll(): number { const n = inflight.size; for (const s of inflight.values()) s.ctl.abort(); inflight.clear(); return n; }

async function openCache(): Promise<Cache | null> {
  try { await cachesReady; return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null; } catch { return null; } // no cache: fetch from the network
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/** Parses "bytes a-b/total" (total may be "*"). */
export function parseContentRange(v: string | null): { start: number; end: number; total: number | null } | null {
  const m = v ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(v.trim()) : null;
  return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) } : null;
}

async function download(url: string, key: string, o: FetchOpts, signal: AbortSignal): Promise<Uint8Array> {
  const cache = o.cache === 'immutable' ? await openCache() : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const headers: Record<string, string> = {};
  if (o.range) headers.Range = `bytes=${o.range[0]}-${o.range[1]}`;
  active++; report();
  let counted = 0;
  try {
    const r = await fetch(routeUrl(url), { headers, signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    // Bytes of the body to skip and to keep: a 206 must match the request; a 200 means the range was ignored.
    let skip = 0, keep = Infinity;
    if (o.range) {
      const want = o.range[1] - o.range[0] + 1;
      if (r.status === 206) {
        // Content-Range is often not CORS-exposed (S3): then only the length can be checked (at most the request).
        const raw = r.headers.get('content-range');
        const cr = parseContentRange(raw);
        if (raw !== null && (!cr || cr.start !== o.range[0] || cr.end > o.range[1])) throw new Error(`range mismatch for ${url}: asked ${o.range.join('-')}, got ${raw}`);
        keep = cr ? cr.end - cr.start + 1 : want;
      } else { skip = o.range[0]; keep = want; }
    }
    const len = Number(r.headers.get('content-length') ?? 0);
    const limit = o.maxBytes ?? Infinity;
    if (Number.isFinite(keep) ? keep > limit : len > limit) throw new Error(`response too large (${len} B) for ${url}`);
    const expected = Math.min(len || keep, keep);
    if (Number.isFinite(expected)) { total += expected; counted = expected; }
    const reader = r.body!.getReader();
    const chunks: Uint8Array[] = [];
    let pos = 0, n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Keep only [skip, skip + keep) of the stream.
      const a = Math.max(0, skip - pos), b = Math.min(value.length, skip + keep - pos);
      pos += value.length;
      if (b > a) { const part = a === 0 && b === value.length ? value : value.subarray(a, b); chunks.push(part); n += part.length; received += part.length; }
      if (n > limit) { reader.cancel().catch(() => {}); throw new Error(`response too large for ${url}`); }
      report();
      if (n >= keep) { reader.cancel().catch(() => {}); break; }
    }
    if (o.range && r.status !== 206 && n < keep && pos < o.range[0] + 1) throw new Error(`range ${o.range.join('-')} beyond end of ${url} (${pos} B)`);
    const out = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    if (cache) await cache.put(key, new Response(out.slice().buffer)).catch(() => {});
    return out;
  } finally {
    active--; if (active === 0) { received = 0; total = 0; } else total -= counted;
    report();
  }
}

export async function fetchBytes(url: string, o: FetchOpts = {}): Promise<Uint8Array> {
  if (o.signal?.aborted) throw abortError();
  // Cache Storage ignores URL fragments, so byte ranges are keyed with a synthetic query parameter.
  const key = o.range ? `${url}${url.includes("?") ? "&" : "?"}cwrv3range=${o.range[0]}-${o.range[1]}` : url;
  let sh = inflight.get(key);
  if (!sh) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException(`timeout after ${o.timeoutMs ?? 90_000} ms: ${url}`, 'TimeoutError')), o.timeoutMs ?? 90_000);
    const s: Shared = { ctl, waiters: 0, promise: download(url, key, o, ctl.signal) };
    s.promise.finally(() => { clearTimeout(timer); if (inflight.get(key) === s) inflight.delete(key); }).catch(() => {});
    inflight.set(key, s);
    sh = s;
  }
  const shared = sh;
  shared.waiters++;
  if (!o.signal) return shared.promise.finally(() => { shared.waiters--; });
  // A caller's abort only detaches that caller; the transfer stops when no caller is left waiting.
  return new Promise<Uint8Array>((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true; shared.waiters--;
      if (shared.waiters <= 0) { shared.ctl.abort(); if (inflight.get(key) === shared) inflight.delete(key); }
      reject(abortError());
    };
    o.signal!.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (v) => { if (done) return; done = true; shared.waiters--; o.signal!.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { if (done) return; done = true; shared.waiters--; o.signal!.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export async function fetchText(url: string, o: FetchOpts = {}): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url, o));
}

export async function fetchJson<T = unknown>(url: string, o: FetchOpts = {}): Promise<T> {
  return JSON.parse(await fetchText(url, o)) as T;
}

export interface S3Object { key: string; size: number; lastModified: string }

/** S3 ListObjectsV2 (anonymous) with pagination; returns keys and common prefixes. */
export async function listS3(bucketUrl: string, prefix: string, opts: { delimiter?: string; startAfter?: string; maxPages?: number } = {}): Promise<{ objects: S3Object[]; prefixes: string[] }> {
  const objects: S3Object[] = [];
  const prefixes: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const q = new URLSearchParams({ 'list-type': '2', prefix });
    if (opts.delimiter) q.set('delimiter', opts.delimiter);
    if (opts.startAfter) q.set('start-after', opts.startAfter);
    if (token) q.set('continuation-token', token);
    const xml = await fetchText(`${bucketUrl}/?${q}`);
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1];
      objects.push({
        key: decodeXml(/<Key>([^<]*)<\/Key>/.exec(body)?.[1] ?? ''),
        size: Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0),
        lastModified: /<LastModified>([^<]*)<\/LastModified>/.exec(body)?.[1] ?? '',
      });
    }
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)) prefixes.push(decodeXml(m[1]));
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break;
    token = decodeXml(next[1]);
  }
  return { objects, prefixes };
}

function decodeXml(s: string) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }

/** Parses an Apache-style directory index (tgftp) into file names and modification times. */
export function parseDirIndex(html: string): { name: string; modified: string }[] {
  const out: { name: string; modified: string }[] = [];
  for (const m of html.matchAll(/<a href="([^"?/][^"]*)">[^<]*<\/a>\s*<\/td>\s*<td[^>]*>([^<]*)</g)) out.push({ name: m[1], modified: m[2].trim() });
  if (!out.length) for (const m of html.matchAll(/href="([^"?/][^"]*)"/g)) out.push({ name: m[1], modified: '' });
  return out;
}
