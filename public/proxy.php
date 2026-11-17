<?php
// PHP port of server/proxy.mjs for shared hosting: /proxy/<host>/<path> -> https://<host>/<path>.
// Same rules as the Node proxy (fixed host allowlist, GET/HEAD only, https on 443, no credentials, every redirect
// hop validated before it is requested, size cap, stall timeout). Loopback-only becomes same-origin-only: browsers
// send Sec-Fetch-Site on every fetch, so other sites can't hotlink it. Shipped from public/ next to .htaccess, which
// routes /proxy/* here; the shared host's bandwidth is limited, so bulk data should not depend on this proxy.

const ALLOWED_HOSTS = [
  'tgftp.nws.noaa.gov', 'mesonet-nexrad.agron.iastate.edu', 'mrms.ncep.noaa.gov', 'nomads.ncep.noaa.gov',
  'www2.census.gov', 'naciscdn.org', 'www.weather.gov', 'aviationweather.gov', 'www.ndbc.noaa.gov',
  'madis-data.ncep.noaa.gov', 'ftp.wpc.ncep.noaa.gov', 'ftp-wpc.ncep.noaa.gov', 'ftp.cpc.ncep.noaa.gov',
  'ftp.nhc.noaa.gov', 'www.nhc.noaa.gov', 'firms.modaps.eosdis.nasa.gov', 'droughtmonitor.unl.edu',
];
const MAX_BYTES = 160 * 1024 * 1024;
// A transfer is aborted when it stalls (under STALL_BYTES/s for STALL_S), not after a fixed total time, so large
// files on a busy link still finish; TOTAL_S is only a backstop.
const CONNECT_S = 15;
const STALL_S = 20;
const STALL_BYTES = 1024;
const TOTAL_S = 300;
const MAX_REDIRECTS = 4;
const USER_AGENT = 'cwrv3-proxy (research client)';
const PASS_HEADERS = ['content-type', 'content-length', 'content-encoding', 'last-modified', 'etag', 'content-range', 'accept-ranges'];

function deny(int $code, string $msg): never {
  http_response_code($code);
  header('content-type: text/plain');
  header('access-control-allow-origin: *');
  echo $msg;
  exit;
}

/** Validates one hop target; returns the absolute URL or dies with 403/502. */
function check_target(string $url, int $failCode): string {
  $u = parse_url($url);
  if ($u === false || !isset($u['scheme'], $u['host'])) deny($failCode, 'bad target');
  if (strtolower($u['scheme']) !== 'https') deny($failCode, "protocol not allowed: {$u['scheme']}");
  if (isset($u['user']) || isset($u['pass'])) deny($failCode, 'credentials in URL not allowed');
  if (isset($u['port']) && $u['port'] !== 443) deny($failCode, "port not allowed: {$u['port']}");
  if (!in_array(strtolower($u['host']), ALLOWED_HOSTS, true)) deny($failCode, "host not allowed: {$u['host']}");
  return $url;
}

/** Resolves a Location header against the current URL (absolute, host-relative or path-relative). */
function resolve_location(string $loc, string $base): string {
  if (preg_match('#^https?://#i', $loc)) return $loc;
  $b = parse_url($base);
  $origin = "{$b['scheme']}://{$b['host']}";
  if (str_starts_with($loc, '//')) return "{$b['scheme']}:$loc";
  if (str_starts_with($loc, '/')) return $origin . $loc;
  $dir = preg_replace('#/[^/]*$#', '/', $b['path'] ?? '/');
  return $origin . $dir . $loc;
}

$site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
if ($site !== '' && $site !== 'same-origin') deny(403, 'same-origin clients only');
$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET' && $method !== 'HEAD') deny(405, 'GET/HEAD only');

$rest = preg_replace('#^.*?/proxy/#', '', $_SERVER['REQUEST_URI'], 1);
$url = check_target('https://' . (str_contains($rest, '/') ? $rest : "$rest/"), 403);

set_time_limit(TOTAL_S + 15);
while (ob_get_level()) ob_end_clean();
header('X-LiteSpeed-Cache-Control: no-cache');

for ($hop = 0; ; $hop++) {
  $status = 0; $headers = []; $sent = false; $total = 0;
  $ch = curl_init($url);
  $reqHeaders = ['User-Agent: ' . USER_AGENT, 'Cache-Control: no-cache', 'Pragma: no-cache'];
  if (isset($_SERVER['HTTP_RANGE'])) $reqHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
  curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_NOBODY => $method === 'HEAD',
    CURLOPT_HTTPHEADER => $reqHeaders,
    CURLOPT_CONNECTTIMEOUT => CONNECT_S,
    CURLOPT_LOW_SPEED_LIMIT => STALL_BYTES,
    CURLOPT_LOW_SPEED_TIME => STALL_S,
    CURLOPT_TIMEOUT => TOTAL_S,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$status, &$headers) {
      if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $status = (int)$m[1]; $headers = []; }
      elseif (($p = strpos($line, ':')) !== false) $headers[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
      return strlen($line);
    },
    // Streams the body once the final (non-redirect) response starts; returning 0 aborts the transfer.
    CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$status, &$headers, &$sent, &$total) {
      if ($status >= 300 && $status <= 399 && $status !== 304) return strlen($chunk);
      if (!$sent) { emit_headers($status, $headers); $sent = true; }
      $total += strlen($chunk);
      if ($total > MAX_BYTES) return 0;
      echo $chunk;
      flush();
      return strlen($chunk);
    },
  ]);
  $ok = curl_exec($ch);
  $err = curl_errno($ch);
  curl_close($ch);

  if ($sent) exit; // body streamed (a mid-stream failure just truncates, like res.destroy())
  if (!$ok && $err) deny(504, $err === CURLE_OPERATION_TIMEDOUT ? 'upstream failed: timeout' : 'upstream failed: error');
  if ($status >= 300 && $status <= 399 && $status !== 304) {
    if (!isset($headers['location'])) deny(502, 'redirect without location');
    if ($hop >= MAX_REDIRECTS) deny(502, 'too many redirects');
    $url = check_target(resolve_location($headers['location'], $url), 502);
    continue;
  }
  emit_headers($status, $headers); // empty body or HEAD
  exit;
}

function emit_headers(int $status, array $headers): void {
  if ((int)($headers['content-length'] ?? 0) > MAX_BYTES) deny(413, 'response too large');
  http_response_code($status);
  foreach (PASS_HEADERS as $h) if (isset($headers[$h])) header("$h: {$headers[$h]}");
  header('access-control-allow-origin: *');
  header('access-control-expose-headers: content-range, content-length, last-modified, etag');
  header('cache-control: no-store');
}
