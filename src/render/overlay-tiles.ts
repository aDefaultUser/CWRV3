// Transparent Web Mercator overlay tiles (worldwide radar mosaic and its coverage mask): a square RGBA texture array allocated on first use, filled lazily with the tiles in view, under a rolling request budget shared by every
// request to the provider. Tiles are keyed by a caller identity (the frame) and position; a missing tile is drawn
// from the nearest loaded ancestor of the same identity only, never from another frame.
import type { Renderer } from './renderer';

/** Rolling-window request budget (requests per window) with a back-off pause after a rate-limit answer. */
export class RequestBudget {
  private times: number[] = [];
  private pausedUntil = 0;
  private backoffMs = 0;
  constructor(readonly limit: number, readonly windowMs: number, private now: () => number = () => Date.now()) {}
  private prune() { const from = this.now() - this.windowMs; while (this.times.length && this.times[0] <= from) this.times.shift(); }
  /**
   * Takes one request; false (and nothing taken) while the window is full or a back-off is in effect. A caller passing
   * `reserve` leaves that many requests of the window to the others (the frame list must never be starved by tiles).
   */
  take(reserve = 0): boolean {
    if (this.now() < this.pausedUntil) return false;
    this.prune();
    if (this.times.length >= this.limit - reserve) return false;
    this.times.push(this.now());
    return true;
  }
  /** Requests taken in the current window. */
  used(): number { this.prune(); return this.times.length; }
  /**
   * A rate-limit answer: no request for `retryAfterMs` when the provider says how long (Retry-After is not exposed
   * cross-origin by every host), else for a back-off that doubles from one minute up to ten.
   */
  limited(retryAfterMs?: number) {
    this.backoffMs = retryAfterMs ?? Math.min(600_000, this.backoffMs ? this.backoffMs * 2 : 60_000);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.backoffMs);
  }
  /** A successful answer ends the back-off doubling. */
  ok() { if (this.now() >= this.pausedUntil) this.backoffMs = 0; }
  /** Milliseconds until requests may resume (0 when not paused). */
  pausedFor(): number { return Math.max(0, this.pausedUntil - this.now()); }
}

