// Model tab: configuration list (public configs + user configs + Custom GRIB), current cycle,
// single-frame / loop downloads by inventory match with HTTP Range, abort, status log, fill / fill-2 rasters,
// vector barbs, contours, legend, probe, timestamp label and the Model timeline.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, type LegendSpec } from '../layers/base';
import { RasterDraw, Lut, type ProjParams } from '../render/raster';
import { LineSet, TextSet, declutter, type GlyphAtlas, type Polyline, type Label } from '../render/prims';
import { uploadGrid } from '../layers/grid';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';
import { timeline, bracket } from '../app/timeline';
import { getPalette } from '../palettes/library';
import { paletteRange } from '../render/palette';
import { fmtProbe } from '../layers/nexrad';
import { barb } from './surface';
import { parseModelConfig, currentCycle, modelUrl, DEFAULT_CONFIGS, type ModelConfig, type ModelProduct } from './model-config';
import { loadPref, savePref, isRecord } from '../app/persist';

const USER_KEY = 'modelConfigs';
export const CUSTOM_CAPTION = 'Custom GRIB';

type Kind = 'fill' | 'fill2' | 'vector' | 'contour';
const KINDS: Kind[] = ['fill', 'fill2', 'vector', 'contour'];
interface Fill { tex: GPUTexture; proj: ProjParams; bounds: [number, number, number, number] }
/** Data of one product slot, tagged with the identity of the product it was loaded for. */
interface Slot { id: string; fill?: Fill; vectors?: Float32Array; contours?: { level: number; coords: number[] }[] }
/** One forecast hour of one model run (`run` is the cycle it was loaded from, not the current cycle). */
interface HourFrame { hour: number; t: number; run: number; slots: Partial<Record<Kind, Slot>> }
/** Settings that change vector/contour geometry or line styles (rebuilt at once when any of them changes). */
const GEOMETRY_SETTINGS = ['ext.config.vectorFieldSize', 'ext.config.vectorFieldType', 'ext.config.vectorFieldRoundingFormat', 'ext.config.vectorFieldColored',
  'ext.config.vectorFieldScaled', 'config.generalVectorFadeMode', 'config.vfDefaultColor', 'settings.generalContourWidth', 'settings.generalContourColor',
  'settings.generalContourBorderColor', 'settings.generalContourBorders', 'settings.generalContourAlpha'];

/**
 * Vector-field fade (General/VectorFadeMode, independent interpretation): 0 none; 1 fade with zoom (55 % at whole-US
 * scale and beyond); 2 zoom fade plus weaker vectors (speed bins ≤ 10 / ≤ 20 mph) at 55 % / 80 %.
 */
export function vectorFade(mode: number, zoomScale: number): (binMph: number) => number {
  const zoom = mode >= 1 ? 1 - 0.45 * Math.min(1, Math.max(0, (zoomScale - 4) / 8)) : 1;
  return (b) => zoom * (mode >= 2 ? (b <= 10 ? 0.55 : b <= 20 ? 0.8 : 1) : 1);
}

export class ModelLayer extends MapLayer {
  readonly id = 'modelFill';
  readonly title = 'Model data';
  configs: ModelConfig[] = [];
  errors: string[] = [];
  log: string[] = ['Awaiting user model data load task...'];
  frames = new Map<number, HourFrame>();
  loopEnd = -1;
  busy = false;
  /** Load generation: clear and abort start a new one, and results of an older one are discarded. */
  private gen = 0;
  private cycle = 0;
  private loadedKey = '';
  private rd1: RasterDraw; private rd2: RasterDraw;
  private lines: LineSet; private labels: TextSet; private vec: LineSet;
  private luts = new Map<string, Lut>();
  private geomKey = '';
  /** Custom GRIB: user file object URLs and the user's parameter list (integration index file). */
  custom = { grib: '' as string, name: '', inventory: '', params: 'Parameters:\n1,0,0,°F,2 m Temperature,M_2MTGLOBAL,TMP:2 m above ground\n1,1,0,mph,10 m Wind,surfacewind,UGRD:10 m above ground@VGRD:10 m above ground\n0,0,1,mb,MSLP,,PRMSL:mean sea level' };

  constructor(r: Renderer, atlas: GlyphAtlas) {
    super(r);
    this.rd1 = new RasterDraw(r); this.rd2 = new RasterDraw(r);
    this.lines = new LineSet(r); this.labels = new TextSet(r, atlas); this.vec = new LineSet(r);
    this.reloadConfigs();
  }

