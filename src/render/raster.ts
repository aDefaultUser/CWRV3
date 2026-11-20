// Gridded raster drawing (MRMS mosaic, GOES ABI, HRRR fills) with data-space temporal interpolation and a
// palette lookup, plus the polar NEXRAD sweep drawing.
import type { Renderer, DrawContext } from './renderer';
import { bakeLut, type BakeOptions, type Palette } from './palette';
import { padSweep } from '../radar/sweep-pad';
import { toHalf } from './gpu';
import { perfMark } from '../perf/meter';

export interface ProjParams { kind: 0 | 1 | 2 | 3 | 4; nx: number; ny: number; flip?: boolean; a: number[]; b: number[]; c?: number[] }

export function latLonProj(la1: number, lo1: number, la2: number, lo2: number, nx: number, ny: number): ProjParams {
  return { kind: 0, nx, ny, a: [la1, lo1, la2, lo2], b: [0, 0, 0, 0] };
}

export { gridProj } from '../gis/gridproj';

export function lambertProj(g: { nx: number; ny: number; la1: number; lo1: number; lad: number; lov: number; dx: number; dy: number; latin1: number; latin2: number; radius: number }): ProjParams {
  const rad = Math.PI / 180;
  const p1 = g.latin1 * rad, p2 = g.latin2 * rad;
  const n = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  const FR = (g.radius * Math.cos(p1) * Math.tan(Math.PI / 4 + p1 / 2) ** n) / n;
  const rho = (lat: number) => FR / Math.tan(Math.PI / 4 + (lat * rad) / 2) ** n;
  const rho0 = rho(g.lad);
  let dl = (g.lo1 > 180 ? g.lo1 - 360 : g.lo1) - (g.lov > 180 ? g.lov - 360 : g.lov);
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  const th = n * dl * rad, r1 = rho(g.la1);
  return { kind: 2, nx: g.nx, ny: g.ny, a: [n, FR, rho0, g.lov > 180 ? g.lov - 360 : g.lov], b: [r1 * Math.sin(th), rho0 - r1 * Math.cos(th), g.dx, g.dy] };
}

export function geosProj(p: { h: number; req: number; rpol: number; lon0: number; x0: number; dx: number; y0: number; dy: number }, nx: number, ny: number): ProjParams {
  return { kind: 1, nx, ny, a: [p.h, p.req, p.rpol, p.lon0], b: [p.x0, p.dx, p.y0, p.dy] };
}

/** A baked palette lookup texture (1024 × frames). */
export class Lut {
  tex: GPUTexture; rows: number;
  constructor(r: Renderer, p: Palette, o: BakeOptions) {
    const data = bakeLut(p, o);
    this.rows = p.frames.length;
    this.tex = r.gpu.texture2D(1024, this.rows, 'rgba8unorm', data, 4, 'palette LUTs');
    this.data = data;
  }
  data: Uint8Array;
  destroy() { this.tex.destroy(); }
}

export interface RasterDrawParams {
  mode: 0 | 1 | 2 | 3 | 4; w: number; alpha: number; smoothing: boolean;
  /** Missing values are negative and 0 is a valid value (grids quantised over a range). */
  negMissing?: boolean;
  bounds: [number, number, number, number]; // lat0, lon0, lat1, lon1
  proj: ProjParams; aux?: ProjParams;
  ptype?: { gradient: number; prob: boolean; sleet: boolean };
  luts: (Lut | null)[]; // up to 4
  data: [GPUTexture | null, GPUTexture | null][]; // up to 3 channels × (A, B)
  auxTex?: GPUTexture | null;
  /** Alternative pipeline on the raster layout (user recipes); not drawn in the probe pass. */
  pipeline?: GPURenderPipeline;
}

function writeProj(f: Float32Array, o: number, p: ProjParams) {
  f.set([p.kind, p.nx, p.ny, p.flip ? 1 : 0], o);
  f.set(p.a, o + 4); f.set(p.b, o + 8); f.set(p.c ?? [0, 0, 0, 0], o + 12);
}