/** Seconds of a Retry-After header (delta seconds or an HTTP date), or undefined. */
export function retryAfterMs(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

const FAIL_RETRY_MS = 60_000;
/** Requests of each budget window that tiles leave free for the provider's frame list. */
export const LIST_RESERVE = 1;
const FULL_RETRY_MS = 5_000;
/** A tile request (headers and body) that takes longer is aborted and counted as failed, freeing its slot. */
export const TILE_TIMEOUT_MS = 20_000;

/** Where a tile's texels are: atlas slot and the sub-rectangle of the (ancestor) tile that covers it. */
export interface TileHit { slot: number; z: number; u0: number; v0: number; scale: number }

export class OverlayTileCache {
  tex: GPUTexture | null = null;
  private entries = new Map<string, { slot: number; used: number }>();
  private free: number[] = [];
  private loading = new Set<string>();
  /** Aborts the loads in flight (of every generation not yet settled). */
  private aborts = new Set<AbortController>();
  private retryAt = new Map<string, number>();
  private failedKeys = new Set<string>();
  /** Tiles asked for since the last pump (only tiles still in view are fetched). */
  private want = new Map<string, { url: string; pri: number }>();
  private active = 0;
  private frame = 0;
  /** Bumped by clear(): a load started before it is discarded. */
  private generation = 0;
  loaded = 0;
  failed = 0;
  lastError = '';
  constructor(private r: Renderer, readonly budget: RequestBudget, private onLoad: () => void, readonly slots = 256, readonly concurrency = 4, readonly size = 256) {
    for (let i = slots - 1; i >= 0; i--) this.free.push(i);
  }

  private ensureTexture(): GPUTexture {
    if (this.tex) return this.tex;
    this.tex = this.r.gpu.device.createTexture({
      size: [this.size, this.size, this.slots], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.r.gpu.trackTexture(this.tex, this.size * this.size * 4 * this.slots, 'world radar');
    return this.tex;
  }

  /**
   * Best loaded tile of identity `id` for (z, x, y): the tile itself, or its nearest loaded ancestor of the same
   * identity (null when none). Asks for the tile itself when it is not loaded.
   */
  lookup(id: string, z: number, x: number, y: number, url: () => string, frame: number, pri: number): TileHit | null {
    this.frame = Math.max(this.frame, frame);
    let hit: TileHit | null = null;
    for (let k = z; k >= 0; k--) {
      const e = this.entries.get(`${id}|${k}/${x >> (z - k)}/${y >> (z - k)}`);
      if (!e) continue;
      e.used = frame;
      const n = 2 ** (z - k);
      hit = { slot: e.slot, z: k, u0: (x % n) / n, v0: (y % n) / n, scale: 1 / n };
      break;
    }
    if (!hit || hit.z < z) {
      const key = `${id}|${z}/${x}/${y}`;
      if (!this.loading.has(key) && Date.now() >= (this.retryAt.get(key) ?? 0)) {
        const w = this.want.get(key);
        if (!w || pri < w.pri) this.want.set(key, { url: w?.url ?? url(), pri });
      }
    }
    return hit;
  }
  /** True when the tile itself is loaded. */
  isLoaded(id: string, z: number, x: number, y: number) { return this.entries.has(`${id}|${z}/${x}/${y}`); }
  /** Whether the tile's last request failed and waits for its retry (false when loaded, loading or not yet asked). */
  failedTile(id: string, z: number, x: number, y: number) { return this.failedKeys.has(`${id}|${z}/${x}/${y}`); }

  /** Starts loads for the tiles asked for since the last pump, nearest-first, within the budget and the free room. */
  pump(frame: number) {
    this.frame = Math.max(this.frame, frame);
    const queue = [...this.want].sort((a, b) => a[1].pri - b[1].pri);
    this.want.clear();
    const now = Date.now();
    for (const [k, t] of this.retryAt) if (t <= now) this.retryAt.delete(k);
    for (const k of this.failedKeys) if (!this.retryAt.has(k)) this.failedKeys.delete(k); // retried: pending again
    let room = this.free.length - this.active;
    for (const v of this.entries.values()) if (v.used < this.frame - 2) room++;
    for (const [key, w] of queue) {
      if (this.active >= this.concurrency || room <= 0) break;
      if (!this.budget.take(LIST_RESERVE)) break;
      room--;
      this.load(key, w.url);
    }
  }

  private load(key: string, url: string) {
    const gen = this.generation;
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, TILE_TIMEOUT_MS);
    this.aborts.add(abort);
    this.loading.add(key);
    this.active++;
    // The signal also aborts reading the body; the check after decoding covers an abort during the decode.
    fetch(url, { signal: abort.signal }).then(async (res) => {
      if (res.status === 429) { this.budget.limited(retryAfterMs(res.headers.get('retry-after'))); throw new Error('rate limited by the provider (HTTP 429)'); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.budget.ok();
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'premultiply' });
      if (gen !== this.generation) { bmp.close(); return; }
      if (abort.signal.aborted) { bmp.close(); throw new Error('aborted'); }
      if (bmp.width !== this.size || bmp.height !== this.size) { bmp.close(); throw new Error(`unexpected tile size ${bmp.width}×${bmp.height}`); }
      let slot = this.free.pop();
      if (slot === undefined) {
        let oldest: string | null = null, ou = Infinity;
        for (const [k, v] of this.entries) if (v.used < this.frame - 2 && v.used < ou) { ou = v.used; oldest = k; }
        if (!oldest) { bmp.close(); this.retryAt.set(key, Date.now() + FULL_RETRY_MS); return; }
        slot = this.entries.get(oldest)!.slot;
        this.entries.delete(oldest);
      }
      const t0 = performance.now();
      this.r.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: this.ensureTexture(), origin: [0, 0, slot], premultipliedAlpha: true }, [this.size, this.size]);
      this.r.gpu.recordUpload('world radar', this.size * this.size * 4, performance.now() - t0);
      bmp.close();
      this.entries.set(key, { slot, used: this.frame });
      this.retryAt.delete(key);
      this.failedKeys.delete(key);
      this.loaded++;
      this.onLoad();
    }).catch((e: Error) => {
      if (gen !== this.generation) return;
      this.failed++; this.failedKeys.add(key); this.lastError = timedOut ? `no answer within ${TILE_TIMEOUT_MS / 1000} s` : e.message;
      this.retryAt.set(key, Date.now() + Math.max(FAIL_RETRY_MS, this.budget.pausedFor()));
      this.onLoad();
    }).finally(() => {
      clearTimeout(timer);
      this.aborts.delete(abort);
      if (gen === this.generation) { this.loading.delete(key); this.active--; }
    });
  }

  /** Drops every tile and the atlas texture (layer disabled) and aborts the loads in flight. */
  clear() {
    this.generation++;
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    this.entries.clear(); this.loading.clear(); this.want.clear(); this.retryAt.clear(); this.failedKeys.clear();
    this.active = 0;
    this.free = [];
    for (let i = this.slots - 1; i >= 0; i--) this.free.push(i);
    if (this.tex) { this.tex.destroy(); this.tex = null; }
  }
}
