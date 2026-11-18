// Custom Radar Integration: a second radial engine for non-NEXRAD radars that publish Archive II
// volumes in HTTP directories. Servers are user-entered base URLs (no server ships with the app); a site's index is
// `<server>/<SITE>/` and the first server that lists volumes wins. Volumes decode on the frozen Archive II path and
// draw with the NEXRAD radial renderer. Fetches are direct, so a server must allow CORS.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, type LegendSpec } from './base';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';
import { fetchText } from '../data/net';
import { RadarDraw, Lut, uploadSweep, type SweepTex } from '../render/raster';
import { getPalette } from '../palettes/library';
import { PRODUCTS } from '../generated/products-catalog';
import { PointSet, TextSet, GlyphAtlas, SHAPE } from '../render/prims';
import type { L2Meta } from '../workers/decode.worker';
import type { NexradLayer } from './nexrad';
import { l2Moment } from '../radar/sources';
import { algorithmKey, columnNote, usesIsotherms, type L2BuildParams } from '../radar/l2products';
import { hailEnvironment, onIsotherms, pointKey, type RadarPoint } from '../radar/environment';
import { ptypeAt, ptypeLabel, type PtypeState, type PtypeTex } from '../render/ptype';
import { loadPref, savePref, isArray } from '../app/persist';

export interface CustomSite { name: string; state: string; place: string; lon: number; lat: number; elev: number }
/** A site's identity for loaded data: its name and location (a site file may move a name to other coordinates). */
const siteKey = (s: CustomSite | null) => (s ? `${s.name}@${s.lon},${s.lat},${s.elev}` : '');
/** `sweep.id` is the display identity it was built for (see CustomRadarLayer.identity); `req` the request in flight. */
interface Volume { name: string; url: string; t: number; size: number; meta?: L2Meta; sweep?: SweepTex & { elevation: number; id: string }; key?: string; req?: string; error?: string; pct: number }

/** Palette setting per Level 2 product index (0–7 base/dealiased, 8–19 derived products built by the same engine). */
export const CUSTOM_RADAR_PALETTE_KEYS = ['Reflectivity', 'BaseVelocity', 'SpectrumWidth', 'ZDR', 'PHI', 'CC', 'BaseVelocity', 'StormRelativeVelocity',
  'Shear', 'G2GShear', 'KDP', 'MEHS', 'POSH', 'VIL', 'VILD', 'ET', 'GUST'].map((k) => `settings.customRadarLevel2${k}Palette`)
  .concat(['ColumnZDR', 'ColumnKDP', 'HailCore'].map((k) => `ext.settings.customRadarLevel2${k}Palette`));
export const CUSTOM_RADAR_PRODUCT_COUNT = CUSTOM_RADAR_PALETTE_KEYS.length;

/** Sweep used for a product: volume products (MEHS…hail core, index ≥ 11) take the whole volume (sweep 0 handle). */
export function customRadarSweep(sweeps: { elevation: number; moments: string[] }[], product: number, angle: number): number {
  if (product >= 11) return sweeps.length ? 0 : -1;
  const need = l2Moment(product);
  return sweeps.findIndex((s) => Math.abs(s.elevation - angle) < 0.25 && !!need && s.moments.includes(need));
}

