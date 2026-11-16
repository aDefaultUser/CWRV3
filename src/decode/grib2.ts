// GRIB2 (WMO FM 92) decoder for the public NCEP/NWS feeds (MRMS, HRRR, RAP, GFS, NBM, NDFD, WPC PWPF).
// Grid templates: 3.0 (regular lat/lon), 3.10 (Mercator), 3.20 (polar stereographic), 3.30 (Lambert conformal).
// Data representation: 5.0 (simple), 5.2/5.3 (complex packing, spatial differencing), 5.40 (JPEG 2000, OpenJPEG
// WebAssembly), 5.41 (PNG). Product templates 4.0–4.12: parameter, level, forecast time, end of statistical
// interval, probability limits and percentile. Section 2 (local use, e.g. NDFD weather strings) is kept raw.
import { decodeJ2K } from './jpeg2000';

export type Inflate = (zlibData: Uint8Array) => Promise<Uint8Array>;

export interface LatLonGrid { kind: 'latlon'; ni: number; nj: number; la1: number; lo1: number; la2: number; lo2: number; di: number; dj: number; scan: number }
export interface LambertGrid {
  kind: 'lambert'; nx: number; ny: number; la1: number; lo1: number; lad: number; lov: number; dx: number; dy: number;
  latin1: number; latin2: number; scan: number; radius: number;
  /** Resolution flag bit 0x08: vector components are relative to the grid x/y axes. */
  uvGrid?: boolean;
}
export interface MercatorGrid { kind: 'mercator'; nx: number; ny: number; la1: number; lo1: number; la2: number; lo2: number; lad: number; di: number; dj: number; scan: number; radius: number }
export interface PolarGrid { kind: 'polar'; nx: number; ny: number; la1: number; lo1: number; lad: number; lov: number; dx: number; dy: number; south: boolean; scan: number; radius: number; uvGrid?: boolean }
export type Grid = LatLonGrid | LambertGrid | MercatorGrid | PolarGrid;
export const gridSize = (g: Grid) => (g.kind === 'latlon' ? [g.ni, g.nj] : [g.nx, g.ny]) as [number, number];

export interface GribField {
  discipline: number; category: number; number: number;
  refTimeMs: number; forecastMinutes: number;
  surfaceType: number; surfaceValue: number;
  /** Second fixed surface (layers such as "3000-0 m above ground"). */
  surface2Type: number; surface2Value: number;
  grid: Grid;
  values: Float32Array; // NaN where the bitmap masks a point
  /** Product definition template number (section 4). */
  pdt: number;
  /** End of the statistical processing interval (templates 4.8–4.12), else null. */
  endTimeMs: number | null;
  /** Probability limits (templates 4.5 / 4.9): type, lower, upper. */
  prob: { type: number; lower: number | null; upper: number | null } | null;
  /** Percentile value (templates 4.6 / 4.10). */
  percentile: number | null;
  /** Raw local-use section 2 (NDFD weather/hazard string tables), when present. */
  local: Uint8Array | null;
  /** Packing template number (section 5). */
  drt: number;
}

/** GRIB2 signed integers use sign-and-magnitude. */
const sm16 = (v: number) => (v & 0x8000 ? -(v & 0x7fff) : v);
const sm8 = (v: number) => (v & 0x80 ? -(v & 0x7f) : v);
const sm32 = (v: number) => (v & 0x80000000 ? -(v & 0x7fffffff) : v);
const smN = (b: Uint8Array, o: number, n: number) => {
  let v = b[o] & 0x7f;
  for (let i = 1; i < n; i++) v = v * 256 + b[o + i];
  return b[o] & 0x80 ? -v : v;
};

class Bits {
  private bitPos = 0;
  constructor(private b: Uint8Array, private start: number) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = this.bitPos++;
      v = v * 2 + ((this.b[this.start + (p >> 3)] >> (7 - (p & 7))) & 1);
    }
    return v;
  }
  /** Fast path for widths <= 25 bits. */
  readFast(n: number): number {
    if (n === 0) return 0;
    if (n > 25) return this.read(n);
    const p = this.bitPos, byte = this.start + (p >> 3), off = p & 7;
    const b = this.b;
    const word = ((b[byte] << 24) | (b[byte + 1] << 16) | (b[byte + 2] << 8) | (b[byte + 3] ?? 0)) >>> 0;
    this.bitPos += n;
    return (word << off >>> 0) >>> (32 - n);
  }
  align() { this.bitPos = (this.bitPos + 7) & ~7; }
}

