// 3D volume view: ray and bounds geometry against brute force and the camera's own picking, the occupancy grid
// against the sampler, the isosurface crossing search, the settings (persistence, dialog, codes) and the layer's rule
// that a march is composited only over the frame of its own volume.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ views: [] as { encoded: { pack: unknown; site: unknown; p: any }[]; drawn: number; destroyed: boolean }[] }));
vi.mock('../src/workers/pool', () => ({ pool: { run: vi.fn(() => new Promise(() => {})), for: () => ({ run: vi.fn(() => new Promise(() => {})) }) } }));
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RadarDraw: class { draw() {} invalidate() {} }, RasterDraw: class { draw() {} invalidate() {} }, Lut: class { rows = 1; constructor(_r: unknown, _p: unknown, readonly o: unknown) {} },
}));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { segs: ArrayLike<number> = []; setStyles() {} setLines() {} setSegments(s: ArrayLike<number>) { this.segs = s; } draw() {} },
  PointSet: class { setPoints() {} setAlpha() {} flushAlpha() {} draw() {} },
  TextSet: class { labels: { text: string; height?: number }[] = []; setLabels(l: { text: string }[]) { this.labels = l; } flushAlpha() {} draw() {} },
}));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));
vi.mock('../src/render/volume-view', async (orig) => ({
  ...(await orig<object>()),
  VolumeView: class {
    encoded: { pack: unknown; site: unknown; p: unknown }[] = []; drawn = 0; destroyed = false; width = 960; height = 540; divisor = 2;
    constructor() { h.views.push(this as never); }
    encode(_ctx: unknown, pack: unknown, site: unknown, p: unknown) { this.encoded.push({ pack, site, p }); }
    draw() { this.drawn++; }
    invalidate() {} destroy() { this.destroyed = true; }
  },
}));

import { Camera, EARTH_KM, lonLatToXYZ, xyzToLonLat } from '../src/render/camera';
import { siteFrame, toSite, viewRays, rayBounds, raySegment, polarOf, sitePoint, firstCrossing, VIEW_TOP_KM, ISO_BISECTIONS, type V3 } from '../src/render/volume-ray';
import { nextDivisor, PREPASS_BUDGET_MS } from '../src/render/volume-view';
import { buildOccupancy, occCell, occLayer, occupancyCode, OCC_N, OCC_LAYERS, OCC_COARSE, OCC_IMAGES } from '../src/radar/volume-pack';
import { sampleVolume, groundRangeKm, tiltHeightKm, type SampleVolume } from '../src/radar/volume-sample';
import { beamHeightKm } from '../src/radar/l2products';
import { NexradLayer } from '../src/layers/nexrad';
import { VIEW3D, VIEW3D_MOMENTS, view3dConfig, verticalScale } from '../src/layers/radar-volume3d';
import { timeline } from '../src/app/timeline';
import { settings, SettingsStore, SETTING_DEFS } from '../src/settings/store';
import { formDef } from '../src/ui/form';
import { analysisBindings } from '../src/ui/analysis-forms';

const SITE = { lon: -97.277761, lat: 35.333361, heightKm: 0.39 };
const add = (o: V3, d: V3, t: number): V3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
const unit = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

let snapshot: ReturnType<typeof settings.exportDocument>;
beforeEach(() => { snapshot = settings.exportDocument(); h.views.length = 0; });
afterEach(() => { settings.importDocument(snapshot); timeline.play(false); });

