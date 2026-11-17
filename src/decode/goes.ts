// GOES-R ABI L2 CMIP and GLM L2 LCFA readers (NetCDF-4 = HDF5) per the GOES-R Product User Guide
// (Vol. 3/5): CF packing (scale_factor/add_offset/_Unsigned/_FillValue) and the geostationary fixed grid.
// The HDF5 library is injected (h5wasm in the browser worker, h5wasm/node in validation scripts).

export interface H5Like {
  FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  File: new (path: string, mode: string) => H5File;
}
interface H5Attr { value: unknown }
interface H5Dataset { value: unknown; shape: number[] | null; attrs: Record<string, H5Attr> }
interface H5File { get(name: string): unknown; attrs: Record<string, H5Attr>; close(): void }

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (ArrayBuffer.isView(v)) return Number((v as unknown as ArrayLike<number>)[0]);
  if (Array.isArray(v)) return Number(v[0]);
  return Number(v);
};
const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : String(v ?? ''));

function attrNum(ds: H5Dataset, name: string, dflt: number): number {
  const a = ds.attrs?.[name];
  return a ? num(a.value) : dflt;
}

type Packed = ArrayLike<number> & { BYTES_PER_ELEMENT?: number };
/** CF unpacking of one packed value of `ds` (raw values read once by the caller); NaN for the fill value. */
function cfUnpacker(ds: H5Dataset, raw: Packed): (v: number) => number {
  const unsigned = ds.attrs?._Unsigned ? str(ds.attrs._Unsigned.value).toLowerCase() === 'true' : false;
  const scale = attrNum(ds, 'scale_factor', 1), offset = attrNum(ds, 'add_offset', 0);
  const hasFill = !!ds.attrs?._FillValue;
  let fill = hasFill ? attrNum(ds, '_FillValue', NaN) : NaN;
  const wrap = 2 ** ((raw.BYTES_PER_ELEMENT ?? 2) * 8);
  if (unsigned && fill < 0) fill += wrap;
  return (v) => {
    if (unsigned && v < 0) v += wrap;
    return hasFill && v === fill ? NaN : v * scale + offset;
  };
}

/** Applies CF unpacking; returns NaN for fill values. */
export function unpackCF(ds: H5Dataset): Float32Array {
  const raw = ds.value as Packed;
  const unpack = cfUnpacker(ds, raw);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = unpack(raw[i]);
  return out;
}

/** CF-unpacked values of `ds` at the given flat indices only (NaN for every index when the variable is absent). */
function unpackAt(ds: H5Dataset | null, idx: number[]): Float32Array {
  if (!ds) return new Float32Array(idx.length).fill(NaN);
  const raw = ds.value as Packed;
  const unpack = cfUnpacker(ds, raw);
  return Float32Array.from(idx, (i) => unpack(raw[i]));
}

export interface GoesProjection {
  h: number; // perspective_point_height + semi_major_axis (m)
  req: number; rpol: number; lon0: number; // degrees
  x0: number; dx: number; y0: number; dy: number; // radians: x = x0 + i*dx, y = y0 + j*dy
}

export interface AbiImage {
  band: number; startMs: number; endMs: number;
  width: number; height: number;
  /** Physical values: reflectance factor (bands 1–6) or brightness temperature in °C (bands 7–16). */
  values: Float32Array;
  proj: GoesProjection;
  platform: string; scene: string;
}

let fileSeq = 0;
function withFile<T>(h5: H5Like, bytes: Uint8Array, fn: (f: H5File) => T): T {
  const path = `/tmp/cwrv3-h5-${++fileSeq}.nc`;
  h5.FS.writeFile(path, bytes);
  const f = new h5.File(path, 'r');
  try { return fn(f); } finally { f.close(); try { h5.FS.unlink(path); } catch { /* ignore */ } }
}

