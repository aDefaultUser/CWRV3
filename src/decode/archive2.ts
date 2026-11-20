// NEXRAD Archive II decoder (ROC ICD 2620010 file format; ICD 2620002 message 31 / message 5 layouts). Volumes from
// before message 31 (until about 2008) hold message 1 radials; that layout follows ICD 2620002 as read by Py-ART
// (pyart/io/nexrad_level2.py, MSG_1) and MetPy (metpy/io/nexrad.py, Level2File.msg1_fmt).
import { bunzip2 } from './bzip2';
import { RADAR_SITES } from '../generated/radar-sites';

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
  nominalElevation: number | null; // from VCP when available (inferred for message 1 volumes without one)
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

/**
 * Cuts (angle/waveform) of the VCPs flown before message 5 was archived, as the message 5 records of 2007–08 volumes
 * give them.
 */
const LEGACY_VCPS: Record<number, string> = {
  11: '0.4834/1 0.4834/2 1.4502/1 1.4502/2 2.4170/4 3.3838/4 4.3066/4 5.3174/4 6.1963/4 7.5146/3 8.7012/3 10.0195/3 11.9971/3 14.0186/3 16.6992/3 19.5117/3',
  12: '0.4834/1 0.4834/2 0.8789/1 0.8789/2 1.3184/1 1.3184/2 1.8018/4 2.4170/4 3.1201/4 3.9990/4 5.0977/4 6.4160/4 7.9980/3 10.0195/3 12.4805/3 15.6006/3 19.5117/3',
  21: '0.4834/1 0.4834/2 1.4502/1 1.4502/2 2.4170/4 3.3838/4 4.3066/4 6.0205/4 9.8877/3 14.5898/3 19.5117/3',
  32: '0.4834/1 0.4834/2 1.4941/1 1.4941/2 2.5049/4 3.5156/4 4.4824/4',
  121: '0.4834/1 0.4834/2 0.4834/2 0.4834/2 1.4502/1 1.4502/2 1.4502/2 1.4502/2 2.4170/4 2.4170/3 2.4170/3 3.3838/4 3.3838/3 3.3838/3 4.3066/4 4.3066/3 6.0205/4 9.8877/3 14.5898/3 19.5117/3',
};

interface RadialAcc {
  azimuths: number[]; elevations: number[]; times: number[];
  azSpacing: number; nyquist: number | null; unambKm: number | null;
  moments: Map<MomentName, { gates: number; first: number; spacing: number; scale: number; offset: number; word: 8 | 16; rows: (Uint8Array | Uint16Array | null)[] }>;
  complete: boolean;
  /** Azimuth turned since the first radial (message 1 sweeps, which overrun one revolution). */
  turned: number;
  /** The sweep built from these radials; cleared when a radial (or the VCP) arrives. */
  built: L2Sweep | null;
}

export class Archive2Decoder {
  site = '';
  volumeTimeMs: number | null = null;
  lat: number | null = null;
  lon: number | null = null;
  heightM: number | null = null;
  vcpNumber: number | null = null;
  vcp: VcpInfo | null = null;
  /** Message 1 radials seen: the volume has no site metadata and may have no VCP record. */
  private legacy = false;
  private sweeps = new Map<number, RadialAcc>();

  /** `requestedSite`: the radar the file was requested for, used when the header leaves the site blank (ARCHIVE2). */
  constructor(private requestedSite = '') {}

  /** Feeds a whole Archive II file (optionally whole-file bzip2) or a chunk (S chunks carry the 24-byte volume header). */
  feed(buf: Uint8Array): void {
    // tgftp serves whole volumes compressed with bzip2 when the name ends in .bz2 but the content is still an AR2V
    // file with bzip2 records; a fully compressed file starts with "BZh".
    if (buf[0] === 0x42 && buf[1] === 0x5a && buf[2] === 0x68) buf = bunzip2(buf);
    let p = 0;
    const head = String.fromCharCode(...buf.subarray(0, 8));
    if (buf.length >= 24 && (head.startsWith('AR2V') || head === 'ARCHIVE2')) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.volumeTimeMs = dateMs(dv.getUint32(12), dv.getUint32(16));
      this.site = String.fromCharCode(...buf.subarray(20, 24)).replace(/[^A-Z0-9]/g, '');
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
      if (type === 1 && sizeHw > 50 && p + 28 + 100 <= d.length) this.msg1(new DataView(d.buffer, d.byteOffset + p + 28, Math.min(sizeHw * 2 - 16, 2404, d.length - p - 28)));
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
    for (const a of this.sweeps.values()) a.built = null; // cut and nominal elevation come from the VCP
  }

