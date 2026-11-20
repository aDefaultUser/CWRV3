// Per-frame and startup costs that must not change results: the label declutter against the greedy reference,
// line tessellation against lonLatToXYZ, wind arrows built once per hour, and backbuffer sizing that touches the
// canvas only on real changes.
import { describe, expect, it } from 'vitest';
import { Camera, lonLatToXYZ } from '../src/render/camera';
import { Declutter, LineSet, type DeclutterItem } from '../src/render/prims';
import { Gpu } from '../src/render/gpu';
import type { Renderer } from '../src/render/renderer';
import { tessellate } from '../src/gis/tessellate';
import { windArrows } from '../src/gis/wind-arrows';

Object.assign(globalThis, { GPUBufferUsage: { STORAGE: 128, COPY_DST: 8 }, GPUTextureUsage: { RENDER_ATTACHMENT: 16 } });

/** The previous per-frame implementation: project every item, test against every placed box. */
function reference(cam: Camera, items: DeclutterItem[], spacingPx: number, filter?: (i: number) => boolean) {
  const vis = new Uint8Array(items.length);
  const order = items.map((_, i) => i).sort((a, b) => (items[b].priority ?? 0) - (items[a].priority ?? 0));
  const boxes: number[] = [];
  for (const i of order) {
    if (filter && !filter(i)) continue;
    const l = items[i];
    const [x, y, front] = cam.project(lonLatToXYZ(l.lon, l.lat));
    if (!front || x < -50 || y < -20 || x > cam.width + 50 || y > cam.height + 20) continue;
    const sp = l.spacing ?? spacingPx;
    const x0 = x - l.w / 2 - sp / 2, x1 = x + l.w / 2 + sp / 2, y0 = y - l.h - sp / 4, y1 = y + sp / 4;
    let hit = false;
    for (let k = 0; k < boxes.length; k += 4) if (x0 < boxes[k + 2] && x1 > boxes[k] && y0 < boxes[k + 3] && y1 > boxes[k + 1]) { hit = true; break; }
    if (hit) continue;
    boxes.push(x0, y0, x1, y1);
    vis[i] = 1;
  }
  return vis;
}

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

describe('label declutter', () => {
  it('matches the greedy reference for every view, spacing and filter', () => {
    const rand = rng(7);
    // Clustered and spread labels with tied priorities, per-item spacing and some very wide boxes.
    const items: DeclutterItem[] = Array.from({ length: 3000 }, (_, i) => ({
      lon: -125 + rand() * 60, lat: 25 + rand() * 25, w: 20 + rand() * (i % 50 === 0 ? 900 : 120), h: 10 + rand() * 20,
      priority: Math.floor(rand() * 5), spacing: i % 3 === 0 ? 40 + rand() * 300 : undefined,
    }));
    const d = new Declutter(items);
    const cam = new Camera();
    const views = [
      { lon: -95, lat: 39, z: 163.75, tilt: 0, swivel: 0 }, { lon: -97.3, lat: 35.3, z: 14, tilt: 0, swivel: 0 },
      { lon: -100, lat: 40, z: 60, tilt: 50, swivel: 30 }, { lon: 80, lat: 0, z: 400, tilt: 0, swivel: 0 }, { lon: -90, lat: 30, z: 2, tilt: 70, swivel: 200 },
    ];
    let shown = 0;
    for (const [w, h] of [[1920, 1080], [935, 520]]) for (const v of views) for (const sp of [0, 30, 140]) for (const filter of [undefined, (i: number) => i % 4 !== 1]) {
      cam.width = w; cam.height = h; cam.setView(v, true); cam.compute();
      const r = { camera: cam } as Renderer;
      const want = reference(cam, items, sp, filter);
      expect(Array.from(d.run(r, sp, filter))).toEqual(Array.from(want));
      shown += want.reduce((a, b) => a + b, 0);
    }
    expect(shown).toBeGreaterThan(1000);
  });
});

