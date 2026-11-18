/// <reference lib="webworker" />
// Decode worker: all heavy format work (bzip2/Archive II, Level III, GRIB2, NetCDF/HDF5, shapefiles) runs here.
import { Archive2Decoder, type L2Volume } from '../decode/archive2';
import { bunzip2 } from '../decode/bzip2';
import { decodeLevel3, type L3Product } from '../decode/level3';
import { decodeGrib2, scanGribMessages, type GribField } from '../decode/grib2';
import { gunzip, inflateZlib, unzip } from '../decode/zip';
import { readShp, readDbf, simplify } from '../decode/shapefile';
import { readAbiCmi, readAbiL2, readGlmLcfa, examineAbi, type H5Like, type GoesProjection } from '../decode/goes';
import { gridMap } from '../gis/gridproj';
import { parseIdx, findIdx, HRRR_FIELDS, type HrrrField } from '../decode/hrrr';
import { fetchBytes, fetchText, abortAll } from '../data/net';
import { recodeVolume, buildProduct, liveComposite, type BuilderSweep, type L2BuildParams } from '../radar/l2products';
import { gaussianBlur, isolines, lambertInverse } from '../gis/contour';
import { padSweep } from '../radar/sweep-pad';
import { fetchShapes, geojsonFeatures } from './shape-tasks';
import { fetchGrib, encodeNormHalf, downsampleMax, downsampleGrid, geoOfGrid, contourLines, windSamples, unitConv } from './grid-tasks';
import { paramName, levelName } from '../decode/grib-names';
import { mesoDecoderUnits, mesoCode, severeCell, severeCodes } from '../sections/meso-math';

import { gridSize } from '../decode/grib2';
import type { LambertGrid } from '../decode/grib2';
import { packPtype } from '../decode/ptype-pack';
import { JobClock, runJob, type JobHandler } from './job-clock';

type Req = { id: number; task: string; args: any };
const scope = self as unknown as DedicatedWorkerGlobalScope;

// ------------------------------------------------------------------------------------------- Level 2
interface VolEntry { meta: L2Meta; sweeps: BuilderSweep[]; volume: L2Volume; products: Map<string, any>; bytes: number }
export interface L2SweepMeta { index: number; elevationNumber: number; elevation: number; nominal: number | null; radials: number; moments: string[]; complete: boolean; label: string; split: 'CS' | 'CD' | null; supplemental: boolean; nyquist: number | null; startMs: number; endMs: number }
export interface L2Meta { site: string; volumeTimeMs: number | null; lat: number | null; lon: number | null; heightM: number | null; vcp: number | null; avset: boolean | null; sails: number; mrle: number; baseTilts: number; sweeps: L2SweepMeta[]; bytes: number }
const volumes = new Map<string, VolEntry>();
/**
 * Decoded-volume cache. The count follows settings.nexradLevel2VolumeCountMemory (sent by the main thread via
 * 'config'); a byte budget per worker keeps memory bounded. Evicted volumes are re-decoded from the Cache API copy.
 */
const cacheCfg = { volumes: 5, byteBudget: 768 * 1024 * 1024 };
function sizeOf(v: unknown, seen = new Set<unknown>()): number {
  if (!v || typeof v !== 'object' || seen.has(v)) return 0;
  seen.add(v);
  if (ArrayBuffer.isView(v)) return v.byteLength;
  let n = 0;
  for (const k of Object.keys(v as object)) n += sizeOf((v as Record<string, unknown>)[k], seen);
  return n;
}
function evict() {
  let total = 0;
  for (const e of volumes.values()) total += e.bytes;
  for (const [k, e] of volumes) {
    if (volumes.size <= cacheCfg.volumes && total <= cacheCfg.byteBudget) break;
    if (volumes.size <= 1) break;
    volumes.delete(k); total -= e.bytes;
  }
}

function describe(v: L2Volume, bytes: number): L2Meta {
  const sweeps = v.sweeps.map((s, index): L2SweepMeta => {
    const cut = s.cut;
    const split = cut ? (cut.waveform === 1 ? 'CS' : cut.waveform === 2 || cut.waveform === 3 ? 'CD' : null) : null;
    let label = `${(cut?.elevation ?? s.elevation).toFixed(1)}°`;
    if (cut?.baseTilt) label += ' - Base Tilt Cut';
    if (cut?.sails && cut.sailsSeq > 0) label += ` - SAILS #${cut.sailsSeq}`;
    if (cut?.mrle && cut.mrleSeq > 0) label += ` - MRLE #${cut.mrleSeq}`;
    return {
      index, elevationNumber: s.elevationNumber, elevation: s.elevation, nominal: s.nominalElevation, radials: s.radialCount,
      moments: Object.keys(s.moments), complete: s.complete, label, split, supplemental: !!cut && ((cut.sails && cut.sailsSeq > 0) || (cut.mrle && cut.mrleSeq > 0)),
      nyquist: s.nyquist, startMs: s.timesMs[0] ?? 0, endMs: s.timesMs[s.timesMs.length - 1] ?? 0,
    };
  });
  return {
    site: v.site, volumeTimeMs: v.volumeTimeMs, lat: v.lat, lon: v.lon, heightM: v.heightM, vcp: v.vcpNumber,
    avset: v.vcp?.avset ?? null, sails: v.vcp?.sails ? v.vcp.sailsCuts : 0, mrle: v.vcp?.mrle ? v.vcp.mrleCuts : 0,
    baseTilts: v.vcp?.baseTilt ? v.vcp.baseTilts : 0, sweeps, bytes,
  };
}