  /**
   * Message 1 ("digital radar data"): one 1° radial with reflectivity (1 km gates) and/or velocity and spectrum width
   * (250 m gates) at 0.5 dB / 0.5 or 1 m/s steps; split cuts are a reflectivity-only and a Doppler-only elevation.
   */
  private msg1(v: DataView) {
    const u16 = (o: number) => v.getUint16(o), angle = (o: number) => (u16(o) * 180) / 32768;
    const az = angle(8), el = ((angle(14) + 180) % 360) - 180, elNum = u16(16), status = u16(12) & 0xf;
    if (!(el >= -10 && el <= 90) || !(az < 360) || elNum < 1 || elNum > 32) return;
    this.legacy = true;
    const vcp = u16(44);
    if (this.vcpNumber === null && vcp >= 1 && vcp <= 999) this.vcpNumber = vcp;
    let acc = this.sweeps.get(elNum);
    if (!acc) {
      acc = { azimuths: [], elevations: [], times: [], azSpacing: 1, nyquist: null, unambKm: null, moments: new Map(), complete: false, turned: 0, built: null };
      this.sweeps.set(elNum, acc);
    }
    acc.built = null;
    if (status === 2 || status === 4) acc.complete = true;
    // Legacy sweeps run a few radials past one revolution; the overlap repeats the first azimuths and is dropped, so
    // a sweep is one turn like a message 31 sweep.
    const n = acc.azimuths.length;
    if (n) {
      const step = (((az - acc.azimuths[n - 1]) % 360) + 540) % 360 - 180;
      if (acc.turned + step >= 359.5) return;
      acc.turned += step;
    }
    acc.azimuths.push(az); acc.elevations.push(el); acc.times.push(dateMs(u16(4), v.getUint32(0)));
    const doppler = u16(28) > 0;
    if (doppler) {
      const nyq = v.getInt16(60) / 100;
      if (nyq > 0) acc.nyquist = nyq;
    }
    if (u16(6)) acc.unambKm = v.getInt16(6) / 10;
    const add = (name: MomentName, ptr: number, gates: number, firstM: number, spacingM: number, scale: number, offset: number) => {
      // Legacy RDA Doppler ranges start before the antenna (first gate at -375 m): gates centred behind it are skipped.
      const skip = firstM < 0 ? Math.ceil(-firstM / spacingM) : 0;
      if (!ptr || gates <= skip || !spacingM || ptr + gates > v.byteLength) return;
      let m = acc.moments.get(name);
      if (!m) { m = { gates: 0, first: firstM + skip * spacingM, spacing: spacingM, scale, offset, word: 8, rows: [] }; acc.moments.set(name, m); }
      m.gates = Math.max(m.gates, gates - skip);
      m.rows[n] = new Uint8Array(v.buffer, v.byteOffset + ptr + skip, gates - skip).slice();
    };
    add('REF', u16(36), u16(26), v.getInt16(18), u16(22), 2, 66);
    if (doppler) {
      const first = v.getInt16(20), spacing = u16(24);
      add('VEL', u16(38), u16(28), first, spacing, u16(42) === 4 ? 1 : 2, 129);
      add('SW', u16(40), u16(28), first, spacing, 2, 129);
    }
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
      acc = { azimuths: [], elevations: [], times: [], azSpacing: azSpacingCode === 1 ? 0.5 : 1, nyquist: null, unambKm: null, moments: new Map(), complete: false, turned: 0, built: null };
      this.sweeps.set(elNum, acc);
    }
    acc.built = null;
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

  /**
   * Builds the volume from everything fed so far (callable repeatedly for live chunks). A sweep that received no
   * radial since the last call is the same object as before, so callers can keep what they derived from it.
   */
  volume(): L2Volume {
    const nums = [...this.sweeps.keys()].sort((a, b) => a - b);
    const sweeps = nums.map((n) => { const a = this.sweeps.get(n)!; return (a.built ??= this.buildSweep(n, a)); });
    return assembleVolume(this, this.requestedSite, sweeps);
  }

  /** Nothing to free (the WebAssembly decoder's counterpart). */
  dispose(): void {}