/** Per-layer raster drawing state: a uniform buffer and a cached bind group per texture set. */
export class RasterDraw {
  private ubuf: GPUBuffer;
  private cache = new Map<string, GPUBindGroup>();
  private ids = new WeakMap<object, number>();
  private seq = 0;
  constructor(private r: Renderer) { this.ubuf = r.gpu.device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); }
  private idOf(o: object | null | undefined) { if (!o) return 0; let i = this.ids.get(o); if (!i) { i = ++this.seq; this.ids.set(o, i); } return i; }
  invalidate() { this.cache.clear(); }

  draw(ctx: DrawContext, p: RasterDrawParams, probeKind = 1) {
    if (ctx.probe && p.pipeline) return;
    const g = this.r.gpu, d = g.device;
    const u = new Float32Array(64);
    u.set([p.mode, p.w, p.alpha, p.smoothing ? 1 : 0], 0);
    u.set([p.luts[0]?.rows ?? 1, p.ptype?.gradient ?? 15, p.ptype?.prob ? 1 : 0, p.ptype?.sleet ? 1 : 0], 4);
    const [gx, gy] = this.r.rasterMesh;
    u.set([p.negMissing ? 1 : 0, gx, gy, 0], 8);
    u.set(p.bounds, 12);
    u.set([0, 1, 0, probeKind], 16);
    writeProj(u, 20, p.proj);
    writeProj(u, 36, p.aux ?? { kind: 0, nx: 1, ny: 1, a: [0, 0, -1, 1], b: [0, 0, 0, 0] });
    d.queue.writeBuffer(this.ubuf, 0, u);
    const tex = [p.data[0]?.[0], p.data[0]?.[1], p.data[1]?.[0], p.data[1]?.[1], p.data[2]?.[0], p.data[2]?.[1]];
    const luts = [0, 1, 2, 3].map((i) => p.luts[i]?.tex ?? p.luts[0]?.tex ?? null);
    const key = [...tex, ...luts, p.auxTex].map((t) => this.idOf(t ?? null)).join(',') + (p.smoothing ? 'L' : 'N');
    let bg = this.cache.get(key);
    if (!bg) {
      perfMark('bindgroup raster');
      const view = (t: GPUTexture | null | undefined) => (t ?? g.dummy2D).createView();
      bg = d.createBindGroup({ layout: this.r.layouts.raster, entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        ...tex.map((t, i) => ({ binding: 1 + i, resource: view(t ?? tex[i & ~1] ?? null) })),
        ...luts.map((t, i) => ({ binding: 7 + i, resource: view(t) })),
        { binding: 11, resource: view(p.auxTex) },
        { binding: 12, resource: p.smoothing ? g.samplers.linear : g.samplers.nearest },
        { binding: 13, resource: g.samplers.lut },
      ] });
      if (this.cache.size > 64) this.cache.clear();
      this.cache.set(key, bg);
    }
    ctx.pass.setPipeline(ctx.probe ? this.r.probePipes.raster : p.pipeline ?? this.r.pipes.raster);
    ctx.pass.setBindGroup(1, bg);
    ctx.pass.draw(gx * gy * 6);
  }
}

// ------------------------------------------------------------------------------------------- polar radar
export interface SweepTex { tex: GPUTexture; firstKm: number; gateKm: number; gates: number; rows: number; az0: number; spacing: number; radials: number; maxRangeKm: number }

/** Uploads a sweep as rows = radials + 2 padding rows (wrap for complete sweeps, clamp otherwise). 16-bit sweeps use
 * r32float holding word/65535 (exact); `upload` is the pre-padded image built in the worker when available. */
export function uploadSweep(r: Renderer, s: { radials: number; gates: number; firstKm: number; gateKm: number; azimuths: Float32Array; half: boolean; complete: boolean; codes: Uint8Array | Uint16Array; wordSize: 8 | 16; upload?: Uint8Array | Float32Array }, owner?: string): SweepTex {
  const rows = s.radials + 2, n = s.gates;
  const img = s.upload ?? padSweep(s.codes, s.radials, n, s.complete, s.wordSize);
  let tex: GPUTexture;
  if (s.wordSize === 8) tex = r.gpu.texture2D(n, rows, 'r8unorm', img, 1, owner);
  else if (r.gpu.float32Filterable) tex = r.gpu.texture2D(n, rows, 'r32float', img, 4, owner);
  else tex = r.gpu.texture2D(n, rows, 'r16float', toHalf(img as Float32Array), 2, owner); // fallback: ~11-bit precision
  // Mean azimuth spacing over the sweep (robust to small irregularities).
  let span = s.azimuths[s.radials - 1] - s.azimuths[0];
  if (span < 0) span += 360;
  const spacing = s.radials > 1 ? span / (s.radials - 1) : s.half ? 0.5 : 1;
  const maxRangeKm = s.firstKm + s.gates * s.gateKm;
  return { tex, firstKm: s.firstKm, gateKm: s.gateKm, gates: n, rows, az0: s.azimuths[0], spacing: spacing > 0.2 && spacing < 1.6 ? spacing : s.half ? 0.5 : 1, radials: s.radials, maxRangeKm };
}