/** Real-time chunk volumes decoded incrementally: each call fetches only the chunks not fed yet. */
const streams = new Map<string, { d: Archive2Decoder; fed: string[]; bytes: number }>();
const streamLock = new Map<string, Promise<unknown>>();
/** Serialises chunk feeding per volume (meta and product requests can overlap). */
function loadChunks(url: string, chunks: string[], job: JobClock): Promise<VolEntry> {
  const run = (streamLock.get(url) ?? Promise.resolve()).catch(() => undefined).then(() => feedChunks(url, chunks, job));
  streamLock.set(url, run);
  void run.finally(() => { if (streamLock.get(url) === run) streamLock.delete(url); }).catch(() => undefined);
  return run;
}
async function feedChunks(url: string, chunks: string[], job: JobClock): Promise<VolEntry> {
  let st = streams.get(url);
  // A different chunk sequence (gap repaired, folder reused) restarts the decode.
  if (!st || st.fed.some((c, i) => chunks[i] !== c)) { st = { d: new Archive2Decoder(), fed: [], bytes: 0 }; streams.set(url, st); }
  const fresh = chunks.slice(st.fed.length);
  const parts = await Promise.all(fresh.map((c) => fetchBytes(c, { cache: 'immutable' })));
  const s = st;
  job.time(() => { for (let i = 0; i < parts.length; i++) { s.d.feed(parts[i]); s.fed.push(fresh[i]); s.bytes += parts[i].length; } });
  while (streams.size > 3) streams.delete(streams.keys().next().value!);
  const hit = volumes.get(url);
  if (hit && !fresh.length) return hit;
  return job.time(() => cacheVolume(url, s.d.volume(), s.bytes));
}

/** Recodes a decoded volume for the product builders and caches it under its URL. */
function cacheVolume(url: string, volume: L2Volume, fileBytes: number): VolEntry {
  const sweeps = recodeVolume(volume);
  const entry: VolEntry = { meta: describe(volume, fileBytes), sweeps, volume, products: new Map(), bytes: sizeOf(volume) + sizeOf(sweeps) };
  volumes.delete(url);
  volumes.set(url, entry);
  evict();
  return entry;
}

async function loadVolume(url: string, live: boolean, job: JobClock, chunks?: string[]): Promise<VolEntry> {
  if (chunks?.length) return loadChunks(url, chunks, job);
  const hit = volumes.get(url);
  if (hit && !live) { volumes.delete(url); volumes.set(url, hit); return hit; }
  const bytes = await fetchBytes(url, { cache: live ? 'none' : 'immutable' });
  // Archive volumes before mid-2016 are whole-file gzip (…_V06.gz).
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
  return job.time(() => {
    let buf = plain;
    // tgftp serves whole volumes compressed with bzip2 when the name ends in .bz2 but the content is still
    // an AR2V file with bzip2 records; a fully compressed file starts with "BZh".
    if (buf[0] === 0x42 && buf[1] === 0x5a && buf[2] === 0x68) buf = bunzip2(buf);
    const d = new Archive2Decoder();
    d.feed(buf);
    return cacheVolume(url, d.volume(), bytes.length);
  });
}

function l2Product(v: VolEntry, a: { sweep: number; product: number; params: L2BuildParams }) {
  const vol = a.product >= 11;
  const key = `${a.product}:${vol ? 'vol' : a.sweep}:${JSON.stringify(a.params)}`;
  let p = v.products.get(key);
  if (!p) {
    const s = v.sweeps[a.sweep];
    p = s ? buildProduct(a.product, s, v.sweeps, a.params) : null;
    v.products.set(key, p);
    v.bytes += sizeOf(p);
    // Bounded per-volume product cache (tilt × product × parameter combinations).
    while (v.products.size > 24) { const [k0, p0] = v.products.entries().next().value!; v.products.delete(k0); v.bytes -= sizeOf(p0); }
    evict();
  }
  if (!p) return { meta: v.meta, sweep: null };
  const sw = v.volume.sweeps[a.sweep];
  return {
    meta: v.meta,
    sweep: { ...p, codes: p.codes.slice(), azimuths: p.azimuths.slice(), startMs: sw?.timesMs[0] ?? 0, endMs: sw?.timesMs[sw.timesMs.length - 1] ?? 0 },
  };
}

// ------------------------------------------------------------------------------------------- Level 3
function l3Result(p: L3Product) {
  return {
    code: p.code, awips: p.awips, lat: p.lat, lon: p.lon, heightFt: p.heightFt, vcp: p.vcp, opMode: p.opMode,
    volumeTimeMs: p.volumeTimeMs, generationTimeMs: p.generationTimeMs, volumeScan: p.volumeScan, elevationNumber: p.elevationNumber, p: p.p,
    radial: p.radial, raster: p.raster, lut: p.lut, flags: [...p.flags], units: p.units,
    cells: p.cells, tvs: p.tvs, etvs: p.etvs, hail: p.hail, features: p.features, contours: p.contours, texts: p.texts, circles: p.circles, pages: p.pages,
  };
}

