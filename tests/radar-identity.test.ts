// Radar request identity: a Level 2 / custom radar sweep is drawn only for the site, product, tilt and algorithm
// inputs it was built for; superseded, out-of-order, unavailable and failed builds never leave another product
// behind under the new product's palette and units.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Run = { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ runs: [] as Run[], textures: [] as { destroyed: boolean; destroy(): void; format: string }[], radarDraws: [] as any[], holdLists: false, lists: [] as { url: string; resolve: (t: string) => void }[] }));

vi.mock('../src/workers/pool', () => ({ pool: { run: vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))) } }));
const LISTING = '<a href="KTST20261116_060000_V06">v</a>';
// Directory listings resolve at once, or wait for the test while `holdLists` is set.
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchText: vi.fn((url: string) => (h.holdLists ? new Promise((resolve) => h.lists.push({ url, resolve })) : Promise.resolve(LISTING))) }));
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RadarDraw: class { calls: any[] = []; constructor() { h.radarDraws.push(this); } draw(_c: unknown, p: unknown) { this.calls.push(p); } invalidate() {} },
  RasterDraw: class { draw() {} invalidate() {} },
  Lut: class { constructor(_r: unknown, public palette: { name?: string }) {} },
  uploadSweep: vi.fn(() => { const tex = { destroyed: false, format: 'r8unorm', destroy() { tex.destroyed = true; } }; h.textures.push(tex); return { tex, firstKm: 0, gateKm: 1, gates: 1, rows: 1, az0: 0, spacing: 1, radials: 360, maxRangeKm: 1 }; }),
}));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { setStyles() {} setLines() {} draw() {} },
  PointSet: class { setPoints() {} setAlpha() {} flushAlpha() {} draw() {} },
  TextSet: class { labels = []; setLabels() {} flushAlpha() {} draw() {} },
}));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));

import { CustomRadarLayer } from '../src/layers/custom-radar';
import { NexradLayer } from '../src/layers/nexrad';
import { settings } from '../src/settings/store';
import { PRODUCTS } from '../src/generated/products-catalog';
import { RADAR_SITES } from '../src/generated/radar-sites';

const DBZ = PRODUCTS.level2[0].unit;

const renderer = { camera: { cur: { z: 5 } } } as never;
const ctx = { probe: false } as never;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const sweep = (product: number) => ({ product, radials: 360, gates: 10, firstKm: 0, gateKm: 1, azimuths: new Float32Array(360), half: false, complete: true, elevation: 0.5, codes: new Uint8Array(3600), wordSize: 8, startMs: 1, endMs: 2 });
/** One low-elevation volume: base moments only, too few sweeps for the volumetric products. */
const lowVolume = { volumeTimeMs: Date.UTC(2026, 10, 16, 6), vcp: 35, avset: false, sails: 0, mrle: 0, sweeps: [{ index: 0, elevation: 0.5, nominal: 0.5, label: '0.5', moments: ['REF', 'VEL'], radials: 360 }] };
const pending = (task: string) => h.runs.filter((r) => r.task === task);
const last = (task: string) => pending(task)[pending(task).length - 1];

let snapshot: ReturnType<typeof settings.exportDocument>;
beforeEach(() => {
  snapshot = settings.exportDocument();
  h.runs.length = 0; h.textures.length = 0; h.radarDraws.length = 0; h.holdLists = false; h.lists.length = 0;
  settings.set('settings.nexradPrecipitationTyping', false);
});
afterEach(() => settings.importDocument(snapshot));

