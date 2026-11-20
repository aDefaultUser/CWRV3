// Worldwide radar (RainViewer): frame-list validation (a real weather-maps.json of 2026-11-20 18:58 UTC), tile URLs,
// the request budget and back-off, the overlay tile atlas under pans, frame changes and failures, the terms gate, stale
// frame lists, and where new layers land in a saved layer order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({ texts: [] as { url: string; resolve: (v: string) => void; reject: (e: Error) => void }[] }));
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchText: vi.fn((url: string) => new Promise((resolve, reject) => h.texts.push({ url, resolve, reject }))) }));
vi.mock('../src/render/raster', async (orig) => ({ ...(await orig<object>()), Lut: class {} }));
import { parseWeatherMaps, radarTileUrl, coverageTileUrl, WorldRadarLayer, RV_MAPS_URL, RV_HOST, RV_BUDGET_PER_MIN, RV_REACH_MS, RV_ATLAS_SLOTS, RV_TILE_PX } from '../src/layers/world-radar';
import { Camera } from '../src/render/camera';
import { OverlayTileCache, RequestBudget, retryAfterMs, TILE_TIMEOUT_MS } from '../src/render/overlay-tiles';
import { mergeLayerOrder, DEFAULT_ORDER } from '../src/app/stores';
import { settings } from '../src/settings/store';
import { HttpError } from '../src/data/net';
import { timeline } from '../src/app/timeline';

const sample = () => JSON.parse(readFileSync(new URL('./fixtures/rainviewer/weather-maps-20261120T1858Z.json', import.meta.url), 'utf8'));

describe('RainViewer frame list', () => {
  it('accepts the live document: 13 past frames, 10 minutes apart, on the one tile host', () => {
    const l = parseWeatherMaps(sample());
    expect(l.frames.length).toBe(13);
    expect(l.frames.every((f, i) => i === 0 || f.t - l.frames[i - 1].t === 600e3)).toBe(true);
    expect(l.frames[12]).toEqual({ t: 1795200600e3, path: '/v2/radar/ff31101ef700' });
    expect(l.generatedMs).toBe(1795200935e3);
  });
  it('rejects another tile host and drops frames with unexpected paths or times', () => {
    expect(() => parseWeatherMaps({ ...sample(), host: 'https://tilecache.rainviewer.com.evil.example' })).toThrow(/tile host/);
    expect(() => parseWeatherMaps({ ...sample(), host: 'http://tilecache.rainviewer.com' })).toThrow(/tile host/);
    const doc = sample();
    doc.radar.past = [
      { time: 1795200600, path: '/v2/radar/ff31101ef700' }, { time: 1795200000, path: '//evil.example/x' }, { time: 1795199400, path: '/v2/radar/../../x' },
      { time: '1795198800', path: '/v2/radar/abcdef12' }, { time: 1795198200.5, path: '/v2/radar/abcdef12' }, { time: 1795197600, path: '/v2/radar/0aa17468fa7e?x=1' },
    ];
    expect(parseWeatherMaps(doc).frames).toEqual([{ t: 1795200600e3, path: '/v2/radar/ff31101ef700' }]);
    doc.radar.past = [{ time: 1, path: 'x' }];
    expect(() => parseWeatherMaps(doc)).toThrow(/no radar frames/);
  });
  it('builds the verified tile URL form (512 px, scheme 2, smoothing option, no snow) and the coverage mask URL', () => {
    expect(radarTileUrl('/v2/radar/ff31101ef700', 2, 3, 1, false)).toBe(`${RV_HOST}/v2/radar/ff31101ef700/512/2/3/1/2/0_0.png`);
    expect(radarTileUrl('/v2/radar/ff31101ef700', 5, 16, 10, true)).toBe(`${RV_HOST}/v2/radar/ff31101ef700/512/5/16/10/2/1_0.png`);
    expect(coverageTileUrl(5, 16, 10)).toBe(`${RV_HOST}/v2/coverage/0/512/5/16/10/0/0_0.png`);
  });
});