// ------------------------------------------------------------------------------------------- GRIB2
const inflate = (b: Uint8Array) => inflateZlib(b);

/** MRMS mosaic → 2×2 max-downsampled byte codes: 0 = no data, else round((dBZ + 32) × 2) + 1 (−32..95 dBZ). */
async function mrms(a: { url: string; factor: number }, job: JobClock) {
  const raw = await fetchBytes(a.url, { cache: 'immutable' });
  const [f] = await job.time(async () => decodeGrib2(raw[0] === 0x1f && raw[1] === 0x8b ? await gunzip(raw) : raw, inflate));
  return job.time(() => mrmsCodes(f, a.factor));
}
function mrmsCodes(f: GribField | undefined, factor: number) {
  if (!f || f.grid.kind !== 'latlon') throw new Error('mrms: unexpected grid');
  const g = f.grid, k = Math.max(1, factor);
  const W = Math.floor(g.ni / k), H = Math.floor(g.nj / k);
  const codes = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = -Infinity;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const v = f.values[(y * k + dy) * g.ni + x * k + dx];
      if (v > best) best = v;
    }
    codes[y * W + x] = best > -32 && best < 200 ? Math.min(255, Math.round((best + 32) * 2) + 1) : 0;
  }
  const lo1 = g.lo1 > 180 ? g.lo1 - 360 : g.lo1, lo2 = g.lo2 > 180 ? g.lo2 - 360 : g.lo2;
  return { width: W, height: H, codes, refTimeMs: f.refTimeMs, la1: g.la1, lo1, la2: g.la2, lo2, scan: g.scan };
}

/** HRRR fields by .idx byte ranges. Values are returned as Float32 on the native Lambert grid. */
async function hrrr(a: { url: string; fields: HrrrField[] }, job: JobClock) {
  const idx = parseIdx(await fetchText(a.url + '.idx'));
  const out: Record<string, Float32Array> = {};
  let grid: GribField['grid'] | null = null, refTimeMs = 0, fcst = 0;
  await Promise.all(a.fields.map(async (name) => {
    const [variable, level] = HRRR_FIELDS[name];
    const e = findIdx(idx, variable, level);
    if (!e) return;
    const bytes = await fetchBytes(a.url, { cache: 'immutable', range: [e.start, e.end ?? e.start + 50_000_000] });
    const [f] = await job.time(() => decodeGrib2(bytes, inflate));
    if (!f) return;
    out[name] = f.values; grid = f.grid; refTimeMs = f.refTimeMs; fcst = f.forecastMinutes;
  }));
  return { fields: out, grid, refTimeMs, validMs: refTimeMs + fcst * 60000 };
}

/** Values of GRIB fields (by .idx variable + level) bilinearly sampled at one point; null when absent/outside. */
async function gribPoint(a: { url: string; fields: [string, string][]; lon: number; lat: number }, job: JobClock) {
  const idx = parseIdx(await fetchText(a.url + '.idx'));
  let validMs = 0;
  const values = await Promise.all(a.fields.map(async ([variable, level]) => {
    const e = findIdx(idx, variable, level);
    if (!e) return null;
    const bytes = await fetchBytes(a.url, { cache: 'immutable', range: [e.start, e.end ?? e.start + 50_000_000] });
    const [f] = await job.time(() => decodeGrib2(bytes, inflate));
    if (!f) return null;
    validMs = f.refTimeMs + f.forecastMinutes * 60000;
    const m = gridMap(f.grid), [fi, fj] = m.fwd(a.lon, a.lat);
    const i0 = Math.floor(fi), j0 = Math.floor(fj), di = fi - i0, dj = fj - j0;
    if (i0 < 0 || j0 < 0 || i0 + 1 >= m.nx || j0 + 1 >= m.ny) return null;
    const v = (i: number, j: number) => f.values[j * m.nx + i];
    const r = v(i0, j0) * (1 - di) * (1 - dj) + v(i0 + 1, j0) * di * (1 - dj) + v(i0, j0 + 1) * (1 - di) * dj + v(i0 + 1, j0 + 1) * di * dj;
    return Number.isFinite(r) ? r : null;
  }));
  return { values, validMs };
}

// ------------------------------------------------------------------------------------------- GOES / GLM
let h5: H5Like | null = null;
async function getH5(): Promise<H5Like> {
  if (h5) return h5;
  const mod = await import('h5wasm');
  await mod.ready;
  h5 = mod as unknown as H5Like;
  return h5;
}

/** ABI band image: area-averaged by `factor`, encoded as bytes over [min,max]: 0 = no data, 1..255 = data. */
/** Block-averages a fixed-grid image by `factor` and quantises it to codes 1–255 over [min, max] (0 = no data). */
function encodeFixedGrid(img: { width: number; height: number; values: Float32Array; proj: GoesProjection }, factor: number, min: number, max: number) {
  const k = Math.max(1, factor), W = Math.floor(img.width / k), H = Math.floor(img.height / k);
  const codes = new Uint8Array(W * H);
  const span = max - min;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) { const v = img.values[(y * k + dy) * img.width + x * k + dx]; if (v === v) { s += v; n++; } }
    codes[y * W + x] = n ? 1 + Math.round(Math.min(1, Math.max(0, (s / n - min) / span)) * 254) : 0;
  }
  const proj = { ...img.proj, dx: img.proj.dx * k, dy: img.proj.dy * k, x0: img.proj.x0 + (img.proj.dx * (k - 1)) / 2, y0: img.proj.y0 + (img.proj.dy * (k - 1)) / 2 };
  return { width: W, height: H, codes, proj };
}

