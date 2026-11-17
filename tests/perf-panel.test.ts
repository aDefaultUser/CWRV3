// Performance panel: honest units and "N/A" for what the browser does not provide; global frame figures, and one row
// per owner with its decode jobs, uploads, live texture memory and layer status.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { perfRows, ownerMatrix, OWNER_COLUMNS, PerfPanel, type PerfSnapshot } from '../src/perf/panel';
import { Gpu } from '../src/render/gpu';
import { Lut } from '../src/render/raster';
import { parsePalette } from '../src/render/palette';
import { TileCache } from '../src/render/tiles';
import { FrameMeter } from '../src/perf/meter';
import { WorkerPool, type WorkerLike } from '../src/workers/pool';
import { runJob, type JobHandler } from '../src/workers/job-clock';

const base = (over: Partial<PerfSnapshot> = {}): PerfSnapshot => ({
  frames: FrameMeter.stats([]), totalFrames: 0, gpuMs: null, heap: null, textureBytes: 0, textures: [], uploads: [], jobs: [], layers: [], timeline: 'General timeline', workers: 2, ...over,
});
const value = (rows: [string, string, string][], label: string) => rows.find((r) => r[1].startsWith(label))?.[2];
/** The owner matrix as { owner: { column: value } }. */
const matrix = (s: PerfSnapshot) => Object.fromEntries(ownerMatrix(s).map((r) => [r[0], Object.fromEntries(OWNER_COLUMNS.map((c, i) => [c.split(':')[0].split(' (')[0], r[i]]))]));

describe('performance panel', () => {
  it('shows N/A, not zero, for missing frame samples, GPU timestamps and heap', () => {
    const rows = perfRows(base());
    expect(value(rows, 'Rendered frame rate')).toBe('N/A');
    expect(value(rows, 'GPU main pass')).toBe('N/A (no timestamp-query feature)');
    expect(value(rows, 'JS heap')).toBe('N/A (performance.memory unavailable)');
  });

  it('labels units: fps, ms, MB, CPU submission (not GPU) time for uploads', () => {
    const m = new FrameMeter();
    for (let i = 0; i <= 60; i++) m.frame(1000 + i * 16.7, 2, 1);
    const rows = perfRows(base({ frames: m.summary(2000), totalFrames: m.total, gpuMs: 0.8, heap: { used: 50 * 1048576, limit: 4096 * 1048576 }, textureBytes: 3 * 1048576,
      uploads: [['nexrad', { count: 4, bytes: 2 * 1048576, cpuMs: 1.25 }]] }));
    expect(value(rows, 'Rendered frame rate')).toMatch(/^59\.\d fps$/);
    expect(value(rows, 'GPU main pass')).toBe('0.8 ms');
    expect(value(rows, 'JS heap')).toBe('50.0 MB / 4096.0 MB');
    expect(value(rows, 'Tracked texture memory, all owners')).toBe('3.0 MB');
    expect(matrix(base({ uploads: [['nexrad', { count: 4, bytes: 2 * 1048576, cpuMs: 1.25 }]] })).nexrad['Texture uploads since start']).toBe('4, 2.0 MB, 1.3 ms');
    expect(OWNER_COLUMNS).toContain('Texture uploads since start: count, MB, CPU submit (not GPU)');
    expect(m.total).toBe(60);
  });

  it('attributes worker jobs to the owner that submitted them, not by task name', async () => {
    const workers: WorkerLike[] = [];
    const pool = new WorkerPool(1, () => { const w: WorkerLike = { onmessage: null, onerror: null, onmessageerror: null, postMessage: (m: any) => queueMicrotask(() => w.onmessage!({ data: { id: m.id, ok: m.task !== 'bad', result: null, error: 'x', ms: 5, bytes: 100 } } as MessageEvent)), terminate() {} }; workers.push(w); return w; });
    // Both the main NEXRAD layer and the custom radar run Level 2 tasks; each is counted under its own owner.
    await pool.for('nexrad').run('l2.product', {});
    await pool.for('customRadar').run('l2.product', {});
    await pool.for('customRadar').run('bad', {}).catch(() => {});
    const o = Object.fromEntries(pool.owners);
    expect([o.nexrad.jobs, o.nexrad.errors, o.nexrad.bytes]).toEqual([1, 0, 100]);
    expect([o.customRadar.jobs, o.customRadar.errors, o.customRadar.inFlight]).toEqual([2, 1, 0]);
    const row = matrix(base({ jobs: [...pool.owners] })).customRadar;
    // A worker that reports no processing time shows N/A, never its fetch + decode wall time.
    expect([row['Decode jobs'], row['Decode mean / max'], row['Worker fetch + decode mean / max']]).toEqual(['2 / 0 / 1', 'N/A', '5.0 ms / 5.0 ms']);
  });
});