  /**
   * The cut of a message 1 sweep when the volume has no VCP record (archived only from about 2005): the cut of the
   * VCP's definition when the sweep's angle and moments agree with it, otherwise inferred from the moments (a
   * reflectivity-only sweep is the surveillance half of a split cut, a Doppler-only sweep right after one its Doppler
   * half at the same angle, anything else a batch cut at its most frequent measured angle).
   */
  private legacyCut(n: number, a: RadialAcc): VcpCut {
    const angle = (x: RadialAcc) => {
      const count = new Map<number, number>();
      for (const e of x.elevations) count.set(e, (count.get(e) ?? 0) + 1);
      return [...count].reduce((best, c) => (c[1] > best[1] ? c : best), [0, 0])[0];
    };
    // As waveforms: 1 surveillance only, 2 Doppler only (halves of a split cut), 3 both (batch, contiguous Doppler).
    const kind = (x: RadialAcc | undefined) => (!x ? 0 : x.moments.has('VEL') ? (x.moments.has('REF') ? 3 : 2) : 1);
    const def = LEGACY_VCPS[this.vcpNumber ?? 0]?.split(' ')[n - 1]?.split('/').map(Number);
    if (def && Math.abs(angle(a) - def[0]) < 0.25 && kind(a) === Math.min(def[1], 3)) return plainCut(def[0], def[1]);
    const prev = this.sweeps.get(n - 1);
    const pair = kind(a) === 2 && kind(prev) === 1 && Math.abs(angle(a) - angle(prev!)) < 0.5;
    return plainCut(Math.round(angle(pair ? prev! : a) * 100) / 100, pair ? 2 : kind(a) === 1 ? 1 : 4);
  }

  private buildSweep(n: number, a: RadialAcc): L2Sweep {
    const radials = a.azimuths.length;
    const moments: Partial<Record<MomentName, L2Moment>> = {};
    for (const [name, m] of a.moments) {
      const raw = m.word === 16 ? new Uint16Array(radials * m.gates) : new Uint8Array(radials * m.gates);
      for (let r = 0; r < radials; r++) { const row = m.rows[r]; if (row) raw.set(row, r * m.gates); }
      moments[name] = { name, gates: m.gates, firstGateM: m.first, gateSpacingM: m.spacing, scale: m.scale, offset: m.offset, wordSize: m.word, raw };
    }
    const cut = this.vcp?.cuts[n - 1] ?? (this.legacy && !this.vcp ? this.legacyCut(n, a) : null);
    const elevations = Float32Array.from(a.elevations);
    return {
      elevationNumber: n, elevation: elevations.reduce((s, x) => s + x, 0) / Math.max(1, radials), nominalElevation: cut?.elevation ?? null,
      cut, azimuthSpacing: a.azSpacing, nyquist: a.nyquist, unambiguousRangeKm: a.unambKm, radialCount: radials,
      azimuths: Float32Array.from(a.azimuths), elevations, timesMs: Float64Array.from(a.times), moments, complete: a.complete,
    };
  }
}

/** A cut without supplemental-scan flags (message 1 volumes). */
export const plainCut = (elevation: number, waveform: number): VcpCut => ({ elevation, waveform, superRes: 0, sails: false, sailsSeq: 0, mrle: false, mrleSeq: 0, mpda: false, baseTilt: false });

/** The volume of decoded header fields and sweeps. */
export function assembleVolume(h: Pick<L2Volume, 'site' | 'volumeTimeMs' | 'lat' | 'lon' | 'heightM' | 'vcpNumber' | 'vcp'>, requestedSite: string, sweeps: L2Sweep[]): L2Volume {
  const site = h.site || requestedSite;
  // Message 1 volumes carry no site location: the radar site table supplies it (ground elevation for the height).
  const known = h.lat === null ? RADAR_SITES.find((s) => s.id === site) : undefined;
  return {
    site, volumeTimeMs: h.volumeTimeMs, lat: h.lat ?? known?.lat ?? null, lon: h.lon ?? known?.lon ?? null,
    heightM: h.heightM ?? (known ? Math.round(known.elevFt * 0.3048) : null), vcpNumber: h.vcpNumber ?? h.vcp?.pattern ?? null, vcp: h.vcp, sweeps,
  };
}

export function decodeArchive2(buf: Uint8Array, requestedSite = ''): L2Volume {
  const d = new Archive2Decoder(requestedSite);
  d.feed(buf);
  return d.volume();
}

/** Physical value of a raw code, or NaN for below-threshold / range-folded. */
export function momentValue(m: L2Moment, raw: number): number {
  return raw <= 1 ? NaN : (raw - m.offset) / m.scale;
}
