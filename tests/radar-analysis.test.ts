// Radar analysis tools: range-ring geometry, the beam readout of single-tilt products, VR-shear math, the VR-shear
// measurement's sampling and identity (RadarTools over a stub renderer), NexradLayer.shownScan, and the settings and
// dialog wiring of the range rings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/workers/pool', () => ({ pool: { run: vi.fn(() => new Promise(() => {})), for: () => ({ run: vi.fn(() => new Promise(() => {})) }) } }));
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RadarDraw: class { draw() {} invalidate() {} }, RasterDraw: class { draw() {} invalidate() {} }, Lut: class {},
}));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { lines: unknown[] = []; setStyles() {} setLines(l: unknown[]) { this.lines = l; } draw() {} },
  PointSet: class { setPoints() {} setAlpha() {} flushAlpha() {} draw() {} },
  TextSet: class { labels: { text: string }[] = []; setLabels(l: { text: string }[]) { this.labels = l; } flushAlpha() {} draw() {} },
}));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));

import { rangeRings, slantRangeKm, beamAt, beamText, vrShear } from '../src/radar/beam';
import { gcDistanceKm, bearingDeg, destination } from '../src/gis/geodesy';
import { RadarTools } from '../src/layers/radar-tools';
import { NexradLayer } from '../src/layers/nexrad';
import { timeline } from '../src/app/timeline';
import { settings, SettingsStore, SETTING_DEFS } from '../src/settings/store';
import { formDef } from '../src/ui/form';
import { analysisBindings } from '../src/ui/analysis-forms';
import { KT } from '../src/sections/sounding-math';

const SITE = { id: 'KTLX', lon: -97.277761, lat: 35.333361, elevFt: 1278 };
const POS = { lon: SITE.lon, lat: SITE.lat, elevM: SITE.elevFt * 0.3048 };
let snapshot: ReturnType<typeof settings.exportDocument>;
beforeEach(() => { snapshot = settings.exportDocument(); });
afterEach(() => settings.importDocument(snapshot));

describe('range rings', () => {
  it('rings every interval with north labels, spokes every N degrees out to the outer ring', () => {
    const g = rangeRings(SITE, 40, 5, 30);
    expect(g.rings).toHaveLength(5);
    g.rings.forEach((ring, k) => { for (let i = 0; i < ring.length; i += 2) expect(gcDistanceKm(SITE.lon, SITE.lat, ring[i], ring[i + 1])).toBeCloseTo(40 * (k + 1), 6); });
    expect(g.rings[0].slice(0, 2)).toEqual(g.rings[0].slice(-2)); // closed
    expect(g.labels.map((l) => l.km)).toEqual([40, 80, 120, 160, 200]);
    for (const l of g.labels) { expect(l.lon).toBeCloseTo(SITE.lon, 9); expect(l.lat).toBeGreaterThan(SITE.lat); }
    expect(g.spokes).toHaveLength(12);
    g.spokes.forEach((sp, i) => {
      const end = sp.slice(-2);
      expect(gcDistanceKm(SITE.lon, SITE.lat, end[0], end[1])).toBeCloseTo(200, 6);
      expect(bearingDeg(SITE.lon, SITE.lat, end[0], end[1])).toBeCloseTo((i * 30) % 360, 4);
    });
    expect(rangeRings(SITE, 40, 5, 0).spokes).toEqual([]);
  });
});

describe('beam geometry', () => {
  it('slant range and beam height at a known ground range and elevation (radar draw earth model, beamHeightKm)', () => {
    // 100 km ground range at 0.5°: s/kₑa = 100/8494.666; r = kₑa·sin(φ)/cos(θ + φ); h = r·sin θ + r²/15417.82.
    const phi = 100 / 8494.666, th = (0.5 * Math.PI) / 180;
    const r = (8494.666 * Math.sin(phi)) / Math.cos(th + phi), hKm = r * Math.sin(th) + (r * r) / 15417.82;
    expect(slantRangeKm(100, 0.5)).toBeCloseTo(r, 9);
    expect(r).toBeCloseTo(100.0187, 3); expect(hKm).toBeCloseTo(1.5217, 3);
    const [lon, lat] = destination(SITE.lon, SITE.lat, 90, 100);
    const b = beamAt(POS, lon, lat, 0.5);
    expect(b.groundKm).toBeCloseTo(100, 6); expect(b.azDeg).toBeCloseTo(90, 6);
    expect(b.arlKm).toBeCloseTo(hKm, 9); expect(b.mslKm).toBeCloseTo(hKm + 0.3895344, 6);
    // Imperial: 62.1 mi; 1.5217 km = 4,992 ft ARL; + 1,278 ft site elevation = 6,270 ft MSL.
    expect(beamText(b, 0.5, true)).toEqual(['62.1 mi @ 90° (slant 62.1 mi)', 'Beam 0.5°: 4,992 ft ARL / 6,270 ft MSL']);
    expect(beamText(b, 0.5, false)).toEqual(['100.0 km @ 90° (slant 100.0 km)', 'Beam 0.5°: 1,522 m ARL / 1,911 m MSL']);
  });
});

