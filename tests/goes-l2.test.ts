// GOES ABI L2+ cloud-top height/temperature and fire/hot-spot decoding from small public NOAA files (GOES-19,
// 2026-11-16, noaa-goes19 bucket). Reference values are NOAA's own statistics stored in each file and the worked
// example of the GOES-R PUG Vol. 3 (4.2.8.1); the decoder computes them independently from the pixel arrays.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readAbiL2, unpackCF, geosForward, geosInverse, FIRE_CATEGORY, type AbiCloudTop, type AbiFires, type H5Like } from '../src/decode/goes';
import { settings } from '../src/settings/store';
import { timeline } from '../src/app/timeline';

// The layer test controls when bucket listings and worker jobs settle, and records raster draws.
type Deferred<T> = { arg: any; resolve: (v: T) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ lists: [] as Deferred<unknown>[], runs: [] as Deferred<unknown>[], draws: 0, params: [] as any[], points: [] as any[][] }));
const defer = (list: Deferred<unknown>[], arg: unknown) => new Promise((resolve, reject) => list.push({ arg, resolve, reject }));
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), listS3: vi.fn((_bucket: string, prefix: string) => defer(h.lists, prefix)) }));
vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => defer(h.runs, { task, args })); return { pool: { run, for: () => ({ run }) } }; });
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RasterDraw: class { draw(_ctx: unknown, p: unknown) { h.draws++; h.params.push(p); } invalidate() {} },
  Lut: class {},
}));
vi.mock('../src/render/prims', async (orig) => ({ ...(await orig<object>()), PointSet: class { setPoints(p: any[]) { h.points.push(p); } draw() {} } }));

const DIR = new URL('./fixtures/goes-l2/', import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(new URL(name, DIR)));
let h5: H5Like;
beforeAll(async () => {
  const mod = await import('h5wasm/node');
  const { FS } = await mod.default.ready;
  // The node build maps the real file system; the decoder writes its temporary copy under /tmp.
  h5 = { FS: { writeFile: (p, d) => FS.writeFile(p, d), unlink: (p) => FS.unlink(p) }, File: mod.default.File as unknown as H5Like['File'] };
});
const stats = (v: Float32Array) => { let n = 0, s = 0, lo = Infinity, hi = -Infinity; for (const x of v) if (x === x) { n++; s += x; lo = Math.min(lo, x); hi = Math.max(hi, x); } return { n, mean: s / n, lo, hi }; };

describe('ABI L2+ cloud top', () => {
  it('decodes Cloud Top Height (ACHA, metres → km) with the quality mask; its valid pixels are NOAA\'s cloud_pixels', () => {
    const g = readAbiL2(h5, file('OR_ABI-L2-ACHAM1-M6_G19_s20263202100285_e20263202100343_c20263202100588.nc')) as AbiCloudTop;
    expect(g.kind).toBe('ACHA');
    expect([g.width, g.height, g.scene, g.platform]).toEqual([250, 250, 'Mesoscale', 'G19']);
    expect(g.startMs).toBe(Date.UTC(2026, 10, 16, 21, 0, 28, 500));
    const s = stats(g.values);
    expect(s.n).toBe(35128); // cloud_pixels
    expect(g.good).toBe(s.n);
    expect(s.lo).toBeGreaterThanOrEqual(0);
    expect(s.hi).toBeLessThan(20); // km (65530 × 0.3052 m = 20.0 km is the packed maximum)
  });

  it('decodes Cloud Top Temperature (ACHT, kelvin → °C) matching NOAA\'s min/max/mean of good-quality pixels', () => {
    const g = readAbiL2(h5, file('OR_ABI-L2-ACHTM1-M6_G19_s20263202100285_e20263202100343_c20263202100588.nc')) as AbiCloudTop;
    expect(g.kind).toBe('ACHT');
    const s = stats(g.values);
    expect([s.n, g.marginal]).toEqual([130754, 2006]); // marginal pixels (down to 185.7 K) are left out, as in NOAA's statistics
    expect(s.lo).toBeCloseTo(193.1156463623047 - 273.15, 2);
    expect(s.hi).toBeCloseTo(300.0810852050781 - 273.15, 2);
    expect(s.mean).toBeCloseTo(266.6802062988281 - 273.15, 1);
  });
});

