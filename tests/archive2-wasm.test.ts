// The Rust/WebAssembly Archive II decoder (rust/archive2, the artifact tools/wasm.mjs builds) against the TypeScript
// reference: bit-identical volumes for the synthetic, bzip2-record, legacy and real fixtures, whole and fed chunk by
// chunk with the same sweep objects kept; the worker tasks on it; refused input that fails predictably without
// poisoning a live stream; decoder handles freed on every path. Real recent volumes are read from
// CWRV3_ARCHIVE2_SAMPLES (a directory of Archive II files kept outside the repository) when it is set.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { concat, splitSailsVolume, writeArchive2, writeLegacyArchive2, type SynthLegacyVolume } from './helpers/archive2-writer';

const files = vi.hoisted(() => new Map<string, Uint8Array | Promise<Uint8Array>>());
vi.mock('../src/data/net', async (orig) => ({ ...(await orig<object>()), fetchBytes: vi.fn(async (url: string) => { const b = await files.get(url); if (!b) throw new Error(`404 ${url}`); return b.slice(); }) }));

import { fetchBytes } from '../src/data/net';
import { Archive2Decoder, type L2Volume } from '../src/decode/archive2';
import { archive2Backend, createArchive2Decoder, loadArchive2Wasm, preferTypeScriptArchive2, type L2Decoder } from '../src/decode/archive2-wasm';
import { L2_HANDLERS, configureL2 } from '../src/workers/l2-volumes';
import { JobClock } from '../src/workers/job-clock';

const WASM = new URL('../rust/archive2/target/wasm32-unknown-unknown/release/cwrv3_archive2.wasm', import.meta.url);
const SAMPLES = process.env.CWRV3_ARCHIVE2_SAMPLES;
const samples = SAMPLES && existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => /^[A-Z]{4}\d{8}_\d{6}(_V0\d)?$/.test(f)).sort() : [];
const hasBzip2 = spawnSync('bzip2', ['--help']).status === 0;

/** Bit-exact structural equality: typed arrays by type and bytes, numbers by Object.is, keys in order. */
function expectSame(a: unknown, b: unknown, path = 'volume'): void {
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    expect(a?.constructor, path).toBe(b?.constructor);
    const x = a as Uint8Array, y = b as Uint8Array;
    expect(Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.byteLength), Buffer.from(y.buffer, y.byteOffset, y.byteLength)), path).toBe(0);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a), path).toEqual(Object.keys(b));
    for (const k of Object.keys(a)) expectSame((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
  } else {
    expect(Object.is(a, b), `${path}: ${String(a)} vs ${String(b)}`).toBe(true);
  }
}

const reference = (buf: Uint8Array, site = '') => { const d = new Archive2Decoder(site); d.feed(buf); return d.volume(); };
const rust = (site = '') => { preferTypeScriptArchive2(false); return createArchive2Decoder(site); };
const decodeWith = (d: L2Decoder, buf: Uint8Array) => { try { d.feed(buf); return d.volume(); } finally { d.dispose(); } };

/**
 * Feeds both decoders chunk by chunk: equal volumes after every chunk, the same sweeps rebuilt (new objects) and
 * the rest kept. Sweeps kept by both were compared when they were built.
 */
function expectIncrementalParity(chunks: Uint8Array[], site = '') {
  const ts = new Archive2Decoder(site), rs = rust(site);
  let prevTs: L2Volume | null = null, prevRs: L2Volume | null = null, kept = 0;
  try {
    for (const [i, c] of chunks.entries()) {
      ts.feed(c); rs.feed(c);
      const a = rs.volume(), b = ts.volume();
      const changedTs = b.sweeps.map((s, k) => s !== prevTs?.sweeps[k]), changedRs = a.sweeps.map((s, k) => s !== prevRs?.sweeps[k]);
      expect(changedRs, `sweeps rebuilt after chunk ${i}`).toEqual(changedTs);
      kept += changedRs.filter((c) => !c).length;
      expectSame({ ...a, sweeps: a.sweeps.filter((_, k) => changedRs[k]) }, { ...b, sweeps: b.sweeps.filter((_, k) => changedTs[k]) }, `after chunk ${i}`);
      prevTs = b; prevRs = a;
    }
  } finally { rs.dispose(); }
  return kept;
}

