// Level 2 volumes in the decode worker: the decoded-volume cache, incremental real-time chunk volumes and the tasks
// built on them (metadata, products, live composite, volume packs).
import type { L2Volume } from '../decode/archive2';
import { archive2Backend, archive2Ready, createArchive2Decoder, type L2Decoder } from '../decode/archive2-wasm';
import { gunzip } from '../decode/zip';
import { fetchBytes } from '../data/net';
import { recodeVolume, buildProduct, liveComposite, rollingTilts, SweepCache, type BuilderSweep, type L2BuildParams, type L2ProductSweep, type VolumeMoment } from '../radar/l2products';
import { buildVolumePack } from '../radar/volume-pack';
import { padSweep } from '../radar/sweep-pad';
import type { JobClock, JobHandler } from './job-clock';

export interface L2SweepMeta { index: number; elevationNumber: number; elevation: number; nominal: number | null; radials: number; moments: string[]; complete: boolean; label: string; split: 'CS' | 'CD' | null; supplemental: boolean; nyquist: number | null; startMs: number; endMs: number }
export interface L2Meta { site: string; volumeTimeMs: number | null; lat: number | null; lon: number | null; heightM: number | null; vcp: number | null; avset: boolean | null; sails: number; mrle: number; baseTilts: number; sweeps: L2SweepMeta[]; bytes: number }

/** A cached product and the sweep it was built from (null for products of the whole volume). */
interface Product { p: L2ProductSweep | null; of: BuilderSweep | null; index: number }
/**
 * A decoded volume: the raw sweeps, their recoded form, the per-sweep derived arrays (`derived`) and up to 24 built
 * products. `bytes` counts all of them and drives eviction. A chunk volume keeps the chunks it was decoded from;
 * `growing` marks a whole file read while it was still being written (the live TGFTP volume).
 */
interface VolEntry { meta: L2Meta; sweeps: BuilderSweep[]; volume: L2Volume; products: Map<string, Product>; derived: SweepCache; bytes: number; chunks?: string[]; growing?: boolean }
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

/**
 * Real-time chunk volumes decoded incrementally. A live volume keeps its decoder (the three most recently fed) and
 * each request feeds only the chunks not fed yet; a complete one (`live` false) frees its decoder after the last
 * chunk. The cached volume answers any request for its chunks or the first of them. Chunks are downloaded before a
 * decoder is created or fed, so pending and failed downloads hold no decoder.
 */
interface Stream { d: L2Decoder; fed: string[]; bytes: number }
const streams = new Map<string, Stream>();
function dropStream(url: string) {
  streams.get(url)?.d.dispose();
  streams.delete(url);
}
const startsWith = (list: string[], head: string[]) => head.length <= list.length && head.every((c, i) => list[i] === c);
const streamLock = new Map<string, Promise<unknown>>();
/** Serialises chunk feeding per volume (meta and product requests can overlap). */
function loadChunks(url: string, chunks: string[], live: boolean, job: JobClock): Promise<VolEntry> {
  const run = (streamLock.get(url) ?? Promise.resolve()).catch(() => undefined).then(() => feedChunks(url, chunks, live, job));
  streamLock.set(url, run);
  void run.finally(() => { if (streamLock.get(url) === run) streamLock.delete(url); }).catch(() => undefined);
  return run;
}
async function feedChunks(url: string, chunks: string[], live: boolean, job: JobClock): Promise<VolEntry> {
  await archive2Ready();
  for (;;) {
    const hit = volumes.get(url);
    // Decoded already (a late request of a live volume gets the volume as it has grown since).
    if (hit?.chunks && startsWith(hit.chunks, chunks)) {
      if (!live) dropStream(url);
      volumes.delete(url); volumes.set(url, hit);
      return hit;
    }
    // A stream fed with other chunks (gap repaired, folder reused, a late request) is decoded afresh.
    const s = streams.get(url), resume = s && startsWith(chunks, s.fed) ? s : null;
    const fresh = chunks.slice(resume?.fed.length ?? 0);
    const parts = await Promise.all(fresh.map((c) => fetchBytes(c, { cache: 'immutable' })));
    // Evicted while its chunks downloaded (and its decoder freed): decode afresh, the earlier chunks come from the cache.
    if (resume && streams.get(url) !== resume) continue;
    return job.time(() => {
      if (!resume) dropStream(url);
      const st = resume ?? { d: createArchive2Decoder(), fed: [], bytes: 0 };
      try {
        for (const p of parts) { st.d.feed(p); st.bytes += p.length; }
        st.fed = chunks;
        const entry = cacheVolume(url, st.d.volume(), st.bytes, chunks);
        streams.delete(url);
        if (live) {
          streams.set(url, st);
          while (streams.size > 3) dropStream(streams.keys().next().value!);
        } else st.d.dispose();
        return entry;
      } catch (e) {
        // A refused chunk leaves the decoder with part of it: the next request decodes the volume afresh.
        if (resume) streams.delete(url);
        st.d.dispose();
        throw e;
      }
    });
  }
}