describe('ABI L2+ fire / hot spot', () => {
  it('lists the fire pixels with radiative power, temperature and area as NOAA counts them', () => {
    const f = readAbiL2(h5, file('OR_ABI-L2-FDCM2-M6_G19_s20263202115556_e20263202116014_c20263202116112.nc')) as AbiFires;
    expect(f.kind).toBe('FDC');
    expect(f.lat.length).toBe(18); // total_number_of_pixels_with_fires_detected
    for (const m of f.mask) expect(FIRE_CATEGORY[m]).toBeDefined();
    const p = stats(f.power), t = stats(f.tempK), a = stats(f.areaM2);
    expect([p.n, t.n, a.n]).toEqual([14, 9, 9]);
    expect(p.lo).toBeCloseTo(29.5935001373291, 3); expect(p.hi).toBeCloseTo(373.33392333984375, 3); expect(p.mean).toBeCloseTo(103.77117156982422, 2);
    expect(t.lo).toBeCloseTo(402.2079772949219, 1); expect(t.hi).toBeCloseTo(1203.26904296875, 1);
    // Area is packed from add_offset 4000 m² in steps of 60.98 m²: NOAA's unpacked minimum (905 m²) is stored at the floor.
    expect(a.lo).toBe(4000); expect(Math.abs(a.hi - 116638.78125)).toBeLessThan(61);
    // Every fire lies in the mesoscale sector: its scan angles are inside the file's grid around x_image/y_image.
    for (let i = 0; i < f.lat.length; i++) {
      const xy = geosForward({ h: 42164160, req: 6378137, rpol: 6356752.31414, lon0: -75, x0: 0, dx: 0, y0: 0, dy: 0 }, f.lat[i], f.lon[i])!;
      expect(Math.abs(xy[0] - -0.02744)).toBeLessThan(0.0141);
      expect(Math.abs(xy[1] - 0.10248)).toBeLessThan(0.0141);
    }
  });
  it('unpacks power, temperature and area only at the fire pixels, reading each variable once, with unchanged values', () => {
    const name = 'OR_ABI-L2-FDCM2-M6_G19_s20263202115556_e20263202116014_c20263202116112.nc';
    const counted = new Set(['Power', 'Temp', 'Area']);
    const reads: Record<string, number> = {}, elements: Record<string, number> = {};
    // The real file through h5wasm, with the three fire variables' raw arrays wrapped to count reads and element accesses.
    const Base = h5.File as unknown as new (p: string, m: string) => { get(n: string): any };
    const File = class extends Base {
      get(n: string) {
        const d = super.get(n);
        if (!d || !counted.has(n)) return d;
        return new Proxy(d, { get: (t, k) => {
          if (k !== 'value') return Reflect.get(t, k, t);
          reads[n] = (reads[n] ?? 0) + 1;
          const raw = t.value;
          return new Proxy(raw, { get: (r, i) => { if (typeof i === 'string' && /^\d+$/.test(i)) elements[n] = (elements[n] ?? 0) + 1; const v = Reflect.get(r, i, r); return typeof v === 'function' ? v.bind(r) : v; } });
        } });
      }
    };
    const f = readAbiL2({ FS: h5.FS, File: File as unknown as H5Like['File'] }, file(name)) as AbiFires;
    expect(reads).toEqual({ Power: 1, Temp: 1, Area: 1 });
    expect(elements).toEqual({ Power: 18, Temp: 18, Area: 18 }); // the 18 fire pixels of 250 000, not the whole grid
    // Same numbers as unpacking every pixel and then picking the fire pixels.
    const g = new (h5.File as unknown as new (p: string, m: string) => { get(n: string): any; close(): void })((h5.FS.writeFile('/tmp/cwrv3-fdc-ref.nc', file(name)), '/tmp/cwrv3-fdc-ref.nc'), 'r');
    try {
      const mask = g.get('Mask').value as Int16Array, idx: number[] = [];
      mask.forEach((m, i) => { if (FIRE_CATEGORY[m]) idx.push(i); });
      for (const [v, out] of [['Power', f.power], ['Temp', f.tempK], ['Area', f.areaM2]] as const) {
        const full = unpackCF(g.get(v));
        expect(Array.from(out)).toEqual(idx.map((i) => full[i]));
      }
    } finally { g.close(); h5.FS.unlink('/tmp/cwrv3-fdc-ref.nc'); }
  });
});

