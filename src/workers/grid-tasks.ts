// Gridded-product work for the decode worker: GRIB2 retrieval by inventory match and HTTP Range,
// unit conversion, quantisation and texture encoding, derived fields (wind speed, EHI, STP/SCP, differences),
// isolines and wind vectors. Everything returned is ready for upload; the main thread only copies to the GPU.
import { decodeGrib2, gridSize, type GribField, type Grid } from '../decode/grib2';
import { parseIdx, matchIdx } from '../decode/hrrr';
import { fetchBytes, fetchText } from '../data/net';
import { gunzip, inflateZlib } from '../decode/zip';
import { gridProj, gridBounds, gridMap, type ProjParamsLike } from '../gis/gridproj';
import { toHalf } from '../render/half';
import { gaussianBlur, isolines } from '../gis/contour';
import type { JobClock } from './job-clock';

const inflate = (b: Uint8Array) => inflateZlib(b);

export interface GeoInfo { nx: number; ny: number; proj: ProjParamsLike; bounds: [number, number, number, number]; grid: Grid }

/**
 * Fetches GRIB2 messages: whole file (optionally gzip) or, with matches, the inventory-selected byte ranges.
 * Decompression and decoding (PNG inflate, JPEG 2000) count as the job's processing time.
 */
export async function fetchGrib(url: string, matches: string[] | null, job: JobClock, o: { gz?: boolean; idxExt?: string; cache?: 'immutable' | 'none' } = {}): Promise<GribField[][]> {
  if (!matches) {
    const bytes = await fetchBytes(url, { cache: o.cache ?? 'none', maxBytes: 256 * 1024 * 1024 });
    return [await job.time(async () => decodeGrib2(o.gz || (bytes[0] === 0x1f && bytes[1] === 0x8b) ? await gunzip(bytes) : bytes, inflate))];
  }
  const idx = parseIdx(await fetchText(url + (o.idxExt ?? '.idx'), { cache: o.cache }));
  return Promise.all(matches.map(async (m) => {
    const hits = matchIdx(idx, m);
    if (!hits.length) throw new Error(`no inventory line matches "${m}"`);
    const out: GribField[] = [];
    // The first matching line is used (lines matching the product's GRIB match select messages).
    const e = hits[0];
    const bytes = await fetchBytes(url, { cache: o.cache ?? 'immutable', range: [e.start, e.end ?? e.start + 200_000_000] });
    out.push(...(await job.time(() => decodeGrib2(bytes, inflate))));
    return out;
  }));
}

/** Normalised half-float texture data: (v − lo)/(hi − lo) clamped to [0, 1]; NaN → −1 (missing). */
export function encodeNormHalf(values: Float32Array, lo: number, hi: number, conv?: (v: number) => number): Uint16Array {
  const f = new Float32Array(values.length), span = hi - lo || 1;
  for (let i = 0; i < values.length; i++) {
    let v = values[i];
    if (v !== v) { f[i] = -1; continue; }
    if (conv) v = conv(v);
    f[i] = Math.min(1, Math.max(0, (v - lo) / span));
  }
  return toHalf(f);
}

/** Max-downsampling by an integer factor (keeps peaks, e.g. reflectivity cores). NaN only when every input is NaN. */
export function downsampleMax(values: Float32Array, w: number, h: number, k: number): { values: Float32Array; w: number; h: number } {
  if (k <= 1) return { values, w, h };
  const W = Math.floor(w / k), H = Math.floor(h / k), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = NaN;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) { const v = values[(y * k + dy) * w + x * k + dx]; if (v === v && !(v <= best)) best = v; }
    out[y * W + x] = best;
  }
  return { values: out, w: W, h: H };
}

/** Grid definition after integer downsampling: first point moves to the centre of the first k×k block. */
export function downsampleGrid(g: Grid, k: number): Grid {
  if (k <= 1) return g;
  const [w, h] = gridSize(g);
  const [lo1, la1] = gridMap(g).inv((k - 1) / 2, (k - 1) / 2);
  if (g.kind === 'latlon') {
    const [lo2, la2] = gridMap(g).inv((Math.floor(w / k) - 1) * k + (k - 1) / 2, (Math.floor(h / k) - 1) * k + (k - 1) / 2);
    return { ...g, ni: Math.floor(w / k), nj: Math.floor(h / k), la1, lo1, la2, lo2, di: g.di * k, dj: g.dj * k };
  }
  if (g.kind === 'mercator') return { ...g, nx: Math.floor(w / k), ny: Math.floor(h / k), la1, lo1, di: g.di * k, dj: g.dj * k };
  return { ...g, nx: Math.floor(w / k), ny: Math.floor(h / k), la1, lo1, dx: g.dx * k, dy: g.dy * k };
}
export function geoOfGrid(grid: Grid): GeoInfo {
  const [nx, ny] = gridSize(grid);
  return { nx, ny, proj: gridProj(grid), bounds: gridBounds(grid), grid };
}

