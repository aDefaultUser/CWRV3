// NEXRAD in linked panes: each pane's product is requested, kept, drawn, probed and labelled under its own identity
// (site, product, tilt, time). A result for one pane never reaches another pane or a pane that changed meanwhile; the
// volume metadata is read once for all panes; the timeline is offered pane 0's frames only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Run = { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
type Tex = { product: number; elevation: number; destroyed: boolean; format: string; destroy(): void };
const h = vi.hoisted(() => ({ runs: [] as Run[], textures: [] as Tex[], radarDraws: [] as { calls: any[] }[] }));

vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))); return { pool: { run, for: () => ({ run }) } }; });
// Directory listings (Level 3 products of the site) are empty.
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchText: vi.fn(() => Promise.resolve('')) }));
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RadarDraw: class { calls: any[] = []; constructor() { h.radarDraws.push(this); } draw(_c: unknown, p: unknown) { this.calls.push(p); } invalidate() {} },
  RasterDraw: class { draw() {} invalidate() {} },
  Lut: class { constructor(_r: unknown, public palette: { name?: string }) {} },
  uploadSweep: vi.fn((_r: unknown, s: { product: number; elevation: number }) => {
    const tex: Tex = { product: s.product, elevation: s.elevation, destroyed: false, format: 'r8unorm', destroy() { tex.destroyed = true; } };
    h.textures.push(tex);
    return { tex, firstKm: 0, gateKm: 1, gates: 1, rows: 1, az0: 0, spacing: 1, radials: 360, maxRangeKm: 1 };
  }),
}));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { draws = 0; setStyles() {} setLines() {} draw() { this.draws++; } },
  PointSet: class { setPoints() {} setAlpha() {} flushAlpha() {} draw() {} },
  TextSet: class { labels = []; setLabels() {} flushAlpha() {} draw() {} },
}));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));

import { NexradLayer, PANE_VOLUMES } from '../src/layers/nexrad';
import { settings } from '../src/settings/store';
import { timeline } from '../src/app/timeline';
import { panes, presets } from '../src/app/panes';
import { useStorage } from '../src/app/persist';
import { PRODUCTS } from '../src/generated/products-catalog';
import { destination } from '../src/gis/geodesy';

