// Synthetic Archive II writer for tests: a volume header, a metadata record carrying the VCP (message 5) and
// uncompressed message 31 records, with the fields at the offsets the decoder reads (ICD 2620002 / 2620010). Records
// are not bzip2-compressed, which the file format allows and the decoder accepts. writeLegacyArchive2 writes the
// message 1 volumes of the years before message 31.
export interface SynthMoment {
  name: 'REF' | 'VEL' | 'SW' | 'ZDR' | 'PHI' | 'RHO';
  gates: number; firstM?: number; spacingM?: number; scale: number; offset: number; word?: 8 | 16;
  /** Raw code of a gate (0 = below threshold, 1 = range folded). */
  code: (radial: number, gate: number) => number;
}
export interface SynthCut {
  /** Nominal angle written to the VCP; radials carry `measured` (default: the same). */
  elevation: number; measured?: number;
  /** 1 surveillance, 2 Doppler half of a split cut, 4 batch (default). */
  waveform?: 1 | 2 | 3 | 4 | 5;
  /** SAILS / MRLE sequence number of a supplemental rescan. */
  sails?: number; mrle?: number;
  /** Half-degree radials (default 1°); `radials` of them starting at `az0`. */
  half?: boolean; radials: number; az0?: number;
  nyquist?: number;
  moments: SynthMoment[];
}
export interface SynthVolume { site: string; timeMs: number; lat: number; lon: number; heightM: number; vcp: number; cuts: SynthCut[] }