  /** "Reload model configuration": re-parses the shipped and the user's configurations. */
  reloadConfigs() {
    const all = { ...DEFAULT_CONFIGS, ...loadPref<Record<string, string>>(USER_KEY, {}, isRecord) };
    this.configs = []; this.errors = [];
    for (const [file, text] of Object.entries(all)) { const r = parseModelConfig(text, file); if (r.config) this.configs.push(r.config); this.errors.push(...r.errors); }
    this.configs.sort((a, b) => a.caption.localeCompare(b.caption));
  }
  addUserConfig(file: string, text: string) {
    const user = { ...loadPref<Record<string, string>>(USER_KEY, {}, isRecord), [file]: text };
    const ok = savePref(USER_KEY, user, 'model configuration');
    this.reloadConfigs();
    return ok;
  }

  captions() { return [...this.configs.map((c) => c.caption), CUSTOM_CAPTION]; }
  isCustom() { return settings.num('layerState.ModelIdx') >= this.configs.length; }
  config(): ModelConfig | null {
    if (this.isCustom()) {
      if (!this.custom.grib) return null;
      const r = parseModelConfig(`Caption\n${CUSTOM_CAPTION}\nForecastTiming\n0\nCycleTiming\n0,24,0\nProjectionFile\nfromGRIB\nDimensions\n0,0\nDownloadURL\n${this.custom.grib}\nInventoryExt\n.idx\n${this.custom.params}`, 'CUSTOMGRIB.dat');
      return r.config;
    }
    return this.configs[settings.num('layerState.ModelIdx')] ?? this.configs[0] ?? null;
  }
  list(kind: 'fill' | 'vector' | 'contour'): ModelProduct[] { return this.config()?.products.filter((p) => p[kind]) ?? []; }
  product(kind: 'fill' | 'vector' | 'contour' | 'fill2'): ModelProduct | null {
    const idx = settings.num({ fill: 'layerState.ModelDataColorFillIdx', vector: 'layerState.ModelDataVectorsIdx', contour: 'layerState.ModelDataContoursIdx', fill2: 'layerState.ModelDataColorFill2Idx' }[kind]);
    return idx < 0 ? null : this.list(kind === 'fill2' ? 'fill' : kind)[idx] ?? null;
  }
  /**
   * Identity of the data a product slot must hold to be shown: configuration (and Custom GRIB source) and the
   * product definition. Data loaded for another selection is never drawn, probed or labelled as this one.
   */
  productId(kind: Kind): string | null {
    const c = this.config(), p = this.product(kind);
    return c && p ? JSON.stringify([c.caption, this.isCustom() ? this.custom.grib : '', p.caption, p.match, p.unit, p.palette]) : null;
  }
  private ids(): Record<Kind, string | null> { return { fill: this.productId('fill'), fill2: this.productId('fill2'), vector: this.productId('vector'), contour: this.productId('contour') }; }
  /** The slot of `f` when it holds data of the selected product, else undefined. */
  private shown(f: HourFrame | null | undefined, kind: Kind, ids = this.ids()): Slot | undefined {
    const s = f?.slots[kind];
    return s && s.id === ids[kind] ? s : undefined;
  }
  enabled() {
    const ids = this.ids();
    for (const f of this.frames.values()) if (KINDS.some((k) => this.shown(f, k, ids))) return true;
    return false;
  }
  runCycle() { const c = this.config(); return c ? (this.isCustom() ? this.cycle : currentCycle(c, Date.now())) : 0; }
  runText() { const c = this.config(); if (!c) return 'Current run: -Z'; const t = this.runCycle(); return `Current run: ${new Date(t).toISOString().slice(11, 13)}Z`; }
  hourItems(): string[] {
    const c = this.config(); if (!c) return [];
    const run = this.runCycle();
    return c.hours.map((h) => `${h}HR - ${new Date(run + h * 3600e3).toLocaleString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', month: 'numeric', day: 'numeric', year: '2-digit' })}`);
  }
  private say(s: string) { this.log.push(s); if (this.log.length > 200) this.log.shift(); }