/** Parses "customradars.gis": one site per line, `name,state,place,lon,lat,elev_ft` (comma, tab or pipe separated; '#' comments). */
export function parseCustomSites(text: string): CustomSite[] {
  const out: CustomSite[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const f = line.split(/[,|\t]/).map((x) => x.trim());
    if (f.length < 5) continue;
    const lon = Number(f[3]), lat = Number(f[4]);
    if (!f[0] || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({ name: f[0].toUpperCase(), state: f[1], place: f[2], lon, lat, elev: Number(f[5]) || 0 });
  }
  return out;
}

/** Volume entries from a directory index: Apache/nginx/S3-style HTML links or a plain "size name" listing. */
export function parseVolumeIndex(text: string, base: string): { name: string; url: string; t: number; size: number }[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/href="([^"?#]+)"/gi)) names.add(decodeURIComponent(m[1].split('/').pop()!));
  // S3 ListObjects XML: keys are full object paths relative to the bucket root.
  const keys = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  const root = new URL('/', base).href;
  const urlOf = new Map<string, string>();
  for (const k of keys) { const n = k.split('/').pop()!; names.add(n); urlOf.set(n, new URL(k, root).href); }
  if (!names.size) for (const line of text.split(/\r?\n/)) { const w = line.trim().split(/\s+/).pop(); if (w) names.add(w); }
  const out: { name: string; url: string; t: number; size: number }[] = [];
  for (const n of names) {
    const m = /(\d{8})[_-]?(\d{6})/.exec(n);
    // Skip non-volume files: listings, checksums and the Model Data Message ("_MDM") companions of NEXRAD archives.
    if (!m || /\.(html?|txt|md5|json)$/i.test(n) || /_MDM$/i.test(n)) continue;
    const t = Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6));
    if (Number.isFinite(t)) out.push({ name: n, url: urlOf.get(n) ?? new URL(n, base).href, t, size: 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

export class CustomRadarLayer extends MapLayer {
  readonly id = 'customRadar';
  readonly title = 'Custom radar';
  sites: CustomSite[] = loadPref('customRadarSites', [], isArray);
  servers: string[] = loadPref('customRadarServers', [], isArray);
  log: string[] = [];
  volumes: Volume[] = [];
  tilts: number[] = [];
  tilt = 0;
  /** The site the loaded volumes belong to, as selected when loading began (name and location); null when none. */
  private loaded: CustomSite | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draw_: RadarDraw;
  private luts = new Map<string, Lut>();
  private dots: PointSet; private names: TextSet;
  private wipeStart = 0;
  /** Bumped when volumes are freed (site or server change, deactivation); async work of an older generation is dropped. */
  private gen = 0;
  /** The poll loop in progress; polls for the same site and servers coalesce into it. */
  private polling: { key: string; again: boolean; done: Promise<void> } | null = null;
  private readonly onPtype = () => this.draw_.invalidate();
  constructor(r: Renderer, atlas: GlyphAtlas, private nexrad: NexradLayer) {
    super(r); this.draw_ = new RadarDraw(r); this.dots = new PointSet(r); this.names = new TextSet(r, atlas); this.rebuildSites();
    // Hail products follow isotherms sampled at this layer's own site; storm-relative velocity follows the automatic
    // vector as soon as it appears or changes (not at the next poll).
    onIsotherms((key) => {
      const p = this.sitePoint();
      if (this.enabled() && p && key === pointKey(p) && usesIsotherms(this.product()) && this.algorithmParams().isothermAuto) this.reloadProducts();
    });
    nexrad.autoMotionListeners.add(() => { if (this.enabled() && this.product() === 7 && !settings.bool('settings.customRadarStormMotionCustom')) this.reloadProducts(); });
  }
  enabled() { return settings.bool('layerState.CustomRadarOn'); }
  /**
   * What a sweep means: site, product, tilt (volume products have none) and the product's algorithm inputs. A
   * sweep is drawn, probed and given a legend only under the identity it was built for.
   */
  identity(): string {
    const product = this.product(), tilt = product >= 11 ? '' : this.tilts[Math.min(this.tilt, this.tilts.length - 1)] ?? 0.5;
    return `${siteKey(this.loaded)}|${product}|${tilt}|${algorithmKey(product, this.algorithmParams(), !settings.bool('settings.customRadarStormMotionCustom') && !!this.nexrad.autoMotion)}`;
  }
  private algorithmParams() { return { ...this.nexrad.algorithmParams(), stormMotion: this.motion() }; }
  /** The loaded site (the one its volumes belong to) as an isotherm sampling point. */
  private sitePoint(): RadarPoint | null { const s = this.loaded; return s ? { lon: s.lon, lat: s.lat, elevM: s.elev * 0.3048 } : null; }
  /** Build parameters of `product` for a volume of this layer's site scanned at `volumeMs`. */
  private buildParams(product: number, volumeMs: number): L2BuildParams {
    const p = this.algorithmParams();
    return { ...p, envIsotherms: hailEnvironment(product, p.isothermAuto, this.sitePoint(), volumeMs) };
  }
  /** True while the loaded volumes belong to the selected site at its selected location. */
  private siteCurrent(): boolean { return !!this.loaded && siteKey(this.loaded) === siteKey(this.siteInfo()); }
  /** Volumes whose sweep matches the current identity, none unless they belong to the selected site. */
  private shown(): Volume[] { if (!this.siteCurrent()) return []; const id = this.identity(); return this.volumes.filter((v) => v.sweep?.id === id); }
  private dropSweep(v: Volume) { v.sweep?.tex.destroy(); v.sweep = undefined; }
  product() { return Math.max(0, Math.min(CUSTOM_RADAR_PRODUCT_COUNT - 1, Math.round(settings.num('layerState.CustomRadarProduct')))); }
  siteInfo() { return this.sites.find((s) => s.name === settings.str('layerState.CustomRadarSite')) ?? null; }
  private note(msg: string) { this.log.push(`${new Date().toLocaleTimeString()}  ${msg}`); if (this.log.length > 300) this.log.shift(); }

  /** A new site list: data of a site that moved or disappeared is freed now, and the loader restarts. */
  setSites(list: CustomSite[]) { this.sites = list; savePref('customRadarSites', list, 'custom radar sites'); this.rebuildSites(); if (this.enabled()) this.sync(); }
  /** A new server list: volumes listed from the earlier servers are freed now, and the loader restarts. */
  setServers(list: string[]) {
    const changed = list.join('\n') !== this.servers.join('\n');
    this.servers = list; savePref('customRadarServers', list, 'custom radar servers');
    if (!changed) return;
    if (this.volumes.length) this.note('Data servers changed. Freeing all volumes.');
    this.freeAll();
    if (this.enabled()) this.sync();
  }
  private rebuildSites() {
    this.dots.setPoints(this.sites.map((s) => ({ lon: s.lon, lat: s.lat, size: 6, shape: SHAPE.square, color: [255, 190, 60, 255] })));
    this.names.setLabels(this.sites.map((s) => ({ lon: s.lon, lat: s.lat, text: s.name, size: 11, color: [255, 210, 120, 255], halo: [0, 0, 0, 200], dx: 6, align: 'left' as const })));
  }

  /** Starts/stops polling (setting changes call this). */
  sync() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.enabled()) { if (this.volumes.length) this.note('Custom radar engine deactivated. Clearing any loaded volumes'); this.freeAll(); this.setStatus('off', ''); return; }
    this.checkSite();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), Math.max(10, settings.num('settings.customRadarPollingInterval')) * 1000);
  }
  freeAll() {
    this.gen++;
    for (const v of this.volumes) v.sweep?.tex.destroy();
    this.volumes = []; this.tilts = []; this.loaded = null; this.ptypeShown = null; this.wipeStart = 0;
  }
  /**
   * Frees everything loaded for a site that is no longer the selected one (another site, the same name at another
   * location, or no valid selection) as soon as the selection changes, before any poll for the new site runs.
   */
  private checkSite() {
    const s = this.siteInfo();
    if (this.loaded && siteKey(this.loaded) === siteKey(s)) return;
    if (this.loaded) this.note('Radar site switched. Freeing all volumes.');
    this.freeAll();
    this.loaded = s ? { ...s } : null;
    if (s) this.setStatus('loading', `Custom radar ${s.name}: loading`);
  }
  /** Rebuilds every volume for the current product/tilt/algorithm; sweeps of another meaning are freed now. */
  reloadProducts() {
    const id = this.identity();
    for (const v of this.volumes) { v.key = undefined; if (v.sweep && v.sweep.id !== id) this.dropSweep(v); }
    void this.loadAll();
  }

  /**
   * One loader pass (own polling timer; the app-wide refresh does not drive it). Overlapping calls for the same site
   * and servers coalesce; a call for another site starts at once (the older pass's results are dropped).
   */
  poll(): Promise<void> {
    this.checkSite();
    const key = `${siteKey(this.loaded)}|${this.servers.join(' ')}`;
    if (this.polling?.key === key) { this.polling.again = true; return this.polling.done; }
    const loop = { key, again: false, done: Promise.resolve() };
    this.polling = loop;
    loop.done = (async () => {
      do { loop.again = false; await this.pollOnce(); } while (loop.again && this.polling === loop);
    })().finally(() => { if (this.polling === loop) this.polling = null; });
    return loop.done;
  }

  private async pollOnce() {
    this.checkSite();
    const s = this.loaded;
    if (!s) { this.setStatus('error', 'Custom radar: choose a site (Site List tab)'); return; }
    if (!this.servers.length) { this.setStatus('error', 'Custom radar: add a data server (Data Servers tab)'); return; }
    this.note('Initiating index refresh check.');
    let items: ReturnType<typeof parseVolumeIndex> = [];
    const gen = this.gen;
    for (const srv of this.servers) {
      // "{SITE}" in a server URL is replaced by the site name (e.g. an S3 listing with a prefix); otherwise the
      // site directory is appended.
      const base = srv.includes('{SITE}') ? srv.replaceAll('{SITE}', s.name) : `${srv.replace(/\/+$/, '')}/${s.name}/`;
      let error = '';
      try { items = parseVolumeIndex(await fetchText(base, { cache: 'none' }), base); } catch (e) { items = []; error = (e as Error).message; }
      if (gen !== this.gen || !this.siteCurrent()) return; // site or servers switched while listing
      if (error) this.note(`${base}: ${error}`);
      else if (items.length) break;
    }
    if (!items.length) { this.note('Active radar index not found. Clearing any loaded volumes.'); this.freeAll(); this.setStatus('error', `Custom radar ${s.name}: no volumes found on the configured servers`); return; }
    const newest = items[items.length - 1];
    const ageDays = (Date.now() - newest.t) / 86400e3;
    if (ageDays > 1) this.note(`Radar site is down. Newest volume file ${ageDays.toFixed(1)} days ago at ${new Date(newest.t).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    const want = items.slice(-Math.max(3, settings.num('settings.customRadarMaxDownloadVolumes')));
    for (const it of want) if (!this.volumes.some((v) => v.url === it.url)) { this.note(`Adding new discovered volume: ${it.name}`); this.volumes.push({ ...it, pct: 0 }); }
    this.volumes.sort((a, b) => a.t - b.t);
    const maxMem = Math.max(10, settings.num('settings.customRadarMaxMemoryVolumes'));
    if (this.volumes.length > maxMem) {
      const drop = this.volumes.length - maxMem;
      this.note(`Releasing volumes 0 through ${drop - 1}`);
      for (const v of this.volumes.splice(0, drop)) v.sweep?.tex.destroy();
    }
    await this.loadAll();
  }

  private async loadAll() {
    const gen = this.gen;
    for (const v of [...this.volumes].reverse()) { if (gen !== this.gen) return; await this.loadVolume(v); }
    if (gen !== this.gen || !this.siteCurrent()) return;
    const ok = this.shown().length;
    this.setStatus(ok ? 'ready' : 'error', `Custom radar ${this.loaded!.name}: ${ok}/${this.volumes.length} volumes`);
  }

  /**
   * Builds the current product for one volume. Metadata belongs to the volume file and is kept whatever is selected
   * meanwhile; everything the build means (site, product, tilt, algorithm inputs) is read once, after the last
   * metadata await and before any build state changes, so a selection made while metadata was loading is built under
   * its own identity and an earlier one is never built or labelled with it. The newest request for a volume wins; a
   * result is applied only while its request is still the volume's newest and the identity is unchanged. When the
   * product cannot be built (missing from the volume, unavailable, failed), no sweep of another meaning stays behind.
   */
  private async loadVolume(v: Volume) {
    const gen = this.gen;
    const stale = () => gen !== this.gen || !this.volumes.includes(v) || !this.siteCurrent();
    let key = '';
    try {
      if (!v.meta) {
        const meta = await pool.for(this.id).run<L2Meta>('l2.meta', { url: v.url, live: false }, v.url);
        if (stale()) return;
        if (!v.meta) { v.meta = meta; v.pct = 100; if (meta.volumeTimeMs) v.t = meta.volumeTimeMs; }
      }
      const meta = v.meta;
      if (v === this.volumes[this.volumes.length - 1]) this.tilts = [...new Set(meta.sweeps.map((s) => Math.round(s.elevation * 10) / 10))].sort((a, b) => a - b);
      const product = this.product(), id = this.identity();
      const want = this.tilts[Math.min(this.tilt, this.tilts.length - 1)] ?? 0.5;
      const sweepIdx = customRadarSweep(meta.sweeps, product, want);
      const params = this.buildParams(product, v.t);
      key = `${id}|${sweepIdx}|${JSON.stringify(params)}`;
      if (v.key === key) { v.req = undefined; return; } // already built; an older request in flight is superseded
      if (v.req === key) return;
      if (sweepIdx < 0) { v.error = 'not available for this volume'; this.dropSweep(v); v.key = key; v.req = undefined; return; }
      v.req = key;
      const res = await pool.for(this.id).run('l2.product', { url: v.url, live: false, sweep: sweepIdx, product, params }, v.url);
      if (v.req !== key) return; // a newer request for this volume replaced this one
      v.req = undefined;
      if (stale() || this.identity() !== id) return;
      if (!res.sweep) { v.error = 'product unavailable'; this.dropSweep(v); v.key = key; return; }
      const old = v.sweep;
      v.sweep = { ...uploadSweep(this.r, res.sweep, this.id), elevation: res.sweep.elevation, id };
      if (!old && settings.num('settings.customRadarUpdateEffect') === 1 && v === this.volumes[this.volumes.length - 1]) this.wipeStart = performance.now();
      old?.tex.destroy();
      v.key = key; v.error = undefined;
    } catch (e) {
      if (key) { if (v.req !== key) return; v.req = undefined; } // a failed build superseded by a newer request
      if (stale()) return;
      v.error = (e as Error).message; this.note(`${v.name}: ${v.error}`);
      // A failed rebuild of the same meaning keeps the previous sweep; anything else is removed.
      if (v.sweep && v.sweep.id !== this.identity()) this.dropSweep(v);
      v.key = undefined;
    }
  }

  /** Storm motion: manual vector, or the NEXRAD automatic (L3) vector when available. */
  motion() {
    if (settings.bool('settings.customRadarStormMotionCustom')) return { speedKt: settings.num('settings.customRadarStormMotionSpeed'), fromDeg: settings.num('settings.customRadarStormMotionAzimuth') };
    return this.nexrad.autoMotion ? { speedKt: this.nexrad.autoMotion.speedKt, fromDeg: this.nexrad.autoMotion.fromDeg } : { speedKt: settings.num('settings.customRadarStormMotionSpeed'), fromDeg: settings.num('settings.customRadarStormMotionAzimuth') };
  }

  private range() {
    const i = this.product(), p = PRODUCTS.level2[i];
    const sixteen = i === 4 || (i === 3 && this.shown().some((v) => v.sweep!.tex.format !== 'r8unorm'));
    return { low: p.low, high: p.high, unit: p.unit, reserve: p.reserve, palette: settings.str(CUSTOM_RADAR_PALETTE_KEYS[i]), top: sixteen ? 65535 : 255 };
  }
  private lut(name = this.range().palette) {
    const d = this.range(), key = `${name}|${d.low}|${d.high}|${d.top}|${d.reserve}`;
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low: d.low, high: d.high, reserve: d.reserve, showRF: d.reserve, topCode: d.top }); this.luts.set(key, l); }
    return l;
  }
  /** Reflectivity typing follows the NEXRAD switch and uses the Level 2 p-type palettes. */
  typed() { return this.product() === 0 && settings.bool('settings.nexradPrecipitationTyping'); }
  private ptypeShown: PtypeState<PtypeTex> | null = null;
  legends(): LegendSpec[] {
    const shown = this.enabled() ? this.shown() : [];
    if (!shown.length) return [];
    const d = this.range();
    const note = this.typed() && this.ptypeShown ? ptypeLabel(this.ptypeShown) : columnNote(this.product(), () => this.buildParams(this.product(), shown[shown.length - 1].t));
    if (this.typed() && this.ptypeShown?.status === 'ready') {
      const k = this.nexrad.ptypeKeys(true), L = (key: string) => ({ palette: getPalette(settings.str(key)), lut: this.lut(settings.str(key)) });
      return [{ id: this.id, ...L(k.rain), low: d.low, high: d.high, unit: d.unit, reserve: d.reserve, note, extra: [{ label: 'Snow', ...L(k.snow) }, { label: 'FrzRain', ...L(k.fr) }, ...(settings.bool('settings.generalPrecipTypingSleetEnabled') ? [{ label: 'Sleet', ...L(k.ip) }] : [])] }];
    }
    return [{ id: this.id, palette: getPalette(d.palette), low: d.low, high: d.high, unit: d.unit, reserve: d.reserve, lut: this.lut(), note }];
  }

  draw(ctx: DrawContext) {
    if (!ctx.probe && settings.bool('settings.customRadarSitesOn') && this.sites.length) { this.dots.draw(ctx); this.names.draw(ctx); }
    if (!this.enabled()) return;
    const frames = this.shown().map((v) => ({ t: v.t, f: v })); // none unless the loaded site is the selected one
    const s = this.loaded;
    if (!frames.length || !s) { this.ptypeShown = null; return; }
    const { a } = bracket(frames, timeline.t, false, 30 * 60e3);
    const sw = a?.f.sweep ?? frames[frames.length - 1]?.f.sweep;
    if (!sw) return;
    const vt = a?.f.t ?? frames[frames.length - 1].t;
    let lut = this.lut(), ptype = null;
    if (this.typed()) {
      const st = ptypeAt(this.r, vt, this.onPtype);
      this.ptypeShown = st;
      if (st.status === 'ready') {
        const k = this.nexrad.ptypeKeys(true);
        lut = this.lut(settings.str(k.rain));
        ptype = { tex: st.value.tex, proj: st.value.proj, snow: this.lut(settings.str(k.snow)), fr: this.lut(settings.str(k.fr)), ip: this.lut(settings.str(k.ip)),
          gradient: settings.num('settings.generalPrecipTypingRainSnowLineGradientWidth'), prob: settings.bool('settings.generalPrecipTypingProbabilityRendering'), sleet: settings.bool('settings.generalPrecipTypingSleetEnabled') };
      }
    } else this.ptypeShown = null;
    const dur = settings.num('settings.customRadarSweepDuration') * 1000;
    const wipe = this.wipeStart && performance.now() - this.wipeStart < dur ? (performance.now() - this.wipeStart) / dur : -1;
    this.draw_.draw(ctx, {
      site: { lon: s.lon, lat: s.lat, heightKm: (s.elev * 0.3048) / 1000 }, elevation: sw.elevation, a: sw, b: null, w: 0, wipe, progress: 1,
      alpha: settings.num('settings.customRadarDataAlpha') / 255, smoothing: settings.bool('settings.customRadarSmoothing'),
      tilt3D: settings.bool('settings.nexrad3DTilt'), exaggeration: settings.num('settings.nexrad3DTiltExaggeration'), shadow: false, azOffset: 0, lut, ptype,
    });
  }
}