describe('VR shear', () => {
  const a = destination(SITE.lon, SITE.lat, 90, 50), b = destination(a[0], a[1], 0, 2);
  it('opposite signs: ΔV, Vr = (|Vin| + |Vout|)/2, shear = ΔV/d, in either click order', () => {
    for (const [p, q] of [[{ lon: a[0], lat: a[1], ms: -20 }, { lon: b[0], lat: b[1], ms: 30 }], [{ lon: b[0], lat: b[1], ms: 30 }, { lon: a[0], lat: a[1], ms: -20 }]]) {
      const s = vrShear(p, q, POS, 0.5);
      expect([s.vin, s.vout, s.dv, s.vr]).toEqual([-20, 30, 50, 25]);
      expect(s.distKm).toBeCloseTo(2, 6);
      expect(s.shear).toBeCloseTo(50 / 2000, 6);
      expect(s.meanRangeKm).toBeCloseTo((50 + gcDistanceKm(SITE.lon, SITE.lat, b[0], b[1])) / 2, 9);
      expect(s.beam.groundKm).toBeCloseTo(s.meanRangeKm, 6);
      expect(s.beam.arlKm).toBeCloseTo(beamAt(POS, ...destination(SITE.lon, SITE.lat, s.beam.azDeg, s.meanRangeKm), 0.5).arlKm, 9);
    }
  });
  it('same sign: no rotational velocity', () => {
    const s = vrShear({ lon: a[0], lat: a[1], ms: 10 }, { lon: b[0], lat: b[1], ms: 35 }, POS, 0.5);
    expect(s.vr).toBeNull(); expect(s.dv).toBe(25);
  });
});

describe('VR-shear measurement (RadarTools)', () => {
  type Probe = { x: number; y: number; layer: string; done: (r: { kind: string; value: number; layer: string } | null) => void };
  const setup = () => {
    const st = { product: 1, id: 'KTLX|1|false|0.5|q', scan: { key: 'KTLX|1|scanA', t: Date.UTC(2026, 10, 17, 21, 4), elevation: 0.5 } as { key: string; t: number; elevation: number | null } | null };
    const nexrad = {
      enabled: () => true, isL2: () => true, liveComposite: false, product: () => st.product, l3Entry: () => ({ category: 'Reflectivity' }),
      l2Identity: () => st.id, l3Identity: () => '', shownScan: () => st.scan, siteInfo: () => SITE,
      displayRange: () => ({ low: -127, high: 126, unit: 'kts' }),
    };
    const pick: [number, number] = destination(SITE.lon, SITE.lat, 90, 100);
    const renderer = { camera: { width: 1000, height: 800, project: () => [500, 400, true], pick: () => pick }, probeOnce: [] as Probe[] };
    const tools = new RadarTools(renderer as never, {} as never, nexrad as never);
    const frame = () => tools.draw({ probe: false } as never, SITE);
    const kts = (v: number) => ({ kind: 'nexrad', value: (v + 127) / 253, layer: 'nexrad' });
    return { st, tools, renderer, frame, kts };
  };
  const a = destination(SITE.lon, SITE.lat, 90, 50), b = destination(a[0], a[1], 0, 2);

  it('reads both points from the NEXRAD probe of the shown scan and reports Vin, Vout, ΔV, Vr, shear, range and beam', () => {
    const { tools, renderer, frame, kts } = setup();
    settings.set('config.generalRadarVelocityMPHForce', false);
    expect(tools.startShear()).toBeNull();
    expect(tools.shearClick(a)).toBe(false);
    expect(tools.shearClick(b)).toBe(true);
    frame();
    expect(renderer.probeOnce.map((p) => p.layer)).toEqual(['nexrad', 'nexrad']);
    renderer.probeOnce[0].done(kts(-40)); renderer.probeOnce[1].done(kts(50));
    const text = tools.shearText();
    expect(text).toContain('Vin -40.0 kt · Vout +50.0 kt · ΔV 90.0 kt');
    expect(text).toContain('Vr 45.0 kt');
    expect(text).toMatch(/Shear 2\.3\de-2 s⁻¹/); // 90 kt over 2 km
    expect(text).toContain('KTLX 0.5° scan 21:04Z');
    expect(tools.shear!.result!.vr).toBeCloseTo(45 * KT, 9);
    settings.set('config.generalRadarVelocityMPHForce', true); // the probe's "mph" option applies too
    expect(tools.shearText()).toContain('Vr 51.8 mph');
  });

  it('discards a read from a scan that is no longer shown, reads the new scan, and clears on a product change', () => {
    const { st, tools, renderer, frame, kts } = setup();
    tools.startShear(); tools.shearClick(a); tools.shearClick(b);
    frame();
    const stale = renderer.probeOnce.splice(0);
    st.scan = { ...st.scan!, key: 'KTLX|1|scanB', t: st.scan!.t + 300e3 };
    stale[0].done(kts(-40)); stale[1].done(kts(50));
    expect(tools.shear!.result).toBeNull();
    frame(); // the next frame reads the new scan
    expect(renderer.probeOnce).toHaveLength(2);
    renderer.probeOnce[0].done(kts(10)); renderer.probeOnce[1].done(kts(20));
    expect(tools.shearText()).toContain('Same sign: no couplet, Vr not computed');
    st.id = 'KTLX|1|false|1.3|q'; // another tilt
    frame();
    expect(tools.shear).toBeNull();
  });

  it('range-folded samples, non-velocity products and Esc', () => {
    const { st, tools, renderer, frame, kts } = setup();
    tools.startShear(); tools.shearClick(a); tools.shearClick(b); frame();
    renderer.probeOnce[0].done({ kind: 'nexrad', value: 256 / 65535, layer: 'nexrad' }); renderer.probeOnce[1].done(kts(50));
    expect(tools.shearText()).toBe('No velocity (no data or range folded) at a point');
    tools.cancelShear();
    expect(tools.shear).toBeNull();
    st.product = 0;
    expect(tools.startShear()).toMatch(/needs a velocity product/);
  });

  it('beam readout only for a single-tilt scan within range', () => {
    const { st, tools } = setup();
    expect(tools.beamProbe(10, 10)).toEqual(beamText(beamAt(POS, ...destination(SITE.lon, SITE.lat, 90, 100), 0.5), 0.5, settings.bool('config.distanceMeasureImperial')));
    st.scan = { ...st.scan!, elevation: null };
    expect(tools.beamProbe(10, 10)).toEqual([]);
  });
});

