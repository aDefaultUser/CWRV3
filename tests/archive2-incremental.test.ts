// Incremental live decode: a volume fed chunk by chunk is identical to a full decode at every step, and the sweeps,
// recoded sweeps, derived arrays and single-sweep products of unchanged elevations are kept, end to end through the
// worker's volume cache (synthetic Archive II volume with a split cut and a SAILS rescan).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeArchive2, splitSailsVolume, concat } from './helpers/archive2-writer';

const files = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchBytes: vi.fn(async (url: string) => { const b = files.get(url); if (!b) throw new Error(`404 ${url}`); return b.slice(); }) }));

import { Archive2Decoder, decodeArchive2, type L2Volume } from '../src/decode/archive2';
import { recodeVolume, SweepCache, dealias, tiltRows } from '../src/radar/l2products';
import { L2_HANDLERS, configureL2 } from '../src/workers/l2-volumes';
import { JobClock } from '../src/workers/job-clock';

const chunks = writeArchive2(splitSailsVolume());

describe('synthetic Archive II volume', () => {
  it('decodes to the cuts it was written from', () => {
    const v = decodeArchive2(concat(chunks));
    expect(v.site).toBe('KTST');
    expect(v.volumeTimeMs).toBe(Date.UTC(2026, 4, 6, 22, 3, 20));
    expect(v.vcpNumber).toBe(212);
    expect(v.vcp?.sails).toBe(true);
    expect(v.sweeps.map((s) => [s.radialCount, s.azimuthSpacing, s.cut?.waveform, s.cut?.sailsSeq, s.complete])).toEqual([
      [720, 0.5, 1, 0, true], [720, 0.5, 2, 0, true], [360, 1, 4, 0, true], [720, 0.5, 1, 1, true], [720, 0.5, 2, 1, true], [360, 1, 4, 0, true], [360, 1, 4, 0, true], [360, 1, 4, 0, true],
    ]);
    expect(v.sweeps[0].elevation).toBeCloseTo(0.53, 5);
    expect(v.sweeps[0].nominalElevation).toBeCloseTo(0.48, 1);
    expect(Object.keys(v.sweeps[0].moments)).toEqual(['REF', 'ZDR', 'PHI', 'RHO']);
    expect(Object.keys(v.sweeps[1].moments)).toEqual(['REF', 'VEL', 'SW']);
    const ref = v.sweeps[2].moments.REF!;
    expect([ref.gates, ref.firstGateM, ref.gateSpacingM, ref.scale, ref.offset, ref.wordSize]).toEqual([48, 2125, 250, 2, 66, 8]);
    expect(v.sweeps[2].azimuths[5]).toBeCloseTo(5.6, 5);
    expect(v.sweeps[0].moments.PHI!.raw).toBeInstanceOf(Uint16Array);
    expect(v.sweeps[0].moments.PHI!.raw[3 * 40 + 2]).toBe(2 + ((3 * 3 + 2 * 40 + 1) % 1000));
  });
});

describe('incremental decode', () => {
  it('equals a full decode after every chunk and keeps the sweep objects of unchanged elevations', () => {
    const d = new Archive2Decoder();
    let prev: L2Volume | null = null, kept = 0;
    chunks.forEach((c, i) => {
      d.feed(c);
      const v = d.volume();
      expect(v).toEqual(decodeArchive2(concat(chunks.slice(0, i + 1))));
      // Each chunk after the first holds radials of one cut: every other sweep is the same object as before.
      if (prev && i > 1) {
        const changed = v.sweeps.filter((s, k) => s !== prev!.sweeps[k]);
        expect(changed).toHaveLength(1);
        kept += v.sweeps.length - 1;
      }
      expect(d.volume().sweeps.every((s, k) => s === v.sweeps[k])).toBe(true); // nothing fed: nothing rebuilt
      prev = v;
    });
    expect(kept).toBeGreaterThan(40);
  });

  it('recodes only the sweeps that changed and frees the derived arrays of replaced sweeps', () => {
    const d = new Archive2Decoder();
    for (const c of chunks.slice(0, 6)) d.feed(c); // cuts 1, 2 complete and half of cut 3
    const v1 = d.volume(), r1 = recodeVolume(v1), cache = new SweepCache();
    for (const s of r1) { dealias(s, false, cache); tiltRows(s, 'REF', false, cache); }
    const before = cache.bytes;
    expect(before).toBe(r1[1].vel!.codes.length + r1[2].vel!.codes.length + r1.reduce((n, s) => n + 720 * s.ref!.gates, 0));
    d.feed(chunks[6]);
    const v2 = d.volume(), r2 = recodeVolume(v2, { volume: v1, sweeps: r1 });
    expect(r2[0]).toBe(r1[0]); expect(r2[1]).toBe(r1[1]);
    expect(r2[2]).not.toBe(r1[2]);
    expect(r2).toEqual(recodeVolume(v2));
    cache.retain(r2);
    expect(cache.bytes).toBe(before - r1[2].vel!.codes.length - 720 * r1[2].ref!.gates);
    const rows = tiltRows(r2[0], 'REF', false, cache)!;
    expect(tiltRows(r2[0], 'REF', false, cache)!.codes).toBe(rows.codes); // cached per sweep object
  });
});