interface Drs { template: number; npts: number; R: number; E: number; D: number; nbits: number; sec: Uint8Array }

function unpackSimple(drs: Drs, data: Uint8Array, count: number): Float64Array {
  const out = new Float64Array(count);
  const bits = new Bits(data, 0);
  for (let i = 0; i < count; i++) out[i] = drs.nbits ? bits.readFast(drs.nbits) : 0;
  return out;
}

function unpackComplex(drs: Drs, data: Uint8Array, count: number): Float64Array {
  const s = drs.sec, dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const missingMgmt = s[22];
  const ng = dv.getUint32(31);
  const widthRef = s[35], widthBits = s[36];
  const lenRef = dv.getUint32(37), lenInc = s[41], lastLen = dv.getUint32(42), lenBits = s[46];
  const order = drs.template === 3 ? s[47] : 0;
  const extraOctets = drs.template === 3 ? s[48] : 0;
  let p = 0;
  const ivals: number[] = [];
  let minsd = 0;
  if (order > 0) {
    for (let k = 0; k < order; k++) { ivals.push(smN(data, p, extraOctets)); p += extraOctets; }
    minsd = smN(data, p, extraOctets); p += extraOctets;
  }
  const br = new Bits(data, p);
  const refs = new Float64Array(ng), widths = new Uint8Array(ng), lens = new Uint32Array(ng);
  for (let g = 0; g < ng; g++) refs[g] = br.read(drs.nbits);
  br.align();
  for (let g = 0; g < ng; g++) widths[g] = br.read(widthBits) + widthRef;
  br.align();
  for (let g = 0; g < ng; g++) lens[g] = br.read(lenBits) * lenInc + lenRef;
  if (ng) lens[ng - 1] = lastLen;
  br.align();
  const X = new Float64Array(count);
  const missing = new Uint8Array(count);
  let n = 0;
  const refMissing = 2 ** drs.nbits - 1;
  for (let g = 0; g < ng && n < count; g++) {
    const w = widths[g], len = lens[g], ref = refs[g];
    if (w === 0) {
      const miss = missingMgmt > 0 && ref === refMissing;
      for (let k = 0; k < len && n < count; k++, n++) { X[n] = ref; if (miss) missing[n] = 1; }
    } else {
      const m1 = 2 ** w - 1, m2 = m1 - 1;
      for (let k = 0; k < len && n < count; k++, n++) {
        const v = br.readFast(w);
        if (missingMgmt === 1 && v === m1) missing[n] = 1;
        else if (missingMgmt === 2 && (v === m1 || v === m2)) missing[n] = 1;
        else X[n] = ref + v;
      }
    }
  }
  if (order > 0) {
    // Undo spatial differencing over non-missing points only.
    let k = 0, prev1 = 0, prev2 = 0;
    for (let i = 0; i < count; i++) {
      if (missing[i]) continue;
      if (k < order) X[i] = ivals[k];
      else X[i] = order === 1 ? X[i] + minsd + prev1 : X[i] + minsd + 2 * prev1 - prev2;
      prev2 = prev1; prev1 = X[i]; k++;
    }
  }
  for (let i = 0; i < count; i++) if (missing[i]) X[i] = NaN;
  return X;
}

