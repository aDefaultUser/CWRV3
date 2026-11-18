// Basic → Satellite Imagery and the public "Extended GOES" substitute: GOES ABI L2 CMIP
// NetCDF from the public NOAA bucket, single bands with band palettes and the two built-in multispectral
// recipes of (True Color from bands 1/2/3, IR/VIS sandwich from bands 2/14).
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, NOT_AVAILABLE, type LegendSpec } from './base';
import { FrameStore } from './frames';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { listS3 } from '../data/net';
import { pool } from '../workers/pool';
import { RasterDraw, Lut, geosProj, type ProjParams } from '../render/raster';
import { getPalette } from '../palettes/library';
import { recipeShader, type Recipe } from '../render/recipes';
import { rgbRecipes } from '../app/stores';

import { SAT_BANDS } from './sat-bands';
export { SAT_BANDS, SAT_NAMES } from './sat-bands';
export const bandRange = (b: number): [number, number] => (b <= 6 ? [0, 1.2] : [-110, 57]);
const bandFactor = (b: number, perf: number, domain: number) => {
  const base = b === 2 ? 4 : [1, 3, 5].includes(b) ? 2 : 1;
  const dom = domain === 1 ? 4 : domain >= 2 ? 0.5 : 1;
  return Math.max(1, Math.round(base * dom * (perf === 2 ? 0.5 : perf === 0 ? 2 : 1)));
};

interface BandFrame { tex: GPUTexture; proj: ProjParams; bounds: [number, number, number, number]; startMs: number }

export interface SatConfig { id: string; title: string; enabled: () => boolean; bands: () => number[]; product: () => 'single' | 'rgb' | 'sandwich' | 'user'; recipe?: () => Recipe | null; platform: () => 'goes19' | 'goes18'; domain: () => number; alpha: () => number; legend: () => boolean; blend: () => boolean; maxFrames: () => number; paletteFor: (band: number) => string }

const DOMAIN_PRODUCT = ['ABI-L2-CMIPC', 'ABI-L2-CMIPF', 'ABI-L2-CMIPM', 'ABI-L2-CMIPM'];
const DOMAIN_TAG = ['CMIPC', 'CMIPF', 'CMIPM1', 'CMIPM2'];

/** The satellite that held a GOES-R position at `t`: the settings name today's pair (goes19 East, goes18 West). */
export function goesAt(platform: 'goes19' | 'goes18', t: number): string {
  if (platform === 'goes19') return t < Date.UTC(2025, 3, 7, 15) ? 'goes16' : 'goes19';
  return t < Date.UTC(2023, 0, 4, 18) ? 'goes17' : 'goes18';
}

export class SatelliteLayer extends MapLayer {
  readonly archive = 'window';
  readonly id: string; readonly title: string;
  private stores = new Map<number, FrameStore<BandFrame>>();
  private draw_: RasterDraw;
  private luts = new Map<string, Lut>();
  private sig = '';
  constructor(r: Renderer, private cfg: SatConfig) { super(r); this.id = cfg.id; this.title = cfg.title; this.draw_ = new RasterDraw(r); }
  enabled() { return this.cfg.enabled(); }
  invalidate() { this.draw_.invalidate(); }

  private store(band: number): FrameStore<BandFrame> {
    let s = this.stores.get(band);
    if (!s) {
      const [min, max] = bandRange(band);
      s = new FrameStore<BandFrame>(async (f) => {
        const res = await pool.for(this.id).run('goes', { url: f.key, factor: bandFactor(band, settings.num('config.performanceMode'), this.cfg.domain()), min, max });
        const tex = this.r.gpu.texture2D(res.width, res.height, 'r8unorm', res.codes, 1, this.id);
        return { tex, proj: geosProj(res.proj, res.width, res.height), bounds: this.boundsFor(res.proj.lon0), startMs: res.startMs };
      }, (d) => d.tex.destroy(), 2, () => this.updateStatus());
      this.stores.set(band, s);
    }
    return s;
  }

  private boundsFor(lon0: number): [number, number, number, number] {
    const d = this.cfg.domain();
    if (d === 1) return [-81, lon0 - 81, 81, lon0 + 81];
    return [12, lon0 - 75, 62, lon0 + 30];
  }

