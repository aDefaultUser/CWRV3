// MRMS tab: 50 products from the public NOAA MRMS bucket, per-product index refresh, newest-first
// back-fill to the loop start, the vendor display-range table (corrected mode optional), precipitation-typed
// reflectivity for products 0–2 and the "Wrap timeline to MRMS loop" rule.
import type { DrawContext, Renderer } from '../render/renderer';
import { GridLayer, uploadGrid, type GridDisplay, type GridFrame } from '../layers/grid';
import { FrameStore } from '../layers/frames';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { listS3 } from '../data/net';
import { pool } from '../workers/pool';
import { XPRODUCTS } from '../generated/products-expanded';
import type { ProjParams } from '../render/raster';
import { ptypeAt, ptypeLabel, dominantTime, type PtypeState, type PtypeTex } from '../render/ptype';
import type { LegendSpec } from '../layers/base';
import { getPalette } from '../palettes/library';

export const MRMS_BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';
export type MrmsProduct = (typeof XPRODUCTS.mrms)[number];
export const MRMS = XPRODUCTS.mrms;

/** S3 directory of a product: the catalog's public template without the date part. */
export function mrmsDir(p: MrmsProduct) { return /CONUS\/([^/]+)\//.exec(p.s3)![1]; }

/** Unit conversion from MRMS native units (mm, km, m) to the unit label (in, kft, ft); others unchanged. */
export function mrmsValueFactor(p: MrmsProduct): number {
  if (p.unit === 'in' || p.unit === 'in/hr') return 0.0393701;
  if (p.unit === 'kft' || p.unit === 'ft') return 3.28084;
  return 1;
}

/** Display range: the vendor table (parity) or, in corrected mode, the raw range in the labelled unit. */
export function mrmsRange(p: MrmsProduct, corrected: boolean): [number, number] {
  if (!corrected) return [p.displayRange[0], p.displayRange[1]];
  const k = mrmsValueFactor(p);
  return [p.rawRange[0] * k, p.rawRange[1] * k];
}

/** Frame count (clamped 1..20). */
export const mrmsFrameCount = () => Math.min(20, Math.max(1, Math.round(settings.num('settings.mrmsFrames'))));

/** Picks the newest n index entries newer than the loop start. */
export function pickMrmsFrames(entries: { t: number; key: string }[], n: number, startMs: number) {
  return entries.filter((e) => e.t >= startMs).sort((a, b) => b.t - a.t).slice(0, n).reverse();
}

interface Loaded { tex: GPUTexture; proj: ProjParams; bounds: [number, number, number, number]; min: number; max: number }

export class MrmsLayer extends GridLayer {
  readonly id = 'mrms';
  readonly title = 'MRMS';
  private store: FrameStore<Loaded>;
  private index: { prod: number; at: number; entries: { t: number; key: string }[] } | null = null;
  private loadedProduct = -1;
  private readonly onPtype = () => { this.rd.invalidate(); this.sync(); };
  /** P-type state of the frame drawn last (legend/status text). */
  private ptypeShown: PtypeState<PtypeTex> | null = null;
  statusText = 'Status: Awaiting activation...';

  constructor(r: Renderer) {
    super(r);
    this.store = new FrameStore<Loaded>(async (f) => {
      const p = this.product();
      const [lo, hi] = mrmsRange(p, settings.bool('ext.settings.mrmsCorrectedUnits'));
      const factor = settings.num('config.performanceMode') === 0 ? 3 : 2;
      const res = await pool.for(this.id).run('grid.mrms', { url: `${MRMS_BUCKET}/${f.key}`, lo, hi, factor, conv: mrmsValueFactor(p) });
      return { tex: uploadGrid(r, res.nx, res.ny, res.data, this.id), proj: res.proj, bounds: res.bounds, min: res.min, max: res.max };
    }, (d) => d.tex.destroy(), 3, () => this.sync());
  }

  product(): MrmsProduct { return MRMS[settings.num('layerState.MRMSProdIdx')] ?? MRMS[1]; }
  enabled() { return settings.bool('layerState.MRMSOn'); }
  typed() { return this.product().index < 3 && settings.bool('settings.mrmsPrecipTyping'); }

  display(): GridDisplay {
    const p = this.product();
    const [low, high] = mrmsRange(p, settings.bool('ext.settings.mrmsCorrectedUnits'));
    return {
      low, high, unit: p.unit, label: p.label, palette: settings.str(p.palette), alpha: settings.num('settings.mrmsFillAlpha') / 255,
      smoothing: settings.bool('settings.mrmsFillSmoothing'), legend: settings.bool('settings.mrmsLegend'),
      blend: settings.bool('layerState.RasterDataTemporalInterpolation'),
    };
  }

  private sync() {
    this.frames = this.store.ready().map((f): GridFrame => ({ t: f.t, key: f.key, tex: f.data.tex, proj: f.data.proj, bounds: f.data.bounds }));
    const c = this.store.counts(), n = this.store.frames.length;
    const newest = this.frames[this.frames.length - 1];
    if (c.error && !c.ready) this.statusText = 'Status: Error loading chosen product.';
    else if (c.loading || c.pending) this.statusText = c.ready ? `Status: Loading frame ${c.ready + 1} of ${n}...` : 'Status: Loading newest frame...';
    else if (newest) this.statusText = `Status: Loaded.\nNewest frame ${new Date(newest.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    const pt = this.typed() && this.ptypeShown ? ` · ${ptypeLabel(this.ptypeShown)}` : '';
    this.setStatus(c.ready ? 'ready' : c.error && !c.loading ? 'error' : 'loading', this.statusText.replace('\n', ' ') + pt, { frames: c.ready, newestMs: newest?.t });
    this.publishTimeline();
  }
  /** Offers the loop to the main timeline while MRMS is on and "Wrap timeline to MRMS loop" is set. */
  private publishTimeline() {
    timeline.offer('mrms', settings.bool('settings.mrmsTimelineConstrain') && this.enabled() ? this.frames.map((f) => f.t) : null);
  }

  async refresh() {
    if (!this.enabled()) { this.statusText = 'Status: Awaiting activation...'; this.setStatus('off', ''); this.publishTimeline(); return; }
    const p = this.product();
    if (p.index !== this.loadedProduct) { this.store.clear(); this.frames = []; this.loadedProduct = p.index; this.index = null; }
    // Re-read the index when it is older than the product's refresh minutes.
    if (!this.index || this.index.prod !== p.index || Date.now() - this.index.at > p.refreshMin * 60e3) {
      this.statusText = 'Status: Loading MRMS index...';
      this.setStatus('loading', this.statusText);
      try { this.index = { prod: p.index, at: Date.now(), entries: await this.listIndex(p) }; }
      catch (e) { this.statusText = 'Status: Error loading chosen product.'; this.setStatus('error', `MRMS index: ${(e as Error).message}`); return; }
    }
    if (this.loadedProduct !== p.index) return; // product switched while listing (back-fill aborts)
    this.store.setWanted(pickMrmsFrames(this.index.entries, mrmsFrameCount(), timeline.loopStart));
    this.sync();
  }

  private async listIndex(p: MrmsProduct) {
    const dir = mrmsDir(p);
    const days = new Set([timeline.loopStart, Date.now()].map((t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '')));
    const out: { t: number; key: string }[] = [];
    for (const day of days) {
      const { objects } = await listS3(MRMS_BUCKET, `CONUS/${dir}/${day}/`, { maxPages: 4 });
      for (const o of objects) {
        const m = /_(\d{8})-(\d{6})\.grib2\.gz$/.exec(o.key);
        if (m) out.push({ t: Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)), key: o.key });
      }
    }
    return out;
  }

  draw(ctx: DrawContext) {
    if (!this.enabled()) return;
    if (!this.typed()) { this.ptypeShown = null; super.draw(ctx); return; }
    const d = this.display();
    const { a, b, w } = bracket(this.frames, timeline.t, d.blend, 30 * 60e3);
    if (!a) return;
    // P-type valid at the drawn frame's own time; unavailable → the product's ordinary palette.
    const pt = ptypeAt(this.r, dominantTime(a, b, w), this.onPtype);
    if (pt.status !== this.ptypeShown?.status || pt.validMs !== this.ptypeShown?.validMs) { this.ptypeShown = pt; this.sync(); }
    if (pt.status !== 'ready') { super.draw(ctx); return; }
    const pal = (k: string) => this.lut(settings.str(k), d.low, d.high);
    this.rd.draw(ctx, {
      mode: 1, w: b ? w : 0, alpha: d.alpha, smoothing: d.smoothing, bounds: a.bounds, proj: a.proj, aux: pt.value.proj, negMissing: true,
      ptype: { gradient: settings.num('settings.generalPrecipTypingRainSnowLineGradientWidth'), prob: settings.bool('settings.generalPrecipTypingProbabilityRendering'), sleet: settings.bool('settings.generalPrecipTypingSleetEnabled') },
      luts: [pal('settings.generalPrecipTypingRainPalette'), pal('settings.generalPrecipTypingSnowPalette'), pal('settings.generalPrecipTypingFRPalette'), pal('settings.generalPrecipTypingSleetPalette')],
      data: [[a.tex, (b ?? a).tex]], auxTex: pt.value.tex,
    }, 5);
  }

  legends(): LegendSpec[] {
    const base = super.legends();
    if (!base.length || !this.typed()) return base;
    if (this.ptypeShown?.status !== 'ready') return this.ptypeShown ? [{ ...base[0], note: ptypeLabel(this.ptypeShown) }] : base;
    const d = this.display();
    const extra: NonNullable<LegendSpec['extra']> = [];
    const add = (label: string, k: string) => extra.push({ label, palette: getPalette(settings.str(k)), lut: this.lut(settings.str(k), d.low, d.high) });
    if (!settings.bool('settings.generalPrecipTypingHideSnowLegend')) add('Snow', 'settings.generalPrecipTypingSnowPalette');
    if (!settings.bool('settings.generalPrecipTypingHideFRLegend')) add('FrzRain', 'settings.generalPrecipTypingFRPalette');
    if (!settings.bool('settings.generalPrecipTypingHideSleetLegend') && settings.bool('settings.generalPrecipTypingSleetEnabled')) add('Sleet', 'settings.generalPrecipTypingSleetPalette');
    const rain = settings.str('settings.generalPrecipTypingRainPalette');
    return [{ ...base[0], palette: getPalette(rain), lut: this.lut(rain, d.low, d.high), extra, note: ptypeLabel(this.ptypeShown) }];
  }
}