describe('custom radar sweeps', () => {
  const setup = async () => {
    const nexrad = new NexradLayer(renderer, {} as never);
    const layer = new CustomRadarLayer(renderer, {} as never, nexrad);
    layer.sites = [{ name: 'KTST', state: 'OK', place: 'Test', lon: -97, lat: 35, elev: 1000 }];
    layer.servers = ['https://radar.example/'];
    settings.set('layerState.CustomRadarSite', 'KTST');
    settings.set('layerState.CustomRadarOn', true);
    settings.set('layerState.CustomRadarProduct', 0);
    const poll = layer.poll();
    await flush();
    last('l2.meta').resolve(lowVolume); await flush();
    last('l2.product').resolve({ sweep: sweep(0) });
    await poll;
    return layer;
  };
  const radarDraw = () => h.radarDraws[h.radarDraws.length - 1];

  it('frees the old product when the new one is unavailable or fails, then shows a valid reload', async () => {
    const layer = await setup();
    expect(radarDraw().calls).toHaveLength(0);
    layer.draw(ctx);
    expect(radarDraw().calls).toHaveLength(1);
    expect(layer.legends()[0].unit).toBe(DBZ);
    const reflectivity = h.textures[0];

    settings.set('layerState.CustomRadarProduct', 13); // VIL: needs a full volume
    layer.reloadProducts();
    expect(reflectivity.destroyed).toBe(true); // never drawn with the VIL palette and units
    layer.draw(ctx);
    expect(radarDraw().calls).toHaveLength(1);
    expect(layer.legends()).toEqual([]);
    last('l2.product').resolve({ sweep: null }); await flush();
    expect(layer.volumes[0].error).toBe('product unavailable');
    layer.draw(ctx);
    expect(radarDraw().calls).toHaveLength(1);

    settings.set('layerState.CustomRadarProduct', 15); // echo tops: the build fails
    layer.reloadProducts(); await flush();
    last('l2.product').reject(new Error('decode failed')); await flush();
    expect(layer.volumes[0].error).toBe('decode failed');
    layer.draw(ctx);
    expect(radarDraw().calls).toHaveLength(1);
    expect(layer.legends()).toEqual([]);

    settings.set('layerState.CustomRadarProduct', 0); // valid again
    layer.reloadProducts(); await flush();
    expect(last('l2.product').args.product).toBe(0);
    last('l2.product').resolve({ sweep: sweep(0) }); await flush();
    layer.draw(ctx);
    expect(radarDraw().calls).toHaveLength(2);
    expect(layer.legends()[0].unit).toBe(DBZ);
  });

  it('applies only the newest request when builds complete out of order', async () => {
    const layer = await setup();
    settings.set('layerState.CustomRadarProduct', 1); layer.reloadProducts(); await flush();
    const velocity = last('l2.product');
    settings.set('layerState.CustomRadarProduct', 0); layer.reloadProducts(); await flush();
    const reflectivity = last('l2.product');
    expect(reflectivity).not.toBe(velocity);
    reflectivity.resolve({ sweep: sweep(0) }); await flush();
    const uploads = h.textures.length;
    velocity.resolve({ sweep: sweep(1) }); await flush(); // late result of a superseded request
    expect(h.textures.length).toBe(uploads);
    layer.draw(ctx);
    expect(layer.legends()[0].unit).toBe(DBZ);
  });
});