/** Isolines of a field in lon/lat (levels at multiples of `interval`), optionally smoothed. */
export function contourLines(f: GribField, interval: number, scale: number | ((v: number) => number) = 1, smoothCells = 0, step = 1): { level: number; coords: number[] }[] {
  const [w, h] = gridSize(f.grid);
  const W = Math.floor(w / step), H = Math.floor(h / step), v = new Float32Array(W * H);
  const conv = typeof scale === 'function' ? scale : (x: number) => x * scale;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v[y * W + x] = conv(f.values[y * step * w + x * step]);
  const sm = smoothCells > 0 ? gaussianBlur(v, W, H, smoothCells) : v;
  let lo = Infinity, hi = -Infinity;
  for (const x of sm) if (x === x) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  if (!(hi > lo)) return [];
  const levels: number[] = [];
  for (let L = Math.ceil(lo / interval) * interval; L <= hi && levels.length < 400; L += interval) levels.push(L);
  const m = gridMap(f.grid);
  return isolines(sm, W, H, levels).flatMap((lv) => lv.lines.filter((l) => l.length >= 6).map((l) => {
    const ll: number[] = [];
    for (let k = 0; k < l.length; k += 2) { const [lon, lat] = m.inv(l[k] * step, l[k + 1] * step); ll.push(lon, lat); }
    return { level: lv.level, coords: ll };
  }));
}

/** Value conversion to a model product's unit label (decoder-style English units). */
export function unitConv(unit: string, f: GribField): ((v: number) => number) | null {
  const key = `${f.discipline}.${f.category}.${f.number}`;
  switch (unit) {
    case '°F': case 'F': return (k) => (k - 273.15) * 1.8 + 32;
    case '°C': case 'C': return (k) => k - 273.15;
    case 'mph': return (v) => v * 2.23694;
    case 'kt': case 'kts': return (v) => v * 1.943844;
    case 'mb': case 'hPa': return (pa) => pa / 100;
    case 'dam': return (m) => m / 10;
    case 'mi': return (m) => m / 1609.344;
    case 'ft': return (m) => m * 3.28084;
    case 'in': return key === '0.1.11' || key === '0.1.29' ? (m) => m * 39.3701 : (kg) => kg / 25.4;
  }
  return null;
}

/** Earth-relative wind samples (lon, lat, u, v m/s) every `step` cells; grid-relative components are rotated. */
export function windSamples(u: GribField, v: GribField, step: number): Float32Array {
  const g = u.grid, [w, h] = gridSize(g), m = gridMap(g);
  const out: number[] = [];
  const rel = (g.kind === 'lambert' || g.kind === 'polar') && g.uvGrid;
  let cone = 0;
  if (g.kind === 'lambert') { const p1 = (g.latin1 * Math.PI) / 180, p2 = (g.latin2 * Math.PI) / 180; cone = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2)); }
  const lov = g.kind === 'lambert' || g.kind === 'polar' ? g.lov : 0;
  for (let j = Math.floor(step / 2); j < h; j += step) for (let i = Math.floor(step / 2); i < w; i += step) {
    const k = j * w + i;
    let uu = u.values[k], vv = v.values[k];
    if (uu !== uu || vv !== vv) continue;
    const [lon, lat] = m.inv(i, j);
    if (rel) {
      let dl = lon - lov; while (dl > 180) dl -= 360; while (dl < -180) dl += 360;
      const ang = (g.kind === 'lambert' ? cone : (g as { south: boolean }).south ? -1 : 1) * dl * (Math.PI / 180);
      const c = Math.cos(ang), s = Math.sin(ang);
      [uu, vv] = [c * uu + s * vv, -s * uu + c * vv];
    }
    out.push(lon, lat, uu, vv);
  }
  return Float32Array.from(out);
}
