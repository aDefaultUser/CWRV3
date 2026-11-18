// GIS vector layers from prebuilt public data (public/gis): coastline, lakes, rivers, country, state and county
// lines, TIGER primary roads with procedural route shields, city labels and radar-site labels.
import type { DrawContext, Renderer } from '../render/renderer';
import { LineSet, PointSet, TextSet, GlyphAtlas, SpriteAtlas, SpriteSet, declutter, declutterBoxes, loadImage, SHAPE, type Polyline } from '../render/prims';
import { linePasses, hasTextStyle } from '../app/styles';
export const ROAD_STYLES = ['RoadInterstate', 'RoadUS', 'RoadState', 'RoadStreet', 'RoadRamp'];
import { decodeLineSet, type LineSet as LS } from '../gis/lineset';
import { settings } from '../settings/store';
import { labelDb, labelKey, type LabelDb } from '../app/stores';
import { MapLayer } from './base';
import { RADAR_SITES } from '../generated/radar-sites';
import { radarStatus } from '../radar/status';
import { lonLatToXYZ } from '../render/camera';
import { loadPref, savePref, isArray, isBool } from '../app/persist';

async function loadSet(name: string): Promise<LS | null> {
  try { const r = await fetch(`${import.meta.env.BASE_URL}gis/${name}`); if (!r.ok) return null; return decodeLineSet(await r.arrayBuffer()); } catch { return null; }
}
function toPolylines(ls: LS, style: (cls: number) => number): Polyline[] {
  const out: Polyline[] = [];
  for (let i = 0; i + 1 < ls.offsets.length; i++) out.push({ coords: ls.coords.subarray(ls.offsets[i] * 2, ls.offsets[i + 1] * 2), style: style(ls.cls[i]) });
  return out;
}

export class GisLayer extends MapLayer {
  readonly id = 'gis';
  readonly archive = 'static';
  readonly title = 'GIS boundaries';
  private lines: LineSet;
  ready = false;
  constructor(r: Renderer) { super(r); this.lines = new LineSet(r); }
  enabled() { const b = settings.num('ext.layerState.MapBase'); return b === 1 || b === 2; }
  async load() {
    this.setStatus('loading', 'Loading GIS…');
    const [coast, lakes, rivers, countries, states, counties] = await Promise.all(['coast.bin', 'lakes.bin', 'rivers.bin', 'countries.bin', 'states.bin', 'counties.bin'].map(loadSet));
    if (!coast) { this.setStatus('unavailable', 'GIS assets missing: run npm run gis'); return; }
    this.lines.setStyles([
      { color: [120, 150, 190, 150], width: 1.0 },  // 0 coast
      { color: [100, 140, 190, 110], width: 0.8 },  // 1 lakes
      { color: [80, 120, 170, 70], width: 0.6 },    // 2 rivers
      { color: [230, 230, 230, 200], width: 1.6 },  // 3 countries
      { color: [215, 215, 200, 175], width: 1.15 }, // 4 states
      { color: [180, 180, 170, 70], width: 0.6 },   // 5 counties
    ]);
    const all: Polyline[] = [];
    if (counties) all.push(...toPolylines(counties, () => 5));
    if (rivers) all.push(...toPolylines(rivers, () => 2));
    if (lakes) all.push(...toPolylines(lakes, () => 1));
    all.push(...toPolylines(coast, () => 0));
    if (countries) all.push(...toPolylines(countries, () => 3));
    if (states) all.push(...toPolylines(states, () => 4));
    this.lines.setLines(all);
    this.ready = true;
    this.setStatus('ready', `GIS ${this.lines.count} segments`);
  }
  tick() {
    // County lines fade in with zoom (decision: they would swamp the national view).
    const z = this.r.camera.zoomScale;
    const s = this.lines.styles;
    if (!s.length) return;
    const ca = Math.round(Math.max(0, Math.min(1, (6 - z) / 3)) * 90);
    if (s[5].color[3] !== ca) { s[5].color[3] = ca; s[5].visible = ca > 0; this.lines.setStyles(s); }
  }
  draw(ctx: DrawContext) { if (!ctx.probe && this.ready) this.lines.draw(ctx); }
}

