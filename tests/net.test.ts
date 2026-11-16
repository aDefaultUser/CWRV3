// Network layer: byte-range validation and shared in-flight abort semantics (static review findings).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchBytes, parseContentRange } from '../src/data/net';

const body = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 255);
function respond(status: number, data: Uint8Array, headers: Record<string, string> = {}) {
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < data.length; i += 7) c.enqueue(data.slice(i, i + 7)); c.close(); } }), { status, headers });
}
afterEach(() => vi.unstubAllGlobals());

describe('fetchBytes ranges', () => {
  it('parses Content-Range', () => {
    expect(parseContentRange('bytes 10-19/100')).toEqual({ start: 10, end: 19, total: 100 });
    expect(parseContentRange('bytes 0-0/*')).toEqual({ start: 0, end: 0, total: null });
    expect(parseContentRange('items 1-2/3')).toBeNull();
  });
  it('accepts a matching 206', async () => {
    vi.stubGlobal('fetch', async () => respond(206, body(100).slice(10, 20), { 'content-range': 'bytes 10-19/100' }));
    expect([...(await fetchBytes('https://example.test/a', { range: [10, 19] }))]).toEqual([...body(100).slice(10, 20)]);
  });
  it('rejects a 206 for a different range', async () => {
    vi.stubGlobal('fetch', async () => respond(206, body(10), { 'content-range': 'bytes 0-9/100' }));
    await expect(fetchBytes('https://example.test/b', { range: [10, 19] })).rejects.toThrow(/range mismatch/);
  });
  it('slices a 200 that ignored the Range header', async () => {
    vi.stubGlobal('fetch', async () => respond(200, body(200)));
    const out = await fetchBytes('https://example.test/c', { range: [50, 59] });
    expect([...out]).toEqual([...body(200).slice(50, 60)]);
  });
  it('rejects a 200 shorter than the requested start', async () => {
    vi.stubGlobal('fetch', async () => respond(200, body(20)));
    await expect(fetchBytes('https://example.test/d', { range: [50, 59] })).rejects.toThrow(/beyond end/);
  });
});

describe('fetchBytes shared in-flight requests', () => {
  it('one caller aborting does not abort the others', async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { signal = init.signal!; await gate; return respond(200, body(30)); });
    const a = new AbortController();
    const p1 = fetchBytes('https://example.test/e', { signal: a.signal });
    const p2 = fetchBytes('https://example.test/e');
    a.abort();
    await expect(p1).rejects.toThrow(/abort/i);
    expect(signal!.aborted).toBe(false);
    release();
    expect((await p2).length).toBe(30);
  });
  it('the transfer stops when every caller aborted', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => { signal = init.signal!; return new Promise((_r, j) => init.signal!.addEventListener('abort', () => j(new DOMException('aborted', 'AbortError')))); });
    const a = new AbortController(), b = new AbortController();
    const p1 = fetchBytes('https://example.test/f', { signal: a.signal });
    const p2 = fetchBytes('https://example.test/f', { signal: b.signal });
    await Promise.resolve();
    a.abort();
    expect(signal!.aborted).toBe(false);
    b.abort();
    await expect(p1).rejects.toThrow(); await expect(p2).rejects.toThrow();
    expect(signal!.aborted).toBe(true);
  });
});

describe('fetchBytes 206 without an exposed Content-Range (S3 CORS)', () => {
  it('accepts a 206 whose length does not exceed the request', async () => {
    vi.stubGlobal('fetch', async () => respond(206, body(10)));
    expect((await fetchBytes('https://example.test/g', { range: [100, 109] })).length).toBe(10);
  });
  it('never keeps more than the requested length', async () => {
    vi.stubGlobal('fetch', async () => respond(206, body(50)));
    expect((await fetchBytes('https://example.test/h', { range: [0, 9] })).length).toBe(10);
  });
});