/** The records of an Archive II file as real-time chunks: the volume header with the first record, then one each. */
function recordChunks(file: Uint8Array): Uint8Array[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength), chunks: Uint8Array[] = [];
  let p = 24, start = 0;
  while (p + 4 <= file.length) {
    const end = p + 4 + Math.abs(dv.getInt32(p));
    if (end > file.length || end === p + 4) break;
    chunks.push(file.subarray(start, end));
    start = p = end;
  }
  return chunks;
}

/** The same volume with every record bzip2-compressed (as real files are), by the bzip2 tool. */
function bzipRecords(chunks: Uint8Array[]): Uint8Array[] {
  return chunks.map((c, i) => {
    const head = i === 0 ? c.subarray(0, 24) : new Uint8Array(0), body = c.subarray(head.length + 4);
    const z = new Uint8Array(spawnSync('bzip2', ['-c', '-9'], { input: body, maxBuffer: 1 << 28 }).stdout);
    const rec = new Uint8Array(4 + z.length);
    new DataView(rec.buffer).setInt32(0, z.length); rec.set(z, 4);
    return concat([head, rec]);
  });
}

/**
 * Whether an uncompressed volume has a moment block the decoders read differently by design: a word size other than
 * 8 or 16 bits, or other than the first block of that moment in the sweep (the reference reads such a block as 8-bit
 * codes; the Rust decoder skips it).
 */
function oddWordSizes(buf: Uint8Array): boolean {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), first = new Map<string, number>();
  for (let p = 24; p + 4 <= buf.length;) {
    const end = p + 4 + Math.abs(dv.getInt32(p));
    if (end === p + 4 || end > buf.length) break;
    for (let q = p + 4; q + 28 <= end;) {
      const hw = dv.getUint16(q + 12);
      if (buf[q + 15] !== 31 || hw <= 8) { q += 2432; continue; }
      const m = q + 28, len = hw * 2 - 16;
      if (m + len > end) break;
      for (let b = 0; len >= 32 && b < Math.min(10, dv.getUint16(m + 30)) && 36 + b * 4 <= len; b++) {
        const ptr = dv.getUint32(m + 32 + b * 4);
        if (!ptr || ptr + 20 > len || buf[m + ptr] !== 0x44) continue;
        const key = `${buf[m + 22]}:${String.fromCharCode(...buf.subarray(m + ptr + 1, m + ptr + 4))}`, word = buf[m + ptr + 19];
        if (word !== 8 && word !== 16) return true;
        if ((first.get(key) ?? word) !== word) return true;
        first.set(key, word);
      }
      q += 12 + hw * 2;
    }
    p = end;
  }
  return false;
}

const legacy = (): SynthLegacyVolume => ({
  header: 'ARCHIVE2.', site: '', timeMs: Date.UTC(1999, 4, 3, 23, 31, 34), vcp: 21,
  cuts: [
    { elevation: 0.48, radials: 367, az0: 213, ref: { gates: 30 }, code: (m, r, g) => 2 + ((r * 3 + g * 5 + m * 31) % 240) },
    { elevation: 0.44, radials: 366, az0: 220.7, doppler: { gates: 40, nyquist: 26.1 }, code: (m, r, g) => ((r + g) % 19 ? 2 + ((r + g * 7 + m) % 200) : 1) },
    { elevation: 2.42, radials: 362, step: 1, ref: { gates: 20 }, doppler: { gates: 36, nyquist: 30.41, res: 4 }, code: (m, r, g) => 2 + ((r * g + m) % 250) },
  ],
});
// VCP 31 has no definition: the cuts are inferred from the moments (a split pair, then a batch cut).
const inferred = (): SynthLegacyVolume => ({
  header: 'AR2V0001.', site: 'KICT', timeMs: Date.UTC(2004, 0, 5, 12), vcp: 31,
  cuts: [
    { elevation: 0.48, radials: 366, ref: { gates: 20 }, code: (m, r, g) => 2 + ((r + g + m) % 90) },
    { elevation: 0.53, radials: 366, doppler: { gates: 20, nyquist: 11.6 }, code: (m, r, g) => 2 + ((r * 2 + g + m) % 90) },
    { elevation: 2.5, radials: 366, ref: { gates: 20 }, doppler: { gates: 20, nyquist: 11.6 }, code: (m, r, g) => 2 + ((r + g * 2 + m) % 90) },
  ],
});