  private updateStatus() {
    const bands = this.cfg.bands();
    const counts = bands.map((b) => this.store(b).counts());
    const ready = Math.min(...counts.map((c) => c.ready)), total = Math.max(...bands.map((b) => this.store(b).frames.length));
    const err = counts.reduce((s, c) => s + c.error, 0);
    this.setStatus(ready ? 'ready' : err ? 'error' : 'loading', `${goesAt(this.cfg.platform(), timeline.loopEnd).toUpperCase()} ${DOMAIN_TAG[this.cfg.domain()]} band ${bands.join('+')}: ${ready}/${total}${err ? `, ${err} failed` : ''}`, { frames: ready });
  }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const sat = goesAt(this.cfg.platform(), timeline.loopEnd);
    const sig = `${timeline.key}|${sat}|${this.cfg.domain()}|${this.cfg.bands().join(',')}|${settings.num('config.performanceMode')}`;
    if (sig !== this.sig) { for (const s of this.stores.values()) s.clear(); this.stores.clear(); this.sig = sig; }
    const bucket = `https://noaa-${sat}.s3.amazonaws.com`;
    const product = DOMAIN_PRODUCT[this.cfg.domain()], tag = DOMAIN_TAG[this.cfg.domain()];
    const hours: number[] = [];
    for (let t = Math.floor(timeline.loopStart / 3600e3) * 3600e3; t <= timeline.loopEnd; t += 3600e3) hours.push(t);
    const files: { key: string; band: number; t: number }[] = [];
    try {
      await Promise.all(hours.map(async (h) => {
        const d = new Date(h);
        const doy = Math.floor((h - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400e3) + 1;
        const prefix = `${product}/${d.getUTCFullYear()}/${String(doy).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`;
        const { objects } = await listS3(bucket, prefix, { maxPages: 3 });
        for (const o of objects) {
          const m = new RegExp(`OR_ABI-L2-${tag}-M\\d+C(\\d\\d)_G\\d+_s(\\d{4})(\\d{3})(\\d{2})(\\d{2})(\\d{2})`).exec(o.key);
          if (!m) continue;
          const t = Date.UTC(+m[2], 0, 1) + (+m[3] - 1) * 86400e3 + +m[4] * 3600e3 + +m[5] * 60e3 + +m[6] * 1000;
          files.push({ key: `${bucket}/${o.key}`, band: +m[1], t });
        }
      }));
    } catch (e) { this.setStatus('error', `GOES listing failed: ${(e as Error).message}`); return; }
    if (sig !== this.sig) return; // the selection, mode or archive time changed while listing
    if (!files.length && timeline.mode === 'archive') { this.setStatus('unavailable', NOT_AVAILABLE); return; }
    for (const band of this.cfg.bands()) {
      let fs = thinGoesFiles(files.filter((f) => f.band === band && f.t >= timeline.loopStart - 10 * 60e3).sort((a, b) => a.t - b.t), this.cfg.domain());
      fs = fs.slice(-this.cfg.maxFrames());
      this.store(band).setWanted(fs.map((f) => ({ t: f.t, key: f.key })));
    }
    this.updateStatus();
  }

  private lut(name: string, band: number): Lut {
    const key = `${name}|${band}`;
    let l = this.luts.get(key);
    if (!l) {
      const [min, max] = bandRange(band);
      l = new Lut(this.r, getPalette(name), { low: min - (max - min) / 254, high: max, raster: false });
      this.luts.set(key, l);
    }
    return l;
  }

  legends(): LegendSpec[] {
    if (!this.enabled() || !this.cfg.legend() || this.cfg.product() !== 'single') return [];
    const b = this.cfg.bands()[0], [min, max] = bandRange(b), name = this.cfg.paletteFor(b);
    return [{ id: this.id, palette: getPalette(name), low: min, high: max, unit: b <= 6 ? '' : '°C', lut: this.lut(name, b) }];
  }

  probeKind() { return this.enabled() && this.cfg.product() === 'single' && this.store(this.cfg.bands()[0]).ready().length ? 'sat' : null; }
  probeText(v: number) {
    const b = this.cfg.bands()[0], [min, max] = bandRange(b);
    const val = min + ((max - min) * (v * 255 - 1)) / 254;
    return b <= 6 ? `${(val * 100).toFixed(1)} % refl. (band ${b})` : `${val.toFixed(1)} °C (band ${b})`;
  }

  draw(ctx: DrawContext) {
    if (!this.enabled()) return;
    const bands = this.cfg.bands();
    const blend = this.cfg.blend() && settings.bool('layerState.RasterDataTemporalInterpolation');
    const pairs = bands.map((b) => bracket(this.store(b).ready(), timeline.t, blend, 30 * 60e3));
    if (pairs.some((p) => !p.a)) return;
    const prod = this.cfg.product();
    const a0 = pairs[0].a!.data;
    if (prod === 'user') { this.drawRecipe(ctx, pairs.map((p) => p.a!.data.tex), a0); return; }
    const mode = prod === 'rgb' ? 2 : prod === 'sandwich' ? 3 : 0;
    const irBand = bands[bands.length - 1];
    this.draw_.draw(ctx, {
      mode, w: pairs[0].w, alpha: this.cfg.alpha() / 255, smoothing: true,
      bounds: a0.bounds, proj: a0.proj,
      luts: mode === 3 ? [this.lut(this.cfg.paletteFor(2), 2), this.lut(this.cfg.paletteFor(irBand), irBand)] : [this.lut(this.cfg.paletteFor(bands[0]), bands[0])],
      data: pairs.map((p) => [p.a!.data.tex, (p.b ?? p.a)!.data.tex] as [GPUTexture, GPUTexture]),
    }, 2);
  }