/** GOES fixed-grid projection of an ABI file: x/y scan angles (CF-packed, radians) and goes_imager_projection. */
function fixedGrid(f: H5File): GoesProjection {
  const x = f.get('x') as H5Dataset, y = f.get('y') as H5Dataset;
  const xs = attrNum(x, 'scale_factor', 1), xo = attrNum(x, 'add_offset', 0), ys = attrNum(y, 'scale_factor', 1), yo = attrNum(y, 'add_offset', 0);
  const xr = x.value as ArrayLike<number>, yr = y.value as ArrayLike<number>;
  const p = f.get('goes_imager_projection') as H5Dataset;
  const req = attrNum(p, 'semi_major_axis', 6378137), rpol = attrNum(p, 'semi_minor_axis', 6356752.31414);
  return {
    h: attrNum(p, 'perspective_point_height', 35786023) + req, req, rpol, lon0: attrNum(p, 'longitude_of_projection_origin', -75),
    x0: xr[0] * xs + xo, dx: xs * (xr[1] - xr[0]), y0: yr[0] * ys + yo, dy: ys * (yr[1] - yr[0]),
  };
}
const fileTime = (f: H5File, name: string) => Date.parse(str(f.attrs[name]?.value));

export function readAbiCmi(h5: H5Like, bytes: Uint8Array): AbiImage {
  return withFile(h5, bytes, (f) => {
    const cmi = f.get('CMI') as H5Dataset;
    const [height, width] = cmi.shape!;
    const values = unpackCF(cmi);
    const band = num((f.get('band_id') as H5Dataset).value);
    if (band >= 7) for (let i = 0; i < values.length; i++) values[i] -= 273.15;
    return {
      band, width, height, values, proj: fixedGrid(f), startMs: fileTime(f, 'time_coverage_start'), endMs: fileTime(f, 'time_coverage_end'),
      platform: str(f.attrs.platform_ID?.value), scene: str(f.attrs.scene_id?.value),
    };
  });
}

/**
 * ABI L2+ cloud-top grid: Cloud Top Height (ACHA, variable HT, metres → km) or Cloud Top Temperature (ACHT, TEMP,
 * kelvin → °C). Only good-quality pixels (DQF 0) are kept, the set NOAA's own per-file statistics (minimum, maximum,
 * mean cloud-top temperature) are computed over; marginal (1), retrieval-attempted (2), bad (3) and opaque-retrieval
 * (4) pixels are missing (NaN). `marginal` counts the marginal pixels that had a value and were left out.
 */
export interface AbiCloudTop { kind: 'ACHA' | 'ACHT'; width: number; height: number; values: Float32Array; good: number; marginal: number; proj: GoesProjection; startMs: number; endMs: number; platform: string; scene: string }
/** Fire/Hot Spot detections (FDC): one entry per pixel whose Fire Mask is a fire category (10–15, 30–35). */
export interface AbiFires {
  kind: 'FDC'; startMs: number; endMs: number; platform: string; scene: string;
  lat: Float32Array; lon: Float32Array; mask: Int16Array; dqf: Uint8Array;
  /** Fire radiative power (MW), fire temperature (K) and fire area (m²); NaN where the product gives none. */
  power: Float32Array; tempK: Float32Array; areaM2: Float32Array;
}
/** Fire Mask categories that are fire detections: processed, saturated, cloud-contaminated, high/medium/low probability, and their temporally filtered forms. */
export const FIRE_CATEGORY: Record<number, string> = {
  10: 'good fire', 11: 'saturated fire', 12: 'cloud-contaminated fire', 13: 'high-probability fire', 14: 'medium-probability fire', 15: 'low-probability fire',
  30: 'good fire (temporally filtered)', 31: 'saturated fire (temporally filtered)', 32: 'cloud-contaminated fire (temporally filtered)',
  33: 'high-probability fire (temporally filtered)', 34: 'medium-probability fire (temporally filtered)', 35: 'low-probability fire (temporally filtered)',
};

