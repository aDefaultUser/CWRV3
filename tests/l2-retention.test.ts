// Level 2 download budget and memory count (Settings → Data/Downloading).
import { describe, expect, it } from 'vitest';
import { l2Retention, type L2File } from '../src/radar/sources';

const vol = (i: number, live = false): L2File => ({ t: 1_000_000 + i * 240e3, url: `v${i}`, live, name: `v${i}` });
const names = (l: L2File[]) => l.map((f) => f.url);
const index = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => vol(from + k));

describe('Level 2 retention', () => {
  it('downloads the newest volumes up to the download count', () => {
    expect(names(l2Retention(index(0, 7), new Set(), 4, 26))).toEqual(['v4', 'v5', 'v6', 'v7']);
    expect(names(l2Retention(index(0, 7), new Set(['v4', 'v5', 'v6', 'v7']), 8, 26))).toEqual(names(index(0, 7)));
  });

  it('keeps held volumes as new scans arrive, up to the memory count', () => {
    let held = l2Retention(index(0, 3), new Set(), 4, 6);
    for (let newest = 4; newest <= 9; newest++) held = l2Retention(index(0, newest), new Set(names(held)), 4, 6);
    expect(names(held)).toEqual(['v4', 'v5', 'v6', 'v7', 'v8', 'v9']); // 6 kept although only 4 are downloaded at once
  });

  it('shrinks to a lower memory count at once; a lower download count keeps what is held', () => {
    const held = new Set(names(index(0, 7)));
    expect(names(l2Retention(index(0, 7), held, 8, 3))).toEqual(['v5', 'v6', 'v7']);
    expect(names(l2Retention(index(0, 7), held, 2, 26))).toEqual(names(index(0, 7)));
  });

  it('drops held volumes no longer listed (outside the loop window)', () => {
    expect(names(l2Retention(index(3, 7), new Set(['v0', 'v1', 'v6', 'v7']), 2, 26))).toEqual(['v6', 'v7']);
  });

  it('counts the live partial volume as the newest download and as held memory', () => {
    const live = vol(8, true);
    expect(names(l2Retention([...index(0, 7), live], new Set(), 4, 26, live))).toEqual(['v5', 'v6', 'v7', 'v8']);
    expect(names(l2Retention([...index(0, 7), live], new Set(names(index(0, 7))), 4, 5, live))).toEqual(['v4', 'v5', 'v6', 'v7', 'v8']);
  });
});
