// A live Level 2 volume that completes, end to end: a real-time chunk volume (ChunkFeed over a fake bucket listing)
// grows, then gets its end chunk, through NexradLayer.refresh and the worker's real Level 2 tasks on a synthetic
// Archive II volume. The completed volume keeps its frame and URL, is read again as complete (its decoder freed),
// leaves rolling mode, and replies of its live reads still in flight are discarded. The full-volume (TGFTP) fallback
// completes the same way without relabelling the next volume.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeArchive2, splitSailsVolume, concat } from './helpers/archive2-writer';

type Run = { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), runs: [] as Run[], index: [] as unknown[], fetched: [] as string[] }));
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchBytes: vi.fn(async (url: string) => { h.fetched.push(url); const b = h.files.get(url); if (!b) throw new Error(`404 ${url}`); return b.slice(); }) }));
vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))); return { pool: { run, for: () => ({ run }) } }; });
vi.mock('../src/radar/sources', async (orig) => ({ ...(await orig<object>()), listL2: vi.fn(async () => h.index) }));
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RadarDraw: class { draw() {} invalidate() {} }, RasterDraw: class { draw() {} invalidate() {} }, Lut: class {},
  uploadSweep: vi.fn(() => ({ tex: { destroy() {}, format: 'r8unorm' }, firstKm: 0, gateKm: 1, gates: 1, rows: 1, az0: 0, spacing: 1, radials: 720, maxRangeKm: 1 })),
}));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { setStyles() {} setLines() {} draw() {} }, PointSet: class { setPoints() {} setAlpha() {} flushAlpha() {} draw() {} },
  TextSet: class { setLabels() {} flushAlpha() {} draw() {} },
}));

import { L2_HANDLERS, configureL2 } from '../src/workers/l2-volumes';
import { fetchBytes } from '../src/data/net';
import { JobClock } from '../src/workers/job-clock';
import { archive2Backend, loadArchive2Wasm } from '../src/decode/archive2-wasm';
import { ChunkFeed, CHUNK_BUCKET } from '../src/radar/chunks';
import { NexradLayer } from '../src/layers/nexrad';
import { settings } from '../src/settings/store';

const WASM = new URL('../rust/archive2/target/wasm32-unknown-unknown/release/cwrv3_archive2.wasm', import.meta.url);
/** The worker's decoders are the WebAssembly ones when the module is built (the TypeScript ones hold nothing to free). */
const RUST = existsSync(WASM);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Answers a held worker request with the real task. */
const answer = async (r: Run) => { h.runs.splice(h.runs.indexOf(r), 1); L2_HANDLERS[r.task](r.args, new JobClock()).then(r.resolve, r.reject); await flush(); };
/** Answers every request (and those they lead to) except the held ones. */
async function settle(hold: (r: Run) => boolean = () => false) {
  await flush();
  for (let r = h.runs.find((x) => !hold(x)); r; r = h.runs.find((x) => !hold(x))) await answer(r);
}
const T = Math.floor(Date.now() / 60e3) * 60e3 - 120e3;
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const volume = (timeMs: number) => writeArchive2({ ...splitSailsVolume(), site: 'KTLX', timeMs });
const radials = (meta: any) => meta.sweeps.map((s: any) => s.radials);

