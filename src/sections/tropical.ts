// Tropical tab: active systems (TC vitals), best track and model / official forecast tracks (ATCF
// b- and a-decks), NHC cone and watch/warning lines, wind radii (current, interpolated, forecast), aircraft
// reconnaissance (HDOB), the 7-day formation outlook, the info panel, text products and center extrapolation.
import type { Renderer } from '../render/renderer';
import { SHAPE, type GlyphAtlas, type Color } from '../render/prims';
import { VectorLayer, type VShape } from '../layers/vector';
import { settings } from '../settings/store';
import { fetchBytes, fetchText, parseDirIndex } from '../data/net';
import { gunzip } from '../decode/zip';
import { pool } from '../workers/pool';
import { timeline } from '../app/timeline';
import { destination } from '../layers/annotations';
import type { VectorLayer as Decoded } from '../workers/shape-tasks';
import { compass } from './surface-math';
import { registerStyleResolver } from '../app/styles';
import { eventColor } from './nwsspc';
import { prefObject } from '../app/persist';

registerStyleResolver('Model:', (tech) => { const c = eventColor(tech); return { fill: [0, 0, 0, 0], line: [c[0], c[1], c[2], 230], width: 1.4, pattern: 0, patternSize: 8, dash: 0, visible: true }; });

const NHC = 'https://ftp.nhc.noaa.gov/atcf/';
const BASIN: Record<string, string> = { L: 'al', E: 'ep', C: 'cp', W: 'wp', A: 'io', B: 'io', S: 'sh', P: 'sh', Q: 'sl' };

export interface TropSystem { org: string; id: string; atcf: string; name: string; t: number; lat: number; lon: number; dir: number; speedMs: number; pres: number; vmaxMs: number; invest: boolean }

/** TC vitals line (public NCEP format): ORG ID NAME YYYYMMDD HHMM LAT LON DIR SPD(m/s×10) PCEN PENV RENV VMAX(m/s) … */
export function parseTcvitals(text: string): TropSystem[] {
  const out: TropSystem[] = [];
  for (const l of text.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 13) continue;
    const ll = (s: string, neg: string) => (Number(s.slice(0, -1)) / 10) * (s.endsWith(neg) ? -1 : 1);
    const id = f[1], num = id.slice(0, 2), basin = BASIN[id.slice(-1)] ?? 'xx';
    const t = Date.UTC(+f[3].slice(0, 4), +f[3].slice(4, 6) - 1, +f[3].slice(6, 8), +f[4].slice(0, 2), +f[4].slice(2, 4));
    out.push({ org: f[0], id, atcf: `${basin}${num}${f[3].slice(0, 4)}`, name: f[2], t, lat: ll(f[5], 'S'), lon: ll(f[6], 'W'), dir: Number(f[7]), speedMs: Number(f[8]) / 10, pres: Number(f[9]), vmaxMs: Number(f[12]), invest: Number(num) >= 90 });
  }
  // Keep one line per storm, preferring NHC over JTWC.
  const best = new Map<string, TropSystem>();
  for (const s of out) { const p = best.get(s.atcf); if (!p || (s.org === 'NHC' && p.org !== 'NHC') || (s.org === p.org && s.t > p.t)) best.set(s.atcf, s); }
  return [...best.values()].sort((a, b) => a.atcf.localeCompare(b.atcf));
}

export interface AtcfLine { basin: string; cy: string; t: number; tech: string; tau: number; lat: number; lon: number; vmax: number; mslp: number; ty: string; rad: number; quad: [number, number, number, number] }
/** ATCF a/b-deck CSV (public NHC/JTWC ATCF format). */
export function parseAtcf(text: string): AtcfLine[] {
  const out: AtcfLine[] = [];
  for (const l of text.split('\n')) {
    const f = l.split(',').map((x) => x.trim());
    if (f.length < 9 || !/^\d{10}$/.test(f[2])) continue;
    const ll = (s: string, neg: string) => (Number(s.slice(0, -1)) / 10) * (s.endsWith(neg) ? -1 : 1);
    out.push({ basin: f[0], cy: f[1], t: Date.UTC(+f[2].slice(0, 4), +f[2].slice(4, 6) - 1, +f[2].slice(6, 8), +f[2].slice(8, 10)), tech: f[4], tau: Number(f[5] || 0), lat: ll(f[6], 'S'), lon: ll(f[7], 'W'),
      vmax: Number(f[8] || 0), mslp: Number(f[9] || 0), ty: f[10] ?? '', rad: Number(f[11] || 0), quad: [Number(f[13] || 0), Number(f[14] || 0), Number(f[15] || 0), Number(f[16] || 0)] });
  }
  return out;
}

