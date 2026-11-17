// Basic → National Radar Reflectivity: MRMS CONUS mosaics from the public NOAA bucket, P-typed with
// HRRR precipitation-type fields, temporal blending and smoothing.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, type LegendSpec } from './base';
import { FrameStore } from './frames';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { listS3 } from '../data/net';
import { pool } from '../workers/pool';
import { RasterDraw, Lut, latLonProj, type ProjParams } from '../render/raster';
import { getPalette } from '../palettes/library';
import { ptypeAt, ptypeLabel, dominantTime, type PtypeState, type PtypeTex } from '../render/ptype';

export const MRMS_BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';
/** NationalRadarIdx → MRMS product directory (original keys bref2 / cref2 / hsr2). */
export const NR_PRODUCTS = ['MergedBaseReflectivityQC_00.50', 'MergedReflectivityQCComposite_00.50', 'SeamlessHSR_00.00'] as const;
// Byte code c ↔ dBZ: c = round((dBZ + 32) × 2) + 1; texture x = c / 255.
const NR_LOW = -32.5, NR_HIGH = (255 - 1) / 2 - 32;

interface NrFrame { tex: GPUTexture; proj: ProjParams; bounds: [number, number, number, number] }

/** Picks frames: 6-minute spacing for the newest hour, then 12-minute spacing (hint). */
export function pickMosaicFrames(keys: { t: number; key: string }[], end: number, start: number): { t: number; key: string }[] {
  const sorted = keys.filter((k) => k.t >= start - 60e3 && k.t <= end + 60e3).sort((a, b) => b.t - a.t);
  const out: { t: number; key: string }[] = [];
  let next = Infinity;
  for (const k of sorted) {
    if (k.t > next) continue;
    out.push(k);
    const step = end - k.t <= 3600e3 ? 6 * 60e3 : 12 * 60e3;
    next = k.t - step + 30e3;
  }
  return out.reverse();
}

export class NationalRadarLayer extends MapLayer {
  readonly id = 'nationalRadar';
  readonly title = 'National radar';
  private store: FrameStore<NrFrame>;
  private draw_: RasterDraw;
  private luts = new Map<string, Lut>();
  private readonly onPtype = () => { this.draw_.invalidate(); this.updateStatus(); };
  /** P-type state of the frame drawn last (legend/status text). */
  private ptypeShown: PtypeState<PtypeTex> | null = null;
  private productIdx = -1;

  constructor(r: Renderer) {
    super(r);
    this.draw_ = new RasterDraw(r);
    this.store = new FrameStore<NrFrame>(async (f) => {
      const res = await pool.for(this.id).run('mrms', { url: `${MRMS_BUCKET}/${f.key}`, factor: 2 });
      const tex = r.gpu.texture2D(res.width, res.height, 'r8unorm', res.codes, 1, this.id);
      // Half an input cell: the input grid has 2 × width cells between lo1 and lo2 (cell centres).
      const halfLon = (res.lo2 - res.lo1) / (2 * (res.width * 2 - 1)), halfLat = (res.la1 - res.la2) / (2 * (res.height * 2 - 1));
      const lonW = res.lo1 - halfLon, lonE = res.lo2 + halfLon, latN = res.la1 + halfLat, latS = res.la2 - halfLat;
      return { tex, proj: latLonProj(latN, lonW, latS, lonE, res.width, res.height), bounds: [latS, lonW, latN, lonE] };
    }, (d) => d.tex.destroy(), 3, () => this.updateStatus());
  }

  enabled() { return settings.bool('layerState.NationalRadarOn'); }
  invalidate() { this.draw_.invalidate(); }

  private lut(name: string): Lut {
    let l = this.luts.get(name);
    if (!l) { l = new Lut(this.r, getPalette(name), { low: NR_LOW, high: NR_HIGH }); this.luts.set(name, l); }
    return l;
  }