async function unpackPng(data: Uint8Array, inflate: Inflate): Promise<Float64Array> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 8, width = 0, height = 0, depth = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  while (p + 8 <= data.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(data[p + 4], data[p + 5], data[p + 6], data[p + 7]);
    if (type === 'IHDR') { width = dv.getUint32(p + 8); height = dv.getUint32(p + 12); depth = data[p + 16]; colorType = data[p + 17]; }
    else if (type === 'IDAT') idat.push(data.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
  const bitsPerPixel = depth * channels;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const total = idat.reduce((s, c) => s + c.length, 0);
  const z = new Uint8Array(total);
  let o = 0; for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = await inflate(z);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const img = new Uint8Array(stride * height);
  const prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = img.subarray(y * stride, (y + 1) * stride);
    const up = y ? img.subarray((y - 1) * stride, y * stride) : prevRow;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = up[x], c = x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      switch (filter) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
      }
      row[x] = v;
    }
  }
  const n = width * height;
  const out = new Float64Array(n);
  if (bitsPerPixel === 16) for (let i = 0; i < n; i++) out[i] = (img[2 * i] << 8) | img[2 * i + 1];
  else if (bitsPerPixel === 8) for (let i = 0; i < n; i++) out[i] = img[i];
  else if (bitsPerPixel === 24) for (let i = 0; i < n; i++) out[i] = (img[3 * i] << 16) | (img[3 * i + 1] << 8) | img[3 * i + 2];
  else if (bitsPerPixel === 32) for (let i = 0; i < n; i++) out[i] = ((img[4 * i] << 24) | (img[4 * i + 1] << 16) | (img[4 * i + 2] << 8) | img[4 * i + 3]) >>> 0;
  else { const br = new Bits(img, 0); for (let y = 0, i = 0; y < height; y++) { for (let x = 0; x < width; x++) out[i++] = br.read(bitsPerPixel); br.align(); } }
  return out;
}

function parseGrid(s: Uint8Array): Grid {
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const tmpl = dv.getUint16(12);
  const shape = s[14];
  const radius = shape === 1 ? dv.getUint32(16) / 10 ** s[15] : shape === 6 ? 6371229 : shape === 0 ? 6367470 : 6371229;
  if (tmpl === 0) {
    return { kind: 'latlon', ni: dv.getUint32(30), nj: dv.getUint32(34), la1: sm32(dv.getUint32(46)) / 1e6, lo1: sm32(dv.getUint32(50)) / 1e6,
      la2: sm32(dv.getUint32(55)) / 1e6, lo2: sm32(dv.getUint32(59)) / 1e6, di: dv.getUint32(63) / 1e6, dj: dv.getUint32(67) / 1e6, scan: s[71] };
  }
  if (tmpl === 10) {
    return { kind: 'mercator', nx: dv.getUint32(30), ny: dv.getUint32(34), la1: sm32(dv.getUint32(38)) / 1e6, lo1: sm32(dv.getUint32(42)) / 1e6,
      lad: sm32(dv.getUint32(47)) / 1e6, la2: sm32(dv.getUint32(51)) / 1e6, lo2: sm32(dv.getUint32(55)) / 1e6, scan: s[59],
      di: dv.getUint32(64) / 1e3, dj: dv.getUint32(68) / 1e3, radius };
  }
  if (tmpl === 20) {
    return { kind: 'polar', nx: dv.getUint32(30), ny: dv.getUint32(34), la1: sm32(dv.getUint32(38)) / 1e6, lo1: sm32(dv.getUint32(42)) / 1e6,
      lad: sm32(dv.getUint32(47)) / 1e6, lov: sm32(dv.getUint32(51)) / 1e6, dx: dv.getUint32(55) / 1e3, dy: dv.getUint32(59) / 1e3,
      south: (s[63] & 0x80) !== 0, scan: s[64], radius, uvGrid: (s[46] & 0x08) !== 0 };
  }
  if (tmpl === 30) {
    return { kind: 'lambert', nx: dv.getUint32(30), ny: dv.getUint32(34), la1: sm32(dv.getUint32(38)) / 1e6, lo1: sm32(dv.getUint32(42)) / 1e6,
      lad: sm32(dv.getUint32(47)) / 1e6, lov: sm32(dv.getUint32(51)) / 1e6, dx: dv.getUint32(55) / 1e3, dy: dv.getUint32(59) / 1e3,
      scan: s[64], latin1: sm32(dv.getUint32(65)) / 1e6, latin2: sm32(dv.getUint32(69)) / 1e6, radius, uvGrid: (s[46] & 0x08) !== 0 };
  }
  throw new Error(`grib2: unsupported grid template 3.${tmpl}`);
}

/**
 * Normalises row storage so that every row runs west→east: bit 0x80 (i negative) is undone in place and cleared.
 * Row order (bit 0x40) is kept and handled by the projection. Bit 0x10 (alternative row scanning, set by NDFD/NBM)
 * reverses every second stored row. ecCodes' `values` stay in storage order and its iterator ignores the bit, so
 * tests/ndfd-geo checks row-to-row smoothness as well as ecCodes values with odd rows reversed.
 */
