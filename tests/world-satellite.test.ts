// NOAA GMGSI global satellite mosaic: decoding real public files (noaa-gmgsi-pds, 2026-11-20 18:00 UTC, longwave IR
// and visible, every 40th row and 50th column kept so that the fixtures stay small) and the World satellite layer's
// listing, frame identity and frame choice.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { H5Like } from '../src/decode/goes';
import { readGmgsi, gmgsiTexel, checkGrid, gmgsiKeyTime, gmgsiScanRange, gmgsiColumns } from '../src/decode/gmgsi';
import { pickValidFrame } from '../src/layers/world-common';
import { settings } from '../src/settings/store';
import { timeline } from '../src/app/timeline';

type Deferred = { arg: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ lists: [] as Deferred[], runs: [] as Deferred[], draws: [] as any[] }));
const defer = (list: Deferred[], arg: unknown) => new Promise((resolve, reject) => list.push({ arg, resolve, reject }));
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), listS3: vi.fn((_bucket: string, prefix: string) => defer(h.lists, prefix)) }));
vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => defer(h.runs, { task, args })); return { pool: { run, for: () => ({ run }) } }; });
vi.mock('../src/render/raster', async (orig) => ({ ...(await orig<object>()), RasterDraw: class { draw(_c: unknown, p: unknown) { h.draws.push(p); } invalidate() {} }, Lut: class {} }));
import { WorldSatelliteLayer, gmgsiHourPrefixes, GMGSI_MAX_FRAMES } from '../src/layers/world-satellite';
import { GMGSI_PRODUCTS } from '../src/decode/gmgsi';

const DIR = new URL('./fixtures/gmgsi/', import.meta.url);
const LW = 'GLOBCOMPLIR_s202611201800_sub40x50.nc', VIS = 'GLOBCOMPVIS_s202611201800_sub40x50.nc';
let h5: H5Like;
let h5raw: any;
beforeAll(async () => {
  const mod = await import('h5wasm/node');
  const { FS } = await mod.default.ready;
  h5raw = mod.default;
  h5 = { FS: { writeFile: (p, d) => FS.writeFile(p, d), unlink: (p) => FS.unlink(p) }, File: mod.default.File as unknown as H5Like['File'] };
});
const file = (name: string) => new Uint8Array(readFileSync(new URL(name, DIR)));
/** The fixture's own arrays (lat/lon per pixel, values, quality), read without the decoder. */
function raw(name: string) {
  const f = new h5raw.File(new URL(name, DIR).pathname, 'r');
  const [, ny, nx] = f.get('data').shape;
  const r = { ny, nx, lat: f.get('lat').value as Float32Array, lon: f.get('lon').value as Float32Array, data: f.get('data').value as Float32Array, dqf: f.get('dqf').value as Int8Array };
  f.close();
  return r;
}
const code = (v: number) => 1 + Math.round((v * 254) / 255);

