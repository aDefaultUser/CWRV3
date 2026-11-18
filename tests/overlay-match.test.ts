// Storm-attribute overlays follow the displayed volume: products are matched by their own volume time, out-of-order
// and previous-site reads are never relabelled, and a volume without products draws none.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Run = { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ runs: [] as Run[], dirs: {} as Record<string, string>, labels: [] as { text: string }[][] }));
vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))); return { pool: { run, for: () => ({ run }) } }; });
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchText: vi.fn((url: string) => Promise.resolve(h.dirs[url] ?? '')) }));
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RadarDraw: class { draw() {} invalidate() {} }, RasterDraw: class { draw() {} invalidate() {} }, Lut: class {},
  uploadSweep: vi.fn(() => ({ tex: { destroy() {}, format: 'r8unorm' }, gates: 1 })),
}));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { setStyles() {} setLines() {} draw() {} },
  PointSet: class { setPoints() {} setAlpha() {} flushAlpha() {} draw() {} },
  TextSet: class { setLabels(l: { text: string }[]) { h.labels.push(l); } draw() {} },
}));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));

import { matchVolume, overlayFiles, VOLUME_MATCH_TOL_MS } from '../src/radar/overlay-match';
import { NexradLayer } from '../src/layers/nexrad';
import { settings } from '../src/settings/store';
import { timeline } from '../src/app/timeline';
import { decodeLevel3 } from '../src/decode/level3';

const MIN = 60e3;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('matchVolume', () => {
  const v = (volumeTimeMs: number) => ({ volumeTimeMs });
  const T = Date.UTC(2026, 10, 18, 0, 36, 6);

  it('returns the nearest product within the tolerance, else null', () => {
    const products = [v(T), v(T + 7 * MIN), v(T - 7 * MIN)];
    expect(matchVolume(products, T + 524)).toBe(products[0]); // Level 2 header vs Level 3 product time of one volume
    expect(matchVolume(products, T + 6 * MIN)).toBe(products[1]);
    expect(matchVolume(products, T + 3.5 * MIN)).toBeNull(); // between volumes: neither neighbour
    expect(matchVolume(products, T + VOLUME_MATCH_TOL_MS)).toBe(products[0]);
    expect(matchVolume(products, T + VOLUME_MATCH_TOL_MS + 1)).toBeNull();
    expect(matchVolume([], T)).toBeNull();
    expect(matchVolume(products, T + 30, 10)).toBeNull();
  });

  it('matches a Level 3 SAILS cut to its own volume by scan number', () => {
    // KTBW VCP 215: volume 79 starts 01:10:44, its supplemental 0.5° cut (elevation 7) reports 01:14:21.
    const vol = Date.UTC(2026, 10, 18, 1, 10, 44), cut = Date.UTC(2026, 10, 18, 1, 14, 21);
    const s = (volumeTimeMs: number, volumeScan: number) => ({ volumeTimeMs, volumeScan });
    const products = [s(vol - 80 * 6.8 * MIN, 79), s(vol, 79), s(vol + 7 * MIN, 80)];
    expect(matchVolume(products, cut)).toBeNull(); // by time alone the cut is 3.6 min from either volume
    expect(matchVolume(products, cut, undefined, 79)).toBe(products[1]);
    expect(matchVolume(products, vol + 500, undefined, 79)).toBe(products[1]);
    expect(matchVolume(products, vol + 7 * MIN, undefined, 80)).toBe(products[2]);
    expect(matchVolume([products[0], products[2]], cut, undefined, 79)).toBeNull(); // volume 79's product missing
  });

  it('does not depend on arrival order', () => {
    const products = [v(T + 4 * MIN), v(T), v(T + 1.5 * MIN)];
    for (const order of [products, [...products].reverse()]) expect(matchVolume(order, T + 1 * MIN)?.volumeTimeMs).toBe(T + 1.5 * MIN);
  });
});

describe('overlayFiles', () => {
  const f = (t: number, url = String(t)) => ({ t, url });
  it('keeps files listed in the window after a frame, newest first, up to the cap', () => {
    const T = Date.UTC(2026, 10, 18, 1);
    const files = [f(T - 60 * MIN), f(T), f(T + 7 * MIN), f(T + 30 * MIN), f(T - 2 * MIN)];
    expect(overlayFiles(files, [], T - 10 * MIN, T + 60 * MIN).map((x) => x.t)).toEqual([T + 30 * MIN, T + 7 * MIN, T, T - 2 * MIN]);
    expect(overlayFiles(files, [T], T - 90 * MIN, T + 60 * MIN).map((x) => x.t)).toEqual([T + 7 * MIN, T]); // listed after the frame
    expect(overlayFiles(files, [], T - 90 * MIN, T + 60 * MIN, 2).map((x) => x.t)).toEqual([T + 30 * MIN, T + 7 * MIN]);
  });
});