describe('line tessellation', () => {
  it('writes the same segments as lonLatToXYZ, across the antimeridian and with heights', () => {
    let out: Float32Array = new Float32Array(0);
    const r = { gpu: { buffer: (f: Float32Array) => { out = f; return { size: f.byteLength }; } } } as unknown as Renderer;
    const ls = new LineSet(r);
    ls.setLines([{ coords: [-100, 30, -97.5, 33.2, -97.4, 33.3], style: 2 }, { coords: [179.5, 10, -179, 12], style: 5, height: 0.001 }]);
    const want: number[] = [];
    const seg = (lo0: number, la0: number, lo1: number, la1: number, style: number, rr: number) => {
      if (lo1 - lo0 > 180) lo1 -= 360; else if (lo0 - lo1 > 180) lo1 += 360;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(lo1 - lo0), Math.abs(la1 - la0)) / 0.75));
      let a = lonLatToXYZ(lo0, la0, rr);
      for (let s = 1; s <= steps; s++) { const b = lonLatToXYZ(lo0 + ((lo1 - lo0) * s) / steps, la0 + ((la1 - la0) * s) / steps, rr); want.push(...a, style, ...b, 0); a = b; }
    };
    seg(-100, 30, -97.5, 33.2, 2, 1.000004); seg(-97.5, 33.2, -97.4, 33.3, 2, 1.000004); seg(179.5, 10, -179, 12, 5, 1.001);
    expect(ls.count).toBe(want.length / 8);
    const got = Array.from(out.subarray(0, want.length));
    want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 6));
  });

  it('sizes the array for longitudes mixed between 0–360 and ±180', () => {
    // -170 → 350 (= -10) is 160° east: 214 steps, which a count over the raw difference (520°) undercounted.
    const segs = tessellate([{ coords: [-170, 10, 350, 10, 351, 11], style: 1 }, { coords: [200, -5, -150, -4], style: 2 }]);
    expect(segs.length / 8).toBe(214 + 2 + 14);
    const end = (k: number) => Array.from(segs.subarray(k * 8 + 4, k * 8 + 7));
    const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
    near(end(213), lonLatToXYZ(-10, 10, 1.000004));
    near(end(215), lonLatToXYZ(-9, 11, 1.000004));
    near(end(229), lonLatToXYZ(-150, -4, 1.000004));
    expect(Array.from(segs.subarray(229 * 8 + 3, 229 * 8 + 4))).toEqual([2]);
  });

  it('wraps full turns and keeps valid segments on both sides of malformed coordinates', () => {
    const mixed = tessellate([{ coords: [0, 30, 720, 30.5, NaN, 31, 10, 30, 10.5, 30.5, 10.5, 100], style: 1 }]);
    const valid = tessellate([
      { coords: [0, 30, 0, 30.5], style: 1 },
      { coords: [10, 30, 10.5, 30.5], style: 1 },
    ]);
    expect(mixed).toEqual(valid);
    expect(mixed.length).toBe(16);
  });
});

describe('wind arrows', () => {
  it('match the arrows the surface layer built per frame', () => {
    const rand = rng(3), wv = new Float32Array(4 * 400);
    for (let i = 0; i < 400; i++) wv.set([-130 + rand() * 70, 20 + rand() * 32, (rand() - 0.5) * 70, (rand() - 0.5) * 70], i * 4);
    wv.set([-97, 35, 0, 0, -97, 36, 0.2, 0.1], 0); // calm samples are skipped
    const want: { coords: number[]; style: number }[] = [], bins = [5, 10, 15, 20, 30, 40, 55, 75];
    for (let i = 0; i < wv.length; i += 4) {
      const [lon, lat, u, v] = [wv[i], wv[i + 1], wv[i + 2], wv[i + 3]];
      const mph = Math.hypot(u, v) * 2.23694;
      if (!(mph > 1)) continue;
      const L = 0.06 + mph * 0.006, k = Math.cos((lat * Math.PI) / 180);
      const dx = (u / Math.hypot(u, v)) * L / k, dy = (v / Math.hypot(u, v)) * L;
      const style = Math.max(0, bins.findIndex((b) => mph <= b));
      const tipX = lon + dx, tipY = lat + dy;
      want.push({ coords: [lon, lat, tipX, tipY], style });
      want.push({ coords: [tipX - dx * 0.35 - dy * 0.2 / k, tipY - dy * 0.35 + dx * 0.2 * k, tipX, tipY, tipX - dx * 0.35 + dy * 0.2 / k, tipY - dy * 0.35 - dx * 0.2 * k], style });
    }
    expect(want.length).toBeGreaterThan(700);
    expect(Array.from(tessellate(windArrows(wv)))).toEqual(Array.from(tessellate(want)));
  });
});