async function goes(a: { url?: string; bytes?: Uint8Array; factor: number; min: number; max: number }, job: JobClock) {
  const h = await getH5(), bytes = a.bytes ?? await fetchBytes(a.url!, { cache: 'immutable' });
  return job.time(() => {
    const img = readAbiCmi(h, bytes);
    return { band: img.band, ...encodeFixedGrid(img, a.factor, a.min, a.max), startMs: img.startMs, endMs: img.endMs, platform: img.platform, scene: img.scene };
  });
}

/** ABI L2+ product: cloud-top height/temperature as encoded grids, fire/hot spot as a detection list. */
async function goesL2(a: { url: string; factor: number; min: number; max: number }, job: JobClock) {
  const h = await getH5(), bytes = await fetchBytes(a.url, { cache: 'immutable' });
  return job.time(() => {
    const r = readAbiL2(h, bytes);
    if (r.kind === 'FDC') return r;
    return { kind: r.kind, ...encodeFixedGrid(r, a.factor, a.min, a.max), good: r.good, marginal: r.marginal, startMs: r.startMs, endMs: r.endMs, platform: r.platform, scene: r.scene };
  });
}

async function glm(a: { urls: string[] }, job: JobClock) {
  const h = await getH5();
  const parts = await Promise.all(a.urls.map(async (u) => { try { const b = await fetchBytes(u, { cache: 'immutable' }); return job.time(() => readGlmLcfa(h, b)); } catch { return null; } }));
  return job.time(() => mergeGlm(parts));
}
function mergeGlm(parts: (ReturnType<typeof readGlmLcfa> | null)[]) {
  const ok = parts.filter((p): p is NonNullable<typeof p> => !!p);
  const n = ok.reduce((s, p) => s + p.lat.length, 0);
  const lat = new Float32Array(n), lon = new Float32Array(n), energy = new Float32Array(n), timeMs = new Float64Array(n);
  let o = 0;
  for (const p of ok) { lat.set(p.lat, o); lon.set(p.lon, o); energy.set(p.energy, o); timeMs.set(p.timeMs, o); o += p.lat.length; }
  return { lat, lon, energy, timeMs, files: ok.length, newestMs: ok.length ? Math.max(...ok.map((p) => p.endMs)) : 0 };
}

// ------------------------------------------------------------------------------------------- Shapefile zip
async function zipLines(a: { url: string; tol: number; classField?: string; nameField?: string }, job: JobClock) {
  const bytes = await fetchBytes(a.url, { cache: 'immutable' });
  return job.time(async () => roadLines(await unzip(bytes, (n) => /\.(shp|dbf)$/i.test(n)), a));
}
function roadLines(files: Map<string, Uint8Array>, a: { tol: number; classField?: string; nameField?: string }) {
  const shp = readShp(files.get([...files.keys()].find((k) => /\.shp$/i.test(k))!)!);
  const dbfKey = [...files.keys()].find((k) => /\.dbf$/i.test(k));
  const dbf = dbfKey ? readDbf(files.get(dbfKey)!) : [];
  const parts: number[][] = [], cls: number[] = [], names: string[] = [];
  shp.forEach((s, i) => {
    const row = dbf[i] ?? {};
    const c = roadClass(String(row[a.classField ?? ''] ?? ''), String(row.MTFCC ?? ''));
    const name = a.nameField ? String(row[a.nameField] ?? '').trim() : '';
    for (const p of s.parts) { const q = simplify(p, a.tol); if (q.length >= 4) { parts.push(Array.from(q)); cls.push(c); names.push(name); } }
  });
  return { parts, cls, names };
}
/** TIGER road class → style index 0 interstate, 1 US, 2 state, 3 streets, 4 ramps (RTTYP route type, MTFCC feature class). */
function roadClass(rttyp: string, mtfcc: string): number {
  if (mtfcc === 'S1630') return 4;
  if (rttyp === 'I') return 0;
  if (rttyp === 'U') return 1;
  if (rttyp === 'S') return 2;
  return 3;
}