describe('live Level 2 volume completion', () => {
  let snapshot: ReturnType<typeof settings.exportDocument>;
  beforeAll(async () => { if (RUST) { await loadArchive2Wasm(readFileSync(WASM)); expect(archive2Backend().backend).toBe('rust'); } });
  beforeEach(() => {
    snapshot = settings.exportDocument(); h.runs.length = 0; h.files.clear(); h.fetched.length = 0;
    configureL2({ volumes: 10 });
    settings.set('settings.nexradSiteICAO', 'KTLX'); settings.set('layerState.NEXRADOn', true); settings.set('layerState.NEXRADLevel2', true);
    settings.set('layerState.NEXRADLevel2Product', 13); settings.set('settings.nexradLevel2VolumeCountMemory', 5);
    for (const k of ['NEXRADStormTracksOn', 'NEXRADTVSIconsOn', 'NEXRADHAILIconsOn', 'NEXRADMESOIconsOn', 'NEXRADMeltingLayerOn']) settings.set(`layerState.${k}`, false);
  });
  afterEach(() => settings.importDocument(snapshot));

  it('keeps a completed fallback volume cached when a growing read finishes later', async () => {
    const url = 'https://tgftp/KTLX/overlap';
    const parts = volume(T);
    h.files.set(url, concat(parts));
    let release!: (data: Uint8Array) => void;
    const partial = new Promise<Uint8Array>((resolve) => { release = resolve; });
    vi.mocked(fetchBytes).mockReturnValueOnce(partial);
    const meta = (live: boolean) => L2_HANDLERS['l2.meta']({ url, live }, new JobClock());

    const pending = meta(true);
    const complete = await meta(false);
    release(concat(parts.slice(0, 12)));
    expect(await pending).toBe(complete);
    expect(await meta(false)).toBe(complete);
    expect(h.fetched).toEqual([url]);
  });

  const layerWith = (feed: ChunkFeed) => {
    const layer = new NexradLayer({ camera: { cur: { z: 5 } } } as never, {} as never);
    layer.liveScan = true;
    (layer as unknown as { chunkFeed: ChunkFeed }).chunkFeed = feed;
    return layer;
  };

  it('reads the chunk volume again as complete under its own frame, out of rolling mode, discarding stale live replies', async () => {
    settings.set('ext.settings.nexradLevel2Rolling', true);
    const prevUrl = 'https://x/KTLX_prev';
    h.files.set(prevUrl, concat(volume(T - 300e3)));
    h.index = [{ t: T - 300e3, url: prevUrl, live: false, name: 'prev' }];
    const parts = volume(T), keys = parts.map((_, i) => `KTLX/7/${stamp(T)}-${String(i + 1).padStart(3, '0')}-${i === 0 ? 'S' : i === parts.length - 1 ? 'E' : 'I'}`);
    keys.forEach((k, i) => h.files.set(`${CHUNK_BUCKET}/${k}`, parts[i]));
    let listed = 14;
    const layer = layerWith(new ChunkFeed(async (prefix) => (prefix === 'KTLX/' ? { keys: [], prefixes: ['KTLX/7/'] } : { keys: prefix === 'KTLX/7/' ? keys.slice(0, listed) : [], prefixes: [] })));
    const url = `chunks:KTLX/7/${T}`;
    const productRuns: any[] = [];
    const record = () => { for (const r of h.runs) if (r.task === 'l2.product' && !productRuns.includes(r.args)) productRuns.push(r.args); };
    const settleAll = async (hold?: (r: Run) => boolean) => { const p = settle((r) => { record(); return hold?.(r) ?? false; }); await p; record(); };

    // Live: 14 of 17 chunks, built with the previous volume's upper tilts.
    let done = layer.refresh(); await settleAll(); await done;
    const f = layer.l2[layer.l2.length - 1] as any;
    expect(layer.l2.map((x) => x.file.url)).toEqual([prevUrl, url]);
    expect([f.file.live, f.file.chunks.length]).toEqual([true, 14]);
    expect(f.sweep.rolling).toMatchObject({ prevTimeMs: T - 300e3 });
    expect(productRuns.filter((a) => a.url === url).every((a) => a.live && a.rolling?.url === prevUrl)).toBe(true);
    if (RUST) expect(archive2Backend().liveDecoders).toBe(1);

    // Same-frame growth: 16 chunks.
    const before = radials(f.meta);
    listed = 16;
    done = layer.refresh(); await settleAll(); await done;
    expect(layer.l2[layer.l2.length - 1]).toBe(f);
    expect([f.file.live, f.file.chunks.length]).toEqual([true, 16]);
    expect(radials(f.meta)).not.toEqual(before);
    expect(productRuns.at(-1)).toMatchObject({ url, live: true, chunks: keys.slice(0, 16).map((k) => `${CHUNK_BUCKET}/${k}`) });
    const grown = f.sweep;
    expect(grown.rolling).toBeDefined();

    // A live product build (new build parameters) and a live metadata read are still in flight when the end chunk is listed.
    settings.set('settings.nexradAlgorithmHailZLower', settings.num('settings.nexradAlgorithmHailZLower') - 1);
    layer.reloadProducts(); await settleAll((r) => r.task === 'l2.product');
    const staleBuild = h.runs.find((r) => r.task === 'l2.product' && r.args.url === url)!;
    expect(staleBuild.args.live).toBe(true);
    layer.reloadProducts(); await flush();
    const staleMeta = h.runs.find((r) => r.task === 'l2.meta' && r.args.url === url)!;
    expect(staleMeta.args.live).toBe(true);
    listed = 17;
    done = layer.refresh(); await flush();
    const finalMeta = h.runs.find((r) => r.task === 'l2.meta' && r.args !== staleMeta.args)!;
    expect(finalMeta.args).toMatchObject({ url, live: false, chunks: keys.map((k) => `${CHUNK_BUCKET}/${k}`) });
    expect(layer.l2[layer.l2.length - 1]).toBe(f);
    expect([f.file.live, f.meta]).toEqual([false, undefined]); // the partial metadata is not kept for the complete volume
    await answer(staleMeta); await answer(staleBuild);
    expect(f.meta).toBeUndefined();
    expect(f.sweep).toBe(grown); // the live build did not land on the completed volume
    expect(h.runs.filter((r) => r.task === 'l2.product' && r.args.url === url)).toEqual([]);

    await settleAll(); await done;
    expect(h.fetched).toContain(`${CHUNK_BUCKET}/${keys[16]}`);
    expect(f.meta.sweeps.every((s: any) => s.complete)).toBe(true);
    expect(productRuns.at(-1)).toMatchObject({ url, live: false, rolling: undefined });
    expect(f.sweep).not.toBe(grown);
    expect(f.sweep.rolling).toBeUndefined();
    if (RUST) expect(archive2Backend().liveDecoders).toBe(0); // the stream's decoder is freed

    // The completed volume listed again: nothing is read or built again.
    const shown = f.sweep, meta = f.meta;
    done = layer.refresh(); await flush();
    expect(h.runs).toEqual([]);
    await done;
    expect([layer.l2[layer.l2.length - 1], f.sweep, f.meta]).toEqual([f, shown, meta]);
  });

  it('completes the growing full-volume file under its own URL while the next volume goes live', async () => {
    const a = 'https://tgftp/KTLX/A', b = 'https://tgftp/KTLX/B';
    const full = volume(T - 300e3);
    h.files.set(a, concat(full.slice(0, 12)));
    h.index = [{ t: T - 300e3, url: a, live: true, name: 'A' }];
    const layer = layerWith(new ChunkFeed(async () => ({ keys: [], prefixes: [] }))); // no chunk volume: full-volume fallback
    let done = layer.refresh(); await settle(); await done;
    const fa = layer.l2[0] as any;
    expect(layer.liveSource.kind).toBe('full-volume');
    expect([layer.l2.length, fa.file.url, fa.file.live]).toEqual([1, a, true]);
    const partial = radials(fa.meta);

    // A is complete; B is the new growing file.
    h.files.set(a, concat(full));
    h.files.set(b, concat(volume(T).slice(0, 6)));
    h.index = [{ t: T - 300e3, url: a, live: false, name: 'A' }, { t: T, url: b, live: true, name: 'B' }];
    (layer as any).index = null; // the listing is re-read every 60 s
    done = layer.refresh(); await settle(); await done;
    await settle();
    expect(layer.l2[0]).toBe(fa);
    expect(layer.l2.map((x) => [x.file.url, x.file.live])).toEqual([[a, false], [b, true]]);
    expect(fa.meta.volumeTimeMs).toBe(T - 300e3);
    expect(radials(fa.meta)).not.toEqual(partial); // read again: the cached partial read is not the complete file
    expect(fa.meta.sweeps.every((s: any) => s.complete)).toBe(true);
    expect((layer.l2[1] as any).meta.volumeTimeMs).toBe(T);

    // Complete A is cached from now on.
    const fetches = h.fetched.filter((u) => u === a).length;
    done = layer.refresh(); await settle(); await done;
    expect(h.fetched.filter((u) => u === a).length).toBe(fetches);
    expect(layer.l2[0]).toBe(fa);
  });
});