describe('site frame and view rays', () => {
  const f = siteFrame(SITE.lon, SITE.lat);
  it('is the orthonormal east / north / up frame of the radar shader', () => {
    const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const [a, b, want] of [[f.east, f.east, 1], [f.north, f.north, 1], [f.up, f.up, 1], [f.east, f.north, 0], [f.east, f.up, 0], [f.north, f.up, 0]] as const) expect(dot(a, b)).toBeCloseTo(want, 12);
    expect(f.east[2]).toBe(0);
    expect(f.north[2]).toBeGreaterThan(0);
    expect(toSite(f, f.up)).toEqual([0, 0, EARTH_KM].map((v) => expect.closeTo(v, 9)));
  });
  it('maps ground range and azimuth as the sweep mesh does and inverts to site points', () => {
    const b = rayBounds([0, 0, 9000], SITE.heightKm, 2.5, 460);
    for (const [az, s, hKm] of [[0, 10, 1], [90, 150, 4], [213.4, 320, 12.5], [359.9, 459, 19.9], [45, 0.4, 0.05]]) {
      const p = sitePoint(az, s, hKm, b), q = polarOf(p, b);
      expect(q.s).toBeCloseTo(s, 8); expect(q.h).toBeCloseTo(hKm, 8); expect(Math.abs(((q.az - az + 540) % 360) - 180)).toBeLessThan(1e-8);
      // The radar shader: normalize(c + (east·e + north·n) / EARTH) · (1 + h / EARTH).
      const a = (az * Math.PI) / 180, e = s * Math.sin(a), n = s * Math.cos(a), k = (EARTH_KM + SITE.heightKm + hKm * 2.5) / Math.hypot(e, n, EARTH_KM);
      expect(p).toEqual([e * k, n * k, EARTH_KM * k].map((v) => expect.closeTo(v, 8)));
    }
  });
  it('ends each view ray on the globe where camera.pick finds it', () => {
    const cam = new Camera();
    cam.width = 1600; cam.height = 900;
    cam.setView({ lon: -98.4, lat: 36.1, z: 7, tilt: 62, swivel: -35 }, true);
    cam.compute();
    const rays = viewRays(cam, f), b = rayBounds(rays.eye, SITE.heightKm, 1, 460);
    for (const [px, py] of [[800, 450], [300, 700], [1300, 520], [1000, 860]]) {
      const nx = (px / cam.width) * 2 - 1, ny = 1 - (py / cam.height) * 2;
      const d = unit([0, 1, 2].map((i) => rays.d0[i] + nx * rays.dx[i] + ny * rays.dy[i]) as V3);
      const bd = d[0] * rays.eye[0] + d[1] * rays.eye[1] + d[2] * rays.eye[2], ground = add(rays.eye, d, -bd - Math.sqrt(bd * bd - b.ground));
      // Back to world coordinates (earth radii): site coordinates are the components along east, north and up.
      const world = [0, 1, 2].map((i) => (f.east[i] * ground[0] + f.north[i] * ground[1] + f.up[i] * ground[2]) / EARTH_KM) as V3;
      const [lon, lat] = xyzToLonLat(world), want = cam.pick(px, py)!;
      expect(lon).toBeCloseTo(want[0], 7); expect(lat).toBeCloseTo(want[1], 7);
      // The march segment ends there or earlier (at the range cylinder).
      const seg = raySegment(rays.eye, d, b);
      if (seg) expect(seg[1]).toBeLessThanOrEqual(-bd - Math.sqrt(bd * bd - b.ground) + 1e-6);
    }
  });
});

describe('ray bounds', () => {
  const vscale = 2, range = 300, radar = EARTH_KM + SITE.heightKm, top = radar + VIEW_TOP_KM * vscale, radius = (range * top) / EARTH_KM;
  const bounds = (eye: V3) => rayBounds(eye, SITE.heightKm, vscale, range);
  it('enters at the top sphere and ends on the globe for a ray straight down the radar’s vertical', () => {
    const eye: V3 = [0, 0, EARTH_KM + 500];
    expect(raySegment(eye, [0, 0, -1], bounds(eye))).toEqual([expect.closeTo(EARTH_KM + 500 - top, 9), expect.closeTo(500, 9)]);
    expect(bounds(eye).radarKm).toBe(radar);
  });
  it('starts at the eye when the eye is inside the bounds and ends at the top looking up', () => {
    const eye: V3 = [20, -30, radar + 5];
    const seg = raySegment(eye, [0, 0, 1], bounds(eye))!;
    expect(seg[0]).toBe(0);
    expect(Math.hypot(...add(eye, [0, 0, 1], seg[1]))).toBeCloseTo(top, 8);
  });
  it('misses outside the range cylinder, along its axis or across it', () => {
    const eye: V3 = [radius + 50, 0, EARTH_KM + 300];
    expect(raySegment(eye, [0, 0, -1], bounds(eye))).toBeNull();          // parallel to the axis, outside
    expect(raySegment(eye, unit([0, 1, -1]), bounds(eye))).toBeNull();    // passes beside the cylinder
    expect(raySegment(eye, unit([-1, 0, -0.5]), bounds(eye))).not.toBeNull();
    expect(raySegment([0, 0, EARTH_KM + 300], [0, 0, 1], bounds([0, 0, EARTH_KM + 300]))).toBeNull(); // above the top, looking away
  });
  it('leaves through the cylinder wall for a grazing ray that never reaches the globe', () => {
    const eye: V3 = [0, 0, radar + 10];
    const d = unit([1, 0, 0.02]), seg = raySegment(eye, d, bounds(eye))!;
    const exit = add(eye, d, seg[1]);
    expect(seg[0]).toBe(0);
    expect(Math.hypot(exit[0], exit[1])).toBeCloseTo(radius, 6);
    expect(Math.hypot(...exit)).toBeLessThan(top);
  });
  it('matches brute-force stepping along random rays', () => {
    const rand = rng(7);
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const eye: V3 = [(rand() - 0.5) * 900, (rand() - 0.5) * 900, EARTH_KM + 1 + rand() * 600];
      const d = unit([rand() - 0.5, rand() - 0.5, -rand() * 0.8 + 0.1]), b = bounds(eye), seg = raySegment(eye, d, b);
      // Inside: below the top, within the cylinder, and before the first point under the globe.
      let first = -1, last = -1, underground = false;
      const step = 0.25;
      for (let t = 0; t < 2500 && !underground; t += step) {
        const p = add(eye, d, t), r = Math.hypot(...p);
        if (r < EARTH_KM) { underground = true; break; }
        if (r < top && Math.hypot(p[0], p[1]) < radius) { if (first < 0) first = t; last = t; }
      }
      if (!seg) { expect(last - first, `ray ${i}`).toBeLessThan(2 * step); continue; }
      hits++;
      expect(Math.abs(seg[0] - first), `ray ${i} enter`).toBeLessThanOrEqual(step + 1e-6);
      expect(Math.abs(seg[1] - last), `ray ${i} exit`).toBeLessThanOrEqual(step + 1e-6);
    }
    expect(hits).toBeGreaterThan(60);
  });
});