const MS_DAY = 86400000;
const ascii = (b: Uint8Array, o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
export const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
/** A record: its length as a signed 32-bit control word, then the messages. */
const record = (messages: Uint8Array[]) => { const body = concat(messages), out = new Uint8Array(4 + body.length); new DataView(out.buffer).setInt32(0, body.length); out.set(body, 4); return out; };

/** Message framing: 12 bytes of CTM header, the 16-byte message header, then the payload. */
function message(type: number, payload: Uint8Array, frame = 12 + 16 + payload.length): Uint8Array {
  const out = new Uint8Array(frame), dv = new DataView(out.buffer);
  dv.setUint16(12, (16 + payload.length) / 2); out[15] = type;
  out.set(payload, 28);
  return out;
}

function vcpMessage(v: SynthVolume): Uint8Array {
  const p = new Uint8Array(22 + v.cuts.length * 46), dv = new DataView(p.buffer);
  dv.setUint16(0, p.length / 2); dv.setUint16(2, 2); dv.setUint16(4, v.vcp); dv.setUint16(6, v.cuts.length);
  const sails = Math.max(0, ...v.cuts.map((c) => c.sails ?? 0)), mrle = Math.max(0, ...v.cuts.map((c) => c.mrle ?? 0));
  dv.setUint16(18, (sails ? 1 | (sails << 1) : 0) | (mrle ? 16 | (mrle << 5) : 0));
  v.cuts.forEach((c, i) => {
    const o = 22 + i * 46;
    dv.setUint16(o, Math.round((c.elevation * 32768) / 180 / 8) * 8);
    p[o + 3] = c.waveform ?? 4; p[o + 4] = c.half ? 1 : 0;
    dv.setUint16(o + 28, (c.sails ? 1 | (c.sails << 1) : 0) | (c.mrle ? 16 | (c.mrle << 5) : 0));
  });
  return message(5, p, 2432);
}

function radialMessage(v: SynthVolume, cut: SynthCut, elNum: number, r: number, status: number, timeMs: number): Uint8Array {
  const blocks: Uint8Array[] = [];
  const vol = new Uint8Array(44), vd = new DataView(vol.buffer);
  ascii(vol, 0, 'RVOL'); vd.setUint16(4, 44); vd.setFloat32(8, v.lat); vd.setFloat32(12, v.lon); vd.setInt16(16, v.heightM); vd.setUint16(40, v.vcp);
  const elv = new Uint8Array(12); ascii(elv, 0, 'RELV'); new DataView(elv.buffer).setUint16(4, 12);
  const rad = new Uint8Array(28), rd = new DataView(rad.buffer);
  ascii(rad, 0, 'RRAD'); rd.setUint16(4, 28); rd.setInt16(6, 4600); rd.setInt16(16, Math.round((cut.nyquist ?? 26) * 100));
  blocks.push(vol, elv, rad);
  for (const m of cut.moments) {
    const word = m.word ?? 8, b = new Uint8Array(28 + ((m.gates * (word / 8) + 1) & ~1)), d = new DataView(b.buffer);
    ascii(b, 0, 'D' + m.name.padEnd(3));
    d.setUint16(8, m.gates); d.setInt16(10, m.firstM ?? 2125); d.setInt16(12, m.spacingM ?? 250); b[19] = word;
    d.setFloat32(20, m.scale); d.setFloat32(24, m.offset);
    for (let g = 0; g < m.gates; g++) { if (word === 16) d.setUint16(28 + g * 2, m.code(r, g)); else b[28 + g] = m.code(r, g); }
    blocks.push(b);
  }
  const head = 32 + blocks.length * 4, p = new Uint8Array(head + blocks.reduce((n, b) => n + b.length, 0)), dv = new DataView(p.buffer);
  ascii(p, 0, v.site.padEnd(4));
  dv.setUint32(4, timeMs % MS_DAY); dv.setUint16(8, Math.floor(timeMs / MS_DAY) + 1); dv.setUint16(10, r + 1);
  dv.setFloat32(12, ((cut.az0 ?? (cut.half ? 0.25 : 0.5)) + r * (cut.half ? 0.5 : 1)) % 360);
  p[20] = cut.half ? 1 : 2; p[21] = status; p[22] = elNum;
  dv.setFloat32(24, cut.measured ?? cut.elevation); dv.setUint16(30, blocks.length);
  let o = head;
  blocks.forEach((b, i) => { dv.setUint32(32 + i * 4, o); p.set(b, o); o += b.length; });
  return message(31, p);
}

/**
 * The volume as real-time style chunks: [0] is the volume header plus the metadata record, then each cut follows as
 * `split` records of radials. Concatenated, the chunks are the Archive II file.
 */
export function writeArchive2(v: SynthVolume, split = 2): Uint8Array[] {
  const header = new Uint8Array(24), hd = new DataView(header.buffer);
  ascii(header, 0, 'AR2V0006.001'); hd.setUint32(12, Math.floor(v.timeMs / MS_DAY) + 1); hd.setUint32(16, v.timeMs % MS_DAY); ascii(header, 20, v.site.padEnd(4));
  const chunks = [concat([header, record([vcpMessage(v)])])];
  v.cuts.forEach((cut, ci) => {
    const messages = Array.from({ length: cut.radials }, (_, r) => {
      const first = r === 0, last = r === cut.radials - 1;
      const status = first ? (ci === 0 ? 3 : 0) : last ? (ci === v.cuts.length - 1 ? 4 : 2) : 1;
      return radialMessage(v, cut, ci + 1, r, status, v.timeMs + ci * 20000 + r * 20);
    });
    const per = Math.ceil(messages.length / split);
    for (let i = 0; i < messages.length; i += per) chunks.push(record(messages.slice(i, i + per)));
  });
  return chunks;
}

const pattern = (seed: number) => (r: number, g: number) => ((r * 7 + g * 13 + seed) % 23 === 0 ? (r + g) % 2 : 2 + ((r * 5 + g * 3 + seed) % 250));
const moments = (seed: number, names: SynthMoment['name'][], gates: number): SynthMoment[] => names.map((name, i) => ({
  name, gates: name === 'REF' ? gates + 8 : gates, word: name === 'PHI' ? 16 : 8,
  scale: { REF: 2, VEL: 2, SW: 2, ZDR: 16, PHI: 2.8361, RHO: 300 }[name], offset: { REF: 66, VEL: 129, SW: 129, ZDR: 128, PHI: 2, RHO: -60.5 }[name],
  code: name === 'PHI' ? (r, g) => 2 + ((r * 3 + g * 40 + seed) % 1000) : pattern(seed + i * 17),
}));

/**
 * A small volume with the cut kinds the tilt logic has to tell apart: a 0.5° split cut (surveillance + Doppler,
 * half-degree radials), 1.5°, a SAILS rescan of the split cut, then 2.5°, 4.0° and 8.0° batch cuts at 1°.
 */
export function splitSailsVolume(gates = 40): SynthVolume {
  const pol: SynthMoment['name'][] = ['REF', 'ZDR', 'PHI', 'RHO'], dop: SynthMoment['name'][] = ['REF', 'VEL', 'SW'], all: SynthMoment['name'][] = ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO'];
  return {
    site: 'KTST', timeMs: Date.UTC(2026, 4, 6, 22, 3, 20), lat: 35.33, lon: -97.28, heightM: 384, vcp: 212,
    cuts: [
      { elevation: 0.5, measured: 0.53, waveform: 1, half: true, radials: 720, moments: moments(1, pol, gates) },
      { elevation: 0.5, measured: 0.48, waveform: 2, half: true, radials: 720, az0: 0.3, moments: moments(2, dop, gates) },
      { elevation: 1.5, radials: 360, az0: 0.6, moments: moments(3, all, gates) },
      { elevation: 0.5, measured: 0.52, waveform: 1, sails: 1, half: true, radials: 720, az0: 0.2, moments: moments(4, pol, gates) },
      { elevation: 0.5, measured: 0.49, waveform: 2, sails: 1, half: true, radials: 720, moments: moments(5, dop, gates) },
      { elevation: 2.5, radials: 360, moments: moments(6, all, gates) },
      { elevation: 4.0, radials: 360, az0: 0.4, moments: moments(7, all, gates - 6) },
      { elevation: 8.0, radials: 360, moments: moments(8, all, gates - 12) },
    ],
  };
}

/**
 * A message 1 cut (the format before message 31): reflectivity at 1 km gates and/or velocity and spectrum width at
 * 250 m gates, one radial per fixed 2432-byte frame (ICD 2620002 message 1, as Py-ART and MetPy read it).
 */
export interface SynthLegacyCut {
  elevation: number; radials: number; az0?: number;
  /** Azimuth step per radial; legacy sweeps are not exactly 1° and overrun one turn (default 0.985). */
  step?: number;
  ref?: { gates: number; firstM?: number };
  /** `res` 2 = 0.5 m/s velocity steps, 4 = 1 m/s. */
  doppler?: { gates: number; firstM?: number; nyquist: number; res?: 2 | 4 };
  /** Raw code of a gate of moment 0 (REF), 1 (VEL) or 2 (SW). */
  code: (moment: number, radial: number, gate: number) => number;
}
export interface SynthLegacyVolume { header: 'ARCHIVE2.' | 'AR2V0001.'; site: string; timeMs: number; vcp: number; cuts: SynthLegacyCut[] }

const angleCode = (deg: number) => Math.round((deg * 32768) / 180 / 8) * 8;

function legacyRadial(v: SynthLegacyVolume, cut: SynthLegacyCut, elNum: number, r: number, status: number, timeMs: number): Uint8Array {
  const p = new Uint8Array(2400), dv = new DataView(p.buffer);
  const ref = cut.ref, dop = cut.doppler;
  dv.setUint32(0, timeMs % MS_DAY); dv.setUint16(4, Math.floor(timeMs / MS_DAY) + 1);
  dv.setInt16(6, dop ? 1480 : 4660); dv.setUint16(8, angleCode(((cut.az0 ?? 0.5) + r * (cut.step ?? 0.985)) % 360)); dv.setUint16(10, r + 1);
  dv.setUint16(12, status); dv.setUint16(14, angleCode(cut.elevation)); dv.setUint16(16, elNum);
  dv.setInt16(18, ref?.firstM ?? 0); dv.setInt16(20, dop?.firstM ?? -375); dv.setUint16(22, 1000); dv.setUint16(24, 250);
  dv.setUint16(26, ref?.gates ?? 0); dv.setUint16(28, dop?.gates ?? 0);
  const refPtr = 100, velPtr = 100 + (ref?.gates ?? 0), swPtr = velPtr + (dop?.gates ?? 0);
  if (ref) dv.setUint16(36, refPtr);
  if (dop) { dv.setUint16(38, velPtr); dv.setUint16(40, swPtr); dv.setUint16(42, dop.res ?? 2); dv.setInt16(60, Math.round(dop.nyquist * 100)); }
  dv.setUint16(44, v.vcp);
  for (let g = 0; g < (ref?.gates ?? 0); g++) p[refPtr + g] = cut.code(0, r, g);
  for (let g = 0; g < (dop?.gates ?? 0); g++) { p[velPtr + g] = cut.code(1, r, g); p[swPtr + g] = cut.code(2, r, g); }
  return message(1, p, 2432);
}

/**
 * A legacy Archive II file: the volume header (ARCHIVE2 leaves the site blank), an all-zero message 5 frame as some
 * 2005 files carry, an RDA status frame, then the radials of each cut.
 */
export function writeLegacyArchive2(v: SynthLegacyVolume): Uint8Array {
  const header = new Uint8Array(24), hd = new DataView(header.buffer);
  ascii(header, 0, `${v.header}001`); hd.setUint32(12, Math.floor(v.timeMs / MS_DAY) + 1); hd.setUint32(16, v.timeMs % MS_DAY);
  if (v.header === 'AR2V0001.') ascii(header, 20, v.site);
  const frames = [header, message(5, new Uint8Array(2400), 2432), message(2, new Uint8Array(96), 2432)];
  v.cuts.forEach((cut, ci) => {
    for (let r = 0; r < cut.radials; r++) {
      const first = r === 0, last = r === cut.radials - 1;
      const status = first ? (ci === 0 ? 3 : 0) : last ? (ci === v.cuts.length - 1 ? 4 : 2) : 1;
      frames.push(legacyRadial(v, cut, ci + 1, r, status, v.timeMs + ci * 20000 + r * 50));
    }
  });
  return concat(frames);
}
