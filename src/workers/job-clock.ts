// Per-job processing time in the decode worker: only the decode/build sections a handler wraps in `job.time()` are
// counted, so network waits, queueing and transfer are excluded. Each message gets its own clock, so jobs that
// interleave on one worker (awaiting fetches) never add to each other's totals.

export class JobClock {
  /** Processing milliseconds so far (overlapping sections of this job count once). */
  ms = 0;
  /**
   * True once an asynchronous section (stream inflate, WebAssembly decode) was timed. Synchronous sections run
   * uninterrupted on the worker thread; an asynchronous one is wall time and can include other jobs' work.
   */
  async = false;
  private open = 0;
  private since = 0;
  constructor(private now: () => number = () => performance.now()) {}

  /** Runs `fn` and counts its time (until its promise settles when it returns one). */
  time<T>(fn: () => T): T {
    if (this.open++ === 0) this.since = this.now();
    let r: T;
    try { r = fn(); } catch (e) { this.close(); throw e; }
    if (r instanceof Promise) { this.async = true; return r.finally(() => this.close()) as T; }
    this.close();
    return r;
  }
  private close() { if (--this.open === 0) this.ms += this.now() - this.since; }
}

export type JobHandler = (args: any, job: JobClock) => Promise<unknown>;
/** Worker reply timing: `ms` is the handler's wall time (fetch + decode); `procMs` is null for untimed tasks. */
export interface JobReply { ok: boolean; result?: unknown; error?: string; ms: number; procMs: number | null; procWall: boolean }

/** Runs one worker message. `timed` says the handler times its processing (a cache hit then reports 0, not N/A). */
export async function runJob(handler: JobHandler | undefined, task: string, args: unknown, timed: boolean, now: () => number = () => performance.now()): Promise<JobReply> {
  const job = new JobClock(now), t0 = now();
  const timing = () => ({ ms: now() - t0, procMs: timed ? job.ms : null, procWall: job.async });
  try {
    if (!handler) throw new Error(`unknown task ${task}`);
    const result = await handler(args, job);
    return { ok: true, result, ...timing() };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err), ...timing() };
  }
}