describe('worker volume cache', () => {
  const params = { qualityDealiasing: true, stormMotion: { speedKt: 30, fromDeg: 240 }, hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 300, hm20Custom: 900, envIsotherms: null, etThreshold: 18.5, gust1991: true };
  const run = (task: string, args: object) => L2_HANDLERS[task](args, new JobClock()) as Promise<any>;
  const urls = chunks.map((_, i) => `https://chunks.example/KTST/1/${i}`);
  beforeEach(() => { files.clear(); chunks.forEach((c, i) => files.set(urls[i], c)); configureL2({ volumes: 50 }); });

  it('gives the same products, composite and packs for a growing chunk volume as a full decode of the same bytes', async () => {
    const live = 'chunks:KTST/1';
    for (let n = 2; n <= chunks.length; n += 3) {
      const full = `https://full.example/KTST_${n}`;
      files.set(full, concat(chunks.slice(0, n)));
      const meta = await run('l2.meta', { url: live, live: true, chunks: urls.slice(0, n) });
      expect(meta).toEqual(await run('l2.meta', { url: full, live: false }));
      const jobs: [string, object][] = [];
      for (const product of [0, 3, 6, 7, 9, 10]) for (let sweep = 0; sweep < meta.sweeps.length; sweep++) jobs.push(['l2.product', { sweep, product, params }]);
      for (const product of [11, 13, 15, 17, 18, 19]) jobs.push(['l2.product', { sweep: 0, product, params }]);
      jobs.push(['l2.composite', { base: 500, top: 3000, selectiveMax: true }]);
      for (const moment of ['REF', 'VEL', 'ZDR', 'CC', 'KDP']) for (const latest of [false, true]) jobs.push(['l2.volume', { moment, latest, qualityDealiasing: true }]);
      for (const [task, args] of jobs) {
        const a = await run(task, { ...args, url: live, live: true, chunks: urls.slice(0, n) });
        const b = await run(task, { ...args, url: full, live: false });
        expect(a, `${task} ${JSON.stringify(args)} after ${n} chunks`).toEqual(b);
      }
    }
  });

  it('counts derived arrays in the cached bytes and keeps what unchanged sweeps derived across a chunk update', async () => {
    const live = 'chunks:KTST/2', upTo = (n: number, url = live) => ({ url, live: true, chunks: urls.slice(0, n) });
    const others = configureL2({}).bytes, mine = () => configureL2({}).bytes - others;
    await run('l2.meta', upTo(6)); // cuts 1 and 2 complete, half of cut 3
    const base = mine();
    const first = await run('l2.product', { ...upTo(6), sweep: 1, product: 6, params });
    const dealiased = 720 * 40, product = dealiased + 720 * 4; // the product holds the same codes plus its azimuths
    expect(mine() - base).toBe(dealiased + product);
    await run('l2.volume', { ...upTo(6), moment: 'REF', latest: false, qualityDealiasing: true });
    expect(mine() - base).toBe(dealiased + product + 2 * 720 * 48); // rows of the two reflectivity tilts so far
    // More radials of cut 3 arrive: cut 2 keeps its dealiased codes and product, cut 1 its rows; cut 3's rows go.
    await run('l2.meta', upTo(7));
    const grown = mine();
    await run('l2.meta', upTo(7, 'chunks:KTST/3')); // the same bytes with nothing derived
    expect(grown).toBe(mine() - grown + dealiased + product + 720 * 48);
    const again = await run('l2.product', { ...upTo(7), sweep: 1, product: 6, params });
    expect(again.sweep.codes).toEqual(first.sweep.codes);
    expect(mine()).toBe(2 * grown - (dealiased + product + 720 * 48)); // served from the kept product: nothing added
  });
});
