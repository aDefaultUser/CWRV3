// MESO tab: 22 RAP 13 km mesoanalysis fields (decoder units, 16-bit quantisation, contoured heights)
// and the STP / SCP severe-parameter overlay with the instruction-recovered arithmetic and coupled texture coding.
// Frames: hourly valid times back to the loop start; source = the RAP 1-hour forecast of the previous cycle.
import type { DrawContext, Renderer } from '../render/renderer';
import { GridLayer, uploadGrid, type GridDisplay, type GridFrame } from '../layers/grid';
import { LineSet, TextSet, GlyphAtlas, declutter, type Polyline, type Label } from '../render/prims';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';
import { timeline } from '../app/timeline';
import { XPRODUCTS } from '../generated/products-expanded';
import { NOT_AVAILABLE } from '../layers/base';
import { severeFrameTime } from './meso-math';

export const MESO = XPRODUCTS.meso;
export const rapUrl = (cycleMs: number, fh = 1) => {
  const d = new Date(cycleMs), ymd = d.toISOString().slice(0, 10).replace(/-/g, ''), hh = String(d.getUTCHours()).padStart(2, '0');
  return `https://noaa-rap-pds.s3.amazonaws.com/rap.${ymd}/rap.t${hh}z.awp130pgrbf${String(fh).padStart(2, '0')}.grib2`;
};
/** Hourly valid times, newest first rule of, back to the loop start (at least one frame). */
export function rapValidTimes(nowMs: number, startMs: number): number[] {
  const out: number[] = [];
  for (let v = severeFrameTime(nowMs); out.length === 0 || v > startMs; v -= 3600e3) { out.push(v); if (out.length >= 24) break; }
  return out.reverse();
}

interface Pending { valid: number; key: string }

abstract class RapLayer extends GridLayer {
  readonly archive = 'window';
  protected loading = new Set<string>();
  protected keys = new Set<string>();
  protected cache = new Map<string, GridFrame & { extra?: unknown }>();
  protected abstract frameKey(valid: number): string;
  protected abstract load(p: Pending): Promise<GridFrame & { extra?: unknown }>;
  protected wanted(): Pending[] { return rapValidTimes(timeline.now(), timeline.loopStart).map((v) => ({ valid: v, key: this.frameKey(v) })); }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const want = this.wanted();
    const keys = new Set(want.map((w) => w.key));
    this.keys = keys;
    for (const [k, f] of this.cache) if (!keys.has(k)) { f.tex.destroy(); this.cache.delete(k); }
    this.publish();
    let errors = 0;
    // Newest first, two at a time.
    const todo = want.filter((w) => !this.cache.has(w.key) && !this.loading.has(w.key)).reverse();
    const run = async () => {
      for (let p = todo.shift(); p; p = todo.shift()) {
        this.loading.add(p.key);
        this.setStatus('loading', `${this.title}: ${this.cache.size}/${want.length} frames`);
        try { const f = await this.load(p); if (this.keys.has(p.key) && this.enabled()) { this.cache.set(p.key, f); this.publish(); } else f.tex.destroy(); }
        catch (e) { errors++; this.setStatus('error', `${this.title} ${new Date(p.valid).toISOString().slice(11, 16)}Z: ${(e as Error).message}`); }
        finally { this.loading.delete(p.key); }
      }
    };
    await Promise.all([run(), run()]);
    const ready = want.filter((w) => this.cache.has(w.key)).length;
    if (!errors) this.setStatus(ready ? 'ready' : 'loading', `${this.title}: ${ready}/${want.length} frames`);
    else if (!ready && timeline.mode === 'archive') this.setStatus('unavailable', NOT_AVAILABLE); // the RAP archive does not reach this time
  }
  protected publish() { this.frames = [...this.cache.values()].filter((f) => this.keys.has(f.key)).sort((a, b) => a.t - b.t); }
}