/** HRRR surface products for one hour: MSLP isolines (mb), 10 m wind samples and a byte-coded fill field. */
async function surface(a: { url: string; mslp?: { interval: number; kernel: number }; wind?: { step: number }; fill?: { field: HrrrField; min: number; max: number; unit: 'F' | 'J' } }, job: JobClock) {
  const fields: HrrrField[] = [];
  if (a.mslp) fields.push('mslp');
  if (a.wind) fields.push('u10', 'v10');
  if (a.fill) fields.push(a.fill.field);
  const h = await hrrr({ url: a.url, fields }, job);
  return job.time(() => {
    const g = h.grid as LambertGrid | null;
    if (!g) throw new Error('hrrr: no grid');
    const inv = lambertInverse(g);
    const out: any = { validMs: h.validMs, nx: g.nx, ny: g.ny, grid: g };
    if (a.mslp && h.fields.mslp) {
      // Work at half resolution (6 km); smoothing kernel scaled to grid cells.
      const W = Math.floor(g.nx / 2), H = Math.floor(g.ny / 2), mb = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mb[y * W + x] = h.fields.mslp[(y * 2) * g.nx + x * 2] / 100;
      const sm = gaussianBlur(mb, W, H, a.mslp.kernel * 4);
      let lo = Infinity, hi = -Infinity;
      for (const v of sm) if (v === v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const levels: number[] = [];
      for (let L = Math.ceil(lo / a.mslp.interval) * a.mslp.interval; L <= hi; L += a.mslp.interval) levels.push(L);
      const iso = isolines(sm, W, H, levels);
      out.contours = iso.flatMap((lv) => lv.lines.filter((l) => l.length >= 8).map((l) => {
        const ll: number[] = [];
        for (let k = 0; k < l.length; k += 2) { const [lon, lat] = inv(l[k] * 2, l[k + 1] * 2); ll.push(lon, lat); }
        return { level: lv.level, coords: ll };
      }));
    }
    if (a.wind && h.fields.u10 && h.fields.v10) {
      const pts: number[] = [];
      for (let j = 0; j < g.ny; j += a.wind.step) for (let i = 0; i < g.nx; i += a.wind.step) {
        const k = j * g.nx + i; const [lon, lat] = inv(i, j);
        pts.push(lon, lat, h.fields.u10[k], h.fields.v10[k]);
      }
      out.wind = Float32Array.from(pts);
    }
    if (a.fill && h.fields[a.fill.field]) {
      const f = h.fields[a.fill.field]!, codes = new Uint8Array(f.length), span = a.fill.max - a.fill.min;
      for (let i = 0; i < f.length; i++) {
        let v = f[i];
        if (a.fill.unit === 'F') v = (v - 273.15) * 1.8 + 32;
        codes[i] = v === v ? 1 + Math.round(Math.min(1, Math.max(0, (v - a.fill.min) / span)) * 254) : 0;
      }
      out.fill = codes;
    }
    return out;
  });
}

/** Adds the padded upload image to a sweep result so the main thread only copies it to the GPU. */
function withUpload<T extends { sweep: any }>(r: T): T {
  const s = r.sweep;
  if (s) s.upload = padSweep(s.codes, s.radials, s.gates, s.complete, s.wordSize);
  return r;
}

/** MRMS tab product: whole gzip GRIB2, unit conversion, max-downsampling, half-float range encoding. */
async function gridMrms(a: { url: string; lo: number; hi: number; factor: number; conv: number }, job: JobClock) {
  const [[f]] = await fetchGrib(a.url, null, job, { gz: true, cache: 'immutable' });
  return job.time(() => {
    if (!f) throw new Error('mrms: no field');
    const [w, h] = gridSize(f.grid);
    // MRMS missing / no-coverage values (−999, −99) are transparent.
    const v = new Float32Array(f.values.length);
    for (let i = 0; i < v.length; i++) { const x = f.values[i]; v[i] = x === x && x > -90 ? x * a.conv : NaN; }
    const d = downsampleMax(v, w, h, a.factor);
    const geo = geoOfGrid(downsampleGrid(f.grid, a.factor));
    let mn = Infinity, mx = -Infinity;
    for (const x of d.values) if (x === x) { if (x < mn) mn = x; if (x > mx) mx = x; }
    return { nx: d.w, ny: d.h, data: encodeNormHalf(d.values, a.lo, a.hi), proj: geo.proj, bounds: geo.bounds, refTimeMs: f.refTimeMs + f.forecastMinutes * 60e3, min: mn, max: mx };
  });
}

/** Fields of one inventory match grouped by GRIB parameter (sub-message pairs return both components). */
function rapFields(url: string, matches: string[], job: JobClock) {
  return fetchGrib(url, matches, job, { cache: 'immutable' });
}

const isU = (f: GribField) => f.discipline === 0 && f.category === 2 && (f.number === 2 || f.number === 15);
const isV = (f: GribField) => f.discipline === 0 && f.category === 2 && (f.number === 3 || f.number === 16);

/** MESO product: decoder units, derivation, 16-bit quantisation as exact texels; contours for heights. */
async function gridMeso(a: { url: string; matches: string[]; lo: number; hi: number; derivation: string; render: string; corrected: boolean; contourInterval: number }, job: JobClock) {
  const groups = await rapFields(a.url, a.derivation.startsWith('speed') ? [a.matches[0]] : a.matches, job);
  return job.time(() => {
    const all = groups.flat();
    const f0 = all[0];
    if (!f0) throw new Error('meso: no field');
    const [w, h] = gridSize(f0.grid);
    const n = w * h, v = new Float32Array(n);
    if (a.derivation.startsWith('speed')) {
      const u = all.find(isU), vv = all.find(isV);
      if (!u || !vv) throw new Error('meso: wind components missing');
      for (let i = 0; i < n; i++) v[i] = Math.sqrt(u.values[i] ** 2 + vv.values[i] ** 2) * 2.23693629;
    } else if (a.derivation.startsWith('EHI')) {
      const cape = groups[0][0], srh = groups[1][0];
      for (let i = 0; i < n; i++) v[i] = (cape.values[i] * srh.values[i]) / 160000;
    } else for (let i = 0; i < n; i++) v[i] = mesoDecoderUnits(a.matches[0], f0.values[i], a.corrected);
    // 9999 → 0 (missing values become 0), then 16-bit codes over the table range.
    const tex = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = v[i] === v[i] && v[i] !== 9999 ? v[i] : 0; tex[i] = mesoCode(x, a.lo, a.hi) / 65535; }
    const geo = geoOfGrid(f0.grid);
    const contours = a.render === 'contour' ? contourLines(f0, a.contourInterval, 1, 1) : null;
    return { nx: w, ny: h, data: tex, proj: geo.proj, bounds: geo.bounds, refTimeMs: f0.refTimeMs, validMs: f0.refTimeMs + f0.forecastMinutes * 60e3, contours };
  });
}

