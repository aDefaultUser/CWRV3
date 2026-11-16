// Surface tab: METAR station plots (instruction-recovered parsing, derived fields, weather classes,
// display filters and probe text) and NDBC buoy/ship observations, with declutter by spacing,
// palettes per field, wind barbs, weather icons, temporal selection along the main timeline and the buoy explorer.
import type { DrawContext, Renderer } from '../render/renderer';
import type { GlyphAtlas, Label, PointSpec, Polyline } from '../render/prims';
import { LineSet, PointSet, TextSet, SHAPE, declutterBoxes, type Color } from '../render/prims';
import { MapLayer } from '../layers/base';
import { settings } from '../settings/store';
import { fetchBytes, fetchText } from '../data/net';
import { gunzip } from '../decode/zip';
import { getPalette } from '../palettes/library';
import { evalPalette } from '../render/palette';
import { timeline } from '../app/timeline';
import { parseMetar, metarValue, interpolateMetar, metarDrawn, metarProbe, marineValue, marineDrawn, marineProbe, MISSING, type MetarReport, type MarineObs } from './surface-math';
import { rne } from '../util/round';
import { lonLatToXYZ } from '../render/camera';

const METAR_PALETTES = ['settings.metarTempColorPalette', 'settings.metarDewPTColorPalette', 'settings.metarWindColorPalette', '', '', 'settings.metarGustColorPalette', 'settings.metarRHColorPalette', 'settings.metarWindChillColorPalette', 'settings.metarHeatIndexColorPalette'];
const MARINE_PALETTES = ['settings.ndbcWindColorPalette', 'settings.ndbcGustColorPalette', 'settings.ndbcWindColorPalette', 'settings.ndbcGustColorPalette', 'settings.ndbcTempColorPalette', 'settings.ndbcWaterTempColorPalette', 'settings.ndbcDewPTColorPalette', '', 'settings.ndbcWaveHtColorPalette', 'settings.ndbcWavePdColorPalette'];
const fmtTime = (ms: number) => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Weather icon per class (vendor sheet not shipped; drawn as SDF symbols). Class > 22 adds thunder. */
export function wxIcon(c: number): { shape: number; color: Color } | null {
  const k = c > 22 ? c - 22 : c;
  if (c === 22) return { shape: SHAPE.bolt, color: [255, 230, 60, 255] };
  if (k >= 2 && k <= 4) return { shape: SHAPE.dot, color: [60, 200, 80, 255] };
  if (k >= 5 && k <= 7) return { shape: SHAPE.dot, color: [120, 220, 140, 255] };
  if (k >= 8 && k <= 10) return { shape: SHAPE.plus, color: [140, 190, 255, 255] };
  if (k === 11) return { shape: SHAPE.triUp, color: [220, 160, 255, 255] };
  if (k === 12) return { shape: SHAPE.diamond, color: [170, 210, 255, 255] };
  if (k >= 13 && k <= 18) return { shape: SHAPE.diamond, color: [255, 120, 190, 255] };
  if (k === 19 || k === 20) return { shape: SHAPE.square, color: [190, 190, 190, 255] };
  if (k === 21) return { shape: SHAPE.triDown, color: [255, 60, 60, 255] };
  return null;
}

/** Wind barb polyline (knots) in lon/lat, staff toward the direction the wind blows from, sized in screen pixels. */
export function barb(lon: number, lat: number, kt: number, fromDeg: number, degPerPx: number, sizePx = 22): number[][] {
  const out: number[][] = [];
  const k = Math.cos((lat * Math.PI) / 180) || 1e-6;
  const a = (fromDeg * Math.PI) / 180;
  const ux = Math.sin(a), uy = Math.cos(a); // unit vector toward the source
  const px = -uy, py = ux;                  // perpendicular (barbs on the left in the NH convention)
  const L = sizePx * degPerPx;
  const pt = (s: number, t: number) => [lon + (ux * s + px * t) / k, lat + uy * s + py * t];
  const tip = pt(L, 0);
  out.push([lon, lat, ...tip]);
  let v = Math.round(kt / 5) * 5, pos = L;
  const step = L * 0.14, flag = L * 0.4;
  while (v >= 50) { const b0 = pt(pos, 0), b1 = pt(pos - step, flag), b2 = pt(pos - step * 1.6, 0); out.push([...b0, ...b1, ...b2]); pos -= step * 2; v -= 50; }
  while (v >= 10) { out.push([...pt(pos, 0), ...pt(pos + step * 0.6, flag)]); pos -= step; v -= 10; }
  if (v >= 5) { if (pos === L) pos -= step; out.push([...pt(pos, 0), ...pt(pos + step * 0.3, flag / 2)]); }
  return out;
}