describe('per-layer decode time', () => {
  // A controllable clock: a "fetch" advances it while the job awaits; a decode advances it synchronously.
  let t = 0;
  const now = () => t;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fetchFor = async (ms: number) => { await tick(); t += ms; return new Uint8Array(4); };
  const decodeFor = (ms: number) => { t += ms; return { codes: new Uint8Array(8) }; };
  const handlers: Record<string, JobHandler> = {
    // Level 2 style: fetch 100 ms, then decode 4 ms.
    volume: async (_a, job) => { await fetchFor(100); return job.time(() => decodeFor(4)); },
    // Two decode sections around a fetch: 10 ms, a 50 ms fetch, 2 ms.
    grids: async (_a, job) => { job.time(() => decodeFor(10)); await fetchFor(50); return job.time(() => decodeFor(2)); },
    cached: async () => ({ codes: new Uint8Array(1) }),
    // Asynchronous sections (stream inflate, WASM): counted once while they overlap, marked as wall time.
    inflate: async (_a, job) => {
      const part = (ms: number) => job.time(async () => { t += 1; await tick(); t += ms; });
      await Promise.all([part(2), part(3)]);
      return null;
    },
  };
  const timed = new Set(['volume', 'grids', 'cached', 'inflate']);
  /** A pool whose single worker runs each message through runJob, as decode.worker.ts does. */
  const pool = () => new WorkerPool(1, () => {
    const w: WorkerLike = { onmessage: null, onerror: null, onmessageerror: null, terminate() {},
      postMessage: (m: any) => void runJob(handlers[m.task], m.task, m.args, timed.has(m.task), now).then((reply) => w.onmessage!({ data: { id: m.id, ...reply, bytes: 0 } } as MessageEvent)) };
    return w;
  });

  it('counts decode time without the network wait: fetch 100 ms + decode 4 ms is 4 ms, not 104', async () => {
    t = 0;
    const r = await runJob(handlers.volume, 'volume', {}, true, now);
    expect([r.ok, r.ms, r.procMs, r.procWall]).toEqual([true, 104, 4, false]);
  });

  it('keeps concurrent owners on one worker apart', async () => {
    t = 0;
    const p = pool();
    await Promise.all([p.for('nexrad').run('volume', {}), p.for('model').run('grids', {})]);
    const o = Object.fromEntries(p.owners);
    expect([o.nexrad.procMs, o.nexrad.procJobs, o.model.procMs, o.model.procJobs]).toEqual([4, 1, 12, 1]);
    // The handlers' wall time includes each other's fetches; the decode time does not.
    expect(o.nexrad.execMs).toBeGreaterThanOrEqual(104);
    expect(o.model.execMs).toBeGreaterThanOrEqual(62);
    const row = matrix(base({ jobs: [...p.owners] })).nexrad;
    expect([row['Decode jobs'], row['Decode mean / max']]).toEqual(['1 / 0 / 0', '4.0 ms / 4.0 ms']);
    expect(row['Worker fetch + decode mean / max']).toMatch(/^1\d\d\.\d ms \//);
  });

  it('reports 0 for a known cache hit, N/A for an untimed task and labels async wall time', async () => {
    t = 0;
    expect((await runJob(handlers.cached, 'cached', {}, true, now)).procMs).toBe(0);
    expect((await runJob(handlers.cached, 'cached', {}, false, now)).procMs).toBeNull();
    const a = await runJob(handlers.inflate, 'inflate', {}, true, now);
    expect([a.procMs, a.procWall]).toEqual([7, true]); // 1 + 1 + 2 + 3 while either section is open
    const failed = await runJob(undefined, 'missing', {}, true, now);
    expect([failed.ok, failed.error, failed.procMs]).toEqual([false, 'unknown task missing', 0]);

    const p = pool();
    await p.for('mrms').run('inflate', {});
    await p.for('mrms').run('cached', {});
    expect(matrix(base({ jobs: [...p.owners] })).mrms['Decode mean / max']).toBe('3.5 ms / 7.0 ms (1 with async wall)');
  });
});

describe('per-owner texture memory', () => {
  afterEach(() => vi.unstubAllGlobals());
  /** A Gpu over a stand-in device: textures are plain objects with a destroy() that counts calls. */
  function gpu() {
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, STORAGE_BINDING: 8 });
    const g = new Gpu({} as HTMLCanvasElement);
    const destroyed: object[] = [];
    g.device = { createTexture: () => { const t = { destroy: () => destroyed.push(t) }; return t; }, queue: { writeTexture() {}, copyExternalImageToTexture() {} } } as never;
    return { g, destroyed };
  }

  it('adds live bytes per owner on creation and subtracts them once on destroy, including palette LUTs and basemap atlases', () => {
    const { g, destroyed } = gpu();
    const a = g.texture2D(100, 50, 'r8unorm', new Uint8Array(5000), 1, 'nexrad');
    const b = g.texture2D(10, 10, 'r32float', new Float32Array(100), 4, 'nexrad');
    g.texture2D(20, 20, 'r16float', null, 2, 'model');
    const lut = new Lut({ gpu: g } as never, parsePalette('test\n0,0,0,255|0\n255,255,255,255|1'), { low: 0, high: 1 });
    new TileCache({ gpu: g } as never, () => '', 8, () => {}); // imagery atlas: 256 slots with mips
    new TileCache({ gpu: g } as never, () => '', 11, () => {}, true); // terrain atlas: one level
    const atlas = 256 * 256 * 4 * 256, mips = atlas * (1 + 1 / 4 + 1 / 16 + 1 / 64 + 1 / 256 + 1 / 1024 + 1 / 4096 + 1 / 16384 + 1 / 65536); // 256² … 1²
    expect(Object.fromEntries(g.textureBytes)).toEqual({ nexrad: 5400, model: 800, 'palette LUTs': 1024 * 4, basemap: mips + atlas });
    expect(g.trackedTextureBytes).toBe(5400 + 800 + 4096 + mips + atlas);
    a.destroy(); a.destroy(); lut.destroy();
    expect(destroyed.length).toBe(3); // the device texture is still destroyed each time
    expect([g.textureBytes.get('nexrad'), g.textureBytes.get('palette LUTs')]).toEqual([400, 0]);
    b.destroy();
    // An owner whose textures were all released shows 0, an owner that never had one N/A; uploads stay cumulative.
    const m = matrix(base({ textures: [...g.textureBytes], uploads: [...g.uploads], layers: [{ id: 'warnings', state: 'ready', text: '' }] }));
    expect(m.nexrad['Live texture memory']).toBe('0.0 MB');
    expect(m.nexrad['Texture uploads since start']).toMatch(/^2, 5\.3 KB, \d+\.\d ms$/);
    expect(m['palette LUTs']['Texture uploads since start']).toMatch(/^1, 4\.0 KB, /);
    expect([m.warnings['Live texture memory'], m.warnings['Decode jobs'], m.warnings['Layer status']]).toEqual(['N/A', 'N/A', 'ready']);
    expect(m.model['Layer status']).toBe('N/A (not an enabled layer)');
    expect(m.basemap['Live texture memory']).toBe(`${((mips + atlas) / 1048576).toFixed(1)} MB`);
  });

  it('lists the union of job, upload, texture and layer owners once each', () => {
    const owners = ownerMatrix(base({
      layers: [{ id: 'nexrad', state: 'ready', frames: 12, text: 'KTLX' }], textures: [['nexrad', 10], ['basemap', 20]],
      uploads: [['nexrad', { count: 1, bytes: 1, cpuMs: 0 }], ['palette LUTs', { count: 1, bytes: 1, cpuMs: 0 }]],
      jobs: [['mrms', { jobs: 1, errors: 0, inFlight: 0, execMs: 1, waitMs: 0, maxExecMs: 1, bytes: 0, lastTask: '', lastMs: 0, procMs: 0, procJobs: 0, maxProcMs: 0, procWallJobs: 0 }]],
    })).map((r) => r[0]);
    expect(owners).toEqual(['nexrad', 'mrms', 'palette LUTs', 'basemap']);
  });
});