export function readAbiL2(h5: H5Like, bytes: Uint8Array): AbiCloudTop | AbiFires {
  return withFile(h5, bytes, (f) => {
    const proj = fixedGrid(f);
    const meta = { startMs: fileTime(f, 'time_coverage_start'), endMs: fileTime(f, 'time_coverage_end'), platform: str(f.attrs.platform_ID?.value), scene: str(f.attrs.scene_id?.value) };
    const dqfDs = f.get('DQF') as H5Dataset | null;
    if (!dqfDs) throw new Error('no DQF variable (not an ABI L2+ product)');
    const dqf = dqfDs.value as ArrayLike<number>;
    const mask = f.get('Mask') as H5Dataset | null;
    if (mask) {
      const width = mask.shape![1];
      const m = mask.value as ArrayLike<number>;
      const idx: number[] = [];
      for (let i = 0; i < m.length; i++) if (FIRE_CATEGORY[m[i]]) idx.push(i);
      // Only the fire pixels are unpacked (a Full Disk has ~30 M pixels per variable, typically a few thousand fires).
      const pick = (name: string) => unpackAt(f.get(name) as H5Dataset | null, idx);
      const lat = new Float32Array(idx.length), lon = new Float32Array(idx.length);
      idx.forEach((i, k) => { const ll = geosInverse(proj, proj.x0 + (i % width) * proj.dx, proj.y0 + Math.floor(i / width) * proj.dy); lat[k] = ll ? ll[0] : NaN; lon[k] = ll ? ll[1] : NaN; });
      return { kind: 'FDC', ...meta, lat, lon, mask: Int16Array.from(idx, (i) => m[i]), dqf: Uint8Array.from(idx, (i) => dqf[i]), power: pick('Power'), tempK: pick('Temp'), areaM2: pick('Area') };
    }
    const name = f.get('HT') ? 'HT' : f.get('TEMP') ? 'TEMP' : '';
    if (!name) throw new Error('no HT, TEMP or Mask variable (unsupported ABI L2+ product)');
    const ds = f.get(name) as H5Dataset;
    const [height, width] = ds.shape!;
    const values = unpackCF(ds);
    let good = 0, marginal = 0;
    for (let i = 0; i < values.length; i++) {
      const q = dqf[i];
      if (values[i] !== values[i] || q !== 0) { if (q === 1 && values[i] === values[i]) marginal++; values[i] = NaN; continue; }
      good++;
      values[i] = name === 'HT' ? values[i] / 1000 : values[i] - 273.15;
    }
    return { kind: name === 'HT' ? 'ACHA' : 'ACHT', width, height, values, good, marginal, proj, ...meta };
  });
}

/** "Examine" summary of an ABI NetCDF file (GOES-R Manual Loader): band, variable, projection and statistics. */
export interface AbiSummary {
  band: number | null; variable: string; projection: 'GOES Imager' | 'Lambert' | 'unknown'; width: number; height: number;
  scale: number; offset: number; standardParallel: number | null; centralMeridian: number | null; originLat: number | null;
  perspectiveHeight: number | null; min: number; max: number; avg: number; startMs: number; platform: string;
}
export function examineAbi(h5: H5Like, bytes: Uint8Array): AbiSummary {
  return withFile(h5, bytes, (f) => {
    const variable = ['CMI', 'Rad'].find((n) => !!f.get(n)) ?? '';
    if (!variable) throw new Error('no CMI or Rad variable (not an ABI imagery file)');
    const ds = f.get(variable) as H5Dataset;
    const [height, width] = ds.shape!;
    const v = unpackCF(ds);
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = 0; i < v.length; i++) { const x = v[i]; if (x === x) { if (x < min) min = x; if (x > max) max = x; sum += x; n++; } }
    const geos = f.get('goes_imager_projection') as H5Dataset | null, lam = f.get('lambert_projection') as H5Dataset | null;
    const p = geos ?? lam;
    const opt = (name: string) => (p?.attrs?.[name] ? num(p.attrs[name].value) : null);
    const bandDs = f.get('band_id') as H5Dataset | null;
    return {
      band: bandDs ? num(bandDs.value) : null, variable, projection: geos ? 'GOES Imager' : lam ? 'Lambert' : 'unknown', width, height,
      scale: attrNum(ds, 'scale_factor', 1), offset: attrNum(ds, 'add_offset', 0),
      standardParallel: opt('standard_parallel'), centralMeridian: opt('longitude_of_projection_origin') ?? opt('longitude_of_central_meridian'),
      originLat: opt('latitude_of_projection_origin'), perspectiveHeight: opt('perspective_point_height'),
      min: n ? min : NaN, max: n ? max : NaN, avg: n ? sum / n : NaN,
      startMs: Date.parse(str(f.attrs.time_coverage_start?.value)), platform: str(f.attrs.platform_ID?.value),
    };
  });
}

