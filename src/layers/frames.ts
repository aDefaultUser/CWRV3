// Time-indexed frame cache with newest-first progressive loading and bounded concurrency.
export interface FrameEntry<T> { t: number; key: string; state: 'pending' | 'loading' | 'ready' | 'error'; data?: T; error?: string }

export class FrameStore<T> {
  frames: FrameEntry<T>[] = [];
  private active = 0;
  constructor(private load: (f: FrameEntry<T>) => Promise<T>, private dispose: (d: T) => void, private concurrency = 3, private onReady: () => void = () => {}) {}

  /** Replaces the wanted frame list (keys must be stable); keeps loaded data for retained keys. */
  setWanted(wanted: { t: number; key: string }[]) {
    const keep = new Map(this.frames.map((f) => [f.key, f]));
    const next: FrameEntry<T>[] = [];
    for (const w of wanted) next.push(keep.get(w.key) ?? { t: w.t, key: w.key, state: 'pending' });
    const nextKeys = new Set(next.map((f) => f.key));
    for (const f of this.frames) if (!nextKeys.has(f.key) && f.data) this.dispose(f.data);
    this.frames = next.sort((a, b) => a.t - b.t);
    this.pump();
  }

  pump() {
    const pending = this.frames.filter((f) => f.state === 'pending').sort((a, b) => b.t - a.t);
    while (this.active < this.concurrency && pending.length) {
      const f = pending.shift()!;
      f.state = 'loading';
      this.active++;
      this.load(f).then((d) => {
        if (!this.frames.includes(f)) { this.dispose(d); return; }
        f.data = d; f.state = 'ready';
        this.onReady();
      }, (e) => { f.state = 'error'; f.error = String(e?.message ?? e); this.onReady(); })
        .finally(() => { this.active--; this.pump(); });
    }
  }

  ready(): (FrameEntry<T> & { data: T })[] { return this.frames.filter((f): f is FrameEntry<T> & { data: T } => f.state === 'ready' && !!f.data); }
  counts() { const c = { ready: 0, loading: 0, pending: 0, error: 0 }; for (const f of this.frames) c[f.state]++; return c; }
  clear() { for (const f of this.frames) if (f.data) this.dispose(f.data); this.frames = []; }
}
