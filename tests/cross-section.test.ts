// Cross-section / RHI tool: section geometry against the reference sampler (a single-gate target appears at its
// beam-centre height), the radar plane of the map line, RHI lines, end-point advection with storm motion, and the
// tool's placement, handle editing, follow mode and site-change clearing (CrossSection over a stub NEXRAD layer).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/workers/pool', () => ({ pool: { run: vi.fn(() => new Promise(() => {})), for: () => ({ run: vi.fn(() => new Promise(() => {})) }) } }));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { lines: unknown[] = []; setStyles() {} setLines(l: unknown[]) { this.lines = l; } draw() {} },
  PointSet: class { setPoints() {} draw() {} },
  TextSet: class { labels: { text: string }[] = []; setLabels(l: { text: string }[]) { this.labels = l; } draw() {} },
}));

import { toLocal, toLonLat, polarOf, rhiLine, advect, sectionAt, beamCurve, probeGeometry, sectionLength, tickStep, type EN } from '../src/radar/section-geometry';
import { sampleVolume, groundRangeKm, type SampleVolume } from '../src/radar/volume-sample';
import { beamHeightKm, AZ_BIN0 } from '../src/radar/l2products';
import { PACK_ROWS } from '../src/radar/volume-pack';
import { destination } from '../src/gis/geodesy';
import { CrossSection, SECTION_PRODUCT } from '../src/layers/cross-section';
import { SECTION_MOMENTS } from '../src/ui/section-panel';
import { L2, L2_PALETTE_KEYS } from '../src/radar/sources';
import { VOLUME_MOMENTS } from '../src/radar/l2products';
import { timeline } from '../src/app/timeline';
import { settings, SETTING_DEFS } from '../src/settings/store';
import { formDef } from '../src/ui/form';
import { analysisBindings } from '../src/ui/analysis-forms';

const SITE = { id: 'KTLX', lon: -97.277761, lat: 35.333361, elevFt: 1278 };
let snapshot: ReturnType<typeof settings.exportDocument>;
beforeEach(() => { snapshot = settings.exportDocument(); });
afterEach(() => settings.importDocument(snapshot));

/** A volume with one non-zero gate: tilt `k`, azimuth bin `bin`, gate `gate`. */
function targetVolume(k: number, bin: number, gate: number, code = 200): SampleVolume {
  const width = 400, tilts = [0.5, 1.5, 2.5, 4.0, 6.0].map((elevation) => ({ elevation, firstKm: 2.125, gateKm: 0.25, gates: width }));
  const layers = tilts.map(() => new Uint8Array(PACK_ROWS * width));
  layers[k][(bin + 1) * width + gate] = code;
  return { moment: 'REF', width, tilts, layers };
}

