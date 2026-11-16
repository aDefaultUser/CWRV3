// Time-matched precipitation typing: HRRR categorical p-type valid at the displayed scan time, per renderer (GPU
// device) and valid hour. Archived scans get archived HRRR forecasts; nothing ever falls back to "current" weather.
// When no matching forecast exists the consumer renders ordinary reflectivity and reports p-type unavailable.
import type { Renderer } from './renderer';
import { lambertProj, type ProjParams } from './raster';
import { loadPtypeGrid, ptypeValidHour, type PtypeGrid } from '../data/hrrr-service';

export type PtypeState<T> =
  | { status: 'ready'; validMs: number; cycleMs: number; fh: number; value: T }
  | { status: 'loading'; validMs: number }
  | { status: 'unavailable'; validMs: number; reason: string };

interface Entry<T> { state: PtypeState<T>; listeners: Set<() => void>; retryAt: number }

/**
 * Bounded cache of p-type fields keyed by HRRR valid hour. Each consumer registers a stable invalidation callback
 * and is notified when the hour it asked for resolves. A response that arrives after its entry was evicted (or
 * replaced by a retry) is disposed and never shown.
 */
export class PtypeCache<T> {
  private entries = new Map<number, Entry<T>>();
  constructor(
    private load: (validMs: number) => Promise<PtypeGrid | null>,
    private upload: (g: PtypeGrid) => T,
    private dispose: (v: T) => void,
    private max = 10,
    private retryMs = 10 * 60e3,
    private now: () => number = Date.now,
  ) {}

  /** P-type for the data time `t` (ms); `onChange` must be a stable function (it is kept in a set). */
  get(t: number, onChange: () => void): PtypeState<T> {
    const validMs = ptypeValidHour(t);
    let e = this.entries.get(validMs);
    if (e && e.state.status === 'unavailable' && this.now() >= e.retryAt) { this.entries.delete(validMs); e = undefined; }
    if (e) {
      // Re-insert to keep LRU order.
      this.entries.delete(validMs); this.entries.set(validMs, e);
      e.listeners.add(onChange);
      return e.state;
    }
    const entry: Entry<T> = { state: { status: 'loading', validMs }, listeners: new Set([onChange]), retryAt: Infinity };
    this.entries.set(validMs, entry);
    this.evict();
    void (async () => {
      let reason = `no HRRR forecast valid ${new Date(validMs).toISOString().slice(0, 13)}Z`;
      try {
        const g = await this.load(validMs);
        if (this.entries.get(validMs) !== entry) return; // evicted or superseded: drop the late response
        if (g) { entry.state = { status: 'ready', validMs, cycleMs: g.cycleMs, fh: g.fh, value: this.upload(g) }; return; }
      } catch (err) {
        if (this.entries.get(validMs) !== entry) return;
        reason = (err as Error).message;
      }
      entry.state = { status: 'unavailable', validMs, reason };
      entry.retryAt = this.now() + this.retryMs;
    })().finally(() => { for (const f of entry.listeners) f(); });
    return entry.state;
  }

  private evict() {
    while (this.entries.size > this.max) {
      const [k, e] = this.entries.entries().next().value!;
      this.entries.delete(k);
      if (e.state.status === 'ready') this.dispose(e.state.value);
    }
  }

  size() { return this.entries.size; }
  clear() { for (const e of this.entries.values()) if (e.state.status === 'ready') this.dispose(e.state.value); this.entries.clear(); }
}

export interface PtypeTex { tex: GPUTexture; proj: ProjParams }
const caches = new WeakMap<Renderer, PtypeCache<PtypeTex>>();

/** Time-matched p-type texture for a renderer; textures are released two seconds after eviction (in-flight frames). */
export function ptypeAt(r: Renderer, t: number, onChange: () => void): PtypeState<PtypeTex> {
  let c = caches.get(r);
  if (!c) {
    c = new PtypeCache<PtypeTex>(loadPtypeGrid, (g) => ({ tex: r.gpu.texture2D(g.nx, g.ny, 'rgba8unorm', g.packed), proj: lambertProj(g.grid) }), (v) => setTimeout(() => v.tex.destroy(), 2000));
    caches.set(r, c);
  }
  return c.get(t, onChange);
}

/** Short status text for legends and layer status lines. */
export function ptypeLabel(s: PtypeState<unknown>): string {
  const hh = (ms: number) => `${new Date(ms).toISOString().slice(5, 13).replace('T', ' ')}Z`;
  if (s.status === 'ready') return `P-type: HRRR ${hh(s.cycleMs)} f${String(s.fh).padStart(2, '0')} valid ${hh(s.validMs)}`;
  if (s.status === 'loading') return `P-type: loading HRRR valid ${hh(s.validMs)}`;
  return `P-type unavailable (${hh(s.validMs)}): showing reflectivity`;
}

/** Data time that a blended pair of frames represents: the dominant frame's own time, never the clock. */
export function dominantTime(a: { t: number }, b: { t: number } | null, w: number): number {
  return b && w >= 0.5 ? b.t : a.t;
}