/**
 * Recodes a decoded volume for the product builders and caches it under its URL. When the URL is already cached (a
 * live volume that grew), the sweeps the decoder left unchanged keep their recoded sweep, their derived arrays and
 * their single-sweep products; only changed sweeps and whole-volume products are rebuilt.
 */
function cacheVolume(url: string, volume: L2Volume, fileBytes: number, chunks?: string[], growing = false): VolEntry {
  const prev = volumes.get(url);
  const sweeps = recodeVolume(volume, prev);
  const derived = prev?.derived ?? new SweepCache();
  derived.retain(sweeps);
  const products = new Map<string, Product>();
  if (prev) for (const [k, e] of prev.products) if (e.of && sweeps[e.index] === e.of) products.set(k, e);
  const seen = new Set<unknown>();
  let bytes = sizeOf(volume, seen) + sizeOf(sweeps, seen) + derived.bytes;
  for (const e of products.values()) bytes += sizeOf(e.p);
  const entry: VolEntry = { meta: describe(volume, fileBytes), sweeps, volume, products, derived, bytes, chunks, growing };
  volumes.delete(url);
  volumes.set(url, entry);
  evict();
  return entry;
}

async function loadVolume(url: string, live: boolean, job: JobClock, chunks?: string[]): Promise<VolEntry> {
  if (chunks?.length) return loadChunks(url, chunks, live, job);
  const hit = volumes.get(url);
  // A file read while it was still being written is read again once it is complete.
  if (hit && !live && !hit.growing) { volumes.delete(url); volumes.set(url, hit); return hit; }
  const bytes = await fetchBytes(url, { cache: live ? 'none' : 'immutable' });
  // Archive volumes before mid-2016 are whole-file gzip (…_V06.gz, or without a version before 2008).
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
  await archive2Ready();
  return job.time(() => {
    // A final read can finish while an earlier growing-file request is still in flight.
    const completed = volumes.get(url);
    if (live && completed && completed !== hit && !completed.growing) return completed;
    // ARCHIVE2 volumes (before about 2004) leave the header's site blank; the file name holds the requested radar.
    const d = createArchive2Decoder(/\/([A-Z]{4})\d{8}_\d{6}[^/]*$/.exec(url)?.[1]);
    try {
      d.feed(plain);
      return cacheVolume(url, d.volume(), bytes.length, undefined, live);
    } finally {
      d.dispose();
    }
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

/**
 * A volume product of a live volume in rolling mode: built from the live volume's complete tilts and the previous
 * volume's tilts above them (rollingTilts). Returns the sweep with the time span of the data used and how many tilts
 * came from each volume; not cached, as the live volume changes with every request.
 */
function rollingProduct(v: VolEntry, prev: VolEntry, a: { product: number; params: L2BuildParams }) {
  const pick = rollingTilts(v.sweeps, prev.sweeps);
  const sweeps = [...pick.live.map((i) => v.sweeps[i]), ...pick.prev.map((i) => prev.sweeps[i])];
  const times = [...pick.live.map((i) => v.volume.sweeps[i].timesMs), ...pick.prev.map((i) => prev.volume.sweeps[i].timesMs)].filter((t) => t.length);
  const p = sweeps.length ? buildProduct(a.product, sweeps[0], sweeps, a.params) : null;
  if (!p) return { meta: v.meta, sweep: null };
  const startMs = Math.min(...times.map((t) => t[0])), endMs = Math.max(...times.map((t) => t[t.length - 1]));
  return { meta: v.meta, sweep: { ...p, startMs, endMs, rolling: { liveTilts: pick.live.length, prevTilts: pick.prev.length, prevTimeMs: prev.meta.volumeTimeMs } } };
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
  return { ...cacheCfg, cached: volumes.size, bytes, decoder: archive2Backend() };
}

export const L2_HANDLERS: Record<string, JobHandler> = {
  'l2.meta': async (a, job) => (await loadVolume(a.url, a.live, job, a.chunks)).meta,
  'l2.product': async (a, job) => {
    const v = await loadVolume(a.url, a.live, job, a.chunks);
    if (a.rolling) {
      const prev = await loadVolume(a.rolling.url, false, job, a.rolling.chunks);
      return job.time(() => withUpload(rollingProduct(v, prev, a)));
    }
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
