// GPU primitives shared by the map layers: screen-space polylines, SDF point icons and glyph text.
import type { Renderer, DrawContext } from './renderer';
import { lonLatToXYZ } from './camera';
import { textStyle } from '../app/styles';
import { tessellate, type LineInput } from '../gis/tessellate';

export type Color = [number, number, number, number]; // 0..255 RGBA
export interface LineStyle {
  color: Color; width: number; dash?: number; feather?: number; visible?: boolean;
  /** Animation keyframe (pulse between color/width and color2/width2 every `interval` seconds). */
  color2?: Color; width2?: number; interval?: number; nonLinear?: boolean;
  /** 0 solid, 1 stretch, 2 round, 3 hard (default 3 when `dash` > 0). */ dashMode?: number; dashSpeed?: number;
  offset?: [number, number]; additive?: boolean;
}
export type Polyline = LineInput; // lon/lat interleaved

/** Instanced screen-space polylines on the globe. */
export class LineSet {
  private segBuf: GPUBuffer | null = null;
  private styleBuf: GPUBuffer | null = null;
  private bg: GPUBindGroup | null = null;
  count = 0;
  styles: LineStyle[] = [];
  constructor(private r: Renderer) {}

  setStyles(styles: LineStyle[]) {
    this.styles = styles;
    const f = new Float32Array(Math.max(1, styles.length) * 20);
    styles.forEach((s, i) => {
      const c2 = s.color2 ?? s.color;
      f.set([s.color[0] / 255, s.color[1] / 255, s.color[2] / 255, s.color[3] / 255, c2[0] / 255, c2[1] / 255, c2[2] / 255, c2[3] / 255,
        s.width, s.width2 ?? s.width, s.interval ?? 0, s.nonLinear ? 1 : 0,
        s.dash ?? 0, s.dashMode ?? (s.dash ? 3 : 0), s.dashSpeed ?? 0, s.feather ?? 0,
        s.visible === false ? 0 : 1, s.offset?.[0] ?? 0, s.offset?.[1] ?? 0, s.additive ? 1 : 0], i * 20);
    });
    if (!this.styleBuf || this.styleBuf.size < f.byteLength) { this.styleBuf?.destroy(); this.styleBuf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else this.r.gpu.device.queue.writeBuffer(this.styleBuf, 0, f);
  }

  setLines(lines: Polyline[]) { this.setTessellated(tessellate(lines)); }

  /** Segments built by tessellate() (here or in the decode worker). */
  setTessellated(segs: Float32Array) {
    const f = segs.length ? segs : new Float32Array(8);
    this.count = segs.length / 8;
    if (!this.segBuf || this.segBuf.size < f.byteLength) { this.segBuf?.destroy(); this.segBuf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else this.r.gpu.device.queue.writeBuffer(this.segBuf, 0, f);
  }

  /** Raw 3D segments (7 numbers each: a xyz, b xyz in globe units, style), e.g. vertical lines above the surface. */
  setSegments(segs: ArrayLike<number>) {
    const n = Math.floor(segs.length / 7), f = new Float32Array(Math.max(1, n) * 8);
    for (let i = 0; i < n; i++) f.set([segs[i * 7], segs[i * 7 + 1], segs[i * 7 + 2], segs[i * 7 + 6], segs[i * 7 + 3], segs[i * 7 + 4], segs[i * 7 + 5], 0], i * 8);
    this.count = n;
    if (!this.segBuf || this.segBuf.size < f.byteLength) { this.segBuf?.destroy(); this.segBuf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else this.r.gpu.device.queue.writeBuffer(this.segBuf, 0, f);
  }

  draw(ctx: DrawContext) {
    if (!this.count || !this.segBuf || !this.styleBuf) return;
    if (!this.bg) this.bg = this.r.gpu.device.createBindGroup({ layout: this.r.layouts.lines, entries: [{ binding: 0, resource: { buffer: this.segBuf } }, { binding: 1, resource: { buffer: this.styleBuf } }] });
    ctx.pass.setPipeline(this.r.pipes.lines);
    ctx.pass.setBindGroup(1, this.bg);
    ctx.pass.draw(6, this.count);
  }

  destroy() { this.segBuf?.destroy(); this.styleBuf?.destroy(); }
}

export const SHAPE = { circle: 0, ring: 1, triUp: 2, triDown: 3, diamond: 4, square: 5, plus: 6, bolt: 7, semicircle: 8, frontTri: 9, dot: 10 } as const;
export interface PointSpec { lon: number; lat: number; size: number; color: Color; shape: number; rot?: number; outline?: number; glow?: number; height?: number; additive?: boolean }

export class PointSet {
  private buf: GPUBuffer | null = null;
  private bg: GPUBindGroup | null = null;
  count = 0;
  private data = new Float32Array(0);
  constructor(private r: Renderer) {}

  setPoints(pts: PointSpec[]) {
    const f = new Float32Array(Math.max(1, pts.length) * 12);
    pts.forEach((p, i) => {
      const xyz = lonLatToXYZ(p.lon, p.lat, 1 + (p.height ?? 0.00001));
      f.set([xyz[0], xyz[1], xyz[2], p.size, p.color[0] / 255, p.color[1] / 255, p.color[2] / 255, p.color[3] / 255, p.shape + (p.additive ? 100 : 0), p.rot ?? 0, p.outline ?? 0, p.glow ?? 0], i * 12);
    });
    this.data = f;
    this.count = pts.length;
    if (!this.buf || this.buf.size < f.byteLength) { this.buf?.destroy(); this.buf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else this.r.gpu.device.queue.writeBuffer(this.buf, 0, f);
  }

  /** Updates alpha of point i in place (animations); call flushAlpha() once per frame. */
  setAlpha(i: number, a: number) { this.data[i * 12 + 7] = a; }
  flushAlpha() { if (this.buf && this.count) this.r.gpu.device.queue.writeBuffer(this.buf, 0, this.data, 0, this.count * 12); }

  draw(ctx: DrawContext) {
    if (!this.count || !this.buf) return;
    if (!this.bg) this.bg = this.r.gpu.device.createBindGroup({ layout: this.r.layouts.points, entries: [{ binding: 0, resource: { buffer: this.buf } }] });
    ctx.pass.setPipeline(this.r.pipes.points);
    ctx.pass.setBindGroup(1, this.bg);
    ctx.pass.draw(6, this.count);
  }
}

// ------------------------------------------------------------------------------------------- text
const FONT = '600 30px "Segoe UI", "Noto Sans", "DejaVu Sans", Arial, sans-serif';
const ATLAS = 1024, CELL_H = 44, BASE = 32;

export interface AtlasSpec { font: string; stroke: number; join: CanvasLineJoin; glow: number }
const DEFAULT_SPEC: AtlasSpec = { font: FONT, stroke: 7, join: 'round', glow: 6 };
const atlases = new Map<string, GlyphAtlas>();
/** Atlas per font / stroke / join / glow (text styles, TFrmFontControl). */
export function atlasFor(r: Renderer, spec: AtlasSpec): GlyphAtlas {
  const key = JSON.stringify(spec);
  let a = atlases.get(key);
  if (!a) { a = new GlyphAtlas(r, spec); atlases.set(key, a); }
  return a;
}

/** Glyph atlas: R = fill coverage, G = stroke (halo) coverage, B = blurred outer-effect coverage. */
export class GlyphAtlas {
  tex: GPUTexture;
  private canvas: OffscreenCanvas;
  private g: OffscreenCanvasRenderingContext2D;
  private glyphs = new Map<string, { u: number; v: number; w: number }>();
  private x = 0; private y = 0;
  private dirty = false;
  constructor(private r: Renderer, readonly spec: AtlasSpec = DEFAULT_SPEC) {
    this.canvas = new OffscreenCanvas(ATLAS, ATLAS);
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.tex = r.gpu.device.createTexture({ size: [ATLAS, ATLAS], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.g.font = spec.font;
  }
  glyph(ch: string) {
    let gl = this.glyphs.get(ch);
    if (gl) return gl;
    const w = Math.ceil(this.g.measureText(ch).width) + 8 + Math.ceil(this.spec.glow);
    if (this.x + w > ATLAS) { this.x = 0; this.y += CELL_H; }
    if (this.y + CELL_H > ATLAS) { this.glyphs.clear(); this.x = 0; this.y = 0; this.g.clearRect(0, 0, ATLAS, ATLAS); }
    // Halo pass into G, fill into R (composited by channel masks via two draws).
    const tmp = new OffscreenCanvas(w, CELL_H), t = tmp.getContext('2d', { willReadFrequently: true })!;
    t.font = this.spec.font; t.textBaseline = 'alphabetic';
    t.lineJoin = this.spec.join; t.lineWidth = this.spec.stroke; t.strokeStyle = '#fff'; t.strokeText(ch, 4, BASE);
    const halo = t.getImageData(0, 0, w, CELL_H);
    t.clearRect(0, 0, w, CELL_H); t.filter = `blur(${this.spec.glow / 2}px)`; t.lineWidth = this.spec.stroke + this.spec.glow; t.strokeText(ch, 4, BASE); t.fillText(ch, 4, BASE);
    const glow = t.getImageData(0, 0, w, CELL_H);
    t.filter = 'none'; t.clearRect(0, 0, w, CELL_H); t.fillStyle = '#fff'; t.fillText(ch, 4, BASE);
    const fill = t.getImageData(0, 0, w, CELL_H);
    const out = this.g.createImageData(w, CELL_H);
    for (let i = 0; i < w * CELL_H; i++) { out.data[i * 4] = fill.data[i * 4 + 3]; out.data[i * 4 + 1] = Math.max(halo.data[i * 4 + 3], fill.data[i * 4 + 3]); out.data[i * 4 + 2] = glow.data[i * 4 + 3]; out.data[i * 4 + 3] = 255; }
    this.g.putImageData(out, this.x, this.y);
    gl = { u: this.x, v: this.y, w };
    this.glyphs.set(ch, gl);
    this.x += w;
    this.dirty = true;
    return gl;
  }
  measure(text: string, sizePx: number) { let w = 0; for (const ch of text) w += this.glyph(ch).w - 8; return (w * sizePx) / 30; }
  upload() {
    if (!this.dirty) return;
    this.dirty = false;
    this.r.gpu.device.queue.copyExternalImageToTexture({ source: this.canvas }, { texture: this.tex }, [ATLAS, ATLAS]);
  }
}

export interface Label {
  lon: number; lat: number; text: string; size: number; color: Color; halo: Color;
  dx?: number; dy?: number; align?: 'left' | 'center' | 'right'; height?: number; letterSpacing?: number; priority?: number;
}

const GL = 36; // floats per glyph record
export class TextSet {
  /** Optional named text style (TFrmTextAppearance / TFrmFontControl); overrides font, size and colours. */
  style: string | null = null;
  private gbuf: GPUBuffer | null = null;
  private abuf: GPUBuffer | null = null;
  private bg: GPUBindGroup | null = null;
  private count = 0;
  labels: Label[] = [];
  alpha = new Float32Array(1);
  widths: number[] = [];
  /** Declutter set of these labels (see declutter()); rebuilt after setLabels. */
  boxes: Declutter | null = null;
  constructor(private r: Renderer, private atlas: GlyphAtlas) {}

  setLabels(labels: Label[]) {
    this.labels = labels;
    this.boxes = null;
    const st = this.style ? textStyle(this.style) : null;
    if (st) {
      const font = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '500'} 30px "${st.font}", "Noto Sans", "DejaVu Sans", sans-serif`;
      this.atlas = atlasFor(this.r, { font, stroke: Math.max(0, st.strokeWidth * 2), join: (['miter', 'bevel', 'round', 'miter'] as CanvasLineJoin[])[st.corner] ?? 'round', glow: Math.max(2, st.outerSize) });
      this.bg = null;
    }
    let n = 0;
    for (const l of labels) n += [...l.text].length + (st?.box ? 1 : 0);
    const f = new Float32Array(Math.max(1, n) * GL);
    let k = 0;
    this.widths = [];
    const c4 = (c: number[]) => [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255];
    labels.forEach((l0, li) => {
      const l = st ? { ...l0, size: st.size, color: st.color, halo: st.stroke, letterSpacing: st.kerning / 10000 } : l0;
      const xyz = lonLatToXYZ(l.lon, l.lat, 1 + (l.height ?? 0.00002));
      const s = l.size / 30, sp = (l.letterSpacing ?? 0) * l.size;
      const chars = [...l.text];
      const total = chars.reduce((w, ch) => w + (this.atlas.glyph(ch).w - 8 - Math.ceil(this.atlas.spec.glow)) * s + sp, 0) - sp;
      this.widths.push(total);
      let x = (l.dx ?? 0) - (l.align === 'left' ? 0 : l.align === 'right' ? total : total / 2) - 4 * s;
      const y = (l.dy ?? 0) + (BASE - 4) * s * 0.62;
      const flags = st ? (st.flashing ? 1 : 0) + (st.gradient ? 2 : 0) : 0;
      const fx = st ? [st.gradWidth / 100, st.gradPos / 100, flags, Math.max(0.2, st.outerExp / 25)] : [0, 0, 0, 1];
      const glow = st?.outer ? c4(st.outerColor) : [0, 0, 0, 0];
      const color2 = st ? c4(st.color2) : c4(l.color);
      const gofs = st ? [-st.outerOffset[0] / ATLAS / s, -st.outerOffset[1] / ATLAS / s, 0, 0] : [0, 0, 0, 0];
      if (st?.box) {
        const px = st.boxPad[0], py = st.boxPad[1];
        f.set([xyz[0], xyz[1], xyz[2], li, 0, 0, 0, 0, x + 2 * s - px, y + 8 * s - py, total + 4 * s + px * 2, 30 * s + py * 2, ...c4(st.boxColor), 0, 0, 0, 0, ...c4(st.boxGradient ? st.boxColor2 : st.boxColor), 0, 0, 0, 0, 0, 0, 4 + (st.boxGradient ? 2 : 0), 1, 0, 0, 0, 0], k * GL);
        k++;
      }
      // Colours and effects are the same for every glyph of the label: written per glyph without new arrays.
      const tail = new Float32Array([...c4(l.color), ...c4(l.halo), ...color2, ...glow, ...fx, ...gofs]);
      for (const ch of chars) {
        const g = this.atlas.glyph(ch), o = k * GL;
        f[o] = xyz[0]; f[o + 1] = xyz[1]; f[o + 2] = xyz[2]; f[o + 3] = li;
        f[o + 4] = g.u / ATLAS; f[o + 5] = g.v / ATLAS; f[o + 6] = g.w / ATLAS; f[o + 7] = CELL_H / ATLAS;
        f[o + 8] = x; f[o + 9] = y; f[o + 10] = g.w * s; f[o + 11] = CELL_H * s;
        f.set(tail, o + 12);
        x += (g.w - 8 - Math.ceil(this.atlas.spec.glow)) * s + sp;
        k++;
      }
    });
    this.count = k;
    this.atlas.upload();
    const d = this.r.gpu.device;
    if (!this.gbuf || this.gbuf.size < f.byteLength) { this.gbuf?.destroy(); this.gbuf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else d.queue.writeBuffer(this.gbuf, 0, f);
    this.alpha = new Float32Array(Math.max(4, labels.length)).fill(1);
    if (!this.abuf || this.abuf.size < this.alpha.byteLength) { this.abuf?.destroy(); this.abuf = this.r.gpu.buffer(this.alpha, GPUBufferUsage.STORAGE); this.bg = null; }
    else d.queue.writeBuffer(this.abuf, 0, this.alpha);
  }

  flushAlpha() { if (this.abuf) this.r.gpu.device.queue.writeBuffer(this.abuf, 0, this.alpha); }

  draw(ctx: DrawContext) {
    if (!this.count || !this.gbuf || !this.abuf) return;
    if (!this.bg) this.bg = this.r.gpu.device.createBindGroup({ layout: this.r.layouts.text, entries: [
      { binding: 0, resource: { buffer: this.gbuf } }, { binding: 1, resource: { buffer: this.abuf } },
      { binding: 2, resource: this.atlas.tex.createView() }, { binding: 3, resource: this.r.gpu.samplers.linear }] });
    ctx.pass.setPipeline(this.r.pipes.text);
    ctx.pass.setBindGroup(1, this.bg);
    ctx.pass.draw(6, this.count);
  }
}

/** Screen-space declutter: greedy by priority; returns per-label target visibility. */
export function declutter(r: Renderer, ts: TextSet, spacingPx: number, filter?: (i: number) => boolean): Uint8Array {
  ts.boxes ??= new Declutter(ts.labels.map((l, i) => ({ lon: l.lon, lat: l.lat, w: ts.widths[i] ?? 40, h: l.size, priority: l.priority })));
  return ts.boxes.run(r, spacingPx, filter);
}

/** Greedy declutter of screen boxes anchored bottom-centre at lon/lat, highest priority first. */
export function declutterBoxes(r: Renderer, items: DeclutterItem[], spacingPx: number, filter?: (i: number) => boolean): Uint8Array {
  return new Declutter(items).run(r, spacingPx, filter);
}

export interface DeclutterItem { lon: number; lat: number; w: number; h: number; priority?: number; spacing?: number }
const CELL = 64, MARGIN = 256;
/**
 * Declutter of a fixed item set, run every frame: the world positions and the priority order are computed once, and
 * placed boxes are found through a screen grid, so a frame costs one projection per item and a few box tests.
 */
export class Declutter {
  private xyz: Float64Array; private w: Float64Array; private h: Float64Array; private sp: Float64Array;
  private order: Uint32Array;
  private vis: Uint8Array;
  private boxes = new Float64Array(256);
  private next = new Int32Array(64);
  private head = new Int32Array(0);
  constructor(items: readonly DeclutterItem[]) {
    const n = items.length;
    this.xyz = new Float64Array(n * 3); this.w = new Float64Array(n); this.h = new Float64Array(n); this.sp = new Float64Array(n);
    items.forEach((l, i) => {
      const p = lonLatToXYZ(l.lon, l.lat);
      this.xyz[i * 3] = p[0]; this.xyz[i * 3 + 1] = p[1]; this.xyz[i * 3 + 2] = p[2];
      this.w[i] = l.w; this.h[i] = l.h; this.sp[i] = l.spacing ?? NaN;
    });
    // Stable sort: equal priorities keep their item order.
    this.order = Uint32Array.from(items.map((_, i) => i).sort((a, b) => (items[b].priority ?? 0) - (items[a].priority ?? 0)));
    this.vis = new Uint8Array(n);
  }
  /** Per-item visibility for the current camera (the returned array is reused by the next run). */
  run(r: Renderer, spacingPx: number, filter?: (i: number) => boolean): Uint8Array {
    const vis = this.vis.fill(0), cam = r.camera, m = cam.viewProj, e = cam.eye, W = cam.width, H = cam.height, xyz = this.xyz;
    const cols = Math.ceil((W + 2 * MARGIN) / CELL), rows = Math.ceil((H + 2 * MARGIN) / CELL);
    if (this.head.length < cols * rows) this.head = new Int32Array(cols * rows);
    this.head.fill(-1, 0, cols * rows);
    const cx = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x + MARGIN) / CELL)));
    const cy = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y + MARGIN) / CELL)));
    let placed = 0;
    this.links = 0;
    for (const i of this.order) {
      if (filter && !filter(i)) continue;
      const px = xyz[i * 3], py = xyz[i * 3 + 1], pz = xyz[i * 3 + 2];
      const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (cw <= 0 || (e[0] - px) * px + (e[1] - py) * py + (e[2] - pz) * pz <= 0) continue; // behind the camera or the horizon
      const x = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / cw * 0.5 + 0.5) * W;
      const y = (1 - ((m[1] * px + m[5] * py + m[9] * pz + m[13]) / cw * 0.5 + 0.5)) * H;
      if (x < -50 || y < -20 || x > W + 50 || y > H + 20) continue;
      const w = this.w[i], h = this.h[i], sp = Number.isNaN(this.sp[i]) ? spacingPx : this.sp[i];
      const x0 = x - w / 2 - sp / 2, x1 = x + w / 2 + sp / 2, y0 = y - h - sp / 4, y1 = y + sp / 4;
      const c0 = cx(x0), c1 = cx(x1), r0 = cy(y0), r1 = cy(y1);
      if (this.hits(x0, y0, x1, y1, c0, c1, r0, r1, cols)) continue;
      if (this.boxes.length < (placed + 1) * 4) { const b = new Float64Array(this.boxes.length * 2); b.set(this.boxes); this.boxes = b; }
      const k = placed * 4;
      this.boxes[k] = x0; this.boxes[k + 1] = y0; this.boxes[k + 2] = x1; this.boxes[k + 3] = y1;
      for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) this.link(rr * cols + c, placed);
      placed++;
      vis[i] = 1;
    }
    return vis;
  }
  /** Linked lists of the boxes in each grid cell: `head` per cell, then (box, next) pairs. */
  private links = 0;
  private link(cell: number, box: number) {
    if (this.next.length < (this.links + 1) * 2) { const n = new Int32Array(this.next.length * 2); n.set(this.next); this.next = n; }
    this.next[this.links * 2] = box; this.next[this.links * 2 + 1] = this.head[cell];
    this.head[cell] = this.links++;
  }
  private hits(x0: number, y0: number, x1: number, y1: number, c0: number, c1: number, r0: number, r1: number, cols: number) {
    const b = this.boxes, nx = this.next;
    for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) {
      for (let l = this.head[rr * cols + c]; l >= 0; l = nx[l * 2 + 1]) {
        const k = nx[l * 2] * 4;
        if (x0 < b[k + 2] && x1 > b[k] && y0 < b[k + 3] && y1 > b[k + 1]) return true;
      }
    }
    return false;
  }
}

// ------------------------------------------------------------------------------------------- sprites
/** Colour sprite atlas (route shields): images or canvas drawings rasterized at 2× for crisp DPR scaling. */
const SPRITE_W = 2048, SPRITE_H = 1024;
export class SpriteAtlas {
  tex: GPUTexture;
  private canvas = new OffscreenCanvas(SPRITE_W, SPRITE_H);
  private g = this.canvas.getContext('2d')!;
  private slots = new Map<string, { u: number; v: number; w: number; h: number }>();
  private x = 0; private y = 0; private rowH = 0;
  private dirty = false;
  constructor(private r: Renderer) {
    this.tex = r.gpu.device.createTexture({ size: [SPRITE_W, SPRITE_H], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  }
  /** Reserves a w×h (CSS px) slot and lets `paint` draw into it at 2× scale; null when the atlas is full. */
  draw(key: string, w: number, h: number, paint: (g: OffscreenCanvasRenderingContext2D, scale: number) => void) {
    if (this.slots.has(key)) return this.slots.get(key)!;
    const W = Math.ceil(w * 2), H = Math.ceil(h * 2);
    if (this.x + W > SPRITE_W) { this.x = 0; this.y += this.rowH + 2; this.rowH = 0; }
    if (this.y + H > SPRITE_H) return null;
    this.g.save(); this.g.translate(this.x, this.y); paint(this.g, 2); this.g.restore();
    const slot = { u: this.x / SPRITE_W, v: this.y / SPRITE_H, w: W / SPRITE_W, h: H / SPRITE_H };
    this.slots.set(key, slot);
    this.x += W + 2; this.rowH = Math.max(this.rowH, H);
    this.dirty = true;
    return slot;
  }
  async add(key: string, url: string, w: number, h: number) {
    const img = await loadImage(url);
    return this.draw(key, w, h, (g, k) => g.drawImage(img, 0, 0, w * k, h * k));
  }
  /** Uploads pending drawings (call once after a batch of draw/add calls). */
  flush() {
    if (!this.dirty) return;
    this.r.gpu.device.queue.copyExternalImageToTexture({ source: this.canvas }, { texture: this.tex, premultipliedAlpha: false }, [SPRITE_W, SPRITE_H]);
    this.dirty = false;
  }
  get(key: string) { return this.slots.get(key); }
  /** Forgets every slot (the next draw calls repaint from the top-left). */
  reset() {
    this.slots.clear(); this.x = 0; this.y = 0; this.rowH = 0;
    this.g.clearRect(0, 0, SPRITE_W, SPRITE_H);
    this.dirty = true;
  }
}

export async function loadImage(url: string) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export interface SpriteSpec { lon: number; lat: number; key: string; w: number; h: number; dx?: number; dy?: number; alpha?: number }
export class SpriteSet {
  private buf: GPUBuffer | null = null;
  private bg: GPUBindGroup | null = null;
  private data = new Float32Array(0);
  count = 0;
  /** Additive sprites add their colour to the scene instead of covering it. */
  additive = false;
  constructor(private r: Renderer, private atlas: SpriteAtlas) {}
  setSprites(list: SpriteSpec[]) {
    const f = new Float32Array(Math.max(1, list.length) * 12);
    list.forEach((s, i) => {
      const slot = this.atlas.get(s.key);
      const p = lonLatToXYZ(s.lon, s.lat, 1.00002);
      f.set([p[0], p[1], p[2], slot ? s.alpha ?? 1 : 0, slot?.u ?? 0, slot?.v ?? 0, slot?.w ?? 0, slot?.h ?? 0, s.w, s.h, s.dx ?? 0, s.dy ?? 0], i * 12);
    });
    this.data = f; this.count = list.length;
    if (!this.buf || this.buf.size < f.byteLength) { this.buf?.destroy(); this.buf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else this.r.gpu.device.queue.writeBuffer(this.buf, 0, f);
  }
  setAlpha(i: number, a: number) { if (this.data[i * 12 + 6] > 0) this.data[i * 12 + 3] = a; }
  flushAlpha() { if (this.buf && this.count) this.r.gpu.device.queue.writeBuffer(this.buf, 0, this.data, 0, this.count * 12); }
  draw(ctx: DrawContext) {
    if (!this.count || !this.buf) return;
    if (!this.bg) this.bg = this.r.gpu.device.createBindGroup({ layout: this.r.layouts.sprites, entries: [{ binding: 0, resource: { buffer: this.buf } }, { binding: 1, resource: this.atlas.tex.createView() }, { binding: 2, resource: this.r.gpu.samplers.linear }] });
    ctx.pass.setPipeline(this.additive ? this.r.pipes.spritesAdd : this.r.pipes.sprites);
    ctx.pass.setBindGroup(1, this.bg);
    ctx.pass.draw(6, this.count);
  }
}