/** Model technique sets (exact vendor lists are a bounded unknown, — chosen here). */
export function techniqueSet(tech: string): 'official' | 'late' | 'ensemble' | 'current' | 'other' {
  if (tech === 'OFCL' || tech === 'OFCI') return 'official';
  if (/^(AP\d\d|AC00|AEMN|AEMI)$/.test(tech)) return 'ensemble';
  if (/^(CARQ|WRNG|BEST|XTRP|CLP5|TCLP|SHIP|DSHP|LGEM|SHF5|DRCL|TABS|TABM|TABD|BAMS|BAMM|BAMD)$/.test(tech)) return /^(TAB|BAM)/.test(tech) ? 'current' : 'other';
  if (/I$|2$/.test(tech) && tech.length === 4) return 'late';
  return 'current';
}

export interface Hdob { t: number; lat: number; lon: number; pres: number | null; height: number | null; temp: number | null; dew: number | null; wdir: number | null; wspd: number | null; max10s: number | null; sfmr: number | null; rain: number | null }
/** URNT15 HDOB lines (public NHC format). */
export function parseHdob(text: string, nowMs: number): Hdob[] {
  const out: Hdob[] = [];
  let day = new Date(nowMs);
  const hdr = /HDOB\s+\d+\s+(\d{8})/.exec(text);
  if (hdr) day = new Date(Date.UTC(+hdr[1].slice(0, 4), +hdr[1].slice(4, 6) - 1, +hdr[1].slice(6, 8)));
  for (const l of text.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 12 || !/^\d{6}$/.test(f[0]) || !/^\d{4}[NS]$/.test(f[1])) continue;
    const num = (s: string) => (/\//.test(s) ? null : Number(s));
    const ll = (s: string, deg: number) => (Number(s.slice(0, deg)) + Number(s.slice(deg, deg + 2)) / 60) * (/[SW]$/.test(s) ? -1 : 1);
    let p = num(f[3]); if (p !== null) { p /= 10; if (p < 300) p += 1000; }
    const signed = (s: string) => (/\//.test(s) ? null : Number(s) / 10);
    out.push({ t: Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), +f[0].slice(0, 2), +f[0].slice(2, 4), +f[0].slice(4, 6)), lat: ll(f[1], 2), lon: ll(f[2], 3), pres: p, height: num(f[4]), temp: signed(f[6]), dew: signed(f[7]),
      wdir: /\//.test(f[8]) ? null : Number(f[8].slice(0, 3)), wspd: /\//.test(f[8]) ? null : Number(f[8].slice(3)), max10s: num(f[9]), sfmr: num(f[10]), rain: num(f[11]) });
  }
  return out;
}

/** Four-quadrant wind-radii ring (NE, SE, SW, NW radii in nmi) around a center. */
export function radiiRing(lon: number, lat: number, quad: [number, number, number, number]): number[] {
  const ring: number[] = [];
  for (let q = 0; q < 4; q++) for (let a = 0; a <= 90; a += 6) { const [x, y] = destination(lon, lat, q * 90 + a, quad[q] * 1.852); ring.push(x, y); }
  ring.push(ring[0], ring[1]);
  return ring;
}

/** Saffir-Simpson colour by maximum wind (kt). */
export function intensityColor(kt: number): Color {
  if (kt < 34) return [90, 160, 255, 255]; if (kt < 64) return [80, 220, 120, 255]; if (kt < 83) return [255, 255, 120, 255];
  if (kt < 96) return [255, 200, 60, 255]; if (kt < 113) return [255, 130, 40, 255]; if (kt < 137) return [255, 40, 40, 255]; return [255, 80, 255, 255];
}

export class TropicalLayer extends VectorLayer {
  readonly id = 'tropical';
  readonly title = 'Tropical';
  systems: TropSystem[] = [];
  selected = -1;
  private readonly opts = prefObject('tropicalOptions', { filterSelected: false });
  get filterSelected() { return this.opts.filterSelected; }
  set filterSelected(v: boolean) { this.opts.filterSelected = v; }
  busyText = false;
  private decks = new Map<string, { b: AtcfLine[]; a: AtcfLine[]; at: number; gis: Decoded[] | null }>();
  private gtwo: Decoded[] = [];
  private recon: Hdob[] = [];
  private at = 0;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r, atlas); this.labelSpacing = 30; }
  private on(k: string) { return settings.bool(`layerState.Tropical${k}On`); }
  enabled() { return ['ActiveSystems', 'BestTrack', 'OfficialForecast', 'NHCForecastCone', 'ForecastModels', 'WindRadii', 'ForecastRadii', 'ReconData', 'WatchesWarnings', 'FormationProbabilities'].some((k) => this.on(k)); }
  visibleSystems() { return this.systems.filter((s) => settings.bool('settings.tropicalShowInvestSystems') || !s.invest); }
  selectedSystem() { return this.visibleSystems()[this.selected] ?? null; }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    this.setStatus('loading', 'Tropical');
    try {
      if (Date.now() - this.at > 10 * 60e3) {
        this.systems = parseTcvitals(await fetchText(NHC + 'com/tcvitals'));
        this.at = Date.now();
      }
      const need = this.on('BestTrack') || this.on('OfficialForecast') || this.on('ForecastModels') || this.on('WindRadii') || this.on('ForecastRadii') || this.on('NHCForecastCone') || this.on('WatchesWarnings');
      if (need) await Promise.all(this.visibleSystems().filter((s) => /^(al|ep|cp)/.test(s.atcf) && !s.invest).map((s) => this.loadDeck(s)));
      if (this.on('FormationProbabilities') && !this.gtwo.length) this.gtwo = await pool.for(this.id).run<Decoded[]>('shapes', { url: 'https://www.nhc.noaa.gov/xgtwo/gtwo_shapefiles.zip', kind: 'zip' });
      if (this.on('ReconData')) this.recon = parseHdob(await fetchText('https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.knhc..txt'), Date.now());
      this.apply();
      this.setStatus('ready', `${this.systems.length} active systems`);
    } catch (e) { this.setStatus('error', `Tropical: ${(e as Error).message}`); }
  }

  private async loadDeck(s: TropSystem) {
    const c = this.decks.get(s.atcf);
    if (c && Date.now() - c.at < 15 * 60e3) return;
    const [b, a, gis] = await Promise.all([
      fetchText(`${NHC}btk/b${s.atcf}.dat`).then(parseAtcf, () => []),
      fetchBytes(`${NHC}aid_public/a${s.atcf}.dat.gz`).then(async (x) => parseAtcf(new TextDecoder().decode(await gunzip(x))), () => []),
      pool.for(this.id).run<Decoded[]>('shapes', { url: `https://www.nhc.noaa.gov/gis/forecast/archive/${s.atcf}_5day_latest.zip`, kind: 'zip' }).catch(() => null),
    ]);
    this.decks.set(s.atcf, { b, a, gis, at: Date.now() });
  }

  /** Current center: last fix advanced along the reported motion to the map time (linear, capped at 6 h). */
  center(s: TropSystem): [number, number] {
    if (!settings.bool('settings.tropicalExtrapolateCenters')) return [s.lon, s.lat];
    const h = Math.max(0, Math.min(6, (timeline.t - s.t) / 3600e3));
    return destination(s.lon, s.lat, s.dir, (s.speedMs * 3.6) * h);
  }

  apply() {
    const shapes: VShape[] = [];
    const sel = this.selectedSystem();
    const show = this.visibleSystems().filter((s) => !this.filterSelected || s === sel);
    for (const s of show) {
      const d = this.decks.get(s.atcf);
      const kt = s.vmaxMs * 1.943844;
      if (this.on('ActiveSystems')) {
        const [lon, lat] = this.center(s);
        shapes.push({ kind: 'point', parts: [[lon, lat]], style: 'TropBestTrack', z: 50, label: s.name, point: { size: s.invest ? 12 : 18, shape: s.invest ? SHAPE.ring : SHAPE.circle, color: intensityColor(kt), outline: 0.18 },
          info: ['Active System', `${s.name} (${s.atcf.toUpperCase()})`, `Time: ${new Date(s.t).toLocaleString()}`, `Central Pressure: ${s.pres}mb`, `Maximum Wind: ${Math.round(kt * 1.15078)}mph`, `Motion Speed: ${Math.round(s.speedMs * 2.23694)}mph`, `Motion Direction: ${s.dir}° (${compass(s.dir)})`] });
      }
      if (!d) continue;
      const fixes = d.b.filter((x) => x.rad === 34 || x.rad === 0);
      if (this.on('BestTrack') && fixes.length) {
        const coords = fixes.flatMap((x) => [x.lon, x.lat]);
        shapes.push({ kind: 'line', parts: [coords], style: 'TropBestTrack', z: 10 });
        for (const x of fixes) shapes.push({ kind: 'point', parts: [[x.lon, x.lat]], style: 'TropBestTrack', z: 11, point: { size: 7, shape: SHAPE.circle, color: intensityColor(x.vmax), outline: 0.2 }, info: ['Tropical Best Track', `${s.name} ${new Date(x.t).toUTCString().slice(5, 22)}Z`, `Maximum Wind: ${Math.round(x.vmax * 1.15078)}mph`, `Central Pressure: ${x.mslp}mb`, `Type: ${x.ty}`] });
      }
      const latestRun = (tech: (t: string) => boolean) => { const ls = d.a.filter((x) => tech(x.tech)); const t0 = Math.max(...ls.map((x) => x.t)); return ls.filter((x) => x.t === t0); };
      if (this.on('OfficialForecast') || this.on('ForecastRadii')) {
        const ofcl = latestRun((t) => t === 'OFCL');
        const pts = ofcl.filter((x) => x.rad === 34 || x.rad === 0).sort((a, b) => a.tau - b.tau);
        if (this.on('OfficialForecast') && pts.length) {
          shapes.push({ kind: 'line', parts: [pts.flatMap((x) => [x.lon, x.lat])], style: 'TropForecastTrack', z: 12 });
          for (const x of pts) shapes.push({ kind: 'point', parts: [[x.lon, x.lat]], style: 'TropForecastTrack', z: 13, label: `${x.tau}h`, point: { size: 9, shape: SHAPE.ring, color: intensityColor(x.vmax) }, info: ['Official Forecast', `${s.name} +${x.tau} h`, `Maximum Wind: ${Math.round(x.vmax * 1.15078)}mph`] });
        }
        if (this.on('ForecastRadii')) for (const x of ofcl) if (x.rad && x.quad.some((q) => q > 0) && x.tau > 0) shapes.push({ kind: 'polygon', parts: [radiiRing(x.lon, x.lat, x.quad)], tris: undefined, style: `WindRadii${x.rad}Kt`, z: 2 + x.rad / 100 });
      }
      if (this.on('ForecastModels')) {
        const type = settings.num('settings.tropicalForecastModelTypeIdx');
        const want = type === 2 ? 'ensemble' : type === 1 ? 'late' : 'current';
        const run = latestRun((t) => techniqueSet(t) === want);
        const byTech = new Map<string, AtcfLine[]>();
        for (const x of run) if (x.rad === 34 || x.rad === 0) { if (!byTech.has(x.tech)) byTech.set(x.tech, []); byTech.get(x.tech)!.push(x); }
        for (const [tech, ls] of byTech) { ls.sort((a, b) => a.tau - b.tau); if (ls.length > 1) shapes.push({ kind: 'line', parts: [ls.flatMap((x) => [x.lon, x.lat])], style: `Model:${tech}`, z: 5, label: tech, info: [`Model track ${tech}`, `${s.name}, run ${new Date(ls[0].t).toUTCString().slice(5, 22)}Z`] }); }
      }
      if (this.on('WindRadii')) {
        // Current radii: newest best-track radii, or interpolated between the two OFCL taus around the map time.
        const latest = d.b.filter((x) => x.t === Math.max(...d.b.map((y) => y.t)) && x.rad > 0);
        let rad = latest.map((x) => ({ rad: x.rad, quad: x.quad, lon: x.lon, lat: x.lat }));
        if (settings.bool('settings.tropicalInterpolateWindRadii')) {
          const ofcl = latestRun((t) => t === 'OFCL').filter((x) => x.rad > 0);
          const tau = (timeline.t - (ofcl[0]?.t ?? timeline.t)) / 3600e3;
          if (ofcl.length && tau > 0) {
            const at = (r: number) => { const ls = ofcl.filter((x) => x.rad === r).sort((a, b) => a.tau - b.tau); const i = ls.findIndex((x) => x.tau >= tau); if (i <= 0) return null; const a = ls[i - 1], b = ls[i], w = (tau - a.tau) / (b.tau - a.tau); return { rad: r, lon: a.lon + (b.lon - a.lon) * w, lat: a.lat + (b.lat - a.lat) * w, quad: a.quad.map((q, k) => q + (b.quad[k] - q) * w) as AtcfLine['quad'] }; };
            const ip = [34, 50, 64].map(at).filter((x): x is NonNullable<typeof x> => !!x);
            if (ip.length) rad = ip;
          }
        }
        for (const x of rad) if (x.quad.some((q) => q > 0)) shapes.push({ kind: 'polygon', parts: [radiiRing(x.lon, x.lat, x.quad)], style: `WindRadii${x.rad}Kt`, z: 3 + x.rad / 100, info: [`${x.rad} kt wind radii`, `NE ${x.quad[0]} SE ${x.quad[1]} SW ${x.quad[2]} NW ${x.quad[3]} nmi`] });
      }
      for (const l of d.gis ?? []) for (const f of l.features) {
        if (this.on('NHCForecastCone') && /5day_pgn/i.test(l.name) && f.kind === 'polygon') shapes.push({ kind: 'polygon', parts: f.parts, tris: f.tris, style: 'NHCCone', z: 1, info: ['NHC Forecast Cone', `${s.name}`] });
        if (this.on('WatchesWarnings') && /wwlin/i.test(l.name) && f.kind === 'line') {
          const t = String(f.attrs.TCWW ?? '').toUpperCase();
          const style = t === 'HWR' ? 'NHCHurWarn' : t === 'HWA' ? 'NHCHurWatch' : t === 'TWR' ? 'NHCTSWarn' : 'NHCTSWatch';
          shapes.push({ kind: 'line', parts: f.parts, style, z: 20, info: [{ HWR: 'Hurricane Warning', HWA: 'Hurricane Watch', TWR: 'Tropical Storm Warning', TWA: 'Tropical Storm Watch' }[t] ?? t, s.name] });
        }
      }
    }
    if (this.on('FormationProbabilities')) for (const l of this.gtwo) for (const f of l.features) {
      const risk = String(f.attrs.RISK7DAY ?? f.attrs.RISK2DAY ?? '').toLowerCase();
      const style = /high/.test(risk) ? 'GTwo2' : /med/.test(risk) ? 'GTwo1' : 'GTwo0';
      const info = ['Tropical Weather Outlook', `7-day: ${f.attrs.PROB7DAY ?? '-'} (${f.attrs.RISK7DAY ?? '-'})`, `2-day: ${f.attrs.PROB2DAY ?? '-'} (${f.attrs.RISK2DAY ?? '-'})`];
      if (f.kind === 'polygon') shapes.push({ kind: 'polygon', parts: f.parts, tris: f.tris, style, z: 0, info });
      else if (f.kind === 'line') shapes.push({ kind: 'line', parts: f.parts, style, z: 0, info });
      else shapes.push({ kind: 'point', parts: f.parts, style, z: 1, point: { size: 14, shape: SHAPE.ring, color: [255, 200, 0, 255] }, info });
    }
    if (this.on('ReconData')) for (const h of this.recon.slice(-400)) {
      const kt = h.wspd ?? 0;
      shapes.push({ kind: 'point', parts: [[h.lon, h.lat]], style: 'Recon', point: { size: 6, shape: SHAPE.dot, color: intensityColor(kt) },
        info: ['HDOB Data', `Time: ${new Date(h.t).toUTCString().slice(17, 25)}Z`, `Aircraft Pressure: ${h.pres?.toFixed(1) ?? '-'}mb`, `Aircraft Height: ${h.height ?? '-'}m`, `Air Temp: ${h.temp ?? '-'}°C`, `Dew Pt: ${h.dew ?? '-'}°C`, `Wind Speed: ${h.wspd ?? '-'}kt`, `Wind Direction: ${h.wdir ?? '-'}°`, `Max 10s Surface Wind: ${h.sfmr ?? '-'}kt`, `SFMR-Derived Rain Rate: ${h.rain ?? '-'} mm/hr`] });
    }
    // Triangulate radii rings lazily (simple fan: rings are star-shaped around their centre).
    for (const sh of shapes) if (sh.kind === 'polygon' && !sh.tris && sh.parts[0]) sh.tris = fan(sh.parts[0]);
    this.setShapes(shapes);
  }

  async advisoryText(): Promise<string> {
    const s = this.selectedSystem(); if (!s) return 'No system selected';
    const list = parseDirIndex(await fetchText(NHC + 'adv/')).map((x) => x.name).filter((n) => n.startsWith(`${s.atcf}_info`)).sort();
    if (!list.length) return `No advisory information file for ${s.atcf.toUpperCase()} on ${NHC}adv/`;
    return fetchText(NHC + 'adv/' + list[list.length - 1]);
  }
  async discussionText(): Promise<string> {
    const s = this.selectedSystem(); if (!s) return 'No system selected';
    const list = parseDirIndex(await fetchText(NHC + 'dis/')).map((x) => x.name).filter((n) => n.startsWith(`${s.atcf}.discus.`)).sort();
    if (!list.length) return `No discussion for ${s.atcf.toUpperCase()} on ${NHC}dis/`;
    return fetchText(NHC + 'dis/' + list[list.length - 1]);
  }
}

function fan(ring: number[]): number[] {
  let cx = 0, cy = 0; const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cy += ring[i + 1]; }
  cx /= n; cy /= n;
  const out: number[] = [];
  for (let i = 0; i + 3 < ring.length; i += 2) out.push(cx, cy, ring[i], ring[i + 1], ring[i + 2], ring[i + 3]);
  return out;
}
