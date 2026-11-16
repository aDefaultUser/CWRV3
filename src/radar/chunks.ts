// Real-time Level 2 chunk feed (public unidata-nexrad-level2-chunks bucket): SITE/<volume 1..999>/
// <YYYYMMDD-HHMMSS>-<NNN>-<S|I|E>. S carries the volume header and metadata, I/E carry compressed radial records;
// concatenated in sequence they form an Archive II volume, which the worker decodes incrementally.
import { listS3 } from '../data/net';

export const CHUNK_BUCKET = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';

export interface ChunkKey { key: string; vol: number; timeMs: number; seq: number; kind: 'S' | 'I' | 'E' }
export interface ChunkVolume { site: string; vol: number; timeMs: number; chunks: string[]; complete: boolean }

export function parseChunkKey(key: string): ChunkKey | null {
  const m = /^[A-Z0-9]{4}\/(\d+)\/(\d{8})-(\d{6})-(\d{3})-([SIE])$/.exec(key);
  if (!m) return null;
  const d = m[2], t = m[3];
  return { key, vol: +m[1], timeMs: Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)), seq: +m[4], kind: m[5] as ChunkKey['kind'] };
}

/**
 * Chunk keys of one volume in sequence. A reused folder can still hold chunks of an older volume, so only chunks
 * sharing the newest start time are kept; the run stops at a gap (a missing chunk would corrupt the record stream).
 */
export function orderChunks(keys: ChunkKey[]): ChunkKey[] {
  const t = Math.max(...keys.filter((k) => k.kind === 'S').map((k) => k.timeMs), -Infinity);
  const s = keys.filter((k) => k.timeMs === t).sort((a, b) => a.seq - b.seq);
  const out: ChunkKey[] = [];
  for (const k of s) { if (k.seq !== out.length + 1) break; out.push(k); }
  return out[0]?.kind === 'S' ? out : [];
}

/**
 * Newest volume folder. Folder numbers wrap (… 999, 1, 2 …) and the bucket keeps stale folders from earlier cycles
 * (e.g. after a radar restart the counter jumps), so start times are only locally increasing. Folders are sampled
 * every `step` positions (parallel, first-chunk time), then the newest run is followed forward from the newest
 * sample by binary search inside the next interval.
 */
export async function newestFolder(nums: number[], timeOf: (n: number) => Promise<number>, step = 32): Promise<number> {
  const s = [...nums].sort((a, b) => a - b);
  if (s.length <= 1) return s[0] ?? -1;
  const idx: number[] = [];
  for (let i = 0; i < s.length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== s.length - 1) idx.push(s.length - 1);
  const times: number[] = [];
  for (let k = 0; k < idx.length; k += 12) times.push(...(await Promise.all(idx.slice(k, k + 12).map((i) => timeOf(s[i])))));
  let best = 0;
  for (let k = 1; k < idx.length; k++) if (times[k] > times[best]) best = k;
  // Within (idx[best], idx[best + 1]) times rise from the sample until the run ends: last index with time ≥ sample.
  const t0 = times[best];
  let lo = idx[best], hi = Math.min(s.length - 1, (idx[best + 1] ?? s.length) - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((await timeOf(s[mid])) >= t0) lo = mid; else hi = mid - 1;
  }
  // The run may continue past the wrap (999 → 1) when the newest sample is the last folder.
  return s[lo];
}

export const nextFolder = (n: number, max = 999) => (n >= max ? 1 : n + 1);

/** Tracks the current real-time volume of one site; `poll` lists only the current and the following folder. */
export class ChunkFeed {
  private vol = -1; private site = ''; private sampledAt = 0;
  constructor(private list: (prefix: string, opts?: { delimiter?: string }) => Promise<{ keys: string[]; prefixes: string[] }> = defaultList) {}

  private async keysOf(site: string, vol: number): Promise<ChunkKey[]> {
    return (await this.list(`${site}/${vol}/`)).keys.map(parseChunkKey).filter((k): k is ChunkKey => !!k);
  }

  async poll(site: string, now = Date.now()): Promise<ChunkVolume | null> {
    if (site !== this.site) { this.site = site; this.vol = -1; }
    if (this.vol < 0) {
      this.sampledAt = now;
      const { prefixes } = await this.list(`${site}/`, { delimiter: '/' });
      const nums = prefixes.map((p) => Number(p.split('/')[1])).filter(Number.isFinite);
      const times = new Map<number, number>();
      this.vol = await newestFolder(nums, async (n) => { if (!times.has(n)) times.set(n, Math.max(0, ...(await this.keysOf(site, n)).filter((k) => k.kind === 'S').map((k) => k.timeMs))); return times.get(n)!; });
      if (this.vol < 0) return null;
    }
    let keys = orderChunks(await this.keysOf(site, this.vol));
    // After the end chunk, follow the next folder once its start chunk exists.
    if (keys.some((k) => k.kind === 'E')) {
      const next = orderChunks(await this.keysOf(site, nextFolder(this.vol)));
      if (next.length && next[0].timeMs > keys[0].timeMs) { this.vol = nextFolder(this.vol); keys = next; }
    }
    // A followed volume that went stale (feed stall, counter jump) triggers a fresh search at most every 5 minutes.
    if ((!keys.length || now - keys[0].timeMs > 20 * 60e3) && now - this.sampledAt > 5 * 60e3) { this.vol = -1; return this.poll(site, now); }
    if (!keys.length) return null;
    return { site, vol: this.vol, timeMs: keys[0].timeMs, chunks: keys.map((k) => `${CHUNK_BUCKET}/${k.key}`), complete: keys.some((k) => k.kind === 'E') };
  }
}

async function defaultList(prefix: string, opts: { delimiter?: string } = {}) {
  const r = await listS3(CHUNK_BUCKET, prefix, { ...opts, maxPages: 2 });
  return { keys: r.objects.map((o) => o.key), prefixes: r.prefixes };
}
