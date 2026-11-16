// NEXRAD Level III product decoder (ROC ICD 2620001AA, Build 21.0, public).
// Supports radial packets 16 / AF1F, raster BA0F/BA07, contour 0E03/0802/3501, text 1/2/8,
// vectors 6/7/9/10, special symbols 12/15/19/20/23/24/25/26, bzip2-compressed products and
// tabular / graphic alphanumeric blocks.
import { bunzip2 } from './bzip2';

export interface L3Radial {
  firstBin: number;
  bins: number;
  gateKm: number;
  radials: number;
  startAz: Float32Array;
  widthAz: Float32Array;
  /** Data level codes, radial-major. */
  codes: Uint8Array;
}

export interface L3Raster { rows: number; cols: number; cellKm: number; codes: Uint8Array; }

export interface L3Point { x: number; y: number } // km east / north of radar
export interface L3Cell { id: string; x: number; y: number; past: L3Point[]; forecast: L3Point[] }
export interface L3Hail { x: number; y: number; poh: number; posh: number; maxSizeIn: number }
export interface L3Feature { x: number; y: number; type: number; attr: number }
export interface L3Contour { level: number | null; points: L3Point[] }
export interface L3Text { x: number; y: number; text: string; color: number | null }

export interface L3Product {
  code: number;
  wmoHeader: string;
  awips: string;
  lat: number; lon: number; heightFt: number;
  opMode: number; vcp: number; volumeScan: number;
  volumeTimeMs: number; generationTimeMs: number;
  elevationNumber: number;
  /** Product-dependent halfwords P1..P10 (index 0 = P1). */
  p: number[];
  thresholds: number[]; // halfwords 31..46 (raw uint16)
  radial?: L3Radial;
  raster?: L3Raster;
  /** Code → physical value (NaN where the code is a flag). */
  lut: Float32Array;
  /** Code → flag label for non-numeric codes. */
  flags: Map<number, string>;
  units: string;
  cells: L3Cell[]; tvs: L3Point[]; etvs: L3Point[]; hail: L3Hail[]; features: L3Feature[];
  contours: L3Contour[]; texts: L3Text[]; circles: (L3Point & { r: number })[];
  pages: string[][];
}

/** Gate length in km for radial products (ICD Table III resolution column). */
const GATE_KM: Record<number, number> = {
  19: 1, 20: 2, 25: 0.25, 27: 1, 28: 0.25, 30: 1, 32: 1, 56: 1, 78: 2, 79: 2, 80: 2, 94: 1, 99: 0.25, 134: 1, 135: 1,
  138: 2, 153: 0.25, 154: 0.25, 159: 0.25, 161: 0.25, 163: 0.25, 165: 0.25, 169: 2, 170: 0.25, 171: 2, 172: 0.25,
  173: 0.25, 174: 0.25, 175: 0.25, 176: 0.25, 177: 0.25,
};
/** Raster cell size in km. */
const RASTER_KM: Record<number, number> = { 37: 1, 38: 4, 41: 4, 57: 4, 65: 4, 66: 4, 67: 4, 90: 4 };

export const UNITS: Record<number, string> = {
  19: 'dBZ', 20: 'dBZ', 30: 'kt', 32: 'dBZ', 37: 'dBZ', 38: 'dBZ', 41: 'kft', 56: 'kt', 57: 'kg/m²', 65: 'dBZ', 66: 'dBZ',
  67: 'dBZ', 78: 'in', 79: 'in', 80: 'in', 90: 'dBZ', 94: 'dBZ', 99: 'm/s', 134: 'kg/m²', 135: 'kft', 138: 'in', 153: 'dBZ',
  154: 'm/s', 159: 'dB', 161: '', 163: '°/km', 165: 'class', 169: 'in', 170: 'in', 171: 'in', 172: 'in', 173: 'in',
  174: 'in', 175: 'in', 176: 'in/h', 177: 'class',
};