abstract class StationLayer extends MapLayer {
  protected text: TextSet; protected pts: PointSet; protected lines: LineSet;
  private camKey = ''; private dataKey = '';
  protected items: { lon: number; lat: number; label: Label | null; icon: PointSpec | null; wind: { kt: number; dir: number } | null; priority: number; probe: () => string[] }[] = [];
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r); this.text = new TextSet(r, atlas); this.pts = new PointSet(r); this.lines = new LineSet(r); }
  abstract spacing(): number;
  abstract build(): void;
  abstract alpha(): number;
  protected key(): string { return ''; }
  tick(t: number) {
    if (!this.enabled()) return;
    const dk = this.key() + '|' + Math.floor(t / 60e3);
    if (dk !== this.dataKey) { this.dataKey = dk; this.build(); this.camKey = ''; }
    const c = this.r.camera.cur;
    const ck = `${c.lon.toFixed(3)},${c.lat.toFixed(3)},${c.z.toFixed(2)},${c.tilt.toFixed(0)},${c.swivel.toFixed(0)},${this.r.camera.width}`;
    if (ck === this.camKey) return;
    this.camKey = ck;
    this.place();
  }
  /** Declutter: stations closer than the spacing to an already placed higher-priority station are hidden. */
  private place() {
    const vis = declutterBoxes(this.r, this.items.map((it) => ({ lon: it.lon, lat: it.lat, w: 26, h: 14, priority: it.priority })), this.spacing());
    const labels: Label[] = [], icons: PointSpec[] = [], lines: Polyline[] = [];
    const degPerPx = this.r.camera.metersPerPixel() / 111320;
    const a = this.alpha();
    this.items.forEach((it, i) => {
      if (!vis[i]) return;
      if (it.label) labels.push({ ...it.label, color: [it.label.color[0], it.label.color[1], it.label.color[2], Math.round(it.label.color[3] * a)] });
      if (it.icon) icons.push({ ...it.icon, color: [it.icon.color[0], it.icon.color[1], it.icon.color[2], Math.round(it.icon.color[3] * a)] });
      if (it.wind && it.wind.kt >= 2.5) for (const seg of barb(it.lon, it.lat, it.wind.kt, it.wind.dir, degPerPx)) lines.push({ coords: seg, style: 0 });
    });
    this.text.setLabels(labels); this.pts.setPoints(icons); this.lines.setLines(lines);
    this.lines.setStyles([{ color: [235, 240, 255, Math.round(230 * a)], width: 1.4 }]);
  }
  draw(ctx: DrawContext) { if (!this.enabled() || ctx.probe) return; this.lines.draw(ctx); this.pts.draw(ctx); this.text.draw(ctx); }
  probeAt(_lon: number, _lat: number, x: number, y: number): string[] | null {
    if (!this.enabled()) return null;
    let best = -1, bd = 14;
    this.items.forEach((it, i) => { const [px, py, f] = this.r.camera.project(lonLatToXYZ(it.lon, it.lat)); if (!f) return; const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    return best >= 0 ? this.items[best].probe() : null;
  }
}

function colorOf(paletteSetting: string, v: number): Color {
  if (!paletteSetting) return [235, 240, 255, 255];
  const c = evalPalette(getPalette(settings.str(paletteSetting)).frames[0], v);
  return [c[0], c[1], c[2], Math.max(200, c[3])];
}

/** Display priority (stand-in for the vendor station prominence byte): 3-letter-code airports first. */
export const stationPriority = (id: string) => (/^K[A-Z]{3}$/.test(id) ? 3 : /^[CKP][A-Z]{3}$/.test(id) ? 2 : /^[A-Z]{4}$/.test(id) ? 1 : 0);

export class MetarLayer extends StationLayer {
  readonly id = 'metar';
  readonly title = 'METAR observations';
  /** Reports per station, oldest first (history accumulates from the feed while the app runs). */
  history = new Map<string, { lon: number; lat: number; reports: MetarReport[] }>();
  private at = 0;
  enabled() { return settings.bool('layerState.METAROn'); }
  spacing() { return settings.num('settings.metarSpacing'); }
  alpha() { return settings.num('settings.metarAlpha') / 255; }
  protected key() { return `${settings.num('layerState.METARFieldIndex')}|${settings.bool('settings.metarLargeFont')}|${this.at}|${settings.bool('ext.settings.surfaceCorrectedFormulas')}|${settings.str(METAR_PALETTES[settings.num('layerState.METARFieldIndex')] || 'settings.metarAlpha')}`; }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    if (Date.now() - this.at < 4 * 60e3) return;
    this.setStatus('loading', 'METAR reports');
    try {
      // AWC cache: latest METAR/SPECI of every station with coordinates; the raw text goes through the parser.
      const csv = new TextDecoder().decode(await gunzip(await fetchBytes('https://aviationweather.gov/data/cache/metars.cache.csv.gz')));
      const corrected = settings.bool('ext.settings.surfaceCorrectedFormulas');
      let n = 0;
      for (const line of csv.split('\n').slice(1)) {
        const m = /^"([^"]*)",([^,]*),([^,]*),([^,]*),([^,]*)/.exec(line);
        if (!m) continue;
        const r = parseMetar(m[1], Date.now(), corrected);
        const lat = Number(m[4]), lon = Number(m[5]);
        if (!r || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        let h = this.history.get(r.station);
        if (!h) { h = { lon, lat, reports: [] }; this.history.set(r.station, h); }
        if (!h.reports.some((x) => x.timeMs === r.timeMs)) { h.reports.push(r); h.reports.sort((a, b) => a.timeMs - b.timeMs); if (h.reports.length > 24) h.reports.shift(); }
        n++;
      }
      this.at = Date.now();
      this.setStatus('ready', `${n} stations`);
    } catch (e) { this.setStatus('error', `METAR: ${(e as Error).message}`); }
  }

  build() {
    const field = settings.num('layerState.METARFieldIndex');
    const large = settings.bool('settings.metarLargeFont');
    const t = timeline.t;
    this.items = [];
    for (const [id, h] of this.history) {
      // Newest report at or before the map time, at most 2 hours old.
      let r: MetarReport | null = null, next: MetarReport | null = null;
      for (const x of h.reports) { if (x.timeMs <= t + 60e3) r = x; else { next = x; break; } }
      if (!r || t - r.timeMs > 2 * 3600e3 || !metarDrawn(r, field)) continue;
      const interp = settings.bool('layerState.METARTemporalInterpolation') && next && metarDrawn(next, field) ? next : null;
      const v = interp ? interpolateMetar(r, interp, t, field) : metarValue(r, field);
      const rep = r;
      const item: StationLayer['items'][number] = { lon: h.lon, lat: h.lat, label: null, icon: null, wind: null, priority: stationPriority(id), probe: () => metarProbe(rep, fmtTime) };
      if (field === 3) { const ic = wxIcon(v); if (!ic) continue; item.icon = { lon: h.lon, lat: h.lat, size: large ? 16 : 12, shape: ic.shape, color: ic.color, outline: 0.15 }; }
      else if (field === 2) { item.wind = { kt: interp ? v / 1.15077945 : r.wspeed, dir: r.wdir === 65534 ? 0 : r.wdir }; item.label = { lon: h.lon, lat: h.lat, text: String(rne(v)), size: large ? 13 : 10, color: colorOf(METAR_PALETTES[2], v), halo: [0, 0, 0, 230], dy: -6, dx: -10, align: 'right', priority: item.priority }; }
      else item.label = { lon: h.lon, lat: h.lat, text: field === 4 ? v.toFixed(0) : String(rne(v)), size: large ? 15 : 11, color: colorOf(METAR_PALETTES[field], v), halo: [0, 0, 0, 230], priority: item.priority };
      this.items.push(item);
    }
  }
}

