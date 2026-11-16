// Worker pool: a failing worker rejects its pending tasks and is replaced (static review finding).
import { describe, it, expect } from 'vitest';
import { WorkerPool, type WorkerLike } from '../src/workers/pool';

class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  posted: any[] = []; terminated = false;
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  reply(i: number, result: unknown) { const m = this.posted[i]; this.onmessage!({ data: { id: m.id, ok: true, result, ms: 1 } } as MessageEvent); }
}

describe('WorkerPool failure handling', () => {
  it('rejects pending tasks on error and keeps working with a new worker', async () => {
    const made: FakeWorker[] = [];
    const pool = new WorkerPool(1, () => { const w = new FakeWorker(); made.push(w); return w; });
    const a = pool.run('x', 1), b = pool.run('y', 2);
    made[0].onerror!(new Event('error'));
    await expect(a).rejects.toThrow(/worker failed/);
    await expect(b).rejects.toThrow(/worker failed/);
    expect(made[0].terminated).toBe(true);
    expect(made.length).toBe(2);
    const c = pool.run('z', 3);
    made[1].reply(0, 42);
    await expect(c).resolves.toBe(42);
  });
  it('messageerror is a failure too, and other workers are untouched', async () => {
    const made: FakeWorker[] = [];
    const pool = new WorkerPool(2, () => { const w = new FakeWorker(); made.push(w); return w; });
    const s0 = pool.slot('k'), other = 1 - s0;
    const a = pool.run('x', 1, 'k');
    const keyOther = ['a', 'b', 'c', 'd', 'e', 'f'].find((k) => pool.slot(k) === other)!;
    const b = pool.run('y', 2, keyOther);
    made[s0].onmessageerror!({} as MessageEvent);
    await expect(a).rejects.toThrow(/deserialized/);
    made[other].reply(0, 'ok');
    await expect(b).resolves.toBe('ok');
  });
  it('an aborted caller stops waiting', async () => {
    const pool = new WorkerPool(1, () => new FakeWorker());
    const ctl = new AbortController();
    const p = pool.run('x', 1, undefined, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow(/abort/);
  });
});