const THRESH_CODES = ['', 'TH', 'ND', 'RF', 'BI', 'GC', 'IC', 'GR', 'WS', 'DS', 'RA', 'HR', 'BD', 'HA', 'UK', 'LH', 'GH'];
export const HCA_CLASSES: Record<number, string> = {
  10: 'BI', 20: 'GC', 30: 'IC', 40: 'DS', 50: 'WS', 60: 'RA', 70: 'HR', 80: 'BD', 90: 'GR', 100: 'HA', 110: 'LH', 120: 'GH', 140: 'UK', 150: 'RF',
};

function halfFloat(hw: number): number {
  const s = hw >> 15 & 1, e = hw >> 10 & 0x1f, f = hw & 0x3ff;
  const v = e === 0 ? 2 * (f / 1024) : 2 ** (e - 16) * (1 + f / 1024);
  return s ? -v : v;
}

function floatFrom(hi: number, lo: number): number {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint16(0, hi); dv.setUint16(2, lo);
  return dv.getFloat32(0);
}

/** Builds the code→value table from the product's threshold halfwords (ICD Table V notes). */
function buildLut(code: number, t: number[]): { lut: Float32Array; flags: Map<number, string> } {
  const lut = new Float32Array(256).fill(NaN);
  const flags = new Map<number, string>();
  const s16 = (v: number) => (v << 16) >> 16;
  if ([32, 93, 94, 153, 195, 99, 154].includes(code)) {
    const min = s16(t[0]) / 10, inc = t[1] / 10, n = t[2];
    flags.set(0, 'BT'); flags.set(1, code === 99 || code === 154 ? 'RF' : 'MISSING');
    for (let c = 2; c < Math.max(n, 2) && c < 256; c++) lut[c] = min + (c - 2) * inc;
  } else if (code === 138) {
    const min = s16(t[0]), inc = t[1];
    flags.set(0, 'NONE');
    for (let c = 1; c < 256; c++) lut[c] = (min + c * inc) / 100;
  } else if (code === 134) {
    const linScale = halfFloat(t[0]), linOff = halfFloat(t[1]), logStart = t[2], logScale = halfFloat(t[3]), logOff = halfFloat(t[4]);
    flags.set(0, 'BT'); flags.set(1, 'FLAGGED'); flags.set(255, 'RESERVED');
    for (let c = 2; c < 255; c++) lut[c] = c < logStart ? (c - linOff) / linScale : Math.exp((c - logOff) / logScale);
  } else if (code === 135) {
    const mask = t[0], scale = t[1] || 1, off = t[2];
    flags.set(0, 'BT'); flags.set(1, 'BAD');
    for (let c = 2; c < 256; c++) lut[c] = (c & mask) / scale - off;
  } else if ([159, 161, 163, 167, 168, 170, 172, 173, 174, 175, 176].includes(code)) {
    const scale = floatFrom(t[0], t[1]), off = floatFrom(t[2], t[3]);
    const leading = t[6], maxData = t[5] || 255;
    const hundredths = [170, 172, 173, 174, 175].includes(code) ? 0.01 : 1;
    for (let c = 0; c < leading; c++) flags.set(c, c === 0 ? (leading === 1 ? 'NONE' : 'BT') : 'RF');
    for (let c = leading; c <= Math.min(255, maxData); c++) lut[c] = ((c - off) / scale) * hundredths;
  } else if (code === 165 || code === 177) {
    for (const [k, name] of Object.entries(HCA_CLASSES)) { lut[+k] = +k; flags.set(+k, name); }
    flags.set(0, 'ND'); lut[0] = NaN; lut[150] = NaN;
  } else {
    // 16-level legacy products: each halfword is a coded threshold.
    for (let c = 0; c < 16; c++) {
      const hw = t[c];
      if (hw & 0x8000) { flags.set(c, THRESH_CODES[(hw & 0xff) + 1] ?? `C${hw & 0xff}`); continue; }
      let v = hw & 0xff;
      if (hw & 0x4000) v /= 100; else if (hw & 0x2000) v /= 20; else if (hw & 0x1000) v /= 10;
      if (hw & 0x0100) v = -v;
      lut[c] = v;
      if (hw & 0x0800) flags.set(c, '>'); // qualifier, value retained
      if (hw & 0x0400) flags.set(c, '<');
    }
  }
  return { lut, flags };
}