describe('NEXRAD Level 2 sweeps', () => {
  const frame = (url: string, live = false) => ({ t: Date.UTC(2026, 10, 16, 6), file: { t: Date.UTC(2026, 10, 16, 6), url, live, name: url } });
  const setup = async (product = 0) => {
    settings.set('settings.nexradSiteICAO', 'KTLX');
    settings.set('layerState.NEXRADOn', true);
    settings.set('layerState.NEXRADLevel2', true);
    settings.set('layerState.NEXRADLevel2Product', product);
    const layer = new NexradLayer(renderer, {} as never);
    const f = frame('https://x/KTLX1');
    layer.l2 = [f as never];
    void (layer as any).loadL2(f);
    last('l2.meta').resolve(lowVolume); await flush();
    return { layer };
  };
  const shown = (layer: NexradLayer) => { const radar = h.radarDraws[h.radarDraws.length - 3]; /* main sweep renderer */ const n = radar.calls.length; layer.draw(ctx); return radar.calls.length > n; };

  it('shows the newest product only when builds complete out of order', async () => {
    const { layer } = await setup(0);
    const reflectivity = last('l2.product');
    settings.set('layerState.NEXRADLevel2Product', 1); layer.reloadProducts(); await flush();
    const velocity = last('l2.product');
    expect(velocity.args.product).toBe(1);
    velocity.resolve({ sweep: sweep(1) }); await flush();
    reflectivity.resolve({ sweep: sweep(0) }); await flush(); // stale
    expect(h.textures).toHaveLength(1);
    expect(layer.probeKind()).toBe('nexrad');
    expect(layer.l2[0].sweep!.id).toMatch(/^KTLX\|1\|/);
    expect(shown(layer)).toBe(true);
  });

  it('frees reflectivity when a derived product is unavailable for the volume, with no fallback', async () => {
    const { layer } = await setup(0);
    last('l2.product').resolve({ sweep: sweep(0) }); await flush();
    expect(shown(layer)).toBe(true);
    settings.set('layerState.NEXRADLevel2Product', 13); layer.reloadProducts();
    expect(h.textures[0].destroyed).toBe(true);
    expect(shown(layer)).toBe(false);
    await flush();
    last('l2.product').resolve({ sweep: null }); await flush();
    expect(layer.probeKind()).toBeNull();
    expect(shown(layer)).toBe(false);
    expect(layer.statusText).toBe('product unavailable');
  });

  it('discards metadata and products requested for another site, tilt or live-composite mode', async () => {
    const { layer } = await setup(0);
    const product = last('l2.product');
    settings.set('settings.nexradSiteICAO', 'KFWS'); layer.freeAll();
    product.resolve({ sweep: sweep(0) }); await flush();
    expect(h.textures).toHaveLength(0);

    const f = frame('https://x/KFWS1', true);
    layer.l2 = [f as never];
    void (layer as any).loadL2(f); void (layer as any).loadL2(f);
    const [older, newer] = pending('l2.meta').slice(-2);
    newer.resolve({ ...lowVolume, sweeps: [{ ...lowVolume.sweeps[0], radials: 360 }] }); await flush();
    older.resolve({ ...lowVolume, sweeps: [] }); await flush(); // an older, shorter read never replaces the newer one
    expect(layer.l2[0].meta!.sweeps).toHaveLength(1);
    const tiltRequest = last('l2.product');
    layer.setTilt(1.5); // another tilt: the 0.5° result must not be labelled 1.5°
    tiltRequest.resolve({ sweep: sweep(0) }); await flush();
    expect(layer.probeKind()).toBeNull();
    layer.liveComposite = true; layer.reloadProducts(); await flush();
    last('l2.meta').resolve(lowVolume); await flush();
    const composite = last('l2.composite');
    layer.liveComposite = false; layer.reloadProducts(); await flush();
    last('l2.meta').resolve(lowVolume); await flush();
    composite.resolve({ sweep: sweep(0) }); await flush();
    expect(layer.l2[0].sweep?.id ?? '').not.toMatch(/\|true\|/);
  });

  it('drops storm overlays fetched for the previous site', async () => {
    settings.set('settings.nexradSiteICAO', 'KTLX');
    settings.set('layerState.NEXRADTVSIconsOn', true);
    const layer = new NexradLayer(renderer, {} as never);
    const refresh = (layer as any).refreshOverlays('KTLX');
    settings.set('settings.nexradSiteICAO', 'KFWS'); layer.freeAll();
    for (const r of pending('l3')) r.resolve({ tvs: [{ x: 1, y: 1 }], etvs: [] });
    await refresh;
    expect(layer.overlays.tvs).toEqual([]);
  });
});

