// NWS/SPC tab: SPC convective outlooks (family rule by day, CIG modes, layered, labels, valid time),
// mesoscale discussions (SPC MDs + WPC MPDs, by type), local storm reports (type / magnitude / age filters) and
// NWS advisories (public api.weather.gov substitute for the vendor NWSA package).
import type { Renderer } from '../render/renderer';
import type { GlyphAtlas, Color } from '../render/prims';
import { SHAPE } from '../render/prims';
import { VectorLayer, type VShape } from '../layers/vector';
import { settings } from '../settings/store';
import { fetchJson, fetchText } from '../data/net';
import { pool } from '../workers/pool';
import { XPRODUCTS } from '../generated/products-expanded';
import { timeline } from '../app/timeline';
import type { VectorLayer as VectorLayerData } from '../workers/shape-tasks';
import { registerStyleResolver } from '../app/styles';
import { loadPref, savePref, isRecord } from '../app/persist';

const SPC = 'https://www.spc.noaa.gov/';

/** Family availability by day: Days 1–2 cat/torn/hail/wind, Day 3 cat/prob, Days 4–8 prob only. */
export function familiesForDay(day: number): number[] { return day < 2 ? [0, 1, 2, 3] : day === 2 ? [0, 1] : [1]; }
export function normalizeFamily(day: number, fam: number) { return day < 2 ? Math.min(3, Math.max(0, fam)) : day === 2 ? (fam >= 1 ? 1 : 0) : 1; }

/** Outlook GeoJSON paths for a day index (0-based), family and CIG mode (table). */
export function outlookUrls(day: number, fam: number, cig: number): { main: string | null; cig: string | null } {
  const N = day + 1;
  if (day >= 3) return { main: `${SPC}products/exper/day4-8/day${N}prob.nolyr.geojson`, cig: null };
  if (day === 2) return { main: cig === 2 ? null : `${SPC}products/outlook/day3otlk_${fam === 0 ? 'cat' : 'prob'}.nolyr.geojson`, cig: fam === 1 && cig !== 0 ? `${SPC}products/outlook/day3otlk_cigprob.nolyr.geojson` : null };
  const name = ['cat', 'torn', 'hail', 'wind'][fam];
  return { main: cig === 2 && fam !== 0 ? null : `${SPC}products/outlook/day${N}otlk_${name}.nolyr.geojson`, cig: fam !== 0 && cig !== 0 ? `${SPC}products/outlook/day${N}otlk_cig${name}.nolyr.geojson` : null };
}

/** Map-object style for an outlook polygon from its LABEL (category, probability or CIG level). */
export function outlookStyle(label: string, fam: number, day: number): { style: string; z: number } {
  const L = label.trim().toUpperCase();
  const cat = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];
  if (cat.includes(L)) return { style: `COCat${L}`, z: cat.indexOf(L) };
  const cig = /^CIG\s*(\d)/.exec(L); if (cig) return { style: `COCIG${cig[1]}`, z: 20 + Number(cig[1]) };
  if (L === 'SIGN') return { style: fam === 1 ? 'COSigTorn' : fam === 2 ? 'COSigHail' : 'COSigWind', z: 30 };
  const p = Math.round(Number(L) * (Number(L) <= 1 ? 100 : 1));
  if (fam === 1 && day < 2) return { style: `COTorn${p}`, z: p };
  return { style: `COWH${p}`, z: p };
}

/** "202611151300" → epoch ms (UTC). */
export function spcTime(s: unknown): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s ?? ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