/** Forward geostationary projection (GOES-R PUG Vol. 3): lon/lat (deg) → scan angles x, y (rad). */
export function geosForward(p: GoesProjection, latDeg: number, lonDeg: number): [number, number] | null {
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180, lon0 = (p.lon0 * Math.PI) / 180;
  const e2 = 1 - (p.rpol * p.rpol) / (p.req * p.req);
  const phic = Math.atan(((p.rpol * p.rpol) / (p.req * p.req)) * Math.tan(lat));
  const rc = p.rpol / Math.sqrt(1 - e2 * Math.cos(phic) ** 2);
  const sx = p.h - rc * Math.cos(phic) * Math.cos(lon - lon0);
  const sy = -rc * Math.cos(phic) * Math.sin(lon - lon0);
  const sz = rc * Math.sin(phic);
  if (p.h * (p.h - sx) < sy * sy + ((p.req * p.req) / (p.rpol * p.rpol)) * sz * sz) return null; // not visible
  return [Math.asin(-sy / Math.sqrt(sx * sx + sy * sy + sz * sz)), Math.atan(sz / sx)];
}

/** Inverse geostationary projection (GOES-R PUG Vol. 3, 4.2.8.1): scan angles x, y (rad) → [lat, lon] (deg), or null off the Earth. */
export function geosInverse(p: GoesProjection, x: number, y: number): [number, number] | null {
  const k = (p.req * p.req) / (p.rpol * p.rpol);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y);
  const a = sx * sx + cx * cx * (cy * cy + k * sy * sy), b = -2 * p.h * cx * cy, c = p.h * p.h - p.req * p.req;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const rs = (-b - Math.sqrt(disc)) / (2 * a);
  const Sx = rs * cx * cy, Sy = -rs * sx, Sz = rs * cx * sy;
  const lat = Math.atan(k * Sz / Math.sqrt((p.h - Sx) ** 2 + Sy * Sy));
  const lon = (p.lon0 * Math.PI) / 180 - Math.atan(Sy / (p.h - Sx));
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

export interface GlmFlashes {
  startMs: number; endMs: number;
  lat: Float32Array; lon: Float32Array; energy: Float32Array; // J
  timeMs: Float64Array; // epoch ms of the first event
  area: Float32Array;
}

export function readGlmLcfa(h5: H5Like, bytes: Uint8Array): GlmFlashes {
  return withFile(h5, bytes, (f) => {
    const get = (n: string) => f.get(n) as H5Dataset | null;
    const lat = unpackCF(get('flash_lat')!), lon = unpackCF(get('flash_lon')!);
    const energy = unpackCF(get('flash_energy')!);
    const area = get('flash_area') ? unpackCF(get('flash_area')!) : new Float32Array(lat.length);
    const off = unpackCF(get('flash_time_offset_of_first_event')!);
    const startMs = Date.parse(str(f.attrs.time_coverage_start?.value));
    const endMs = Date.parse(str(f.attrs.time_coverage_end?.value));
    // product_time is seconds since 2000-01-01 12:00:00 UTC (J2000); offsets are seconds relative to it.
    const pt = num((get('product_time') as H5Dataset).value);
    const epoch = Date.UTC(2000, 0, 1, 12, 0, 0) + pt * 1000;
    const timeMs = new Float64Array(lat.length);
    for (let i = 0; i < lat.length; i++) timeMs[i] = epoch + off[i] * 1000;
    return { startMs, endMs, lat, lon, energy, timeMs, area };
  });
}
