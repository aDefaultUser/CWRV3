import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

interface Run { task: string; args: { url: string; t: number; site?: string }; resolve: (v: unknown) => void; reject: (e: unknown) => void }
const h = vi.hoisted(() => ({ runs: [] as Run[], listed: [] as string[] }));
vi.mock('../src/workers/pool', () => {
  const run = vi.fn((task: string, args: Run['args']) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject })));
  return { pool: { run, for: () => ({ run }) } };
});
vi.mock('../src/data/net', async (orig) => ({
  ...(await orig<object>()),
  listS3: vi.fn((_bucket: string, prefix: string) => {
    h.listed.push(prefix);
    const day = prefix.match(/(\d{8})\/$/)?.[1] ?? '', objects = [];
    for (let m = 0; m < 24 * 60; m += 2) objects.push({ key: `${prefix}${prefix.startsWith('ProbSevere') ? `MRMS_PROBSEVERE_${day}_` : `MRMS_X_${day}-`}${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}38${prefix.startsWith('ProbSevere') ? '.json' : '.grib2.gz'}`, size: 1, lastModified: '' });
    return Promise.resolve({ objects, prefixes: [] });
  }),
}));
vi.mock('../src/render/prims', async (orig) => ({ ...(await orig<object>()), LineSet: class { setStyles() {} setLines() {} draw() {} }, TextSet: class { setLabels() {} draw() {} } }));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));
vi.mock('../src/render/raster', async (orig) => ({ ...(await orig<object>()), RasterDraw: class { draw() {} }, Lut: class { destroy() {} } }));

import { ProbSevereLayer } from '../src/sections/probsevere';
import { probSevereResult } from '../src/sections/probsevere-data';
import { MrmsLayer } from '../src/sections/mrms';
import { timeline } from '../src/app/timeline';
import { settings } from '../src/settings/store';

const V3 = JSON.parse(readFileSync('tests/fixtures/probsevere/MRMS_PROBSEVERE_20261118_004438.json', 'utf8'));
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
/** A real v3 file valid at t, or the same file labelled as the earlier version archived files before v3 carry. */
const v3 = (t: number) => ({ ...V3, validTime: stamp(t) });
const v2 = (t: number) => ({ ...v3(t), product: 'ProbSevere 2.0' });
/** Answers a worker run the way the decode worker does for that downloaded file. */
const answer = (r: Run, json: unknown) => r.resolve(probSevereResult(json, r.args.t, r.args.url));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const pending = () => h.runs.filter((r) => !(r as { done?: boolean }).done);
const take = (r: Run) => { (r as { done?: boolean }).done = true; return r; };

afterEach(() => {
  timeline.setArchive(null);
  settings.set('ext.layerState.ProbSevereOn', false); settings.set('layerState.MRMSOn', false); settings.set('ext.layerState.LoopLength', 1);
  h.runs.length = 0; h.listed.length = 0;
});

describe('ProbSevere in archive mode', () => {
  it('stops downloading an archive time whose files are an earlier ProbSevere version and says so', async () => {
    settings.set('ext.layerState.ProbSevereOn', true);
    timeline.setArchive(Date.UTC(2024, 4, 6, 22, 30));
    const layer = new ProbSevereLayer({} as never, {} as never);
    await layer.refresh();
    for (let i = 0; i < 4 && pending().length; i++) { pending().forEach((r) => answer(take(r), v2(r.args.t))); await flush(); }
    expect(h.runs.length).toBeLessThanOrEqual(8); // the files in flight, not the whole loop (dozens listed)
    expect(layer.statusText()).toMatch(/earlier version/);
    const runs = h.runs.length;
    await layer.refresh(); await flush();
    expect(h.runs.length).toBe(runs);
  });

  it('does not mark a newer archive time by a late failure of the previous one', async () => {
    settings.set('ext.layerState.ProbSevereOn', true);
    timeline.setArchive(Date.UTC(2024, 4, 6, 22, 30));
    const layer = new ProbSevereLayer({} as never, {} as never);
    await layer.refresh();
    const old = pending().map(take);
    expect(old.length).toBeGreaterThan(0);
    timeline.setArchive(Date.UTC(2026, 4, 18, 2, 45));
    await layer.refresh();
    old.forEach((r) => answer(r, v2(r.args.t))); // the 2024 downloads fail only now
    await flush();
    expect(layer.statusText()).not.toMatch(/earlier version/);
    const next = pending();
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((r) => r.args.url.includes('/20260518/'))).toBe(true);
  });

  it('keeps the newer files of a loop that spans the change to v3', async () => {
    settings.set('ext.layerState.ProbSevereOn', true);
    timeline.setArchive(Date.UTC(2025, 7, 1, 18, 0));
    const layer = new ProbSevereLayer({} as never, {} as never);
    await layer.refresh();
    // Files load newest first: the oldest of the first downloads is of the earlier version, the newer ones are v3.
    const first = pending().map(take), oldest = Math.min(...first.map((r) => r.args.t));
    first.forEach((r) => (r.args.t === oldest ? answer(r, v2(r.args.t)) : answer(r, v3(r.args.t))));
    await flush();
    expect(h.runs.slice(first.length).filter((r) => r.args.t <= oldest)).toEqual([]); // older files are not fetched
    expect(layer.statusText()).toMatch(new RegExp(`ProbSevere v3: ${first.length - 1}/${first.length - 1} files`)); // the v3 files stay
  });
});

describe('MRMS index in archive mode', () => {
  it('lists the previous day when a longer loop starts before midnight', async () => {
    settings.set('layerState.MRMSOn', true); settings.set('ext.layerState.LoopLength', 0.5);
    timeline.setArchive(Date.UTC(2025, 9, 2, 0, 40));
    const layer = new MrmsLayer({} as never);
    await layer.refresh();
    expect(h.listed.some((p) => p.endsWith('/20251002/'))).toBe(true);
    expect(h.listed.some((p) => p.endsWith('/20251001/'))).toBe(false);
    settings.set('ext.layerState.LoopLength', 2);
    await layer.refresh();
    expect(h.listed.some((p) => p.endsWith('/20251001/'))).toBe(true);
    const listings = h.listed.length, now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 3600e3); // past any product's live refresh interval
    try {
      await layer.refresh(); // archive listings do not change: no re-list for the same days
      expect(h.listed.length).toBe(listings);
    } finally { vi.restoreAllMocks(); }
  });
});