export class OutlookLayer extends VectorLayer {
  readonly id = 'spcOutlook';
  readonly title = 'SPC convective outlook';
  validText = 'Valid: ---';
  private key = '';
  private at = 0;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r, atlas); }
  enabled() { return settings.bool('layerState.NWSConvectiveOutlooksOn'); }
  labelsOn() { return settings.bool('settings.NWSConvectiveOutlooksShowLabels'); }
  filled(s: VShape) { return settings.bool('layerState.NWSConvectiveOutlooksLayered') || s.style.startsWith('COCIG') || s === this.topShape(s); }
  private top = new Map<string, VShape>();
  private topShape(s: VShape) { return this.top.get(s.label ?? '') ?? s; }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const day = settings.num('layerState.NWSConvectiveOutlooksDayIdx');
    const fam = normalizeFamily(day, settings.num('layerState.NWSConvectiveOutlooksFamilyIdx'));
    const cig = settings.num('layerState.NWSConvectiveOutlooksCIGMode');
    const key = `${day}_${fam}_${cig}`; // cache key
    if (key === this.key && Date.now() - this.at < 10 * 60e3) return;
    const urls = outlookUrls(day, fam, cig);
    this.setStatus('loading', `SPC Day ${day + 1} outlook`);
    try {
      const out: VShape[] = [];
      let valid: number | null = null, expire: number | null = null;
      for (const url of [urls.main, urls.cig]) {
        if (!url) continue;
        const gj = await fetchJson<{ features: { geometry: any; properties: Record<string, unknown> }[] }>(url);
        const feats = await pool.for(this.id).run<{ kind: string; attrs: Record<string, unknown>; parts: number[][]; tris?: number[] }[]>('geojson', { gj });
        for (const f of feats) {
          const label = String(f.attrs.LABEL ?? f.attrs.LABEL2 ?? '');
          const st = outlookStyle(label, fam, day);
          valid ??= spcTime(f.attrs.VALID); expire ??= spcTime(f.attrs.EXPIRE);
          out.push({ kind: 'polygon', parts: f.parts, tris: f.tris, style: st.style, z: st.z, label: /^0?\.\d+$/.test(label) ? `${Math.round(Number(label) * 100)}%` : label, info: [`SPC Day ${day + 1} ${['Categorical', 'Probabilistic', 'Hail', 'Wind'][fam]} outlook`, `${String(f.attrs.LABEL2 ?? label)}`, `Valid: ${fmtRange(valid, expire)}`] });
        }
      }
      // Without "Layered" only the highest level of each nested set is filled (choose).
      this.top.clear();
      const hi = out.filter((s) => !s.style.startsWith('COCIG')).sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0];
      for (const s of out) if (hi) this.top.set(s.label ?? '', hi);
      this.validText = `Valid: ${fmtRange(valid, expire)}`;
      this.key = key; this.at = Date.now();
      this.setShapes(out);
      this.setStatus('ready', `${out.length} outlook areas`);
    } catch (e) { this.setStatus('error', `SPC outlook: ${(e as Error).message}`); }
  }
  textUrl() {
    const d = settings.num('layerState.NWSConvectiveOutlooksDayIdx');
    return d >= 3 ? 'https://tgftp.nws.noaa.gov/data/raw/ac/acus48.kwns.swo.d48.txt' : `https://tgftp.nws.noaa.gov/data/raw/ac/acus0${d + 1}.kwns.swo.dy${d + 1}.txt`;
  }
}

export function fmtRange(a: number | null, b: number | null) {
  const f = (t: number) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return a && b ? `${f(a)} – ${f(b)}` : '---';
}

// ------------------------------------------------------------------------------------------- MDs
/** LAT...LON block → lon/lat ring (8-digit LLLLOOOO groups, hundredths, west longitudes; +100 when < 50). */
export function parseLatLon(text: string): number[] | null {
  const m = /LAT\.\.\.LON\s+([\d\s]+)/.exec(text);
  if (!m) return null;
  const out: number[] = [];
  for (const g of m[1].trim().split(/\s+/)) {
    if (!/^\d{8}$/.test(g)) break;
    const lat = Number(g.slice(0, 4)) / 100;
    let lon = Number(g.slice(4)) / 100;
    if (lon < 50) lon += 100;
    out.push(-lon, lat);
  }
  if (out.length >= 6 && (out[0] !== out[out.length - 2] || out[1] !== out[out.length - 1])) out.push(out[0], out[1]);
  return out.length >= 6 ? out : null;
}
/** MD type by the "Concerning" line keywords; unmatched → Severe (choose). */
export function mdType(text: string): 'Severe' | 'Winter' | 'HeavyRain' {
  const c = (/CONCERNING\.\.\.(.*)/i.exec(text)?.[1] ?? text).toUpperCase();
  const kw = XPRODUCTS.md.keywords as Record<string, readonly string[]>;
  if (kw.HeavyRain.some((k) => c.includes(k))) return 'HeavyRain';
  if (kw.Winter.some((k) => c.includes(k))) return 'Winter';
  return 'Severe';
}

