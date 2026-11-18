// Max-value trail: the blend's texel mapping (trailTexel, mirrored by the WGSL blend) against a direct CPU maximum on
// small synthetic frames, and RadarTrail's identity: which volumes it requests and blends, rebuilding only when the
// site, product, window or frame set changes, and discarding results of another site or a superseded request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Run = { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ runs: [] as Run[], uploads: 0 }));
vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))); return { pool: { run, for: () => ({ run }) } }; });
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RadarDraw: class { calls: any[] = []; draw(_c: unknown, p: unknown) { this.calls.push(p); } },
  Lut: class { rows = 1; },
  uploadSweep: vi.fn((_r: unknown, s: { gates: number; firstKm: number; gateKm: number; radials: number }) => { h.uploads++; return { tex: { destroy() {}, createView: () => ({}) }, firstKm: s.firstKm, gateKm: s.gateKm, gates: s.gates, rows: s.radials + 2, az0: 0.25, spacing: 0.5, radials: s.radials, maxRangeKm: s.firstKm + s.gates * s.gateKm }; }),
}));

import { trailTexel, trailReference, trailRowAz, TRAIL_ROWS, type PolarGeom } from '../src/render/trail';
import { RadarTrail, TRAIL_PRODUCTS, type TrailHost } from '../src/layers/radar-trail';
import { padSweep } from '../src/radar/sweep-pad';
import { Gpu } from '../src/render/gpu';
import { settings } from '../src/settings/store';

Object.assign(globalThis, { GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, COPY_SRC: 1 }, GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 }, GPUShaderStage: { FRAGMENT: 2 } });

let snapshot: ReturnType<typeof settings.exportDocument>;
beforeEach(() => { snapshot = settings.exportDocument(); h.runs.length = 0; h.uploads = 0; });
afterEach(() => settings.importDocument(snapshot));

/** A sweep as uploaded: `radials` rows from az0 at `spacing`, padded with the two wrap rows. */
function sweep(radials: number, gates: number, az0: number, spacing: number, gateKm: number, code: (r: number, g: number) => number) {
  const codes = Uint8Array.from({ length: radials * gates }, (_, i) => code(Math.floor(i / gates), i % gates));
  const geom: PolarGeom = { firstKm: 2.125, gateKm, gates, rows: radials + 2, az0, spacing };
  return { geom, image: padSweep(codes, radials, gates, true, 8) as Uint8Array, codes };
}