/** STP / SCP: seven RAP inputs, per-cell arithmetic and the coupled texture coding. */
async function gridSevere(a: { url: string; corrected: boolean }, job: JobClock) {
  const M = ['CAPE:surface', 'HLCY:1000-0 m above', 'VVCSH:0-6000 m', 'DPT:2 m', 'TMP:2 m', 'PRES:surface', 'HLCY:3000-0 m'];
  const g = await rapFields(a.url, M, job);
  return job.time(() => {
    const cape = g[0][0], srh1 = g[1][0], u6 = g[2].find(isU) ?? g[2][0], v6 = g[2].find(isV) ?? g[2][1], td = g[3][0], t = g[4][0], p = g[5][0], srh3 = g[6][0];
    if (!cape || !srh1 || !u6 || !v6 || !td || !t || !p || !srh3) throw new Error('severe: not all seven inputs loaded');
    const [w, h] = gridSize(cape.grid), n = w * h;
    const stpTex = new Float32Array(n), scpTex = new Float32Array(n), stp = new Float32Array(n), scp = new Float32Array(n);
    const F = (k: number) => (k - 273.15) * 1.8 + 32; // decoder English units (°F) for TMP/DPT
    for (let i = 0; i < n; i++) {
      const c = severeCell({ cape: cape.values[i], srh1: srh1.values[i], u6: u6.values[i], v6: v6.values[i], tF: F(t.values[i]), tdF: F(td.values[i]), pPa: p.values[i], srh3: srh3.values[i] }, a.corrected);
      stp[i] = Math.fround(c.stp); scp[i] = Math.fround(c.scp);
      const k = severeCodes(stp[i], scp[i], a.corrected);
      stpTex[i] = k.stp / 65535; scpTex[i] = k.scp / 65535;
    }
    const geo = geoOfGrid(cape.grid);
    return { nx: w, ny: h, stpTex, scpTex, stp, scp, proj: geo.proj, bounds: geo.bounds, refTimeMs: cape.refTimeMs, validMs: cape.refTimeMs + cape.forecastMinutes * 60e3 };
  });
}

/** Temperature / dew point / MSLP difference between two RAP cycles, raw values for the palette range. */
async function gridDiff(a: { urlNow: string; urlThen: string; match: string; lo: number; hi: number }, job: JobClock) {
  const [[now], [then]] = await Promise.all([fetchGrib(a.urlNow, [a.match], job, { cache: 'immutable' }).then((g) => g[0]), fetchGrib(a.urlThen, [a.match], job, { cache: 'immutable' }).then((g) => g[0])]);
  return job.time(() => {
    if (!now || !then) throw new Error('diff: field missing');
    const [w, h] = gridSize(now.grid), n = w * h, d = new Float32Array(n);
    const conv = /^TMP|^DPT/.test(a.match) ? (k: number) => k * 1.8 : (pa: number) => pa / 100; // K difference → °F difference; Pa → mb
    for (let i = 0; i < n; i++) d[i] = conv(now.values[i] - then.values[i]);
    const geo = geoOfGrid(now.grid);
    return { nx: w, ny: h, data: encodeNormHalf(d, a.lo, a.hi), proj: geo.proj, bounds: geo.bounds, validMs: now.refTimeMs + now.forecastMinutes * 60e3 };
  });
}

/** Unit conversion to the display units used for NDFD/PWPF products (degrib-style English units, choose). */
function englishUnits(f: GribField): { conv: ((v: number) => number) | null; unit: string } {
  const key = `${f.discipline}.${f.category}.${f.number}`;
  switch (key) {
    case '0.0.0': case '0.0.4': case '0.0.5': case '0.0.6': case '0.0.21': return { conv: (k) => (k - 273.15) * 1.8 + 32, unit: '°F' };
    case '0.2.1': case '0.2.22': return { conv: (ms) => ms * 2.23694, unit: 'mph' };
    case '0.2.0': return { conv: null, unit: '°' };
    case '0.1.8': return { conv: (kg) => kg / 25.4, unit: 'in' };
    case '0.1.29': return { conv: (m) => m * 39.3701, unit: 'in' };
    case '10.0.3': case '10.0.5': return { conv: (m) => m * 3.28084, unit: 'ft' };
    case '0.1.1': case '0.6.1': case '0.1.8.9': return { conv: null, unit: '%' };
  }
  return { conv: null, unit: '' };
}