function normalizeScan(grid: Grid, v: Float32Array, w: number, h: number) {
  if (grid.scan & 0x10) for (let r = 1; r < h; r += 2) v.subarray(r * w, (r + 1) * w).reverse();
  const iNeg = (grid.scan & 0x80) !== 0;
  if (!iNeg) { grid.scan &= ~0x10; return; }
  for (let r = 0; r < h; r++) v.subarray(r * w, (r + 1) * w).reverse();
  if (iNeg && grid.kind === 'latlon') { const t = grid.lo1; grid.lo1 = grid.lo2; grid.lo2 = t; }
  grid.scan &= ~0x90;
}

/** Decodes every message in a GRIB2 buffer (concatenated messages allowed). */
/**
 * Complete GRIB2 messages in a buffer: "GRIB", edition 2, a total length that fits the buffer and the "7777" end
 * marker. Anything else is skipped one byte at a time, so malformed lengths (0, short, past the end) cannot stall
 * or overrun the scan.
 */
export function scanGribMessages(bytes: Uint8Array): { offset: number; length: number }[] {
  const out: { offset: number; length: number }[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let m = 0;
  while (m + 20 <= bytes.length) {
    if (bytes[m] === 0x47 && bytes[m + 1] === 0x52 && bytes[m + 2] === 0x49 && bytes[m + 3] === 0x42 && bytes[m + 7] === 2) {
      const len = Number(dv.getBigUint64(m + 8));
      const end = m + len;
      if (len >= 20 && end <= bytes.length && bytes[end - 4] === 0x37 && bytes[end - 3] === 0x37 && bytes[end - 2] === 0x37 && bytes[end - 1] === 0x37) {
        out.push({ offset: m, length: len });
        m = end;
        continue;
      }
    }
    m++;
  }
  return out;
}

export async function decodeGrib2(buf: Uint8Array, inflate: Inflate): Promise<GribField[]> {
  const fields: GribField[] = [];
  let m = 0;
  while (m + 16 <= buf.length) {
    if (buf[m] !== 0x47 || buf[m + 1] !== 0x52 || buf[m + 2] !== 0x49 || buf[m + 3] !== 0x42) { m++; continue; }
    const dvAll = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const discipline = buf[m + 6];
    const total = Number(dvAll.getBigUint64(m + 8));
    const end = m + total;
    if (total < 20 || end > buf.length) { m++; continue; } // not a complete message: keep scanning
    let p = m + 16;
    let refTimeMs = 0, grid: Grid | null = null, category = 0, number = 0, fcst = 0, surfaceType = 0, surfaceValue = 0, surface2Type = 255, surface2Value = NaN;
    let pdt = 0, endTimeMs: number | null = null, prob: GribField['prob'] = null, percentile: number | null = null, local: Uint8Array | null = null;
    let drs: Drs | null = null, bitmap: Uint8Array | null = null;
    while (p + 5 <= end && p + 4 <= buf.length) {
      if (buf[p] === 0x37 && buf[p + 1] === 0x37 && buf[p + 2] === 0x37 && buf[p + 3] === 0x37) break;
      const len = dvAll.getUint32(p);
      if (len < 5 || p + len > end) throw new Error('grib2: bad section length');
      const sec = buf.subarray(p, p + len);
      const dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
      switch (buf[p + 4]) {
        case 1:
          refTimeMs = Date.UTC(dv.getUint16(12), sec[14] - 1, sec[15], sec[16], sec[17], sec[18]);
          break;
        case 2: local = sec.subarray(5); break;
        case 3: grid = parseGrid(sec); break;
        case 4: {
          pdt = dv.getUint16(7);
          category = sec[9]; number = sec[10];
          const unit = sec[17];
          const t = sm32(dv.getUint32(18));
          fcst = unit === 0 ? t : unit === 1 ? t * 60 : unit === 2 ? t * 1440 : unit === 10 ? t * 180 : unit === 11 ? t * 360 : unit === 12 ? t * 720 : unit === 13 ? t / 60 : t;
          surfaceType = sec[22];
          surfaceValue = sm32(dv.getUint32(24)) / 10 ** sm8(sec[23]);
          surface2Type = sec[28];
          surface2Value = surface2Type === 255 ? NaN : sm32(dv.getUint32(30)) / 10 ** sm8(sec[29]);
          // Octet positions below are 1-based in the WMO tables; the section array is 0-based.
          const at = (o: number) => Date.UTC(dv.getUint16(o - 1), sec[o + 1] - 1, sec[o + 2], sec[o + 3], sec[o + 4], sec[o + 5]);
          // Probability block (4.5 / 4.9): octet 37 type, 38 lower scale, 39–42 lower value, 43 upper scale, 44–47 upper value.
          const probAt = () => ({
            type: sec[36],
            lower: sec[37] === 255 ? null : sm32(dv.getUint32(38)) / 10 ** sm8(sec[37]),
            upper: sec[42] === 255 ? null : sm32(dv.getUint32(43)) / 10 ** sm8(sec[42]),
          });
          if (pdt === 8) endTimeMs = at(35);
          else if (pdt === 9) { prob = probAt(); endTimeMs = at(48); }
          else if (pdt === 10) { percentile = sec[34]; endTimeMs = at(36); }
          else if (pdt === 11) endTimeMs = at(38);
          else if (pdt === 12) endTimeMs = at(37);
          else if (pdt === 5) prob = probAt();
          else if (pdt === 6) percentile = sec[34];
          break;
        }
        case 5:
          drs = { template: dv.getUint16(9), npts: dv.getUint32(5), R: dv.getFloat32(11), E: sm16(dv.getUint16(15)), D: sm16(dv.getUint16(17)), nbits: sec[19], sec };
          break;
        case 6:
          bitmap = sec[5] === 0 ? sec.subarray(6) : null;
          break;
        case 7: {
          if (!grid || !drs) throw new Error('grib2: data section before grid/representation');
          const data = sec.subarray(5);
          let X: Float64Array;
          if (drs.template === 0) X = unpackSimple(drs, data, drs.npts);
          else if (drs.template === 2 || drs.template === 3) X = unpackComplex(drs, data, drs.npts);
          else if (drs.template === 41) X = await unpackPng(data, inflate);
          else if (drs.template === 40) X = (await decodeJ2K(data)).samples;
          else throw new Error(`grib2: data representation template 5.${drs.template} not supported`);
          const [gw, gh] = gridSize(grid);
          const npts = gw * gh;
          const values = new Float32Array(npts).fill(NaN);
          const bscale = 2 ** drs.E, dscale = 10 ** -drs.D;
          let k = 0;
          for (let i = 0; i < npts; i++) {
            if (bitmap && !((bitmap[i >> 3] >> (7 - (i & 7))) & 1)) continue;
            const x = drs.nbits === 0 && drs.template === 0 ? 0 : X[k++];
            values[i] = (drs.R + x * bscale) * dscale;
          }
          normalizeScan(grid, values, gw, gh);
          fields.push({ discipline, category, number, refTimeMs, forecastMinutes: fcst, surfaceType, surfaceValue, surface2Type, surface2Value, grid, values, pdt, endTimeMs, prob, percentile, local, drt: drs.template });
          break;
        }
      }
      p += len;
    }
    m = end;
  }
  return fields;
}

/** Lambert conformal (secant/tangent cone on a sphere) forward projection to grid indices. */
export function lambertIndex(g: LambertGrid, latDeg: number, lonDeg: number): [number, number] {
  const rad = Math.PI / 180;
  const p1 = g.latin1 * rad, p2 = g.latin2 * rad;
  const n = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  const F = (Math.cos(p1) * Math.tan(Math.PI / 4 + p1 / 2) ** n) / n;
  const rho = (lat: number) => g.radius * F / Math.tan(Math.PI / 4 + lat * rad / 2) ** n;
  const rho0 = rho(g.lad);
  const xy = (lat: number, lon: number) => {
    let dl = lon - g.lov; while (dl > 180) dl -= 360; while (dl < -180) dl += 360;
    const th = n * dl * rad, r = rho(lat);
    return [r * Math.sin(th), rho0 - r * Math.cos(th)];
  };
  const [x0, y0] = xy(g.la1, g.lo1);
  const [x, y] = xy(latDeg, lonDeg);
  return [(x - x0) / g.dx, (y - y0) / g.dy];
}
