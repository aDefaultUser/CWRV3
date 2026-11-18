// Loopback-only CORS proxy for local development and `npm run serve`. The allowlist, redirect validation and size
// cap live in proxy-rules.mjs, shared with the hosted proxy (functions/proxy/[[path]].ts); this file adds the Node
// side: loopback clients only, a stall timeout and streaming the body to the response.
import { Readable } from 'node:stream';
import { MAX_BYTES, PASS_HEADERS, PROXY_PREFIX, fetchValidated, proxyTarget } from './proxy-rules.mjs';

export { ALLOWED_HOSTS, MAX_BYTES, MAX_REDIRECTS, PROXY_PREFIX, checkTarget, fetchValidated } from './proxy-rules.mjs';

/** Aborts when upstream sends nothing for this long (before headers or mid-body); large files may take longer. */
const STALL_MS = 20_000;
const USER_AGENT = 'cwrv3-local-proxy (local research client)';

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Connect/Node middleware. Returns true when the request was handled. */
export async function handleProxy(req, res) {
  if (!req.url || !req.url.startsWith(PROXY_PREFIX)) return false;
  const deny = (code, msg) => { res.statusCode = code; res.setHeader('content-type', 'text/plain'); res.setHeader('access-control-allow-origin', '*'); res.end(msg); return true; };
  if (!isLoopback(req.socket.remoteAddress)) return deny(403, 'loopback clients only');
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'GET/HEAD only');
  const first = proxyTarget(req.url);
  if (first.error) return deny(403, first.error);
  const ctl = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), STALL_MS); };
  arm();
  req.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  try {
    // Directory indexes change every few minutes; ask intermediaries for a fresh copy.
    const headers = { 'user-agent': USER_AGENT, 'cache-control': 'no-cache', pragma: 'no-cache' };
    if (req.headers.range) headers.range = req.headers.range;
    const r = await fetchValidated(first.url, { method: req.method, headers, signal: ctl.signal, cache: 'no-store' });
    if (r.error) return deny(r.status, r.error);
    const up = r.up;
    const len = Number(up.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) { try { await up.body?.cancel(); } catch { /* */ } return deny(413, 'response too large'); }
    res.statusCode = up.status;
    // fetch() transparently decodes gzip/br, so the upstream content-length only applies to identity bodies.
    const encoded = !!up.headers.get('content-encoding');
    for (const h of PASS_HEADERS) {
      if (h === 'content-length' && encoded) continue;
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'content-range, content-length, last-modified, etag');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'HEAD' || !up.body) { res.end(); return true; }
    let total = 0;
    const body = Readable.fromWeb(up.body);
    body.on('data', (chunk) => {
      arm();
      total += chunk.length;
      if (total > MAX_BYTES) { body.destroy(); res.destroy(); }
    });
    body.on('error', () => res.destroy());
    body.pipe(res);
    await new Promise((resolve) => res.on('close', resolve));
  } catch (err) {
    if (!res.headersSent) deny(504, `upstream failed: ${err?.name === 'AbortError' ? 'timeout': 'error'}`);
    else res.destroy();
  } finally {
    clearTimeout(timer);
  }
  return true;
}