export class MdLayer extends VectorLayer {
  readonly id = 'mesoDiscussions';
  readonly title = 'Mesoscale discussions';
  texts: { title: string; text: string; t: number }[] = [];
  private at = 0;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r, atlas); }
  enabled() { return settings.bool('layerState.NWSMesoscaleDiscussionsOn'); }
  labelsOn() { return settings.bool('settings.NWSMesoscaleDiscussionShowLabels'); }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    if (Date.now() - this.at < 5 * 60e3 && this.texts.length) { this.apply(); return; }
    this.setStatus('loading', 'Mesoscale discussions');
    try {
      const rss = await fetchText(XPRODUCTS.md.spc);
      const links = [...rss.matchAll(/<link>([^<]*md\d+\.html)<\/link>/g)].map((m) => m[1].replace(/^http:/, 'https:'));
      const texts: MdLayer['texts'] = [];
      await Promise.all(links.slice(0, 20).map(async (u) => {
        try {
          const html = await fetchText(u);
          const pre = /<pre>([\s\S]*?)<\/pre>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&') ?? '';
          if (pre) texts.push({ title: /Mesoscale Discussion \d+/i.exec(pre)?.[0] ?? u, text: pre, t: Date.now() });
        } catch { /* one MD failing does not hide the others */ }
      }));
      try {
        const mpd = await fetchText(XPRODUCTS.md.wpc);
        for (const part of mpd.split(/(?=Mesoscale Precipitation Discussion \d+)/i)) if (/LAT\.\.\.LON/.test(part)) texts.push({ title: /Mesoscale Precipitation Discussion \d+/i.exec(part)?.[0] ?? 'WPC MPD', text: part, t: Date.now() });
      } catch { /* WPC MPD file may be empty or unavailable */ }
      this.texts = texts; this.at = Date.now();
      this.apply();
    } catch (e) { this.setStatus('error', `MDs: ${(e as Error).message}`); }
  }
  apply() {
    const show = { Severe: settings.bool('settings.NWSMesoscaleDiscussionShowSevere'), Winter: settings.bool('settings.NWSMesoscaleDiscussionShowWinter'), HeavyRain: settings.bool('settings.NWSMesoscaleDiscussionShowHeavyRainfall') };
    const shapes: VShape[] = [];
    for (const m of this.texts) {
      const ring = parseLatLon(m.text);
      if (!ring) continue;
      const type = /Precipitation Discussion/i.test(m.title) ? 'HeavyRain' : mdType(m.text);
      if (!show[type]) continue;
      shapes.push({ kind: 'line', parts: [ring], style: `MD${type}`, label: `${m.title.replace(/Mesoscale (Precipitation )?Discussion/i, (x) => (/Precip/i.test(x) ? 'MPD' : 'MD'))} ${type === 'HeavyRain' ? 'Heavy Rain' : type}`, info: [m.title, ...(/CONCERNING\.\.\.(.*)/i.exec(m.text)?.slice(1, 2) ?? [])] });
    }
    this.setShapes(shapes);
    this.setStatus('ready', `${shapes.length} discussions`);
  }
}

// ------------------------------------------------------------------------------------------- LSRs
export const LSR_TYPES = XPRODUCTS.lsrTypes as readonly string[];
/** IEM TYPETEXT → filter bit (order); authored mapping (vendor table not transcribed, bounded). */
export function lsrTypeIndex(typetext: string): number {
  const t = typetext.toUpperCase();
  const rules: [RegExp, number][] = [[/^TORNADO/, 1], [/FUNNEL/, 2], [/^HAIL|MARINE HAIL/, 3], [/NON-TSTM WND GST/, 4], [/NON-TSTM WND DMG/, 5], [/MARINE TSTM/, 8], [/TSTM WND GST/, 6], [/TSTM WND DMG/, 7],
    [/HIGH SUST/, 9], [/BLIZZARD/, 10], [/SNOW/, 11], [/ICE STORM|FREEZING RAIN|FREEZING DRIZZLE/, 12], [/SLEET/, 13], [/HEAVY RAIN/, 14], [/FLOOD/, 15], [/LIGHTNING/, 16], [/FREEZE/, 17]];
  for (const [re, i] of rules) if (re.test(t)) return i;
  return 0;
}
const LSR_LOOK: [number, Color][] = [[SHAPE.circle, [200, 200, 200, 255]], [SHAPE.triDown, [255, 0, 0, 255]], [SHAPE.triDown, [255, 140, 140, 255]], [SHAPE.circle, [0, 200, 0, 255]], [SHAPE.square, [190, 140, 255, 255]], [SHAPE.square, [140, 100, 220, 255]],
  [SHAPE.square, [80, 120, 255, 255]], [SHAPE.square, [30, 60, 230, 255]], [SHAPE.diamond, [60, 200, 230, 255]], [SHAPE.diamond, [160, 120, 60, 255]], [SHAPE.plus, [255, 255, 255, 255]], [SHAPE.plus, [120, 200, 255, 255]],
  [SHAPE.diamond, [255, 120, 200, 255]], [SHAPE.diamond, [180, 180, 255, 255]], [SHAPE.circle, [40, 160, 60, 255]], [SHAPE.circle, [30, 190, 120, 255]], [SHAPE.bolt, [255, 230, 60, 255]], [SHAPE.circle, [120, 180, 255, 255]]];

