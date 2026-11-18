// Basic → Warnings (TOR SVR SQW SMW FFW SWS EWW) and Severe Watches from the public NWS API
// (api.weather.gov GeoJSON) and SPC watch outlines (ActiveWW.kmz). Polling replaces the vendor push feed.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, NOT_AVAILABLE } from './base';
import { timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { fetchJson, fetchBytes } from '../data/net';
import { LineSet, PointSet, TextSet, GlyphAtlas, SHAPE, type Polyline, type Label, type PointSpec, type LineStyle } from '../render/prims';
import { destination } from '../gis/geodesy';
import { decodeLineSet } from '../gis/lineset';
import { unzip } from '../decode/zip';
import { lonLatToXYZ } from '../render/camera';
import earcut from 'earcut';
import { PolySet, type PolyFill } from '../render/polys';
import { passTable, polyFill, objectStyle, warningCustomStyles, hasTextStyle } from '../app/styles';
import { loadArchiveWarnings } from './warnings-archive';

export interface WarnType { code: string; event: string; layer: string; color: [number, number, number] }
/** Colors: unknown in the original; NWS-conventional choices recorded in */
export const WARN_TYPES: WarnType[] = [
  { code: 'TOR', event: 'Tornado Warning', layer: 'layerState.TORWarningsOn', color: [255, 0, 0] },
  { code: 'SVR', event: 'Severe Thunderstorm Warning', layer: 'layerState.SVRWarningsOn', color: [255, 225, 0] },
  { code: 'SQW', event: 'Snow Squall Warning', layer: 'layerState.SQWarningsOn', color: [199, 21, 133] },
  { code: 'SMW', event: 'Special Marine Warning', layer: 'layerState.SMWarningsOn', color: [255, 165, 0] },
  { code: 'FFW', event: 'Flash Flood Warning', layer: 'layerState.FFWWarningsOn', color: [0, 210, 60] },
  { code: 'SWS', event: 'Special Weather Statement', layer: 'layerState.SWSWarningsOn', color: [255, 228, 181] },
  { code: 'EWW', event: 'Extreme Wind Warning', layer: 'layerState.EWWarningsOn', color: [255, 140, 0] },
];
const WATCH_EVENTS = ['Tornado Watch', 'Severe Thunderstorm Watch'];

/** Alerts not seen in earlier polls that are still in effect; updates `seen`. The first poll only records ids. */
export function newAlerts(seen: Set<string> | null, alerts: Alert[], now: number): Alert[] {
  const first = seen === null;
  const out = first ? [] : alerts.filter((a) => !seen!.has(a.id) && a.ends > now);
  return out;
}

export interface Alert {
  id: string; type: WarnType | null; event: string; sent: number; expires: number; ends: number;
  rings: number[][]; headline: string; description: string; area: string; wfo: string; etn: string;
  hail: string; wind: string; damage: string; tornado: string; motion: string; zones: string[]; pds: boolean; refs: string[];
}

const API = 'https://api.weather.gov';
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export function parseAlert(f: any): Alert {
  const p = f.properties;
  const ev: string = p.event;
  const type = WARN_TYPES.find((w) => w.event === ev) ?? null;
  const rings: number[][] = [];
  const g = f.geometry;
  if (g?.type === 'Polygon') for (const r of g.coordinates) rings.push(r.flat());
  else if (g?.type === 'MultiPolygon') for (const poly of g.coordinates) for (const r of poly) rings.push(r.flat());
  const prm = p.parameters ?? {};
  const first = (k: string) => (Array.isArray(prm[k]) ? String(prm[k][0]) : '');
  const vtec = first('VTEC');
  return {
    id: p.id, type, event: ev, sent: ms(p.sent), expires: ms(p.expires), ends: ms(p.ends ?? p.expires), rings,
    headline: p.headline ?? '', description: p.description ?? '', area: p.areaDesc ?? '', wfo: (p.senderName ?? '').replace(/^NWS /, ''),
    etn: /\.(\d{4})\./.exec(vtec)?.[1] ?? '', hail: first('maxHailSize'), wind: first('maxWindGust'),
    damage: first('thunderstormDamageThreat') || first('tornadoDamageThreat') || first('flashFloodDamageThreat'), tornado: first('tornadoDetection'),
    motion: first('eventMotionDescription'), zones: (p.affectedZones ?? []).map((z: string) => z.split('/').pop()!),
    pds: /PARTICULARLY DANGEROUS SITUATION/i.test(p.description ?? ''), refs: (p.references ?? []).map((r: any) => r.identifier),
  };
}

export class WarningsLayer extends MapLayer {
  readonly id = 'warnings';
  readonly archive = 'resolver';
  readonly title = 'Warnings and watches';
  alerts: Alert[] = [];
  watches: Alert[] = [];
  /** Alert ids seen so far (null before the first successful poll). */
  private seen: Set<string> | null = null;
  onNew: (alerts: Alert[]) => void = () => {};
  private lines: LineSet; private text: TextSet;
  private watchLines: LineSet;
  private counties: { ids: string[]; rings: Map<string, number[][]> } | null = null;
  private avBoxes: { num: string; tor: boolean; coords: number[] }[] = [];
  private lastKey = '';
  /** Timeline key (mode, archive time) and, in archive mode, the loop period the alerts were loaded for. */
  private loaded = '';
  selected: Alert | null = null;
  private fills: PolySet;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r); this.lines = new LineSet(r); this.text = new TextSet(r, atlas); this.watchLines = new LineSet(r); this.fills = new PolySet(r); }
  /** Style edits and zoom-level styles rebuild on the next tick. */
  styleChanged() { this.lastKey = ''; }
  enabled() { return WARN_TYPES.some((w) => settings.bool(w.layer)) || settings.bool('layerState.SevereWatchesOn'); }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const epoch = timeline.epoch;
    if (!this.loaded.startsWith(`${timeline.key}|`)) { this.alerts = []; this.watches = []; this.avBoxes = []; this.selected = null; this.loaded = `${timeline.key}|`; this.lastKey = ''; }
    if (timeline.mode === 'archive') { await this.refreshArchive(epoch); return; }
    const start = new Date(timeline.loopStart - 3 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
    const events = [...WARN_TYPES.map((w) => w.event), ...WATCH_EVENTS];
    try {
      const out: any[] = [];
      let url: string | null = `${API}/alerts?start=${start}&event=${encodeURIComponent(events.join(','))}&limit=500`;
      for (let page = 0; url && page < 6; page++) {
        const j: any = await fetchJson(url);
        out.push(...j.features);
        url = j.features.length >= 500 ? j.pagination?.next ?? null : null;
      }
      const active: any = await fetchJson(`${API}/alerts/active?event=${encodeURIComponent(events.join(','))}`);
      const byId = new Map<string, any>();
      for (const f of [...out, ...active.features]) byId.set(f.properties.id, f);
      if (epoch !== timeline.epoch) return; // archive mode was entered meanwhile
      const all = [...byId.values()].map(parseAlert);
      // A later message referencing an earlier one supersedes it from its send time.
      const superseded = new Map<string, number>();
      for (const a of all) for (const r of a.refs) superseded.set(r, Math.min(superseded.get(r) ?? Infinity, a.sent));
      for (const a of all) { const s = superseded.get(a.id); if (s !== undefined) a.ends = Math.min(a.ends, s); }
      const fresh = newAlerts(this.seen, all.filter((a) => (a.type && settings.bool(a.type.layer)) || (WATCH_EVENTS.includes(a.event) && settings.bool('layerState.SevereWatchesOn'))), Date.now());
      this.alerts = all.filter((a) => a.type && a.rings.length);
      this.watches = all.filter((a) => WATCH_EVENTS.includes(a.event));
      // Live notification text for messages that appeared since the previous poll (not on the first load).
      this.seen = new Set([...(this.seen ?? []), ...all.map((a) => a.id)]);
      if (fresh.length && settings.bool('settings.severeWarningsShowPushNotification')) this.onNew(fresh);
      this.setStatus('ready', `NWS alerts: ${this.alerts.length} warnings, ${this.watches.length} watch messages`);
    } catch (e) { if (epoch === timeline.epoch) this.setStatus('error', `NWS API: ${(e as Error).message}`); }
    if (settings.bool('layerState.SevereWatchesOn')) { await this.loadCounties(); await this.loadAviationBoxes(epoch); }
    this.lastKey = '';
  }

  /**
   * Archive mode: warning polygons and SPC watch outlines of the loop period from IEM, each drawn only while it was in
   * effect. Nothing is announced as new, and Special Weather Statements are not archived.
   */
  private async refreshArchive(epoch: number) {
    const from = timeline.loopStart, to = timeline.loopEnd, watches = settings.bool('layerState.SevereWatchesOn');
    const key = `${timeline.key}|${from}|${watches}`;
    if (key === this.loaded) return;
    this.setStatus('loading', 'Archived warnings (IEM)');
    try {
      const res = await loadArchiveWarnings(from, to, watches);
      if (epoch !== timeline.epoch) return; // the mode or archive time changed while loading
      this.alerts = res.alerts; this.watches = res.watches; this.loaded = key; this.lastKey = '';
      const sws = settings.bool('layerState.SWSWarningsOn') ? `; Special Weather Statements ${NOT_AVAILABLE}` : '';
      this.setStatus('ready', `IEM archive: ${this.alerts.length} warning polygons, ${this.watches.length} watches${sws}`);
    } catch (e) { if (epoch === timeline.epoch) this.setStatus('error', `IEM warnings: ${(e as Error).message}`); }
  }

  private async loadCounties() {
    if (this.counties) return;
    try {
      const [ids, rings] = await Promise.all([fetch(`${import.meta.env.BASE_URL}gis/county-ids.json`).then((r) => r.json()), fetch(`${import.meta.env.BASE_URL}gis/county-rings.bin`).then((r) => r.arrayBuffer())]);
      const ls = decodeLineSet(rings);
      const m = new Map<string, number[][]>();
      for (let i = 0; i + 1 < ls.offsets.length; i++) {
        const id = ids[ls.value[i]];
        if (!m.has(id)) m.set(id, []);
        m.get(id)!.push(Array.from(ls.coords.subarray(ls.offsets[i] * 2, ls.offsets[i + 1] * 2)));
      }
      this.counties = { ids, rings: m };
    } catch { /* GIS assets missing: watches draw no outline */ }
  }

  private async loadAviationBoxes(epoch: number) {
    try {
      const files = await unzip(await fetchBytes('https://www.spc.noaa.gov/products/watch/ActiveWW.kmz'), (n) => n.endsWith('.kml'));
      if (epoch !== timeline.epoch) return;
      const kml = new TextDecoder().decode([...files.values()][0] ?? new Uint8Array());
      this.avBoxes = [];
      for (const pm of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
        const body = pm[1];
        const name = /<name>([^<]*)<\/name>/.exec(body)?.[1] ?? '';
        const c = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
        if (!c) continue;
        const coords = c.trim().split(/\s+/).flatMap((t) => t.split(',').slice(0, 2).map(Number));
        this.avBoxes.push({ num: name, tor: /tornado|TOR/i.test(name + body), coords });
      }
    } catch { if (epoch === timeline.epoch) this.avBoxes = []; }
  }

  activeAt(t: number) { return this.alerts.filter((a) => a.sent <= t && t < a.ends && settings.bool(a.type!.layer)); }
  watchesAt(t: number) { return settings.bool('layerState.SevereWatchesOn') ? this.watches.filter((a) => a.sent <= t && t < a.ends) : []; }

  /** Rebuilds geometry when map time crosses alert boundaries (minute resolution for countdown captions). */
  tick(t: number) {
    if (!this.enabled()) return;
    const key = `${Math.floor(t / 60e3)}|${Math.round(Math.log2(this.r.camera.cur.z) * 8)}|${this.alerts.length}|${this.watches.length}|${WARN_TYPES.map((w) => +settings.bool(w.layer)).join('')}|${+settings.bool('layerState.SevereWatchesOn')}|${+settings.bool('settings.severeWarningsShowCaptions')}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const act = this.activeAt(t);
    // Map-object styles (TORWarn …, custom text-matched styles; TFrmWarningControl → TFrmStyleEditor).
    const styleOf = (a: Alert) => { const txt = `${a.headline}\n${a.description}`.toUpperCase(); const c = warningCustomStyles.find((w) => w.phrases.some((p) => p && txt.includes(p.toUpperCase()))); return c ? `WarnCustom:${c.name}` : `${a.type!.code}Warn`; };
    const names = [...new Set(act.map(styleOf))];
    const z = this.r.camera.cur.z;
    const table = passTable(names, z);
    this.lines.setStyles(table.styles);
    this.fills.setStyles(names.map((n) => polyFill(n, z)));
    const lines: Polyline[] = [], polys: PolyFill[] = [];
    for (const a of act) {
      const n = styleOf(a);
      for (const r of a.rings) {
        for (const k of table.idx(n)) lines.push({ coords: r, style: k });
        if (polyFill(n, z).color[3] > 0 || objectStyle(n).poly.levels.some((l) => l.pattern.on || l.texture.on)) { const idx = earcut(r, undefined, 2); const tris: number[] = []; for (const i of idx) tris.push(r[i * 2], r[i * 2 + 1]); polys.push({ tris, style: names.indexOf(n) }); }
      }
    }
    this.lines.setLines(lines);
    this.fills.setPolys(polys);
    this.buildTracking(act, t);
    const labels: Label[] = [];
    if (settings.bool('settings.severeWarningsShowCaptions')) {
      for (const a of act) {
        const c = centroid(a.rings[0]);
        const parts: string[] = [];
        if (settings.bool('settings.severeWarningsShowTitleCaption')) parts.push(settings.bool('settings.severeWarningsTitleCaptionAbbreviated') ? a.type!.code : a.event);
        if (settings.bool('settings.severeWarningsShowExpirationCaption')) {
          const left = Math.max(0, a.ends - t);
          parts.push(settings.bool('settings.severeWarningsExpirationCaptionCountdown') ? `${Math.floor(left / 60e3)}m` : `EXP ${new Date(a.ends).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        }
        if (settings.bool('settings.severeWarningsShowHailImpactCaption') && a.hail && a.hail !== '0.00') parts.push(`${a.hail}" hail`);
        if (settings.bool('settings.severeWarningsShowWindImpactCaption') && a.wind) parts.push(a.wind.replace(/\s*MPH/i, ' mph'));
        if (settings.bool('settings.severeWarningsShowDamageImpactCaption') && a.damage) parts.push(a.damage);
        if (a.tornado && settings.bool('settings.severeWarningsShowDamageImpactCaption')) parts.push(`TOR ${a.tornado.toLowerCase()}`);
        if (parts.length) labels.push({ lon: c[0], lat: c[1], text: parts.join(' · '), size: 12, color: [...a.type!.color, 255] as never, halo: [0, 0, 0, 230], priority: 10 - WARN_TYPES.indexOf(a.type!) });

      }
    }
    this.text.style = hasTextStyle('WarningCaptions') ? 'WarningCaptions' : null;
    this.text.setLabels(labels);
    // Watches: union of county outlines (edges shared by two affected counties cancel), PDS styled thicker.
    const wl: Polyline[] = [];
    const WN = ['TORWatch', 'SVRWatch', 'TORPDSWatch', 'SVRPDSWatch', 'TORAVWatch', 'SVRAVWatch'];
    const wt = passTable(WN, z);
    for (const w of this.watchesAt(t)) {
      const tor = w.event.startsWith('Tornado');
      const n = w.pds ? (tor ? 'TORPDSWatch' : 'SVRPDSWatch') : tor ? 'TORWatch' : 'SVRWatch';
      // Live watches are county unions; archived ones carry the issued outline.
      for (const seg of w.zones.length ? this.unionOutline(w.zones) : w.rings) for (const k of wt.idx(n)) wl.push({ coords: seg, style: k });
    }
    if (settings.bool('layerState.SevereWatchesOn')) for (const b of this.avBoxes) {
      if ((b.tor && settings.bool('settings.severeTORAviationWatch')) || (!b.tor && settings.bool('settings.severeSVRAviationWatch'))) for (const k of wt.idx(b.tor ? 'TORAVWatch' : 'SVRAVWatch')) wl.push({ coords: b.coords, style: k });
    }
    this.watchLines.setStyles(wt.styles);
    this.watchLines.setLines(wl);
  }

  private unionOutline(zones: string[]): number[][] {
    if (!this.counties) return [];
    const count = new Map<string, number>();
    const segs: [number, number, number, number][] = [];
    for (const z of zones) for (const ring of this.counties.rings.get(z) ?? []) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const s: [number, number, number, number] = [ring[i], ring[i + 1], ring[i + 2], ring[i + 3]];
        const k = s[0] < s[2] || (s[0] === s[2] && s[1] < s[3]) ? s.join(',') : [s[2], s[3], s[0], s[1]].join(',');
        count.set(k, (count.get(k) ?? 0) + 1);
        segs.push(s);
      }
    }
    return segs.filter((s) => {
      const k = s[0] < s[2] || (s[0] === s[2] && s[1] < s[3]) ? s.join(',') : [s[2], s[3], s[0], s[1]].join(',');
      return count.get(k) === 1;
    }).map((s) => [...s]);
  }

  /** Warning polygon under a screen point (Interact mode). */
  hit(x: number, y: number, t: number): Alert | null {
    const ll = this.r.camera.pick(x, y);
    if (!ll) return null;
    for (const a of this.activeAt(t).reverse()) for (const r of a.rings) if (pointInRing(ll[0], ll[1], r)) return a;
    return null;
  }

  infoLines(a: Alert): string[] {
    const L: string[] = [];
    if (settings.bool('settings.severeWarningsInfoBoxTextWarningType')) L.push(a.event.toUpperCase());
    if (settings.bool('settings.severeWarningsInfoBoxTextIssued')) L.push(`Issued: ${new Date(a.sent).toLocaleString()}`);
    if (settings.bool('settings.severeWarningsInfoBoxTextExpiration')) L.push(`Expires: ${new Date(a.ends).toLocaleString()}`);
    if (settings.bool('settings.severeWarningsInfoBoxTextStormMotion') && a.motion) L.push(`Motion: ${a.motion}`);
    if (settings.bool('settings.severeWarningsInfoBoxTextImpactFields')) {
      if (a.hail) L.push(`Max hail: ${a.hail} in`);
      if (a.wind) L.push(`Max wind: ${a.wind}`);
      if (a.damage) L.push(`Damage threat: ${a.damage}`);
      if (a.tornado) L.push(`Tornado: ${a.tornado}`);
    }
    if (settings.bool('settings.severeWarningsInfoBoxTextLocations')) L.push(a.area);
    const width = settings.num('settings.severeWarningsInfoBoxTextWrappingMaxCharWidth');
    return L.flatMap((l) => wrap(l, width));
  }

  screenAnchor(a: Alert): [number, number] | null {
    const c = centroid(a.rings[0]);
    const [x, y, f] = this.r.camera.project(lonLatToXYZ(c[0], c[1]));
    return f ? [x, y] : null;
  }

  /**
   * Tracking objects ("Show tracking objects"): the storm positions of each warning's motion line
   * (eventMotionDescription: time...DIR DEG...SPEED KT...lat lon pairs), advanced along the motion to the displayed
   * time, with a 30-minute motion arrow in the warning colour.
   */
  private trackLines: LineSet | null = null; private trackPts: PointSet | null = null;
  private buildTracking(act: Alert[], t: number) {
    this.trackLines ??= new LineSet(this.r); this.trackPts ??= new PointSet(this.r);
    const lines: Polyline[] = [], pts: PointSpec[] = [], styles: LineStyle[] = [];
    if (settings.bool('settings.severeWarningsShowTracking')) for (const a of act) {
      const m = parseMotion(a.motion);
      if (!m) continue;
      const toward = (m.fromDeg + 180) % 360, kmPerMin = (m.speedKt * 1.852) / 60;
      const dt = Math.max(0, Math.min(90, (t - m.timeMs) / 60e3));
      const style = styles.length;
      styles.push({ color: [...a.type!.color, 240] as never, width: 2 });
      for (const p of m.points) {
        const now = destination(p[0], p[1], toward, kmPerMin * dt), end = destination(now[0], now[1], toward, kmPerMin * 30);
        pts.push({ lon: now[0], lat: now[1], size: 8, shape: SHAPE.circle, color: [...a.type!.color, 255] as never, outline: 0.3 });
        if (kmPerMin > 0) {
          lines.push({ coords: [...now, ...end], style, height: 0.00002 });
          for (const s of [-150, 150]) lines.push({ coords: [...end, ...destination(end[0], end[1], toward + s, Math.max(1.5, kmPerMin * 4))], style, height: 0.00002 });
        }
      }
    }
    this.trackLines.setStyles(styles.length ? styles : [{ color: [0, 0, 0, 0], width: 1 }]); this.trackLines.setLines(lines); this.trackPts.setPoints(pts);
  }
  draw(ctx: DrawContext) { if (ctx.probe) return; this.fills.draw(ctx); this.watchLines.draw(ctx); this.lines.draw(ctx); this.trackLines?.draw(ctx); this.trackPts?.draw(ctx); this.text.draw(ctx); }
}

export function centroid(r: number[]): [number, number] {
  let x = 0, y = 0, n = 0;
  for (let i = 0; i + 1 < r.length; i += 2) { x += r[i]; y += r[i + 1]; n++; }
  return [x / n, y / n];
}
export function pointInRing(x: number, y: number, r: number[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > w && line) { out.push(line); line = word; } else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out;
}

/** NWS eventMotionDescription, e.g. "2026-11-15T17:56:00-00:00...storm...262DEG...28KT...3292 9893" (lat/lon × 100, west). */
export function parseMotion(text: string): { timeMs: number; fromDeg: number; speedKt: number; points: [number, number][] } | null {
  const m = /^(\S+?)\.\.\.[^.]*\.\.\.(\d{1,3})DEG\.\.\.(\d{1,3})KT\.\.\.([\d ]+)$/.exec((text ?? '').trim());
  if (!m) return null;
  const nums = m[4].trim().split(/\s+/).map(Number), points: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) points.push([-nums[i + 1] / 100, nums[i] / 100]);
  const timeMs = Date.parse(m[1]);
  return points.length && Number.isFinite(timeMs) ? { timeMs, fromDeg: +m[2], speedKt: +m[3], points } : null;
}
