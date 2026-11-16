// Loopback proxy: redirect targets are validated before they are requested (static review finding).
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM module without types
import { fetchValidated, checkTarget, MAX_REDIRECTS } from '../server/proxy.mjs';

function fakeFetch(map: Record<string, { status: number; location?: string }>) {
  const seen: string[] = [];
  const f = async (url: string) => {
    seen.push(url);
    const r = map[url];
    if (!r) throw new Error(`unexpected request ${url}`);
    return new Response(r.status >= 300 && r.status < 400 ? null : 'ok', { status: r.status, headers: r.location ? { location: r.location } : {} });
  };
  return { f, seen };
}

describe('proxy redirect validation', () => {
  it('follows an allowlisted https redirect', async () => {
    const { f, seen } = fakeFetch({ 'https://ftp.wpc.ncep.noaa.gov/a.zip': { status: 302, location: 'https://ftp-wpc.ncep.noaa.gov/a.zip' }, 'https://ftp-wpc.ncep.noaa.gov/a.zip': { status: 200 } });
    const r = await fetchValidated(new URL('https://ftp.wpc.ncep.noaa.gov/a.zip'), {}, f);
    expect(r.up.status).toBe(200);
    expect(seen).toEqual(['https://ftp.wpc.ncep.noaa.gov/a.zip', 'https://ftp-wpc.ncep.noaa.gov/a.zip']);
  });
  it('never requests a redirect target outside the allowlist', async () => {
    const { f, seen } = fakeFetch({ 'https://tgftp.nws.noaa.gov/x': { status: 301, location: 'https://evil.example/x' } });
    const r = await fetchValidated(new URL('https://tgftp.nws.noaa.gov/x'), {}, f);
    expect(r.error).toMatch(/host not allowed/);
    expect(seen).toEqual(['https://tgftp.nws.noaa.gov/x']);
  });
  it('refuses downgrade, credentials, odd ports and loops', async () => {
    expect(checkTarget('http://tgftp.nws.noaa.gov/x').error).toMatch(/protocol/);
    expect(checkTarget('https://u:p@tgftp.nws.noaa.gov/x').error).toMatch(/credentials/);
    expect(checkTarget('https://tgftp.nws.noaa.gov:8443/x').error).toMatch(/port/);
    expect(checkTarget('/rel', new URL('https://tgftp.nws.noaa.gov/a/b')).url.href).toBe('https://tgftp.nws.noaa.gov/rel');
    const { f, seen } = fakeFetch({ 'https://tgftp.nws.noaa.gov/l': { status: 302, location: '/l' } });
    const r = await fetchValidated(new URL('https://tgftp.nws.noaa.gov/l'), {}, f);
    expect(r.error).toMatch(/too many/);
    expect(seen.length).toBe(MAX_REDIRECTS + 1);
  });
});