export interface Lsr { lon: number; lat: number; t: number; type: number; typeText: string; mag: number | null; wfo: string; city: string; county: string; state: string; source: string; remark: string }

/** Shown when the type bit is set, within the age limit, and (filter on) magnitude ≥ value. */
export function lsrVisible(l: Lsr, now: number, filter: string, ageH: number, magOn: boolean, mag: number): boolean {
  if (filter[l.type] !== '1') return false;
  if (now - l.t > ageH * 3600e3 || l.t > now + 60e3) return false;
  if (magOn && !(l.mag !== null && l.mag >= mag)) return false;
  return true;
}

export class LsrLayer extends VectorLayer {
  readonly id = 'lsr';
  readonly title = 'Local storm reports';
  reports: Lsr[] = [];
  private at = 0;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r, atlas); this.labelSpacing = 0; }
  enabled() { return settings.bool('layerState.NWSLocalStormReportsOn'); }
  labelsOn() { return false; }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    if (Date.now() - this.at > 5 * 60e3) {
      this.setStatus('loading', 'Local storm reports');
      try {
        const layers = await pool.for(this.id).run<VectorLayerData[]>('shapes', { url: 'https://mesonet.agron.iastate.edu/data/gis/shape/4326/us/lsr_24hour.zip', kind: 'zip' });
        this.reports = (layers[0]?.features ?? []).filter((f) => f.kind === 'point').map((f) => {
          const a = f.attrs as Record<string, string | number | null>;
          return { lon: f.parts[0][0], lat: f.parts[0][1], t: spcTime(a.VALID) ?? 0, type: lsrTypeIndex(String(a.TYPETEXT ?? '')), typeText: String(a.TYPETEXT ?? ''), mag: a.MAG === null || a.MAG === '' || Number.isNaN(Number(a.MAG)) ? null : Number(a.MAG), wfo: String(a.WFO ?? ''), city: String(a.CITY ?? ''), county: String(a.COUNTY ?? ''), state: String(a.STATE ?? ''), source: String(a.SOURCE ?? ''), remark: String(a.REMARK ?? '') };
        });
        this.at = Date.now();
      } catch (e) { this.setStatus('error', `LSR: ${(e as Error).message}`); return; }
    }
    this.apply();
  }
  apply() {
    const filter = settings.str('ini.NWSLocalStormReports.TypeFilter');
    // Age is measured from the map time, so looping the timeline replays the reports.
    const shapes: VShape[] = this.reports.filter((l) => lsrVisible(l, timeline.t, filter, settings.num('settings.NWSLSRShowReportsWithinHours'), settings.bool('settings.NWSLSRMagnitudeFilter'), settings.num('settings.NWSLSRMagnitudeFilterValue'))).map((l) => ({
      kind: 'point', parts: [[l.lon, l.lat]], style: 'LSR', t: l.t,
      point: { size: 12, shape: LSR_LOOK[l.type][0], color: LSR_LOOK[l.type][1], outline: 0.18 },
      info: ['Local Storm Report', `Time: ${new Date(l.t).toLocaleString()}`, `City: ${l.city}`, `County/State: ${l.county}, ${l.state}`, `Position: ${l.lat.toFixed(2)}, ${l.lon.toFixed(2)}`, `Type: ${l.typeText}`, `Magnitude: ${l.mag ?? '-'}`, `WFO: ${l.wfo}`, `Source: ${l.source}`, `Remark: ${l.remark}`],
    }));
    this.setShapes(shapes);
    this.setStatus('ready', `${shapes.length} of ${this.reports.length} reports`);
  }
}

