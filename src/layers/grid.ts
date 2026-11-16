// Shared gridded-product layer (MRMS, MESO, STP/SCP, NDFD, Winter, temperature difference, model fills):
// time frames of GPU textures in their native projection, temporal blending, palette lookup over a value range,
// legend and probe. Subclasses supply frames and the display description.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, type LegendSpec } from './base';
import { bracket, timeline } from '../app/timeline';
import { RasterDraw, Lut, type ProjParams } from '../render/raster';
import { getPalette } from '../palettes/library';
import { fmtProbe } from './nexrad';
import { toHalf } from '../render/half';

export interface GridFrame { t: number; tex: GPUTexture; proj: ProjParams; bounds: [number, number, number, number]; key: string; validMs?: number; info?: string }
export interface GridDisplay { low: number; high: number; unit: string; palette: string; label: string; alpha: number; smoothing: boolean; legend: boolean; blend: boolean }

/** Uploads worker output: Uint16Array = half floats (r16float), Float32Array = exact texels (r32float). */
export function uploadGrid(r: Renderer, nx: number, ny: number, data: Uint16Array | Float32Array): GPUTexture {
  if (data instanceof Float32Array) return r.gpu.float32Filterable ? r.gpu.texture2D(nx, ny, "r32float", data, 4) : r.gpu.texture2D(nx, ny, "r16float", toHalf(data), 2);
  return r.gpu.texture2D(nx, ny, 'r16float', data, 2);
}
export abstract class GridLayer extends MapLayer {
  frames: GridFrame[] = [];
  protected rd: RasterDraw;
  private luts = new Map<string, Lut>();
  constructor(r: Renderer) { super(r); this.rd = new RasterDraw(r); }
  abstract display(): GridDisplay;
  invalidate() { this.rd.invalidate(); }

  protected lut(name: string, low: number, high: number): Lut {
    const key = `${name}|${low}|${high}`;
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low, high, reserve: false, showRF: false, topCode: 255 }); this.luts.set(key, l); if (this.luts.size > 16) { const [k, v] = this.luts.entries().next().value!; v.destroy(); this.luts.delete(k); } }
    return l;
  }

  clearFrames() { for (const f of this.frames) f.tex.destroy(); this.frames = []; this.rd.invalidate(); }
  setFrames(next: GridFrame[]) {
    const keep = new Set(next.map((f) => f.tex));
    for (const f of this.frames) if (!keep.has(f.tex)) f.tex.destroy();
    this.frames = next.sort((a, b) => a.t - b.t);
  }

  /** Frame shown at time t (subclasses may override, e.g. NDFD slider positions). */
  current(t: number): { a: GridFrame | null; b: GridFrame | null; w: number } {
    const d = this.display();
    if (this.frames.length === 1) return { a: this.frames[0], b: null, w: 0 };
    const r = bracket(this.frames, t, d.blend, 6 * 3600e3);
    return { a: r.a ?? this.frames[this.frames.length - 1] ?? null, b: r.b, w: r.w };
  }

  draw(ctx: DrawContext) {
    if (!this.enabled()) return;
    const { a, b, w } = this.current(timeline.t);
    if (!a) return;
    const d = this.display();
    const bt = b && b.proj.nx === a.proj.nx && b.proj.ny === a.proj.ny ? b : null;
    this.rd.draw(ctx, { mode: 0, w: bt ? w : 0, alpha: d.alpha, smoothing: d.smoothing, bounds: a.bounds, proj: a.proj, luts: [this.lut(d.palette, d.low, d.high)], data: [[a.tex, bt?.tex ?? a.tex]], negMissing: true }, 5);
  }

  legends(): LegendSpec[] {
    const d = this.display();
    if (!d.legend || !this.frames.length) return [];
    return [{ id: this.id, palette: getPalette(d.palette), low: d.low, high: d.high, unit: d.unit, lut: this.lut(d.palette, d.low, d.high) }];
  }
  probeKind() { return this.enabled() && this.frames.length ? this.id : null; }
  probeText(x: number) {
    const d = this.display();
    const v = d.low + (d.high - d.low) * x;
    const bound = x <= 0.00001 ? '≤' : x >= 0.99999 ? '≥' : '';
    return `${d.label}: ${bound}${fmtProbe(v)} ${d.unit}`.trim();
  }
}
