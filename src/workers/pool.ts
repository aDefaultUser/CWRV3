// Main-thread side of the decode worker pool. Tasks with an affinity key (e.g. a Level 2 volume URL) always
// run on the same worker so that worker-side caches are reused. A worker that fails (error / messageerror)
// rejects every task it owned and is replaced, so callers never wait forever.
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; task: string; worker: number };

export interface TaskStat { task: string; ms: number; ok: boolean }
export interface WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent | Event) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
  terminate(): void;
}

export class WorkerPool {
  private workers: WorkerLike[] = [];
  private pending = new Map<number, Pending>();
  private load: number[] = [];
  private seq = 0;
  readonly stats: TaskStat[] = [];
  restarts = 0;

  constructor(size: number, private spawn: (i: number) => WorkerLike) {
    for (let i = 0; i < size; i++) { this.workers.push(this.start(i)); this.load.push(0); }
  }

  get size() { return this.workers.length; }

  private start(i: number): WorkerLike {
    const w = this.spawn(i);
    w.onmessage = (ev) => {
      const { id, ok, result, error, ms } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      this.load[i] = Math.max(0, this.load[i] - 1);
      this.stats.push({ task: p.task, ms, ok });
      if (this.stats.length > 500) this.stats.shift();
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
    const fail = (why: string) => this.fail(i, w, why);
    w.onerror = (ev) => { (ev as Event).preventDefault?.(); fail((ev as ErrorEvent).message || 'worker error'); };
    w.onmessageerror = () => fail('worker message could not be deserialized');
    return w;
  }

  /** Rejects all tasks owned by the failed worker and replaces it (its caches are lost). */
  private fail(i: number, w: WorkerLike, why: string) {
    if (this.workers[i] !== w) return;
    for (const [id, p] of this.pending) if (p.worker === i) { this.pending.delete(id); this.stats.push({ task: p.task, ms: 0, ok: false }); p.reject(new Error(`decode worker failed: ${why}`)); }
    this.load[i] = 0;
    try { w.terminate(); } catch { /* already gone */ }
    this.restarts++;
    this.workers[i] = this.start(i);
  }

  /** Index used for an affinity key (stable while the pool size is unchanged). */
  slot(affinity: string) {
    let h = 0;
    for (let k = 0; k < affinity.length; k++) h = (h * 31 + affinity.charCodeAt(k)) | 0;
    return Math.abs(h) % this.workers.length;
  }

  run<T = any>(task: string, args: unknown, affinity?: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    const i = affinity ? this.slot(affinity) : this.load.indexOf(Math.min(...this.load));
    const id = ++this.seq;
    this.load[i]++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, task, worker: i });
      // An aborted caller stops waiting; the worker finishes its task and the result is discarded.
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.load[i] = Math.max(0, this.load[i] - 1);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
      try { this.workers[i].postMessage({ id, task, args }); } catch (e) { this.pending.delete(id); this.load[i]--; reject(e as Error); }
    });
  }

  /** Sends the same message to every worker (configuration such as cache budgets). */
  broadcast(task: string, args: unknown) { return Promise.all(this.workers.map((_, i) => this.runOn(i, task, args))); }
  private runOn(i: number, task: string, args: unknown) {
    const id = ++this.seq;
    this.load[i]++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, task, worker: i }); this.workers[i].postMessage({ id, task, args }); });
  }
}

const browser = typeof Worker !== 'undefined' && typeof navigator !== 'undefined';
export const pool = browser
  ? new WorkerPool(Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 3))), (i) => new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module', name: `decode-${i}` }) as unknown as WorkerLike)
  : (null as unknown as WorkerPool);