  private updateStatus() {
    const c = this.store.counts();
    const ready = this.store.ready();
    this.setStatus(ready.length ? 'ready' : c.error && !c.loading ? 'error' : 'loading',
      `${NR_PRODUCTS[settings.num('layerState.NationalRadarIdx')]}: ${c.ready}/${this.store.frames.length} frames${c.error ? `, ${c.error} failed` : ''}${this.ptypeShown && settings.bool('layerState.NationalRadarPrecipTyped') ? ` · ${ptypeLabel(this.ptypeShown)}` : ''}`,
      { frames: ready.length, newestMs: ready.length ? ready[ready.length - 1].t : undefined });
  }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const idx = settings.num('layerState.NationalRadarIdx');
    if (idx !== this.productIdx) { this.store.clear(); this.productIdx = idx; }
    const prod = NR_PRODUCTS[idx];
    const days = new Set([timeline.loopStart, timeline.loopEnd].map((t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '')));
    const keys: { t: number; key: string }[] = [];
    for (const day of days) {
      try {
        const { objects } = await listS3(MRMS_BUCKET, `CONUS/${prod}/${day}/`, { maxPages: 2 });
        for (const o of objects) {
          const m = /_(\d{8})-(\d{6})\.grib2\.gz$/.exec(o.key);
          if (!m) continue;
          const t = Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6));
          keys.push({ t, key: o.key });
        }
      } catch (e) { this.setStatus('error', `MRMS listing failed: ${(e as Error).message}`); return; }
    }
    this.store.setWanted(pickMosaicFrames(keys, timeline.loopEnd, timeline.loopStart));
    this.updateStatus();
  }

  legends(): LegendSpec[] {
    if (!this.enabled() || !settings.bool('settings.nrLegend')) return [];
    const name = settings.str('settings.nrColorPalette');
    const spec: LegendSpec = { id: 'nr', palette: getPalette(name), low: NR_LOW, high: NR_HIGH, unit: 'dBz', lut: this.lut(name) };
    if (settings.bool('layerState.NationalRadarPrecipTyped') && this.ptypeShown) spec.note = ptypeLabel(this.ptypeShown);
    if (settings.bool('layerState.NationalRadarPrecipTyped') && this.ptypeShown?.status === 'ready') {
      const rain = settings.str('settings.generalPrecipTypingRainPalette');
      Object.assign(spec, { palette: getPalette(rain), lut: this.lut(rain) });
      spec.extra = [];
      if (!settings.bool('settings.generalPrecipTypingHideSnowLegend')) spec.extra.push({ label: 'Snow', palette: getPalette(settings.str('settings.generalPrecipTypingSnowPalette')), lut: this.lut(settings.str('settings.generalPrecipTypingSnowPalette')) });
      if (!settings.bool('settings.generalPrecipTypingHideFRLegend')) spec.extra.push({ label: 'FrzRain', palette: getPalette(settings.str('settings.generalPrecipTypingFRPalette')), lut: this.lut(settings.str('settings.generalPrecipTypingFRPalette')) });
      if (!settings.bool('settings.generalPrecipTypingHideSleetLegend') && settings.bool('settings.generalPrecipTypingSleetEnabled')) spec.extra.push({ label: 'Sleet', palette: getPalette(settings.str('settings.generalPrecipTypingSleetPalette')), lut: this.lut(settings.str('settings.generalPrecipTypingSleetPalette')) });
    }
    return [spec];
  }

  probeKind() { return this.enabled() && this.store.ready().length ? 'nr' : null; }
  probeText(v: number) { return `${(NR_LOW + (NR_HIGH - NR_LOW) * v).toFixed(1)} dBZ`; }

  draw(ctx: DrawContext) {
    const frames = this.store.ready();
    if (!frames.length) return;
    const blend = settings.bool('settings.nrBlendFrames') && settings.bool('layerState.RasterDataTemporalInterpolation');
    const { a, b, w } = bracket(frames, timeline.t, blend, 15 * 60e3);
    if (!a) return;
    // P-type valid at the drawn frame's own time (not the clock); unavailable → ordinary reflectivity.
    const pt = settings.bool('layerState.NationalRadarPrecipTyped') ? ptypeAt(this.r, dominantTime(a, b, w), this.onPtype) : null;
    if (pt?.status !== this.ptypeShown?.status || pt?.validMs !== this.ptypeShown?.validMs) { this.ptypeShown = pt; this.updateStatus(); }
    const ready = pt?.status === 'ready' ? pt.value : null, ptyped = !!ready;
    this.draw_.draw(ctx, {
      mode: ptyped ? 1 : 0, w, alpha: settings.num('settings.nrAlpha') / 255, smoothing: settings.bool('settings.nrSmoothing'),
      bounds: a.data.bounds, proj: a.data.proj, aux: ready?.proj,
      ptype: { gradient: settings.num('settings.generalPrecipTypingRainSnowLineGradientWidth'), prob: settings.bool('settings.generalPrecipTypingProbabilityRendering'), sleet: settings.bool('settings.generalPrecipTypingSleetEnabled') },
      luts: [this.lut(settings.str(ptyped ? 'settings.generalPrecipTypingRainPalette' : 'settings.nrColorPalette')), this.lut(settings.str('settings.generalPrecipTypingSnowPalette')), this.lut(settings.str('settings.generalPrecipTypingFRPalette')), this.lut(settings.str('settings.generalPrecipTypingSleetPalette'))],
      data: [[a.data.tex, (b ?? a).data.tex]], auxTex: ready?.tex ?? null,
    });
  }
}