describe('fixed-grid geolocation', () => {
  const p = { h: 42164160, req: 6378137, rpol: 6356752.31414, lon0: -75, x0: 0, dx: 0, y0: 0, dy: 0 };
  it('reproduces the GOES-R PUG worked example', () => {
    const [lat, lon] = geosInverse(p, -0.024052, 0.095340)!;
    expect(lat).toBeCloseTo(33.846162, 4);
    expect(lon).toBeCloseTo(-84.690932, 4);
  });
  it('inverts the forward projection and rejects scan angles off the Earth', () => {
    for (const [lat, lon] of [[35.2, -97.4], [-20, -40], [60, -120]]) {
      const [x, y] = geosForward(p, lat, lon)!;
      const r = geosInverse(p, x, y)!;
      expect(r[0]).toBeCloseTo(lat, 6); expect(r[1]).toBeCloseTo(lon, 6);
    }
    expect(geosInverse(p, 0.16, 0.16)).toBeNull();
  });
});

describe('ABI L2+ product listing', () => {
  it('maps each product and sector to the bucket prefix and file tag NOAA publishes, with no CONUS cloud-top temperature', async () => {
    const { GOES_L2, goesL2Names, goesL2FileTime } = await import('../src/layers/goes-l2');
    expect(goesL2Names('ACHA', 0)).toEqual({ prefix: 'ABI-L2-ACHAC', tag: 'ACHAC' });
    expect(goesL2Names('ACHT', 1)).toEqual({ prefix: 'ABI-L2-ACHTF', tag: 'ACHTF' });
    expect(goesL2Names('FDC', 3)).toEqual({ prefix: 'ABI-L2-FDCM', tag: 'FDCM2' });
    expect(GOES_L2.map((p) => [p.key, p.sectors.join('')])).toEqual([['ACHA', '0123'], ['ACHT', '123'], ['FDC', '0123']]);
    const name = 'ABI-L2-ACHAM/2026/320/21/OR_ABI-L2-ACHAM1-M6_G19_s20263202100285_e20263202100343_c20263202100588.nc';
    expect(goesL2FileTime(name, 'ACHAM1')).toBe(Date.UTC(2026, 10, 16, 21, 0, 28));
    expect(goesL2FileTime(name, 'ACHAM2')).toBeNull(); // mesoscale 1 and 2 share a prefix
    expect(goesL2FileTime(name.replace('ACHAM1', 'ACHTM1'), 'ACHAM1')).toBeNull();
  });
});