describe('trail blend math', () => {
  const dst = { firstKm: 2.125, gateKm: 0.25, gates: 60 };
  it('is the texel-wise maximum of frames already on the target frame', () => {
    const a = sweep(720, 60, 0.25, 0.5, 0.25, (r, g) => (r * 7 + g * 3) % 200), b = sweep(720, 60, 0.25, 0.5, 0.25, (r, g) => (r * 5 + g * 11 + 40) % 230);
    const out = trailReference(dst, [a, b]);
    for (let y = 0; y < TRAIL_ROWS; y++) {
      const bin = (y + 719) % 720;
      for (let g = 0; g < 60; g++) expect(out[y * 60 + g]).toBe(Math.max(a.codes[bin * 60 + g], b.codes[bin * 60 + g]));
    }
  });
  it('reads 1° radials and coarser gates at the nearest radial and gate, and leaves the far gates empty', () => {
    const one = sweep(360, 20, 0.5, 1, 0.5, (r, g) => 2 + ((r + g * 17) % 250));
    const out = trailReference(dst, [one]);
    for (let y = 0; y < TRAIL_ROWS; y++) {
      const az = trailRowAz(y);
      for (let g = 0; g < 60; g++) {
        const r = 2.125 + g * 0.25, gate = Math.round((r - 2.125) / 0.5);
        let rad = Math.floor(az - 0.5 + 0.5); rad = ((rad % 360) + 360) % 360;
        // The source radial whose 1° span holds the bin centre (bin centres sit a quarter degree off the radial edges).
        expect(Math.abs(((0.5 + rad - az + 540) % 360) - 180)).toBeLessThanOrEqual(0.5);
        expect(out[y * 60 + g]).toBe(gate < 20 && (r - 2.125) / 0.5 + 0.5 < 20 * 0.9992 ? one.codes[rad * 20 + gate] : 0);
      }
    }
  });
  it('rotates a frame whose first radial is not at the frame origin onto the shared azimuths', () => {
    const shifted = sweep(720, 4, 100.25, 0.5, 0.25, (r) => (r % 250) + 2); // radial r at 100.25 + r/2
    const out = trailReference({ firstKm: 2.125, gateKm: 0.25, gates: 4 }, [shifted]);
    for (const bin of [0, 199, 200, 719]) expect(out[(bin + 1) * 4]).toBe((((bin - 200 + 720) % 720) % 250) + 2);
    expect(trailTexel(shifted.geom, 100.25, 2.125)).toEqual([0, 1]);
    expect(trailTexel(shifted.geom, 100.25, 2.125 + 4 * 0.25)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ RadarTrail
function fakeGpu() {
  const log = { targets: 0, passes: [] as { draws: number }[] };
  const device = {
    createTexture: () => { log.targets++; return { destroy() {}, createView: () => ({}) }; },
    createBuffer: () => ({ destroy() {} }), createBindGroup: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({ getCompilationInfo: () => Promise.resolve({ messages: [] }) }), createRenderPipeline: () => ({}),
    queue: { writeBuffer() {}, writeTexture() {} },
  };
  const gpu = new Gpu({} as HTMLCanvasElement);
  gpu.device = device as never;
  const enc = { beginRenderPass: () => { const p = { draws: 0 }; log.passes.push(p); return { setPipeline() {}, setBindGroup() {}, draw() { p.draws++; }, end() {} }; } };
  return { r: { gpu } as never, ctx: { enc, timing: () => undefined } as never, log };
}

const T0 = Date.UTC(2024, 4, 6, 22, 3);
const meta = { sweeps: [] } as never;
function host(over: Partial<TrailHost> = {}) {
  let site = 'KTLX';
  const l2 = [0, 1, 2, 3].map((i) => ({ t: T0 + i * 5 * 60e3, file: { url: `https://x/KTLX_${i}`, live: i === 3 }, meta }));
  const h0: TrailHost & { shown: number } = {
    l2, liveComposite: false, tiltAngle: 0.5, shown: T0 + 10 * 60e3,
    enabled: () => true, isL2: () => true, sweepFor: () => 0,
    siteInfo: () => ({ id: site, lon: -97.28, lat: 35.33, elevFt: 1278 }),
    algorithmParams: () => ({ qualityDealiasing: true, stormMotion: { speedKt: 0, fromDeg: 0 }, hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 4000, hm20Custom: 6000, etThreshold: 18, gust1991: false }),
    shownScan(): { t: number } { return { t: h0.shown }; },
    ...over,
  };
  return { h: h0, setSite: (s: string) => { site = s; } };
}
const result = (gates = 30) => ({ meta: {}, sweep: { radials: 720, gates, firstKm: 2.125, gateKm: 0.5, elevation: 0.5, upload: new Uint8Array(722 * gates) } });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('RadarTrail', () => {
  beforeEach(() => { settings.set('ext.settings.nexradTrail', true); settings.set('ext.settings.nexradTrailProduct', 19); settings.set('ext.settings.nexradTrailMinutes', 0); });

  it('requests the complete volumes newest first, two at a time, and blends those that arrived', async () => {
    const { h: hs } = host(), { r, ctx, log } = fakeGpu(), trail = new RadarTrail(r, hs);
    trail.prepass(ctx);
    expect(h.runs.map((x) => x.args.url)).toEqual(['https://x/KTLX_2', 'https://x/KTLX_1']); // the live volume is not used
    expect(h.runs.every((x) => x.task === 'l2.product' && x.args.product === 19 && x.args.sweep === 0 && !x.args.live)).toBe(true);
    h.runs[0].resolve(result()); await flush();
    trail.prepass(ctx);
    expect(trail.target!.n).toBe(1);
    expect(log.passes.at(-1)!.draws).toBe(1);
    expect(h.runs.map((x) => x.args.url)).toEqual(['https://x/KTLX_2', 'https://x/KTLX_1', 'https://x/KTLX_0']);
    h.runs[1].resolve(result()); h.runs[2].resolve(result()); await flush();
    trail.prepass(ctx);
    expect(log.passes.at(-1)!.draws).toBe(3);
    const passes = log.passes.length;
    trail.prepass(ctx); trail.prepass(ctx);
    expect(log.passes.length).toBe(passes); // nothing changed: no rebuild
    expect(trail.legend()!.note).toBe('Hail core: max over 22:03–22:13Z (3 volumes)');
  });

  it('narrows to the window ending at the shown volume without new requests, and follows the shown volume', async () => {
    const { h: hs } = host(), { r, ctx, log } = fakeGpu(), trail = new RadarTrail(r, hs);
    trail.prepass(ctx); h.runs[0].resolve(result()); h.runs[1].resolve(result()); await flush();
    trail.prepass(ctx); h.runs[2].resolve(result()); await flush();
    trail.prepass(ctx);
    settings.set('ext.settings.nexradTrailMinutes', 6);
    hs.shown = T0 + 5 * 60e3;
    trail.prepass(ctx);
    expect(log.passes.at(-1)!.draws).toBe(2);
    expect(trail.legend()!.note).toBe('Hail core: max over 22:03–22:08Z (2 volumes)');
    hs.shown = T0;
    trail.prepass(ctx);
    expect(trail.target!.n).toBe(1);
    expect(h.runs).toHaveLength(3);
  });

  it('rebuilds for another product and discards the old product results still in flight', async () => {
    const { h: hs } = host(), { r, ctx } = fakeGpu(), trail = new RadarTrail(r, hs);
    trail.prepass(ctx);
    const old = [...h.runs];
    settings.set('ext.settings.nexradTrailProduct', 13);
    trail.prepass(ctx);
    expect(h.runs.slice(2).map((x) => x.args.product)).toEqual([13, 13]);
    old.forEach((x) => x.resolve(result())); await flush();
    expect(h.uploads).toBe(0);
    trail.prepass(ctx);
    expect(trail.target).toBeNull();
    h.runs[2].resolve(result()); await flush();
    trail.prepass(ctx);
    expect(trail.target!.product).toBe(13);
    expect(trail.legend()!.note).toMatch(/^VIL: max over/);
    settings.set('ext.settings.nexradTrailProduct', 9); // not a trail product: the default (hail core)
    expect(trail.product()).toBe(19);
    expect(TRAIL_PRODUCTS).toContain(trail.product());
  });

  it('skips volumes the host has no sweep for (column products on pre-dual-pol volumes)', () => {
    settings.set('ext.settings.nexradTrailProduct', 17);
    const { h: hs } = host({ sweepFor: (_m, p) => (p === 17 ? null : 0) }), { r, ctx } = fakeGpu(), trail = new RadarTrail(r, hs);
    trail.prepass(ctx);
    expect(h.runs).toHaveLength(0);
    expect(trail.target).toBeNull();
  });

  it('never mixes sites: a site change drops the blend and discards results of the old site', async () => {
    const { h: hs, setSite } = host(), { r, ctx } = fakeGpu(), trail = new RadarTrail(r, hs);
    trail.prepass(ctx); h.runs[0].resolve(result()); await flush();
    trail.prepass(ctx);
    expect(trail.target).not.toBeNull();
    setSite('KINX');
    trail.prepass(ctx);
    expect(trail.target).toBeNull();
    const uploads = h.uploads;
    h.runs[1].resolve(result()); await flush(); // KTLX volume answered after the switch
    expect(h.uploads).toBe(uploads);
    trail.prepass(ctx);
    expect(trail.target).toBeNull(); // the new site's volumes are requested afresh
  });

  it('re-requests a volume whose build inputs changed and draws nothing while off', async () => {
    const { h: hs } = host(), { r, ctx } = fakeGpu(), trail = new RadarTrail(r, hs);
    trail.prepass(ctx); h.runs[0].resolve(result()); await flush(); trail.prepass(ctx);
    const before = h.runs.length;
    hs.algorithmParams = () => ({ ...host().h.algorithmParams(), h0Custom: 3500 });
    trail.prepass(ctx);
    expect(trail.target).toBeNull(); // the old blend was built with other isotherm heights
    expect(h.runs.length).toBeGreaterThan(before);
    settings.set('ext.settings.nexradTrail', false);
    trail.prepass(ctx);
    expect(trail.target).toBeNull();
    expect(trail.legend()).toBeNull();
  });
});