describe('panel toggle', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('samples only while shown and stops when hidden', () => {
    vi.useFakeTimers();
    class El {
      style: Record<string, string> = {}; children: El[] = []; textContent = ''; className = ''; colSpan = 1;
      setAttribute() {} appendChild(c: El) { this.children.push(c); return c; } replaceChildren(...c: El[]) { this.children = c; }
      insertRow() { return this.appendChild(new El()); } insertCell() { return this.appendChild(new El()); }
    }
    vi.stubGlobal('document', { createElement: () => new El() });
    let snapshots = 0;
    const p = new PerfPanel(new El() as never, () => { snapshots++; return base({ layers: [{ id: 'nexrad', state: 'ready', text: '' }] }); }, 500);
    vi.advanceTimersByTime(5000);
    expect(snapshots).toBe(0);
    p.toggle();
    vi.advanceTimersByTime(1000);
    expect([snapshots, p.visible]).toEqual([3, true]);
    const tables = (p.el as unknown as El).children;
    expect(tables.length).toBe(2);
    expect(tables[1].children.at(-1)!.children[0].textContent).toBe('nexrad'); // the owner matrix row
    p.toggle();
    vi.advanceTimersByTime(5000);
    expect([snapshots, p.visible, p.el.style.display]).toEqual([3, false, 'none']);
  });
});
