// Time-matched precipitation typing: HRRR selection by scan time, bounded cache, late responses, unavailable data.
import { describe, it, expect } from 'vitest';
import { PtypeCache, dominantTime, ptypeLabel } from '../src/render/ptype';
import { ptypeValidHour, ptypeCandidates, loadPtypeGrid, type PtypeGrid } from '../src/data/hrrr-service';
import { hrrrUrl } from '../src/decode/hrrr';
import { packPtype } from '../src/decode/ptype-pack';

const H = 3600e3;
const utc = (s: string) => Date.parse(s);
const grid = (validMs: number, fh = 1): PtypeGrid => ({ cycleMs: validMs - fh * H, fh, nx: 1, ny: 1, grid: { nx: 1, ny: 1 } as never, packed: new Uint8Array(4) });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('HRRR selection for a scan time', () => {
  it('picks the forecast valid at the hour nearest an archived scan (2024-05-06 KTLX)', () => {
    const scan = utc('2024-05-06T22:03:43Z');
    expect(ptypeValidHour(scan)).toBe(utc('2024-05-06T22:00:00Z'));
    expect(ptypeValidHour(utc('2024-05-06T22:31:00Z'))).toBe(utc('2024-05-06T23:00:00Z'));
    const c = ptypeCandidates(ptypeValidHour(scan));
    // f01 from the previous cycle first; never f00 (empty categorical fields).
    expect(c[0]).toEqual({ cycleMs: utc('2024-05-06T21:00:00Z'), fh: 1 });
    expect(c.every((x) => x.fh >= 1 && x.cycleMs + x.fh * H === utc('2024-05-06T22:00:00Z'))).toBe(true);
    expect(hrrrUrl(new Date(c[0].cycleMs), c[0].fh)).toBe('https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20240506/conus/hrrr.t21z.wrfsfcf01.grib2');
  });

  it('falls back to an older run valid at the same hour, then reports none', async () => {
    const valid = utc('2024-05-06T22:00:00Z');
    const urls: string[] = [];
    const packed = packPtype(1, { cpofp: new Float32Array([-50]), crain: new Float32Array([1]), csnow: new Float32Array([0]), cicep: new Float32Array([0]), cfrzr: new Float32Array([0]), t2m: new Float32Array([290]) })!;
    const tasks = new Set<string>();
    const run = (async (task: string, a: { url: string }) => { tasks.add(task); urls.push(a.url); if (a.url.includes('f01')) throw new Error('404'); return { grid: { nx: 1, ny: 1 }, packed }; }) as never;
    const g = await loadPtypeGrid(valid, run);
    expect(g?.fh).toBe(2);
    expect(g?.cycleMs).toBe(utc('2024-05-06T20:00:00Z'));
    expect(urls[0]).toContain('hrrr.t21z.wrfsfcf01');
    expect(g?.packed[1]).toBe(Math.round(0.25 * 255)); // rain category
    expect([...tasks]).toEqual(['hrrr.ptype']); // packing happens in the worker task
    expect(await loadPtypeGrid(valid, (async () => { throw new Error('404'); }) as never)).toBeNull();
  });
});

describe('p-type texel packing', () => {
  const f = (v: number[]) => new Float32Array(v);
  it('encodes probability, category and temperature, and leaves missing points invalid', () => {
    const n = 7;
    const packed = packPtype(n, {
      //       snow  rain  sleet  frz   none(−50, cold)  NaN cat  no prob source
      cpofp: f([80, 10, 60, 70, -50, 50, NaN]),
      crain: f([0, 1, 0, 0, 0, NaN, 0]),
      csnow: f([1, 0, 0, 0, 0, 0, 0]),
      cicep: f([0, 0, 1, 0, 0, 0, 0]),
      cfrzr: f([0, 0, 0, 1, 0, 0, 0]),
      t2m: f([268.15, 283.15, 271.15, 272.15, 263.15, 270, NaN]),
    })!;
    const px = (i: number) => [...packed.slice(i * 4, i * 4 + 4)];
    expect(px(0)).toEqual([204, 128, Math.round((35 / 80) * 255), 255]); // snow, 80 %, −5 °C
    expect(px(1)).toEqual([26, 64, Math.round((50 / 80) * 255), 255]); // rain, 10 %, +10 °C
    expect(px(2)[1]).toBe(191); expect(px(3)[1]).toBe(255);
    expect(px(4)).toEqual([255, 0, Math.round((30 / 80) * 255), 255]); // no precipitation code, frozen by temperature
    expect(px(5)[3]).toBe(0); // missing categorical value
    expect(px(6)[3]).toBe(0); // no category, no CPOFP and no temperature: unknown, not "valid rain"
    expect(packPtype(1, { cpofp: f([0]), crain: f([1]), csnow: f([0]), cicep: f([0]) })).toBeNull();
  });
  it('derives the probability from the category when CPOFP and temperature are missing', () => {
    const p = packPtype(2, { cpofp: f([NaN, NaN]), crain: f([0, 1]), csnow: f([1, 0]), cicep: f([0, 0]), cfrzr: f([0, 0]) })!;
    expect([p[0], p[3], p[4], p[7]]).toEqual([255, 255, 0, 255]);
    expect(p[2]).toBe(0);
  });
});

