// NOAA Global Mosaic of Geostationary Satellite Imagery (GMGSI, NESDIS/OSPO, v3) NetCDF-4 reader. One file per
// channel and hour blends GOES-East/West, Meteosat (0° and Indian Ocean) and Himawari into a global Mercator grid
// (lon −180…180 at ~0.072°, rows uniform in Mercator y to ±72.7°). `data` holds 0–255 scaled image values (not a
// calibrated temperature or reflectance), `dqf` is 0 for good pixels (10: no data, e.g. visible at night; 20 and the
// −128 fill are left out too). The grid is checked, not assumed: a file with another layout is rejected. Columns are
// spread over exactly 360° (gmgsiColumns), so the texture wraps around the globe without a seam.
import type { H5Like } from './goes';
import type { ProjParamsLike } from '../gis/gridproj';

export interface GmgsiProduct { id: 'LW' | 'VIS' | 'WV' | 'SW'; prefix: string; file: string; name: string; short: string }
/** The four channels in the public bucket (noaa-gmgsi-pds), in the order of the product setting. */
export const GMGSI_PRODUCTS: readonly GmgsiProduct[] = [
  { id: 'LW', prefix: 'GMGSI_LW', file: 'GLOBCOMPLIR', name: 'Longwave infrared (~11 µm)', short: 'IR' },
  { id: 'VIS', prefix: 'GMGSI_VIS', file: 'GLOBCOMPVIS', name: 'Visible (daylight only)', short: 'VIS' },
  { id: 'WV', prefix: 'GMGSI_WV', file: 'GLOBCOMPWV', name: 'Water vapour (~6.7 µm)', short: 'WV' },
  { id: 'SW', prefix: 'GMGSI_SW', file: 'GLOBCOMPSIR', name: 'Shortwave infrared (~3.9 µm)', short: 'SWIR' },
];