  /** Stops the running download: results still in flight are discarded. */
  setAbort() {
    if (!this.busy) return;
    this.gen++; this.busy = false;
    this.say('Model download aborted.');
    this.setStatus('ready', `${this.frames.size} hours loaded`);
  }
  private dropFrames() {
    for (const f of this.frames.values()) for (const s of Object.values(f.slots)) s?.fill?.tex.destroy();
    this.frames.clear(); this.geomKey = '';
  }
  clear() {
    this.gen++; this.busy = false;
    this.dropFrames(); this.loadedKey = ''; this.say('Model data cleared');
    timeline.offer('model', null);
  }

  /**
   * Loads the selected products for hours [start..end] (single frame: start only). The request (configuration,
   * run and product identities) is fixed when Load is pressed; a result is stored only while its load is current
   * (no clear/abort since) and its product is still selected, and always under the identity it was requested for.
   */
  async load(startIdx: number, endIdx = startIdx) {
    const c = this.config();
    if (!c) { this.say(this.isCustom() ? 'Load a GRIB2 file for Custom GRIB first.' : 'No model configuration loaded.'); return; }
    if (this.busy) { this.say('A download is already running.'); return; }
    const run = this.runCycle(), custom = this.isCustom(), grib = this.custom.grib;
    const req = KINDS.map((kind) => ({ kind, p: this.product(kind), id: this.productId(kind) })).filter((x): x is { kind: Kind; p: ModelProduct; id: string } => !!x.p && !!x.id);
    const key = JSON.stringify([run, req.map((x) => [x.kind, x.id])]);
    if (key !== this.loadedKey) { this.dropFrames(); this.loadedKey = key; }
    const gen = ++this.gen, current = () => gen === this.gen;
    this.busy = true;
    this.setStatus('loading', 'Model download');
    const hours = c.hours.slice(Math.max(0, startIdx), Math.min(c.hours.length, Math.max(startIdx, endIdx) + 1));
    let failed = false;
    try {
      for (const h of hours) {
        if (!current()) return;
        const url = custom ? grib : modelUrl(c, run, h, settings.num('settings.modelDataSource'));
        const fr: HourFrame = this.frames.get(h) ?? { hour: h, t: run + h * 3600e3, run, slots: {} };
        this.say(`Starting product load (${c.caption} ${h} hr ${new Date(run).toISOString().slice(11, 13)}Z)...`);
        for (const { kind, p, id } of req) {
          if (this.productId(kind) !== id) continue; // deselected since Load
          this.say(`Downloading product (${p.caption})`);
          const [lo, hi] = p.palette ? paletteRange(getPalette(p.palette)) : [0, 1];
          const interval = /MSL/.test(p.match.join()) ? settings.num('settings.generalMSLPContourInterval') : Math.max(1, settings.num('settings.generalHeightContourInterval') / 10);
          try {
            const res = await pool.for(this.id).run('grid.model', { url, invExt: c.invExt, matches: p.match, kind: kind === 'fill2' ? 'fill' : kind, unit: p.unit, lo, hi, interval, vectorStep: this.vectorStep(c), local: custom });
            if (!current()) return;
            if (this.productId(kind) !== id) continue; // selection changed while downloading
            fr.t = res.validMs ?? fr.t;
            fr.slots[kind]?.fill?.tex.destroy();
            fr.slots[kind] = { id, fill: res.data ? { tex: uploadGrid(this.r, res.nx, res.ny, res.data, this.id), proj: res.proj, bounds: res.bounds } : undefined, vectors: res.vectors, contours: res.contours };
          } catch (e) {
            if (!current()) return;
            failed = true;
            this.say(`Error: ${p.caption} ${h} hr: ${(e as Error).message}`); this.setStatus('error', `${c.caption}: ${(e as Error).message}`);
          }
        }
        this.frames.set(h, fr);
        this.geomKey = '';
        this.say(`Finished product load (${c.caption} ${h} hr).`);
        this.publishTimeline();
      }
    } finally {
      // A superseded load leaves the state of the newer one alone.
      if (current()) {
        this.busy = false; this.geomKey = '';
        if (!failed) this.setStatus('ready', `${c.caption}: ${this.frames.size} hours`);
      }
    }
  }
  private vectorStep(c: ModelConfig) {
    // Grid spacing trackbar (TVectorBarPanel, 90..600) → roughly that many km between barbs on a 3–13 km grid.
    const km = settings.num('ext.config.vectorFieldSpacing');
    const nx = c.dims[0] || 451;
    const gridKm = nx > 1500 ? 3 : nx > 1000 ? 5 : nx > 600 ? 12 : nx > 400 ? 13 : 100;
    return Math.max(1, Math.round(km / 4 / gridKm));
  }
  /** Offers the loaded valid times; they own the main timeline while the Model timeline is selected. */
  publishTimeline() { timeline.offer('model', [...this.frames.values()].map((f) => f.t)); }