describe('PtypeCache', () => {
  function make(max = 3) {
    const pending = new Map<number, (g: PtypeGrid | null) => void>();
    const disposed: number[] = [];
    let now = 0;
    const cache = new PtypeCache<number>((v) => new Promise((r) => pending.set(v, r)), (g) => g.cycleMs + g.fh * H, (v) => disposed.push(v), max, 600e3, () => now);
    return { cache, pending, disposed, advance: (ms: number) => { now += ms; } };
  }

  it('serves each scan its own valid hour while looping forward and backward', async () => {
    const { cache, pending } = make();
    const t1 = utc('2024-05-06T21:10:00Z'), t2 = utc('2024-05-06T22:05:00Z');
    let calls = 0; const cb = () => calls++;
    expect(cache.get(t1, cb).status).toBe('loading');
    expect(cache.get(t2, cb).status).toBe('loading');
    pending.get(ptypeValidHour(t2))!(grid(ptypeValidHour(t2)));
    await tick();
    const s2 = cache.get(t2, cb);
    expect(s2.status === 'ready' && s2.validMs).toBe(utc('2024-05-06T22:00:00Z'));
    // Stepping back to the older scan does not reuse the newer hour.
    expect(cache.get(t1, cb).status).toBe('loading');
    pending.get(ptypeValidHour(t1))!(grid(ptypeValidHour(t1)));
    await tick();
    const s1 = cache.get(t1, cb);
    expect(s1.status === 'ready' && s1.value).toBe(utc('2024-05-06T21:00:00Z'));
    expect(calls).toBe(2);
  });

  it('notifies every consumer registered for an hour', async () => {
    const { cache, pending } = make();
    const t = utc('2024-05-06T22:00:00Z');
    const seen: string[] = [];
    cache.get(t, () => seen.push('national')); cache.get(t, () => seen.push('mrms')); cache.get(t, () => seen.push('nexrad'));
    pending.get(t)!(grid(t));
    await tick();
    expect(seen.sort()).toEqual(['mrms', 'national', 'nexrad']);
  });

  it('drops a late response for an evicted hour and bounds the cache', async () => {
    const { cache, pending, disposed } = make(2);
    const hours = [0, 1, 2].map((k) => utc('2024-05-06T20:00:00Z') + k * H);
    for (const h of hours) cache.get(h, () => {});
    expect(cache.size()).toBe(2); // the oldest request was evicted
    pending.get(hours[0])!(grid(hours[0])); // late answer for the evicted hour
    await tick();
    expect(cache.get(hours[1], () => {}).status).toBe('loading');
    for (const h of hours.slice(1)) pending.get(h)!(grid(h));
    await tick();
    expect(cache.size()).toBe(2);
    // Requesting hour 0 again restarts it; a ready entry is disposed on eviction.
    cache.get(hours[0], () => {});
    expect(disposed).toHaveLength(1);
    expect(cache.get(hours[0], () => {}).status).toBe('loading');
  });

  it('reports unavailable data (never another hour) and retries later', async () => {
    const { cache, pending, advance } = make();
    const t = utc('2024-05-06T22:00:00Z');
    cache.get(t + H, () => {});
    pending.get(t + H)!(grid(t + H));
    cache.get(t, () => {});
    pending.get(t)!(null);
    await tick();
    const s = cache.get(t, () => {});
    expect(s.status).toBe('unavailable');
    expect(ptypeLabel(s)).toMatch(/P-type unavailable.*showing reflectivity/);
    advance(601e3);
    expect(cache.get(t, () => {}).status).toBe('loading');
  });

  it('uses the dominant frame time when blending', () => {
    expect(dominantTime({ t: 1 }, { t: 2 }, 0.4)).toBe(1);
    expect(dominantTime({ t: 1 }, { t: 2 }, 0.6)).toBe(2);
    expect(dominantTime({ t: 1 }, null, 0.9)).toBe(1);
  });
});