describe('NexradLayer.shownScan', () => {
  it('gives the drawn scan’s tilt for single-tilt products and none for volume or tilt-less products', () => {
    settings.set('settings.nexradSiteICAO', 'KTLX');
    settings.set('layerState.NEXRADOn', true); settings.set('layerState.NEXRADLevel2', true); settings.set('layerState.NEXRADLevel2Product', 1);
    const n = new NexradLayer({ camera: {} } as never, {} as never);
    const t = Date.UTC(2026, 10, 17, 21, 4);
    timeline.t = t + 60e3;
    const frame = { t, file: { t, url: 'u', name: 'v' }, sweep: { id: n.l2Identity(), elevation: 0.48 } };
    n.l2 = [frame as never];
    expect(n.shownScan()).toMatchObject({ t, elevation: 0.48 });
    settings.set('layerState.NEXRADLevel2Product', 13); // VIL (volume product)
    frame.sweep.id = n.l2Identity();
    expect(n.shownScan()!.elevation).toBeNull();
    settings.set('layerState.NEXRADLevel2', false);
    settings.set('layerState.NEXRADLevel3Product', 11); // N0U 0.5° base velocity
    n.l3 = [{ t, url: 'u', id: n.l3Identity(), tex: {}, elevation: 0.5 } as never];
    expect(n.shownScan()!.elevation).toBe(0.5);
    settings.set('layerState.NEXRADLevel3Product', 25); // DVL (no tilt)
    n.l3 = [{ t, url: 'u', id: n.l3Identity(), tex: {}, elevation: 0.5 } as never];
    expect(n.shownScan()!.elevation).toBeNull();
  });
});

describe('range-ring settings and dialog', () => {
  const ids = ['', 'Interval', 'Count', 'Color', 'Width', 'Labels', 'Spokes', 'SpokeInterval'].map((k) => `ext.settings.nexradRangeRings${k}`);
  it('each setting has a control in the analysis dialog that binds to it', () => {
    const controls = formDef('TFrmRadarAnalysis').controls;
    for (const id of ids) {
      const def = SETTING_DEFS.get(id)!;
      const c = controls.find((x) => x.id === def.ui[0]);
      expect(c, id).toBeTruthy();
      expect(c!.cls).toBe(def.type === 'boolean' ? 'TsCheckBox' : def.type === 'rgba' ? 'TsColorSelect' : def.type === 'integer' ? 'TsSpinEdit' : 'TsDecimalSpinEdit');
    }
    const names = new Set(controls.map((x) => `TFrmRadarAnalysis.${x.name}`));
    for (const key of Object.keys(analysisBindings({} as never).TFrmRadarAnalysis)) expect(names.has(key), key).toBe(true);
  });
  it('values are coerced to their ranges and persist as their own records', () => {
    const mem = new Map<string, string>(), kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = new SettingsStore(kv);
    expect(s.bool(ids[0])).toBe(false); expect(s.num(ids[1])).toBe(25); expect(s.num(ids[2])).toBe(10); expect(s.num(ids[7])).toBe(30);
    s.set(ids[0], true); s.set(ids[2], 100); s.set(ids[1], 0); s.set(ids[3], [10, 20, 30, 40]); s.set(ids[7], 2);
    s.flush();
    const again = new SettingsStore(kv);
    expect([again.bool(ids[0]), again.num(ids[2]), again.num(ids[1]), again.arr(ids[3]), again.num(ids[7])]).toEqual([true, 40, 1, [10, 20, 30, 40], 5]);
    expect(mem.has(`cwrv3.setting/${ids[2]}`)).toBe(true);
  });
});