  /** User recipe: channel textures in slots ch1..ch4 (no temporal blend), generated fsUser pipeline. */
  recipeError = '';
  private drawRecipe(ctx: DrawContext, texs: GPUTexture[], a0: BandFrame) {
    const r = this.cfg.recipe?.();
    if (!r) return;
    let pipeline: GPURenderPipeline;
    try { pipeline = this.r.rasterVariant(JSON.stringify(r), recipeShader(r), 'fsUser', (e) => { this.recipeError = e; }); }
    catch (e) { this.recipeError = (e as Error).message; return; }
    const slots: (GPUTexture | null)[] = [null, null, null, null];
    let k = 0;
    r.enabled.forEach((on, i) => { if (on) slots[i] = texs[k++] ?? null; });
    const pal = r.paletteChannel >= 0 ? this.lut(this.cfg.paletteFor(r.bands[r.paletteChannel]), r.bands[r.paletteChannel]) : null;
    this.draw_.draw(ctx, { mode: 0, w: 0, alpha: this.cfg.alpha() / 255, smoothing: true, bounds: a0.bounds, proj: a0.proj, luts: [pal], data: [[slots[0], slots[1]], [slots[2], slots[3]]], pipeline }, 2);
  }
}

/** "15-min CONUS mode" and "3-min mesoscale mode" thinning of a time-sorted file list (newest file always kept). */
export function thinGoesFiles<T extends { t: number }>(fs: T[], domain: number): T[] {
  if (settings.bool('settings.goesCONUSThird') && domain === 0) fs = fs.filter((f) => new Date(f.t).getUTCMinutes() % 15 < 5);
  if (settings.bool('settings.goesMesoThird') && domain >= 2) { const n = fs.length; fs = fs.filter((_, i) => i % 3 === n % 3 - 1 || i === n - 1); }
  return fs;
}

export function basicSatelliteConfig(): SatConfig {
  const idx = () => settings.num('layerState.SatelliteProductIndex');
  return {
    id: 'satellite', title: 'Satellite',
    enabled: () => settings.bool('layerState.SatelliteOn'),
    bands: () => SAT_BANDS[idx()] ?? [14],
    product: () => (idx() === 6 ? 'rgb' : idx() === 7 ? 'sandwich' : 'single'),
    platform: () => 'goes19', domain: () => 0,
    alpha: () => settings.num('settings.goesAlpha'), legend: () => settings.bool('settings.goesLegend'), blend: () => settings.bool('settings.goesBlendFrames'),
    maxFrames: () => 36,
    paletteFor: (b) => settings.arr<string>('settings.goesBandPals')[b - 1] ?? `GOESRBand${b}`,
  };
}

/** The selected user recipe (multi index 2+), when it has at least one enabled channel. */
function userRecipe(): Recipe | null {
  const r = rgbRecipes.list[settings.num('layerState.ExtendedSatelliteMultiIndex') - 2];
  return r && r.enabled.some(Boolean) ? r : null;
}

export function extendedSatelliteConfig(): SatConfig {
  const multi = () => settings.bool('layerState.ExtendedSatelliteUseMulti');
  return {
    id: 'satelliteExtended', title: 'Extended GOES',
    enabled: () => settings.bool('layerState.ExtendedSatelliteOn') && !settings.bool('ext.layerState.ExtendedSatelliteUseL2') && settings.num('ext.layerState.ExtendedSatellitePlatform') !== 2,
    bands: () => {
      if (!multi()) return [Math.min(16, Math.max(1, settings.num('layerState.ExtendedSatelliteProductIndex') + 1))];
      const r = userRecipe();
      if (r) return r.bands.filter((_, i) => r.enabled[i]);
      return settings.num('layerState.ExtendedSatelliteMultiIndex') === 1 ? [2, 14] : [1, 2, 3];
    },
    product: () => (multi() ? (userRecipe() ? 'user' : settings.num('layerState.ExtendedSatelliteMultiIndex') === 1 ? 'sandwich' : 'rgb') : 'single'),
    recipe: userRecipe,
    platform: () => (settings.num('ext.layerState.ExtendedSatellitePlatform') === 1 ? 'goes18' : 'goes19'),
    domain: () => settings.num('ext.layerState.ExtendedSatelliteDomain'),
    alpha: () => settings.num('settings.goesExtendedAlpha'), legend: () => settings.bool('settings.goesLegend'), blend: () => true,
    maxFrames: () => (settings.bool('settings.goesExtendedForce60fps') ? 60 : 36),
    paletteFor: (b) => settings.arr<string>('settings.goesExtendedBandPals')[b - 1] ?? `GOESRBand${b}`,
  };
}