/** A small synthetic volume: `tilts` of 240 gates of 0.5 km from 1 km, empty but for the blobs written into it. */
function synthetic(moment: SampleVolume['moment'], elevations: number[]): SampleVolume {
  const width = 240;
  return { moment, width, tilts: elevations.map((elevation) => ({ elevation, firstKm: 1, gateKm: 0.5, gates: width })), layers: elevations.map(() => new Uint8Array(722 * width)) };
}
function blob(v: SampleVolume, tilt: number, bin0: number, bins: number, gate0: number, gates: number, code: (bin: number, gate: number) => number) {
  for (let b = bin0; b < bin0 + bins; b++) for (let g = gate0; g < gate0 + gates; g++) v.layers[tilt][(((b % 720) + 720) % 720 + 1) * v.width + g] = code(b, g);
}

describe('occupancy grid', () => {
  const v = synthetic('REF', [0.5, 1.5, 2.4, 4.0, 10.0]);
  blob(v, 0, 100, 12, 60, 30, (b, g) => 60 + ((b * 7 + g * 3) % 40));   // near the ground, north-east
  blob(v, 2, 400, 6, 150, 20, () => 120);                               // a core aloft, south-west
  blob(v, 3, 398, 10, 148, 26, (b, g) => 70 + ((b + g) % 9));           // blended with the tilt above it
  blob(v, 4, 715, 10, 20, 8, () => 90);                                 // across north, in the cone of the highest tilt
  const { occupancy, occKm } = buildOccupancy(v.moment, v.width, v.tilts, v.layers);
  const size = OCC_N * OCC_N, at = (image: number, i: number) => occupancy[image * size + i];

  it('covers the tilts’ ground range with OCC_N cells and holds the height bins, the column maxima and their coarse level', () => {
    expect(occupancy).toHaveLength(OCC_IMAGES * size);
    const reach = groundRangeKm(1 + 239.5 * 0.5, 0.5);
    expect((occKm * OCC_N) / 2).toBeGreaterThan(reach);
    expect((occKm * OCC_N) / 2).toBeLessThan(reach + 0.1);
    for (let i = 0; i < size; i++) {
      let m = 0;
      for (let z = 0; z < OCC_LAYERS; z++) m = Math.max(m, at(z, i));
      expect(at(OCC_LAYERS, i)).toBe(m);
    }
    for (let cy = 0; cy < OCC_N / OCC_COARSE; cy++) for (let cx = 0; cx < OCC_N / OCC_COARSE; cx++) {
      let m = 0;
      for (let y = 0; y < OCC_COARSE; y++) for (let x = 0; x < OCC_COARSE; x++) m = Math.max(m, at(OCC_LAYERS, (cy * OCC_COARSE + y) * OCC_N + cx * OCC_COARSE + x));
      expect(at(OCC_LAYERS + 1, cy * OCC_N + cx)).toBe(m);
    }
  });

  it('is never below what the sampler reads anywhere in a cell (brute force over the volume)', () => {
    const rand = rng(11);
    let data = 0, top = 0;
    const check = (az: number, s: number, hKm: number) => {
      const c = occupancyCode(v.moment, sampleVolume(v, az, s, hKm));
      if (!c) return;
      data++; top = Math.max(top, c);
      const i = occCell(az, s, occKm);
      expect(at(occLayer(hKm), i), `az ${az} s ${s} h ${hKm}`).toBeGreaterThanOrEqual(Math.ceil(c));
    };
    for (let i = 0; i < 150_000; i++) check(rand() * 360, rand() * 121, rand() * VIEW_TOP_KM);
    // Dense samples around each blob, where the data is.
    for (const [tilt, bin0, bins, gate0, gates] of [[0, 100, 12, 60, 30], [2, 400, 6, 150, 20], [3, 398, 10, 148, 26], [4, 715, 10, 20, 8]]) {
      for (let i = 0; i < 40_000; i++) {
        const el = v.tilts[tilt].elevation + (rand() - 0.5) * 3.2, r = 1 + (gate0 - 2 + rand() * (gates + 4)) * 0.5, s = groundRangeKm(r, v.tilts[tilt].elevation);
        check((0.25 + (bin0 - 2 + rand() * (bins + 4)) / 2 + 360) % 360, s, tiltHeightKm(s, el));
      }
    }
    expect(data).toBeGreaterThan(20_000);
    expect(top).toBe(120);
  });

  it('is empty away from the data: only cells within a cell, a gate group and the beam’s reach of a blob are set', () => {
    // The 0.5° blob: bins 100..111 are azimuths 50..56°, gates 60..89 are slant ranges 30.75..45.75 km.
    let set = 0;
    for (let y = 0; y < OCC_N; y++) for (let x = 0; x < OCC_N; x++) {
      const e = (x + 0.5 - OCC_N / 2) * occKm, n = (y + 0.5 - OCC_N / 2) * occKm, s = Math.hypot(e, n), az = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
      const i = y * OCC_N + x, low = at(0, i);
      if (at(OCC_LAYERS, i)) set++;
      const margin = occKm * 1.5 + 2.1;
      const nearBlob = s > 30.7 - margin && s < 45.8 + margin && az > 50 - (margin / s) * 57.3 && az < 56 + (margin / s) * 57.3;
      if (!nearBlob && s < 60 && az > 20 && az < 90) expect(low, `cell ${x},${y}`).toBe(0);
      if (s > 32 && s < 44 && az > 51 && az < 55) expect(low).toBeGreaterThanOrEqual(60);
    }
    expect(set / size).toBeLessThan(0.03);
    // The 0.5° blob lies below 1.2 km: nothing of it in the bins above its beam's reach (1.5° is empty there).
    const i = occCell(53, 38, occKm);
    expect(at(occLayer(beamHeightKm(38, 0.5)), i)).toBeGreaterThanOrEqual(60);
    expect(at(occLayer(beamHeightKm(38, 0.5) + 2.5), i)).toBe(0);
  });

  it('folds velocity to speed, so one threshold covers inbound and outbound', () => {
    expect([0, 1, 2, 129, 60, 198, 255].map((c) => occupancyCode('VEL', c))).toEqual([0, 0, 255, 129, 198, 198, 255]);
    expect([0, 1, 2, 60].map((c) => occupancyCode('REF', c))).toEqual([0, 0, 2, 60]);
    const vel = synthetic('VEL', [0.5, 1.5]);
    blob(vel, 0, 200, 4, 100, 8, () => 60); // 69 kt inbound
    const o = buildOccupancy('VEL', vel.width, vel.tilts, vel.layers);
    expect(o.occupancy[OCC_LAYERS * size + occCell(0.25 + 201 / 2, groundRangeKm(1 + 103 * 0.5, 0.5), o.occKm)]).toBe(198);
  });
});

