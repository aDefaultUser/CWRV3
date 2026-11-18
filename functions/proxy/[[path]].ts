// Hosted CORS proxy (Cloudflare Pages Function): /proxy/<host>/<path> → https://<host>/<path>, served from the same
// origin as the app, so src/data/net.ts routes to it unchanged. Rules are shared with the local Node proxy
// (server/proxy-rules.mjs). Loopback-only becomes same-origin-only: browsers send Sec-Fetch-Site on every fetch, so
// other sites can't use it. Bodies stream through untouched (no per-byte work), so large files cost no CPU time.
import { MAX_BYTES, PASS_HEADERS, fetchValidated, proxyTarget } from '../../server/proxy-rules.mjs';

const USER_AGENT = 'cwrv3-proxy (research client)';

function deny(status: number, msg: string): Response {
  return new Response(msg, { status, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
}

export const onRequest = async ({ request }: { request: Request }): Promise<Response> => {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return deny(403, 'same-origin clients only');
  if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405, 'GET/HEAD only');
  const u = new URL(request.url);
  const target = proxyTarget(u.pathname + u.search);
  if (target.error !== undefined) return deny(403, target.error);

  // Directory indexes change every few minutes; ask intermediaries for a fresh copy.
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, 'cache-control': 'no-cache', pragma: 'no-cache' };
  const range = request.headers.get('range');
  if (range) headers.range = range;
  let r;
  try { r = await fetchValidated(target.url, { method: request.method, headers }); }
  catch { return deny(504, 'upstream failed: error'); }
  if (r.error !== undefined) return deny(r.status, r.error);
  const up = r.up;
  if (Number(up.headers.get('content-length') ?? 0) > MAX_BYTES) { await up.body?.cancel(); return deny(413, 'response too large'); }

  const out = new Headers({
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-range, content-length, last-modified, etag',
    'cache-control': 'no-store',
  });
  // fetch() decodes gzip/br, so the upstream content-length only applies to identity bodies.
  const encoded = up.headers.has('content-encoding');
  for (const h of PASS_HEADERS) {
    const v = up.headers.get(h);
    if (v && !(h === 'content-length' && encoded)) out.set(h, v);
  }
  return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
};