describe('section geometry', () => {
  it('finds a single-gate target at its beam-centre height, on an RHI and on an oblique line', () => {
    const k = 2, bin = 74, gate = 200, v = targetVolume(k, bin, gate);
    const az = AZ_BIN0 + bin / 2, el = v.tilts[k].elevation, r = 2.125 + gate * 0.25;
    const s = groundRangeKm(r, el), h = beamHeightKm(r, el);
    const target: EN = [s * Math.sin((az * Math.PI) / 180), s * Math.cos((az * Math.PI) / 180)];
    const W = 600, H = 300;
    const lines = [
      { a: [0, 0] as EN, b: [100 * Math.sin((az * Math.PI) / 180), 100 * Math.cos((az * Math.PI) / 180)] as EN, topKm: 6 },
      { a: [target[0] - 20, target[1] + 15] as EN, b: [target[0] + 20, target[1] - 15] as EN, topKm: 6 },
    ];
    for (const line of lines) {
      const hits: { fx: number; h: number }[] = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = sectionAt(line, (x + 0.5) / W, (y + 0.5) / H);
        if (sampleVolume(v, p.az, p.s, p.h) === 200) hits.push({ fx: (x + 0.5) / W, h: p.h });
      }
      expect(hits.length).toBeGreaterThan(0);
      const meanH = hits.reduce((n, p) => n + p.h, 0) / hits.length;
      expect(Math.abs(meanH - h)).toBeLessThan(0.02); // a 1° beam's zone is centred on the beam
      // The beam-centre curve the panel draws passes through the target where the line crosses it.
      const fx = hits.reduce((n, p) => n + p.fx, 0) / hits.length, curve = beamCurve(line, el, 2.125 + 400 * 0.25, 600);
      const near = curve.reduce((a, b) => (Math.abs(b[0] - fx) < Math.abs(a[0] - fx) ? b : a));
      expect(near[1]).toBeCloseTo(h, 1);
      const g = probeGeometry(s, h, v.tilts);
      expect(g.nearest).toBe(k); expect(g.slantKm).toBeCloseTo(r, 6); expect(Math.abs(g.offDeg)).toBeLessThan(1e-6);
    }
  });

  it('puts map points in the plane the radar draw uses, round trip and against great-circle range and bearing', () => {
    for (const [brg, km] of [[0, 50], [137, 120], [251.5, 230], [330, 5]]) {
      const [lon, lat] = destination(SITE.lon, SITE.lat, brg, km), p = polarOf(toLocal(SITE, lon, lat));
      expect(p.az).toBeCloseTo(brg, 1);
      expect(Math.abs(p.s - km)).toBeLessThan(0.02 + (km / 6371) ** 2 * km); // gnomonic plane vs great circle
      const back = toLonLat(SITE, toLocal(SITE, lon, lat));
      expect(back[0]).toBeCloseTo(lon, 9); expect(back[1]).toBeCloseTo(lat, 9);
    }
  });

  it('puts both RHI end points on the radial of the point moved, each keeping its range', () => {
    const [a, b] = rhiLine([10, 0], [0, 50], [30, 30]);
    expect(polarOf(a).az).toBeCloseTo(45, 9); expect(polarOf(b).az).toBeCloseTo(45, 9);
    expect(polarOf(a).s).toBeCloseTo(10, 9); expect(polarOf(b).s).toBeCloseTo(50, 9);
  });

  it('advects end points with the storm motion (coming from fromDeg) for the elapsed time', () => {
    const p = advect([10, 20], { speedKt: 30, fromDeg: 270 }, 3600e3);
    expect(p[0]).toBeCloseTo(10 + 30 * 1.852, 9); expect(p[1]).toBeCloseTo(20, 9);
    const q = advect([0, 0], { speedKt: 40, fromDeg: 225 }, 30 * 60e3);
    expect(q[0]).toBeCloseTo(20 * 1.852 * Math.SQRT1_2, 9); expect(q[1]).toBeCloseTo(20 * 1.852 * Math.SQRT1_2, 9);
    expect(advect(q, { speedKt: 40, fromDeg: 225 }, -30 * 60e3)[0]).toBeCloseTo(0, 9);
  });

  it('chooses round tick steps along the line', () => {
    expect(tickStep(100, 1)).toBe(20); expect(tickStep(30, 1)).toBe(5); expect(tickStep(300, 1.609344)).toBe(25);
    expect(sectionLength({ a: [0, 0], b: [3, 4] })).toBe(5);
  });

  it('maps every moment to the map product whose palette and range decode the pack codes', () => {
    for (const m of SECTION_MOMENTS) {
      const p = L2[SECTION_PRODUCT[m]], pack = VOLUME_MOMENTS[m === 'SRV' ? 'VEL' : m];
      expect(L2_PALETTE_KEYS[SECTION_PRODUCT[m]]).toBeTruthy();
      // The radar draw's 8-bit value at code c: reserve → low + (high − low)(c − 2)/253, else low + (high − low)c/255.
      const value = (c: number) => (p.reserve ? p.low + ((p.high - p.low) * (c - 2)) / 253 : p.low + ((p.high - p.low) * c) / 255);
      for (const c of [2, 100, 254]) expect(Math.abs(value(c) * (m === 'CC' ? 0.01 : 1) - (c * pack.scale + pack.offset))).toBeLessThan(m === 'REF' ? 1.01 : 0.01);
    }
  });
});

