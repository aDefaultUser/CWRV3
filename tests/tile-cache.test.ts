// Basemap tile atlas: delayed, out-of-order and failing tile loads with rapid panning under atlas pressure. A drawn
// tile always has imagery (its own or an ancestor's) once the coarse coverage has loaded, and a tile that stays in
// view never falls back to coarser imagery than it already had.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/render/mips', () => ({ generateLayerMips: vi.fn(), mipLevels: () => 9, anisotropyOf: (x: number) => x }));
import { TileCache } from '../src/render/tiles';

type Pending = { url: string; resolve: () => void; reject: () => void };
let pending: Pending[] = [];
let fetches = 0;
let rng = 1;
const rand = () => ((rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) / 2 ** 32);

beforeEach(() => {
  pending = []; rng = 7;
  vi.stubGlobal('fetch', (url: string) => (fetches++, new Promise((res, rej) => pending.push({ url, resolve: () => res({ ok: true, blob: async () => new Blob() }), reject: () => rej(new TypeError('network')) }))));
  vi.stubGlobal('createImageBitmap', async () => { counts.bitmaps++; return { close() {} }; });
  fetches = 0;
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, STORAGE_BINDING: 8 });
});
afterEach(() => vi.unstubAllGlobals());

const counts = { bitmaps: 0, uploads: 0 };
function cache() {
  counts.bitmaps = counts.uploads = 0;
  const device = { createTexture: () => ({}), queue: { copyExternalImageToTexture: () => { counts.uploads++; } } };
  return new TileCache({ gpu: { device, trackTexture: () => {}, recordUpload: () => {} } } as never, (z, x, y) => `${z}/${x}/${y}`, 8, () => {});
}
/** Completes up to `n` pending loads in random order; `failRate` of them fail. */
async function settle(n: number, failRate = 0) {
  for (let i = 0; i < n && pending.length; i++) {
    const p = pending.splice(Math.floor(rand() * pending.length), 1)[0];
    if (rand() < failRate) p.reject(); else p.resolve();
  }
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
/** Level-8 tiles of a 6×4 view around tile (cx, cy). */
const view = (cx: number, cy: number) => Array.from({ length: 24 }, (_, i) => [8, cx + (i % 6), cy + Math.floor(i / 6)] as [number, number, number]);

describe('tile atlas coverage', () => {
  it('never draws a tile without imagery once coarse coverage is loaded, and never coarsens a tile in view', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const c = cache();
    let frame = 0, uncoveredAfterCoarse = 0, coarsened = 0, coarseLoaded = false;
    const level = new Map<string, number>();
    // Cold start zoomed in, then rapid pans over 70 regions (far more distinct tiles than the 256 atlas slots).
    for (let step = 0; step < 70 * 6; step++) {
      const region = Math.floor(step / 6);
      const tiles = view(20 + ((region * 7) % 200), 60 + ((region * 3) % 120));
      frame++;
      const seen = new Map<string, number>();
      tiles.forEach(([z, x, y], i) => {
        const r = c.lookup(z, x, y, frame, z * 10 + i * 0.001);
        const k = `${z}/${x}/${y}`;
        if (!r) { if (coarseLoaded || step >= 60) uncoveredAfterCoarse++; return; } // coarse coverage loads within the first steps
        if ((level.get(k) ?? -1) > r[1]) coarsened++;
        seen.set(k, r[1]);
      });
      level.clear(); for (const [k, v] of seen) level.set(k, v);
      if (!coarseLoaded) coarseLoaded = Array.from({ length: 16 }, (_, i) => c.lookup(2, i % 4, i >> 2, frame, 0)).every((r) => r?.[1] === 2);
      c.pump(frame);
      await settle(3, 0.05); // slower than the panning: most views move on before their tiles arrive
      vi.setSystemTime(Date.now() + 250);
    }
    vi.useRealTimers();
    expect(coarseLoaded).toBe(true);
    expect(uncoveredAfterCoarse).toBe(0);
    expect(coarsened).toBe(0);
  });

  it('retries a tile whose load failed', async () => {
    const c = cache();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let f = 1; f < 10; f++) { c.pump(f); await settle(50); } // kept coarse levels
      const urls = () => pending.map((p) => p.url);
      c.lookup(5, 10, 10, 10, 50); c.pump(10);
      expect(urls()).toContain('5/10/10');
      pending.splice(pending.findIndex((p) => p.url === '5/10/10'), 1)[0].reject();
      await settle(0);
      c.lookup(5, 10, 10, 11, 50); c.pump(11);
      expect(urls()).not.toContain('5/10/10'); // no tight retry loop
      vi.setSystemTime(Date.now() + 60_000);
      c.lookup(5, 10, 10, 12, 50); c.pump(12);
      expect(urls()).toContain('5/10/10');
    } finally { vi.useRealTimers(); }
  });
});

