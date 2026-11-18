// Level 2 loop fill and FIFO (memory volumes) and parallel downloads per source (Settings → Data/Downloading).
import { describe, expect, it } from 'vitest';
import { l2Parallel, l2Retention, PROXIED_L2_PARALLEL, type L2File } from '../src/radar/sources';

const vol = (i: number, live = false): L2File => ({ t: 1_000_000 + i * 240e3, url: `v${i}`, live, name: `v${i}` });
const names = (l: L2File[]) => l.map((f) => f.url);
const index = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => vol(from + k));

describe('Level 2 retention', () => {
  it('fills the loop with the newest volumes up to the memory count at once', () => {
    expect(names(l2Retention(index(0, 29), 26))).toEqual(names(index(4, 29)));
  });

  it('keeps every listed volume when fewer than the memory count exist', () => {
    expect(names(l2Retention(index(0, 6), 26))).toEqual(names(index(0, 6)));
  });

  it('drops the oldest volume as each new scan arrives (FIFO at the memory count)', () => {
    for (let newest = 5; newest <= 9; newest++) expect(names(l2Retention(index(0, newest), 5))).toEqual(names(index(newest - 4, newest)));
  });

  it('drops volumes no longer listed (outside the loop window)', () => {
    expect(names(l2Retention(index(3, 7), 26))).toEqual(names(index(3, 7)));
  });

  it('counts the live partial volume as the newest and towards the memory count', () => {
    const live = vol(8, true);
    expect(names(l2Retention([...index(0, 7), live], 5, live))).toEqual(['v4', 'v5', 'v6', 'v7', 'v8']);
  });

  it('keeps at least one volume', () => {
    expect(names(l2Retention(index(0, 3), 0))).toEqual(['v3']);
  });
});

describe('Level 2 parallel downloads', () => {
  it('uses the download setting as-is for AWS (fetched directly by the browser)', () => {
    expect(l2Parallel(3, 12)).toBe(12);
    expect(l2Parallel(3, 2)).toBe(2);
  });

  it('caps TGFTP and custom servers, which go through the hosted proxy', () => {
    expect(PROXIED_L2_PARALLEL).toBe(4);
    expect(l2Parallel(2, 12)).toBe(4);
    expect(l2Parallel(4, 12)).toBe(4);
    expect(l2Parallel(2, 3)).toBe(3);
  });

  it('downloads at least one at a time', () => {
    expect(l2Parallel(3, 0)).toBe(1);
    expect(l2Parallel(2, 0)).toBe(1);
  });
});
