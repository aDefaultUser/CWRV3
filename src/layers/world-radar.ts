// Worldwide Weather → Radar: the RainViewer global radar mosaic (Weather Maps API v2, public endpoint; RainViewer's API
// transition summary keeps it free for personal and educational use), credited on the map. Opt-in: off by default and
// enabled only after the user has accepted the provider's terms. The frame list (weather-maps.json, the past ~2 h at 10-minute steps) names
// opaque frame paths on one tile host; tiles in view are fetched directly (the host sends CORS headers), at most
// level 7 (native; deeper views upscale), under a request budget of 80 per rolling minute for every request this app
// makes to RainViewer (one of them always left to the frame list), with a back-off after a rate-limit answer. Tiles are RGBA images (colour scheme 2): there is no
// value to probe. Transparent means either no precipitation detected or no radar coverage; the optional coverage
// mask shades the areas without coverage.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, NOT_AVAILABLE, type LegendSpec } from './base';
import { timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { fetchText, HttpError } from '../data/net';
import { Lut } from '../render/raster';
import { parsePalette } from '../render/palette';
import { selectTiles } from '../render/tiles';
import { OverlayTileCache, RequestBudget, retryAfterMs, type TileHit } from '../render/overlay-tiles';
import { pickValidFrame, hhmmZ, dateTimeZ, type Attribution } from './world-common';

export const RV_MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
export const RV_HOST = 'https://tilecache.rainviewer.com';
export const RV_SITE = 'https://www.rainviewer.com/';
export const RV_API_DOCS = 'https://www.rainviewer.com/api/weather-maps-api.html';
export const RV_TERMS = 'https://www.rainviewer.com/terms.html';
/** Deepest native tile level; deeper levels return placeholder images. */
export const RV_MAX_Z = 7;
/** Requests to RainViewer per rolling minute (frame list, radar and coverage tiles together). */
export const RV_BUDGET_PER_MIN = 80;
/**
 * Tile size: a 512 px tile holds the same pixels as its four 256 px children (checked against the live service), so
 * a view needs a quarter of the requests. Tiles drawn per view at most while paused (the view is split more coarsely
 * beyond), and atlas slots (1 MiB each, 90 MiB in all; while the loop plays every frame of it shares them).
 */
export const RV_TILE_PX = 512;
const MAX_VIEW_TILES = 24;
export const RV_ATLAS_SLOTS = 90;
/** Frames are 10 minutes apart; the newest stays shown until its successor can be listed. */
const RV_STEP_MS = 10 * 60e3, MATCH_MS = 11 * 60e3, NEWEST_MS = 25 * 60e3;
/** Past frames in a frame list (~2 hours). */
const RV_LIST_FRAMES = 13;
/**
 * How far back the frame list can hold a frame for a loop window: its ~2 hours, the newest frame published up to
 * ~10 minutes late, and a generous half hour more. An archive window ending earlier is not requested at all.
 */
export const RV_REACH_MS = 160 * 60e3;
/** The frame list is fetched at most this often (it changes every 10 minutes). */
const LIST_INTERVAL_MS = 120_000;

export interface RvFrame { t: number; path: string }

/**
 * Validated frame list of a weather-maps.json document: the tile host must be exactly RV_HOST, and only past radar
 * frames with an integer time and an opaque `/v2/radar/<hex>` path are kept (sorted by time). Throws when the
 * document is not usable.
 */
export function parseWeatherMaps(doc: unknown): { generatedMs: number; frames: RvFrame[] } {
  const d = doc as { host?: unknown; generated?: unknown; radar?: { past?: unknown } } | null;
  if (!d || typeof d !== 'object') throw new Error('RainViewer: not a frame list');
  if (d.host !== RV_HOST) throw new Error(`RainViewer: unexpected tile host ${JSON.stringify(d.host)}`);
  const past = Array.isArray(d.radar?.past) ? d.radar!.past as { time?: unknown; path?: unknown }[] : [];
  const frames: RvFrame[] = [];
  for (const f of past) {
    if (!Number.isInteger(f?.time) || typeof f.path !== 'string' || !/^\/v2\/radar\/[0-9a-f]{6,64}$/.test(f.path)) continue;
    const t = (f.time as number) * 1000;
    if (t > 1e12 && !frames.some((x) => x.t === t)) frames.push({ t, path: f.path });
  }
  if (!frames.length) throw new Error('RainViewer: no radar frames listed');
  frames.sort((a, b) => a.t - b.t);
  return { generatedMs: Number.isInteger(d.generated) ? (d.generated as number) * 1000 : frames[frames.length - 1].t, frames };
}

/** Radar tile of a frame: RV_TILE_PX, colour scheme 2 (the API's only scheme), smoothing option, no snow colours. */
export const radarTileUrl = (path: string, z: number, x: number, y: number, smooth: boolean) => `${RV_HOST}${path}/${RV_TILE_PX}/${z}/${x}/${y}/2/${smooth ? 1 : 0}_0.png`;
/** Coverage mask tile: opaque where no radar covers the area. */
export const coverageTileUrl = (z: number, x: number, y: number) => `${RV_HOST}/v2/coverage/0/${RV_TILE_PX}/${z}/${x}/${y}/0/0_0.png`;

/** Colour scheme 2 ("Universal Blue", rain), every 5 dBZ from RainViewer's published colour table (rainviewer_api_colors_table.csv). */
const UNIVERSAL_BLUE = [
  [-10, '63615914'], [-5, '726e612e'], [0, '827b6949'], [5, '92887164'], [10, 'cec08796'], [15, '88ddeeff'], [20, '00a3e0ff'], [25, '0077aaff'],
  [30, '005588ff'], [35, 'ffee00ff'], [40, 'ffaa00ff'], [45, 'ff4400ff'], [50, 'c10000ff'], [55, 'ffaaffff'], [60, 'ff77ffff'], [65, 'ffffffff'], [70, 'ffffffff'],
] as const;
const legendPalette = () => parsePalette(['RainViewer Universal Blue', ...UNIVERSAL_BLUE.map(([v, h]) => `${[0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',')}|${v}`)].join('\n'));

export class WorldRadarLayer extends MapLayer {
  readonly id = 'worldRadar';
  readonly title = 'World radar (RainViewer)';
  readonly archive = 'window';
  readonly budget = new RequestBudget(RV_BUDGET_PER_MIN, 60_000);
  private cache: OverlayTileCache;
  private frames: RvFrame[] = [];
  private listedAt = 0;
  /** Mode/archive time the frame list was requested under; a response for another is discarded. */
  private listKey = '';
  private listError = '';
  private frameNo = 0;
  private tileBuf: GPUBuffer | null = null;
  private ubuf: GPUBuffer | null = null;
  private bg: GPUBindGroup | null = null;
  private bgTex: GPUTexture | null = null;
  private lut: Lut | null = null;
  /**
   * Tiles of the drawn frame in view, how many of them are drawn from their own data, and over how many the coverage
   * mask is not known yet (not loaded, or failed): clear there does not mean covered.
   */
  view = { tiles: 0, exact: 0, frame: null as RvFrame | null, coverUnknown: 0, coverFailed: 0 };
  private viewKey = '';
  constructor(r: Renderer) { super(r); this.cache = new OverlayTileCache(r, this.budget, () => { this.updateStatus(); this.onTiles(); }, RV_ATLAS_SLOTS, 4, RV_TILE_PX); }
  /** Called when a tile arrives (the app redraws). */
  onTiles: () => void = () => {};

  /** The setting is on and the provider's terms were accepted in this browser. */
  enabled() { return settings.bool('ext.layerState.WorldRadarOn') && termsAccepted(); }
  smooth() { return settings.bool('ext.layerState.WorldRadarSmooth'); }
  coverage() { return settings.bool('ext.layerState.WorldRadarCoverage'); }

  /** An archive loop window that ends before anything the frame list can hold. */
  beyondReach() { return timeline.mode === 'archive' && timeline.loopEnd < Date.now() - RV_REACH_MS; }
  /** Frames inside the loop window (the list only reaches back ~2 hours). */
  framesInWindow(): RvFrame[] { return this.frames.filter((f) => f.t >= timeline.loopStart - MATCH_MS && f.t <= timeline.loopEnd + 60e3); }
  shown(): RvFrame | null {
    const fs = this.framesInWindow();
    return pickValidFrame(fs, timeline.t, fs.length ? fs[fs.length - 1].t : 0, MATCH_MS, NEWEST_MS);
  }

  async refresh() {
    if (!this.enabled()) {
      this.frames = []; this.listedAt = 0; this.listKey = ''; this.cache.clear(); this.bg = null; this.bgTex = null;
      this.setStatus('off', '');
      return;
    }
    const key = timeline.key;
    if (this.beyondReach()) { this.frames = []; this.listKey = key; this.listError = ''; this.updateStatus(); return; }
    if (key === this.listKey && Date.now() - this.listedAt < LIST_INTERVAL_MS) { this.updateStatus(); return; }
    if (!this.budget.take()) { this.updateStatus(); return; }
    if (!this.frames.length) this.setStatus('loading', 'Loading the RainViewer frame list…');
    this.listKey = key;
    this.listedAt = Date.now();
    try {
      const list = parseWeatherMaps(JSON.parse(await fetchText(RV_MAPS_URL, { cache: 'none', timeoutMs: 20_000 })));
      if (key !== timeline.key || !this.enabled()) return; // mode or archive time changed, or switched off, meanwhile
      this.budget.ok();
      this.frames = list.frames;
      this.listError = '';
    } catch (e) {
      // The pause applies to all RainViewer requests, even if the timeline changed during this request.
      if (e instanceof HttpError && e.status === 429) this.budget.limited(retryAfterMs(e.retryAfter));
      if (key !== timeline.key || !this.enabled()) return;
      this.listError = `frame list failed: ${(e as Error).message}`;
      this.listedAt = Date.now() - LIST_INTERVAL_MS + 30_000; // retried after 30 s at the earliest
    }
    this.updateStatus();
  }

  private updateStatus() {
    if (!this.enabled()) return;
    if (this.beyondReach()) { this.setStatus('unavailable', `${NOT_AVAILABLE} (RainViewer keeps only the past ~2 hours)`); return; }
    const paused = this.budget.pausedFor();
    const wait = paused ? `; RainViewer rate limit: paused ${Math.ceil(paused / 1000)} s` : '';
    if (!this.frames.length) { this.setStatus(this.listError ? 'error' : 'loading', this.listError || 'Loading the RainViewer frame list…'); return; }
    const fs = this.framesInWindow();
    if (!fs.length) { this.setStatus('unavailable', timeline.mode === 'archive' ? NOT_AVAILABLE : 'no RainViewer frame in the loop window'); return; }
    const f = this.view.frame, v = this.view;
    const tiles = f && v.tiles ? `, tiles ${v.exact}/${v.tiles}` : '';
    const cover = f && v.coverUnknown ? `; ${this.coverText()}` : '';
    const err = this.cache.lastError && this.cache.failed ? `; ${this.cache.failed} tile errors (last: ${this.cache.lastError})` : '';
    const text = `RainViewer: ${fs.length} frames ${hhmmZ(fs[0].t).slice(0, 5)}–${hhmmZ(fs[fs.length - 1].t)}${f ? `, showing ${hhmmZ(f.t)}${tiles}` : ', no frame at this time'}${cover}${this.listError ? `; ${this.listError}` : ''}${wait}${err}`;
    this.setStatus(f && (v.tiles > v.exact || v.coverUnknown) ? 'loading' : 'ready', text, { frames: fs.length, newestMs: fs[fs.length - 1].t });
  }
  private coverText() {
    const v = this.view;
    return `coverage unknown in ${v.coverUnknown} of ${v.tiles} tiles${v.coverFailed ? ` (${v.coverFailed} failed)` : ' (loading)'}`;
  }

  mapLabel(): string | null {
    if (!this.enabled() || !this.frames.length) return null;
    const f = this.shown();
    // Tiles of this frame still missing are left empty (or drawn from a coarser tile of the same frame): say so.
    const same = this.view.frame === f, missing = same ? this.view.tiles - this.view.exact : 0;
    const notes = [missing > 0 ? `loading ${missing} of ${this.view.tiles} tiles` : '', same && this.view.coverUnknown ? this.coverText() : ''].filter(Boolean).join('; ');
    return f ? `World radar: RainViewer mosaic, frame ${dateTimeZ(f.t)}${notes ? ` (${notes})` : ''}` : 'World radar (RainViewer): no frame for this time';
  }
  /** RainViewer's credit, shown whenever its data is drawn (a frame is shown). */
  attribution(): Attribution[] { return this.shown() ? [{ text: 'Radar: RainViewer', href: RV_SITE, title: 'Global radar mosaic by RainViewer (rainviewer.com); opens in a new tab' }] : []; }

  legends(): LegendSpec[] {
    if (!this.enabled() || !settings.bool('ext.layerState.WorldRadarLegend') || !this.shown()) return [];
    const palette = legendPalette();
    this.lut ??= new Lut(this.r, palette, { low: -10, high: 70, raster: false });
    return [{ id: this.id, palette, low: -10, high: 70, unit: 'dBZ', lut: this.lut, note: this.coverage() ? 'RainViewer · shaded: no radar coverage' : 'RainViewer · clear: no echo or no coverage' }];
  }

  /**
   * Tiles each frame may use. While the loop plays, the tiles of every frame in the loop and of the coverage mask
   * must fit in the atlas together (else every pass of the loop fetches them again), so the view is split more
   * coarsely; paused, the frame shown gets the detailed split.
   */
  tileCap(): number {
    if (!timeline.playing) return MAX_VIEW_TILES;
    // Frames the loop window can hold (its length, the inclusion slack either side, 10-minute steps, at most the list's
    // ~2 hours), not the frames it holds now: that count changes as the window moves, and so would every tile.
    const span = timeline.loopEnd - timeline.loopStart + MATCH_MS + 60e3;
    const frames = Math.max(this.framesInWindow().length, Math.min(RV_LIST_FRAMES, Math.floor(span / RV_STEP_MS) + 1));
    const sets = frames + (this.coverage() ? 1 : 0);
    return Math.max(1, Math.min(MAX_VIEW_TILES, Math.floor(RV_ATLAS_SLOTS / sets)));
  }

  /**
   * Mercator tiles covering the whole view, at most `cap`: the finest split that fits, else the whole view at level
   * 1 (four tiles) or 0. Nothing visible is left out: a tile is culled only when none of it can be visible, and the
   * list is never cut short.
   */
  viewTiles(cap: number): number[][] {
    const cam = this.r.camera, dpr = this.r.gpu.dpr;
    let split = 2 * RV_TILE_PX * dpr * 0.9; // drawn at 0.9–1.8× their size
    for (let i = 0; i < 8; i++, split *= 2) {
      const t = selectTiles(cam, dpr, RV_MAX_Z, split, cap + 1, 2, true);
      if (t.length <= cap) return t;
    }
    const z = cap >= 4 ? 1 : 0;
    return selectTiles(cam, dpr, z, Infinity, 4, z);
  }

  draw(ctx: DrawContext) {
    if (!this.enabled() || ctx.probe) return;
    const f = this.shown();
    this.view = { tiles: 0, exact: 0, frame: f, coverUnknown: 0, coverFailed: 0 };
    if (!f) {
      if (this.viewKey) { this.viewKey = ''; this.updateStatus(); }
      return;
    }
    this.frameNo++;
    const smooth = this.smooth(), id = `${f.path}|${smooth ? 1 : 0}`, cover = this.coverage();
    const tiles = this.viewTiles(this.tileCap());
    const inst: number[] = [];
    const add = (h: TileHit, z: number, x: number, y: number, kind: number) => inst.push(z, x, y, h.slot, h.u0, h.v0, h.scale, kind);
    tiles.forEach(([z, x, y], i) => {
      this.view.tiles++;
      if (cover) {
        // The mask is time-independent and fetched one level coarser (a quarter of the requests); it is drawn over
        // each radar tile's own footprint, so masks of different levels never overlap (no doubled shade).
        const cz = Math.max(0, z - 1), cx = x >> (z - cz), cy = y >> (z - cz), n = 2 ** (z - cz);
        const h = this.cache.lookup('coverage', cz, cx, cy, () => coverageTileUrl(cz, cx, cy), this.frameNo, 1000 + i);
        if (h) add({ ...h, u0: h.u0 + (h.scale * (x % n)) / n, v0: h.v0 + (h.scale * (y % n)) / n, scale: h.scale / n }, z, x, y, 1);
        else { this.view.coverUnknown++; if (this.cache.failedTile('coverage', cz, cx, cy)) this.view.coverFailed++; }
      }
      const h = this.cache.lookup(id, z, x, y, () => radarTileUrl(f.path, z, x, y, smooth), this.frameNo, i);
      if (!h) return;
      if (h.z === z) this.view.exact++;
      add(h, z, x, y, 0);
    });
    this.cache.pump(this.frameNo);
    const viewKey = `${f.path}|${this.view.exact}/${this.view.tiles}|${this.view.coverUnknown}/${this.view.coverFailed}`;
    if (viewKey !== this.viewKey) { this.viewKey = viewKey; this.updateStatus(); }
    const tex = this.cache.tex, n = inst.length / 8;
    if (!tex || !n) return;
    const d = this.r.gpu.device;
    if (!this.tileBuf || this.tileBuf.size < inst.length * 4) { this.tileBuf?.destroy(); this.tileBuf = d.createBuffer({ size: Math.max(inst.length * 4, 2 * MAX_VIEW_TILES * 32), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); this.bg = null; }
    this.ubuf ??= d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.tileBuf, 0, new Float32Array(inst));
    d.queue.writeBuffer(this.ubuf, 0, new Float32Array([settings.num('ext.layerState.WorldRadarAlpha') / 255, 0, 0, 0, 0.35, 0.37, 0.42, 0.55]));
    if (!this.bg || this.bgTex !== tex) {
      this.bgTex = tex;
      this.bg = d.createBindGroup({ layout: this.r.layouts.overlayTiles, entries: [
        { binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: { buffer: this.tileBuf } },
        { binding: 2, resource: tex.createView({ dimension: '2d-array' }) }, { binding: 3, resource: this.r.gpu.samplers.linear }] });
    }
    ctx.pass.setPipeline(this.r.pipe('overlayTiles'));
    ctx.pass.setBindGroup(1, this.bg);
    ctx.pass.draw(16 * 16 * 6, n);
  }
}

/** Whether the RainViewer terms were accepted in this browser (a configuration setting, not part of layer presets). */
export const termsAccepted = () => settings.bool('ext.config.worldRadarTermsAccepted');