export interface RadarDrawParams {
  site: { lon: number; lat: number; heightKm: number }; elevation: number;
  a: SweepTex; b?: SweepTex | null; w: number; wipe: number; progress: number;
  alpha: number; smoothing: boolean; tilt3D: boolean; exaggeration: number; shadow: boolean; azOffset: number; lut: Lut;
  /** Precipitation typing of reflectivity: `lut` is the rain palette, the others share its value range. */
  ptype?: { tex: GPUTexture; proj: ProjParams; snow: Lut; fr: Lut; ip: Lut; gradient: number; prob: boolean; sleet: boolean } | null;
  /** Live-composite update flash strength (0..1). */
  flash?: number;
  /** Beam fade trail width behind the update/live front in degrees (0 = off). */
  trailDeg?: number;
}

export class RadarDraw {
  private ubuf: GPUBuffer;
  private cache = new Map<string, GPUBindGroup>();
  private ids = new WeakMap<object, number>(); private seq = 0;
  constructor(private r: Renderer) { this.ubuf = r.gpu.device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); }
  private idOf(o: object | null | undefined) { if (!o) return 0; let i = this.ids.get(o); if (!i) { i = ++this.seq; this.ids.set(o, i); } return i; }
  invalidate() { this.cache.clear(); }

  draw(ctx: DrawContext, p: RadarDrawParams) {
    const g = this.r.gpu, d = g.device;
    const u = new Float32Array(52);
    const pt = p.ptype ?? null;
    const b = p.b ?? null;
    const maxR = Math.max(p.a.maxRangeKm, b?.maxRangeKm ?? 0) * Math.cos((p.elevation * Math.PI) / 180);
    u.set([p.site.lon, p.site.lat, p.site.heightKm, p.elevation], 0);
    u.set([p.a.firstKm, p.a.gateKm, p.a.gates, p.a.rows], 4);
    u.set([p.a.az0, p.a.spacing, p.a.radials, maxR], 8);
    u.set([p.alpha, p.smoothing ? 1 : 0, p.tilt3D ? 1 : 0, p.exaggeration], 12);
    u.set([p.w, p.wipe, p.progress, p.shadow ? 1 : 0], 16);
    u.set([p.lut.rows, p.azOffset, p.flash ?? 0, p.trailDeg ?? 0], 20);
    if (b) { u.set([b.firstKm, b.gateKm, b.gates, b.rows], 24); u.set([b.az0, b.spacing, b.radials, 1], 28); }
    if (pt) { u.set([1, pt.gradient, pt.prob ? 1 : 0, pt.sleet ? 1 : 0], 32); writeProj(u, 36, pt.proj); }
    d.queue.writeBuffer(this.ubuf, 0, u);
    const key = `${this.idOf(p.a.tex)},${this.idOf(b?.tex)},${this.idOf(p.lut.tex)},${p.smoothing},${this.idOf(pt?.tex)},${this.idOf(pt?.snow.tex)},${this.idOf(pt?.fr.tex)},${this.idOf(pt?.ip.tex)}`;
    let bg = this.cache.get(key);
    if (!bg) {
      perfMark('bindgroup radar');
      bg = d.createBindGroup({ layout: this.r.layouts.radar, entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: p.a.tex.createView() }, { binding: 2, resource: (b?.tex ?? p.a.tex).createView() },
        { binding: 3, resource: p.lut.tex.createView() },
        { binding: 4, resource: p.smoothing ? g.samplers.linear : g.samplers.nearest }, { binding: 5, resource: g.samplers.lut },
        // Unused p-type slots are bound to the rain palette texture (never sampled when typing is off).
        { binding: 6, resource: (pt?.tex ?? p.lut.tex).createView() }, { binding: 7, resource: (pt?.snow.tex ?? p.lut.tex).createView() },
        { binding: 8, resource: (pt?.fr.tex ?? p.lut.tex).createView() }, { binding: 9, resource: (pt?.ip.tex ?? p.lut.tex).createView() }] });
      if (this.cache.size > 64) this.cache.clear();
      this.cache.set(key, bg);
    }
    ctx.pass.setPipeline(ctx.probe ? this.r.probePipes.radar : this.r.pipes.radar);
    ctx.pass.setBindGroup(1, bg);
    ctx.pass.draw(96 * 360 * 6);
  }
}
