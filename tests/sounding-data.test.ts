// Sounding sources: IEM response parsing (identity as returned), station selection, request URLs, the request
// order of the observed and model look-ups over a mocked network, and VAD winds from a real VWP product (Level 3
// product 48, KOAX 2026-11-18 01:33 UTC from TGFTP) through the real Level 3 decoder.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({ calls: [] as string[], respond: (_url: string): unknown => { throw new Error('unset'); }, vwp: [] as { t: number; url: string; name: string }[] }));
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchJson: vi.fn(async (url: string) => { h.calls.push(url); return h.respond(url); }) }));
vi.mock('../src/radar/sources', async (orig) => ({ ...(await orig<object>()), listL3: vi.fn(async () => h.vwp) }));
// The worker's 'l3' task, run in-process on the fixture with the real decoder.
vi.mock('../src/workers/pool', async () => {
  const { decodeLevel3 } = await import('../src/decode/level3');
  const run = vi.fn(async (_task: string, a: { url: string }) => { h.calls.push(a.url); return decodeLevel3(new Uint8Array(readFileSync(new URL('./fixtures/sounding/koax-vwp-2026111801.bin', import.meta.url)))); });
  return { pool: { run, for: () => ({ run }) } };
});

import { parseRaob, parseBufkit, parseRaobStations, nearestStations, raobCycles, raobUrl, bufkitUrl, observedSounding, modelSounding, parseVad, vadSounding } from '../src/sections/sounding-data';
import { soundingLabel, indicesText } from '../src/ui/sounding-panel';
import { decodeLevel3 } from '../src/decode/level3';
import { windIndices, standardPressure } from '../src/sections/sounding-math';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/sounding/${name}`, import.meta.url), 'utf8'));
const RAOB = fixture('iem-raob-koax-2026111712.json'), BUFKIT = fixture('iem-bufkit-hrrr-oax-2026111715.json'), NET = fixture('iem-raob-network.json');
const at = (s: string) => Date.parse(s);
beforeEach(() => { h.calls.length = 0; });

describe('IEM responses', () => {
  it('RAOB: the profile starts at the surface (levels below ground dropped) with the station and valid time returned', () => {
    const r = parseRaob(RAOB)!;
    expect(r.station).toBe('KOAX');
    expect(r.validMs).toBe(at('2026-11-17T12:00:00Z'));
    expect(RAOB.profiles[0].profile[0]).toMatchObject({ pres: 1000, tmpc: null }); // 1000 hPa is below the 983 hPa surface
    expect(r.levels[0]).toMatchObject({ p: 983, z: 350 });
    expect(r.levels[0].t - 273.15).toBeCloseTo(10, 9);
    expect(r.levels.every((l, i) => i === 0 || l.p < r.levels[i - 1].p)).toBe(true);
    expect(r.levels.every((l) => !(l.td > l.t))).toBe(true);
    // 200° at 11 kt: wind from the south-southwest blows toward the north-northeast.
    expect(r.levels[0].u).toBeGreaterThan(0); expect(r.levels[0].v).toBeGreaterThan(0);
    expect(parseRaob({ profiles: [] })).toBeNull();
  });
  it('BUFKIT: station, position, run, forecast hour and valid time are the ones the service picked', () => {
    const r = parseBufkit(BUFKIT)!;
    expect(r).toMatchObject({ station: 'OAX', lat: 41.32, lon: -96.37, runMs: at('2026-11-17T15:00:00Z'), validMs: at('2026-11-17T15:00:00Z'), fhour: 0 });
    expect(r.levels).toHaveLength(BUFKIT.profiles[0].levels.length);
    expect(parseBufkit({ detail: 'Could not find any profile.' })).toBeNull();
  });
  it('station list: aliases and closed or offline sites are left out; nearest first within range', () => {
    const list = parseRaobStations(NET);
    expect(list.map((s) => s.id)).not.toContain('_ABR');
    expect(list.map((s) => s.id)).not.toContain('KLTS');
    const near = nearestStations(list, -96.4, 41.3);
    expect(near.map((s) => s.id)).toEqual(['KOAX', 'KTOP', 'KLBF']);
    expect(near[0].km).toBeLessThan(80); // IEM lists KOAX at 41.32°N 95.6°W
    expect(nearestStations(list, 0, 0)).toEqual([]);
    expect(() => parseRaobStations({})).toThrow();
  });
  it('labels name the source, station, run and valid time actually returned', () => {
    const r = parseBufkit(BUFKIT)!;
    const text = soundingLabel({ ...r, source: 'HRRR', name: '', distKm: 3.4, url: '' });
    expect(text).toBe('HRRR (IEM BUFKIT) site OAX 41.32°N 96.37°W · run 2026-11-17 15:00 UTC F00 · valid 2026-11-17 15:00 UTC · 3 km from the point');
  });
});

describe('requests', () => {
  it('RAOB launches at or before the time are 00/12 UTC, newest first', () => {
    expect(raobCycles(at('2026-11-17T11:59:00Z')).map((t) => new Date(t).toISOString())).toEqual(['2026-11-17T00:00:00.000Z', '2026-11-16T12:00:00.000Z', '2026-11-16T00:00:00.000Z']);
    expect(raobCycles(at('2026-11-17T12:00:00Z'))[0]).toBe(at('2026-11-17T12:00:00Z'));
    expect(raobUrl(at('2026-11-17T12:00:00Z'), 'KOAX')).toBe('https://mesonet.agron.iastate.edu/json/raob.py?ts=202611171200&station=KOAX');
  });
  it('BUFKIT URLs carry only lat, lon, model, runtime and time (the service rejects other parameters)', () => {
    const u = new URL(bufkitUrl('HRRR', -96.4, 41.3, at('2026-11-17T15:00:00Z'), at('2026-11-17T12:00:00Z')));
    expect([...u.searchParams.keys()]).toEqual(['lat', 'lon', 'model', 'runtime', 'time']);
    expect(u.searchParams.get('time')).toBe('2026-11-17T15:00Z');
    expect(new URL(bufkitUrl('GFS', 0, 0, 0)).searchParams.has('runtime')).toBe(false);
  });

  it('observed: nearest station first, each at its newest launch at or before the time, then the next station', async () => {
    h.respond = (url) => {
      if (url.includes('/network/RAOB.json')) return NET;
      if (url.includes('station=KTOP') && url.includes('ts=202611171200')) return { profiles: [{ ...RAOB.profiles[0], station: 'KTOP' }] };
      return { profiles: [] }; // KOAX launches missing
    };
    const s = await observedSounding(-96.4, 41.3, at('2026-11-17T14:30:00Z'));
    expect(s).toMatchObject({ source: 'RAOB', station: 'KTOP', validMs: at('2026-11-17T12:00:00Z') });
    expect(s.distKm).toBeGreaterThan(150);
    expect(h.calls.filter((u) => u.includes('raob.py')).map((u) => /ts=(\d+)&station=(\w+)/.exec(u)!.slice(1).join(' '))).toEqual([
      '202611171200 KOAX', '202611170000 KOAX', '202611161200 KOAX', '202611171200 KTOP',
    ]);
  });

  it('model: valid time rounded to the hour; on "no profile" the recent cycles are named, then a clear error', async () => {
    const now = at('2026-11-18T01:22:00Z');
    h.respond = (url) => {
      if (url.includes('runtime=2026-11-17T23:00Z')) return BUFKIT;
      throw new Error(`HTTP 422 for ${url}`);
    };
    const s = await modelSounding('HRRR', -96.4, 41.3, at('2026-11-18T04:40:00Z'), undefined, now);
    expect(s.source).toBe('HRRR');
    expect(h.calls.map((u) => new URL(u).searchParams.get('runtime'))).toEqual([null, '2026-11-18T01:00Z', '2026-11-18T00:00Z', '2026-11-17T23:00Z']);
    expect(h.calls.every((u) => u.endsWith('time=2026-11-18T05:00Z'))).toBe(true);

    h.calls.length = 0;
    h.respond = (url) => { throw new Error(`HTTP 422 for ${url}`); };
    await expect(modelSounding('NAM', -96.4, 41.3, at('2026-11-17T12:00:00Z'), undefined, now)).rejects.toThrow('NAM: no profile valid 2026-11-17T12:00Z (HTTP 422)');
    expect(h.calls).toHaveLength(5);
    expect(new URL(h.calls[1]).searchParams.get('runtime')).toBe('2026-11-17T12:00Z'); // 6-hourly cycles at or before the valid time

    h.respond = () => { throw new Error('network down'); };
    await expect(modelSounding('RAP', 0, 0, now, undefined, now)).rejects.toThrow('network down');
  });
});

describe('VAD wind profile (NEXRAD Level 3 product 48)', () => {
  const bytes = () => new Uint8Array(readFileSync(new URL('./fixtures/sounding/koax-vwp-2026111801.bin', import.meta.url)));
  it('reads the "VAD Algorithm Output" table: altitude (100 ft MSL), U and V (m/s)', () => {
    const p = decodeLevel3(bytes());
    expect(p.code).toBe(48);
    const lv = parseVad(p.pages);
    // ALT 023 / 030 / 060 → 2300, 3000, 6000 ft MSL; U, V as listed (182°/38 kt is 0.8, 19.8 m/s).
    expect(lv.map((l) => Math.round(l.z / 0.3048))).toEqual([2300, 3000, 6000]);
    expect(lv.map((l) => [l.u, l.v])).toEqual([[0.8, 19.8], [-1.1, 18.3], [2.6, 12.7]]);
    expect(lv[0].p).toBeCloseTo(standardPressure(2300 * 0.3048), 9);
    expect(lv.every((l) => Number.isNaN(l.t))).toBe(true);
    const ix = windIndices(lv);
    // 0–1 km from the lowest level (701 m): the top at 1701 m lies 86 % of the way from 3000 to 6000 ft, where the
    // wind is about (2.08, 13.48) m/s; the difference from (0.8, 19.8) is about 6.45 m/s.
    expect(ix.shear1).toBeCloseTo(6.45, 1);
    expect(ix.storm).toBeNull(); // the profile ends below 6 km: no Bunkers motion, no helicity
    expect(indicesText(ix)).toContain('VAD winds only: no temperature profile');
  });
  it('picks the newest product at or before the time and labels the radar and volume time', async () => {
    const vt = Date.parse('2026-11-18T01:33:41Z');
    h.calls.length = 0;
    h.vwp = [{ t: vt - 600e3, url: 'old', name: 'sn.0001' }, { t: vt + 60e3, url: 'new', name: 'sn.0002' }, { t: vt + 3600e3, url: 'later', name: 'sn.0003' }];
    const s = await vadSounding({ id: 'KOAX', name: 'OMAHA', lat: 41.320369, lon: -96.366819 }, -96.4, 41.3, vt + 5 * 60e3);
    expect(h.calls).toEqual(['new']);
    expect(s).toMatchObject({ source: 'VAD', station: 'KOAX', validMs: vt, url: 'new' });
    expect(soundingLabel(s)).toBe('NEXRAD VAD wind profile KOAX (Level 3 product 48) · volume 2026-11-18 01:33 UTC · heights from the lowest VAD level, 701 m MSL · radar 4 km from the point');
    // A product scanned after the requested time is not used.
    await expect(vadSounding({ id: 'KOAX', name: 'OMAHA', lat: 41.32, lon: -96.37 }, -96.4, 41.3, vt - 60e3)).rejects.toThrow('no VAD wind profile of KOAX');
  });
});