export class MesoLayer extends RapLayer {
  readonly id = 'meso';
  readonly title = 'Mesoanalysis';
  private contours: LineSet; private labels: TextSet;
  private contourKey = '';
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r); this.contours = new LineSet(r); this.labels = new TextSet(r, atlas); }
  product() { return MESO[settings.num('layerState.MesoanalysisProductIdx')] ?? MESO[0]; }
  enabled() { return settings.bool('layerState.MesoanalysisDataOn'); }
  protected frameKey(v: number) { return `${this.product().index}|${v}|${settings.bool('ext.settings.mesoCorrectedFormulas')}|${settings.num('settings.generalHeightContourInterval')}`; }
  protected async load(p: Pending) {
    const prod = this.product();
    const res = await pool.for(this.id).run('grid.meso', { url: rapUrl(p.valid - 3600e3), matches: prod.match, lo: prod.range[0], hi: prod.range[1], derivation: prod.derivation, render: prod.render, corrected: settings.bool('ext.settings.mesoCorrectedFormulas'), contourInterval: Math.max(1, settings.num('settings.generalHeightContourInterval')) });
    return { t: p.valid, key: p.key, tex: uploadGrid(this.r, res.nx, res.ny, res.data, this.id), proj: res.proj, bounds: res.bounds, extra: res.contours };
  }
  display(): GridDisplay {
    const p = this.product();
    const pal = settings.arr<string>('settings.mesoanalysisPalettes')[p.index] ?? 'M_CAPE';
    return { low: p.range[0], high: p.range[1], unit: p.unit, palette: pal, label: p.label, alpha: settings.num('settings.mesoanalysisFillAlpha') / 255, smoothing: settings.bool('settings.mesoanalysisFillSmoothing'), legend: settings.bool('settings.mesoanalysisFillLegend') && p.render !== 'contour', blend: settings.bool('layerState.RasterDataTemporalInterpolation') };
  }
  tick(t: number) {
    if (!this.enabled() || this.product().render !== 'contour') return;
    const { a } = this.current(t);
    const key = `${a?.key}|${settings.num('settings.generalContourWidth')}|${settings.num('settings.generalContourAlpha')}|${settings.arr('settings.generalContourColor')}|${settings.bool('settings.generalContourBorders')}`;
    if (key !== this.contourKey) {
      this.contourKey = key;
      const cc = settings.arr<number>('settings.generalContourColor'), bc = settings.arr<number>('settings.generalContourBorderColor');
      const al = Math.round(settings.num('settings.generalContourAlpha') * 255), w = settings.num('settings.generalContourWidth');
      this.contours.setStyles([{ color: [bc[0], bc[1], bc[2], settings.bool('settings.generalContourBorders') ? al : 0], width: w + 2.2 }, { color: [cc[0], cc[1], cc[2], Math.min(255, al + 60)], width: w }]);
      const iso = ((a as { extra?: { level: number; coords: number[] }[] } | null)?.extra ?? []);
      const lines: Polyline[] = [], labels: Label[] = [];
      for (const c of iso) {
        lines.push({ coords: c.coords, style: 0 }, { coords: c.coords, style: 1 });
        const n = c.coords.length / 2;
        for (let k = Math.floor(n / 2) % 30; k < n; k += 60) labels.push({ lon: c.coords[k * 2], lat: c.coords[k * 2 + 1], text: String(Math.round(c.level / 10)), size: 11, color: [230, 235, 255, 255], halo: [20, 30, 60, 220], priority: 1 });
      }
      this.contours.setLines(lines); this.labels.setLabels(labels);
    }
    const vis = declutter(this.r, this.labels, 100);
    for (let i = 0; i < vis.length; i++) this.labels.alpha[i] = vis[i];
    this.labels.flushAlpha();
  }
  draw(ctx: DrawContext) {
    if (!this.enabled()) return;
    if (this.product().render === 'contour') { if (!ctx.probe) { this.contours.draw(ctx); this.labels.draw(ctx); } return; }
    super.draw(ctx);
  }
  probeKind() { return this.enabled() && this.product().render !== 'contour' && this.frames.length ? this.id : null; }
}