// ------------------------------------------------------------------------------------------- roads
interface Shield { lon: number; lat: number; cls: number; num: number; key: string; w: number; h: number }
/** Text box inside a blank, in blank pixels (left, top, right, bottom padding from Americana `networks.json`; its
 *  Interstate south-half-ellipse text constraint is approximated by the padded rectangle). */
interface ShieldStyle { blanks: string[]; size: [number, number][]; textColor: string; pad: [number, number, number, number] }
const SHIELD_STYLES: Record<number, ShieldStyle> = {
  0: { blanks: ['shield_us_interstate_2.svg', 'shield_us_interstate_3.svg'], size: [[20, 20], [25, 20]], textColor: '#fff', pad: [4, 6, 4, 5] },
  1: { blanks: ['shield_badge_2.svg', 'shield_badge_3.svg'], size: [[20, 20], [25, 20]], textColor: '#000', pad: [3, 4, 3, 5] },
};
const SHIELD_FONT = '"Noto Sans Condensed"';
const SHIELD_SCALE = 0.95; // CSS px per blank pixel

export class RoadsLayer extends MapLayer {
  readonly id = 'roads';
  readonly archive = 'static';
  readonly title = 'Roads';
  private lines: LineSet; private sprites: SpriteSet; private spriteAtlas: SpriteAtlas;
  private shieldList: Shield[] = [];
  /** Downloaded TIGER road sets by key ("state:40" secondary roads, "county:40027" local streets) with street names. */
  groups = new Map<string, { label: string; lines: Polyline[]; names: string[] }>();
  private primary: Polyline[] = [];
  /** "Remove" US primary roads (TFrmRoadsControl); "Download" brings the prebuilt set back. Persisted locally. */
  primaryRemoved = loadPref('roadsPrimaryRemoved', false, isBool);
  /** Placed road-name labels (Road Name Labeling, Alt+L). */
  labels = loadPref<{ lon: number; lat: number; name: string; dx: number; dy: number }[]>('roadLabels', [], isArray);
  private labelText: TextSet;
  ready = false;
  constructor(r: Renderer, atlas: GlyphAtlas) {
    super(r); this.lines = new LineSet(r); this.spriteAtlas = new SpriteAtlas(r); this.sprites = new SpriteSet(r, this.spriteAtlas);
    this.labelText = new TextSet(r, atlas); this.labelText.style = 'RoadLabels';
  }
  setPrimaryRemoved(v: boolean) { this.primaryRemoved = v; savePref('roadsPrimaryRemoved', v, 'road settings'); this.rebuild(); }
  saveLabels() { const ok = savePref('roadLabels', this.labels, 'road labels'); this.rebuildLabels(); return ok; }
  /** World-space road labels are map text; screen-space ones are DOM boxes drawn by the app. */
  rebuildLabels() {
    const world = settings.bool('config.roadLabelWorld');
    this.labelText.setLabels(world ? this.labels.map((l) => ({ lon: l.lon, lat: l.lat, text: l.name, size: 13, color: [255, 255, 255, 255], halo: [0, 0, 0, 220], priority: 1e8 })) : []);
  }
  /** Name of the closest named downloaded road within `tolPx` of a screen point. */
  nameAt(x: number, y: number, tolPx = 9): { name: string; lon: number; lat: number } | null {
    const cam = this.r.camera;
    const ll = cam.pick(x, y), ll2 = cam.pick(x + tolPx, y);
    if (!ll || !ll2) return null;
    const tol = Math.hypot((ll2[0] - ll[0]) * Math.cos((ll[1] * Math.PI) / 180), ll2[1] - ll[1]);
    const kx = Math.cos((ll[1] * Math.PI) / 180);
    let best: { name: string; lon: number; lat: number } | null = null, bd = tol;
    for (const g of this.groups.values()) g.lines.forEach((l, i) => {
      const name = g.names[i];
      if (!name) return;
      const c = l.coords;
      for (let k = 0; k + 3 < c.length; k += 2) {
        const ax = (c[k] - ll[0]) * kx, ay = c[k + 1] - ll[1], bx = (c[k + 2] - ll[0]) * kx, by = c[k + 3] - ll[1];
        if (Math.min(ax, bx) > bd || Math.max(ax, bx) < -bd || Math.min(ay, by) > bd || Math.max(ay, by) < -bd) continue;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < bd) { bd = d; best = { name, lon: ll[0] + (ax + t * dx) / kx, lat: ll[1] + ay + t * dy }; }
      }
    });
    return best;
  }
  enabled() { const b = settings.num('ext.layerState.MapBase'); return b === 1 || b === 2; }
  async load() {
    const roads = await loadSet('roads-primary.bin');
    if (!roads) return;
    this.primary = toPolylines(roads, (c) => c);
    this.applyStyles();
    this.rebuild();
    const anchors: { lon: number; lat: number; cls: number; num: number }[] = [];
    // Shield anchors: one per long feature part, at its middle vertex.
    for (let i = 0; i + 1 < roads.offsets.length; i++) {
      const a = roads.offsets[i], b = roads.offsets[i + 1];
      if (b - a < 6 || !roads.value[i]) continue;
      const m = Math.floor((a + b) / 2);
      anchors.push({ lon: roads.coords[m * 2], lat: roads.coords[m * 2 + 1], cls: roads.cls[i], num: roads.value[i] });
    }
    await this.buildShields(anchors);
    this.ready = true;
  }
  /** Interstate and US-route blanks from the OpenStreetMap Americana shield set and the bundled Noto Sans Condensed
   *  (public/assets/roads, licences beside the files); state routes get a white oval because TIGER primary roads
   *  carry no state. Each network + number is drawn once into the sprite atlas. */
  private async buildShields(anchors: { lon: number; lat: number; cls: number; num: number }[]) {
    const root = `${import.meta.env.BASE_URL}assets/roads/`;
    if (!document.querySelector('link[data-shield-font]')) {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${root}fonts/fonts.css` });
      link.dataset.shieldFont = '1';
      document.head.append(link);
      await new Promise((ok) => { link.onload = link.onerror = ok; });
    }
    // A canvas does not trigger web-font loading; without this wait it silently measures a fallback face.
    await document.fonts.load(`condensed 500 14px ${SHIELD_FONT}`).catch(() => []);
    const blanks = new Map<string, HTMLImageElement>();
    await Promise.all(Object.values(SHIELD_STYLES).flatMap((st) => st.blanks).map(async (f) => {
      try { blanks.set(f, await loadImage(`${root}shields/sprites/${f}`)); } catch { /* missing blank: oval fallback */ }
    }));
    for (const a of anchors) {
      const text = String(a.num), wide = text.length > 2 ? 1 : 0;
      const st = SHIELD_STYLES[a.cls], blank = st && blanks.get(st.blanks[wide]);
      const [bw, bh] = blank ? st.size[wide] : [wide ? 24 : 18, 16];
      const key = `${blank ? a.cls : 2}:${text}`;
      const w = bw * SHIELD_SCALE, h = bh * SHIELD_SCALE;
      this.spriteAtlas.draw(key, w, h, (g, k) => {
        const s = SHIELD_SCALE * k;
        g.scale(s, s);
        const [l, t, r, b] = blank ? st.pad : [3, 3, 3, 3];
        if (blank) g.drawImage(blank, 0, 0, bw, bh);
        else {
          g.beginPath(); g.ellipse(bw / 2, bh / 2, bw / 2 - 0.75, bh / 2 - 0.75, 0, 0, Math.PI * 2);
          g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#000'; g.stroke();
        }
        const boxW = bw - l - r, boxH = bh - t - b;
        // Largest font whose number fits the box (Americana fits text the same way).
        let px = boxH * 1.25;
        g.font = `condensed 500 ${px}px ${SHIELD_FONT}`;
        const mw = g.measureText(text).width;
        if (mw > boxW) { px *= boxW / mw; g.font = `condensed 500 ${px}px ${SHIELD_FONT}`; }
        g.fillStyle = blank ? st.textColor : '#000'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(text, l + boxW / 2, t + boxH / 2 + px * 0.04);
      });
      this.shieldList.push({ ...a, key, w, h });
    }
    this.spriteAtlas.flush();
    this.sprites.setSprites(this.shieldList.map((s) => ({ lon: s.lon, lat: s.lat, key: s.key, w: s.w, h: s.h })));
  }
  /** Road classes 0 interstate, 1 US, 2 state, 3 streets, 4 ramps: map-object styles (TFrmRoadsControl). Only the
   * interior pass is used for roads (one segment per class keeps the large road set cheap). */
  applyStyles() {
    const z = this.r.camera.cur.z;
    const vis = [settings.bool('config.geoRoadsInterstates'), settings.bool('config.geoRoadsSecondary'), settings.bool('config.geoRoadsSecondary'), settings.bool('config.geoRoadsLocal'), settings.bool('config.geoRoadsLocal')];
    this.lines.setStyles(ROAD_STYLES.map((n, i) => { const p = linePasses(n, z)[5]; return { ...p, visible: vis[i] && p.visible !== false }; }));
  }
  styleChanged() { this.applyStyles(); this.rebuildLabels(); }
  rebuild() { this.lines.setLines([...(this.primaryRemoved ? [] : this.primary), ...[...this.groups.values()].flatMap((g) => g.lines)]); }
  private appear = new Float64Array(0);
  tick(_t = 0, now = performance.now()) {
    if (!this.ready) return;
    // Per-class shield density (interstate / US / state route): spacing = 140 px / density.
    const dens = [settings.num('config.geoInterstateLabelsDensity'), settings.num('config.geoUSRouteLabelsDensity'), settings.num('config.geoStateRouteLabelsDensity')];
    const spacing = 140 / Math.max(0.2, dens[0]);
    const enabled = [settings.bool('config.geoInterstateLabels'), settings.bool('config.geoUSRouteLabels'), settings.bool('config.geoStateRouteLabels')];
    const alphas = [settings.num('config.geoInterstateLabelsAlpha'), settings.num('config.geoUSRouteLabelsAlpha'), settings.num('config.geoStateRouteLabelsAlpha')];
    const z = this.r.camera.zoomScale;
    const list = this.shieldList;
    const vis = declutterBoxes(this.r, list.map((s) => ({ lon: s.lon, lat: s.lat, w: s.w, h: s.h, priority: 3 - s.cls, spacing: 140 / Math.max(0.2, dens[s.cls] ?? dens[0]) })), spacing, (i) => enabled[list[i].cls] && (list[i].cls === 0 || z < 2.5));
    if (this.appear.length !== vis.length) this.appear = new Float64Array(vis.length);
    const flash = settings.bool('config.geoInterstateLabelsEffect');
    for (let i = 0; i < vis.length; i++) {
      if (!vis[i]) { this.appear[i] = 0; this.sprites.setAlpha(i, 0); continue; }
      if (!this.appear[i]) this.appear[i] = now;
      // Interstate "flash on": a newly shown shield brightens past its alpha and settles over 400 ms.
      const k = flash && list[i].cls === 0 ? shieldFlash(now - this.appear[i]) : 1;
      this.sprites.setAlpha(i, Math.min(1, alphas[list[i].cls] * k));
    }
    this.sprites.flushAlpha();
  }
  draw(ctx: DrawContext) { if (ctx.probe || !this.ready) return; this.lines.draw(ctx); if (!this.primaryRemoved) this.sprites.draw(ctx); this.labelText.draw(ctx); }
}

/** Flash-on alpha multiplier for a shield shown `ms` ago: fades in over 120 ms, overshoots to 1.6×, settles at 1. */
export function shieldFlash(ms: number): number {
  if (ms < 120) return ms / 120;
  if (ms < 400) return 1 + 0.6 * Math.sin((Math.PI * (ms - 120)) / 280);
  return 1;
}

// ------------------------------------------------------------------------------------------- cities
export interface City { n: string; lon: number; lat: number; pop: number; rank: number; lrank: number; cap: number; cc: string; fixed?: boolean; zoom?: 0 | 1 | 2 }
export class CityLayer extends MapLayer {
  readonly id = 'cities';
  readonly archive = 'static';
  readonly title = 'City labels';
  private text: TextSet;
  private base: City[] = [];
  private cities: City[] = [];
  private shown = new Float32Array(0);
  private lastNow = 0;
  private placed = false;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r); this.text = new TextSet(r, atlas); }
  enabled() { return settings.bool('config.citylabels') && settings.num('ext.layerState.MapBase') !== 3; }
  async load() {
    try { this.base = await (await fetch(`${import.meta.env.BASE_URL}gis/cities.json`)).json(); } catch { this.base = []; }
    this.rebuild();
  }
  styleChanged() { this.rebuild(); }
  list(): readonly City[] { return this.cities; }
  /** Built-in list before label-database edits (for the editor). */
  builtIn(): readonly City[] { return this.base; }
  /** Applies label-database edits (TFrmLabelDBEdit) to the built-in list. */
  private applyDb(db: LabelDb): City[] {
    const out: City[] = [];
    for (const c of this.base) {
      const e = db.edits[labelKey(c)];
      if (e?.deleted) continue;
      out.push(e ? { ...c, n: e.n ?? c.n, fixed: e.fixed, zoom: e.zoom } : c);
    }
    for (const a of db.added) out.push({ n: a.n, lon: a.lon, lat: a.lat, pop: 0, rank: 5, lrank: 5, cap: 0, cc: '', fixed: a.fixed, zoom: a.zoom });
    return out;
  }
  rebuild() {
    this.cities = this.applyDb(labelDb.value);
    const caps = settings.bool('config.citylabelCaps');
    this.text.style = hasTextStyle('CityLabels') ? 'CityLabels' : null;
    this.text.setLabels(this.cities.map((c) => ({ lon: c.lon, lat: c.lat, text: caps ? c.n.toUpperCase() : c.n, size: 15, color: [255, 255, 255, 255], halo: [0, 0, 0, 200], letterSpacing: 0.12, priority: c.fixed ? 1e12 : c.pop })));
    this.shown = new Float32Array(this.cities.length);
  }
  tick(_t: number, now: number) {
    if (!this.cities.length) return;
    const dt = Math.min(200, now - (this.lastNow || now)); this.lastNow = now;
    const z = this.r.camera.zoomScale;
    // Rank filter: value 70..100 maps to the number of label ranks admitted at this zoom.
    const rf = settings.bool('config.citylabelRFilterOn') ? settings.num('config.citylabelRFilter') : 100;
    const maxRank = Math.max(1, Math.min(10, 2 + (rf - 70) / 6 + Math.max(0, 4.5 - z) * 1.5));
    const minPop = settings.bool('config.citylabelFilter') ? Math.max(1000, 2e5 / Math.max(0.3, 5 - z)) : 0;
    // Label-database zoom classes: fixed = always, 1 = from low zoom, 2 = only when zoomed in (z < 1.5).
    const admit = (c: City) => c.fixed || c.zoom === 1 || (c.zoom === 2 ? z < 1.5 : c.rank <= maxRank && c.pop >= minPop);
    const vis = declutter(this.r, this.text, settings.num('config.citylabelSpacing') * 0.6, (i) => admit(this.cities[i]));
    // Fade-in applies to the first placement; labels that pop in later (pan/zoom declutter) fade only with "pop-in".
    const fade = settings.bool('config.citylabelFadeIn') && (!this.placed || settings.bool('config.citylabelPopIn')) ? settings.num('config.citylabelFadeTime') : 0;
    const k = fade > 0 ? dt / fade : 1;
    if (!this.placed && this.shown.some((v) => v >= 1)) this.placed = true;
    for (let i = 0; i < vis.length; i++) {
      this.shown[i] = vis[i] ? Math.min(1, this.shown[i] + k) : 0;
      this.text.alpha[i] = this.shown[i];
    }
    this.text.flushAlpha();
  }
  draw(ctx: DrawContext) { if (!ctx.probe) this.text.draw(ctx); }
}

// ------------------------------------------------------------------------------------------- radar sites
export class SiteLabelLayer extends MapLayer {
  readonly id = 'radarSites';
  readonly archive = 'static';
  readonly title = 'Radar site labels';
  private text: TextSet; private dots: PointSet;
  mouse: [number, number] | null = null;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r); this.text = new TextSet(r, atlas); this.dots = new PointSet(r); this.rebuild(); }
  enabled() { return settings.bool('settings.nexradSitesOn'); }
  sites() { return RADAR_SITES.filter((s) => !(settings.bool('config.radarSites.HideTDWRs') && s.type === 'TDWR')); }
  /** Radar status (api.weather.gov) while site labels or NEXRAD are on; sites reported down are drawn grey and dimmed. */
  async refresh() {
    if (!this.enabled() && !settings.bool('layerState.NEXRADOn')) return;
    if (await radarStatus.refresh()) this.rebuild();
  }
  /** Label scale near the cursor (MouseProximityScale): up to 1.5× within 250 CSS px, 1× beyond. */
  static proximityScale(d: number) { return 1 + 0.5 * Math.max(0, 1 - d / 250); }
  private scaleKey = '';
  rebuild() {
    const cur = settings.str('settings.nexradSiteICAO');
    const other = settings.arr<number>('config.radarSites.SitesColor'), curC = settings.arr<number>('config.radarSites.CurrentSiteColor');
    const sites = this.sites();
    const near = settings.bool('config.radarSites.MouseProximityScale') && this.mouse ? this.mouse : null;
    const scale = (lon: number, lat: number) => {
      if (!near) return 1;
      const [px, py, front] = this.r.camera.project(lonLatToXYZ(lon, lat));
      return front ? SiteLabelLayer.proximityScale(Math.hypot(px - near[0], py - near[1])) : 1;
    };
    const color = (id: string) => (radarStatus.get(id)?.down ? [140, 140, 140, 255] : id === cur ? [...curC, 255] : [...other, 255]) as [number, number, number, number];
    this.text.setLabels(sites.map((s) => ({ lon: s.lon, lat: s.lat, text: s.id, size: 11 * settings.num('config.radarSites.Scale') * scale(s.lon, s.lat), color: color(s.id), halo: [0, 0, 0, 170], dx: 6, align: 'left' as const, priority: s.id === cur ? 1e9 : 0 })));
    this.dots.setPoints(sites.map((s) => ({ lon: s.lon, lat: s.lat, size: 5, shape: SHAPE.circle, color: color(s.id) })));
  }
  /** Site under the cursor (CSS px) within 14 px. */
  hit(x: number, y: number): string | null {
    let best: string | null = null, bd = 14;
    for (const s of this.sites()) {
      const [px, py, front] = this.r.camera.project(lonLatToXYZ(s.lon, s.lat));
      if (!front) continue;
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  }
  tick() {
    const sites = this.sites();
    const cur = settings.str('settings.nexradSiteICAO');
    if (settings.bool('config.radarSites.MouseProximityScale')) {
      const c = this.r.camera.cur, m = this.mouse;
      const key = m ? `${Math.round(m[0] / 4)},${Math.round(m[1] / 4)},${c.lon.toFixed(3)},${c.lat.toFixed(3)},${c.z.toFixed(1)}` : '';
      if (key !== this.scaleKey) { this.scaleKey = key; this.rebuild(); }
    }
    const base = settings.num('config.radarSites.Alpha'), fadeOut = settings.num('config.radarSites.FadeOutAlpha');
    const prox = settings.bool('config.radarSites.MouseProximityAlpha');
    const pointOnly = settings.bool('config.radarSites.UnselectedSitesPointOnly');
    sites.forEach((s, i) => {
      let a = base;
      if (prox && this.mouse) {
        const [px, py, front] = this.r.camera.project(lonLatToXYZ(s.lon, s.lat));
        const d = front ? Math.hypot(px - this.mouse[0], py - this.mouse[1]) : 1e9;
        a = fadeOut + (base - fadeOut) * Math.max(0, 1 - d / 250);
      }
      if (s.id === cur && settings.bool('config.radarSites.CurrentShowAlways')) a = 1;
      if (radarStatus.get(s.id)?.down) a *= 0.5;
      this.text.alpha[i] = pointOnly && s.id !== cur ? 0 : a;
      this.dots.setAlpha(i, a);
    });
    this.text.flushAlpha(); this.dots.flushAlpha();
  }
  draw(ctx: DrawContext) { if (ctx.probe) return; this.dots.draw(ctx); this.text.draw(ctx); }
}