describe('tile atlas pressure', () => {
  /**
   * A wide, tilted terrain view: 360 tiles across three levels (near 8, middle 7, far 6), more than the 256 atlas
   * slots once their own fallbacks are counted.
   */
  const tilted = () => {
    const out: [number, number, number][] = [];
    for (let i = 0; i < 192; i++) out.push([8, 100 + (i % 24), 60 + Math.floor(i / 24)]);
    for (let i = 0; i < 96; i++) out.push([7, 30 + (i % 24), 26 + Math.floor(i / 24)]);
    for (let i = 0; i < 72; i++) out.push([6, 4 + (i % 24), 6 + Math.floor(i / 24)]);
    return out;
  };

  it('stops fetching tiles it has no slot for, keeps every tile covered and never coarsens one', async () => {
    const c = cache();
    const level = new Map<string, number>();
    let uncovered = 0, coarsened = 0, fetchesBefore = 0, bitmapsBefore = 0;
    for (let frame = 1; frame <= 160; frame++) {
      if (frame === 80) { fetchesBefore = fetches; bitmapsBefore = counts.bitmaps; }
      tilted().forEach(([z, x, y], i) => {
        const r = c.lookup(z, x, y, frame, z * 10 + i * 0.001);
        const k = `${z}/${x}/${y}`;
        if (!r) { if (frame > 10) uncovered++; return; }
        if ((level.get(k) ?? -1) > r[1]) coarsened++;
        level.set(k, r[1]);
      });
      c.pump(frame);
      await settle(pending.length); // the network keeps up: every request completes before the next frame
    }
    expect([uncovered, coarsened]).toEqual([0, 0]);
    // Saturated by frame 80: no further network requests or image decodes for a view that is not moving.
    expect(fetches - fetchesBefore).toBe(0);
    expect(counts.bitmaps - bitmapsBefore).toBe(0);
    // Every decoded tile was kept: none were fetched and decoded only to be dropped for want of a slot.
    expect(counts.bitmaps).toBe(counts.uploads);
    expect(counts.uploads).toBeGreaterThanOrEqual(250);
  });

  it('drops a tile whose slot the view pinned again while it loaded, once, and backs off instead of refetching', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const c = cache();
      const draw = (frame: number, skip?: string) => {
        let own: string | undefined;
        tilted().forEach(([z, x, y], i) => {
          const k = `${z}/${x}/${y}`;
          if (k === skip) return;
          const r = c.lookup(z, x, y, frame, z * 10 + i * 0.001);
          if (r?.[1] === z) own ??= k;
        });
        return own!;
      };
      let frame = 1;
      for (; frame <= 60; frame++) { draw(frame); c.pump(frame); await settle(pending.length); }
      const before = fetches;
      // One drawn tile leaves the view for three frames: its slot becomes free for one queued tile.
      const away = draw(frame);
      for (let k = 0; k < 3; k++) { frame++; draw(frame, away); }
      c.pump(frame);
      expect(fetches - before).toBe(1);
      // It comes back before the load completes: the loaded tile has no slot and is dropped.
      frame++; draw(frame); c.pump(frame);
      await settle(pending.length);
      expect(c.dropped).toBe(1);
      for (let k = 0; k < 20; k++) { frame++; draw(frame); c.pump(frame); await settle(pending.length); vi.setSystemTime(Date.now() + 250); }
      expect([fetches - before, c.dropped]).toEqual([1, 1]);
    } finally { vi.useRealTimers(); }
  });
});
