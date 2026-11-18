// NEXRAD Archive II decoder (ROC ICD 2620010 file format; ICD 2620002 message 31 / message 5 layouts).
import { bunzip2 } from './bzip2';

export const MOMENT_NAMES = ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', 'CFP'] as const;
export type MomentName = (typeof MOMENT_NAMES)[number];

export interface L2Moment {
  name: MomentName;
  gates: number;
  firstGateM: number;
  gateSpacingM: number;
  scale: number;
  offset: number;
  wordSize: 8 | 16;
  /** Raw codes, radial-major [radial * gates + gate]; 0 = below threshold, 1 = range folded. */
  raw: Uint8Array | Uint16Array;
}

export interface VcpCut {
  elevation: number;
  waveform: number; // 1 CS, 2 CD w/ amb. res., 3 CD w/o, 4 batch, 5 staggered PRT
  superRes: number;
  sails: boolean; sailsSeq: number;
  mrle: boolean; mrleSeq: number;
  mpda: boolean; baseTilt: boolean;
}

export interface VcpInfo {
  pattern: number;
  sails: boolean; sailsCuts: number;
  mrle: boolean; mrleCuts: number;
  mpda: boolean; baseTilt: boolean; baseTilts: number;
  avset: boolean | null;
  cuts: VcpCut[];
}

export interface L2Sweep {
  /** RDA elevation number (1-based); split cuts and SAILS/MRLE rescans are separate sweeps. */
  elevationNumber: number;
  elevation: number; // mean measured elevation, deg
  nominalElevation: number | null; // from VCP when available
  cut: VcpCut | null;
  azimuthSpacing: number; // deg
  nyquist: number | null; // m/s
  unambiguousRangeKm: number | null;
  radialCount: number;
  azimuths: Float32Array;
  elevations: Float32Array;
  timesMs: Float64Array; // epoch ms
  moments: Partial<Record<MomentName, L2Moment>>;
  complete: boolean;
}

export interface L2Volume {
  site: string;
  volumeTimeMs: number | null;
  lat: number | null;
  lon: number | null;
  heightM: number | null;
  vcpNumber: number | null;
  vcp: VcpInfo | null;
  sweeps: L2Sweep[];
}

const dateMs = (mjd: number, ms: number) => (mjd - 1) * 86400000 + ms;

interface RadialAcc {
  azimuths: number[]; elevations: number[]; times: number[];
  azSpacing: number; nyquist: number | null; unambKm: number | null;
  moments: Map<MomentName, { gates: number; first: number; spacing: number; scale: number; offset: number; word: 8 | 16; rows: (Uint8Array | Uint16Array | null)[] }>;
  complete: boolean;
}

export class Archive2Decoder {
  site = '';
  volumeTimeMs: number | null = null;
  lat: number | null = null;
  lon: number | null = null;
  heightM: number | null = null;
  vcpNumber: number | null = null;
  vcp: VcpInfo | null = null;
  private sweeps = new Map<number, RadialAcc>();

