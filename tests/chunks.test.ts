// Real-time Level 2 chunk feed: key parsing, chunk ordering, newest-folder search across the 999 wrap, polling.
import { describe, it, expect } from 'vitest';
import { parseChunkKey, orderChunks, newestFolder, nextFolder, ChunkFeed, type ChunkKey } from '../src/radar/chunks';

const k = (vol: number, time: string, seq: number, kind: string) => parseChunkKey(`KTLX/${vol}/${time}-${String(seq).padStart(3, '0')}-${kind}`)!;

describe('chunk keys', () => {
  it('parses folder, start time, sequence and kind', () => {
    expect(parseChunkKey('KTLX/1/20261112-104929-002-I')).toEqual({ key: 'KTLX/1/20261112-104929-002-I', vol: 1, timeMs: Date.UTC(2026, 10, 12, 10, 49, 29), seq: 2, kind: 'I' });
    expect(parseChunkKey('KTLX/1/garbage')).toBeNull();
  });
  it('orders chunks and stops at a gap; a volume must start with S', () => {
    const t = '20261115-194500';
    expect(orderChunks([k(5, t, 3, 'I'), k(5, t, 1, 'S'), k(5, t, 2, 'I')]).map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(orderChunks([k(5, t, 1, 'S'), k(5, t, 3, 'I')]).map((c) => c.seq)).toEqual([1]);
    expect(orderChunks([k(5, t, 2, 'I')])).toEqual([]);
    // Leftover chunks of an older volume in the same (reused) folder are ignored.
    const old = '20261110-132622';
    expect(orderChunks([k(5, old, 1, 'S'), k(5, old, 2, 'I'), k(5, old, 3, 'E'), k(5, t, 1, 'S'), k(5, t, 2, 'I')]).map((c) => `${c.seq}${c.kind}`)).toEqual(['1S', '2I']);
  });
  it('wraps 999 → 1', () => { expect(nextFolder(999)).toBe(1); expect(nextFolder(41)).toBe(42); });
});

describe('newest folder', () => {
  it('finds the rotation point of wrapped folder numbers with few lookups', async () => {
    // Folders 1..943; 1..500 are the newest run (rising), 501..943 older (rising).
    const nums = Array.from({ length: 943 }, (_, i) => i + 1);
    const time = (n: number) => (n <= 500 ? 2_000_000 + n : 1_000_000 + n);
    let calls = 0;
    expect(await newestFolder(nums, async (n) => { calls++; return time(n); })).toBe(500);
    expect(calls).toBeLessThan(50);
    expect(await newestFolder([1, 2, 3], async (n) => n)).toBe(3); // no wrap
  });
  it('ignores stale folders left from an earlier cycle (counter jump)', async () => {
    // Observed layout: 1..628 newest run part A, 629..670 stale (5 days old), 671..712 current, 713..999 stale.
    const nums = Array.from({ length: 999 }, (_, i) => i + 1);
    const time = (n: number) => (n <= 628 ? 5000 + n : n <= 670 ? 100 + n : n <= 712 ? 6000 + n : 200 + n);
    expect(await newestFolder(nums, async (n) => time(n))).toBe(712);
  });
});

describe('ChunkFeed polling', () => {
  it('follows the current volume and moves to the next folder after the end chunk', async () => {
    const folders: Record<string, string[]> = {
      'KTLX/7/': ['KTLX/7/20261115-194000-001-S', 'KTLX/7/20261115-194000-002-I'],
      'KTLX/8/': [], 'KTLX/6/': ['KTLX/6/20261115-193500-001-S', 'KTLX/6/20261115-193500-002-E'],
    };
    const list = async (prefix: string, o: { delimiter?: string } = {}) => (o.delimiter ? { keys: [], prefixes: ['KTLX/6/', 'KTLX/7/', 'KTLX/8/'] } : { keys: folders[prefix] ?? [], prefixes: [] });
    const feed = new ChunkFeed(list);
    folders['KTLX/8/'] = [];
    let v = await feed.poll('KTLX');
    // Folder 8 is empty (time 0): 7 is the newest folder with data.
    expect(v?.vol).toBe(7);
    expect(v?.chunks).toHaveLength(2);
    expect(v?.complete).toBe(false);
    folders['KTLX/7/'].push('KTLX/7/20261115-194000-003-E');
    folders['KTLX/8/'] = ['KTLX/8/20261115-194500-001-S'];
    v = await feed.poll('KTLX');
    expect(v?.vol).toBe(8);
    expect(v?.chunks[0]).toMatch(/KTLX\/8\/20261115-194500-001-S$/);
    void ([] as ChunkKey[]);
  });
  it('re-samples when the followed volume goes stale (counter jump)', async () => {
    const t0 = Date.UTC(2026, 10, 15, 19, 0, 0);
    let prefixes = ['KTLX/10/'];
    const folders: Record<string, string[]> = { 'KTLX/10/': ['KTLX/10/20261115-190000-001-S'], 'KTLX/11/': [], 'KTLX/50/': ['KTLX/50/20261115-193000-001-S'] };
    const list = async (prefix: string, o: { delimiter?: string } = {}) => (o.delimiter ? { keys: [], prefixes } : { keys: folders[prefix] ?? [], prefixes: [] });
    const feed = new ChunkFeed(list);
    expect((await feed.poll('KTLX', t0 + 60e3))?.vol).toBe(10);
    prefixes = ['KTLX/10/', 'KTLX/50/'];
    expect((await feed.poll('KTLX', t0 + 10 * 60e3))?.vol).toBe(10); // not stale yet
    expect((await feed.poll('KTLX', t0 + 31 * 60e3))?.vol).toBe(50);
  });
});