describe('request budget', () => {
  it('allows the limit per rolling window, then waits for the oldest request to leave it', () => {
    let now = 0;
    const b = new RequestBudget(80, 60_000, () => now);
    for (let i = 0; i < 80; i++) { now += 100; expect(b.take()).toBe(true); }
    expect(b.take()).toBe(false);
    now = 60_100; expect(b.take()).toBe(true); // the first request (t = 100) left the window
    expect(b.take()).toBe(false);
  });
  it('pauses after a rate-limit answer, for Retry-After when given, else a doubling back-off', () => {
    let now = 0;
    const b = new RequestBudget(80, 60_000, () => now);
    b.limited();
    expect(b.take()).toBe(false);
    expect(b.pausedFor()).toBe(60_000);
    now = 60_000; expect(b.take()).toBe(true);
    b.limited(); expect(b.pausedFor()).toBe(120_000);
    now = 200_000; b.ok(); b.limited(); expect(b.pausedFor()).toBe(60_000);
    b.limited(5_000); expect(b.pausedFor()).toBe(60_000); // a shorter Retry-After does not shorten a running pause
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs('Fri, 20 Nov 2026 19:00:30 GMT', Date.UTC(2026, 10, 20, 19))).toBe(30_000);
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------- tile atlas
type Pending = { url: string; signal?: AbortSignal; resolve: (status?: number) => void; reject: () => void; stall: () => void };
let pending: Pending[] = [];
let fetchTimes: number[] = [];
let inFlight = 0, maxInFlight = 0;
let clock = 0;
beforeEach(() => {
  pending = []; fetchTimes = []; inFlight = 0; maxInFlight = 0; clock = 0;
  // Like the browser's fetch, an abort rejects the request or, after the headers, the body being read.
  vi.stubGlobal('fetch', (url: string, { signal }: { signal?: AbortSignal } = {}) => {
    fetchTimes.push(clock); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    let open = true;
    const done = () => { if (open) { open = false; inFlight--; } };
    const aborted = new Promise<never>((_, rej) => signal?.addEventListener('abort', () => { done(); rej(new DOMException('aborted', 'AbortError')); }));
    aborted.catch(() => {});
    const answer = (status: number, blob: () => Promise<Blob>) => ({ ok: status === 200, status, headers: new Headers(), blob });
    return Promise.race([aborted, new Promise((res, rej) => pending.push({
      url, signal,
      resolve: (status = 200) => { done(); res(answer(status, async () => new Blob())); },
      reject: () => { done(); rej(new TypeError('network')); },
      stall: () => res(answer(200, () => aborted)), // headers arrive, the body never does
    }))]);
  });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 256, height: 256, close() {} }));
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const gpu = () => ({ gpu: { device: { createTexture: () => ({ destroy() {} }), queue: { copyExternalImageToTexture: () => {} } }, trackTexture: () => {}, recordUpload: () => {} } }) as never;
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const settleAll = async (status = 200) => { for (const p of pending.splice(0)) p.resolve(status); await flush(); };

describe('overlay tile atlas', () => {
  it('stays within the budget and the concurrency limit through a minute of panning and frame changes', async () => {
    const budget = new RequestBudget(RV_BUDGET_PER_MIN, 60_000, () => clock);
    const c = new OverlayTileCache(gpu(), budget, () => {});
    for (let step = 0; step < 600; step++) {
      clock = step * 300; // 3 minutes at ~3 frames per second
      const frame = `/v2/radar/${(Math.floor(step / 40) % 13).toString(16).padStart(6, '0')}`;
      for (let i = 0; i < 20; i++) c.lookup(frame, 6, 10 + ((step + i) % 30), 20 + (i % 5), () => `https://x/${frame}/${i}`, step + 1, i);
      c.pump(step + 1);
      if (step % 3 === 0) await settleAll();
    }
    expect(maxInFlight).toBeLessThanOrEqual(4);
    for (const t of fetchTimes) expect(fetchTimes.filter((u) => u > t - 60_000 && u <= t).length).toBeLessThanOrEqual(RV_BUDGET_PER_MIN);
    expect(fetchTimes.length).toBeGreaterThan(150); // the budget is used, not starved
  });

  it('draws a missing tile from an ancestor of the same frame only, never from another frame', async () => {
    const c = new OverlayTileCache(gpu(), new RequestBudget(80, 60_000, () => clock), () => {});
    c.lookup('A', 4, 5, 6, () => 'A/4/5/6', 1, 0);
    c.lookup('B', 5, 10, 12, () => 'B/5/10/12', 1, 1);
    c.pump(1); await settleAll();
    const hit = c.lookup('A', 6, 21, 25, () => 'A/6/21/25', 2, 0)!;
    expect(hit.z).toBe(4); // A's level-4 ancestor, although B has a closer one
    expect([hit.u0, hit.v0, hit.scale]).toEqual([1 / 4, 1 / 4, 1 / 4]);
    expect(c.lookup('C', 5, 10, 12, () => 'C/5/10/12', 2, 0)).toBeNull(); // only B has this tile: nothing for C
    c.pump(2);
    expect(pending.map((p) => p.url).sort()).toEqual(['A/6/21/25', 'C/5/10/12']);
  });

  it('fetches only tiles still asked for: a tile panned away before the budget allows it is never requested', () => {
    const budget = new RequestBudget(3, 60_000, () => clock);
    const c = new OverlayTileCache(gpu(), budget, () => {});
    for (let i = 0; i < 5; i++) c.lookup('A', 5, i, 0, () => `A/${i}`, 1, i);
    c.pump(1);
    expect(pending.map((p) => p.url)).toEqual(['A/0', 'A/1']);
    expect(budget.take()).toBe(true); // tiles leave the last request of the window to the frame list
    clock = 61_000;
    c.lookup('A', 5, 9, 9, () => 'A/9', 2, 0);
    c.pump(2);
    expect(pending.map((p) => p.url)).toEqual(['A/0', 'A/1', 'A/9']);
  });

  it('stops every request after a rate-limit answer until the back-off ends', async () => {
    const budget = new RequestBudget(80, 60_000, () => clock);
    const c = new OverlayTileCache(gpu(), budget, () => {});
    c.lookup('A', 5, 1, 1, () => 'A/1', 1, 0); c.pump(1);
    await settleAll(429);
    expect(c.lastError).toMatch(/429/);
    for (let f = 2; f < 50; f++) { clock = f * 1000; c.lookup('A', 5, 2, f, () => `A/${f}`, f, 0); c.pump(f); }
    expect(fetchTimes.length).toBe(1);
    clock = 61_000; c.lookup('A', 5, 3, 3, () => 'A/3', 61, 0); c.pump(61);
    expect(fetchTimes.length).toBe(2);
  });

  it('aborts a request whose body stalls, so stuck tiles never hold the concurrency slots', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const micro = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    let loads = 0;
    const c = new OverlayTileCache(gpu(), new RequestBudget(80, 60_000, () => clock), () => loads++);
    for (let i = 0; i < 4; i++) c.lookup('A', 5, i, 0, () => `A/${i}`, 1, i);
    c.pump(1);
    for (const p of pending) p.stall();
    await micro();
    c.lookup('A', 5, 9, 9, () => 'A/9', 2, 0); c.pump(2);
    expect(pending.length).toBe(4); // all four slots are taken by the stalled bodies
    await vi.advanceTimersByTimeAsync(TILE_TIMEOUT_MS);
    expect(pending.every((p) => p.signal?.aborted)).toBe(true);
    expect([c.failed, loads, inFlight]).toEqual([4, 4, 0]);
    expect(c.lastError).toBe('no answer within 20 s');
    c.lookup('A', 5, 9, 9, () => 'A/9', 3, 0);
    for (let i = 0; i < 4; i++) c.lookup('A', 5, i, 0, () => `A/${i}`, 3, i + 1); // failed tiles wait for their retry
    c.pump(3);
    expect(pending.slice(4).map((p) => p.url)).toEqual(['A/9']);
    pending[4].resolve(); await micro();
    expect(c.isLoaded('A', 5, 9, 9)).toBe(true);
    // Retry times that have passed are dropped, and the tiles are asked for again.
    expect((c as unknown as { retryAt: Map<string, number> }).retryAt.size).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    c.pump(4);
    expect((c as unknown as { retryAt: Map<string, number> }).retryAt.size).toBe(0);
    for (let i = 0; i < 4; i++) c.lookup('A', 5, i, 0, () => `A/${i}`, 5, i);
    c.pump(5);
    expect(pending.slice(5).map((p) => p.url)).toEqual(['A/0', 'A/1', 'A/2', 'A/3']);
  });

  it('aborts the loads in flight when switched off: none counts as failed and every slot is free again', async () => {
    let loads = 0;
    const c = new OverlayTileCache(gpu(), new RequestBudget(80, 60_000, () => clock), () => loads++);
    for (let i = 0; i < 4; i++) c.lookup('A', 5, i, 0, () => `A/${i}`, 1, i);
    c.pump(1);
    pending[0].stall(); await flush();
    c.clear();
    await flush();
    expect(pending.every((p) => p.signal?.aborted)).toBe(true);
    expect([inFlight, c.failed, loads]).toEqual([0, 0, 0]);
    for (let i = 0; i < 4; i++) c.lookup('B', 5, i, 0, () => `B/${i}`, 2, i);
    c.pump(2);
    expect(pending.slice(4).map((p) => p.url)).toEqual(['B/0', 'B/1', 'B/2', 'B/3']);
    await settleAll();
    expect(c.isLoaded('B', 5, 3, 0)).toBe(true);
  });

  it('discards a tile that arrives after the atlas was cleared (layer switched off)', async () => {
    const c = new OverlayTileCache(gpu(), new RequestBudget(80, 60_000, () => clock), () => {});
    c.lookup('A', 3, 1, 1, () => 'A', 1, 0); c.pump(1);
    c.clear();
    await settleAll();
    expect(c.isLoaded('A', 3, 1, 1)).toBe(false);
    expect(c.tex).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- layer
describe('World radar layer', () => {
  const r = { gpu: { device: {}, dpr: 1 }, camera: {} } as never;
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  beforeEach(() => { h.texts.length = 0; settings.set('ext.config.worldRadarTermsAccepted', false); settings.set('ext.layerState.WorldRadarOn', false); timeline.setArchive(null); });
  afterEach(() => { settings.set('ext.config.worldRadarTermsAccepted', false); settings.set('ext.layerState.WorldRadarOn', false); timeline.setArchive(null); });

  it('is off by default and contacts RainViewer only after the terms are accepted', async () => {
    const l = new WorldRadarLayer(r);
    expect(settings.bool('ext.layerState.WorldRadarOn')).toBe(false);
    await l.refresh();
    settings.set('ext.layerState.WorldRadarOn', true); // e.g. a layer preset, without acceptance in this browser
    await l.refresh();
    expect(l.enabled()).toBe(false);
    expect(h.texts.length).toBe(0);
    settings.set('ext.config.worldRadarTermsAccepted', true);
    void l.refresh();
    expect(h.texts.map((t) => t.url)).toEqual(['https://api.rainviewer.com/public/weather-maps.json']);
  });

  it('pauses every request for a readable Retry-After of a rate-limited frame list, else backs off, within a 20 s limit', async () => {
    settings.set('ext.config.worldRadarTermsAccepted', true); settings.set('ext.layerState.WorldRadarOn', true);
    const t0 = 1795200935e3;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(t0);
    const l = new WorldRadarLayer(r);
    const fetchText = vi.mocked((await import('../src/data/net')).fetchText);
    fetchText.mockClear();
    const answer = async (e: Error) => { const p = l.refresh(); h.texts.shift()!.reject(e); await p; };
    // Without a readable Retry-After (not exposed cross-origin) the back-off doubles from a minute.
    await answer(new HttpError(429, RV_MAPS_URL, null));
    expect(fetchText.mock.calls[0]).toEqual([RV_MAPS_URL, { cache: 'none', timeoutMs: 20_000 }]);
    expect(l.budget.pausedFor()).toBe(60_000);
    vi.setSystemTime(t0 + 60_000);
    await answer(new HttpError(429, RV_MAPS_URL, null));
    expect(l.budget.pausedFor()).toBe(120_000);
    // A readable Retry-After is honoured as for tiles.
    vi.setSystemTime(t0 + 180_000);
    await answer(new HttpError(429, RV_MAPS_URL, '300'));
    expect(l.budget.pausedFor()).toBe(300_000);
    expect(l.status.text).toMatch(/frame list failed: HTTP 429/);
    for (let s = 190; s < 480; s += 10) { vi.setSystemTime(t0 + s * 1000); await l.refresh(); }
    expect(h.texts.length).toBe(0); // no request for five minutes (tiles share the paused budget)
    expect(fetchText.mock.calls.length).toBe(3);
    // Once it ends, the list is asked for again; other failures (a timeout, a server error) pause nothing, and the
    // list is asked for again after 30 s.
    vi.setSystemTime(t0 + 480_000);
    await answer(new Error('timeout after 20000 ms'));
    expect(l.budget.pausedFor()).toBe(0);
    vi.setSystemTime(t0 + 500_000); await l.refresh();
    expect(h.texts.length).toBe(0);
    vi.setSystemTime(t0 + 510_000); void l.refresh();
    expect(h.texts.length).toBe(1);
    h.texts.shift()!.resolve(JSON.stringify(sample())); await settle();
    timeline.refreshWindow(Date.now()); // the loop window at the fake time, not at whenever the module was loaded
    expect(l.framesInWindow().length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('discards a frame list that arrives after the archive time changed', async () => {
    settings.set('ext.config.worldRadarTermsAccepted', true); settings.set('ext.layerState.WorldRadarOn', true);
    const l = new WorldRadarLayer(r);
    const p = l.refresh();
    timeline.setArchive(Date.UTC(2026, 10, 1));
    h.texts[0].resolve(JSON.stringify(sample()));
    await p; await settle();
    expect(l.framesInWindow()).toEqual([]);
    expect(l.shown()).toBeNull();
  });

  it('honours a late rate limit without replacing the current archive status', async () => {
    settings.set('ext.config.worldRadarTermsAccepted', true);
    settings.set('ext.layerState.WorldRadarOn', true);
    const now = 1795200935e3;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const l = new WorldRadarLayer(r);
      const live = l.refresh();
      timeline.setArchive(now - 24 * 3600e3);
      await l.refresh();
      const archiveStatus = l.status;

      h.texts.shift()!.reject(new HttpError(429, RV_MAPS_URL, '300'));
      await live;
      expect(l.budget.pausedFor()).toBe(300_000);
      expect(l.status).toEqual(archiveStatus);

      timeline.setArchive(null);
      const resumed = l.refresh();
      expect(h.texts).toHaveLength(0);
      await resumed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the frame valid at the map time and nothing for archive times outside RainViewer\'s two hours', async () => {
    settings.set('ext.config.worldRadarTermsAccepted', true); settings.set('ext.layerState.WorldRadarOn', true);
    const now = 1795200935e3;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    timeline.refreshWindow(now);
    const l = new WorldRadarLayer(r);
    const p = l.refresh();
    h.texts[0].resolve(JSON.stringify(sample()));
    await p;
    timeline.t = now;
    expect(l.shown()?.path).toBe('/v2/radar/ff31101ef700');
    expect(l.mapLabel()).toBe('World radar: RainViewer mosaic, frame 2026-11-20 18:50 UTC');
    timeline.t = 1795196700e3; // 17:45: the 17:40 frame
    expect(l.shown()?.t).toBe(1795196400e3);
    // An archive time within the list's reach is still requested: 18:10 shows the 18:10 frame.
    timeline.setArchive(now - 45 * 60e3);
    const q = l.refresh();
    expect(h.texts.length).toBe(2);
    h.texts[1].resolve(JSON.stringify(sample()));
    await q;
    timeline.t = now - 45 * 60e3;
    expect(l.shown()?.t).toBe(1795198200e3);
    // Older archive times are not requested at all: not available, no legend, no credit.
    for (const back of [24 * 3600e3, RV_REACH_MS + 60e3]) {
      timeline.setArchive(now - back);
      await l.refresh();
      expect(h.texts.length).toBe(2);
      expect(l.shown()).toBeNull();
      expect(l.status.state).toBe('unavailable');
      expect(l.status.text).toMatch(/not available for this time/);
      expect(l.legends()).toEqual([]);
      expect(l.attribution()).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------- drawing and playback
describe('World radar layer: tiles in view and the playing loop', () => {
  const NOW = 1795200935e3; // the fixture list's generation time
  const pass = { setPipeline() {}, setBindGroup() {}, draw() {} };
  let instances: Float32Array | null = null;
  type V = { lon: number; lat: number; z: number; tilt?: number; swivel?: number };
  const fakeR = (view: V) => {
    const camera = new Camera(); camera.width = 1600; camera.height = 900;
    camera.setView(view, true); camera.compute();
    const device = {
      createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
      createTexture: () => ({ destroy() {}, createView: () => ({}) }),
      createBindGroup: () => ({}),
      queue: { writeBuffer: (b: { size: number }, _o: number, d: Float32Array) => { if (b.size > 32) instances = d; }, copyExternalImageToTexture() {} },
    };
    return { camera, gpu: { device, dpr: 1, samplers: { linear: {} }, trackTexture() {}, recordUpload() {} }, layouts: { overlayTiles: {} }, pipe: () => ({}) } as never;
  };
  /** The fixture list `shift` frames later: the oldest frames dropped, new ones (new paths) appended. */
  const listAfter = (shift: number) => {
    const doc = sample();
    const past = doc.radar.past as { time: number; path: string }[];
    for (let i = 1; i <= shift; i++) past.push({ time: past[past.length - 1].time + 600, path: `/v2/radar/${(0xabc000 + i).toString(16)}` });
    doc.radar.past = past.slice(shift);
    doc.generated = past[past.length - 1].time + 300;
    return JSON.stringify(doc);
  };
  const isTile = (u: string) => u.startsWith(RV_HOST);
  let listTimes: number[] = [];
  const answerLists = (shift: number) => { for (const t of h.texts.splice(0)) { listTimes.push(Date.now()); t.resolve(listAfter(shift)); } };
  const draw = (l: WorldRadarLayer) => l.draw({ probe: false, pass } as never);

  beforeEach(() => {
    h.texts.length = 0; listTimes = []; instances = null;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    vi.stubGlobal('createImageBitmap', async () => ({ width: RV_TILE_PX, height: RV_TILE_PX, close() {} }));
    vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_DST: 8, UNIFORM: 64 });
    settings.set('ext.config.worldRadarTermsAccepted', true); settings.set('ext.layerState.WorldRadarOn', true);
    settings.set('ext.layerState.WorldRadarCoverage', true); settings.set('ext.layerState.LoopLength', 3);
    timeline.setArchive(null); timeline.refreshWindow(NOW); timeline.t = NOW;
  });
  afterEach(() => {
    timeline.play(false);
    settings.set('ext.config.worldRadarTermsAccepted', false); settings.set('ext.layerState.WorldRadarOn', false);
  });
  const start = async (view: V = { lon: -95, lat: 39, z: 163.75 }) => {
    const l = new WorldRadarLayer(fakeR(view));
    const p = l.refresh(); answerLists(0); await p;
    return l;
  };

  it('covers the whole view without cutting the list short, down to level 1 or 0 when the cap is tight', async () => {
    for (const view of [{ lon: -95, lat: 39, z: 163.75 }, { lon: 135, lat: -25, z: 900, tilt: 40 }, { lon: 179.5, lat: 10, z: 40, tilt: 60 }]) {
      const l = await start(view);
      const cam = (l as unknown as { r: { camera: Camera } }).r.camera;
      for (const cap of [1, 4, 6, 24]) {
        const tiles = l.viewTiles(cap);
        expect(tiles.length).toBeLessThanOrEqual(cap);
        if (cap < 4) expect(tiles).toEqual([[0, 0, 0]]);
        // Every visible point of the screen lies in one of the tiles.
        for (let px = 0; px <= 1600; px += 80) for (let py = 0; py <= 900; py += 60) {
          const ll = cam.pick(px, py);
          if (!ll) continue;
          const [lon, lat] = ll, my = (1 - Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360)) / Math.PI) / 2;
          if (Math.abs(lat) > 85) continue;
          expect(tiles.some(([z, x, y]) => { const n = 2 ** z; return Math.floor(((lon + 180) / 360) * n) % n === x && Math.min(n - 1, Math.floor(my * n)) === y; })).toBe(true);
        }
      }
    }
  });

  /** Mercator tile of level z holding a picked point (null beyond the tiles' ±85.05°). */
  const tileAt = (lon: number, lat: number, z: number) => {
    if (Math.abs(lat) > 85) return null;
    const n = 2 ** z, my = (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
    return `${z}/${Math.floor(((lon + 180) / 360) * n) % n}/${Math.min(n - 1, Math.floor(my * n))}`;
  };
  /** Screen points (CSS px) every `step` px whose camera pick hits the globe, with the point picked. */
  const visiblePicks = (cam: Camera, step: number) => {
    const out: { px: number; py: number; lon: number; lat: number }[] = [];
    for (let px = 0; px <= cam.width; px += step) for (let py = 0; py <= cam.height; py += step) {
      const ll = cam.pick(px, py);
      if (ll) out.push({ px, py, lon: ll[0], lat: ll[1] });
    }
    return out;
  };
  const uncovered = <P extends { lon: number; lat: number }>(tiles: number[][], picks: P[]) => {
    const set = new Set(tiles.map((t) => t.join('/'))), zs = [...new Set(tiles.map(([z]) => z))];
    return picks.filter((p) => tileAt(p.lon, p.lat, 0) && !zs.some((z) => set.has(tileAt(p.lon, p.lat, z)!)));
  };

  it('lists the tile of every visible pixel, also where a few sampled tile points miss it (oblique views, the antimeridian)', async () => {
    // Reproductions: a visible pixel outside every selected tile under the sampled cull.
    const near = await start({ lon: -96, lat: 45, z: 15, tilt: 65, swivel: 35 });
    const nearCam = (near as unknown as { r: { camera: Camera } }).r.camera;
    const corner = nearCam.pick(1570, 130)!;
    expect(corner).not.toBeNull();
    const wide = await start({ lon: -95, lat: 10, z: 5, tilt: 75, swivel: 60 });
    const widePicks = visiblePicks((wide as unknown as { r: { camera: Camera } }).r.camera, 40);
    expect(widePicks.length).toBeGreaterThan(0);
    for (const cap of [6, 24]) {
      expect(uncovered(near.viewTiles(cap), [{ lon: corner[0], lat: corner[1] }])).toEqual([]);
      expect(uncovered(wide.viewTiles(cap), widePicks)).toEqual([]);
    }
    // Every visible pixel (every 20 px) of views across the antimeridian, tilts and zooms, for every cap a loop gets;
    // the selection projects a bounded number of points.
    for (const lon of [-96, 179.9, -179.9, 180]) for (const lat of [45, 10, -60]) for (const z of [2, 15, 163.75]) for (const [tilt, swivel] of [[0, 0], [65, 35], [80, 200]]) {
      const l = await start({ lon, lat, z, tilt, swivel });
      const cam = (l as unknown as { r: { camera: Camera } }).r.camera, picks = visiblePicks(cam, 20);
      const project = cam.project.bind(cam);
      let projected = 0;
      cam.project = (p) => { projected++; return project(p); };
      for (const cap of [1, 4, 6, 15, 24]) {
        projected = 0;
        const tiles = l.viewTiles(cap);
        expect(tiles.length).toBeLessThanOrEqual(cap);
        expect(projected).toBeLessThan(20_000);
        expect(uncovered(tiles, picks).map((p) => `${lon},${lat} z${z} tilt ${tilt}/${swivel} cap ${cap}: ${p.px},${p.py}`)).toEqual([]);
      }
    }
  }, 30_000);

  it('leaves the map label and status of a drawn frame once the map time has no frame', async () => {
    const l = await start();
    timeline.t = NOW;
    draw(l);
    expect(l.status.text).toMatch(/showing 18:50 UTC, tiles 0\/\d+/);
    timeline.t = timeline.loopStart; // three hours back: before the list's first frame
    draw(l);
    expect(l.view.frame).toBeNull();
    expect(l.status.text).toMatch(/no frame at this time/);
    expect(l.status.text).not.toMatch(/showing|tiles/);
    expect(l.mapLabel()).toBe('World radar (RainViewer): no frame for this time');
    expect(l.attribution()).toEqual([]);
  });

  it('shades missing coverage over each radar tile once, and reports coverage it does not know (pending or failed) as unknown', async () => {
    const l = await start({ lon: -95, lat: 39, z: 300, tilt: 55 });
    draw(l);
    const tiles = l.viewTiles(24);
    expect(new Set(tiles.map(([z]) => z)).size).toBeGreaterThan(1); // a tilted view mixes levels
    expect(l.view.coverUnknown).toBe(tiles.length);
    expect(l.mapLabel()).toMatch(new RegExp(`coverage unknown in ${tiles.length} of ${tiles.length} tiles \\(loading\\)`));
    // Radar tiles arrive; the coverage mask fails: still unknown, not clear.
    for (let i = 0; i < 20 && pending.length; i++) { for (const p of pending.splice(0)) p.resolve(p.url.includes('/coverage/') ? 503 : 200); await flush(); draw(l); }
    expect(l.view.exact).toBe(l.view.tiles);
    expect(l.view.coverUnknown).toBe(tiles.length);
    expect(l.view.coverFailed).toBe(tiles.length);
    expect(l.status.state).toBe('loading');
    expect(l.status.text).toMatch(/coverage unknown in \d+ of \d+ tiles \(\d+ failed\)/);
    // The retry succeeds: one mask instance per radar tile, at the radar tile's own place (never overlapping).
    vi.setSystemTime(NOW + 61_000);
    for (let i = 0; i < 20; i++) { draw(l); if (!pending.length) break; await settleAll(); }
    draw(l);
    expect(l.view.coverUnknown).toBe(0);
    expect(l.status.state).toBe('ready');
    const inst = [...instances!], masks: string[] = [], radar: string[] = [];
    for (let i = 0; i < inst.length; i += 8) (inst[i + 7] ? masks : radar).push(inst.slice(i, i + 3).join('/'));
    expect(masks.sort()).toEqual(radar.sort());
  });

  /**
   * Plays a stationary loop of `hours` (in `view`) for `warmS` seconds, then `runS` more, one frame per second, with the window
   * following the clock and a new frame published every 10 minutes. Returns the tiles fetched after warming up, the
   * caps used and the frame counts seen.
   */
  const playLoop = async (hours: number, warmS: number, runS: number, view?: V) => {
    settings.set('ext.layerState.LoopLength', hours);
    timeline.refreshWindow(NOW);
    const l = await start(view);
    timeline.play(true);
    let shift = 0, step = 0;
    const tileFetchTimes: number[] = [], caps = new Set<number>(), counts = new Set<number>();
    const run = async (seconds: number) => {
      for (let i = 0; i < seconds; i++, step++) {
        vi.setSystemTime(NOW + step * 1000); clock = Date.now();
        const fs = l.framesInWindow();
        counts.add(fs.length);
        timeline.t = fs[step % fs.length].t; // one frame per second
        caps.add(l.tileCap());
        draw(l);
        if (pending.length) { for (let n = pending.length; n > 0; n--) tileFetchTimes.push(Date.now()); await settleAll(); }
        if (step % 10 === 0) {
          if (step % 600 === 0 && step) shift++; // RainViewer publishes a frame every 10 minutes
          timeline.refreshWindow(Date.now()); timeline.t = fs[0].t;
          const p = l.refresh(); answerLists(shift); await p;
        }
      }
    };
    await run(warmS);
    const warm = tileFetchTimes.length, lists = listTimes.length;
    await run(runS);
    return { l, warm, after: tileFetchTimes.length - warm, newFrames: shift, lists: listTimes.length - lists, caps: [...caps], counts: [...counts] };
  };

  it('a stationary playing loop fits the atlas: after warming up no tile is fetched again, and new frame lists still arrive', async () => {
    // The default view, and an oblique one whose edge tiles only the complete cull lists.
    for (const view of [undefined, { lon: -96, lat: 45, z: 15, tilt: 65, swivel: 35 }]) {
      h.texts.length = 0; listTimes = []; pending = []; vi.setSystemTime(NOW); settings.set('ext.layerState.LoopLength', 3); timeline.play(false);
      const r = await playLoop(3, 180, 1800, view); // 30 minutes after warming up: three new frames
      expect(r.caps).toEqual([Math.floor(RV_ATLAS_SLOTS / 14)]); // 13 frames and the coverage mask share the atlas
      expect(r.warm).toBeGreaterThan(0);
      expect(r.warm).toBeLessThanOrEqual(RV_ATLAS_SLOTS);
      expect(r.newFrames).toBe(3);
      // Only the three new frames' tiles were fetched (the dropped frames' slots are reused), never the loop again.
      expect(r.after).toBeLessThanOrEqual(3 * r.caps[0]);
      expect(r.lists).toBeGreaterThanOrEqual(14); // every two minutes
      expect(r.l.view.exact).toBe(r.l.view.tiles);
    }
  }, 30_000);

  it('a short loop keeps one tile cap while its frame count changes with the clock, and fetches only new frames', async () => {
    // A view whose split differs between the caps of 3 and 4 frames (22 and 18 tiles).
    const r = await playLoop(0.5, 120, 3600, { lon: -95, lat: 39, z: 163.75, tilt: 40 }); // an hour more: six new frames
    expect(r.counts.sort()).toEqual([3, 4]); // the window holds 3 or 4 frames as it moves
    expect(r.caps).toEqual([Math.floor(RV_ATLAS_SLOTS / 6)]); // up to 5 frames of 42 minutes and the mask
    expect(r.newFrames).toBe(6);
    expect(r.warm).toBeGreaterThan(0);
    expect(r.after).toBeLessThanOrEqual(6 * r.caps[0]);
    expect(r.l.view.exact).toBe(r.l.view.tiles);
  }, 30_000);

  it('frame lists are still requested every two minutes while panning keeps the tile budget full', async () => {
    const l = await start();
    timeline.play(true);
    const all: number[] = [];
    const r = (l as unknown as { r: { camera: Camera } }).r;
    for (let step = 0; step < 900; step++) {
      vi.setSystemTime(NOW + step * 1000); clock = Date.now();
      r.camera.setView({ lon: -95 + step * 2 }, true); r.camera.compute(); // a new view every second
      const fs = l.framesInWindow();
      timeline.t = fs[step % fs.length].t;
      draw(l);
      for (const p of pending) if (isTile(p.url)) all.push(Date.now());
      await settleAll();
      if (step % 10 === 0) { const n = h.texts.length; const p = l.refresh(); if (h.texts.length > n) all.push(Date.now()); answerLists(0); await p; }
    }
    expect(all.length).toBeGreaterThan(10 * RV_BUDGET_PER_MIN); // the budget is used to the full
    for (const t of all) expect(all.filter((u) => u > t - 60_000 && u <= t).length).toBeLessThanOrEqual(RV_BUDGET_PER_MIN);
    expect(listTimes.length).toBeGreaterThanOrEqual(1 + 7); // the first list, then one per two minutes
    for (let i = 2; i < listTimes.length; i++) expect(listTimes[i] - listTimes[i - 1]).toBeLessThanOrEqual(130_000);
  });
});

describe('layer order migration', () => {
  it('inserts new layers above their default neighbour and keeps the user\'s own order', () => {
    const before = DEFAULT_ORDER.filter((x) => x !== 'worldSatellite' && x !== 'worldRadar');
    // A saved order where the user put lightning under the satellite and NEXRAD on top of everything.
    const saved = [...before.filter((x) => x !== 'lightning' && x !== 'nexrad'), 'nexrad'];
    saved.splice(saved.indexOf('satellite'), 0, 'lightning');
    const m = mergeLayerOrder(saved);
    expect(m.length).toBe(DEFAULT_ORDER.length);
    expect(m.filter((x) => x !== 'worldSatellite' && x !== 'worldRadar')).toEqual(saved); // nothing else moved
    expect(m.indexOf('worldSatellite')).toBe(m.indexOf('customBackground') + 1); // under every GOES layer
    expect(m.indexOf('worldSatellite')).toBeLessThan(m.indexOf('satellite'));
    expect(m.indexOf('worldRadar')).toBeGreaterThan(m.indexOf('satelliteL2'));
    for (const id of ['mrms', 'nationalRadar', 'nexrad', 'warnings', 'gis', 'cities']) expect(m.indexOf('worldRadar')).toBeLessThan(m.indexOf(id));
    expect(mergeLayerOrder(m)).toEqual(m);
  });
  it('drops unknown or duplicated entries and starts from the default order when nothing is saved', () => {
    expect(mergeLayerOrder(DEFAULT_ORDER)).toEqual(DEFAULT_ORDER);
    expect(mergeLayerOrder(['gone', 'basemap', 'basemap', ...DEFAULT_ORDER.slice(1)])).toEqual(DEFAULT_ORDER);
    expect(mergeLayerOrder([])).toEqual(DEFAULT_ORDER);
  });
});