describe('isosurface crossing', () => {
  // A ball of codes falling off from 200 at its centre by 10 per km; the 150 surface is the sphere of radius 5 km.
  const centre: V3 = [3, -2, 40], o: V3 = [0, 0, 0], d = unit([0.1, -0.05, 1]);
  const value = (t: number) => { const p = add(o, d, t); return 200 - 10 * Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]); };
  const bd = d[0] * centre[0] + d[1] * centre[1] + d[2] * centre[2], miss2 = Math.hypot(...centre) ** 2 - bd * bd;
  const exact = bd - Math.sqrt(25 - miss2);
  it('finds the threshold crossing within step / 2^bisections, on the inside', () => {
    for (const step of [0.3, 0.9, 2.5]) for (const start of [0, 0.37, 1.1]) {
      const t = firstCrossing(value, start, 80, step, 150)!;
      expect(t).toBeGreaterThanOrEqual(exact);
      expect(t - exact).toBeLessThanOrEqual(step / 2 ** ISO_BISECTIONS + 1e-9);
      expect(value(t)).toBeGreaterThanOrEqual(150);
    }
    expect(firstCrossing(value, 0, 80, 0.9, 150, 10)! - exact).toBeLessThan(0.9 / 1024 + 1e-9);
  });
  it('is the start of a ray that begins inside, null when the surface is never reached, and blind to features thinner than a step', () => {
    expect(firstCrossing(value, exact + 2, 80, 0.5, 150)).toBe(exact + 2);
    expect(firstCrossing(value, 0, 80, 0.5, 201)).toBeNull();
    expect(firstCrossing(value, 0, exact - 0.1, 0.5, 150)).toBeNull();
    const thin = (t: number) => (t > 10.1 && t < 10.3 ? 99 : 0);
    expect(firstCrossing(thin, 0, 40, 0.5, 50)).toBeNull();
    expect(firstCrossing(thin, 0, 40, 0.1, 50)).toBeCloseTo(10.1, 1);
  });
});

