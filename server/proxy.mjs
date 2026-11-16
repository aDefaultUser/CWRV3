// Loopback-only CORS proxy for public sources that send no Access-Control-Allow-Origin header (,
//). Bounded: fixed host allowlist, GET/HEAD only, response size cap, timeouts, loopback clients
// only, and every redirect hop is validated *before* it is requested. Not a generic proxy.
import { Readable } from 'node:stream';

export const PROXY_PREFIX = '/proxy/';
export const ALLOWED_HOSTS = new Set([
  'tgftp.nws.noaa.gov',                 // NEXRAD L2/L3, NDFD, SPC/WPC/NHC text, HDOB, METAR bulletins
  'mesonet-nexrad.agron.iastate.edu',   // NEXRAD L2 custom server default (source 4)
  'mrms.ncep.noaa.gov',                 // MRMS real-time directory (alternative to the AWS bucket)
  'nomads.ncep.noaa.gov',               // RAP/model GRIB2 when settings.modelDataSource = NOMADS
  'www2.census.gov',                    // TIGER/Line roads downloaded from the Roads dialog
  'naciscdn.org',                       // Natural Earth (GIS complement)
  'www.weather.gov',                    // NWS county shapefile directory
  'aviationweather.gov',                // METAR JSON (public alternative to the bulletin feed)
  'www.ndbc.noaa.gov',                  // buoy/ship observations, station list, buoy explorer files
  'madis-data.ncep.noaa.gov',           // METAR station table
  'ftp.wpc.ncep.noaa.gov',              // WPC QPF/ERO/winter/PWPF (302 → ftp-wpc)
  'ftp-wpc.ncep.noaa.gov',
  'ftp.cpc.ncep.noaa.gov',              // CPC outlooks
  'ftp.nhc.noaa.gov',                   // ATCF tcvitals, b-decks, a-decks, advisory/discussion text
  'www.nhc.noaa.gov',                   // NHC GIS (cone, watches/warnings, formation outlook)
  'firms.modaps.eosdis.nasa.gov',       // fire detections
  'droughtmonitor.unl.edu',             // drought monitor shapefile
]);
export const MAX_BYTES = 160 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
export const MAX_REDIRECTS = 4;
const USER_AGENT = 'cwrv3-local-proxy (local research client)';

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Validates one hop target. Returns the URL object or a refusal reason. */
export function checkTarget(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch { return { error: 'bad redirect target' }; }
  if (u.protocol !== 'https:') return { error: `protocol not allowed: ${u.protocol}` };
  if (u.username || u.password) return { error: 'credentials in URL not allowed' };
  if (u.port && u.port !== '443') return { error: `port not allowed: ${u.port}` };
  if (!ALLOWED_HOSTS.has(u.hostname)) return { error: `host not allowed: ${u.hostname}` };
  return { url: u };
}

/**
 * Fetches with manual redirect handling: each Location is validated against the allowlist (https, default
 * port, no credentials) before the next request is made, up to MAX_REDIRECTS hops.
 */
export async function fetchValidated(target, init, fetchImpl = fetch) {
  let current = target;
  for (let hop = 0; ; hop++) {
    const up = await fetchImpl(current.href, {...init, redirect: 'manual' });
    if (up.status < 300 || up.status > 399 || up.status === 304) return { up, url: current };
    const loc = up.headers.get('location');
    try { await up.body?.cancel(); } catch { /* already consumed */ }
    if (!loc) return { error: 'redirect without location', status: 502 };
    if (hop >= MAX_REDIRECTS) return { error: 'too many redirects', status: 502 };
    const next = checkTarget(loc, current);
    if (next.error) return { error: `redirect refused: ${next.error}`, status: 502 };
    current = next.url;
  }
}

/** Connect/Node middleware. Returns true when the request was handled. */
export async function handleProxy(req, res) {
  if (!req.url || !req.url.startsWith(PROXY_PREFIX)) return false;
  const deny = (code, msg) => { res.statusCode = code; res.setHeader('content-type', 'text/plain'); res.setHeader('access-control-allow-origin', '*'); res.end(msg); return true; };
  if (!isLoopback(req.socket.remoteAddress)) return deny(403, 'loopback clients only');
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'GET/HEAD only');
  const rest = req.url.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest: rest.slice(0, slash);
  const first = checkTarget(`https://${host}${slash < 0 ? '/': rest.slice(slash)}`);
  if (first.error) return deny(403, first.error);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
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
    for (const h of ['content-type', 'content-length', 'last-modified', 'etag', 'content-range', 'accept-ranges']) {
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