describe('Extended GOES Level 2 layer identity', () => {
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  const renderer = { gpu: { texture2D: () => ({ destroy() {} }) } } as never;
  /** One ACHT mesoscale-1 file 30 minutes before the loop end, listed under its own hour. */
  const achtFile = (minutesAgo = 30) => {
    const d = new Date(Math.floor((timeline.loopEnd - minutesAgo * 60e3) / 60e3) * 60e3);
    const doy = String(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400e3) + 1).padStart(3, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
    const dir = `ABI-L2-ACHTM/${d.getUTCFullYear()}/${doy}/${hh}/`;
    return { dir, t: d.getTime(), key: `${dir}OR_ABI-L2-ACHTM1-M6_G19_s${d.getUTCFullYear()}${doy}${hh}${mm}000_e${d.getUTCFullYear()}${doy}${hh}${mm}590_c${d.getUTCFullYear()}${doy}${hh}${mm}599.nc` };
  };
  let snapshot: ReturnType<typeof settings.exportDocument>;
  beforeEach(() => {
    snapshot = settings.exportDocument();
    h.lists.length = 0; h.runs.length = 0; h.draws = 0; h.params.length = 0; h.points.length = 0;
    settings.set('layerState.ExtendedSatelliteOn', true);
    settings.set('ext.layerState.ExtendedSatelliteUseL2', true);
    settings.set('ext.layerState.ExtendedSatellitePlatform', 0);
    settings.set('ext.layerState.ExtendedSatelliteDomain', 2);
    settings.set('ext.layerState.ExtendedSatelliteL2Product', 0);
  });
  afterEach(() => settings.importDocument(snapshot));

  it('applies opacity changes to fire points on the displayed scan without reloading it', async () => {
    const { GoesL2Layer } = await import('../src/layers/goes-l2');
    settings.set('ext.layerState.ExtendedSatelliteL2Product', 2);
    settings.set('settings.goesExtendedAlpha', 255);
    const layer = new GoesL2Layer(renderer), file = achtFile();
    const dir = file.dir.replaceAll('ACHT', 'FDC'), key = file.key.replaceAll('ACHT', 'FDC');
    const loading = layer.refresh();
    for (const l of h.lists.splice(0)) l.resolve({ objects: l.arg === dir ? [{ key }] : [], prefixes: [] });
    await loading;
    expect(h.runs).toHaveLength(1);
    h.runs[0].resolve({ kind: 'FDC', startMs: file.t, lat: new Float32Array([35]), lon: new Float32Array([-97]),
      power: new Float32Array([5]), tempK: new Float32Array([600]), areaM2: new Float32Array([4000]), mask: new Int16Array([10]), dqf: new Uint8Array([0]) });
    await flush();
    for (const alpha of [255, 80, 0]) {
      settings.set('settings.goesExtendedAlpha', alpha);
      layer.draw({ probe: false } as never);
      expect(h.points.at(-1)?.[0].color[3]).toBe(alpha);
    }
    expect(h.points).toHaveLength(3);
    layer.draw({ probe: false } as never);
    expect(h.points).toHaveLength(3);
    expect(h.runs).toHaveLength(1);
  });

  it.each([0, 0.01])('blends cloud frames only on the same fixed grid (newer x origin %s)', async (x0) => {
    const { GoesL2Layer } = await import('../src/layers/goes-l2');
    settings.set('ext.layerState.ExtendedSatelliteL2Product', 1);
    settings.set('layerState.RasterDataTemporalInterpolation', true);
    settings.set('settings.goesMesoThird', false);
    const layer = new GoesL2Layer(renderer), files = [achtFile(30), achtFile(28)];
    const loading = layer.refresh();
    for (const l of h.lists.splice(0)) l.resolve({ objects: files.filter((f) => f.dir === l.arg).map((f) => ({ key: f.key })), prefixes: [] });
    await loading;
    expect(h.runs).toHaveLength(2);
    for (const r of h.runs) {
      const i = files.findIndex((f) => r.arg.args.url.endsWith(f.key));
      r.resolve({ kind: 'ACHT', width: 2, height: 2, codes: new Uint8Array(4), good: 4, marginal: 0, startMs: files[i].t,
        proj: { h: 42164160, req: 6378137, rpol: 6356752.31414, lon0: -75, x0: i ? x0 : 0, dx: 0.001, y0: 0.1, dy: -0.001 } });
    }
    await flush();
    const time = timeline.t;
    try {
      timeline.t = files[0].t + 60e3;
      for (const probe of [false, true]) {
        layer.draw({ probe } as never);
        const p = h.params.at(-1);
        expect(p.w).toBe(x0 === 0 ? 0.5 : 0);
        expect(p.data[0][0] === p.data[0][1]).toBe(x0 !== 0);
        expect(p.proj.b[0]).toBe(0);
      }
      timeline.t = files[1].t;
      layer.draw({ probe: false } as never);
      expect(h.params.at(-1).proj.b[0]).toBe(x0);
    } finally { timeline.t = time; }
  });

  it('ignores a superseded product\'s late listing failure and never draws its frames under another selection', async () => {
    const { GoesL2Layer } = await import('../src/layers/goes-l2');
    const layer = new GoesL2Layer(renderer);
    const first = layer.refresh(); // cloud-top height: listing still pending
    const heightLists = h.lists.splice(0);
    expect(heightLists.length).toBeGreaterThan(0);

    settings.set('ext.layerState.ExtendedSatelliteL2Product', 1); // cloud-top temperature
    const second = layer.refresh();
    const file = achtFile();
    for (const l of h.lists.splice(0)) l.resolve({ objects: l.arg === file.dir ? [{ key: file.key }] : [], prefixes: [] });
    await second;
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].arg.args.url).toContain('ACHTM1');
    h.runs[0].resolve({ kind: 'ACHT', width: 2, height: 2, codes: new Uint8Array(4), proj: {}, good: 4, marginal: 0, startMs: 0 });
    await flush();
    expect(layer.status.state).toBe('ready');
    const ready = layer.status.text;
    expect(ready).toContain('Cloud Top Temperature');

    // The cloud-top height listing fails after the temperature product is shown: the status stays the new product's.
    for (const l of heightLists) l.reject(new Error('503 Slow Down'));
    await first;
    expect([layer.status.state, layer.status.text]).toEqual(['ready', ready]);

    layer.draw({ probe: false } as never);
    expect(h.draws).toBe(1);
    expect(layer.probeKind()).toBe('satL2');
    // Settings changed but not refreshed yet: the temperature texture is neither drawn nor probed as height.
    settings.set('ext.layerState.ExtendedSatelliteL2Product', 0);
    layer.draw({ probe: false } as never);
    expect(h.draws).toBe(1);
    expect(layer.probeKind()).toBeNull();
    settings.set('ext.layerState.ExtendedSatelliteL2Product', 1);
    layer.draw({ probe: false } as never);
    expect(h.draws).toBe(2);
    settings.set('layerState.ExtendedSatelliteOn', false);
    expect(layer.probeKind()).toBeNull();
  });
});