describe('3D view settings', () => {
  const moments = ['REF', 'VEL', 'ZDR', 'CC', 'KDP'];
  const ids = ['', 'Moment', 'Quality', 'Opacity', 'HeightScale', 'Iso2On', 'Iso1Color', 'Iso2Color', ...moments.flatMap((m) => [`Min${m}`, `Iso1${m}`, `Iso2${m}`])].map(VIEW3D);
  it('each setting has a control in the analysis dialog, and every binding names a control', () => {
    const controls = formDef('TFrmRadarAnalysis').controls, bindings = analysisBindings({} as never).TFrmRadarAnalysis;
    for (const id of ids) {
      const def = SETTING_DEFS.get(id)!;
      expect(def, id).toBeTruthy();
      const c = controls.find((x) => x.id === def.ui[0]);
      expect(c, id).toBeTruthy();
      const explicit = bindings[c!.id.replace(/^ui\./, '')];
      if (c!.cls === 'TsComboBox') { expect(explicit).toEqual({ kind: 'combo', id }); expect(c!.items).toHaveLength(def.max! + 1); }
      else if (/(Min|Iso[12])[A-Z]+$/.test(id)) expect(explicit?.kind).toBe('custom');
      else expect(c!.cls).toBe(def.type === 'boolean' ? 'TsCheckBox' : def.type === 'rgba' ? 'TsColorSelect' : def.type === 'integer' ? 'TsSpinEdit' : 'TsDecimalSpinEdit');
    }
    const names = new Set(controls.map((x) => `TFrmRadarAnalysis.${x.name}`));
    for (const key of Object.keys(bindings)) expect(names.has(key), key).toBe(true);
    expect(formDef('TFrmRadarAnalysis').controls.find((x) => x.name === 'v3Moment')!.items).toHaveLength(VIEW3D_MOMENTS.length);
  });
  it('shows the threshold controls of the selected moment and edits surface opacity as the colour’s alpha', () => {
    const b = analysisBindings({} as never).TFrmRadarAnalysis as Record<string, any>;
    settings.set(VIEW3D('Moment'), 2); // storm-relative velocity: the velocity thresholds
    expect(moments.filter((m) => !b[`TFrmRadarAnalysis.v3Iso1${m}`].hidden())).toEqual(['VEL']);
    expect(b['TFrmRadarAnalysis.v3Unit1'].text()).toBe('kts');
    expect(b['TFrmRadarAnalysis.v3Iso2Label'].text()).toBe('Inbound from');
    b['TFrmRadarAnalysis.v3Iso1VEL'].set(55);
    expect(settings.num(VIEW3D('Iso1VEL'))).toBe(55);
    settings.set(VIEW3D('Moment'), 0);
    expect(moments.filter((m) => !b[`TFrmRadarAnalysis.v3Min${m}`].hidden())).toEqual(['REF']);
    b['TFrmRadarAnalysis.v3Iso2Alpha'].set(40);
    expect(settings.arr(VIEW3D('Iso2Color'))).toEqual([70, 210, 110, 102]);
    expect(b['TFrmRadarAnalysis.v3Iso2Alpha'].get()).toBe(40);
  });
  it('values are coerced to their ranges and persist as their own records', () => {
    const mem = new Map<string, string>(), kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = new SettingsStore(kv);
    expect([s.num(VIEW3D('')), s.num(VIEW3D('Moment')), s.num(VIEW3D('Quality')), s.num(VIEW3D('Opacity')), s.bool(VIEW3D('HeightScale')), s.bool(VIEW3D('Iso2On'))]).toEqual([0, 0, 160, 1, true, true]);
    expect([s.num(VIEW3D('MinREF')), s.num(VIEW3D('Iso1REF')), s.num(VIEW3D('Iso2REF')), s.num(VIEW3D('Iso1VEL')), s.num(VIEW3D('Iso2CC'))]).toEqual([20, 50, 30, 40, 0.9]);
    s.set(VIEW3D(''), 2); s.set(VIEW3D('Moment'), 9); s.set(VIEW3D('Quality'), 5000); s.set(VIEW3D('Opacity'), 0); s.set(VIEW3D('Iso2On'), false);
    s.set(VIEW3D('Iso1REF'), 500); s.set(VIEW3D('Iso2VEL'), -3); s.set(VIEW3D('MinCC'), 0.95); s.set(VIEW3D('Iso1Color'), [1, 2, 3, 4]);
    s.flush();
    const again = new SettingsStore(kv);
    expect([again.num(VIEW3D('')), again.num(VIEW3D('Moment')), again.num(VIEW3D('Quality')), again.num(VIEW3D('Opacity')), again.bool(VIEW3D('Iso2On'))]).toEqual([2, 5, 512, 0.05, false]);
    expect([again.num(VIEW3D('Iso1REF')), again.num(VIEW3D('Iso2VEL')), again.num(VIEW3D('MinCC')), again.arr(VIEW3D('Iso1Color'))]).toEqual([95, 0, 0.95, [1, 2, 3, 4]]);
    for (const id of [VIEW3D(''), VIEW3D('Iso1REF'), VIEW3D('MinCC')]) expect(mem.has(`cwrv3.setting/${id}`)).toBe(true);
  });
  it('turns the settings into pack codes: values, speeds for velocity, and the lowest code drawn', () => {
    expect(view3dConfig()).toBeNull();
    settings.set(VIEW3D(''), 2);
    let c = view3dConfig()!;
    expect([c.view.moment, c.params.mode, c.params.steps, c.params.velocity, c.params.iso, c.minCode]).toEqual(['REF', 2, 160, false, [81, 61], 61]); // 50 and 30 dBZ
    expect(c.params.colors).toEqual([[1, 70 / 255, 50 / 255, 1], [70 / 255, 210 / 255, 110 / 255, 150 / 255]]);
    settings.set(VIEW3D('Iso2On'), false);
    c = view3dConfig()!;
    expect([c.params.iso, c.minCode]).toEqual([[81, 0], 81]);
    settings.set(VIEW3D(''), 1); settings.set(VIEW3D('MinREF'), 35); settings.set(VIEW3D('Opacity'), 2);
    c = view3dConfig()!;
    expect([c.params.mode, c.params.thresholdCode, c.params.fullCode, c.minCode]).toEqual([1, 66, 96, 66]);
    expect(c.params.opacity).toBeCloseTo(2 * 1.2, 12);
    settings.set(VIEW3D('Moment'), 2); settings.set(VIEW3D(''), 2); settings.set(VIEW3D('Iso2On'), true); settings.set(VIEW3D('Iso1VEL'), 50); settings.set(VIEW3D('Iso2VEL'), 30);
    c = view3dConfig()!;
    // Velocity: +50 kt is code 179; the inbound surface tests the mirrored code against the code of +30 kt.
    expect([c.view.moment, c.view.srv, c.view.product, c.params.velocity, c.params.iso, c.minCode]).toEqual(['VEL', true, 7, true, [179, 159], 159]);
    settings.set(VIEW3D('Moment'), 4);
    expect(view3dConfig()!.params.iso.map((x) => +x.toFixed(3))).toEqual([230.5, 209.5]); // CC 0.97 and 0.90
  });
  it('takes the vertical scale from the tilt exaggeration and keeps the volume from going flat', () => {
    expect([0, 25, 100, -10, -25, -100].map(verticalScale)).toEqual([1, 2, 5, 0.6, 0.2, 0.2]);
    settings.set(VIEW3D(''), 1); settings.set('settings.nexrad3DTiltExaggeration', 50);
    expect(view3dConfig()!.params.vscale).toBe(3);
  });
  it('coarsens the target while the prepass is over budget and refines it only when the finer size fits', () => {
    expect(nextDivisor(2, PREPASS_BUDGET_MS - 0.1)).toBe(2);
    expect(nextDivisor(2, PREPASS_BUDGET_MS + 0.1)).toBe(3);
    expect(nextDivisor(3, 9)).toBe(4);
    expect(nextDivisor(4, 9)).toBe(4);
    expect(nextDivisor(3, 1.5)).toBe(3);  // 1.5 ms at 1/3 would be 3.4 ms at 1/2
    expect(nextDivisor(3, 1.0)).toBe(2);
    expect(nextDivisor(4, 1.3)).toBe(3);
    expect(nextDivisor(2, 0)).toBe(2);
  });
});