  /** Feeds a whole Archive II file or a chunk (S chunks carry the 24-byte volume header). */
  feed(buf: Uint8Array): void {
    let p = 0;
    if (buf.length >= 24 && buf[0] === 0x41 && buf[1] === 0x52 && buf[2] === 0x32 && buf[3] === 0x56) { // "AR2V"
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.volumeTimeMs = dateMs(dv.getUint32(12), dv.getUint32(16));
      this.site = String.fromCharCode(...buf.subarray(20, 24)).trim();
      p = 24;
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Archive volumes before mid-2016 have no compressed records: the messages follow the volume header directly
    // (a zero where the first record length would be).
    if (p === 24 && buf.length > 28 && dv.getInt32(24) === 0) { this.parseMessages(buf.subarray(24)); return; }
    while (p + 4 <= buf.length) {
      const size = Math.abs(dv.getInt32(p));
      p += 4;
      if (size === 0 || p + size > buf.length) break;
      const rec = buf.subarray(p, p + size);
      p += size;
      const data = rec[0] === 0x42 && rec[1] === 0x5a && rec[2] === 0x68 ? bunzip2(rec) : rec;
      this.parseMessages(data);
    }
  }

  private parseMessages(d: Uint8Array) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let p = 0;
    while (p + 28 <= d.length) {
      const sizeHw = dv.getUint16(p + 12);
      const type = d[p + 15];
      if (type === 31 && sizeHw > 8) {
        const len = sizeHw * 2 - 16;
        if (p + 28 + len > d.length) break;
        this.msg31(new DataView(d.buffer, d.byteOffset + p + 28, len));
        p += 12 + sizeHw * 2;
        continue;
      }
      if (type === 5 && sizeHw > 0 && p + 28 + 22 <= d.length) this.msg5(new DataView(d.buffer, d.byteOffset + p + 28, Math.min(d.length - p - 28, 2404)));
      p += 2432;
    }
  }

  private msg5(v: DataView) {
    if (this.vcp) return; // the metadata record carries the volume's VCP; keep the first valid one
    const angle = (raw: number) => ((raw & 0xfff8) * 180) / 32768;
    const pattern = v.getUint16(4);
    const nCuts = v.getUint16(6);
    if (nCuts < 1 || nCuts > 32 || pattern < 1 || pattern > 999 || v.getUint16(2) > 7) return;
    const supp = v.getUint16(18);
    const cuts: VcpCut[] = [];
    for (let i = 0; i < nCuts && 22 + (i + 1) * 46 <= v.byteLength; i++) {
      const o = 22 + i * 46;
      const s = v.getUint16(o + 28);
      cuts.push({
        elevation: angle(v.getUint16(o)), waveform: v.getUint8(o + 3), superRes: v.getUint8(o + 4),
        sails: !!(s & 1), sailsSeq: (s >> 1) & 7, mrle: !!(s & 16), mrleSeq: (s >> 5) & 7,
        mpda: !!(s & 0x200), baseTilt: !!(s & 0x400),
      });
    }
    if (cuts.length !== nCuts || cuts.some((c) => c.elevation < -1 || c.elevation > 45)) return;
    this.vcp = {
      pattern, sails: !!(supp & 1), sailsCuts: (supp >> 1) & 7, mrle: !!(supp & 16), mrleCuts: (supp >> 5) & 7,
      mpda: !!(supp & 0x800), baseTilt: !!(supp & 0x1000), baseTilts: (supp >> 13) & 7, avset: null, cuts,
    };
  }

