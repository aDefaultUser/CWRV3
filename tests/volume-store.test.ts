// VolumeStore: a pack is uploaded and returned only under the identity it was requested for; results for another
// site (store cleared) or for a request nobody asks for any more are discarded; uploads are staggered and the store
// stays within its VRAM budget.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Run = { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ runs: [] as Run[] }));
vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))); return { pool: { run, for: () => ({ run }) } }; });

import { VolumeStore, packKey, type PackRequest } from '../src/render/volume';
import { Gpu } from '../src/render/gpu';
import { PACK_ROWS, OCC_N, OCC_IMAGES, type VolumePack } from '../src/radar/volume-pack';
import { NexradLayer } from '../src/layers/nexrad';
import { settings } from '../src/settings/store';

Object.assign(globalThis, { GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, COPY_SRC: 1 }, GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 } });

function fakeRenderer() {
  type Tex = { size: number[]; destroyed: boolean };
  /** `textures` are the tilt textures and `layerWrites` their uploads; the occupancy grids are listed apart. */
  const log = { textures: [] as Tex[], occupancy: [] as (Tex & { written: number })[], layerWrites: [] as number[], bufferWrites: [] as { offset: number; data: Float32Array }[] };
  const device = {
    createTexture: (d: { size: number[]; label: string }) => {
      const t = { size: d.size, destroyed: false, written: 0, destroy() { t.destroyed = true; }, createView: () => ({}) };
      (d.label.startsWith('occupancy') ? log.occupancy : log.textures).push(t);
      return t;
    },
    createBuffer: () => ({ destroy() {} }),
    createBindGroup: () => ({}),
    queue: {
      writeTexture: (dst: { texture: Tex & { written: number }; origin?: number[] }, data: Uint8Array) => { if (dst.origin) log.layerWrites.push(dst.origin[2]); else dst.texture.written += data.length; },
      writeBuffer: (_b: unknown, offset: number, data: Float32Array) => { log.bufferWrites.push({ offset, data }); },
    },
  };
  const gpu = new Gpu({} as HTMLCanvasElement);
  gpu.device = device as never;
  return { r: { gpu, layouts: { volume: {} } } as never, gpu, log };
}

const OCC_BYTES = OCC_N * OCC_N * OCC_IMAGES;
const pack = (tilts: number, width = 100): VolumePack => ({
  moment: 'REF', width,
  tilts: Array.from({ length: tilts }, (_, k) => ({ sweep: k, elevation: 0.5 + k, firstKm: 2.125, gateKm: 0.25, gates: width, radials: 720, startMs: 1000 + k * 20000, endMs: 15000 + k * 20000 })),
  layers: Array.from({ length: tilts }, () => new Uint8Array(PACK_ROWS * width)),
  occupancy: new Uint8Array(OCC_BYTES), occKm: 0.4,
});
const req = (over: Partial<PackRequest> = {}): PackRequest => ({ site: 'KTLX', url: 'https://x/KTLX_1', live: false, moment: 'REF', latest: false, qualityDealiasing: true, lon: -97.28, lat: 35.33, heightKm: 0.37, ...over });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => { h.runs.length = 0; });

describe('pack identity', () => {
  it('is site | volume | moment | algorithm inputs | tilt set', () => {
    expect(packKey(req())).toBe('KTLX|https://x/KTLX_1|REF||first');
    expect(packKey(req({ moment: 'VEL', latest: true }))).toBe('KTLX|https://x/KTLX_1|VEL|true|latest');
    expect(packKey(req({ qualityDealiasing: false }))).toBe(packKey(req())); // dealiasing only enters velocity
    expect(packKey(req({ moment: 'VEL', qualityDealiasing: false }))).not.toBe(packKey(req({ moment: 'VEL' })));
    expect(packKey(req({ live: true, version: '9/312' }))).toBe('KTLX|https://x/KTLX_1|REF||first:9/312');
  });
});