export class SevereLayer extends RapLayer {
  readonly id = 'severeParam';
  readonly title = 'Severe parameter';
  enabled() { return settings.num('layerState.SevereParameterOn') > 0; }
  private which() { return settings.num('layerState.SevereParameterOn') === 2 ? 'scp' : 'stp'; }
  protected frameKey(v: number) { return `${v}|${settings.bool('ext.settings.mesoCorrectedFormulas')}`; }
  private pair = new Map<string, { stp: GPUTexture; scp: GPUTexture }>();
  protected async load(p: Pending) {
    const res = await pool.for(this.id).run('grid.severe', { url: rapUrl(p.valid - 3600e3), corrected: settings.bool('ext.settings.mesoCorrectedFormulas') });
    const stp = uploadGrid(this.r, res.nx, res.ny, res.stpTex, this.id), scp = uploadGrid(this.r, res.nx, res.ny, res.scpTex, this.id);
    this.pair.set(p.key, { stp, scp });
    // The frame's texture is chosen at draw time (STP or SCP); both are kept.
    return { t: p.valid, key: p.key, tex: stp, proj: res.proj, bounds: res.bounds, extra: scp };
  }
  protected publish() {
    const w = this.which();
    this.frames = [...this.cache.values()].filter((f) => this.keys.has(f.key)).map((f) => ({ ...f, tex: w === 'scp' ? (f.extra as GPUTexture) : this.pair.get(f.key)?.stp ?? f.tex })).sort((a, b) => a.t - b.t);
  }
  display(): GridDisplay {
    const scp = this.which() === 'scp';
    return { low: 0, high: scp ? 50 : 10, unit: '', palette: settings.str(scp ? 'settings.scpPalette' : 'settings.stpPalette'), label: scp ? 'SCP' : 'STP', alpha: settings.num('settings.mesoanalysisFillAlpha') / 255, smoothing: settings.bool('settings.mesoanalysisFillSmoothing'), legend: settings.bool('settings.mesoanalysisFillLegend'), blend: settings.bool('layerState.RasterDataTemporalInterpolation') };
  }
  draw(ctx: DrawContext) { this.publish(); super.draw(ctx); }
}

/** Misc → 2 m temperature / dew point / MSLP difference over N hours. */
export class DiffLayer extends RapLayer {
  readonly id = 'miscDiff';
  readonly title = 'Difference';
  enabled() { return settings.bool('layerState.Misc2MTDifferenceOn'); }
  private idx() { return settings.num('layerState.Misc2MTDifferenceIdx'); }
  private range(): [number, number] {
    // Range from the palette: the "Difference" palette spans −30..30 (°F or mb).
    return [-30, 30];
  }
  protected frameKey(v: number) { return `${this.idx()}|${settings.num('layerState.Misc2MTDifferenceHours')}|${v}`; }
  protected async load(p: Pending) {
    const h = Math.min(24, Math.max(1, settings.num('layerState.Misc2MTDifferenceHours')));
    const match = XPRODUCTS.misc.diffFields[this.idx()].split(':').slice(0, 2).join(':');
    const [lo, hi] = this.range();
    const res = await pool.for(this.id).run('grid.diff', { urlNow: rapUrl(p.valid - 3600e3), urlThen: rapUrl(p.valid - 3600e3 - h * 3600e3), match, lo, hi });
    return { t: p.valid, key: p.key, tex: uploadGrid(this.r, res.nx, res.ny, res.data, this.id), proj: res.proj, bounds: res.bounds };
  }
  display(): GridDisplay {
    const [low, high] = this.range();
    return { low, high, unit: XPRODUCTS.misc.diffUnits[this.idx()], palette: settings.str('settings.misc2mtDiffPalette'), label: ['Temperature Difference', 'Dew Pt Difference', 'MSLP Difference'][this.idx()], alpha: settings.num('settings.misc2mtDiffAlpha') / 255, smoothing: settings.bool('settings.misc2mtDiffSmoothing'), legend: settings.bool('settings.misc2mtDiffLegend'), blend: settings.bool('layerState.RasterDataTemporalInterpolation') };
  }
}