  private frameAt(t: number) {
    const fs = [...this.frames.values()].sort((a, b) => a.t - b.t);
    if (fs.length === 1) return { a: fs[0], b: null, w: 0 };
    const r = bracket(fs, t, settings.bool('settings.modelContinuousInterpolation'), 13 * 3600e3);
    return { a: r.a ?? fs[fs.length - 1] ?? null, b: r.b, w: r.w };
  }
  private lut(name: string) {
    let l = this.luts.get(name);
    if (!l) { const [low, high] = paletteRange(getPalette(name)); l = new Lut(this.r, getPalette(name), { low, high }); this.luts.set(name, l); }
    return l;
  }
  tick(t: number) {
    if (!this.enabled()) return;
    const { a } = this.frameAt(t);
    const ids = this.ids();
    const gk = JSON.stringify([a?.hour, this.shown(a, 'contour', ids) ? ids.contour : null, this.shown(a, 'vector', ids) ? ids.vector : null, this.r.camera.cur.z.toFixed(1), GEOMETRY_SETTINGS.map((id) => settings.get(id))]);
    if (gk !== this.geomKey) { this.geomKey = gk; this.buildGeometry(a); }
    if (this.labels.labels.length) { const vis = declutter(this.r, this.labels, 120); for (let i = 0; i < vis.length; i++) this.labels.alpha[i] = vis[i]; this.labels.flushAlpha(); }
  }
  private buildGeometry(a: HourFrame | null) {
    const cc = settings.arr<number>('settings.generalContourColor'), bc = settings.arr<number>('settings.generalContourBorderColor');
    const al = Math.round(settings.num('settings.generalContourAlpha') * 255), w = settings.num('settings.generalContourWidth');
    this.lines.setStyles([{ color: [bc[0], bc[1], bc[2], settings.bool('settings.generalContourBorders') ? al : 0], width: w + 2.2 }, { color: [cc[0], cc[1], cc[2], Math.min(255, al + 60)], width: w }]);
    const ls: Polyline[] = [], lb: Label[] = [];
    for (const ct of this.shown(a, 'contour')?.contours ?? []) {
      ls.push({ coords: ct.coords, style: 0 }, { coords: ct.coords, style: 1 });
      const n = ct.coords.length / 2;
      for (let k = Math.floor(n / 2) % 40; k < n; k += 80) lb.push({ lon: ct.coords[k * 2], lat: ct.coords[k * 2 + 1], text: ct.level.toFixed(0), size: 11, color: [230, 235, 255, 255], halo: [20, 30, 60, 220], priority: 1 });
    }
    this.lines.setLines(ls);
    // Vectors (TVectorBarPanel): 0 Text (speed in kt), 1 Barbs, 2 Text vectors (arrow + speed), 3 Vectors 1,
    // 4 Vectors 2 (length by speed); colour by speed when "Colored". Speed text uses the vector rounding format.
    const vl: Polyline[] = [];
    const v = this.shown(a, 'vector')?.vectors;
    const type = settings.num('ext.config.vectorFieldType'), size = settings.num('ext.config.vectorFieldSize') / 100;
    const decimals = (settings.str('ext.config.vectorFieldRoundingFormat').split('.')[1] ?? '').length;
    const degPerPx = this.r.camera.metersPerPixel() / 111320;
    const bins = [10, 20, 30, 50, 70, 100, 1e9];
    const pal = getPalette('surfacewind');
    // Uncoloured vectors use the vector-field default colour; the fade mode thins vectors when zoomed out / weak.
    const dc = settings.arr<number>('config.vfDefaultColor'), base = [dc[0], dc[1], dc[2], 255];
    const fade = vectorFade(settings.num('config.generalVectorFadeMode'), this.r.camera.zoomScale);
    const styles = bins.map((b) => { const col = settings.bool('ext.config.vectorFieldColored') ? pal.frames[0].reduce((acc, s) => (s.v <= b * 0.8 ? s.b : acc), base) : base; return { color: [col[0], col[1], col[2], Math.round(235 * fade(b))] as [number, number, number, number], width: 1.3 }; });
    this.vec.setStyles(styles);
    if (v) for (let i = 0; i < v.length; i += 4) {
      const [lon, lat, u, vv] = [v[i], v[i + 1], v[i + 2], v[i + 3]];
      const ms = Math.hypot(u, vv), kt = ms * 1.943844, mph = ms * 2.23694;
      const style = Math.max(0, bins.findIndex((b) => mph <= b));
      const from = (Math.atan2(-u, -vv) * 180) / Math.PI;
      if (type === 0 || type === 2) {
        const c = styles[style].color;
        lb.push({ lon, lat, text: kt.toFixed(decimals), size: Math.round(11 * size), color: c, halo: [0, 0, 0, 220], priority: 0 });
        if (type === 0) continue;
      }
      if (type === 1) { for (const seg of barb(lon, lat, kt, (from + 360) % 360, degPerPx, 22 * size)) vl.push({ coords: seg, style }); }
      else {
        // Arrow length grows with speed for the scaled type and with the vector bar's "Scaled" option.
        const L = (type === 4 || settings.bool('ext.config.vectorFieldScaled') ? 10 + mph * 0.5 : 18) * size * degPerPx, k = Math.cos((lat * Math.PI) / 180) || 1e-6;
        const dx = (u / (ms || 1)) * L / k, dy = (vv / (ms || 1)) * L;
        vl.push({ coords: [lon, lat, lon + dx, lat + dy], style });
        const hx = lon + dx, hy = lat + dy;
        for (const s of [-1, 1]) vl.push({ coords: [hx, hy, hx - dx * 0.3 - (s * dy * 0.2) / k, hy - dy * 0.3 + s * dx * 0.2 * k], style });
      }
    }
    this.vec.setLines(vl);
    this.labels.setLabels(lb);
  }
  draw(ctx: DrawContext) {
    if (!this.enabled()) return;
    const { a, b, w } = this.frameAt(timeline.t);
    if (!a) return;
    const alpha = settings.num('settings.modelFillAlpha') / 255, sm = settings.bool('settings.modelFillSmoothing');
    const ids = this.ids();
    const fill = (kind: 'fill' | 'fill2', rd: RasterDraw) => {
      const p = this.product(kind), fa = this.shown(a, kind, ids)?.fill, fb = this.shown(b, kind, ids)?.fill;
      if (p && fa) rd.draw(ctx, { mode: 0, w: fb ? w : 0, alpha, smoothing: sm, bounds: fa.bounds, proj: fa.proj, luts: [this.lut(p.palette || 'M_2MTGLOBAL')], data: [[fa.tex, fb?.tex ?? fa.tex]], negMissing: true }, 6);
    };
    fill('fill', this.rd1);
    if (!ctx.probe) fill('fill2', this.rd2);
    if (!ctx.probe) { this.lines.draw(ctx); this.labels.draw(ctx); this.vec.draw(ctx); }
  }
  /** True when some loaded hour holds data of the selected fill product. */
  private fillShown() { const ids = this.ids(); for (const f of this.frames.values()) if (this.shown(f, 'fill', ids)?.fill) return true; return false; }
  legends(): LegendSpec[] {
    const p = this.product('fill');
    if (!p || !settings.bool('settings.modelFillLegend') || !this.fillShown()) return [];
    const pal = p.palette || 'M_2MTGLOBAL'; const [low, high] = paletteRange(getPalette(pal));
    return [{ id: 'model', palette: getPalette(pal), low, high, unit: p.unit, lut: this.lut(pal) }];
  }
  probeKind() { return this.fillShown() ? 'model' : null; }
  probeText(x: number) {
    const p = this.product('fill'); if (!p) return '';
    const [low, high] = paletteRange(getPalette(p.palette || 'M_2MTGLOBAL'));
    return `${p.caption}: ${fmtProbe(low + (high - low) * x)} ${p.unit}`;
  }
  mapLabel() {
    if (!this.enabled() || !settings.bool('settings.modelTimestamp')) return null;
    const { a } = this.frameAt(timeline.t); const c = this.config(); if (!a || !c) return null;
    return `${c.caption} ${new Date(a.run).toISOString().slice(11, 13)}Z +${a.hour}HR valid ${new Date(a.t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
  }
  invalidate() { this.rd1.invalidate(); this.rd2.invalidate(); }
}