class Reader {
  dv: DataView;
  constructor(public b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  i16(o: number) { return this.dv.getInt16(o); }
  u16(o: number) { return this.dv.getUint16(o); }
  i32(o: number) { return this.dv.getInt32(o); }
  u32(o: number) { return this.dv.getUint32(o); }
  str(o: number, n: number) { let s = ''; for (let i = 0; i < n && o + i < this.b.length; i++) s += String.fromCharCode(this.b[o + i]); return s; }
}

const pt = (i: number, j: number): L3Point => ({ x: i / 4, y: -j / 4 });

export function decodeLevel3(input: Uint8Array): L3Product {
  // Optional WMO / AWIPS text header ("SDUS54 KOUN 151139\r\r\nN0QTLX\r\r\n").
  let start = 0, wmoHeader = '', awips = '';
  if (input[0] >= 0x41 && input[0] <= 0x5a && input[1] >= 0x41 && input[1] <= 0x5a) {
    const lines: string[] = [];
    for (let k = 0; k < 2; k++) {
      let e = start;
      while (e < Math.min(input.length, start + 64) && input[e] !== 0x0a) e++;
      lines.push(String.fromCharCode(...input.subarray(start, e)).replace(/\r/g, '').trim());
      start = e + 1;
    }
    [wmoHeader, awips] = lines;
  }
  let msg = input.subarray(start);
  let r = new Reader(msg);
  if (r.i16(18) !== -1) throw new Error('level3: product description block divider not found');
  const code = r.i16(30);
  const p = [r.i16(52), r.i16(54), r.i16(58), r.i16(92), r.i16(94), r.i16(96), r.i16(98), r.i16(100), r.i16(102), r.i16(104)];
  const thresholds: number[] = [];
  for (let k = 0; k < 16; k++) thresholds.push(r.u16(60 + k * 2));
  const dayMs = (d: number, sec: number) => (d - 1) * 86400000 + sec * 1000;
  const symOff = r.u32(108) * 2, graphOff = r.u32(112) * 2, tabOff = r.u32(116) * 2;

  // Compressed products: P8 (halfword 51) == 1 → bzip2 after the 120-byte header.
  const compressible = ![56, 2, 58, 59, 61, 62, 141].includes(code);
  if (compressible && r.u16(100) === 1 && msg[120] === 0x42 && msg[121] === 0x5a) {
    const body = bunzip2(msg, 120);
    const full = new Uint8Array(120 + body.length);
    full.set(msg.subarray(0, 120)); full.set(body, 120);
    msg = full; r = new Reader(msg);
  }

  const { lut, flags } = buildLut(code, thresholds);
  const prod: L3Product = {
    code, wmoHeader, awips, lat: r.i32(20) / 1000, lon: r.i32(24) / 1000, heightFt: r.i16(28),
    opMode: r.i16(32), vcp: r.i16(34), volumeScan: r.i16(38),
    volumeTimeMs: dayMs(r.u16(40), r.u32(42)), generationTimeMs: dayMs(r.u16(46), r.u32(48)),
    elevationNumber: r.i16(56), p, thresholds, lut, flags, units: UNITS[code] ?? '',
    cells: [], tvs: [], etvs: [], hail: [], features: [], contours: [], texts: [], circles: [], pages: [],
  };

  if (symOff > 0 && symOff + 10 < msg.length && r.i16(symOff) === -1 && r.i16(symOff + 2) === 1) {
    const blockLen = r.u32(symOff + 4);
    const nLayers = r.i16(symOff + 8);
    let o = symOff + 10;
    const end = Math.min(msg.length, symOff + blockLen);
    for (let L = 0; L < nLayers && o + 6 <= end; L++) {
      if (r.i16(o) !== -1) break;
      const layerLen = r.u32(o + 2);
      parsePackets(r, o + 6, Math.min(end, o + 6 + layerLen), prod, true);
      o += 6 + layerLen;
    }
  }
  if (graphOff > 0 && graphOff + 8 < msg.length && r.i16(graphOff + 2) === 2) parseGraphicBlock(r, graphOff, prod);
  if (tabOff > 0 && tabOff + 8 < msg.length) parseTabular(r, tabOff, prod);
  return prod;
}

function parsePackets(r: Reader, o: number, end: number, prod: L3Product, sym: boolean, cell?: { list: L3Point[] }) {
  let contourLevel: number | null = null;
  while (o + 4 <= end) {
    const pc = r.u16(o);
    if (pc === 16) {
      const firstBin = r.i16(o + 2), bins = r.i16(o + 4), nr = r.i16(o + 12);
      const codes = new Uint8Array(nr * bins), startAz = new Float32Array(nr), widthAz = new Float32Array(nr);
      let q = o + 14;
      for (let k = 0; k < nr; k++) {
        const nb = r.u16(q);
        startAz[k] = r.i16(q + 2) / 10; widthAz[k] = r.i16(q + 4) / 10;
        codes.set(r.b.subarray(q + 6, q + 6 + Math.min(nb, bins)), k * bins);
        q += 6 + nb + (nb & 1);
      }
      prod.radial = { firstBin, bins, gateKm: GATE_KM[prod.code] ?? 1, radials: nr, startAz, widthAz, codes };
      o = q; continue;
    }
    if (pc === 0xaf1f) {
      const firstBin = r.i16(o + 2), bins = r.i16(o + 4), nr = r.i16(o + 12);
      const codes = new Uint8Array(nr * bins), startAz = new Float32Array(nr), widthAz = new Float32Array(nr);
      let q = o + 14;
      for (let k = 0; k < nr; k++) {
        const nhw = r.u16(q);
        startAz[k] = r.i16(q + 2) / 10; widthAz[k] = r.i16(q + 4) / 10;
        let g = 0;
        for (let b = 0; b < nhw * 2; b++) {
          const v = r.b[q + 6 + b], run = v >> 4, color = v & 15;
          for (let n = 0; n < run && g < bins; n++) codes[k * bins + g++] = color;
        }
        q += 6 + nhw * 2;
      }
      prod.radial = { firstBin, bins, gateKm: GATE_KM[prod.code] ?? 1, radials: nr, startAz, widthAz, codes };
      o = q; continue;
    }
    if (pc === 0xba0f || pc === 0xba07) {
      const rows = r.i16(o + 18);
      let q = o + 22;
      const rowData: Uint8Array[] = [];
      let cols = 0;
      for (let k = 0; k < rows; k++) {
        const nb = r.u16(q);
        const row: number[] = [];
        for (let b = 0; b < nb; b++) { const v = r.b[q + 2 + b]; for (let n = 0; n < v >> 4; n++) row.push(v & 15); }
        rowData.push(Uint8Array.from(row)); cols = Math.max(cols, row.length);
        q += 2 + nb;
      }
      const codes = new Uint8Array(rows * cols);
      rowData.forEach((row, k) => codes.set(row, k * cols));
      prod.raster = { rows, cols, cellKm: RASTER_KM[prod.code] ?? 4, codes };
      o = q; continue;
    }
    if (pc === 0x0802) { contourLevel = r.i16(o + 4); o += 6; continue; }
    if (pc === 0x0e03) {
      // Layout: code, 0x8000 indicator, I start, J start, byte length, then end points.
      const pts = [pt(r.i16(o + 4), r.i16(o + 6))];
      const n = r.i16(o + 8) / 4;
      for (let k = 0; k < n; k++) pts.push(pt(r.i16(o + 10 + k * 4), r.i16(o + 12 + k * 4)));
      prod.contours.push({ level: contourLevel, points: pts });
      o += 10 + n * 4; continue;
    }
    if (pc === 0x3501) {
      const len = r.i16(o + 2);
      for (let k = 0; k + 8 <= len; k += 8) prod.contours.push({ level: contourLevel, points: [pt(r.i16(o + 4 + k), r.i16(o + 6 + k)), pt(r.i16(o + 8 + k), r.i16(o + 10 + k))] });
      o += 4 + len; continue;
    }
    const len = r.u16(o + 2);
    const body = o + 4, next = o + 4 + len;
    if (next > end || len > 65000) break;
    switch (pc) {
      case 1: case 2: case 8: {
        const hasColor = pc === 8;
        const ib = body + (hasColor ? 2 : 0);
        prod.texts.push({ ...pt(r.i16(ib), r.i16(ib + 2)), text: r.str(ib + 4, next - ib - 4).replace(/\0/g, ''), color: hasColor ? r.i16(body) : null });
        break;
      }
      case 6: case 9: {
        const pts: L3Point[] = [];
        for (let q = body + (pc === 9 ? 2 : 0); q + 4 <= next; q += 4) pts.push(pt(r.i16(q), r.i16(q + 2)));
        if (cell) cell.list.push(...pts); else prod.contours.push({ level: pc === 9 ? r.i16(body) : null, points: pts });
        break;
      }
      case 7: case 10:
        for (let q = body + (pc === 10 ? 2 : 0); q + 8 <= next; q += 8) prod.contours.push({ level: null, points: [pt(r.i16(q), r.i16(q + 2)), pt(r.i16(q + 4), r.i16(q + 6))] });
        break;
      case 12: case 26:
        for (let q = body; q + 4 <= next; q += 4) (pc === 12 ? prod.tvs : prod.etvs).push(pt(r.i16(q), r.i16(q + 2)));
        break;
      case 15:
        for (let q = body; q + 6 <= next; q += 6) prod.cells.push({ id: r.str(q + 4, 2), ...pt(r.i16(q), r.i16(q + 2)), past: [], forecast: [] });
        break;
      case 19:
        for (let q = body; q + 10 <= next; q += 10) prod.hail.push({ ...pt(r.i16(q), r.i16(q + 2)), poh: r.i16(q + 4), posh: r.i16(q + 6), maxSizeIn: r.i16(q + 8) });
        break;
      case 20:
        for (let q = body; q + 8 <= next; q += 8) prod.features.push({ ...pt(r.i16(q), r.i16(q + 2)), type: r.i16(q + 4), attr: r.i16(q + 6) });
        break;
      case 23: case 24: {
        const target = prod.cells[prod.cells.length - 1];
        const acc = { list: [] as L3Point[] };
        parsePackets(r, body, next, prod, sym, acc);
        if (target) (pc === 23 ? target.past : target.forecast).push(...acc.list);
        break;
      }
      case 25:
        if (!cell) prod.circles.push({ ...pt(r.i16(body), r.i16(body + 2)), r: r.i16(body + 4) / 4 });
        break;
      default:
        break; // unsupported packet types (e.g. 28/29 generic XDR) are skipped by length
    }
    o = next;
  }
}

function parseGraphicBlock(r: Reader, off: number, prod: L3Product) {
  const nPages = r.i16(off + 8);
  let o = off + 10;
  for (let pg = 0; pg < nPages && o + 4 <= r.b.length; pg++) {
    const len = r.i16(o + 2);
    const before = prod.texts.length;
    parsePackets(r, o + 4, o + 4 + len, prod, false);
    // Graphic alphanumeric text is page text, not map labels.
    const texts = prod.texts.splice(before);
    prod.pages.push(texts.map((t) => t.text));
    o += 4 + len;
  }
}

function parseTabular(r: Reader, off: number, prod: L3Product) {
  let o = off;
  if (r.i16(o) === -1 && r.i16(o + 2) === 3) o += 8 + 120; // block header + repeated message/PDB headers
  if (r.i16(o) !== -1) return;
  const nPages = r.i16(o + 2);
  o += 4;
  for (let pg = 0; pg < nPages && o + 2 <= r.b.length; pg++) {
    const lines: string[] = [];
    while (o + 2 <= r.b.length) {
      const n = r.i16(o);
      o += 2;
      if (n === -1) break;
      lines.push(r.str(o, n));
      o += n;
    }
    prod.pages.push(lines);
  }
}

export function l3Value(p: L3Product, code: number): number { return p.lut[code]; }