describe('GMGSI decoding (real files)', () => {
  it('reads the Mercator grid, times and satellites of the longwave IR mosaic', () => {
    const g = readGmgsi(h5, file(LW), 1);
    expect([g.width, g.height, g.proj.kind, g.proj.flip]).toEqual([100, 75, 4, true]);
    // Outer edges: half a (subsampled) row beyond the first row (72.72°) and the last kept row (source row 2960).
    expect(g.bounds[0]).toBeCloseTo(73.14, 1);
    expect(g.bounds[2]).toBeCloseTo(-72.33, 1);
    expect([g.bounds[1], g.bounds[3]]).toEqual([-180, 180]);
    expect(g.nominalMs).toBe(Date.UTC(2026, 10, 20, 18));
    // Meteosat 17:45/18:00, Himawari 17:40–18:00, GOES 17:50/18:00 scans named in `source`.
    expect([g.scanStartMs, g.scanEndMs]).toEqual([Date.UTC(2026, 10, 20, 17, 40), Date.UTC(2026, 10, 20, 18, 0, 22)]);
    expect(g.platforms).toBe('H-9,G18,G19,Meteosat10,Meteosat9');
  });

  it('places every pixel at its own latitude/longitude: no mirroring, no shift and no seam at the antimeridian', () => {
    const g = readGmgsi(h5, file(LW), 1), r = raw(LW);
    // For points all over the grid (both sides of ±180° included), the texel the shader samples holds the value of
    // the fixture pixel nearest that point by its own lat/lon arrays.
    let checked = 0;
    for (let lat = -70; lat <= 70; lat += 7.3) for (let lon = -179.9; lon <= 180; lon += 13.1) {
      const t = gmgsiTexel(g.proj, lon, lat)!;
      expect(t).not.toBeNull();
      let best = -1, bd = Infinity;
      for (let k = 0; k < r.ny * r.nx; k++) {
        const dLon = Math.abs(((r.lon[k] - lon + 540) % 360) - 180), dLat = Math.abs(r.lat[k] - lat);
        const d = dLon * dLon + dLat * dLat * 4; // rows are denser than columns in latitude near the poles
        if (d < bd) { bd = d; best = k; }
      }
      const i = Math.round(t[0]), j = Math.round(t[1]);
      if (Math.abs(t[0] - Math.round(t[0])) > 0.45 || Math.abs(t[1] - Math.round(t[1])) > 0.45) continue; // halfway between pixels
      expect([j, ((i % r.nx) + r.nx) % r.nx]).toEqual([Math.floor(best / r.nx), best % r.nx]);
      if (r.dqf[best] === 0) expect(g.codes[j * g.width + (((i % r.nx) + r.nx) % r.nx)]).toBe(code(r.data[best]));
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
    // Either side of the antimeridian lands at the two ends of the same row (column 0 is at 180°), not mid-grid.
    const e = gmgsiTexel(g.proj, 179.99, 0)!, w = gmgsiTexel(g.proj, -179.99, 0)!;
    expect(Math.abs(e[0]) < 0.6 || Math.abs(e[0] - (g.width - 1)) < 0.6).toBe(true);
    expect(Math.abs(w[0]) < 0.6).toBe(true);
    expect(e[1]).toBeCloseTo(w[1], 6);
    // Beyond the grid (polar caps) there is no texel at all.
    expect(gmgsiTexel(g.proj, 0, 80)).toBeNull();
    expect(gmgsiTexel(g.proj, 0, -80)).toBeNull();
  });

  it('shows brightness, not a mirror image: cold Greenland ice is brighter than the warm Sahara in longwave IR', () => {
    const g = readGmgsi(h5, file(LW), 1);
    const at = (lon: number, lat: number) => { const t = gmgsiTexel(g.proj, lon, lat)!; return g.codes[Math.round(t[1]) * g.width + Math.round(t[0])]; };
    expect(at(-40, 72)).toBeGreaterThan(at(10, 23) + 60);
  });

  it('keeps only good-quality pixels: the visible mosaic has no data on the night side', () => {
    const g = readGmgsi(h5, file(VIS), 1), r = raw(VIS);
    let bad = 0, empty = 0;
    for (let k = 0; k < r.data.length; k++) { if (r.dqf[k] !== 0) bad++; if (!g.codes[k]) empty++; }
    expect(bad).toBeGreaterThan(1000); // 18 UTC: Africa, Europe and Asia are dark
    expect(empty).toBe(bad);
    const at = (lon: number, lat: number) => { const t = gmgsiTexel(g.proj, lon, lat)!; return g.codes[Math.round(t[1]) * g.width + Math.round(t[0])]; };
    expect(at(100, 30)).toBe(0); // China at local midnight
    expect(at(-60, -5)).toBeGreaterThan(0); // Amazon in daylight
  });

  it('block-averages good pixels only and keeps the grid georeferenced', () => {
    const g1 = readGmgsi(h5, file(VIS), 1), g2 = readGmgsi(h5, file(VIS), 2);
    expect([g2.width, g2.height]).toEqual([50, 37]);
    for (let j = 0; j < g2.height; j++) for (let i = 0; i < g2.width; i++) {
      const src = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => g1.codes[(2 * j + dy) * g1.width + 2 * i + dx]).filter((c) => c > 0);
      const c = g2.codes[j * g2.width + i];
      if (!src.length) { expect(c).toBe(0); continue; }
      const mean = src.reduce((s, x) => s + (x - 1) * (255 / 254), 0) / src.length;
      expect(Math.abs(c - code(mean))).toBeLessThanOrEqual(1);
    }
    // The averaged texel of a point is the block holding the full-resolution texel.
    for (const [lon, lat] of [[-60, -5], [140, 35], [-120, 40], [179.5, -10]]) {
      const a = gmgsiTexel(g1.proj, lon, lat)!, b = gmgsiTexel(g2.proj, lon, lat)!;
      expect(Math.abs(b[0] - (a[0] - 0.5) / 2)).toBeLessThan(0.01);
      expect(Math.abs(b[1] - (a[1] - 0.5) / 2)).toBeLessThan(0.01);
    }
  });

  it('spreads the columns over exactly 360° for every factor: no antimeridian gap, good pixels only, georeferenced', () => {
    const r = raw(LW), { nx, ny } = r;
    const grid = checkGrid(Array.from({ length: ny }, (_, j) => r.lat[j * nx]), r.lon.slice(0, nx));
    const gap = 360 - nx * grid.di; // the fixture's columns (every 50th) leave −0.04° at the seam; natively +0.03°
    const lat = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);
    for (const k of [1, 2, 3]) {
      const g = readGmgsi(h5, file(LW), k), W = Math.floor(nx / k), H = Math.floor(ny / k);
      expect([g.width, g.height]).toEqual([W, H]);
      expect([g.bounds[1], g.bounds[3]]).toEqual([-180, 180]);
      // Latitude edges: the first row's northern edge and the southern edge of the last row kept (ny mod k left out).
      expect(g.bounds[0]).toBeCloseTo(lat(grid.y0 + grid.dy / 2), 6);
      expect(g.bounds[2]).toBeCloseTo(lat(grid.y0 - grid.dy * (k * H - 0.5)), 6);
      // Output column c holds the k or k+1 source columns whose centres fall in it (k = 3: 33 columns from 100).
      const bin = (s: number) => Math.min(W - 1, Math.floor(((s + 0.5) * W) / nx));
      const per = new Array(W).fill(0);
      for (let s = 0; s < nx; s++) per[bin(s)]++;
      expect(per.every((n) => n === k || n === k + 1)).toBe(true);
      // Each code is the mean of the good pixels of its block, never a value for a block without one.
      for (let j = 0; j < H; j++) for (let c = 0; c < W; c++) {
        let sum = 0, n = 0;
        for (let dy = 0; dy < k; dy++) for (let s = 0; s < nx; s++) {
          const q = (j * k + dy) * nx + s;
          if (bin(s) === c && r.dqf[q] === 0 && r.data[q] >= 0 && r.data[q] <= 255) { sum += r.data[q]; n++; }
        }
        expect(g.codes[j * W + c]).toBe(n ? code(sum / n) : 0);
      }
      // Every source column's own longitude lands in its output column, moved by at most half the seam gap.
      for (let s = 0; s < nx; s++) {
        const t = gmgsiTexel(g.proj, r.lon[s], 0)!;
        const off = (((t[0] + 0.5 - ((s + 0.5) * W) / nx) % W) + W + W / 2) % W - W / 2;
        expect(Math.abs(off)).toBeLessThanOrEqual((Math.abs(gap) / 2) * (W / 360) + 1e-9);
      }
      // Every longitude has a texel, continuous across ±180° (the column only ever advances by one, wrapping once).
      let prev = -1, wraps = 0;
      for (let lon = -180; lon <= 180; lon += 0.01) {
        const t = gmgsiTexel(g.proj, lon, 10);
        expect(t).not.toBeNull();
        const c = ((Math.round(t![0]) % W) + W) % W;
        if (prev >= 0 && c !== prev) { expect((c - prev + W) % W).toBe(1); if (c < prev) wraps++; }
        prev = c;
      }
      expect(wraps).toBeLessThanOrEqual(1);
      // Longwave IR has good pixels all along the antimeridian at low latitudes: drawn on both sides.
      for (const lon of [179.99, 180, -179.99, 179.2, -179.2]) for (const la of [-30, 0, 30]) {
        const t = gmgsiTexel(g.proj, lon, la)!;
        expect(g.codes[Math.round(t[1]) * W + ((Math.round(t[0]) % W) + W) % W]).toBeGreaterThan(0);
      }
    }
  });

  it('closes the native seam: 4999 columns from 180° to 179.9° spread over exactly 360°, each moved at most 0.014°', () => {
    const nx = 4999, step = 359.9 / 4998;
    const lon = Array.from({ length: nx }, (_, i) => { const l = 180 + i * step; return l > 180 ? l - 360 : l; });
    expect([lon[1], lon[2], lon[nx - 3], lon[nx - 1]].map((x) => +x.toFixed(3))).toEqual([-179.928, -179.856, 179.756, 179.9]);
    const merc = (k: number) => (2 * Math.atan(Math.exp(1.88 - k * 0.001)) - Math.PI / 2) * (180 / Math.PI);
    const grid = checkGrid(Array.from({ length: 50 }, (_, k) => merc(k)), lon);
    for (const k of [1, 2, 3]) {
      const { W, col, west } = gmgsiColumns(grid.lon0, grid.di, nx, k), dw = 360 / W;
      expect(W).toBe([4999, 2499, 1666][k - 1]);
      if (k === 1) expect(col.every((c, s) => c === s)).toBe(true);
      expect(col[0]).toBe(0); expect(col[nx - 1]).toBe(W - 1);
      let worst = 0;
      for (let s = 0; s < nx; s++) {
        // Source column s's centre against its place in the stretched index space of the output columns.
        const at = west + ((s + 0.5) * W / nx) * dw, own = grid.lon0 + s * grid.di;
        worst = Math.max(worst, Math.abs(((at - own + 540) % 360) - 180));
        expect(col[s]).toBe(Math.floor(((at - west) / dw + 360 / dw) % W));
      }
      expect(worst).toBeLessThanOrEqual(0.0141);
    }
  });

  it('rejects grids it does not understand instead of drawing them misplaced', () => {
    const lon = Array.from({ length: 100 }, (_, i) => -180 + i * 3.6);
    const merc = (k: number) => (2 * Math.atan(Math.exp(1.88 - k * 0.05)) - Math.PI / 2) * (180 / Math.PI);
    expect(() => checkGrid(Array.from({ length: 75 }, (_, k) => merc(k)), lon)).not.toThrow();
    expect(() => checkGrid(Array.from({ length: 75 }, (_, k) => 72 - k * 2), lon)).toThrow(/Mercator/); // equirectangular rows
    expect(() => checkGrid(Array.from({ length: 75 }, (_, k) => merc(74 - k)), lon)).toThrow(/north to south/);
    expect(() => checkGrid(Array.from({ length: 75 }, (_, k) => merc(k)), lon.slice(0, 50))).toThrow(/span the globe/);
  });

  it('parses object names and the scan times of the source list', () => {
    expect(gmgsiKeyTime('GMGSI_LW/2026/11/20/18/GLOBCOMPLIR_v3r0_blend_s202611201800000_e202611201809599_c202611201833438.nc')).toBe(Date.UTC(2026, 10, 20, 18));
    expect(gmgsiKeyTime('GMGSI_LW/2026/11/20/18/notes.txt')).toBeNull();
    expect(gmgsiScanRange('LIR/H-000-MSG3__-MSG3________-IR_108___-000001___-202611201745-C_,LIR/HS_H09_20261120_1800_B13_FLDK_R20_S0310.DAT')).toEqual([Date.UTC(2026, 10, 20, 17, 45), Date.UTC(2026, 10, 20, 18)]);
    expect(gmgsiScanRange('')).toBeNull();
  });
});

