// Filled polygons on the globe: pre-triangulated lon/lat triangles (worker, earcut + subdivision) with the
// polygon-style features of TFrmPolygonStyle: animated colour keyframe, additive blending, pattern layer
// (horizontal, vertical, wave, bubbles, square bubbles, hatch, dots; screen- or world-anchored, moving) and an
// optional user texture layer (blend / add / subtract / blend-add).
import type { Renderer, DrawContext } from './renderer';
import { lonLatToXYZ } from './camera';
import type { Color } from './prims';

export interface FillStyle {
  color: Color; color2?: Color; interval?: number; nonLinear?: boolean; additive?: boolean;
  /** 0 none, 1 horiz, 2 vert, 3 wave, 4 bubbles, 5 square bubbles, 6 hatch, 7 dots (legacy 1–3 map via styles.ts). */
  pattern?: number; patternColor?: Color; spacing?: number; patternSpeed?: number; patternFixed?: boolean; angle?: number;
  texture?: string; textureIntensity?: number; textureSpeed?: number; textureSize?: number; textureMode?: number;
  visible?: boolean;
}
export interface PolyFill { tris: ArrayLike<number>; style: number; height?: number }

const TEX = 256, LAYERS = 8;
/** Shared 256×256×8 texture array for user fill textures (loaded from object URLs or paths). */
class TextureLayers {
  tex: GPUTexture;
  private slots = new Map<string, number>();
  private pending = new Set<string>();
  onLoad: () => void = () => {};
  constructor(private r: Renderer) {
    this.tex = r.gpu.device.createTexture({ size: [TEX, TEX, LAYERS], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  }
  layer(url: string): number {
    const s = this.slots.get(url);
    if (s !== undefined) return s;
    if (!this.pending.has(url) && this.slots.size + this.pending.size < LAYERS) {
      this.pending.add(url);
      fetch(url).then((r) => r.blob()).then((b) => createImageBitmap(b, { resizeWidth: TEX, resizeHeight: TEX })).then((bmp) => {
        const i = this.slots.size;
        this.r.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: this.tex, origin: [0, 0, i] }, [TEX, TEX, 1]);
        this.slots.set(url, i); this.pending.delete(url); this.onLoad();
      }, () => this.pending.delete(url));
    }
    return -1;
  }
}
let shared: TextureLayers | null = null;

export class PolySet {
  private vbuf: GPUBuffer | null = null;
  private sbuf: GPUBuffer | null = null;
  private bg: GPUBindGroup | null = null;
  private styles: FillStyle[] = [];
  count = 0;
  constructor(private r: Renderer) {}

  setStyles(styles: FillStyle[]) {
    this.styles = styles;
    if (styles.some((s) => s.texture)) { shared ??= new TextureLayers(this.r); shared.onLoad = () => this.setStyles(this.styles); }
    const f = new Float32Array(Math.max(1, styles.length) * 28);
    styles.forEach((s, i) => {
      const c2 = s.color2 ?? s.color, pc = s.patternColor ?? s.color;
      // Legacy patterns (seed styles before styles.ts conversion): 1 hatch, 2 cross, 3 dots.
      const layer = s.texture && shared ? shared.layer(s.texture) : -1;
      f.set([...s.color.map((x) => x / 255), ...c2.map((x) => x / 255), ...pc.map((x) => x / 255),
        s.pattern ?? 0, s.spacing ?? 8, s.patternSpeed ?? 0, s.visible === false ? 0 : 1,
        s.interval ?? 0, s.nonLinear ? 1 : 0, s.patternFixed ? 1 : 0, s.additive ? 1 : 0,
        layer, s.textureIntensity ?? 1, s.textureSpeed ?? 0, s.textureSize ?? 64,
        s.textureMode ?? 0, 0, 0, 0], i * 28);
    });
    if (!this.sbuf || this.sbuf.size < f.byteLength) { this.sbuf?.destroy(); this.sbuf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else this.r.gpu.device.queue.writeBuffer(this.sbuf, 0, f);
  }

  setPolys(polys: PolyFill[]) {
    let n = 0;
    for (const p of polys) n += Math.floor(p.tris.length / 2);
    const f = new Float32Array(Math.max(3, n) * 4);
    let k = 0;
    for (const p of polys) {
      const rr = 1 + (p.height ?? 0.000002);
      for (let i = 0; i + 1 < p.tris.length; i += 2) {
        const xyz = lonLatToXYZ(p.tris[i], p.tris[i + 1], rr);
        f[k++] = xyz[0]; f[k++] = xyz[1]; f[k++] = xyz[2]; f[k++] = p.style;
      }
    }
    this.count = n - (n % 3);
    if (!this.vbuf || this.vbuf.size < f.byteLength) { this.vbuf?.destroy(); this.vbuf = this.r.gpu.buffer(f, GPUBufferUsage.STORAGE); this.bg = null; }
    else this.r.gpu.device.queue.writeBuffer(this.vbuf, 0, f);
  }

  draw(ctx: DrawContext) {
    if (!this.count || !this.vbuf || !this.sbuf || ctx.probe) return;
    shared ??= new TextureLayers(this.r);
    if (!this.bg) this.bg = this.r.gpu.device.createBindGroup({ layout: this.r.layouts.polys, entries: [{ binding: 0, resource: { buffer: this.vbuf } }, { binding: 1, resource: { buffer: this.sbuf } }, { binding: 2, resource: shared.tex.createView({ dimension: '2d-array' }) }, { binding: 3, resource: this.r.gpu.samplers.repeat }] });
    ctx.pass.setPipeline(this.r.pipes.polys);
    ctx.pass.setBindGroup(1, this.bg);
    ctx.pass.draw(this.count);
  }

  destroy() { this.vbuf?.destroy(); this.sbuf?.destroy(); this.vbuf = this.sbuf = null; this.bg = null; this.count = 0; }
}