describe('NEXRAD layer 3D view', () => {
  const T0 = Date.UTC(2024, 4, 6, 22, 3, 20), MIN = 60e3;
  /** A layer with three Level 2 volumes whose sweeps fit the selected product, and every pack "uploaded". */
  function setup() {
    settings.set('settings.nexradSiteICAO', 'KTLX');
    settings.set('layerState.NEXRADOn', true); settings.set('layerState.NEXRADLevel2', true); settings.set('layerState.NEXRADLevel2Product', 0);
    settings.set('settings.nexradScanTransitionMode', 1);
    const n = new NexradLayer({ camera: {}, gpu: {} } as never, {} as never);
    n.l2 = [0, 4, 8].map((m) => ({ t: T0 + m * MIN, file: { t: T0 + m * MIN, url: `vol${m}`, live: false, name: `vol${m}` }, sweep: { id: n.l2Identity(), elevation: 0.5 } })) as never;
    const asked: string[] = [], motions: unknown[] = [];
    const packs = new Map<string, object>();
    n.volumes.get = ((q: { url: string; moment: string }) => { asked.push(`${q.url}/${q.moment}`); const k = `${q.url}/${q.moment}`; if (!packs.has(k)) packs.set(k, { key: k, moment: q.moment, tilts: [1, 2, 3], bytes: 20 * 1048576 }); return packs.get(k); }) as never;
    n.volumes.setMotion = ((_p: unknown, m: unknown) => { motions.push(m); }) as never;
    const ctx = { enc: {}, r: {}, timing: () => undefined } as never, site = { lon: -97.28, lat: 35.33, heightKm: 0.39 };
    return { n, asked, motions, packs, ctx, site };
  }

  it('lists the loop’s volumes and the one drawn at the timeline time', () => {
    const { n } = setup();
    timeline.t = T0 + 5 * MIN;
    const f = n.volumeFrames('REF');
    expect(f.frames.map((x) => [x.t - T0, x.q.url, x.q.moment, x.q.site])).toEqual([[0, 'vol0', 'REF', 'KTLX'], [4 * MIN, 'vol4', 'REF', 'KTLX'], [8 * MIN, 'vol8', 'REF', 'KTLX']]);
    expect(f.shown).toBe(1);
    // As draw() does: the newest volume stays after its time, the oldest shows before its own.
    timeline.t = T0 + 40 * MIN;
    expect(n.volumeFrames('REF').shown).toBe(2);
    timeline.t = T0 - MIN;
    expect(n.volumeFrames('REF').shown).toBe(0);
    n.l2[1].sweep = undefined; // a volume whose sweep is not built is not part of the shown loop
    timeline.t = T0 + 5 * MIN;
    expect(n.volumeFrames('REF')).toMatchObject({ frames: [{ t: T0 }, { t: T0 + 8 * MIN }], shown: 0 });
    settings.set('layerState.NEXRADLevel2', false);
    expect(n.volumeFrames('REF')).toEqual({ frames: [], shown: -1 });
  });

  it('marches the pack of the shown volume and composites it only over that volume’s frame, never in the probe pass', () => {
    const { n, asked, ctx, site, packs } = setup();
    timeline.t = T0 + 5 * MIN;
    n.view3d.prepass(ctx);
    expect(h.views).toHaveLength(0); // off
    expect(n.view3d.status).toBe('Off');
    settings.set(VIEW3D(''), 2);
    n.view3d.prepass(ctx);
    const view = h.views[0];
    expect(asked).toEqual(['vol4/REF']);
    expect(view.encoded).toHaveLength(1);
    expect(view.encoded[0].pack).toBe(packs.get('vol4/REF'));
    expect(view.encoded[0].p).toMatchObject({ mode: 2, iso: [81, 61], emptyCode: 61, velocity: false, vscale: 1 });
    expect(n.view3d.status).toMatch(/^Reflectivity 22:07Z, 3 tilts\nTarget 960×540 \(1\/2 of the map\)$/);
    const pass = { r: {}, pass: {}, probe: false } as never;
    n.view3d.draw(pass, 'vol0', site); // the frame of another volume: nothing is drawn
    expect(view.drawn).toBe(0);
    n.view3d.draw({ r: {}, pass: {}, probe: true } as never, 'vol4', site);
    expect(view.drawn).toBe(0);
    n.view3d.draw(pass, 'vol4', site);
    expect(view.drawn).toBe(1);
    // The next frame shows another volume: its own pack is marched, and the old target is not drawn over it.
    timeline.t = T0 + 9 * MIN;
    n.view3d.prepass(ctx);
    expect(view.encoded[1].pack).toBe(packs.get('vol8/REF'));
    n.view3d.draw(pass, 'vol4', site);
    expect(view.drawn).toBe(1);
    // A pack still loading: nothing is marched or drawn for that frame.
    n.volumes.get = (() => null) as never; n.volumes.state = (() => 'loading') as never;
    n.view3d.prepass(ctx);
    n.view3d.draw(pass, 'vol8', site);
    expect([view.encoded.length, view.drawn, n.view3d.status]).toEqual([2, 1, 'Reflectivity 22:11Z: loading']);
    settings.set(VIEW3D(''), 0);
    n.view3d.prepass(ctx);
    expect(view.destroyed).toBe(true);
  });

  it('keeps the packs of the following loop frames requested while the loop plays, within the memory budget', () => {
    const { n, asked, ctx } = setup();
    settings.set(VIEW3D(''), 1);
    timeline.t = T0 + 5 * MIN;
    n.view3d.prepass(ctx);
    expect(asked).toEqual(['vol4/REF']);
    asked.length = 0;
    timeline.play(true);
    n.view3d.prepass(ctx);
    expect(asked).toEqual(['vol4/REF', 'vol8/REF', 'vol0/REF']);
    asked.length = 0;
    n.volumes.budgetBytes = 45 * 1048576; // room for two 20 MB packs: the shown one and the next
    n.view3d.prepass(ctx);
    expect(asked).toEqual(['vol4/REF', 'vol8/REF']);
  });

  it('sets the volume’s storm motion for storm-relative velocity, none for velocity, and lowers the empty-space code by the storm speed', () => {
    const { n, motions, ctx } = setup();
    settings.set('settings.nexradStormMotionCustom', true); settings.set('settings.nexradStormMotionSpeed', 25); settings.set('settings.nexradStormMotionAzimuth', 240);
    settings.set(VIEW3D(''), 2); settings.set(VIEW3D('Moment'), 2);
    timeline.t = T0 + 5 * MIN;
    n.view3d.prepass(ctx);
    expect(motions).toEqual([{ speedKt: 25, fromDeg: 240 }]);
    expect(h.views[0].encoded[0].p).toMatchObject({ velocity: true, iso: [169, 169], emptyCode: 169 - 25 });
    expect(n.view3d.status).toMatch(/^Storm-relative velocity 22:07Z, 3 tilts, storm motion 240° 25 kt/);
    settings.set(VIEW3D('Moment'), 1);
    n.view3d.prepass(ctx);
    expect(motions[1]).toBeNull();
    expect(h.views[0].encoded[1].p.emptyCode).toBe(169);
  });

  it('draws the height scale at the radar: a vertical line to the top with a tick cross and label every 5 km or 10 kft', () => {
    const { n, ctx, site } = setup();
    settings.set(VIEW3D(''), 1); settings.set('settings.nexrad3DTiltExaggeration', 25); settings.set('config.distanceMeasureImperial', false);
    timeline.t = T0 + 5 * MIN;
    n.view3d.prepass(ctx);
    n.view3d.draw({ r: {}, pass: {}, probe: false } as never, 'vol4', site);
    const v3 = n.view3d as unknown as { lines: { segs: number[] }; text: { labels: { text: string; height: number }[] } };
    expect(v3.text.labels.map((l) => l.text)).toEqual(['5 km', '10 km', '15 km', '20 km']);
    // Exaggeration 25 doubles heights: the 10 km label is 20 km above the radar level.
    expect(v3.text.labels[1].height * EARTH_KM).toBeCloseTo(site.heightKm + 20, 9);
    expect(v3.lines.segs).toHaveLength(7 * (1 + 2 * 4));
    const up = lonLatToXYZ(site.lon, site.lat), radius = (i: number) => Math.hypot(v3.lines.segs[i], v3.lines.segs[i + 1], v3.lines.segs[i + 2]) * EARTH_KM - EARTH_KM;
    expect([radius(0), radius(3)]).toEqual([expect.closeTo(site.heightKm, 6), expect.closeTo(site.heightKm + 40, 6)]);
    expect(v3.lines.segs[0] / v3.lines.segs[1]).toBeCloseTo(up[0] / up[1], 9);
    settings.set('config.distanceMeasureImperial', true);
    n.view3d.draw({ r: {}, pass: {}, probe: false } as never, 'vol4', site);
    expect(v3.text.labels.map((l) => l.text)).toEqual(['10 kft', '20 kft', '30 kft', '40 kft', '50 kft', '60 kft']);
  });
});
