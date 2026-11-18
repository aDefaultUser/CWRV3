// Message 1 (legacy) Archive II volumes: synthetic volumes from the writer decoded end to end (gate geometry, scaling,
// sweep boundaries and the cuts of volumes without a VCP record) through the worker's product tasks, and a trimmed
// real volume (KTLX 1999-05-03 23:31:34Z, elevations 1–2 at azimuths 240–258°, the Bridge Creek tornado couplet).
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLegacyArchive2, type SynthLegacyVolume } from './helpers/archive2-writer';

const files = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchBytes: vi.fn(async (url: string) => { const b = files.get(url); if (!b) throw new Error(`404 ${url}`); return b.slice(); }) }));

import { decodeArchive2, momentValue } from '../src/decode/archive2';
import { recodeSweep } from '../src/radar/l2products';
import { L2_HANDLERS, configureL2 } from '../src/workers/l2-volumes';
import { JobClock } from '../src/workers/job-clock';
import { RADAR_SITES } from '../src/generated/radar-sites';

const code = (m: number, r: number, g: number) => ((r * 7 + g * 11 + m * 5) % 19 === 0 ? (r + g) % 2 : 2 + ((r * 3 + g * 5 + m * 31) % 240));
const vcp21 = (): SynthLegacyVolume => ({
  header: 'ARCHIVE2.', site: '', timeMs: Date.UTC(1999, 4, 3, 23, 31, 34), vcp: 21,
  cuts: [
    { elevation: 0.48, radials: 367, az0: 213, ref: { gates: 30 }, code },
    { elevation: 0.44, radials: 366, az0: 220.7, doppler: { gates: 40, nyquist: 26.1 }, code },
    { elevation: 1.45, radials: 365, ref: { gates: 24 }, code },
    { elevation: 1.45, radials: 365, doppler: { gates: 40, nyquist: 26.1 }, code },
    { elevation: 2.42, radials: 362, step: 1, ref: { gates: 20 }, doppler: { gates: 36, nyquist: 30.41, res: 4 }, code },
  ],
});