// ------------------------------------------------------------------------------------------- marine
/** Parses NDBC latest_obs.txt / ship_obs.txt fixed-column text ("MM" missing). */
export function parseNdbc(text: string, ship: boolean): MarineObs[] {
  const lines = text.split('\n');
  const head = (lines[0] ?? '').replace(/^#/, '').trim().split(/\s+/);
  const col = (n: string) => head.indexOf(n);
  const out: MarineObs[] = [];
  for (const l of lines) {
    if (!l.trim() || l.startsWith('#')) continue;
    const f = l.trim().split(/\s+/);
    const num = (n: string, miss = -1) => { const i = col(n); const v = i >= 0 ? f[i] : 'MM'; return v === undefined || v === 'MM' ? miss : Number(v); };
    const y = num(ship ? 'YY' : 'YYYY'), mo = num('MM'), d = num('DD'), hh = num('hh'), mn = ship ? 0 : num('mm');
    const lat = num('LAT', NaN), lon = num('LON', NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const wd = col('WDIR') >= 0 ? f[col('WDIR')] : 'MM';
    out.push({ id: f[0], ship, lat, lon: lon > 180 ? lon - 360 : lon, timeMs: Date.UTC(y, mo - 1, d, hh, Math.max(0, mn)), wspd: num('WSPD'), gust: num('GST'), wdir: wd === 'MM' ? null : Number(wd),
      atmp: num('ATMP', 9999), wtmp: num('WTMP', 9999), dewp: num('DEWP', 9999), pres: num('PRES'), wvht: num('WVHT'), dpd: num('DPD') });
  }
  return out;
}
/** Hourly continuous-wind file: newest record per station (m/s). */
export function parseCwind(text: string): Map<string, { spd: number; gst: number; dir: number }> {
  const out = new Map<string, { spd: number; gst: number; dir: number }>();
  for (const l of text.split('\n')) {
    if (!l.trim() || l.startsWith('#')) continue;
    const f = l.trim().split(/\s+/);
    if (f.length < 10) continue;
    out.set(f[0], { dir: Number(f[6]), spd: Number(f[7]) >= 99 ? -1 : Number(f[7]), gst: Number(f[9]) >= 99 ? -1 : Number(f[9]) });
  }
  return out;
}

export class MarineLayer extends StationLayer {
  readonly id = 'marine';
  readonly title = 'Marine observations';
  obs: MarineObs[] = [];
  private active: Set<string> | null = null;
  private at = 0; private cwAt = 0;
  private cw = new Map<string, { spd: number; gst: number; dir: number }>();
  enabled() { return settings.bool('layerState.MarineBuoyObservationsOn') || settings.bool('layerState.MarineShipObservationsOn'); }
  spacing() { return settings.num('settings.ndbcSpacing'); }
  alpha() { return settings.num('settings.ndbcAlpha') / 255; }
  protected key() { return ['layerState.MarineObservationIdx', 'settings.ndbcLargeFont', 'settings.ndbcSitesOn', 'settings.ndbcHideDeadBuoys', 'layerState.MarineBuoyObservationsOn', 'layerState.MarineShipObservationsOn', 'ext.settings.surfaceCorrectedFormulas'].map((k) => settings.get(k)).join('|') + this.at + this.cwAt; }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const field = settings.num('layerState.MarineObservationIdx');
    this.setStatus('loading', 'NDBC observations');
    try {
      if (Date.now() - this.at > 5 * 60e3) {
        const [b, s] = await Promise.all([fetchText('https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt'), fetchText('https://www.ndbc.noaa.gov/data/realtime2/ship_obs.txt').catch(() => '')]);
        this.obs = [...parseNdbc(b, false), ...parseNdbc(s, true)];
        if (!this.active) {
          try {
            const xml = await fetchText('https://www.ndbc.noaa.gov/activestations.xml');
            this.active = new Set([...xml.matchAll(/<station id="([^"]+)"[^>]*met="y"/g)].map((m) => m[1].toUpperCase()));
          } catch { this.active = null; }
        }
        this.at = Date.now();
      }
      // Continuous winds (fields 0/1) come from the hourly cwind file.
      if ((field === 0 || field === 1) && Date.now() - this.cwAt > 10 * 60e3) {
        const hh = String(new Date(Date.now() - 3600e3).getUTCHours()).padStart(2, '0');
        this.cw = parseCwind(await fetchText(`https://www.ndbc.noaa.gov/data/hourly2/hour_${hh}.cwind`));
        this.cwAt = Date.now();
      }
      this.setStatus('ready', `${this.obs.length} buoy/ship reports`);
    } catch (e) { this.setStatus('error', `NDBC: ${(e as Error).message}`); }
  }

  build() {
    const field = settings.num('layerState.MarineObservationIdx');
    const large = settings.bool('settings.ndbcLargeFont'), sites = settings.bool('settings.ndbcSitesOn');
    const buoys = settings.bool('layerState.MarineBuoyObservationsOn'), ships = settings.bool('layerState.MarineShipObservationsOn');
    const hideDead = settings.bool('settings.ndbcHideDeadBuoys') && this.active;
    const corrected = settings.bool('ext.settings.surfaceCorrectedFormulas');
    this.items = [];
    for (const o0 of this.obs) {
      if (o0.ship ? !ships : !buoys) continue;
      if (!o0.ship && hideDead && !this.active!.has(o0.id.toUpperCase())) continue;
      const cw = this.cw.get(o0.id);
      const o: MarineObs = cw ? { ...o0, cwSpd: cw.spd, cwGust: cw.gst } : o0;
      const drawn = marineDrawn(o, field);
      if (!drawn && !sites) continue;
      const v = marineValue(o, field);
      const it: StationLayer['items'][number] = { lon: o.lon, lat: o.lat, label: null, icon: null, wind: null, priority: o.ship ? 0 : 1, probe: () => marineProbe(o, fmtTime, corrected) };
      if (sites) it.icon = { lon: o.lon, lat: o.lat, size: 6, shape: SHAPE.square, color: [255, 210, 80, 230], outline: 0.2 };
      if (drawn && v !== MISSING) {
        it.label = { lon: o.lon, lat: o.lat, text: field === 7 ? v.toFixed(0) : field === 9 ? v.toFixed(0) : String(rne(v)), size: large ? 15 : 11, color: colorOf(MARINE_PALETTES[field], v), halo: [0, 0, 0, 230], priority: it.priority, dy: sites ? -6 : 0 };
        if (field >= 0 && field <= 3 && (o.wdir !== null)) it.wind = { kt: v / 1.15078, dir: field <= 1 && cw ? cw.dir : o.wdir! };
      }
      this.items.push(it);
    }
  }
}

// ------------------------------------------------------------------------------------------- buoy explorer
export interface BuoyData { std: string[][]; head: string[]; cwind: string[][]; spec: string[][]; specHead: string[]; ocean: string[][]; oceanHead: string[] }
/** Downloads the realtime2 files of one station; missing files leave their tab empty. */
export async function loadBuoy(id: string): Promise<BuoyData> {
  const get = async (ext: string) => { try { return (await fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${id.toUpperCase()}.${ext}`)).split('\n').filter((l) => l.trim()); } catch { return []; } };
  const [std, cwind, spec, ocean] = await Promise.all([get('txt'), get('cwind'), get('spec'), get('ocean')]);
  const rows = (ls: string[]) => ls.filter((l) => !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
  const head = (ls: string[]) => (ls[0] ?? '').replace(/^#/, '').trim().split(/\s+/);
  return { std: rows(std), head: head(std), cwind: rows(cwind), spec: rows(spec), specHead: head(spec), ocean: rows(ocean), oceanHead: head(ocean) };
}
