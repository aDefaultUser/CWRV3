// Level 2 volumes in the decode worker: the decoded-volume cache, incremental real-time chunk volumes and the tasks
// built on them (metadata, products, live composite, volume packs).
import { Archive2Decoder, type L2Volume } from '../decode/archive2';
import { bunzip2 } from '../decode/bzip2';
import { fetchBytes } from '../data/net';
import { recodeVolume, buildProduct, liveComposite, SweepCache, type BuilderSweep, type L2BuildParams, type L2ProductSweep, type VolumeMoment } from '../radar/l2products';
import { buildVolumePack } from '../radar/volume-pack';
import { padSweep } from '../radar/sweep-pad';
import type { JobClock, JobHandler } from './job-clock';

export interface L2SweepMeta { index: number; elevationNumber: number; elevation: number; nominal: number | null; radials: number; moments: string[]; complete: boolean; label: string; split: 'CS' | 'CD' | null; supplemental: boolean; nyquist: number | null; startMs: number; endMs: number }
export interface L2Meta { site: string; volumeTimeMs: number | null; lat: number | null; lon: number | null; heightM: number | null; vcp: number | null; avset: boolean | null; sails: number; mrle: number; baseTilts: number; sweeps: L2SweepMeta[]; bytes: number }

/** A cached product and the sweep it was built from (null for products of the whole volume). */
interface Product { p: L2ProductSweep | null; of: BuilderSweep | null; index: number }
/**
 * A decoded volume: the raw sweeps, their recoded form, the per-sweep derived arrays (`derived`) and up to 24 built
 * products. `bytes` counts all of them and drives eviction.
 */
interface VolEntry { meta: L2Meta; sweeps: BuilderSweep[]; volume: L2Volume; products: Map<string, Product>; derived: SweepCache; bytes: number }
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
/** Runs a build that may add to the volume's derived cache and charges the growth to the volume. */
function charged<T>(v: VolEntry, build: () => T): T {
  const before = v.derived.bytes;
  const r = build();
  v.bytes += v.derived.bytes - before;
  return r;
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

/**
 * Recodes a decoded volume for the product builders and caches it under its URL. When the URL is already cached (a
 * live volume that grew), the sweeps the decoder left unchanged keep their recoded sweep, their derived arrays and
 * their single-sweep products; only changed sweeps and whole-volume products are rebuilt.
 */
function cacheVolume(url: string, volume: L2Volume, fileBytes: number): VolEntry {
  const prev = volumes.get(url);
  const sweeps = recodeVolume(volume, prev);
  const derived = prev?.derived ?? new SweepCache();
  derived.retain(sweeps);
  const products = new Map<string, Product>();
  if (prev) for (const [k, e] of prev.products) if (e.of && sweeps[e.index] === e.of) products.set(k, e);
  const seen = new Set<unknown>();
  let bytes = sizeOf(volume, seen) + sizeOf(sweeps, seen) + derived.bytes;
  for (const e of products.values()) bytes += sizeOf(e.p);
  const entry: VolEntry = { meta: describe(volume, fileBytes), sweeps, volume, products, derived, bytes };
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
  return job.time(() => {
    let buf = bytes;
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
  let e = v.products.get(key);
  if (!e) {
    const s = v.sweeps[a.sweep];
    e = { p: s ? charged(v, () => buildProduct(a.product, s, v.sweeps, a.params, v.derived)) : null, of: vol ? null : s ?? null, index: a.sweep };
    v.products.set(key, e);
    v.bytes += sizeOf(e.p);
    // Bounded per-volume product cache (tilt × product × parameter combinations).
    while (v.products.size > 24) { const [k0, e0] = v.products.entries().next().value!; v.products.delete(k0); v.bytes -= sizeOf(e0.p); }
    evict();
  }
  const p = e.p;
  if (!p) return { meta: v.meta, sweep: null };
  const sw = v.volume.sweeps[a.sweep];
  return {
    meta: v.meta,
    sweep: { ...p, codes: p.codes.slice(), azimuths: p.azimuths.slice(), startMs: sw?.timesMs[0] ?? 0, endMs: sw?.timesMs[sw.timesMs.length - 1] ?? 0 },
  };
}

/** Adds the padded upload image to a sweep result so the main thread only copies it to the GPU. */
function withUpload<T extends { sweep: any }>(r: T): T {
  const s = r.sweep;
  if (s) s.upload = padSweep(s.codes, s.radials, s.gates, s.complete, s.wordSize);
  return r;
}

/** Arguments of 'l2.volume': the volume (as for 'l2.product') and what to pack. */
export interface L2VolumeArgs { url: string; live: boolean; chunks?: string[]; moment: VolumeMoment; latest: boolean; qualityDealiasing: boolean }

export function configureL2(a: { volumes?: number; byteBudget?: number }) {
  if (a.volumes) cacheCfg.volumes = Math.max(1, Math.round(a.volumes));
  if (a.byteBudget) cacheCfg.byteBudget = a.byteBudget;
  evict();
  let bytes = 0;
  for (const e of volumes.values()) bytes += e.bytes;
  return { ...cacheCfg, cached: volumes.size, bytes };
}

export const L2_HANDLERS: Record<string, JobHandler> = {
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
      const g = charged(v, () => liveComposite(v.sweeps, a.base, a.top, a.selectiveMax, v.derived));
      evict();
      if (!g) return { meta: v.meta, sweep: null };
      const az = new Float32Array(720);
      for (let i = 0; i < 720; i++) az[i] = (g.az0 + i * 0.5) % 360;
      return withUpload({ meta: v.meta, sweep: { product: 0, radials: 720, gates: g.gates, firstKm: g.firstKm, gateKm: g.gateKm, azimuths: az, half: true, complete: true, elevation: 0, codes: g.codes, wordSize: 8 } });
    });
  },
  // Every tilt of one moment as a VolumePack (null when the volume lacks the moment); the layer images are new
  // arrays, transferred to the caller.
  'l2.volume': async (a: L2VolumeArgs, job) => {
    const v = await loadVolume(a.url, a.live, job, a.chunks);
    return job.time(() => {
      const scan = v.meta.sweeps.map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
      const pack = charged(v, () => buildVolumePack(v.sweeps, a.moment, a, scan, v.derived));
      evict();
      return { meta: v.meta, pack };
    });
  },
};