  private msg31(v: DataView) {
    const site = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
    if (!this.site) this.site = site.trim();
    const timeMs = dateMs(v.getUint16(8), v.getUint32(4));
    const az = v.getFloat32(12);
    const azSpacingCode = v.getUint8(20);
    const status = v.getUint8(21);
    const elNum = v.getUint8(22);
    const el = v.getFloat32(24);
    const nBlocks = v.getUint16(30);
    // A corrupt radial header (seen in real-time chunk streams) must not create a bogus tilt.
    if (!(el >= -10 && el <= 90) || !(az >= 0 && az <= 360) || elNum < 1 || elNum > 32) return;
    let acc = this.sweeps.get(elNum);
    if (!acc) {
      acc = { azimuths: [], elevations: [], times: [], azSpacing: azSpacingCode === 1 ? 0.5 : 1, nyquist: null, unambKm: null, moments: new Map(), complete: false };
      this.sweeps.set(elNum, acc);
    }
    const r = acc.azimuths.length;
    acc.azimuths.push(az); acc.elevations.push(el); acc.times.push(timeMs);
    if (status === 2 || status === 4) acc.complete = true;
    for (let b = 0; b < nBlocks && b < 10; b++) {
      const ptr = v.getUint32(32 + b * 4);
      if (!ptr || ptr + 4 > v.byteLength) continue;
      const kind = String.fromCharCode(v.getUint8(ptr));
      const name = String.fromCharCode(v.getUint8(ptr + 1), v.getUint8(ptr + 2), v.getUint8(ptr + 3)).trim();
      if (kind === 'R') {
        if (name === 'VOL') {
          this.lat = v.getFloat32(ptr + 8); this.lon = v.getFloat32(ptr + 12);
          this.heightM = v.getInt16(ptr + 16) + v.getUint16(ptr + 18);
          this.vcpNumber = v.getUint16(ptr + 40);
        } else if (name === 'RAD') {
          acc.unambKm = v.getInt16(ptr + 6) / 10;
          acc.nyquist = v.getInt16(ptr + 16) / 100;
        }
        continue;
      }
      if (kind !== 'D' || !(MOMENT_NAMES as readonly string[]).includes(name)) continue;
      const gates = v.getUint16(ptr + 8);
      const word = v.getUint8(ptr + 19) as 8 | 16;
      const dataStart = ptr + 28;
      if (dataStart + gates * (word / 8) > v.byteLength) continue;
      const mname = name as MomentName;
      let m = acc.moments.get(mname);
      if (!m) {
        m = { gates, first: v.getInt16(ptr + 10), spacing: v.getInt16(ptr + 12), scale: v.getFloat32(ptr + 20), offset: v.getFloat32(ptr + 24), word, rows: [] };
        acc.moments.set(mname, m);
      }
      let row: Uint8Array | Uint16Array;
      if (word === 16) {
        row = new Uint16Array(gates);
        for (let g = 0; g < gates; g++) row[g] = v.getUint16(dataStart + g * 2);
      } else {
        row = new Uint8Array(v.buffer, v.byteOffset + dataStart, gates).slice();
      }
      m.gates = Math.max(m.gates, gates);
      m.rows[r] = row;
    }
  }

  /** Builds the volume from everything fed so far (callable repeatedly for live chunks). */
  volume(): L2Volume {
    const nums = [...this.sweeps.keys()].sort((a, b) => a - b);
    const sweeps: L2Sweep[] = nums.map((n) => {
      const a = this.sweeps.get(n)!;
      const radials = a.azimuths.length;
      const moments: Partial<Record<MomentName, L2Moment>> = {};
      for (const [name, m] of a.moments) {
        const raw = m.word === 16 ? new Uint16Array(radials * m.gates) : new Uint8Array(radials * m.gates);
        for (let r = 0; r < radials; r++) { const row = m.rows[r]; if (row) raw.set(row, r * m.gates); }
        moments[name] = { name, gates: m.gates, firstGateM: m.first, gateSpacingM: m.spacing, scale: m.scale, offset: m.offset, wordSize: m.word, raw };
      }
      const cut = this.vcp?.cuts[n - 1] ?? null;
      const elevations = Float32Array.from(a.elevations);
      return {
        elevationNumber: n, elevation: elevations.reduce((s, x) => s + x, 0) / Math.max(1, radials), nominalElevation: cut?.elevation ?? null,
        cut, azimuthSpacing: a.azSpacing, nyquist: a.nyquist, unambiguousRangeKm: a.unambKm, radialCount: radials,
        azimuths: Float32Array.from(a.azimuths), elevations, timesMs: Float64Array.from(a.times), moments, complete: a.complete,
      };
    });
    return { site: this.site, volumeTimeMs: this.volumeTimeMs, lat: this.lat, lon: this.lon, heightM: this.heightM, vcpNumber: this.vcpNumber ?? this.vcp?.pattern ?? null, vcp: this.vcp, sweeps };
  }
}

export function decodeArchive2(buf: Uint8Array): L2Volume {
  const d = new Archive2Decoder();
  d.feed(buf);
  return d.volume();
}

/** Physical value of a raw code, or NaN for below-threshold / range-folded. */
export function momentValue(m: L2Moment, raw: number): number {
  return raw <= 1 ? NaN : (raw - m.offset) / m.scale;
}