describe('custom radar environment and storm motion', () => {
  // A volume old enough that every HRRR cycle around it is published; three sweeps for the volumetric products.
  const T = Date.UTC(2026, 10, 10, 6, 10);
  const volume = { ...lowVolume, volumeTimeMs: T, sweeps: [0.5, 1.5, 2.5].map((e, i) => ({ ...lowVolume.sweeps[0], index: i, elevation: e, nominal: e, label: String(e) })) };
  const ftToM = 0.3048;
  const sites = [
    { name: 'KENA', state: 'OK', place: 'A', lon: -95.1, lat: 33.2, elev: 1000 },
    { name: 'KENB', state: 'TX', place: 'B', lon: -101.4, lat: 31.7, elev: 3000 },
  ];
  const ktlx = RADAR_SITES.find((s) => s.id === 'KTLX')!;
  const gribAt = (p: { lon: number; lat: number }) => pending('grib.point').filter((r) => r.args.lon === p.lon && r.args.lat === p.lat);
  const cycle = (r: Run) => Date.parse(/hrrr\.(\d{8})\/conus\/hrrr\.t(\d\d)z/.exec(r.args.url)!.slice(1).join('T').replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)$/, '$1-$2-$3T$4:00:00Z'));
  const products = (site: string) => pending('l2.product').filter((r) => r.args.url.includes(`/${site}/`));
  const lastProduct = (site: string) => products(site)[products(site).length - 1];

  const setup = async (product: number, site = 'KENA') => {
    settings.set('settings.nexradSiteICAO', 'KTLX');
    settings.set('layerState.NEXRADLevel2', true);
    settings.set('layerState.NEXRADLevel2Product', 0); // the main product needs no environment
    settings.set('settings.nexradAlgorithmHailIsothermCustom', false);
    settings.set('settings.customRadarStormMotionCustom', false);
    const nexrad = new NexradLayer(renderer, {} as never);
    const layer = new CustomRadarLayer(renderer, {} as never, nexrad);
    layer.sites = sites;
    layer.servers = ['https://radar.example/'];
    settings.set('layerState.CustomRadarSite', site);
    settings.set('layerState.CustomRadarOn', true);
    settings.set('layerState.CustomRadarProduct', product);
    const poll = layer.poll();
    await flush();
    last('l2.meta').resolve(volume); await flush();
    return { nexrad, layer, poll, radar: h.radarDraws[h.radarDraws.length - 1] };
  };
  const drawn = (layer: CustomRadarLayer, radar: any) => { const n = radar.calls.length; layer.draw(ctx); return radar.calls.length > n; };

  it('samples HRRR isotherms at its own site, not the main radar, and rebuilds MEHS when they arrive late', async () => {
    const { nexrad, layer, poll, radar } = await setup(11);
    const first = lastProduct('KENA');
    expect(first.args.params.envIsotherms).toBeNull(); // nothing loaded yet: the custom heights apply
    expect(gribAt(sites[0])).toHaveLength(3);
    expect(gribAt(ktlx)).toHaveLength(0);
    first.resolve({ sweep: sweep(11) }); await poll;
    expect(drawn(layer, radar)).toBe(true);

    const elevM = 1000 * ftToM;
    const at = (c: number) => gribAt(sites[0]).find((r) => cycle(r) === c)!;
    const h6 = Date.UTC(2026, 10, 10, 6), h7 = Date.UTC(2026, 10, 10, 7);
    at(h6).resolve({ values: [3000 + elevM, 6000 + elevM] }); await flush();
    const rebuilt = lastProduct('KENA');
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.args.params.envIsotherms.h0).toBeCloseTo(3000);
    expect(rebuilt.args.params.envIsotherms.hm20).toBeCloseTo(6000);
    expect(drawn(layer, radar)).toBe(true); // same identity: the built sweep stays until the rebuild lands

    at(h7).resolve({ values: [3600 + elevM, 6600 + elevM] }); await flush(); // a later cycle: interpolated at 06:10
    const latest = lastProduct('KENA');
    expect(latest.args.params.envIsotherms.h0).toBeCloseTo(3100);
    latest.resolve({ sweep: sweep(11) }); await flush();
    rebuilt.resolve({ sweep: sweep(11) }); await flush(); // superseded: never replaces the newer build
    expect(h.textures.filter((t) => !t.destroyed)).toHaveLength(1);
    expect(h.textures[h.textures.length - 1].destroyed).toBe(false);

    // The main radar's hail product samples KTLX itself and never uses the custom site's heights.
    settings.set('layerState.NEXRADLevel2Product', 11);
    expect(nexrad.buildParams(T).envIsotherms).toBeNull();
    expect(gribAt(ktlx)).toHaveLength(3);
    settings.set('layerState.NEXRADLevel2Product', 0);
  });

  it('ignores isotherms of the previous site when the site changes while they are pending', async () => {
    const { layer, poll } = await setup(12);
    lastProduct('KENA').resolve({ sweep: sweep(12) }); await poll;
    const oldGrib = gribAt(sites[0]);
    settings.set('layerState.CustomRadarSite', 'KENB');
    const next = layer.poll();
    await flush();
    last('l2.meta').resolve(volume); await flush();
    expect(lastProduct('KENB').args.params.envIsotherms).toBeNull();
    const before = products('KENB').length;
    for (const r of oldGrib) r.resolve({ values: [3000, 6000] }); // KENA's heights arrive after the switch
    await flush();
    expect(products('KENB')).toHaveLength(before); // no rebuild, and nothing built with KENA's heights
    lastProduct('KENB').resolve({ sweep: sweep(12) }); await next;
    const own = gribAt(sites[1]);
    expect(own).toHaveLength(3);
    own[1].resolve({ values: [4000 + 3000 * ftToM, 7000 + 3000 * ftToM] }); await flush();
    expect(lastProduct('KENB').args.params.envIsotherms.h0).toBeCloseTo(4000); // above KENB's own elevation
  });

  it('rebuilds storm-relative velocity as soon as the automatic vector arrives or changes', async () => {
    const { nexrad, layer, poll, radar } = await setup(7);
    const manual = lastProduct('KENA');
    expect(manual.args.params.stormMotion).toEqual({ speedKt: settings.num('settings.customRadarStormMotionSpeed'), fromDeg: settings.num('settings.customRadarStormMotionAzimuth') });
    manual.resolve({ sweep: sweep(7) }); await poll;
    expect(drawn(layer, radar)).toBe(true);

    nexrad.setAutoMotion({ speedKt: 30, fromDeg: 240 });
    expect(h.textures[0].destroyed).toBe(true); // the manual-vector sweep is not shown as the automatic one
    await flush();
    const auto = lastProduct('KENA');
    expect(auto.args.params.stormMotion).toEqual({ speedKt: 30, fromDeg: 240 });
    auto.resolve({ sweep: sweep(7) }); await flush();
    expect(drawn(layer, radar)).toBe(true); // shown without waiting for the next poll

    nexrad.setAutoMotion({ speedKt: 35, fromDeg: 250 });
    await flush();
    const changed = lastProduct('KENA');
    expect(changed.args.params.stormMotion).toEqual({ speedKt: 35, fromDeg: 250 });
    changed.resolve({ sweep: sweep(7) }); await flush();
    expect(h.textures.filter((t) => !t.destroyed)).toHaveLength(1);
    const count = products('KENA').length;
    nexrad.setAutoMotion({ speedKt: 35, fromDeg: 250 }); await flush(); // unchanged vector: no rebuild
    expect(products('KENA')).toHaveLength(count);
  });
});