describe('VolumeStore', () => {
  it('requests once, uploads at most two tilt layers per frame and returns the pack only when all are uploaded', async () => {
    const { r, gpu, log } = fakeRenderer(), store = new VolumeStore(r, 'nexrad');
    expect(store.get(req())).toBeNull();
    expect(store.get(req())).toBeNull();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].task).toBe('l2.volume');
    expect(h.runs[0].args).toEqual({ url: 'https://x/KTLX_1', live: false, chunks: undefined, moment: 'REF', latest: false, qualityDealiasing: true });
    h.runs[0].resolve({ pack: pack(5) }); await flush();
    expect(log.textures[0].size).toEqual([100, PACK_ROWS, 5]);
    expect(store.state(req())).toBe('uploading');
    for (const [frame, done] of [[1, 2], [2, 4]] as const) { store.pump(); expect(log.layerWrites).toHaveLength(done); expect(store.get(req()), `frame ${frame}`).toBeNull(); }
    store.pump();
    expect(log.layerWrites).toEqual([0, 1, 2, 3, 4]);
    const p = store.get(req())!;
    expect(p.key).toBe(packKey(req()));
    expect(p.tilts).toHaveLength(5);
    expect(p.timeMs).toBe(1000);
    // The occupancy grid is uploaded whole with the pack and counted with its textures.
    expect(log.occupancy.map((t) => [t.size, t.written])).toEqual([[[OCC_N, OCC_N, OCC_IMAGES], OCC_BYTES]]);
    expect([p.occ, p.occKm, p.bytes]).toEqual([log.occupancy[0], 0.4, 100 * PACK_ROWS * 5 + OCC_BYTES]);
    expect(gpu.textureBytes.get('nexrad')).toBe(p.bytes);
    expect(gpu.uploads.get('nexrad')!.count).toBe(6);
    // Uniform: site and grid head, then the tilt table with scan times relative to the pack time.
    const u = log.bufferWrites[0].data;
    expect(Array.from(u.subarray(0, 8))).toEqual([Math.fround(-97.28), Math.fround(35.33), Math.fround(0.37), 5, 100, PACK_ROWS, 1, 0]);
    expect(Array.from(u.subarray(12 + 12, 12 + 24))).toEqual([1.5, 2.125, 0.25, 100, 720, 20, 34, 0, Math.fround(Math.cos((1.5 * Math.PI) / 180)), Math.fround(Math.sin((1.5 * Math.PI) / 180)), 0, 0]);
  });

  it('discards a result that arrives after the site changed (store cleared)', async () => {
    const { r, log } = fakeRenderer(), store = new VolumeStore(r, 'nexrad');
    store.get(req());
    store.clear();
    h.runs[0].resolve({ pack: pack(3) }); await flush();
    expect(log.textures).toHaveLength(0);
    expect(store.get(req({ site: 'KINX', url: 'https://x/KINX_1' }))).toBeNull();
    expect(h.runs).toHaveLength(2);
    expect(store.bytes).toBe(0);
  });

  it('discards a result for a product nobody asks for any more and never returns it for another request', async () => {
    const { r, log } = fakeRenderer(), store = new VolumeStore(r, 'nexrad');
    store.get(req({ moment: 'REF' }));
    // The view switches to velocity: only that pack is asked for from now on.
    for (let i = 0; i < 5; i++) { expect(store.get(req({ moment: 'VEL' }))).toBeNull(); store.pump(); }
    const [ref, vel] = h.runs;
    ref.resolve({ pack: pack(3) }); await flush();
    expect(log.textures).toHaveLength(0); // the reflectivity result is dropped, not uploaded
    vel.resolve({ pack: { ...pack(2), moment: 'VEL' } }); await flush();
    store.pump();
    expect(store.get(req({ moment: 'VEL' }))!.moment).toBe('VEL');
    expect(log.textures).toHaveLength(1);
    expect(store.get(req({ moment: 'REF' }))).toBeNull(); // asked again: a new request, not the velocity pack
    expect(h.runs).toHaveLength(3);
  });

  it('abandons an upload nobody asks for and frees its texture', async () => {
    const { r, gpu, log } = fakeRenderer(), store = new VolumeStore(r, 'nexrad');
    store.get(req());
    h.runs[0].resolve({ pack: pack(8) }); await flush();
    store.pump();
    expect(log.layerWrites).toHaveLength(2);
    for (let i = 0; i < 4; i++) store.pump(); // no get(): two more frames of uploads, then the pack is stale
    expect(log.layerWrites.length).toBeLessThan(8);
    expect([log.textures[0].destroyed, log.occupancy[0].destroyed]).toEqual([true, true]);
    expect(gpu.textureBytes.get('nexrad')).toBe(0);
  });

  it('keeps packs least-recently-used within the VRAM budget', async () => {
    const one = 100 * PACK_ROWS * 2 + OCC_BYTES;
    const { r, log } = fakeRenderer(), store = new VolumeStore(r, 'nexrad', 2.5 * one);
    const load = async (url: string) => { store.get(req({ url })); h.runs[h.runs.length - 1].resolve({ pack: pack(2) }); await flush(); store.pump(); expect(store.get(req({ url }))).not.toBeNull(); };
    await load('a'); await load('b');
    for (let i = 0; i < 3; i++) { store.get(req({ url: 'b' })); store.pump(); } // b is in use, a is not
    await load('c');
    expect(store.bytes).toBe(2 * one);
    expect(log.textures.map((t) => t.destroyed)).toEqual([true, false, false]);
    const before = h.runs.length;
    expect(store.get(req({ url: 'b' }))).not.toBeNull();
    expect(store.get(req({ url: 'a' }))).toBeNull(); // evicted: requested again
    expect(h.runs.length).toBe(before + 1);
  });

  it('reports a missing moment, retries a failed request later, and changes storm motion without a new pack', async () => {
    const { r, log } = fakeRenderer(), store = new VolumeStore(r, 'nexrad');
    store.get(req({ moment: 'KDP' }));
    h.runs[0].resolve({ pack: null }); await flush();
    expect(store.state(req({ moment: 'KDP' }))).toBe('moment not in this volume');
    expect(store.get(req({ moment: 'KDP' }))).toBeNull();
    expect(h.runs).toHaveLength(1);
    const now = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 11_000);
    store.get(req({ moment: 'KDP' }));
    expect(h.runs).toHaveLength(2);
    now.mockRestore();

    store.get(req({ moment: 'VEL' }));
    h.runs[2].resolve({ pack: { ...pack(1), moment: 'VEL' } }); await flush();
    store.pump();
    const p = store.get(req({ moment: 'VEL' }))!, writes = log.bufferWrites.length;
    store.setMotion(p, { speedKt: 30, fromDeg: 240 });
    store.setMotion(p, { speedKt: 30, fromDeg: 240 });
    expect(log.bufferWrites.slice(writes).map((w) => [w.offset, ...w.data])).toEqual([[32, 30, 240, 1, 0]]);
    expect(h.runs).toHaveLength(3);
    expect(log.textures).toHaveLength(1);
  });
});