/** NUL-separated printable strings of an NDFD local-use section (weather / hazard code tables). */
function localStrings(b: Uint8Array | null): string[] {
  if (!b) return [];
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0) { if (cur.length >= 2 && /[A-Za-z<]/.test(cur)) out.push(cur); cur = ''; }
    else if (c >= 32 && c < 127) cur += String.fromCharCode(c); else cur = '';
  }
  return out;
}

/** Every message of a whole GRIB file (NDFD region file, WPC PWPF) encoded over [lo, hi] in display units. */
async function gridAll(a: { url: string; lo: number; hi: number; maxFrames?: number; byCode?: boolean }, job: JobClock) {
  const [fields] = await fetchGrib(a.url, null, job, { cache: 'none' });
  return job.time(() => {
    if (!fields.length) throw new Error('no GRIB messages');
    const frames = fields.slice(0, a.maxFrames ?? 64).map((f) => {
      const u = a.byCode ? { conv: null, unit: '' } : englishUnits(f);
      const geo = geoOfGrid(f.grid);
      const [w, h] = gridSize(f.grid);
      return { nx: w, ny: h, data: encodeNormHalf(f.values, a.lo, a.hi, u.conv ?? undefined), proj: geo.proj, bounds: geo.bounds, refTimeMs: f.refTimeMs,
        validMs: f.endTimeMs ?? f.refTimeMs + f.forecastMinutes * 60e3, startMs: f.refTimeMs + f.forecastMinutes * 60e3, unit: u.unit, strings: localStrings(f.local), percentile: f.percentile, prob: f.prob };
    });
    return { frames };
  });
}


/** One model product for one forecast hour: fill (scalar or vector magnitude), vectors or contours. */
async function gridModel(a: { url: string; invExt: string; matches: string[]; kind: 'fill' | 'vector' | 'contour'; unit: string; lo: number; hi: number; interval: number; vectorStep: number; local?: boolean }, job: JobClock) {
  let groups: GribField[][];
  if (a.local) {
    // User-supplied GRIB2 (Custom GRIB): decode the file and select fields by their generated inventory text.
    const all = (await fetchGrib(a.url, null, job, { cache: 'none' }))[0];
    const desc = (f: GribField) => `:${paramName(f)}:${levelName(f.surfaceType, f.surfaceValue, f.surface2Type, f.surface2Value)}:${f.forecastMinutes / 60} hour fcst:`;
    groups = a.matches.map((m) => all.filter((f) => desc(f).includes(':' + m)).slice(0, 1));
    if (groups.some((g) => !g.length)) throw new Error(`no message matches "${a.matches[groups.findIndex((g) => !g.length)]}" in the file`);
  } else groups = await fetchGrib(a.url, a.matches, job, { idxExt: a.invExt, cache: 'immutable' });
  return job.time(() => {
    const all = groups.flat();
    const f0 = all[0];
    if (!f0) throw new Error('no field');
    const [w, h] = gridSize(f0.grid);
    const geo = geoOfGrid(f0.grid);
    const base = { nx: w, ny: h, proj: geo.proj, bounds: geo.bounds, refTimeMs: f0.refTimeMs, validMs: f0.endTimeMs ?? f0.refTimeMs + f0.forecastMinutes * 60e3 };
    const u = all.find(isU) ?? all[0], v = all.find(isV) ?? all[1];
    if (a.kind === 'vector') {
      if (!u || !v || u === v) throw new Error('vector product needs U and V components');
      return { ...base, vectors: windSamples(u, v, Math.max(1, a.vectorStep)) };
    }
    if (a.kind === 'contour') {
      // Contour the converted physical values (affine conversions such as K→°F keep their offset).
      return { ...base, contours: contourLines(f0, a.interval, unitConv(a.unit, f0) ?? 1, 1.5, w > 1200 ? 2 : 1) };
    }
    let vals = f0.values;
    if (a.matches.length >= 2 && u && v && u !== v) { vals = new Float32Array(u.values.length); for (let i = 0; i < vals.length; i++) vals[i] = Math.hypot(u.values[i], v.values[i]); }
    const conv = unitConv(a.unit, f0);
    return { ...base, data: encodeNormHalf(vals, a.lo, a.hi, conv ?? undefined) };
  });
}

/** wgrib-style inventory of a local GRIB2 file (custom GRIB): n:offset:d=YYYYMMDDHH:PARAM:level:time: */
async function gribInventory(a: { url: string }, job: JobClock) {
  const bytes = await fetchBytes(a.url, { cache: 'none' });
  return job.time(() => inventoryLines(bytes));
}
async function inventoryLines(bytes: Uint8Array) {
  const lines: string[] = [];
  let n = 1;
  for (const { offset: m, length } of scanGribMessages(bytes)) {
    let fields: GribField[];
    try { fields = await decodeGrib2(bytes.subarray(m, m + length), inflateZlib); } catch { continue; } // corrupt message body
    for (const f of fields) lines.push(`${n}:${m}:d=${new Date(f.refTimeMs).toISOString().slice(0, 13).replace(/[-T]/g, '')}:${paramName(f)}:${levelName(f.surfaceType, f.surfaceValue, f.surface2Type, f.surface2Value)}:${f.forecastMinutes / 60} hour fcst:`);
    n++;
  }
  return lines.join('\n') + '\n';
}