// ------------------------------------------------------------------------------------------- advisories (NWSA)
export interface AdvisoryStyle { visible: boolean; color: [number, number, number] }
const ADV_KEY = 'nwsaStyles';
export const advisoryStyles = loadPref<Record<string, AdvisoryStyle>>(ADV_KEY, {}, isRecord);
export function saveAdvisoryStyles() { return savePref(ADV_KEY, advisoryStyles, 'advisory styles'); }
/** Deterministic default colour per event name (CWRV3 choice; NWS hazard colours are not machine-published). */
export function eventColor(name: string): [number, number, number] {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = (h % 360) / 360, s = 0.65, l = 0.55;
  const f = (n: number) => { const k = (n + hue * 12) % 12; return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

registerStyleResolver('Advisory:', (event) => {
  const st = advisoryStyles[event] ?? { visible: true, color: eventColor(event) };
  return { fill: [...st.color, 60] as Color, line: [...st.color, 255] as Color, width: 1.5, pattern: 0, patternSize: 8, dash: 0, visible: st.visible };
});

/** Simplification tolerance (degrees) for advisory polygons: NWSAdvisoriesResolution 0 = finest, each step coarser. */
export function advisoryTolerance(base: number, res = settings.num('settings.NWSAdvisoriesResolution')): number { return base * (1 + Math.max(0, res)); }

export class AdvisoryLayer extends VectorLayer {
  readonly id = 'advisories';
  readonly title = 'NWS advisories';
  events: string[] = [];
  private alerts: { event: string; parts: number[][]; tris?: number[]; info: string[] }[] = [];
  private zoneGeo = new Map<string, Promise<{ parts: number[][]; tris?: number[] } | null>>();
  private at = 0;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r, atlas); }
  enabled() { return settings.bool('layerState.NWSAdvisoriesOn'); }
  labelsOn() { return false; }
  filled() { return !settings.bool('settings.NWSAdvisoriesNoBorders'); }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    if (Date.now() - this.at < 2 * 60e3) { this.apply(); return; }
    this.setStatus('loading', 'NWS advisories');
    try {
      const gj = await fetchJson<{ features: { geometry: any; properties: { event: string; headline?: string; areaDesc?: string; expires?: string; affectedZones?: string[] } }[] }>('https://api.weather.gov/alerts/active?status=actual&message_type=alert,update');
      const out: AdvisoryLayer['alerts'] = [];
      await Promise.all(gj.features.map(async (f) => {
        const p = f.properties;
        const info = [p.event, p.headline ?? '', p.areaDesc ?? '', p.expires ? `Expires ${new Date(p.expires).toLocaleString()}` : ''];
        if (f.geometry) {
          const [feat] = await pool.for(this.id).run<{ parts: number[][]; tris?: number[] }[]>('geojson', { gj: { features: [{ geometry: f.geometry, properties: {} }] }, tol: advisoryTolerance(0.004) });
          if (feat) out.push({ event: p.event, parts: feat.parts, tris: feat.tris, info });
          return;
        }
        // Zone-based alerts: zone geometry from api.weather.gov, cached per zone (bounded to 60 zones per alert).
        for (const z of (p.affectedZones ?? []).slice(0, 60)) {
          const g = await this.zone(z);
          if (g) out.push({ event: p.event, parts: g.parts, tris: g.tris, info });
        }
      }));
      this.alerts = out; this.at = Date.now();
      this.events = [...new Set(out.map((a) => a.event))].sort();
      this.apply();
    } catch (e) { this.setStatus('error', `NWS alerts: ${(e as Error).message}`); }
  }
  private zone(url: string) {
    let p = this.zoneGeo.get(url);
    if (!p) {
      p = fetchJson<{ geometry: any }>(url, { cache: 'immutable' }).then(async (z) => (z.geometry ? (await pool.for(this.id).run<{ parts: number[][]; tris?: number[] }[]>('geojson', { gj: { features: [{ geometry: z.geometry, properties: {} }] }, tol: advisoryTolerance(0.01) }))[0] ?? null : null), () => null);
      this.zoneGeo.set(url, p);
    }
    return p;
  }
  styleOf(event: string): AdvisoryStyle { return advisoryStyles[event] ?? { visible: true, color: eventColor(event) }; }
  apply() {
    const shapes: VShape[] = [];
    for (const a of this.alerts) {
      const st = this.styleOf(a.event);
      if (!st.visible) continue;
      shapes.push({ kind: 'polygon', parts: settings.bool('settings.NWSAdvisoriesNoLines') ? [] : a.parts, tris: a.tris, style: `Advisory:${a.event}`, info: a.info });
    }
    this.setShapes(shapes);
    this.setStatus('ready', `${this.alerts.length} areas, ${this.events.length} event types`);
  }
}
