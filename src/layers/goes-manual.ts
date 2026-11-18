// GOES-R Manual Loader: user-chosen ABI L2 CMI NetCDF files decoded in the worker and drawn on
// the fixed grid with the band palette. Files must share band, dimensions and fixed-grid parameters. Frames play on their own
// loop, or follow the main timeline when embedded (the newest file must then lie inside the main loop span).
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, type LegendSpec } from './base';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';
import { RasterDraw, Lut, geosProj, type ProjParams } from '../render/raster';
import { getPalette } from '../palettes/library';
import { bandRange } from './satellite';

interface FixedGrid { h: number; req: number; rpol: number; lon0: number; x0: number; dx: number; y0: number; dy: number }
interface ManualFrame { name: string; t: number; tex: GPUTexture; proj: ProjParams; grid: FixedGrid; band: number; lon0: number; width: number; height: number; platform: string }

/** Fixed-grid parameters that differ between two files (sub-satellite longitude, ellipsoid, height, scan angles). */
export function fixedGridMismatch(a: FixedGrid, b: FixedGrid): string[] {
  const out: string[] = [];
  for (const k of ['h', 'req', 'rpol', 'lon0', 'x0', 'dx', 'y0', 'dy'] as const) {
    const tol = Math.max(1e-9, Math.abs(a[k]) * 1e-6);
    if (!(Math.abs(a[k] - b[k]) <= tol)) out.push(`${k} ${b[k]} ≠ ${a[k]}`);
  }
  return out;
}

export class GoesManualLayer extends MapLayer {
  readonly id = 'goesManual';
  readonly archive = 'static';
  readonly title = 'GOES-R manual files';
  frames: ManualFrame[] = [];
  frame = 0;
  loop = true;
  embed = false;
  showTime = true;
  private draw_: RasterDraw;
  private luts = new Map<string, Lut>();
  private lastStep = 0;
  constructor(r: Renderer) { super(r); this.draw_ = new RasterDraw(r); }
  enabled() { return this.frames.length > 0; }
  band() { return this.frames[0]?.band ?? 1; }
  palette() { return settings.arr<string>('settings.goesBandPals')[this.band() - 1] ?? `GOESRBand${this.band()}`; }

  /** Decodes files and appends them; throws with a readable message when they do not match the loaded set. */
  async load(files: File[]) {
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const sum = await pool.for(this.id).run('goes.examine', { bytes: bytes.slice() });
      if (sum.variable !== 'CMI') throw new Error(`${f.name}: only ABI L2 Cloud and Moisture Imagery (CMI) files can be displayed (found ${sum.variable})`);
      if (sum.projection !== 'GOES Imager') throw new Error(`${f.name}: ${sum.projection} projection files cannot be displayed (fixed-grid files only)`);
      const first = this.frames[0];
      if (first && (sum.band !== first.band || sum.width !== first.width || sum.height !== first.height)) {
        throw new Error(`${f.name}: every file must have the same band, projection and dimensions as the files already loaded (band ${first.band}, ${first.width}×${first.height})`);
      }
      const [min, max] = bandRange(sum.band);
      const k = Math.max(1, Math.round(Math.max(sum.width, sum.height) / 5000));
      const res = await pool.for(this.id).run('goes', { bytes, factor: k, min, max });
      // Frames blend in one projection, so the fixed grid itself (not only band and size) must match.
      const diff = first ? fixedGridMismatch(first.grid, res.proj) : [];
      if (diff.length) throw new Error(`${f.name}: fixed grid differs from the files already loaded (${diff.join(', ')}); clear the loaded files to switch satellite or sector`);
      const tex = this.r.gpu.texture2D(res.width, res.height, 'r8unorm', res.codes, 1, this.id);
      this.frames.push({ name: f.name, t: res.startMs, tex, proj: geosProj(res.proj, res.width, res.height), grid: res.proj, band: res.band, lon0: res.proj.lon0, width: sum.width, height: sum.height, platform: res.platform });
    }
    this.frames.sort((a, b) => a.t - b.t);
    this.frame = this.frames.length - 1;
  }
  clear() { for (const f of this.frames) f.tex.destroy(); this.frames = []; this.frame = 0; this.embed = false; this.draw_.invalidate(); }

  /** Embedding needs the newest file inside the main loop; returns an explanation when it is not. */
  setEmbed(on: boolean): string | null {
    if (!on) { this.embed = false; return null; }
    const newest = this.frames[this.frames.length - 1];
    if (!newest) return 'Load GOES-R files first.';
    if (newest.t < timeline.loopStart || newest.t > timeline.loopEnd) {
      const f = (t: number) => new Date(t).toLocaleString();
      return `The newest loaded file (${f(newest.t)}) is outside the main timeline (${f(timeline.loopStart)} – ${f(timeline.loopEnd)}). Load files from within the loop period, or lengthen the loop, then try again.`;
    }
    this.embed = true;
    return null;
  }

  tick(_t: number, now: number) {
    if (!this.frames.length || this.embed || !this.loop || this.frames.length < 2) return;
    if (now - this.lastStep >= settings.num('settings.generalLoopSpeedFrameTime')) { this.lastStep = now; this.frame = (this.frame + 1) % this.frames.length; }
  }
  private current(): ManualFrame | null {
    if (!this.frames.length) return null;
    if (this.embed) return bracket(this.frames.map((f) => ({ t: f.t, f })), timeline.t, false, 6 * 3600e3).a?.f ?? null;
    return this.frames[Math.min(this.frame, this.frames.length - 1)];
  }
  mapLabel(): string | null {
    const f = this.current();
    if (!f || !this.showTime) return null;
    return `${f.platform || 'GOES-R'} ABI band ${f.band}: ${new Date(f.t).toLocaleString()}`;
  }
  legends(): LegendSpec[] {
    if (!this.frames.length || !settings.bool('settings.goesLegend')) return [];
    const b = this.band(), [min, max] = bandRange(b), name = this.palette();
    return [{ id: this.id, palette: getPalette(name), low: min, high: max, unit: b <= 6 ? '' : '°C', lut: this.lut(name) }];
  }
  private lut(name: string): Lut {
    let l = this.luts.get(name);
    if (!l) { const [min, max] = bandRange(this.band()); l = new Lut(this.r, getPalette(name), { low: min - (max - min) / 254, high: max, raster: false }); this.luts.set(name, l); }
    return l;
  }
  draw(ctx: DrawContext) {
    const f = this.current();
    if (!f) return;
    const b: [number, number, number, number] = [-81, f.lon0 - 81, 81, f.lon0 + 81];
    this.draw_.draw(ctx, { mode: 0, w: 0, alpha: settings.num('settings.goesManualAlpha') / 255, smoothing: true, bounds: b, proj: f.proj, luts: [this.lut(this.palette())], data: [[f.tex, f.tex]] }, 2);
  }
}