describe('custom radar selections made while data loads', () => {
  const VEL = PRODUCTS.level2[1].unit;
  const KTST = { name: 'KTST', state: 'OK', place: 'Test', lon: -97, lat: 35, elev: 1000 };
  const layers: CustomRadarLayer[] = [];
  afterEach(() => { settings.set('layerState.CustomRadarOn', false); for (const l of layers.splice(0)) l.sync(); }); // stops poll timers
  /** Starts the first poll with nothing loaded yet: the volume's metadata request is pending. */
  const start = (product = 0, nexrad = new NexradLayer(renderer, {} as never)) => {
    const layer = new CustomRadarLayer(renderer, {} as never, nexrad);
    layers.push(layer);
    layer.sites = [KTST, { ...KTST, name: 'KOTH', lon: -96 }];
    layer.servers = ['https://radar.example/'];
    settings.set('layerState.CustomRadarSite', 'KTST');
    settings.set('layerState.CustomRadarOn', true);
    settings.set('layerState.CustomRadarProduct', product);
    return { layer, nexrad, poll: layer.poll(), radar: h.radarDraws[h.radarDraws.length - 1] };
  };
  const loaded = async (product = 0, nexrad?: NexradLayer) => {
    const t = start(product, nexrad);
    await flush();
    last('l2.meta').resolve(lowVolume); await flush();
    last('l2.product').resolve({ sweep: sweep(product) }); await t.poll;
    return t;
  };
  const drawn = (layer: CustomRadarLayer, radar: any) => { const n = radar.calls.length; layer.draw(ctx); return radar.calls.length > n; };

  for (const order of ['newer first', 'older first'] as const) {
    it(`builds a product selected while metadata loads only under its own identity (metadata ${order})`, async () => {
      const { layer, poll, radar } = start(0);
      await flush();
      expect(pending('l2.meta')).toHaveLength(1);
      settings.set('layerState.CustomRadarProduct', 1); layer.reloadProducts(); await flush(); // the app's listener
      const metas = pending('l2.meta');
      expect(metas).toHaveLength(2);
      for (const m of order === 'newer first' ? [...metas].reverse() : metas) { m.resolve(lowVolume); await flush(); }
      expect(pending('l2.product').map((r) => r.args.product)).toEqual([1]); // reflectivity is never built or relabelled
      last('l2.product').resolve({ sweep: sweep(1) }); await poll;
      expect(layer.volumes[0].sweep!.id).toBe(layer.identity());
      expect(layer.identity()).toMatch(/\|1\|/);
      expect(drawn(layer, radar)).toBe(true);
      expect(layer.legends()[0].unit).toBe(VEL);
    });
  }

  it('builds with the tilt and algorithm inputs selected while metadata loads, never the earlier ones', async () => {
    settings.set('settings.customRadarStormMotionCustom', true);
    settings.set('settings.customRadarStormMotionSpeed', 20);
    const twoTilts = { ...lowVolume, sweeps: [lowVolume.sweeps[0], { ...lowVolume.sweeps[0], index: 1, elevation: 1.5, nominal: 1.5, label: '1.5' }] };
    const { layer, poll } = start(7);
    await flush();
    layer.tilt = 1; // the UI's tilt selection (1.5°), then a new manual vector
    settings.set('settings.customRadarStormMotionSpeed', 35); layer.reloadProducts(); await flush();
    for (const m of pending('l2.meta')) { m.resolve(twoTilts); await flush(); }
    const builds = pending('l2.product');
    expect(builds).toHaveLength(1);
    expect(builds[0].args.sweep).toBe(1);
    expect(builds[0].args.params.stormMotion.speedKt).toBe(35);
    builds[0].resolve({ sweep: { ...sweep(7), elevation: 1.5 } }); await poll;
    expect(layer.volumes[0].sweep!.id).toBe(layer.identity());
    expect(layer.identity()).toMatch(/\|7\|1\.5\|.*35\//);
  });

  it('drops a late build of the previous product when the newer product is unavailable', async () => {
    const { layer, poll, radar } = start(0);
    await flush();
    last('l2.meta').resolve(lowVolume); await flush();
    const reflectivity = last('l2.product');
    settings.set('layerState.CustomRadarProduct', 13); layer.reloadProducts(); await flush();
    const vil = last('l2.product');
    expect(vil.args.product).toBe(13);
    vil.resolve({ sweep: null }); await flush();
    reflectivity.resolve({ sweep: sweep(0) }); await poll; // completes after the newer, unavailable request
    expect(h.textures).toHaveLength(0);
    expect(layer.volumes[0].error).toBe('product unavailable');
    expect(drawn(layer, radar)).toBe(false);
    expect(layer.legends()).toEqual([]);
  });

  it('frees a relocated site at once, before a pending poll resolves, and draws only at the new location', async () => {
    const { layer, radar } = await loaded(0);
    expect(drawn(layer, radar)).toBe(true);
    h.holdLists = true;
    const oldPoll = layer.poll(); await flush(); // a listing for the old location is in flight
    settings.set('layerState.CustomRadarProduct', 1); layer.reloadProducts();
    const oldBuild = last('l2.product'); // and a rebuild of the old location's volume
    layer.setSites([{ ...KTST, lon: -98, lat: 36 }]); // the site file moves KTST
    expect(h.textures[0].destroyed).toBe(true);
    expect(drawn(layer, radar)).toBe(false);
    expect(layer.legends()).toEqual([]);
    expect(layer.tilts).toEqual([]);
    expect(layer.status).toMatchObject({ state: 'loading', text: 'Custom radar KTST: loading' });
    expect(h.lists).toHaveLength(2); // the new location's listing starts at once, not after the old one
    const [oldList, newList] = h.lists;
    newList.resolve(LISTING); await flush();
    const meta = last('l2.meta');
    oldList.resolve(LISTING); await oldPoll; // the old pass's late listing adds nothing
    oldBuild.resolve({ sweep: sweep(1) }); await flush();
    expect(h.textures).toHaveLength(1);
    expect(layer.volumes).toHaveLength(1);
    expect(layer.status.state).toBe('loading');
    meta.resolve(lowVolume); await flush();
    last('l2.product').resolve({ sweep: sweep(1) }); await flush();
    expect(drawn(layer, radar)).toBe(true);
    expect(radar.calls[radar.calls.length - 1].site).toMatchObject({ lon: -98, lat: 36 });
    expect(layer.identity()).toMatch(/^KTST@-98,36,1000\|1\|/);
    expect(layer.legends()[0].unit).toBe(VEL);
  });

  it('frees the old site at once when another site, no valid site or other servers are selected', async () => {
    const { layer, radar } = await loaded(0);
    h.holdLists = true;
    settings.set('layerState.CustomRadarProduct', 1); layer.reloadProducts();
    const oldBuild = last('l2.product');
    settings.set('layerState.CustomRadarSite', 'KOTH'); layer.sync(); // the app's listener
    expect(h.textures[0].destroyed).toBe(true);
    expect(drawn(layer, radar)).toBe(false);
    expect(layer.status.text).toBe('Custom radar KOTH: loading');
    oldBuild.resolve({ sweep: sweep(1) }); await flush();
    expect(h.textures).toHaveLength(1);
    expect(layer.status.text).toBe('Custom radar KOTH: loading');

    settings.set('layerState.CustomRadarSite', 'NOPE'); layer.sync(); // no valid site
    expect(layer.status).toMatchObject({ state: 'error', text: 'Custom radar: choose a site (Site List tab)' });
    for (const l of h.lists) l.resolve(LISTING); await flush(); // KOTH's listing arrives late
    expect(layer.volumes).toEqual([]);
    expect(layer.status.state).toBe('error');
    expect(drawn(layer, radar)).toBe(false);

    h.holdLists = false; h.lists.length = 0;
    settings.set('layerState.CustomRadarSite', 'KTST'); layer.sync(); await flush();
    last('l2.meta').resolve(lowVolume); await flush();
    last('l2.product').resolve({ sweep: sweep(1) }); await flush();
    expect(drawn(layer, radar)).toBe(true);
    h.holdLists = true;
    const oldPoll = layer.poll(); await flush();
    layer.setServers(['https://other.example/']);
    expect(h.textures[h.textures.length - 1].destroyed).toBe(true);
    expect(drawn(layer, radar)).toBe(false);
    expect(h.lists.map((l) => new URL(l.url).host)).toEqual(['radar.example', 'other.example']);
    h.lists[0].resolve(LISTING); await oldPoll; // the earlier server's listing is dropped
    expect(layer.volumes).toEqual([]);
    h.lists[1].resolve(LISTING); await flush();
    expect(layer.volumes.map((v) => new URL(v.url).host)).toEqual(['other.example']);
  });
});

describe('automatic storm motion', () => {
  const MANUAL = () => ({ speedKt: settings.num('settings.nexradStormMotionSpeed'), fromDeg: settings.num('settings.nexradStormMotionAzimuth') });
  /** A 56rm0 product with a vector (tenths of knots and degrees) and its volume time. */
  const srm = (speedKt: number, fromDeg: number, volumeTimeMs = Date.now()) => ({ p: [0, 0, 0, 0, 0, 0, speedKt * 10, fromDeg * 10], volumeTimeMs });
  const setup = () => {
    settings.set('settings.nexradSiteICAO', 'KTLX');
    settings.set('layerState.NEXRADOn', false);
    for (const k of ['NEXRADStormTracksOn', 'NEXRADTVSIconsOn', 'NEXRADHAILIconsOn', 'NEXRADMESOIconsOn', 'NEXRADMeltingLayerOn']) settings.set(`layerState.${k}`, false);
    settings.set('layerState.NEXRADLevel2', true);
    settings.set('layerState.NEXRADLevel2Product', 7);
    settings.set('settings.nexradStormMotionCustom', false);
    const layer = new NexradLayer(renderer, {} as never);
    let told = 0;
    layer.autoMotionListeners.add(() => told++);
    return { layer, told: () => told };
  };
  /** One overlay refresh whose motion read returns `value` (an Error: the read fails). */
  const read = async (layer: NexradLayer, site: string, value: unknown) => {
    const done = (layer as any).refreshOverlays(site);
    const req = last('l3');
    expect(req.args.url).toContain(`DS.56rm0/SI.${site.toLowerCase()}/`);
    if (value instanceof Error) req.reject(value); else req.resolve(value);
    await done;
  };

  it("never keeps the previous site's vector: site change, failed, empty, invalid, old and late reads", async () => {
    const { layer, told } = setup();
    await read(layer, 'KTLX', srm(30, 240));
    expect(layer.autoMotion).toMatchObject({ speedKt: 30, fromDeg: 240, site: 'KTLX' });
    expect(layer.l2Identity()).toMatch(/,auto$/);
    expect(told()).toBe(1);
    const late = (layer as any).refreshOverlays('KTLX');
    const lateReq = last('l3');
    settings.set('settings.nexradSiteICAO', 'KFWS'); layer.freeAll();
    expect(layer.autoMotion).toBeNull();
    expect(told()).toBe(2);
    expect(layer.stormMotion()).toEqual(MANUAL());
    lateReq.resolve(srm(30, 240)); await late; // KTLX's vector arrives after the switch
    expect(layer.autoMotion).toBeNull();
    await read(layer, 'KFWS', null);
    await read(layer, 'KFWS', new Error('404'));
    expect(layer.autoMotion).toBeNull();
    expect(told()).toBe(2);
    await read(layer, 'KFWS', srm(25, 200));
    expect(layer.autoMotion).toMatchObject({ speedKt: 25, fromDeg: 200, site: 'KFWS' });
    await read(layer, 'KFWS', srm(200, 200)); // out of range
    expect(layer.autoMotion).toBeNull();
    await read(layer, 'KFWS', srm(25, 200));
    await read(layer, 'KFWS', { p: null }); // no vector in the product
    expect(layer.autoMotion).toBeNull();
    await read(layer, 'KFWS', srm(25, 200, Date.now() - 25 * 60e3)); // the newest product is 25 min old
    expect(layer.autoMotion).toBeNull();
    expect(told()).toBe(6);
    expect(layer.stormMotion()).toEqual(MANUAL());
  });

  it('expires a vector 20 minutes after its product time, also after storm-relative velocity is switched off', async () => {
    const { layer, told } = setup();
    await layer.refresh(); // selects KTLX
    layer.setAutoMotion({ speedKt: 30, fromDeg: 240 }, Date.now() - 19 * 60e3);
    settings.set('layerState.NEXRADLevel2Product', 0); // no more motion reads
    await layer.refresh();
    expect(layer.autoMotion).not.toBeNull();
    layer.setAutoMotion({ speedKt: 30, fromDeg: 240 }, Date.now() - 21 * 60e3); // same vector, older product
    expect(told()).toBe(1);
    await layer.refresh();
    expect(layer.autoMotion).toBeNull();
    expect(told()).toBe(2);
  });

  it('rebuilds custom storm-relative velocity with the manual vector when the main site changes', async () => {
    const { layer: nexrad } = setup();
    settings.set('settings.customRadarStormMotionCustom', false);
    nexrad.setAutoMotion({ speedKt: 30, fromDeg: 240 });
    const layer = new CustomRadarLayer(renderer, {} as never, nexrad);
    layer.sites = [{ name: 'KTST', state: 'OK', place: 'Test', lon: -97, lat: 35, elev: 1000 }];
    layer.servers = ['https://radar.example/'];
    settings.set('layerState.CustomRadarSite', 'KTST');
    settings.set('layerState.CustomRadarOn', true);
    settings.set('layerState.CustomRadarProduct', 7);
    const radar = h.radarDraws[h.radarDraws.length - 1];
    const poll = layer.poll(); await flush();
    last('l2.meta').resolve(lowVolume); await flush();
    expect(last('l2.product').args.params.stormMotion).toEqual({ speedKt: 30, fromDeg: 240 });
    last('l2.product').resolve({ sweep: sweep(7) }); await poll;
    expect(layer.identity()).toMatch(/,auto$/);
    settings.set('settings.nexradSiteICAO', 'KFWS'); nexrad.freeAll();
    expect(h.textures[0].destroyed).toBe(true); // never shown as the current automatic vector
    layer.draw(ctx);
    expect(radar.calls).toHaveLength(0);
    await flush();
    const manual = { speedKt: settings.num('settings.customRadarStormMotionSpeed'), fromDeg: settings.num('settings.customRadarStormMotionAzimuth') };
    expect(last('l2.product').args.params.stormMotion).toEqual(manual);
    last('l2.product').resolve({ sweep: sweep(7) }); await flush();
    layer.draw(ctx);
    expect(radar.calls).toHaveLength(1);
    expect(layer.identity()).not.toMatch(/,auto$/);
    settings.set('layerState.CustomRadarOn', false); layer.sync();
  });
});