describe('frame choice', () => {
  const fs = [0, 60, 120].map((m) => ({ t: m * 60e3 }));
  it('shows the newest frame at or before the time, within its validity, and nothing outside it', () => {
    expect(pickValidFrame(fs, 90 * 60e3, 120 * 60e3, 65 * 60e3, 150 * 60e3)?.t).toBe(60 * 60e3);
    expect(pickValidFrame(fs, -10 * 60e3, 120 * 60e3, 65 * 60e3, 150 * 60e3)).toBeNull(); // before the first frame
    expect(pickValidFrame([{ t: 0 }, { t: 180 * 60e3 }], 100 * 60e3, 180 * 60e3, 65 * 60e3, 150 * 60e3)).toBeNull(); // a gap
    expect(pickValidFrame(fs, 260 * 60e3, 120 * 60e3, 65 * 60e3, 150 * 60e3)?.t).toBe(120 * 60e3); // newest, not yet replaced
    expect(pickValidFrame(fs, 280 * 60e3, 120 * 60e3, 65 * 60e3, 150 * 60e3)).toBeNull();
  });
});

describe('World satellite layer', () => {
  const r = { gpu: { texture2D: () => ({ destroy: vi.fn() }) } } as never;
  const key = (h: number) => { const d = new Date(Date.UTC(2026, 10, 20, h)); const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 10); return `GMGSI_LW/2026/11/20/${String(h).padStart(2, '0')}/GLOBCOMPLIR_v3r0_blend_s${s}00000_e${s}09599_c${s}33438.nc`; };
  const listing = (prefix: string) => { const hh = +prefix.split('/')[4]; return { objects: [{ key: key(hh), size: 7e6, lastModified: '' }], prefixes: [] }; };
  /** One file of the prefix's channel and hour. */
  const listingOf = (prefix: string) => {
    const [dir, , , , hh] = prefix.split('/'), s = `20261120${hh}`, p = GMGSI_PRODUCTS.find((x) => x.prefix === dir)!;
    return { objects: [{ key: `${prefix}${p.file}_v3r0_blend_s${s}00000_e${s}09599_c${s}33438.nc`, size: 7e6, lastModified: '' }], prefixes: [] };
  };
  const image = (t: number) => ({ width: 2, height: 2, codes: new Uint8Array(4), proj: { kind: 4, nx: 2, ny: 2, a: [1, 0, 0, 0], b: [0.5, 0, 1, 1] }, bounds: [72, -180, -72, 180], nominalMs: t, scanStartMs: null, scanEndMs: null, platforms: '' });
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  beforeEach(() => {
    h.lists.length = 0; h.runs.length = 0; h.draws.length = 0;
    timeline.setArchive(Date.UTC(2026, 10, 20, 20, 30));
    timeline.refreshWindow();
    settings.set('ext.layerState.LoopLength', 3);
    settings.set('ext.layerState.WorldSatelliteOn', true);
    settings.set('ext.layerState.WorldSatelliteProduct', 0);
  });
  afterEach(() => { timeline.setArchive(null); settings.set('ext.layerState.WorldSatelliteOn', false); });

  it('lists the hours of the loop window and loads the newest frames first, at most the frame cap', async () => {
    const l = new WorldSatelliteLayer(r);
    const p = l.refresh();
    expect(h.lists.map((x) => x.arg)).toEqual(gmgsiHourPrefixes(GMGSI_PRODUCTS[0], timeline.loopStart - 150 * 60e3, timeline.loopEnd));
    for (const x of h.lists) x.resolve(listing(x.arg));
    await p;
    expect(h.runs.length).toBe(2); // two frames decode at a time, newest first
    expect(h.runs[0].arg).toMatchObject({ task: 'gmgsi', args: { url: expect.stringContaining('/20/GLOBCOMPLIR_v3r0_blend_s2026112020') } });
    expect(l.status.text).toMatch(/GMGSI IR: 0\/[45] hourly frames/);
    expect(GMGSI_MAX_FRAMES).toBeGreaterThanOrEqual(7);
  });

  it('discards a listing that returns after the channel changed, and decodes only the channel now selected', async () => {
    const l = new WorldSatelliteLayer(r);
    const first = l.refresh();
    const stale = h.lists.splice(0);
    settings.set('ext.layerState.WorldSatelliteProduct', 1);
    const second = l.refresh();
    for (const x of stale) x.resolve(listing(x.arg));
    await first;
    expect(h.runs.length).toBe(0); // the IR listing is not used for the visible channel
    expect(h.lists.every((x) => x.arg.startsWith('GMGSI_VIS/'))).toBe(true);
    for (const x of h.lists) x.resolve({ objects: [{ key: x.arg + 'GLOBCOMPVIS_v3r0_blend_s202611202000000_e202611202009599_c202611202038535.nc', size: 1, lastModified: '' }], prefixes: [] });
    await second;
    expect(h.runs.every((x) => x.arg.args.url.includes('GMGSI_VIS/'))).toBe(true);
  });

  it('draws only a frame valid at the map time, labelled with its nominal hour', async () => {
    const l = new WorldSatelliteLayer(r);
    const p = l.refresh();
    for (const x of h.lists) x.resolve(listing(x.arg));
    await p;
    for (const run of h.runs.splice(0)) run.resolve(image(gmgsiKeyTime(run.arg.args.url)!));
    await settle();
    timeline.t = Date.UTC(2026, 10, 20, 20, 30);
    l.draw({ probe: false, pane: 0 } as never);
    expect(h.draws.length).toBe(1);
    expect(l.mapLabel()).toMatch(/NOAA GMGSI IR 2026-11-20 20:00 UTC/);
    timeline.t = Date.UTC(2026, 10, 20, 10); // hours before any loaded frame
    l.draw({ probe: false, pane: 0 } as never);
    expect(h.draws.length).toBe(1);
  });

  it('reports archive times without files as not available, and draws nothing', async () => {
    const l = new WorldSatelliteLayer(r);
    const p = l.refresh();
    for (const x of h.lists) x.resolve({ objects: [], prefixes: [] });
    await p;
    expect(l.status.state).toBe('unavailable');
    l.draw({ probe: false, pane: 0 } as never);
    expect(h.draws.length).toBe(0);
  });

  it('lists a window once while its listing is pending: a second refresh joins it', async () => {
    const l = new WorldSatelliteLayer(r);
    const a = l.refresh(), b = l.refresh();
    const prefixes = gmgsiHourPrefixes(GMGSI_PRODUCTS[0], timeline.loopStart - 150 * 60e3, timeline.loopEnd);
    expect(h.lists.map((x) => x.arg)).toEqual(prefixes);
    for (const x of h.lists) x.resolve(listing(x.arg));
    await Promise.all([a, b]);
    expect(h.lists.length).toBe(prefixes.length);
    expect(l.status.text).toMatch(/0\/4 hourly frames/);
  });

  it('keeps the latest window when an older listing of the same channel answers last, or fails last', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      h.lists.length = 0; h.runs.length = 0;
      settings.set('ext.layerState.LoopLength', 3);
      const l = new WorldSatelliteLayer(r);
      const long = l.refresh(); // 16:30–20:30: hours 16–20
      const older = h.lists.splice(0);
      settings.set('ext.layerState.LoopLength', 1); // 18:30–20:30: hours 18–20
      const short = l.refresh();
      expect(h.lists.map((x) => x.arg)).toEqual(gmgsiHourPrefixes(GMGSI_PRODUCTS[0], timeline.loopStart - 150 * 60e3, timeline.loopEnd));
      for (const x of h.lists) x.resolve(listing(x.arg));
      await short;
      expect(l.status.text).toMatch(/0\/2 hourly frames/); // 19:00 and 20:00
      for (const x of older) if (outcome === 'success') x.resolve(listing(x.arg)); else x.reject(new Error('HTTP 503'));
      await long; await settle();
      expect(l.status.state).toBe('loading');
      expect(l.status.text).toMatch(/0\/2 hourly frames/);
      expect(h.runs.map((x) => gmgsiKeyTime(x.arg.args.url))).toEqual([Date.UTC(2026, 10, 20, 20), Date.UTC(2026, 10, 20, 19)]);
    }
  });

  it('returning to a window listed moments ago supersedes the listing of the window in between', async () => {
    const l = new WorldSatelliteLayer(r);
    const p = l.refresh();
    for (const x of h.lists.splice(0)) x.resolve(listing(x.arg));
    await p;
    expect(l.status.text).toMatch(/0\/4 hourly frames/);
    settings.set('ext.layerState.LoopLength', 1);
    const short = l.refresh();
    settings.set('ext.layerState.LoopLength', 3);
    await l.refresh(); // listed moments ago: nothing new to list
    for (const x of h.lists.splice(0)) x.resolve(listing(x.arg));
    await short;
    expect(l.status.text).toMatch(/0\/4 hourly frames/);
  });

  it('tries a failed frame again with the next listing while it is still wanted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2026, 10, 20, 21));
    try {
      const l = new WorldSatelliteLayer(r);
      const p = l.refresh();
      for (const x of h.lists.splice(0)) x.resolve(listing(x.arg));
      await p;
      const newest = h.runs.shift()!;
      newest.reject(new Error('network'));
      await settle();
      expect(l.status.text).toMatch(/1 failed \(network\)/);
      expect(h.runs.map((x) => x.arg.args.url)).not.toContain(newest.arg.args.url);
      await l.refresh();
      expect(h.lists.length).toBe(0); // within the listing interval: no new listing, no retry yet
      vi.setSystemTime(Date.UTC(2026, 10, 20, 21, 6));
      const q = l.refresh();
      for (const x of h.lists.splice(0)) x.resolve(listing(x.arg));
      await q;
      expect(l.status.text).not.toMatch(/failed/);
      for (const run of h.runs.splice(0)) run.resolve(image(gmgsiKeyTime(run.arg.args.url)!));
      await settle();
      expect(h.runs.map((x) => x.arg.args.url)).toContain(newest.arg.args.url);
    } finally { vi.useRealTimers(); }
  });

  it('draws and probes with nearest sampling (a missing pixel next to good ones is never blended into a value)', async () => {
    const l = new WorldSatelliteLayer(r);
    const p = l.refresh();
    for (const x of h.lists) x.resolve(listing(x.arg));
    await p;
    for (const run of h.runs.splice(0)) run.resolve(image(gmgsiKeyTime(run.arg.args.url)!));
    await settle();
    timeline.t = Date.UTC(2026, 10, 20, 20, 30);
    l.draw({ probe: false, pane: 0 } as never);
    l.draw({ probe: true, pane: 0 } as never);
    expect(h.draws.map((d) => d.smoothing)).toEqual([false, false]);
  });

  it('keeps the frame before a short loop when the next hour is not published yet', async () => {
    settings.set('ext.layerState.LoopLength', 0.5);
    for (const [archive, prefixes] of [[Date.UTC(2026, 10, 20, 12, 35), [9, 10, 11, 12]], [Date.UTC(2026, 10, 20, 13, 20), [10, 11, 12, 13]]] as const) {
      h.lists.length = 0; h.runs.length = 0; h.draws.length = 0;
      timeline.setArchive(archive);
      const l = new WorldSatelliteLayer(r);
      const p = l.refresh();
      // Listed from 150 minutes (the newest frame's validity) before the start of the loop.
      expect(h.lists.map((x) => +x.arg.split('/')[4])).toEqual(prefixes);
      for (const x of h.lists) x.resolve(+x.arg.split('/')[4] <= 11 ? listingOf(x.arg) : { objects: [], prefixes: [] }); // 12:00 is late
      await p;
      expect(h.runs.map((x) => gmgsiKeyTime(x.arg.args.url))).toEqual([Date.UTC(2026, 10, 20, 11)]); // not 10:00
      h.runs[0].resolve(image(Date.UTC(2026, 10, 20, 11)));
      await settle();
      timeline.t = archive;
      l.draw({ probe: false, pane: 0 } as never);
      expect(h.draws.length).toBe(1);
      expect(l.mapLabel()).toMatch(/GMGSI IR 2026-11-20 11:00 UTC/);
    }
  });

  it('a 13:10–13:40 loop lists from 150 minutes before its start and plays the 11:00 frame until 13:30', async () => {
    settings.set('ext.layerState.LoopLength', 0.5);
    timeline.setArchive(Date.UTC(2026, 10, 20, 13, 40));
    const l = new WorldSatelliteLayer(r);
    const p = l.refresh();
    expect(h.lists.map((x) => +x.arg.split('/')[4])).toEqual([10, 11, 12, 13]); // from 10:40
    for (const x of h.lists) x.resolve(+x.arg.split('/')[4] <= 11 ? listingOf(x.arg) : { objects: [], prefixes: [] }); // 12:00, 13:00 late
    await p;
    expect(h.runs.map((x) => gmgsiKeyTime(x.arg.args.url))).toEqual([Date.UTC(2026, 10, 20, 11)]);
    h.runs[0].resolve(image(Date.UTC(2026, 10, 20, 11)));
    await settle();
    const drawnAt = (hh: number, mm: number) => {
      const n = h.draws.length;
      timeline.t = Date.UTC(2026, 10, 20, hh, mm);
      l.draw({ probe: false, pane: 0 } as never);
      return h.draws.length > n;
    };
    expect([drawnAt(13, 10), drawnAt(13, 20), drawnAt(13, 30)]).toEqual([true, true, true]);
    expect(l.mapLabel()).toMatch(/GMGSI IR 2026-11-20 11:00 UTC/);
    expect([drawnAt(13, 31), drawnAt(13, 40)]).toEqual([false, false]); // 150 minutes after 11:00: nothing, not a stale frame
  });

  it('switching channels never runs more than two decodes, uploads none of a dropped channel and loads the newest frames next', async () => {
    const texture2D = vi.fn(() => ({ destroy: vi.fn() }));
    const l = new WorldSatelliteLayer({ gpu: { texture2D } } as never);
    const listAll = async () => { const p = l.refresh(); for (const x of h.lists.splice(0)) x.resolve(listingOf(x.arg)); await p; await settle(); };
    await listAll();
    expect(h.runs.length).toBe(2);
    for (const product of [1, 2, 1, 3, 0, 2]) { settings.set('ext.layerState.WorldSatelliteProduct', product); await listAll(); }
    expect(h.runs.length).toBe(2); // the first two decodes still hold both slots
    for (const run of h.runs.splice(0)) run.resolve(image(gmgsiKeyTime(run.arg.args.url)!));
    await settle();
    expect(texture2D).not.toHaveBeenCalled(); // decoded for longwave IR, discarded before upload
    expect(h.runs.map((x) => x.arg.args.url.split('/')[3] + ' ' + gmgsiKeyTime(x.arg.args.url))).toEqual([`GMGSI_WV ${Date.UTC(2026, 10, 20, 20)}`, `GMGSI_WV ${Date.UTC(2026, 10, 20, 19)}`]);
    for (const run of h.runs.splice(0)) run.resolve(image(gmgsiKeyTime(run.arg.args.url)!));
    await settle();
    expect(texture2D).toHaveBeenCalledTimes(2);
    expect(l.status.text).toMatch(/GMGSI WV: 2\/4 hourly frames/);
  });

  it('makes no request while off', async () => {
    settings.set('ext.layerState.WorldSatelliteOn', false);
    const l = new WorldSatelliteLayer(r);
    await l.refresh();
    expect(h.lists.length + h.runs.length).toBe(0);
    expect(l.status.state).toBe('off');
  });
});
