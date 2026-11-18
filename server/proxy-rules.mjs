// Rules shared by both CORS proxies, the local Node one (server/proxy.mjs) and the hosted Cloudflare Pages Function
// (functions/proxy/[[path]].ts), for public sources that send no Access-Control-Allow-Origin header. Bounded: fixed
// host allowlist, https on the default port, no credentials, and every redirect hop validated *before* it is
// requested. Not a generic proxy. Uses only web-standard APIs (URL, fetch), so it runs in Node and in Workers.

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
export const MAX_REDIRECTS = 4;
/** Response headers passed through to the client (content-length only for bodies that were not re-encoded). */
export const PASS_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag', 'content-range', 'accept-ranges'];

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

/** Target of a proxy path ("/proxy/<host>/<path>?<query>"), validated like any hop. */
export function proxyTarget(pathAndQuery) {
  const rest = pathAndQuery.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  return checkTarget(`https://${host}${slash < 0 ? '/' : rest.slice(slash)}`);
}

/**
 * Fetches with manual redirect handling: each Location is validated against the allowlist (https, default
 * port, no credentials) before the next request is made, up to MAX_REDIRECTS hops.
 */
export async function fetchValidated(target, init, fetchImpl = fetch) {
  let current = target;
  for (let hop = 0; ; hop++) {
    const up = await fetchImpl(current.href, { ...init, redirect: 'manual' });
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
