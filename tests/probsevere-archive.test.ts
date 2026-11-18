import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({ fetched: [] as string[], file: null as unknown }));
vi.mock('../src/data/net', async (orig) => ({
  ...(await orig<object>()),
  listS3: vi.fn((_bucket: string, prefix: string) => {
    const day = prefix.slice(-9, -1), objects = [];
    for (let m = 0; m < 24 * 60; m += 2) objects.push({ key: `${prefix}MRMS_PROBSEVERE_${day}_${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}38.json` });
    return Promise.resolve({ objects, prefixes: [] });
  }),
  fetchJson: vi.fn((url: string) => { h.fetched.push(url); return Promise.resolve(h.file); }),
}));
vi.mock('../src/render/prims', async (orig) => ({ ...(await orig<object>()), LineSet: class { setStyles() {} setLines() {} draw() {} }, TextSet: class { setLabels() {} draw() {} } }));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));

import { ProbSevereLayer } from '../src/sections/probsevere';
import { timeline } from '../src/app/timeline';
import { settings } from '../src/settings/store';

// A real v3 file relabelled as the earlier version that archived files before ProbSevere v3 carry.
const OLD = { ...JSON.parse(readFileSync('tests/fixtures/probsevere/MRMS_PROBSEVERE_20261118_004438.json', 'utf8')), product: 'ProbSevere 2.0' };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

afterEach(() => { timeline.setArchive(null); settings.set('ext.layerState.ProbSevereOn', false); h.fetched.length = 0; });

describe('ProbSevere in archive mode', () => {
  it('stops downloading an archive time whose files are an earlier ProbSevere version and says so', async () => {
    h.file = OLD;
    settings.set('ext.layerState.ProbSevereOn', true);
    timeline.setArchive(Date.UTC(2024, 4, 6, 22, 30));
    const layer = new ProbSevereLayer({} as never, {} as never);
    await layer.refresh();
    await flush();
    const first = h.fetched.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(4); // the files already in flight, not the whole loop (dozens listed)
    expect(layer.statusText()).toMatch(/earlier version/);
    await layer.refresh();
    await flush();
    expect(h.fetched.length).toBe(first);
  });
});