describe('NEXRAD storm overlays per displayed volume', () => {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n: number) => String(n).padStart(2, '0');
  const listed = (t: number) => { const d = new Date(t); return `${p2(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
  const T1 = Math.floor(Date.now() / MIN) * MIN - 20 * MIN, T2 = T1 + 6 * MIN;
  const dir = (ds: string, site = 'ktlx') => `https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.${ds}/SI.${site}/`;
  /** One sn.NNNN file per volume, listed 5 min after it. */
  const list = (ds: string, volumes: number[], site = 'ktlx') => { h.dirs[dir(ds, site)] = volumes.map((t, i) => `<a href="sn.000${i}">sn.000${i}</a></td><td align="right">${listed(t + 5 * MIN)}  </td>`).join('\n'); };
  const reads = (ds: string) => h.runs.filter((r) => r.task === 'l3' && r.args.url.includes(`/DS.${ds}/`));
  const sti = (t: number, id: string) => ({ volumeTimeMs: t, cells: [{ id, x: 10, y: 20, past: [], forecast: [] }], pages: [] });
  const tvs = (t: number, x: number) => ({ volumeTimeMs: t, tvs: [{ x, y: 0 }], etvs: [] });
  const ctx = { probe: false } as never;
  /** Draws the overlays as of timeline time `t` (radar off: the products' own loop). */
  const drawAt = (layer: NexradLayer, t: number) => { timeline.t = t; layer.draw(ctx); };
  const lastLabels = () => h.labels[h.labels.length - 1].map((l) => l.text);

  let snapshot: ReturnType<typeof settings.exportDocument>, t0 = 0;
  beforeEach(() => {
    snapshot = settings.exportDocument(); t0 = timeline.t;
    h.runs.length = 0; h.dirs = {}; h.labels.length = 0;
    settings.set('settings.nexradSiteICAO', 'KTLX');
    settings.set('layerState.NEXRADOn', false);
    for (const k of ['NEXRADStormTracksOn', 'NEXRADTVSIconsOn', 'NEXRADHAILIconsOn', 'NEXRADMESOIconsOn', 'NEXRADMeltingLayerOn']) settings.set(`layerState.${k}`, false);
    settings.set('layerState.NEXRADLevel2Product', 0);
  });
  afterEach(() => { settings.importDocument(snapshot); timeline.t = t0; });

  it('draws each volume with its own products, whatever order they arrive in, and none for a volume without', async () => {
    settings.set('layerState.NEXRADStormTracksOn', true);
    settings.set('layerState.NEXRADTVSIconsOn', true);
    list('58sti', [T1]); list('61tvs', [T1, T2]);
    const layer = new NexradLayer({} as never, {} as never);
    const refresh = (layer as any).refreshOverlays('KTLX') as Promise<void>;
    await flush();
    expect(reads('61tvs').map((r) => r.args.url)).toEqual([dir('61tvs') + 'sn.0001', dir('61tvs') + 'sn.0000']); // newest first
    reads('61tvs')[1].resolve(tvs(T1, 5)); // older volume answers first
    reads('61tvs')[0].resolve(tvs(T2, 9));
    reads('58sti')[0].resolve(sti(T1, 'A1'));
    expect(h.runs).toHaveLength(3); // p62ss and p59hi list no files
    await refresh;

    drawAt(layer, T1 + 30e3);
    expect(layer.shownVolume).toBe(T1);
    expect(layer.overlays.tvs).toEqual([{ x: 5, y: 0 }]);
    expect(layer.scit.map((c) => c.id)).toEqual(['A1']);
    expect(layer.overlayTime).toBe(T1);
    expect(layer.overlayNote).toBe('');

    drawAt(layer, T2 + 30e3);
    expect(layer.overlays.tvs).toEqual([{ x: 9, y: 0 }]);
    expect(layer.scit).toEqual([]); // T2 has no storm-cell product: T1's cells are not drawn over it
    expect(layer.overlayTime).toBe(0);

    settings.set('layerState.NEXRADTVSIconsOn', false);
    drawAt(layer, T2 + 30e3); // radar off: the storm-cell products' own newest volume at that time
    expect(layer.shownVolume).toBe(T1);
    expect(layer.scit.map((c) => c.id)).toEqual(['A1']);
    (layer as any).syncOverlays(T2 + 500); // a radar frame of T2 drawn
    expect(layer.overlays.cells).toEqual([]);
    const hm = new Date(T2).toISOString().slice(11, 16);
    expect(layer.overlayNote).toBe(`No storm attributes for ${hm}Z`);
    expect(lastLabels()).toContain(`No storm attributes for ${hm}Z`);

    (layer as any).syncOverlays(T1 + 500); // back to the earlier volume
    expect(layer.scit.map((c) => c.id)).toEqual(['A1']);
    expect(layer.overlayNote).toBe('');
    expect(layer.latestStormAttributes()).toMatchObject({ site: 'KTLX', volumeTimeMs: T2, cells: null, tvs: [{ x: 9, y: 0 }], hail: null });
  });

  it("follows the drawn radar frame and discards the previous site's late products", async () => {
    settings.set('layerState.NEXRADTVSIconsOn', true);
    list('61tvs', [T1, T2]);
    const layer = new NexradLayer({} as never, {} as never);
    const refresh = (layer as any).refreshOverlays('KTLX') as Promise<void>;
    await flush();
    reads('61tvs')[0].resolve(tvs(T2, 9));
    settings.set('settings.nexradSiteICAO', 'KFWS'); layer.freeAll();
    reads('61tvs')[1].resolve(tvs(T1, 5)); // arrives after the switch
    await refresh;
    drawAt(layer, T2 + 30e3);
    expect(layer.overlays.tvs).toEqual([]);
    expect(layer.latestStormAttributes()).toBeNull();
    expect(layer.overlayNote).toBe(''); // KFWS not listed yet: nothing to report

    // KFWS Level 3 radar frame at T1 drawn while the timeline is later: the overlays follow the frame, not the clock.
    list('61tvs', [T1, T2], 'kfws');
    const next = (layer as any).refreshOverlays('KFWS') as Promise<void>;
    await flush();
    const [r2, r1] = reads('61tvs').slice(-2);
    r2.resolve(tvs(T2, 9)); r1.resolve(tvs(T1, 5));
    await next;
    expect(layer.latestStormAttributes()).toMatchObject({ site: 'KFWS', volumeTimeMs: T2, tvs: [{ x: 9, y: 0 }] });
    (layer as any).syncOverlays(T1 + 500);
    expect(layer.overlays.tvs).toEqual([{ x: 5, y: 0 }]);
    (layer as any).syncOverlays(T1 + 3 * MIN); // a radar volume between the products' volumes
    expect(layer.overlays.tvs).toEqual([]);
    expect(layer.overlayNote).toBe(`No storm attributes for ${new Date(T1 + 3 * MIN).toISOString().slice(11, 16)}Z`);
  });

  it('reads the storm motion and cells of real KJAX products of one volume', async () => {
    const fixture = (ds: string) => decodeLevel3(new Uint8Array(readFileSync(`tests/fixtures/nexrad-l3/KJAX-${ds}-20261118-011827.bin`)));
    const srm = fixture('56rm0'), sti = fixture('58sti'), T = sti.volumeTimeMs;
    expect(srm.volumeTimeMs).toBe(T);
    settings.set('settings.nexradSiteICAO', 'KJAX');
    settings.set('layerState.NEXRADStormTracksOn', true);
    settings.set('layerState.NEXRADLevel2Product', 7);
    settings.set('settings.nexradStormMotionCustom', false);
    list('58sti', [T], 'kjax'); list('56rm0', [T], 'kjax');
    const layer = new NexradLayer({} as never, {} as never);
    const anchor = timeline.anchor;
    timeline.anchor = T + 10 * MIN; timeline.refreshWindow();
    try {
      const refresh = (layer as any).refreshOverlays('KJAX') as Promise<void>;
      await flush();
      reads('58sti')[0].resolve(sti); reads('56rm0')[0].resolve(srm);
      await refresh;
    } finally { timeline.anchor = anchor; timeline.refreshWindow(); }
    expect(layer.motionFor(T + 500)).toEqual({ speedKt: 13.7, fromDeg: 99.5 }); // halfwords 51/52
    (layer as any).syncOverlays(T + 500);
    expect(layer.scit).toHaveLength(28);
    expect(layer.scit[0]).toMatchObject({ id: 'P7' });
    expect(layer.overlayTime).toBe(T);
    // Alerts read the newest volume's cells with the same STI motion as the cell table.
    const p7 = layer.latestStormAttributes()!.cells!.find((c) => c.id === 'P7');
    expect(p7).toMatchObject({ dir: layer.scit[0].dir, speed: layer.scit[0].speed });
    expect(Number.isFinite(p7.dir)).toBe(true);
  });

  it('reads nothing for archived volumes outside the TGFTP files (fixture loops stay without overlays)', async () => {
    settings.set('layerState.NEXRADTVSIconsOn', true);
    list('61tvs', [T1, T2]);
    const layer = new NexradLayer({} as never, {} as never);
    layer.fixture = { site: 'KTLX', files: [] };
    const archived = Date.UTC(2024, 4, 6, 23);
    const anchor = timeline.anchor;
    timeline.anchor = archived; timeline.refreshWindow();
    try { await (layer as any).refreshOverlays('KTLX'); } finally { timeline.anchor = anchor; timeline.refreshWindow(); }
    expect(reads('61tvs')).toEqual([]);
    drawAt(layer, archived);
    expect(layer.overlays.tvs).toEqual([]);
  });
});