describe('NEXRAD layer volume packs', () => {
  it('requests the pack of the drawn volume under the current settings and clears the store on a site change', async () => {
    const { r } = fakeRenderer();
    const layer = new NexradLayer(r, {} as never);
    expect(layer.volumePack('REF')).toBeNull(); // nothing drawn yet
    expect(h.runs).toHaveLength(0);
    const snapshot = settings.exportDocument();
    try {
      settings.set('settings.nexradSiteICAO', 'KTLX'); settings.set('layerState.NEXRADLevel2', true);
      settings.set('settings.nexradLatestUpdateMode', 1); settings.set('settings.nexradQualityDealiasing', false);
      const frame = { t: 1, file: { t: 1, url: 'https://x/KTLX_1', live: false, name: 'v' } };
      Object.assign(layer, { l2: [frame], lastDrawn: frame });
      expect(layer.volumePack('VEL')).toBeNull();
      expect(h.runs[0].args).toMatchObject({ url: 'https://x/KTLX_1', moment: 'VEL', latest: true, qualityDealiasing: false });
      settings.set('settings.nexradLatestUpdateMode', 0); // another tilt set: another request, read each call
      layer.volumePack('VEL');
      expect(h.runs[1].args).toMatchObject({ moment: 'VEL', latest: false });
      layer.freeAll();
      h.runs[1].resolve({ pack: { ...pack(2), moment: 'VEL' } }); await flush();
      expect(layer.volumes.bytes).toBe(0);
    } finally { settings.importDocument(snapshot); }
  });
});

describe('live volume states', () => {
  it('keeps the previous state of a live volume in use until the newer one is uploaded, then frees it', async () => {
    const { r, log } = fakeRenderer(), store = new VolumeStore(r, 'nexrad');
    const state = (version: string) => req({ url: 'chunks:KTLX/271', live: true, version });
    store.get(state('3/240'));
    h.runs[0].resolve({ pack: pack(3) }); await flush();
    store.pump(); store.pump();
    const first = store.get(state('3/240'))!;
    expect(first.tilts).toHaveLength(3);
    // More radials arrive: the new state is requested while the old pack is still returned.
    expect(store.get(state('4/120'))).toBe(first);
    expect(h.runs).toHaveLength(2);
    h.runs[1].resolve({ pack: pack(4) }); await flush();
    store.pump();
    expect(store.get(state('4/120'))).toBe(first); // two of four layers uploaded
    expect(log.textures[0].destroyed).toBe(false);
    store.pump();
    const second = store.get(state('4/120'))!;
    expect(second.tilts).toHaveLength(4);
    expect(log.textures.map((t) => t.destroyed)).toEqual([true, false]);
    // Another volume, moment or tilt set never gets it.
    expect(store.get(req({ url: 'chunks:KTLX/272', live: true, version: '1/120' }))).toBeNull();
    expect(store.get({ ...state('4/120'), moment: 'ZDR' })).toBeNull();
    expect(store.get({ ...state('4/120'), latest: true })).toBeNull();
  });
});