const L2 = PRODUCTS.level2;
const REF = 0, SW = 2, ZDR = 3, CC = 5, VEL = 6, SRV = 7, KDP = 10;
const T = Date.UTC(2024, 4, 6, 22, 0), MIN = 60e3;
const TILTS = [0.5, 0.9, 1.3, 1.8];
const KTLX = { lon: -97.277761, lat: 35.333361 };
/** A point 60 km north-west of the radar, which the stub camera returns for every pick. */
const POINT = destination(KTLX.lon, KTLX.lat, 315, 60);
const renderer = { camera: { cur: { z: 5 }, width: 600, height: 400, pick: () => POINT, project: () => [300, 200, true] }, probeOnce: [] as { x: number; y: number; layer: string; pane?: number }[] };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const volume = (t: number) => ({
  volumeTimeMs: t, vcp: 212, avset: false, sails: 0, mrle: 0,
  sweeps: TILTS.map((e, index) => ({ index, elevation: e, nominal: e, label: `${e}°`, moments: ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO'], radials: 720, split: null })),
});
/** The worker's answer to a product request: the product and tilt it was asked for. */
const answer = (r: Run) => r.resolve({ sweep: { product: r.args.product, radials: 360, gates: 10, firstKm: 0, gateKm: 1, azimuths: new Float32Array(360), half: false, complete: true, elevation: TILTS[r.args.sweep] ?? 0, codes: new Uint8Array(3600), wordSize: 8, startMs: 1, endMs: 2 } });
const pending = (task: string) => h.runs.filter((r) => r.task === task);
const products = () => pending('l2.product');
const frame = (t: number, i = 0) => ({ t, file: { t, url: `https://x/KTLX${i}`, live: false, name: `v${i}` } }) as any;
const ctx = (pane: number, probe = false) => ({ probe, pane }) as never;
/** Whether drawing `pane` draws a sweep, and the texture drawn. */
const drawn = (layer: NexradLayer, pane: number): Tex | null => {
  const before = h.radarDraws.map((d) => d.calls.length);
  layer.draw(ctx(pane));
  const used = h.radarDraws.filter((d, i) => d.calls.length > (before[i] ?? 0));
  return used.length ? used[used.length - 1].calls[used[used.length - 1].calls.length - 1].a.tex : null;
};
const slotOf = (layer: NexradLayer, pane: number, i = 0) => (pane === 0 ? layer.l2[i] : layer.l2[i].panes?.[pane - 1]) as { sweep?: { id: string; tex: Tex }; key?: string; error?: string } | undefined;

let snapshot: ReturnType<typeof settings.exportDocument>;
beforeEach(() => {
  snapshot = settings.exportDocument();
  useStorage({ length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} });
  h.runs.length = 0; h.textures.length = 0; h.radarDraws.length = 0; renderer.probeOnce.length = 0;
  settings.set('settings.nexradPrecipitationTyping', false);
  settings.set('settings.nexrad3DTiltShadow', false);
  settings.set('settings.nexradStormMotionCustom', true); // storm-relative velocity needs no Level 3 motion
  settings.set('config.generalRadarVelocityMPHForce', false);
  settings.set('config.generalRadarVelocityDirectionText', false);
  settings.set('settings.nexradLevel2MaxVolumeDownloadCount', 12);
  settings.set('settings.nexradLevel2VolumeCountMemory', 26);
  settings.set('settings.nexradSiteICAO', 'KTLX');
  settings.set('layerState.NEXRADOn', true);
  settings.set('layerState.NEXRADLevel2', true);
  settings.set('layerState.NEXRADLevel2Product', REF);
  timeline.t = T + 30e3;
});
afterEach(() => {
  panes.setLayout(0);
  [SRV, ZDR, CC].forEach((product, i) => panes.setView(i + 1, { level2: true, product, l3: 0, tilt: 0.5, offsetMin: 0 }));
  settings.importDocument(snapshot);
  useStorage(null);
  vi.restoreAllMocks();
});

/** A layer whose refresh lists `frames` (as the benchmark fixture does) and holds them. */
const hold = (layer: NexradLayer, frames: any[]) => {
  layer.l2 = frames;
  layer.fixture = { site: 'KTLX', files: frames.map((f) => f.file) };
  (layer as any).site = 'KTLX';
};
/** A layer with `n` volumes 5 minutes apart whose metadata is read; the product requests are pending. */
const setup = async (n = 1) => {
  const layer = new NexradLayer(renderer as never, {} as never);
  layer.setTilt(0.5);
  h.runs.length = 0;
  hold(layer, Array.from({ length: n }, (_, i) => frame(T - (n - 1 - i) * 5 * MIN, i)));
  for (const f of layer.l2) void (layer as any).loadL2(f);
  await flush();
  for (const r of pending('l2.meta')) r.resolve(volume(layer.l2.find((f) => f.file.url === r.args.url)!.t));
  await flush();
  return layer;
};
const built = async (n = 1) => { const layer = await setup(n); products().forEach(answer); await flush(); return layer; };
const fourUp = () => panes.apply(presets({ level2: true, product: REF, l3: 0, tilt: 0.5, offsetMin: 0 }, TILTS)[1]);

describe('one volume, a product per pane', () => {
  it('reads the metadata once and requests each pane’s product under its own identity', async () => {
    fourUp();
    const layer = await setup();
    expect(pending('l2.meta')).toHaveLength(1);
    expect(products().map((r) => [r.args.product, r.args.sweep, r.args.url])).toEqual([REF, VEL, ZDR, CC].map((p) => [p, 0, 'https://x/KTLX0']));
    const ids = [0, 1, 2, 3].map((p) => layer.l2Identity(p));
    expect(new Set(ids).size).toBe(4);
    expect(ids.map((id) => id.split('|').slice(0, 4))).toEqual([REF, VEL, ZDR, CC].map((p) => ['KTLX', String(p), 'false', '0.5']));
    products().forEach(answer); await flush();
    expect([0, 1, 2, 3].map((p) => slotOf(layer, p)!.sweep!.id)).toEqual(ids);
    expect(layer.l2Identity(4)).toBe(ids[0]); // a pane the layout does not show is the main view
  });

  it('draws each pane’s own sweep with its own draw object, and nothing of another pane', async () => {
    fourUp();
    const layer = await built();
    const texs = [0, 1, 2, 3].map((p) => drawn(layer, p)!);
    expect(texs.map((t) => t.product)).toEqual([REF, VEL, ZDR, CC]);
    // One uniform buffer per draw object: a pane never reuses another pane's within a frame.
    const users = h.radarDraws.filter((d) => d.calls.length);
    expect(users).toHaveLength(4);
    for (const d of users) expect(new Set(d.calls.map((c) => c.a.tex)).size).toBe(1);
    expect([0, 1, 2, 3].map((p) => layer.paneLabel(p))).toEqual([
      'KTLX · Reflectivity 0.5° · 22:00Z', 'KTLX · Base Velocity (Dealiased) 0.5° · 22:00Z', 'KTLX · ZDR 0.5° · 22:00Z', 'KTLX · CC 0.5° · 22:00Z']);
  });

  it('a single pane requests and draws as before', async () => {
    const layer = await built();
    expect(products().map((r) => r.args.product)).toEqual([REF]);
    expect(drawn(layer, 0)!.product).toBe(REF);
    expect(layer.l2[0].panes).toBeUndefined();
    expect(h.radarDraws).toHaveLength(3); // no draw objects for panes that are not shown
  });
});

describe('a pane’s result under another identity', () => {
  it('discards a stale result for pane 2 and keeps the newest request’s', async () => {
    fourUp();
    const layer = await built();
    panes.setView(2, { product: KDP }); layer.panesChanged(); await flush();
    const kdp = products()[products().length - 1];
    expect([kdp.args.product, products().length]).toEqual([KDP, 5]); // only pane 2 asks again
    panes.setView(2, { product: SW }); layer.panesChanged(); await flush();
    const sw = products()[products().length - 1];
    expect(sw.args.product).toBe(SW);
    answer(sw); await flush();
    const uploads = h.textures.length;
    answer(kdp); await flush(); // the superseded request completes last
    expect(h.textures).toHaveLength(uploads);
    expect(slotOf(layer, 2)!.sweep!.id.split('|')[1]).toBe(String(SW));
    expect(drawn(layer, 2)!.product).toBe(SW);
  });

  it('discards a result that arrives after its pane left the layout', async () => {
    fourUp();
    const layer = await setup();
    const [, , zdr, cc] = products();
    panes.setLayout(1); layer.panesChanged(); await flush(); // REF | VEL
    products().forEach(answer); await flush();
    expect(h.textures.map((t) => t.product).sort()).toEqual([REF, VEL]);
    expect([zdr.args.product, cc.args.product]).toEqual([ZDR, CC]);
    expect(layer.l2[0].panes!.slice(1).every((s) => !s?.sweep)).toBe(true);
  });

  it('frees the sweeps of panes that leave the layout', async () => {
    fourUp();
    const layer = await built();
    const texs = [0, 1, 2, 3].map((p) => slotOf(layer, p)!.sweep!.tex);
    panes.setLayout(0); layer.panesChanged();
    expect(texs.map((t) => t.destroyed)).toEqual([false, true, true, true]);
    expect(drawn(layer, 0)).toBe(texs[0]);
  });

  it('never relabels another pane’s sweep when a pane’s product changes', async () => {
    fourUp();
    const layer = await built();
    const before = [0, 1, 2, 3].map((p) => slotOf(layer, p)!.sweep!);
    panes.setView(2, { product: KDP }); layer.panesChanged();
    // The ZDR sweep is freed at once: it is not drawn or probed as KDP while KDP loads.
    expect(before[2].tex.destroyed).toBe(true);
    expect(drawn(layer, 2)).toBeNull();
    expect(layer.shownScan(2)).toBeNull();
    expect(layer.legends(2)[0].unit).toBe(L2[KDP].unit);
    expect(layer.paneLabel(2)).toBe('KTLX · KDP (Specific Differential Phase) 0.5° · loading…');
    for (const p of [0, 1, 3]) {
      expect(slotOf(layer, p)!.sweep).toBe(before[p]);
      expect(before[p].tex.destroyed).toBe(false);
      expect(drawn(layer, p)).toBe(before[p].tex);
    }
    await flush();
    answer(products()[products().length - 1]); await flush();
    expect(drawn(layer, 2)!.product).toBe(KDP);
    expect([0, 1, 3].map((p) => drawn(layer, p)!.product)).toEqual([REF, VEL, CC]);
  });

  it('pane 0 follows the radar settings and leaves the other panes’ sweeps alone', async () => {
    fourUp();
    const layer = await built();
    const before = [0, 1, 2, 3].map((p) => slotOf(layer, p)!.sweep!);
    settings.set('layerState.NEXRADLevel2Product', SRV); layer.reloadProducts(); await flush();
    expect(before.map((s) => s.tex.destroyed)).toEqual([true, false, false, false]);
    expect(drawn(layer, 0)).toBeNull();
    const srv = products()[products().length - 1];
    expect([srv.args.product, products().length]).toEqual([SRV, 5]);
    answer(srv); await flush();
    expect([0, 1, 2, 3].map((p) => drawn(layer, p)!.product)).toEqual([SRV, VEL, ZDR, CC]);
  });

  it('a product a pane’s volume lacks is reported in that pane only', async () => {
    fourUp();
    const layer = await setup();
    const [ref, vel, zdr, cc] = products();
    [ref, vel, zdr].forEach(answer);
    cc.reject(new Error('decode failed')); await flush();
    expect(slotOf(layer, 3)!.error).toBe('decode failed');
    expect(drawn(layer, 3)).toBeNull();
    expect(layer.paneLabel(3)).toBe('KTLX · CC 0.5° · decode failed');
    expect([0, 1, 2].map((p) => drawn(layer, p)!.product)).toEqual([REF, VEL, ZDR]);
  });
});

describe('tilts, legends and probe readouts per pane', () => {
  const lowestTilts = () => panes.apply(presets({ level2: true, product: REF, l3: 0, tilt: 0.5, offsetMin: 0 }, [0.5, 0.9, 1.3, 0.5, 1.8, 2.4])[2]);

  it('the tilt preset shows the four lowest tilts of one product, each requested for its own cut', async () => {
    lowestTilts();
    const layer = await built();
    expect(products().map((r) => [r.args.product, r.args.sweep])).toEqual([[REF, 0], [REF, 1], [REF, 2], [REF, 3]]);
    expect([0, 1, 2, 3].map((p) => drawn(layer, p)!.elevation)).toEqual(TILTS);
    expect([0, 1, 2, 3].map((p) => layer.shownScan(p)!.elevation)).toEqual(TILTS);
    expect(new Set([0, 1, 2, 3].map((p) => layer.shownScan(p)!.key)).size).toBe(4);
  });

  it('gives each pane the legend of its own product', async () => {
    fourUp();
    const layer = await built();
    const legends = [0, 1, 2, 3].map((p) => layer.legends(p));
    expect(legends.map((l) => l.length)).toEqual([1, 1, 1, 1]);
    expect(legends.map((l) => [l[0].unit, l[0].low, l[0].high])).toEqual([REF, VEL, ZDR, CC].map((p) => [L2[p].unit, L2[p].low, L2[p].high]));
    expect(new Set(legends.map((l) => l[0].palette.name)).size).toBeGreaterThan(1);
  });

  it('reads one probe sample as each pane’s own product', async () => {
    fourUp();
    const layer = await built();
    const value = (p: number, f: number) => L2[p].low + (L2[p].high - L2[p].low) * f;
    const texts = [0, 1, 2, 3].map((p) => layer.probeText(0.75, p));
    expect(texts[0]).toBe(`${value(REF, 0.75).toFixed(1)} ${L2[REF].unit}`);
    expect(texts[1]).toBe(`${value(VEL, 0.75).toFixed(1)} ${L2[VEL].unit}`);
    expect(texts[2]).toBe(`${value(ZDR, 0.75).toFixed(1)} ${L2[ZDR].unit}`);
    expect(texts[3]).toBe(`${value(CC, 0.75).toFixed(1)} ${L2[CC].unit}`);
    expect(layer.probeText(256 / 65535, 1)).toBe('RF'); // range folded: velocity panes only
    expect(layer.probeText(256 / 65535, 0)).not.toBe('RF');
  });

  it('gives the beam height of each pane’s tilt at the same map point', async () => {
    lowestTilts();
    const layer = await built();
    for (const p of [0, 1, 2, 3]) layer.draw(ctx(p));
    const beams = [0, 1, 2, 3].map((p) => layer.tools.beamProbe(300, 200, p));
    expect(beams.map((b) => b[0])).toEqual(Array(4).fill(beams[0][0])); // one ground range and azimuth
    expect(beams.map((b) => /Beam ([\d.]+)°/.exec(b[1])![1])).toEqual(['0.5', '0.9', '1.3', '1.8']);
    const heights = beams.map((b) => Number(/: ([\d,]+) ft ARL/.exec(b[1])![1].replace(',', '')));
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(heights[3]).toBeGreaterThan(heights[0] * 2);
  });

  it('measures VR shear in the pane clicked when it shows velocity, else in the first that does', async () => {
    panes.apply(presets({ level2: true, product: REF, l3: 0, tilt: 0.5, offsetMin: 0 }, TILTS)[0]); // REF | SRV
    const layer = await built();
    for (const p of [0, 1]) layer.draw(ctx(p));
    expect(layer.tools.startShear(0)).toBeNull(); // Alt+V in the reflectivity pane
    expect(layer.tools.shear!.pane).toBe(1);
    layer.tools.shearClick(POINT, 0); layer.tools.shearClick(destination(KTLX.lon, KTLX.lat, 316, 61), 0);
    layer.tools.shearText();
    expect(renderer.probeOnce.map((q) => [q.layer, q.pane])).toEqual([['nexrad', 1], ['nexrad', 1]]);
    // The measurement belongs to that pane's product: it ends when the pane shows something else.
    panes.setView(1, { product: ZDR }); layer.panesChanged();
    layer.tools.shearText();
    expect(layer.tools.shear).toBeNull();
    expect(layer.tools.startShear(0)).toMatch(/needs a velocity product/);
  });
});

describe('the loop in panes', () => {
  it('offers the timeline pane 0’s frames only', async () => {
    panes.apply(presets({ level2: true, product: REF, l3: 0, tilt: 0.5, offsetMin: 0 }, TILTS)[0]);
    settings.set('settings.nexradTimelineConstrain', true);
    const layer = await setup(2);
    const offer = vi.spyOn(timeline, 'offer');
    // Pane 0 holds both volumes, pane 1 (SRV) the older one only.
    products().filter((r) => r.args.product === REF || r.args.url.endsWith('KTLX0')).forEach(answer); await flush();
    layer.publishTimeline();
    const l2 = offer.mock.calls.filter((c) => c[0] === 'nexrad-l2');
    expect(l2[l2.length - 1][1]).toEqual([T - 5 * MIN, T]);
    expect(drawn(layer, 1)).not.toBeNull(); // the older volume, held while the newer one loads
    expect(layer.shownScan(1)!.t).toBe(T - 5 * MIN);
    expect(layer.shownScan(0)!.t).toBe(T);
  });

  it('shows a pane with a time offset the volume of that earlier time, and nothing before its first', async () => {
    panes.apply(presets({ level2: true, product: REF, l3: 0, tilt: 0.5, offsetMin: 0 }, TILTS)[0]);
    const layer = await built(2);
    panes.setView(1, { offsetMin: 5 });
    timeline.t = T + 30e3;
    expect([layer.shownScan(0)!.t, layer.shownScan(1)!.t]).toEqual([T, T - 5 * MIN]);
    for (const p of [0, 1]) layer.draw(ctx(p));
    expect(layer.paneLabel(1)).toBe('KTLX · Storm-Relative Velocity (Dealiased) 0.5° · −5 min · 21:55Z');
    timeline.t = T - 5 * MIN + 30e3; // pane 1 would show 21:50:30, before the loop's first volume
    expect(layer.shownScan(0)!.t).toBe(T - 5 * MIN);
    expect(layer.shownScan(1)).toBeNull();
    expect(drawn(layer, 1)).toBeNull();
    expect(layer.paneLabel(1)).toBe('KTLX · Storm-Relative Velocity (Dealiased) 0.5° · −5 min · no volume at this time');
  });

  it('draws the storm attributes only in panes that show pane 0’s volume', async () => {
    panes.apply(presets({ level2: true, product: REF, l3: 0, tilt: 0.5, offsetMin: 0 }, TILTS)[0]);
    const layer = await built(2);
    const overlay = (layer as any).overlayLines as { draws: number };
    timeline.t = T + 30e3;
    layer.draw(ctx(0)); layer.draw(ctx(1));
    expect(overlay.draws).toBe(2);
    panes.setView(1, { offsetMin: 5 }); // pane 1 now shows the previous volume
    layer.draw(ctx(0)); layer.draw(ctx(1));
    expect(overlay.draws).toBe(3);
    panes.setView(1, { offsetMin: 0 });
    layer.draw(ctx(0)); layer.draw(ctx(1));
    expect(overlay.draws).toBe(5);
  });

  it('holds the newest volumes only while several panes are shown', async () => {
    const layer = new NexradLayer(renderer as never, {} as never);
    const n = PANE_VOLUMES + 3;
    hold(layer, Array.from({ length: n }, (_, i) => ({ ...frame(T - (n - 1 - i) * 5 * MIN, i), sweep: { id: layer.l2Identity(), tex: { format: 'r8unorm', destroy() {} } } })));
    settings.set('settings.nexradTimelineConstrain', true);
    const offer = vi.spyOn(timeline, 'offer');
    const offered = () => { layer.publishTimeline(); const c = offer.mock.calls.filter((x) => x[0] === 'nexrad-l2'); return c[c.length - 1][1] as number[]; };
    expect(offered()).toHaveLength(n);
    panes.setLayout(1);
    expect(offered()).toEqual(layer.l2.slice(-PANE_VOLUMES).map((f) => f.t));
    // Pane 1's sweeps are requested for those volumes only.
    for (const f of layer.l2) f.meta = volume(f.t) as never;
    h.runs.length = 0;
    layer.panesChanged(); await flush();
    const srv = products().filter((r) => r.args.product === SRV);
    expect(srv.map((r) => r.args.url)).toEqual(layer.l2.slice(-PANE_VOLUMES).map((f) => f.file.url));
  });
});

describe('Level 3 beside Level 2', () => {
  it('lists a Level 3 pane’s own product and leaves the status line and timeline to pane 0', async () => {
    panes.setLayout(1);
    panes.setView(1, { level2: false, l3: 11 }); // N0U 0.5° base velocity
    const layer = new NexradLayer(renderer as never, {} as never);
    expect(layer.isL2(0) && !layer.isL2(1)).toBe(true);
    expect(layer.l3Identity(1)).toBe('KTLX|p99v0');
    expect(layer.displayRange(1).unit).toBe('m/s');
    expect(layer.displayRange(0).unit).toBe(L2[REF].unit);
    // Pane 1's Level 3 loop is its own list; pane 0's stays empty.
    (layer as any).paneDraw(1).l3 = [{ t: T, url: 'u', id: layer.l3Identity(1), tex: { gates: 1 }, elevation: 0.5 }];
    expect(layer.l3).toEqual([]);
    expect(layer.shownScan(1)).toMatchObject({ t: T, elevation: 0.5 });
    expect(layer.shownScan(0)).toBeNull();
    expect(layer.probeKind()).toBe('nexrad');
    expect(drawn(layer, 1)).not.toBeNull();
    expect(layer.paneLabel(1)).toBe('KTLX · 0.5° Base Velocity, 162nmi · 22:00Z');
  });
});