const HANDLERS: Record<string, JobHandler> = {
  'grid.all': gridAll,
  'grid.model': gridModel,
  'grib.inventory': gribInventory,
  'grid.meso': gridMeso,
  'grid.severe': gridSevere,
  'grid.diff': gridDiff,
  'grid.mrms': gridMrms,
  'shapes': fetchShapes,
  'geojson': async (a: { gj?: any; url?: string; tol?: number }, job) => {
    const text = a.gj ? null : await fetchText(a.url!);
    return job.time(() => geojsonFeatures(a.gj ?? JSON.parse(text!), a.tol ?? 0));
  },
  'config': async (a: { volumes?: number; byteBudget?: number }) => {
    if (a.volumes) cacheCfg.volumes = Math.max(1, Math.round(a.volumes));
    if (a.byteBudget) cacheCfg.byteBudget = a.byteBudget;
    evict();
    return { ...cacheCfg, cached: volumes.size };
  },
  'surface': surface,
  'l2.meta': async (a, job) => (await loadVolume(a.url, a.live, job, a.chunks)).meta,
  'l2.product': async (a, job) => {
    const v = await loadVolume(a.url, a.live, job, a.chunks);
    return job.time(() => {
      const r = l2Product(v, a);
      // 8-bit ZDR codes are inverted by the builder; the display maps them back.
      if (a.product === 3 && r.sweep && r.sweep.wordSize === 8) { const c = r.sweep.codes; for (let i = 0; i < c.length; i++) c[i] = c[i] ? 255 - c[i] : 0; }
      return withUpload(r);
    });
  },
  'l2.composite': async (a: { url: string; live: boolean; chunks?: string[]; base: number; top: number; selectiveMax: boolean }, job) => {
    const v = await loadVolume(a.url, a.live, job, a.chunks);
    return job.time(() => {
      const g = liveComposite(v.sweeps, a.base, a.top, a.selectiveMax);
      if (!g) return { meta: v.meta, sweep: null };
      const az = new Float32Array(720);
      for (let i = 0; i < 720; i++) az[i] = (g.az0 + i * 0.5) % 360;
      return withUpload({ meta: v.meta, sweep: { product: 0, radials: 720, gates: g.gates, firstKm: g.firstKm, gateKm: g.gateKm, azimuths: az, half: true, complete: true, elevation: 0, codes: g.codes, wordSize: 8 } });
    });
  },
  'l3': async (a, job) => {
    const bytes = await fetchBytes(a.url, { cache: a.live ? 'none' : 'immutable' });
    return job.time(() => l3Result(decodeLevel3(bytes)));
  },
  'mrms': mrms,
  'hrrr': hrrr,
  // P-type texels are packed here so only ~7.6 MB of RGBA8 (not six float fields) reach the main thread.
  'hrrr.ptype': async (a: { url: string }, job) => {
    const h = await hrrr({ url: a.url, fields: ['cpofp', 'crain', 'csnow', 'cicep', 'cfrzr', 't2m'] }, job);
    const g = h.grid as LambertGrid | null;
    const packed = g ? job.time(() => packPtype(g.nx * g.ny, h.fields)) : null;
    if (!g || !packed) return null;
    return { grid: g, packed };
  },
  'grib.point': gribPoint,
  'goes': goes,
  'goes.l2': goesL2,
  'glm': glm,
  'zipLines': zipLines,
  'net.abort': async () => abortAll(),
  'goes.examine': async (a: { bytes: Uint8Array }, job) => { const h = await getH5(); return job.time(() => examineAbi(h, a.bytes)); },
};
/**
 * Tasks that wrap their decode/build work in `job.time()`; a cache hit then reports 0 ms. Any other task reports its
 * processing time as unavailable rather than zero.
 */
const TIMED = new Set(['grid.all', 'grid.model', 'grib.inventory', 'grid.meso', 'grid.severe', 'grid.diff', 'grid.mrms', 'shapes', 'geojson', 'surface',
  'l2.meta', 'l2.product', 'l2.composite', 'l3', 'mrms', 'hrrr', 'hrrr.ptype', 'grib.point', 'goes', 'goes.l2', 'glm', 'zipLines', 'goes.examine']);

function transferables(v: any, out: Transferable[] = [], seen = new Set<any>()): Transferable[] {
  if (!v || typeof v !== 'object' || seen.has(v)) return out;
  seen.add(v);
  if (ArrayBuffer.isView(v)) { if (!out.includes(v.buffer as ArrayBuffer) && v.byteLength === v.buffer.byteLength) out.push(v.buffer as ArrayBuffer); return out; }
  for (const k of Object.keys(v)) transferables(v[k], out, seen);
  return out;
}

scope.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, task, args } = ev.data;
  const reply = await runJob(HANDLERS[task], task, args, TIMED.has(task));
  const list = reply.ok ? transferables(reply.result) : [];
  scope.postMessage({ id, ...reply, bytes: list.reduce<number>((n, b) => n + (b as ArrayBuffer).byteLength, 0) }, list);
};