describe.skipIf(!existsSync(WASM))('Rust/WebAssembly Archive II decoder', () => {
  beforeAll(async () => { await loadArchive2Wasm(readFileSync(WASM)); });
  afterEach(() => { preferTypeScriptArchive2(false); });

  it('is the worker backend once loaded, with no decoder left open', () => {
    expect(archive2Backend()).toMatchObject({ backend: 'rust', error: null, liveDecoders: 0 });
    expect(configureL2({}).decoder.backend).toBe('rust');
    preferTypeScriptArchive2(true);
    expect(archive2Backend().backend).toBe('ts');
    expect(createArchive2Decoder()).toBeInstanceOf(Archive2Decoder);
  });

  describe('parity with the TypeScript decoder', () => {
    const chunks = writeArchive2(splitSailsVolume());

    it('decodes the synthetic split-cut / SAILS volume identically, whole and chunk by chunk', () => {
      expectSame(decodeWith(rust(), concat(chunks)), reference(concat(chunks)));
      expect(expectIncrementalParity(chunks)).toBeGreaterThan(40);
    });

    it.skipIf(!hasBzip2)('decodes bzip2 records and whole-file bzip2 identically', () => {
      const packed = bzipRecords(chunks);
      expect(packed[1][4]).toBe(0x42); // "BZh" records
      expectIncrementalParity(packed);
      const whole = new Uint8Array(spawnSync('bzip2', ['-c'], { input: concat(packed), maxBuffer: 1 << 28 }).stdout);
      expectSame(decodeWith(rust(), whole), reference(whole));
    });

    it('decodes message 1 volumes identically (requested site, VCP-defined and inferred cuts, overrun radials)', () => {
      for (const [v, site] of [[legacy(), 'KTLX'], [inferred(), 'KTLX']] as const) {
        const file = writeLegacyArchive2(v), want = reference(file, site);
        expect(want.sweeps.length).toBe(3);
        expectSame(decodeWith(rust(site), file), want);
        // Fed in pieces of whole frames: legacy cuts depend on the previous sweep when built.
        const pieces = [file.subarray(0, 24 + 2432 * 400), file.subarray(24 + 2432 * 400, 24 + 2432 * 800), file.subarray(24 + 2432 * 800)];
        // Later pieces repeat the volume header: its zero record length marks the uncompressed frames after it.
        const headless = pieces.map((p, i) => (i === 0 ? p : concat([file.subarray(0, 24), p])));
        expectIncrementalParity(headless, site);
      }
    });

    it('decodes the trimmed real 1999 volume identically', () => {
      const file = new Uint8Array(gunzipSync(readFileSync(new URL('./fixtures/radar/KTLX19990503_233134-trim.gz', import.meta.url))));
      expectSame(decodeWith(rust('KTLX'), file), reference(file, 'KTLX'));
    });

    it('decodes the trimmed real 2026 volume identically (message 31 with every moment), whole and record by record', () => {
      const file = new Uint8Array(readFileSync(new URL('./fixtures/radar/KTLX20261115_135928_V06-trim', import.meta.url)));
      const want = reference(file);
      expect(want).toMatchObject({ site: 'KTLX', vcpNumber: 212 });
      expect(want.sweeps.map((s) => [s.elevationNumber, s.radialCount, Object.keys(s.moments).join()])).toEqual([[16, 240, 'REF,VEL,SW,ZDR,PHI,RHO,CFP']]);
      expectSame(decodeWith(rust(), file), want);
      expect(recordChunks(file).length).toBe(3);
      expectIncrementalParity(recordChunks(file));
    });

    it.skipIf(!samples.length)('decodes real recent volumes identically, whole and record by record', () => {
      for (const name of samples) {
        const file = new Uint8Array(readFileSync(join(SAMPLES!, name)));
        const want = reference(file), got = decodeWith(rust(), file);
        expect(want.sweeps.length, name).toBeGreaterThan(10);
        expectSame(got, want, name);
        expect(expectIncrementalParity(recordChunks(file)), name).toBeGreaterThan(100);
      }
    }, 300_000);
  });

  describe('worker tasks', () => {
    const params = { qualityDealiasing: true, stormMotion: { speedKt: 30, fromDeg: 240 }, hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 300, hm20Custom: 900, envIsotherms: null, etThreshold: 18.5, gust1991: true };
    const run = (task: string, args: object) => L2_HANDLERS[task](args, new JobClock()) as Promise<any>;
    const chunks = writeArchive2(splitSailsVolume());
    const urls = (tag: string) => chunks.map((c, i) => { const u = `https://chunks.example/${tag}/${i}`; files.set(u, c); return u; });
    beforeEach(() => { files.clear(); configureL2({ volumes: 50 }); });

    it('give the same meta, products and packs with either decoder, for archive files and live chunks', async () => {
      const file = 'https://unidata-nexrad-level2.s3.amazonaws.com/2026/05/06/KTST/KTST20260506_220320_V06';
      for (const tag of ['#ts', '#rs']) files.set(file + tag, concat(chunks));
      const live = urls('a');
      const jobs: [string, object][] = [['l2.meta', {}], ['l2.composite', { base: 500, top: 3000, selectiveMax: true }]];
      for (const product of [0, 3, 6, 10, 13, 17]) jobs.push(['l2.product', { sweep: 2, product, params }]);
      for (const moment of ['REF', 'VEL', 'CC']) jobs.push(['l2.volume', { moment, latest: true, qualityDealiasing: true }]);
      for (const [task, args] of jobs) {
        for (const [what, src] of [['file', { url: file, live: false }], ['chunks', { url: 'chunks:a', live: true, chunks: live.slice(0, 9) }]] as const) {
          preferTypeScriptArchive2(true);
          const want = await run(task, { ...args, ...src, url: `${src.url}#ts` });
          preferTypeScriptArchive2(false);
          const got = await run(task, { ...args, ...src, url: `${src.url}#rs` });
          expectSame(got, want, `${task} ${what}`);
        }
      }
      expect(archive2Backend().liveDecoders).toBe(1); // the live stream; the archive decode was freed
    });

    it.skipIf(!hasBzip2)('report a refused chunk, then decode afresh: the stream is not left with part of the chunk', async () => {
      const good = urls('b'), bad = 'https://chunks.example/b/bad';
      const corrupt = bzipRecords([chunks[0], chunks[3]])[1].slice();
      corrupt[corrupt.length >> 1] ^= 0x5a;
      files.set(bad, corrupt);
      await run('l2.meta', { url: 'chunks:b', live: true, chunks: good.slice(0, 3) });
      const open = archive2Backend().liveDecoders, list = [...good.slice(0, 3), bad];
      await expect(run('l2.meta', { url: 'chunks:b', live: true, chunks: list })).rejects.toThrow(/corrupt bzip2 record/);
      expect(archive2Backend().liveDecoders).toBe(open - 1); // the failed stream's decoder was freed
      await expect(run('l2.meta', { url: 'chunks:b', live: true, chunks: list })).rejects.toThrow(/corrupt bzip2 record/);
      // The repaired sequence decodes to exactly the full decode of its bytes.
      const meta = await run('l2.meta', { url: 'chunks:b', live: true, chunks: good.slice(0, 6) });
      files.set('https://full.example/b', concat(chunks.slice(0, 6)));
      expectSame(meta, await run('l2.meta', { url: 'https://full.example/b', live: false }));
      expect(archive2Backend().liveDecoders).toBe(open);
    });

    let tags = 0;
    /** The meta of the first `n` chunks decoded as one file. */
    const whole = (n: number) => { const u = `https://full.example/${tags++}`; files.set(u, concat(chunks.slice(0, n))); return run('l2.meta', { url: u, live: false }); };
    /** Frees every stream: three new live streams evict the others, then completing them frees theirs. */
    async function freeStreams() {
      const fill = [0, 1, 2].map(() => urls(`fill${tags++}`).slice(0, 2));
      for (const live of [true, false]) for (const c of fill) await run('l2.meta', { url: `chunks:${c[0]}`, live, chunks: c });
      expect(archive2Backend().liveDecoders).toBe(0);
    }
    const fetched = () => vi.mocked(fetchBytes).mock.calls.map(([u]) => u);

    it('decode a complete chunk volume once, free its decoder and answer later requests from the cache', async () => {
      await freeStreams();
      const u = urls('h'), url = 'chunks:h';
      vi.mocked(fetchBytes).mockClear();
      const partial = await run('l2.meta', { url, live: true, chunks: u.slice(0, 4) });
      expect(archive2Backend().liveDecoders).toBe(1);
      // Overlapping requests run in order: the complete one frees the decoder, a late live one gets the complete volume.
      const [complete, late] = await Promise.all([run('l2.meta', { url, live: false, chunks: u }), run('l2.meta', { url, live: true, chunks: u.slice(0, 6) })]);
      expect(late).toBe(complete);
      expect(archive2Backend().liveDecoders).toBe(0);
      expect(fetched()).toEqual(u); // each chunk once: the complete request fed the live decoder the rest
      vi.mocked(fetchBytes).mockClear();
      for (const live of [false, true]) expect(await run('l2.meta', { url, live, chunks: u })).toBe(complete);
      expect((await run('l2.product', { url, live: false, chunks: u, sweep: 2, product: 0, params })).meta).toBe(complete);
      expect(fetched()).toEqual([]);
      expect(archive2Backend().liveDecoders).toBe(0);
      expectSame(partial, await whole(4));
      expectSame(complete, await whole(u.length));
      // Another chunk sequence under the URL (a chunk replaced) is decoded afresh.
      const other = [...u.slice(0, 5), 'https://chunks.example/h/5b', ...u.slice(6)];
      files.set(other[5], chunks[5]);
      vi.mocked(fetchBytes).mockClear();
      const redone = await run('l2.meta', { url, live: false, chunks: other });
      expect(redone).not.toBe(complete);
      expect(fetched()).toEqual(other);
      expectSame(redone, complete);
      expect(archive2Backend().liveDecoders).toBe(0);
    });

    it('build rolling products over a complete chunk volume as over its file, keeping only the live decoder', async () => {
      await freeStreams();
      const file = 'https://full.example/rolling';
      files.set(file, concat(chunks));
      const args = { url: 'chunks:q', live: true, chunks: urls('q').slice(0, 9), sweep: 0, product: 13, params };
      const want = await run('l2.product', { ...args, rolling: { url: file } });
      expect(want.sweep.rolling.prevTilts).toBeGreaterThan(0);
      for (let i = 0; i < 2; i++) expectSame(await run('l2.product', { ...args, rolling: { url: 'chunks:p', chunks: urls('p') } }), want);
      expect(archive2Backend().liveDecoders).toBe(1);
    });

    it('hold no decoder for failed or pending downloads, and resume a stream after a failed download', async () => {
      await freeStreams();
      const u = urls('m');
      for (let i = 0; i < 8; i++) await expect(run('l2.meta', { url: `chunks:404/${i}`, live: true, chunks: [u[0], `https://missing.example/${i}`] })).rejects.toThrow(/404/);
      expect(archive2Backend().liveDecoders).toBe(0);
      await run('l2.meta', { url: 'chunks:m', live: true, chunks: u.slice(0, 2) });
      await expect(run('l2.meta', { url: 'chunks:m', live: true, chunks: [...u.slice(0, 2), 'https://missing.example/m'] })).rejects.toThrow(/404/);
      expect(archive2Backend().liveDecoders).toBe(1);
      vi.mocked(fetchBytes).mockClear();
      const resumed = await run('l2.meta', { url: 'chunks:m', live: true, chunks: u.slice(0, 3) });
      expect(fetched()).toEqual([u[2]]);
      expectSame(resumed, await whole(3));
      // Eight new volumes whose second chunk is still downloading.
      const release: (() => void)[] = [];
      const pending = Array.from({ length: 8 }, (_, i) => {
        const slow = `https://chunks.example/slow/${i}`;
        files.set(slow, new Promise<Uint8Array>((r) => release.push(() => r(chunks[1]))));
        return run('l2.meta', { url: `chunks:slow/${i}`, live: true, chunks: [u[0], slow] });
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(archive2Backend().liveDecoders).toBe(1);
      for (const r of release) r();
      const want = await whole(2);
      for (const meta of await Promise.all(pending)) expectSame(meta, want);
      expect(archive2Backend().liveDecoders).toBe(3);
    });

    it('decode afresh a stream evicted, and its decoder freed, while its next chunk downloads', async () => {
      await freeStreams();
      let release!: (b: Uint8Array) => void;
      const base = urls('c'), slow = 'https://chunks.example/slow/1';
      files.set(slow, new Promise<Uint8Array>((r) => { release = r; }));
      await run('l2.meta', { url: 'chunks:slow', live: true, chunks: [base[0]] });
      const pending = run('l2.meta', { url: 'chunks:slow', live: true, chunks: [base[0], slow] });
      await new Promise((r) => setTimeout(r, 0));
      for (const tag of ['d', 'e', 'f']) await run('l2.meta', { url: `chunks:${tag}`, live: true, chunks: urls(tag).slice(0, 3) });
      expect(archive2Backend().liveDecoders).toBe(3);
      vi.mocked(fetchBytes).mockClear();
      release(chunks[1]);
      const meta = await pending;
      expect(fetched()).toEqual([base[0], slow]); // fetched again (from the cache in the browser) for the fresh decode
      expectSame(meta, await whole(2));
      expect(archive2Backend().liveDecoders).toBe(3);
    });
  });

  describe('refused input', () => {
    let open = 0;
    beforeEach(() => { open = archive2Backend().liveDecoders; });
    afterEach(() => { expect(archive2Backend().liveDecoders, 'decoders left open').toBe(open); });

    it.skipIf(!hasBzip2)('reports corrupt and truncated bzip2 records and refuses further use', () => {
      const packed = bzipRecords(writeArchive2(splitSailsVolume()));
      const corrupt = packed[2].slice(); corrupt[corrupt.length >> 1] ^= 0x5a;
      const d = rust();
      d.feed(packed[0]); d.feed(packed[1]);
      expect(() => d.feed(corrupt)).toThrow(/corrupt bzip2 record/);
      expect(() => d.feed(packed[3])).toThrow(/decoder failed earlier/);
      expect(() => d.volume()).toThrow(/no volume/);
      d.dispose();
      const cut = packed[2].subarray(0, packed[2].length - 30).slice();
      new DataView(cut.buffer).setInt32(0, cut.length - 4);
      expect(() => decodeWith(rust(), concat([packed[0], cut]))).toThrow(/truncated bzip2 record/);
    });

    it('decodes mutated volumes without faults, and like the reference wherever the reference reads them', () => {
      const file = concat(writeArchive2(splitSailsVolume(12), 1));
      let seed = 7, same = 0, refused = 0, odd = 0;
      const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
      for (let round = 0; round < 300; round++) {
        const buf = file.slice();
        for (let k = 1 + Math.floor(rnd() * 6); k > 0; k--) buf[Math.floor(rnd() * buf.length)] = Math.floor(rnd() * 256);
        let want: L2Volume | null = null;
        try { const ts = new Archive2Decoder(); ts.feed(buf); want = ts.volume(); } catch { refused++; } // RangeError on a truncated block
        const got = decodeWith(rust(), buf); // never throws on uncompressed records
        if (oddWordSizes(buf)) odd++;
        else if (want) { expectSame(got, want, `round ${round}`); same++; }
      }
      expect(same).toBeGreaterThan(200);
      expect(refused + odd).toBeLessThan(100);
    });
  });
});

describe('Archive II module loading', () => {
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); if (existsSync(WASM)) await loadArchive2Wasm(readFileSync(WASM)); });

  it('refuses a module without the decoder interface and keeps the TypeScript decoder', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadArchive2Wasm(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])); // a valid, empty module
    expect(archive2Backend()).toMatchObject({ backend: 'ts', error: 'not the Archive II decoder (missing memory, a2_create, a2_input, a2_feed, a2_volume, a2_sweep)' });
    expect(createArchive2Decoder()).toBeInstanceOf(Archive2Decoder);
  });

  it('gives up a download without an answer after 20 s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', (_url: string, o: RequestInit) => new Promise((_, reject) => o.signal!.addEventListener('abort', () => reject(o.signal!.reason))));
    let settled = false;
    const load = loadArchive2Wasm('/assets/cwrv3_archive2.wasm').then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await load;
    expect(archive2Backend()).toMatchObject({ backend: 'ts', error: 'no answer within 20 s' });
  });
});