describe('backbuffer sizing', () => {
  function fakeGpu(css: { w: number; h: number }) {
    const sets = { width: 0, height: 0 }, textures: { size: number[]; sampleCount: number; destroyed: boolean }[] = [];
    let width = 300, height = 150;
    const canvas = {
      getBoundingClientRect: () => ({ width: css.w, height: css.h }),
      get width() { return width; }, set width(v: number) { sets.width++; width = v; },
      get height() { return height; }, set height(v: number) { sets.height++; height = v; },
    };
    const g = new Gpu(canvas as unknown as HTMLCanvasElement);
    g.device = { limits: { maxTextureDimension2D: 8192 }, createTexture: (d: { size: number[]; sampleCount: number }) => {
      const t = { ...d, width: d.size[0], height: d.size[1], destroyed: false, destroy() { t.destroyed = true; } }; textures.push(t); return t;
    } } as unknown as GPUDevice;
    g.format = 'bgra8unorm';
    return { g, canvas, sets, textures };
  }
  (globalThis as unknown as { window: { devicePixelRatio: number } }).window = { devicePixelRatio: 1 };

  it('assigns the canvas size only when it changes, with and without MSAA', () => {
    const css = { w: 1000, h: 500 };
    const { g, canvas, sets, textures } = fakeGpu(css);
    g.sampleCount = 1;
    expect(g.resize()).toBe(true);
    for (let i = 0; i < 5; i++) expect(g.resize()).toBe(false);
    expect([canvas.width, canvas.height, sets.width, sets.height, textures.length]).toEqual([1000, 500, 1, 1, 0]);
    g.setSampleCount(4); // Lite → Med.: an MSAA target of the same size, no canvas reallocation
    expect(textures.map((t) => [t.size, t.sampleCount])).toEqual([[[1000, 500], 4]]);
    for (let i = 0; i < 5; i++) expect(g.resize()).toBe(false);
    css.w = 1200; // a real size change resizes both
    expect(g.resize()).toBe(true);
    expect([canvas.width, sets.width, textures.length, textures[0].destroyed, textures[1].size]).toEqual([1200, 2, 2, true, [1200, 500]]);
    g.setSampleCount(1);
    expect([textures[1].destroyed, g.msaa, sets.width]).toEqual([true, null, 2]);
  });

  it('keeps a fixed backbuffer stable and follows DPR changes', () => {
    const css = { w: 1280, h: 720 };
    const { g, sets } = fakeGpu(css);
    g.sampleCount = 1;
    g.fixedSize = [3840, 2160];
    expect(g.resize()).toBe(true);
    expect(g.resize()).toBe(false);
    expect([g.width, g.dpr, sets.width]).toEqual([3840, 3, 1]);
    g.fixedSize = null;
    (globalThis as unknown as { window: { devicePixelRatio: number } }).window.devicePixelRatio = 2;
    expect(g.resize()).toBe(true);
    expect([g.width, g.height, g.dpr]).toEqual([2560, 1440, 2]);
    expect(g.resize()).toBe(false);
    (globalThis as unknown as { window: { devicePixelRatio: number } }).window.devicePixelRatio = 1;
  });

  it('follows the CSS width of a fixed backbuffer without reallocating it', () => {
    const css = { w: 1280.5, h: 720 };
    const { g, sets } = fakeGpu(css);
    g.sampleCount = 1;
    g.fixedSize = [1920, 1080];
    expect(g.resize()).toBe(true);
    css.w = 1280.25; // same backbuffer, another pixel ratio (pointer and label mapping use it)
    expect(g.resize()).toBe(true);
    expect([g.dpr, sets.width, sets.height]).toEqual([1920 / 1280.25, 1, 1]);
    expect(g.resize()).toBe(false);
  });

  it('sizes the canvas on the first call even when it matches the initial size', () => {
    const { g, canvas, sets } = fakeGpu({ w: 0, h: 0 }); // not laid out yet: 1 × 1
    g.sampleCount = 1;
    expect(g.resize()).toBe(true);
    expect([canvas.width, canvas.height, sets.width]).toEqual([1, 1, 1]);
    expect(g.resize()).toBe(false);
  });
});
