// Rolling live volume products: a live volume still being scanned takes the tilts it has not rescanned yet from the
// previous volume (rollingTilts), end to end through the worker's 'l2.product' task on synthetic Archive II volumes,
// and the NEXRAD layer requests it only for the live volume, under its own identity.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeArchive2, splitSailsVolume, concat, type SynthVolume } from './helpers/archive2-writer';

type Run = { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), runs: [] as Run[] }));
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchBytes: vi.fn(async (url: string) => { const b = h.files.get(url); if (!b) throw new Error(`404 ${url}`); return b.slice(); }) }));
vi.mock('../src/workers/pool', () => { const run = vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))); return { pool: { run, for: () => ({ run }) } }; });
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

import { decodeArchive2 } from '../src/decode/archive2';
import { recodeVolume, rollingTilts, buildProduct } from '../src/radar/l2products';
import { L2_HANDLERS, configureL2 } from '../src/workers/l2-volumes';
import { JobClock } from '../src/workers/job-clock';
import { NexradLayer } from '../src/layers/nexrad';
import { settings } from '../src/settings/store';

const T = Date.UTC(2024, 4, 6, 22, 8, 10);
/** The previous volume: the same scan five minutes earlier with a 70 dBZ core in its upper (4.0° and 8.0°) tilts. */
const prevSynth: SynthVolume = (() => {
  const v = splitSailsVolume();
  return { ...v, timeMs: T - 300e3, cuts: v.cuts.map((c, i) => (i < 6 ? c : { ...c, moments: c.moments.map((m) => (m.name === 'REF' ? { ...m, code: (r: number, g: number) => (r < 40 && g > 10 ? 66 + 2 * 70 : m.code(r, g)) } : m)) })) };
})();
const liveSynth: SynthVolume = { ...splitSailsVolume(), timeMs: T };
const prevBytes = concat(writeArchive2(prevSynth));
/** Live volume as received so far: header, cuts 0–5 complete and the first half of cut 6 (4.0°). */
const liveBytes = concat(writeArchive2(liveSynth).slice(0, 14));
const params = { qualityDealiasing: true, stormMotion: { speedKt: 0, fromDeg: 0 }, hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 300, hm20Custom: 900, envIsotherms: null, etThreshold: 18.5, gust1991: false };

describe('rolling tilts', () => {
  const live = recodeVolume(decodeArchive2(liveBytes)), prev = recodeVolume(decodeArchive2(prevBytes));
  it('keeps the live volume complete tilts and fills the tilts above the highest one from the previous volume', () => {
    expect(live.map((s) => s.complete)).toEqual([true, true, true, true, true, true, false]);
    const pick = rollingTilts(live, prev);
    expect(pick.live).toEqual([0, 2, 5]); // 0.5° surveillance, 1.5°, 2.5° (split-cut Doppler and SAILS rescans excluded)
    expect(pick.prev).toEqual([6, 7]); // 4.0° (still being scanned live) and 8.0°
    expect(rollingTilts(prev, prev)).toEqual({ live: [0, 2, 5, 6, 7], prev: [] }); // a complete volume needs no filling
    expect(rollingTilts(live.slice(0, 1).map((s) => ({ ...s, complete: false })), prev).prev).toEqual([0, 2, 5, 6, 7]);
  });

  it('builds the product from those tilts in the worker, with the data time span and tilt counts', async () => {
    h.files.set('https://x/prev', prevBytes); h.files.set('https://x/live', liveBytes);
    configureL2({ volumes: 10 });
    const run = (args: object) => L2_HANDLERS['l2.product']({ sweep: 0, product: 19, params, url: 'https://x/live', live: true, ...args }, new JobClock()) as Promise<any>;
    const rolled = await run({ rolling: { url: 'https://x/prev' } });
    const pick = rollingTilts(live, prev), sweeps = [...pick.live.map((i) => live[i]), ...pick.prev.map((i) => prev[i])];
    const want = buildProduct(19, sweeps[0], sweeps, params)!;
    expect(Array.from(rolled.sweep.codes)).toEqual(Array.from(want.codes));
    expect(rolled.sweep.rolling).toEqual({ liveTilts: 3, prevTilts: 2, prevTimeMs: T - 300e3 });
    expect(rolled.sweep.startMs).toBe(T - 300e3 + 6 * 20000); // the previous volume's 4.0° tilt
    expect(rolled.sweep.endMs).toBe(T + 5 * 20000 + 359 * 20); // the live 2.5° tilt's last radial
    expect(rolled.sweep.upload).toBeInstanceOf(Uint8Array);
    // The previous volume's upper core reaches the rolling product and not the live-only one.
    const plain = await run({});
    const max = (c: Uint8Array) => c.reduce((a, b) => Math.max(a, b), 0);
    expect(max(rolled.sweep.codes)).toBeGreaterThan(max(plain.sweep.codes));
    expect(plain.sweep.rolling).toBeUndefined();
  });
});

describe('NEXRAD layer rolling requests', () => {
  let snapshot: ReturnType<typeof settings.exportDocument>;
  beforeEach(() => { snapshot = settings.exportDocument(); h.runs.length = 0; });
  afterEach(() => settings.importDocument(snapshot));
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  const meta = (n: number) => ({ volumeTimeMs: null, vcp: 212, avset: false, sails: 1, mrle: 0, sweeps: Array.from({ length: n }, (_, i) => ({ index: i, elevation: 0.5 + i, nominal: 0.5 + i, label: '', moments: ['REF'], radials: 360 })) });

  it('reads the previous complete volume for the live volume only, under a rolling identity', async () => {
    settings.set('settings.nexradSiteICAO', 'KTLX'); settings.set('layerState.NEXRADOn', true); settings.set('layerState.NEXRADLevel2', true);
    settings.set('layerState.NEXRADLevel2Product', 19);
    const layer = new NexradLayer({ camera: { cur: { z: 5 } } } as never, {} as never);
    const plainId = layer.l2Identity();
    settings.set('ext.settings.nexradLevel2Rolling', true);
    expect(layer.l2Identity()).toBe(`${plainId}|rolling`);
    const frame = (i: number, live = false) => ({ t: T - (2 - i) * 300e3, file: { t: T - (2 - i) * 300e3, url: `https://x/v${i}`, live, name: `v${i}` }, meta: live ? undefined : meta(8) });
    layer.l2 = [frame(0), frame(1), frame(2, true)] as never;
    layer.reloadProducts(); await flush();
    h.runs.find((r) => r.task === 'l2.meta')!.resolve(meta(5)); await flush();
    const products = h.runs.filter((r) => r.task === 'l2.product');
    expect(products.map((r) => [r.args.url, r.args.rolling?.url])).toEqual(expect.arrayContaining([['https://x/v0', undefined], ['https://x/v1', undefined], ['https://x/v2', 'https://x/v1']]));
    settings.set('layerState.NEXRADLevel2Product', 0);
    expect(layer.rolling()).toBe(false);
    expect(layer.l2Identity().endsWith('|rolling')).toBe(false);
  });
});