describe('message 1 volumes', () => {
  it('decodes split and batch cuts with their own gate geometry and scaling', () => {
    const v = decodeArchive2(writeLegacyArchive2(vcp21()), 'KTLX');
    const ktlx = RADAR_SITES.find((s) => s.id === 'KTLX')!;
    expect([v.site, v.volumeTimeMs, v.lat, v.lon, v.heightM, v.vcpNumber, v.vcp]).toEqual(['KTLX', Date.UTC(1999, 4, 3, 23, 31, 34), ktlx.lat, ktlx.lon, 390, 21, null]);
    // Overrun radials (past one turn) are dropped; the end-of-elevation status still completes the sweep.
    expect(v.sweeps.map((s) => [s.elevationNumber, s.radialCount, s.complete, s.cut?.waveform, Object.keys(s.moments).join()])).toEqual([
      [1, 365, true, 1, 'REF'], [2, 365, true, 2, 'VEL,SW'], [3, 365, true, 1, 'REF'], [4, 365, true, 2, 'VEL,SW'], [5, 360, true, 4, 'REF,VEL,SW'],
    ]);
    // Nominal angles from VCP 21's cuts (the split halves share theirs); the measured mean stays the elevation.
    expect(v.sweeps.map((s) => s.nominalElevation)).toEqual([0.4834, 0.4834, 1.4502, 1.4502, 2.417]);
    expect(v.sweeps[1].elevation).toBeCloseTo(0.44, 1);
    const [cs, cd, , , batch] = v.sweeps;
    expect(cs.azimuths[0]).toBeCloseTo(213, 1);
    expect(cs.azimuths[364] - cs.azimuths[0] + 360).toBeCloseTo(364 * 0.985, 1);
    expect([cs.nyquist, cs.unambiguousRangeKm, cd.nyquist, cd.unambiguousRangeKm, batch.nyquist]).toEqual([null, 466, 26.1, 148, 30.41]);

    const ref = cs.moments.REF!, vel = cd.moments.VEL!, sw = cd.moments.SW!;
    expect([ref.gates, ref.firstGateM, ref.gateSpacingM, ref.scale, ref.offset, ref.wordSize]).toEqual([30, 0, 1000, 2, 66, 8]);
    // Doppler gates centred behind the antenna (-375 and -125 m) are skipped.
    expect([vel.gates, vel.firstGateM, vel.gateSpacingM, vel.scale, vel.offset]).toEqual([38, 125, 250, 2, 129]);
    expect([sw.gates, sw.firstGateM, sw.scale]).toEqual([38, 125, 2]);
    expect(batch.moments.VEL!.scale).toBe(1);
    expect(ref.raw[7 * 30 + 4]).toBe(code(0, 7, 4));
    expect(vel.raw[7 * 38 + 4]).toBe(code(1, 7, 6));
    expect(sw.raw[7 * 38 + 4]).toBe(code(2, 7, 6));
    expect(momentValue(ref, 106)).toBe(20);
    expect(momentValue(vel, 109)).toBe(-10);
    expect(momentValue(batch.moments.VEL!, 109)).toBe(-20);
  });

  it('recodes 1 m/s velocity to the builder steps of 0.5 m/s', () => {
    const { sweeps } = decodeArchive2(writeLegacyArchive2(vcp21()));
    const raw = sweeps[4].moments.VEL!.raw, codes = recodeSweep(sweeps[4]).vel!.codes;
    for (let i = 0; i < raw.length; i++) expect(codes[i]).toBe(raw[i] <= 1 ? raw[i] : Math.min(255, Math.max(2, 129 + 2 * (raw[i] - 129))));
    expect(recodeSweep(sweeps[1]).vel!.codes).toBe(sweeps[1].moments.VEL!.raw); // 0.5 m/s codes are used as they are
  });

  it('infers the cuts of a VCP without a definition from the moments', () => {
    const v: SynthLegacyVolume = { header: 'AR2V0001.', site: 'KICT', timeMs: Date.UTC(2004, 0, 5, 12), vcp: 31, cuts: [
      { elevation: 0.48, radials: 366, ref: { gates: 20 }, code },
      { elevation: 0.53, radials: 366, doppler: { gates: 20, nyquist: 11.6 }, code },
      { elevation: 2.5, radials: 366, ref: { gates: 20 }, doppler: { gates: 20, nyquist: 11.6 }, code },
    ] };
    const d = decodeArchive2(writeLegacyArchive2(v), 'KTLX');
    expect(d.site).toBe('KICT'); // the header's site wins over the requested one
    expect(d.lat).toBe(RADAR_SITES.find((s) => s.id === 'KICT')!.lat);
    expect(d.sweeps.map((s) => [s.cut?.waveform, s.nominalElevation])).toEqual([[1, 0.48], [2, 0.48], [4, 2.5]]);
  });

  describe('worker tasks', () => {
    const url = 'https://unidata-nexrad-level2.s3.amazonaws.com/1999/05/03/KTLX/KTLX19990503_233134.gz';
    const params = { qualityDealiasing: true, stormMotion: { speedKt: 30, fromDeg: 240 }, hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 3000, hm20Custom: 6000, envIsotherms: null, etThreshold: 18.5, gust1991: true };
    const run = (task: string, args: object) => L2_HANDLERS[task]({ url, live: false, ...args }, new JobClock()) as Promise<any>;
    beforeEach(() => { files.clear(); files.set(url, gzipSync(writeLegacyArchive2(vcp21()))); configureL2({ volumes: 5 }); });

    it('label the volume with the requested site and build the single-moment and reflectivity products', async () => {
      const meta = await run('l2.meta', {});
      expect([meta.site, meta.vcp, meta.lat]).toEqual(['KTLX', 21, RADAR_SITES.find((s) => s.id === 'KTLX')!.lat]);
      expect(meta.sweeps.map((s: { label: string; split: string | null; moments: string[] }) => [s.label, s.split, s.moments.join()])).toEqual([
        ['0.5°', 'CS', 'REF'], ['0.5°', 'CD', 'VEL,SW'], ['1.5°', 'CS', 'REF'], ['1.5°', 'CD', 'VEL,SW'], ['2.4°', null, 'REF,VEL,SW'],
      ]);
      const ref = (await run('l2.product', { sweep: 0, product: 0, params })).sweep;
      expect([ref.radials, ref.gates, ref.firstKm, ref.gateKm, ref.half]).toEqual([365, 30, 0, 1, false]);
      const vel = (await run('l2.product', { sweep: 1, product: 6, params })).sweep;
      expect([vel.gates, vel.firstKm, vel.gateKm]).toEqual([38, 0.125, 0.25]);
      for (const product of [13, 15, 19]) expect((await run('l2.product', { sweep: 0, product, params })).sweep, `product ${product}`).not.toBeNull();
    });

    it('have no dual-pol products, columns or packs', async () => {
      for (const product of [3, 4, 5, 10]) expect((await run('l2.product', { sweep: 0, product, params })).sweep, `product ${product}`).toBeNull();
      for (const product of [17, 18]) expect((await run('l2.product', { sweep: 0, product, params })).sweep, `product ${product}`).toBeNull();
      for (const moment of ['ZDR', 'CC', 'KDP']) expect((await run('l2.volume', { moment, latest: false, qualityDealiasing: true })).pack, moment).toBeNull();
      expect((await run('l2.volume', { moment: 'REF', latest: false, qualityDealiasing: true })).pack).not.toBeNull();
    });
  });
});

describe('real message 1 volume (trimmed)', () => {
  const v = decodeArchive2(new Uint8Array(gunzipSync(readFileSync(new URL('./fixtures/radar/KTLX19990503_233134-trim.gz', import.meta.url)))), 'KTLX');

  it('reads the header, radials and gate geometry', () => {
    expect([v.site, v.volumeTimeMs, v.vcpNumber]).toEqual(['KTLX', Date.UTC(1999, 4, 3, 23, 31, 34), 11]);
    expect(v.sweeps.map((s) => [s.elevationNumber, s.radialCount, s.cut?.waveform, s.nominalElevation, Object.keys(s.moments).join()])).toEqual([
      [1, 18, 1, 0.4834, 'REF'], [2, 18, 2, 0.4834, 'VEL,SW'],
    ]);
    expect(v.sweeps[0].azimuths[0]).toBeCloseTo(240.732, 3);
    expect(v.sweeps[1].nyquist).toBe(26.1);
    const ref = v.sweeps[0].moments.REF!, vel = v.sweeps[1].moments.VEL!;
    expect([ref.gates, ref.firstGateM, ref.gateSpacingM, vel.gates, vel.firstGateM, vel.gateSpacingM]).toEqual([460, 0, 1000, 918, 125, 250]);
    expect(momentValue(ref, ref.raw[17 * 460 + 55])).toBe(62); // 62 dBZ at 257.4°, 55 km
  });

  it('holds the tornado couplet at 248.6°, 53.6 km', () => {
    const s = v.sweeps[1], vel = s.moments.VEL!, r = s.azimuths.findIndex((a) => Math.abs(a - 248.64) < 0.01), g = (53625 - vel.firstGateM) / vel.gateSpacingM;
    expect([momentValue(vel, vel.raw[(r - 1) * vel.gates + g]), momentValue(vel, vel.raw[r * vel.gates + g])]).toEqual([-21, 21.5]);
  });
});