/** Nominal (start) time of a GMGSI object key: `…_s202611201800000_e…` → epoch ms; null for other names. */
export function gmgsiKeyTime(key: string): number | null {
  const m = /_s(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d_e\d{15}_c\d{15}\.nc$/.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/**
 * Scan start times named in the `source` attribute (the input files of the blend): Meteosat `-YYYYMMDDHHMM-`,
 * Himawari `HS_H09_YYYYMMDD_HHMM_` and GOES `_sYYYYDDDHHMMSS`. Returns [earliest, latest] or null when none parse.
 */
export function gmgsiScanRange(source: string): [number, number] | null {
  const ts: number[] = [];
  for (const m of source.matchAll(/-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})-/g)) ts.push(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  for (const m of source.matchAll(/HS_H\d\d_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_/g)) ts.push(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  for (const m of source.matchAll(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d_e/g)) ts.push(Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 86400e3 + +m[3] * 3600e3 + +m[4] * 60e3 + +m[5] * 1000);
  const ok = ts.filter((t) => Number.isFinite(t));
  return ok.length ? [Math.min(...ok), Math.max(...ok)] : null;
}

export interface GmgsiImage {
  width: number; height: number;
  /** 0 = no data, 1–255 = scaled image value 0–255 (code = 1 + round(v × 254 / 255)). */
  codes: Uint8Array;
  proj: ProjParamsLike;
  /** Drawn patch: lat0, lon0, lat1, lon1 (the grid's outer edges, the whole circle of longitude). */
  bounds: [number, number, number, number];
  nominalMs: number; scanStartMs: number | null; scanEndMs: number | null;
  platforms: string; summary: string;
}

interface Ds { shape: number[] | null; attrs: Record<string, { value: unknown }>; slice(ranges: ([number, number] | [])[]): ArrayLike<number> | null }
interface F { get(name: string): unknown; attrs: Record<string, { value: unknown }>; close(): void }

const RAD = Math.PI / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : String(v ?? ''));
/** Rows per decoded band: bounds the float copy of `data` held at once (~5 MB per band at full width). */
const BAND_ROWS = 240;

let seq = 0;
/**
 * Reads a GMGSI file and averages it by `factor` (good pixels only) into byte codes on its Mercator grid, its columns
 * spread over exactly 360° of longitude.
 */
export function readGmgsi(h5: H5Like, bytes: Uint8Array, factor: number): GmgsiImage {
  const path = `/tmp/cwrv3-gmgsi-${++seq}.nc`;
  h5.FS.writeFile(path, bytes);
  const f = new h5.File(path, 'r') as unknown as F;
  try { return decode(f, Math.max(1, Math.round(factor))); } finally { f.close(); try { h5.FS.unlink(path); } catch { /* ignore */ } }
}

function decode(f: F, k: number): GmgsiImage {
  const data = f.get('data') as Ds | null, dqf = f.get('dqf') as Ds | null, latDs = f.get('lat') as Ds | null, lonDs = f.get('lon') as Ds | null;
  if (!data || !dqf || !latDs || !lonDs || data.shape?.length !== 3) throw new Error('not a GMGSI file (data, dqf, lat, lon)');
  const [, ny, nx] = data.shape;
  const lat = Float64Array.from(latDs.slice([[0, ny], [0, 1]]) ?? []), lon = Float64Array.from(lonDs.slice([[0, 1], [0, nx]]) ?? []);
  if (lat.length !== ny || lon.length !== nx || nx < 8 || ny < 8) throw new Error('GMGSI: coordinate size does not match the data');
  const grid = checkGrid(lat, lon);
  const fill = Number((data.attrs._FillValue?.value as ArrayLike<number> | undefined)?.[0] ?? -9999);
  // Rows are averaged in blocks of k (the last ny mod k rows, at ~72.7°S, are left out); columns as gmgsiColumns says.
  const { W, col, west } = gmgsiColumns(grid.lon0, grid.di, nx, k), H = Math.floor(ny / k);
  const codes = new Uint8Array(W * H);
  const sum = new Float64Array(W), cnt = new Uint32Array(W);
  for (let r0 = 0; r0 < H * k; r0 += BAND_ROWS * k) {
    const r1 = Math.min(H * k, r0 + BAND_ROWS * k);
    const v = data.slice([[0, 1], [r0, r1], []])!, q = dqf.slice([[0, 1], [r0, r1], []])!;
    for (let oy = r0 / k; oy < r1 / k; oy++) {
      sum.fill(0); cnt.fill(0);
      for (let dy = 0; dy < k; dy++) {
        const row = (oy * k + dy - r0) * nx;
        for (let x = 0; x < nx; x++) {
          const val = v[row + x];
          if (q[row + x] !== 0 || val === fill || !(val >= 0 && val <= 255)) continue;
          const o = col[x];
          sum[o] += val; cnt[o]++;
        }
      }
      for (let o = 0; o < W; o++) codes[oy * W + o] = cnt[o] ? 1 + Math.round((sum[o] / cnt[o]) * 254 / 255) : 0;
    }
  }
  // The reference is the middle output column, half a turn from the western edge.
  const ref = (W - 1) / 2;
  const y1 = grid.y0 - (grid.dy * (k - 1)) / 2;
  const proj: ProjParamsLike = { kind: 4, nx: W, ny: H, flip: true, a: [1, wrap(west + 180), y1, 0], b: [ref, 0, (360 / W) * RAD, grid.dy * k] };
  const edge = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
  const bounds: [number, number, number, number] = [edge(y1 + (grid.dy * k) / 2), -180, edge(y1 - grid.dy * k * (H - 0.5)), 180];
  const timeDs = f.get('time') as { value: unknown } | null;
  const tSec = Number((timeDs?.value as ArrayLike<number> | undefined)?.[0]);
  const nominalMs = Number.isFinite(tSec) ? tSec * 1000 : Date.parse(str(f.attrs.time_coverage_start?.value));
  if (!Number.isFinite(nominalMs)) throw new Error('GMGSI: no observation time');
  const scans = gmgsiScanRange(str(f.attrs.source?.value));
  return {
    width: W, height: H, codes, proj, bounds, nominalMs, scanStartMs: scans?.[0] ?? null, scanEndMs: scans?.[1] ?? null,
    platforms: str(f.attrs.platform?.value), summary: str(f.attrs.summary?.value),
  };
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Output columns of nx source columns (the first at lon0, spacing di) averaged by k. The source columns do not span
 * exactly 360° (natively 4999 columns ~0.07201° apart: 0.1° from the last, at 179.9°, to the first, at 180°), so
 * they are spread over W = ⌊nx/k⌋ columns of exactly 360°/W starting at `west` (half the seam gap west of the first
 * column's western edge): output column c averages the k or k+1 source columns whose centres fall in it (`col`), and
 * every source column moves by at most |360° − nx·di| / 2 (0.014°, a fifth of a pixel natively). With k = 1 the
 * columns are kept as they are; only their spacing becomes 360°/nx.
 */
export function gmgsiColumns(lon0: number, di: number, nx: number, k: number): { W: number; col: Uint32Array; west: number } {
  const W = Math.max(1, Math.floor(nx / k)), col = new Uint32Array(nx);
  for (let x = 0; x < nx; x++) col[x] = Math.min(W - 1, Math.floor(((x + 0.5) * W) / nx));
  return { W, col, west: lon0 - di / 2 - (360 - nx * di) / 2 };
}

/**
 * Validates the grid: longitudes regular over the whole circle (the first column may be written as +180), rows
 * uniform in Mercator y and ordered north to south. Returns the first column's longitude, the spacing (degrees), the
 * first row's Mercator y and the row step (Mercator units, positive southward).
 */
export function checkGrid(lat: ArrayLike<number>, lon: ArrayLike<number>): { lon0: number; di: number; y0: number; dy: number } {
  const nx = lon.length, ny = lat.length;
  const lon0 = wrap(lon[0]);
  const east = (d: number) => ((d % 360) + 360) % 360; // eastward offset from the first column, 0 ≤ d < 360
  const di = east(lon[nx - 1] - lon0) / (nx - 1);
  if (!(di > 0) || Math.abs(nx * di - 360) > 1.5 * di) throw new Error('GMGSI: longitudes do not span the globe');
  for (let i = 1; i < nx; i++) if (Math.abs(east(lon[i] - lon0) - i * di) > 0.05 * di) throw new Error('GMGSI: longitudes are not regular');
  const y0 = mercY(lat[0]), dy = (y0 - mercY(lat[ny - 1])) / (ny - 1);
  if (!(dy > 0)) throw new Error('GMGSI: rows are not ordered north to south');
  for (let j = 1; j < ny; j++) if (Math.abs(mercY(lat[j]) - (y0 - j * dy)) > 0.05 * dy) throw new Error('GMGSI: rows are not uniform in Mercator y');
  return { lon0, di, y0, dy };
}

/**
 * Texel (column, row; centres at integers) of a longitude/latitude on a GMGSI grid: the reference of the raster
 * shader's Mercator projection (kind 4) with the reference-column offset. Null outside the grid.
 */
export function gmgsiTexel(p: ProjParamsLike, lon: number, lat: number): [number, number] | null {
  const dl = wrap(lon - p.a[1]);
  const i = (p.a[0] * dl * RAD) / p.b[2] + p.b[0];
  let j = (p.a[0] * mercY(Math.max(-85, Math.min(85, lat))) - p.a[2]) / p.b[3];
  if (p.flip) j = -j;
  const u = (i + 0.5) / p.nx, v = (j + 0.5) / p.ny;
  return u < 0 || u > 1 || v < 0 || v > 1 ? null : [i, j];
}