describe('cross-section tool', () => {
  const ll = (e: number, n: number) => toLonLat(SITE, [e, n]);
  const setup = () => {
    let site = SITE.id;
    const motion = { speedKt: 30, fromDeg: 270 };
    const nexrad = { siteInfo: () => ({ ...SITE, id: site }), stormMotion: vi.fn(() => motion), volumeRequest: () => null, volumes: {} };
    const renderer = { camera: { project: () => [0, 0, true] } } as never;
    const x = new CrossSection(renderer, {} as never, nexrad as never);
    return { x, nexrad, setSite: (s: string) => { site = s; } };
  };
  const close = (p: EN, q: EN) => { expect(p[0]).toBeCloseTo(q[0], 6); expect(p[1]).toBeCloseTo(q[1], 6); };

  it('places A→B by a drag or by two clicks, and an RHI on the radial of B', () => {
    const { x } = setup();
    x.press(ll(10, 10)); x.move(ll(40, 10));
    expect(x.release(ll(50, 10), true)).toBe(true);
    close(x.line!.a, [10, 10]); close(x.line!.b, [50, 10]);
    x.clear();
    x.press(ll(0, 30));
    expect(x.release(ll(0, 30), false)).toBe(false); // first click: waits for B
    x.press(ll(0, 80));
    expect(x.release(ll(0, 80), false)).toBe(true);
    close(x.line!.b, [0, 80]);
    x.clear();
    settings.set('ext.settings.nexradSectionRhi', true);
    x.press(ll(20, 0));
    expect(x.release(ll(60, 60), true)).toBe(true);
    expect(polarOf(x.line!.a).az).toBeCloseTo(45, 6); expect(polarOf(x.line!.a).s).toBeCloseTo(20, 6);
  });

  it('follows storm motion from the time the line was placed or last edited', () => {
    const { x } = setup();
    const t0 = timeline.t;
    x.press(ll(0, 0)); x.release(ll(0, 50), true);
    expect(x.line!.t0).toBe(t0);
    close(x.endpoints(t0 + 20 * 60e3)![1], [0, 50]); // follow off
    settings.set('ext.settings.nexradSectionFollow', true);
    const later = x.endpoints(t0 + 20 * 60e3)!;
    close(later[0], advect([0, 0], { speedKt: 30, fromDeg: 270 }, 20 * 60e3)); close(later[1], [30 * 1.852 / 3, 50]);
    // Dragging B at another time re-bases the line at that time.
    timeline.t = t0 + 10 * 60e3;
    try {
      x.dragHandle('b', ll(5, 60));
      expect(x.line!.t0).toBe(t0 + 10 * 60e3);
      close(x.endpoints(t0 + 10 * 60e3)![1], [5, 60]);
      close(x.endpoints(t0 + 10 * 60e3)![0], advect([0, 0], { speedKt: 30, fromDeg: 270 }, 10 * 60e3));
    } finally { timeline.t = t0; }
  });

  it('is cleared when another radar is selected, and Esc-style clear ends the tool', () => {
    const { x, setSite } = setup();
    const cleared = vi.fn();
    x.onClear = cleared;
    x.press(ll(0, 0)); x.release(ll(0, 50), true);
    setSite('KINX');
    x.prepass({} as never);
    expect(x.line).toBeNull();
    expect(cleared).toHaveBeenCalledTimes(1);
    x.press(ll(0, 0));
    x.clear();
    expect(x.placing).toBeNull();
    expect(cleared).toHaveBeenCalledTimes(2);
  });
});

describe('analysis dialog settings', () => {
  const ids = ['nexradSectionMoment', 'nexradSectionTop', 'nexradSectionBeams', 'nexradSectionIsotherms', 'nexradSectionFollow', 'nexradSectionRhi', 'nexradSectionWidth', 'nexradSectionHeight',
    'nexradTrail', 'nexradTrailProduct', 'nexradTrailMinutes', 'nexradTrailOpacity', 'nexradLevel2Rolling'].map((k) => `ext.settings.${k}`);
  it('each new setting has a control in the analysis dialog bound to it (combo boxes explicitly)', () => {
    const controls = formDef('TFrmRadarAnalysis').controls, bindings = analysisBindings({} as never).TFrmRadarAnalysis;
    for (const id of ids) {
      const def = SETTING_DEFS.get(id)!;
      expect(def, id).toBeTruthy();
      const c = controls.find((x) => x.id === def.ui[0])!;
      expect(c, id).toBeTruthy();
      if (c.cls === 'TsComboBox') expect((bindings[`TFrmRadarAnalysis.${c.name}`] as { id: string }).id).toBe(id);
      else expect(c.cls).toBe(def.type === 'boolean' ? 'TsCheckBox' : def.type === 'integer' ? 'TsSpinEdit' : 'TsDecimalSpinEdit');
    }
    const names = new Set(controls.map((x) => `TFrmRadarAnalysis.${x.name}`));
    for (const key of Object.keys(bindings)) expect(names.has(key), key).toBe(true);
    expect(controls.find((x) => x.name === 'trProduct')!.items).toHaveLength(11);
  });
});
