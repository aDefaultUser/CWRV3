// Sounding panel (CWRV3 addition): skew-T log-p diagram, hodograph and indices for a map point, from the nearest
// observed radiosonde or a model BUFKIT profile at the timeline time, or the selected radar's VAD winds (hodograph
// only). Drawn with the 2D canvas API; the newest request wins and every result is labelled with the station, run
// and valid time the service returned.
import { drag } from './dialogs';
import { pref } from '../app/persist';
import { timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { RADAR_SITES } from '../generated/radar-sites';
import { analyze, windIndices, moistLapse, thermoLevels, windLevels, interp, KT, type Level, type SoundingIndices, type WindIndices } from '../sections/sounding-math';
import { observedSounding, modelSounding, vadSounding, SOUNDING_SOURCES, type Sounding, type SoundingSource } from '../sections/sounding-data';

const P_BOT = 1050, P_TOP = 100, T_LEFT = -40, T_RIGHT = 50;
const BANDS: [number, string][] = [[1000, '#ff5cf0'], [3000, '#ff4a4a'], [6000, '#3fd46a'], [9000, '#ffd84a'], [12000, '#4ac8ff']];
const source = pref<SoundingSource>('soundingSource', 'RAOB', (v) => SOUNDING_SOURCES.includes(v as SoundingSource));

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const ll = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

/** One line naming exactly what was returned: source, station and position, run and valid time, distance. */
export function soundingLabel(s: Sounding): string {
  if (s.source === 'RAOB') return `Observed radiosonde ${s.station} (${s.name}) · valid ${utc(s.validMs)} · ${s.distKm.toFixed(0)} km from the point`;
  if (s.source === 'VAD') return `NEXRAD VAD wind profile ${s.station} (Level 3 product 48) · volume ${utc(s.validMs)} · heights from the lowest VAD level, ${Math.round(s.levels[0].z)} m MSL · radar ${s.distKm.toFixed(0)} km from the point`;
  const run = s.runMs !== null ? ` · run ${utc(s.runMs)}${s.fhour !== null ? ` F${String(s.fhour).padStart(2, '0')}` : ''}` : '';
  return `${s.source} (IEM BUFKIT) site ${s.station.toUpperCase()} ${ll(s.lat, s.lon)}${run} · valid ${utc(s.validMs)} · ${s.distKm.toFixed(0)} km from the point`;
}

class SoundingPanel {
  readonly el: HTMLDivElement;
  private status: HTMLDivElement; private label: HTMLDivElement; private table: HTMLDivElement; private select: HTMLSelectElement;
  private skew: HTMLCanvasElement; private hodo: HTMLCanvasElement;
  private point: [number, number] = [0, 0];
  private token = 0; private ctl: AbortController | null = null;

  constructor() {
    const d = this.el = document.createElement('div');
    d.className = 'dlg'; d.style.cssText = 'left:80px;top:60px;z-index:45';
    const title = document.createElement('div'); title.className = 'dlg-title'; title.textContent = 'Sounding';
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.onclick = () => this.close();
    title.appendChild(x);
    const body = document.createElement('div'); body.className = 'dlg-body'; body.style.cssText = 'max-height:none;user-select:text';
    const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px';
    this.select = document.createElement('select');
    for (const s of SOUNDING_SOURCES) { const o = document.createElement('option'); o.value = s; o.textContent = s === 'RAOB' ? 'Observed (nearest RAOB)' : s === 'VAD' ? 'VAD winds (selected radar)' : `${s} model`; this.select.appendChild(o); }
    this.select.value = source.value;
    this.select.onchange = () => { source.value = this.select.value as SoundingSource; void this.load(); };
    const again = document.createElement('button'); again.textContent = 'Timeline time'; again.title = 'Load again at the current timeline time';
    again.onclick = () => void this.load();
    this.status = document.createElement('div'); this.status.style.cssText = 'color:var(--textDim);flex:1';
    bar.append('Source', this.select, again, this.status);
    this.label = document.createElement('div'); this.label.style.cssText = 'font-weight:600;margin-bottom:4px;max-width:830px';
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;align-items:flex-start';
    this.skew = canvas(500, 540); this.hodo = canvas(320, 320);
    const side = document.createElement('div');
    this.table = document.createElement('div'); this.table.style.cssText = 'white-space:pre;font:11px/1.45 monospace;margin-top:6px';
    side.append(this.hodo, this.table);
    row.append(this.skew, side);
    body.append(bar, this.label, row);
    d.append(title, body);
    drag(d, title);
  }

  open(lon: number, lat: number) {
    this.point = [lon, lat];
    if (!this.el.isConnected) document.getElementById('app')!.appendChild(this.el);
    void this.load();
  }
  close() { this.ctl?.abort(); this.token++; this.el.remove(); }

  /** Requests the selected source for the point at the timeline time; an older request's result is discarded. */
  private async load() {
    const token = ++this.token, src = this.select.value as SoundingSource, [lon, lat] = this.point, t = timeline.t;
    this.ctl?.abort();
    const ctl = this.ctl = new AbortController();
    this.status.textContent = `Loading ${src} for ${ll(lat, lon)} at ${utc(t)}…`;
    try {
      const s = src === 'RAOB' ? await observedSounding(lon, lat, t, ctl.signal) : src === 'VAD' ? await vadSounding(selectedRadar(), lon, lat, t) : await modelSounding(src, lon, lat, t, ctl.signal);
      if (token !== this.token) return;
      const thermo = s.source === 'VAD' ? null : analyze(s.levels), ix = thermo ?? windIndices(s.levels);
      this.status.textContent = `Requested ${ll(lat, lon)} at ${utc(t)}`;
      this.label.textContent = soundingLabel(s);
      this.label.title = s.url;
      drawSkewT(this.skew, s.levels, thermo);
      drawHodograph(this.hodo, s.levels, ix);
      this.table.textContent = indicesText(ix);
    } catch (e) {
      if (token !== this.token) return;
      this.status.textContent = `Not available: ${(e as Error).message}`;
      this.label.textContent = ''; this.table.textContent = '';
      for (const c of [this.skew, this.hodo]) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    }
  }
}

function selectedRadar() {
  const s = RADAR_SITES.find((x) => x.id === settings.str('settings.nexradSiteICAO').toUpperCase());
  if (!s) throw new Error('no NEXRAD site selected');
  return s;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.cssText = `width:${w}px;height:${h}px;background:#101014;border:1px solid var(--edge)`;
  c.getContext('2d')!.scale(dpr, dpr);
  return c;
}

const f0 = (v: number | null, unit = '') => (v === null || !Number.isFinite(v) ? 'n/a' : `${Math.round(v)}${unit}`);
const f1 = (v: number | null, unit = '') => (v === null || !Number.isFinite(v) ? 'n/a' : `${v.toFixed(1)}${unit}`);
const motion = (w: [number, number]) => `${Math.round(((Math.atan2(-w[0], -w[1]) * 180) / Math.PI + 360) % 360)}°/${Math.round(Math.hypot(w[0], w[1]) / KT)} kt`;

/** The indices as fixed-width text (wind indices only for a VAD profile). */
export function indicesText(ix: WindIndices | SoundingIndices): string {
  const row = (name: string, p: SoundingIndices['sb'], note = '') => `${name.padEnd(4)}${f0(p.cape).padStart(7)}${f0(p.cin).padStart(7)}${note}`;
  const st = ix.storm;
  const thermo = 'sb' in ix ? [
    'Parcel  CAPE    CIN  (J/kg)',
    row('SB', ix.sb), row('ML', ix.ml, '  (lowest 100 hPa)'), row('MU', ix.mu, `  (from ${ix.mu.p0.toFixed(0)} hPa)`),
    `LCL ${f0(ix.lclM, ' m')} · LFC ${f0(ix.lfcM, ' m')} · EL ${f0(ix.elM, ' m')} AGL (SB)`,
  ] : ['VAD winds only: no temperature profile'];
  const tail = 'sb' in ix ? [
    `PWAT ${(ix.pwatMm / 25.4).toFixed(2)} in (${ix.pwatMm.toFixed(1)} mm)`,
    `Lapse rate 700–500 hPa ${f1(ix.lapse700500, ' °C/km')} · 0–3 km ${f1(ix.lapse03, ' °C/km')}`,
  ] : [];
  return [
    ...thermo,
    `SRH 0–1 km ${f0(ix.srh1)} · 0–3 km ${f0(ix.srh3)} m²/s² (Bunkers RM)`,
    `Bulk shear 0–1 km ${f0(ix.shear1 === null ? null : ix.shear1 / KT, ' kt')} · 0–6 km ${f0(ix.shear6 === null ? null : ix.shear6 / KT, ' kt')}`,
    ...tail,
    st ? `Bunkers RM ${motion(st.rm)} · LM ${motion(st.lm)} · 0–6 km mean ${motion(st.mean)}` : 'Storm motion n/a (winds below 6 km missing)',
  ].join('\n');
}

/** Skew-T log-p: isobars, isotherms, dry and moist adiabats, T, Td, SB and ML parcels, LCL/LFC/EL and wind barbs. */
function drawSkewT(c: HTMLCanvasElement, levels: Level[], ix: SoundingIndices | null) {
  const g = c.getContext('2d')!, W = parseFloat(c.style.width), H = parseFloat(c.style.height);
  if (!ix) { g.clearRect(0, 0, W, H); g.fillStyle = '#8d97ab'; g.font = '12px sans-serif'; g.textAlign = 'center'; g.fillText('VAD winds only: no temperature profile', W / 2, H / 2); return; }
  const x0 = 38, y0 = 8, w = W - x0 - 56, h = H - y0 - 22;
  const y = (p: number) => y0 + (h * (Math.log(p) - Math.log(P_TOP))) / (Math.log(P_BOT) - Math.log(P_TOP));
  const x = (tc: number, p: number) => x0 + ((tc - T_LEFT) * w) / (T_RIGHT - T_LEFT) + (y0 + h - y(p));
  g.clearRect(0, 0, W, H);
  g.font = '10px sans-serif'; g.lineWidth = 1;
  g.save(); g.beginPath(); g.rect(x0, y0, w, h); g.clip();
  const curve = (pts: [number, number][], color: string, width = 1, dash: number[] = []) => {
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.beginPath();
    pts.forEach(([tc, p], i) => (i ? g.lineTo(x(tc, p), y(p)) : g.moveTo(x(tc, p), y(p))));
    g.stroke(); g.setLineDash([]);
  };
  const ps: number[] = []; for (let p = P_BOT; p >= P_TOP; p -= 10) ps.push(p);
  for (let tc = -120; tc <= 50; tc += 10) curve([[tc, P_BOT], [tc, P_TOP]], tc === 0 ? '#5a6f9a' : '#2c3445');
  for (let th = 250; th <= 460; th += 10) curve(ps.map((p) => [th * (p / 1000) ** (2 / 7) - 273.15, p]), '#3a2f22', 1);
  for (let tc = -10; tc <= 35; tc += 5) { const tt = moistLapse(ps, tc + 273.15, 1000); curve(ps.map((p, i) => [tt[i] - 273.15, p]), '#203d2c', 1, [4, 3]); }
  const th = thermoLevels(levels);
  const path = (q: SoundingIndices['sb']) => q.path.p.map((p, i) => [q.path.parcel[i] - 273.15, p] as [number, number]);
  curve(path(ix.ml), '#ffd84a', 1.4, [6, 4]);
  curve(path(ix.sb), '#f2f2f2', 1.4, [6, 4]);
  curve(th.map((l) => [l.td - 273.15, l.p]), '#2fd35f', 2);
  curve(th.map((l) => [l.t - 273.15, l.p]), '#ff4040', 2);
  g.restore();
  g.strokeStyle = '#4a4a4d'; g.strokeRect(x0, y0, w, h);
  g.fillStyle = '#aab3c5'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const p of [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100]) { g.fillText(String(p), x0 - 4, y(p)); g.strokeStyle = '#3a3a3e'; g.beginPath(); g.moveTo(x0, y(p)); g.lineTo(x0 + w, y(p)); g.stroke(); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let tc = T_LEFT; tc <= T_RIGHT; tc += 10) g.fillText(`${tc}`, x(tc, P_BOT), y0 + h + 4);
  // Parcel levels (SB) as ticks on the right edge.
  g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const [name, p] of [['LCL', ix.sb.path.lclP], ['LFC', ix.sb.lfcP], ['EL', ix.sb.elP]] as [string, number | null][]) {
    if (p === null || p < P_TOP || p > P_BOT) continue;
    g.strokeStyle = g.fillStyle = '#e8e8e8'; g.beginPath(); g.moveTo(x0 + w - 18, y(p)); g.lineTo(x0 + w, y(p)); g.stroke();
    g.fillText(name, x0 + w - 40, y(p) - 6);
  }
  // Wind barbs along the right side, at least 16 px apart.
  let last = Infinity;
  for (const l of windLevels(levels)) {
    if (l.p < P_TOP || l.p > P_BOT || last - y(l.p) < 16) continue;
    last = y(l.p);
    barb(g, x0 + w + 30, y(l.p), l.u / KT, l.v / KT);
  }
}

/** Wind barb (u, v in kt): staff toward the direction the wind comes from; pennant 50, barb 10, half barb 5. */
function barb(g: CanvasRenderingContext2D, cx: number, cy: number, u: number, v: number) {
  const spd = Math.hypot(u, v);
  g.strokeStyle = g.fillStyle = '#d8dce6'; g.lineWidth = 1.2;
  if (spd < 2.5) { g.beginPath(); g.arc(cx, cy, 3, 0, Math.PI * 2); g.stroke(); return; }
  const dx = -u / spd, dy = v / spd, L = 24; // unit vector toward the wind's origin, screen y down
  const px = -dy, py = dx; // barbs on the clockwise side of the staff
  const tip = (k: number): [number, number] => [cx + dx * (L - k), cy + dy * (L - k)];
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(...tip(0)); g.stroke();
  let rest = Math.round(spd / 5) * 5, k = 0;
  while (rest >= 50) { const [a, b] = tip(k), [c2, d2] = tip(k + 6); g.beginPath(); g.moveTo(a, b); g.lineTo(a + px * 10, b + py * 10); g.lineTo(c2, d2); g.fill(); k += 7; rest -= 50; }
  while (rest >= 10) { const [a, b] = tip(k); g.beginPath(); g.moveTo(a, b); g.lineTo(a + px * 10 + dx * 3, b + py * 10 + dy * 3); g.stroke(); k += 4; rest -= 10; }
  if (rest >= 5) { const [a, b] = tip(k === 0 ? 4 : k); g.beginPath(); g.moveTo(a, b); g.lineTo(a + px * 5 + dx * 1.5, b + py * 5 + dy * 1.5); g.stroke(); }
}

/** Hodograph (kt) coloured by height band above ground, with Bunkers right/left movers and the 0–6 km mean wind. */
function drawHodograph(c: HTMLCanvasElement, levels: Level[], ix: WindIndices) {
  const g = c.getContext('2d')!, W = parseFloat(c.style.width), H = parseFloat(c.style.height), cx = W / 2, cy = H / 2;
  const wl = windLevels(levels), z0 = wl[0]?.z ?? 0, h = wl.map((l) => l.z - z0);
  const top = Math.min(12000, h[h.length - 1] ?? 0);
  const samples: { z: number; u: number; v: number }[] = [];
  for (let z = 0; z <= top; z += 100) samples.push({ z, u: interp(z, h, wl.map((l) => l.u)) / KT, v: interp(z, h, wl.map((l) => l.v)) / KT });
  const maxSpd = Math.max(40, ...samples.map((s) => Math.hypot(s.u, s.v)));
  const ring = Math.ceil(maxSpd / 20) * 20, k = (Math.min(W, H) / 2 - 12) / ring;
  g.clearRect(0, 0, W, H); g.font = '10px sans-serif'; g.lineWidth = 1;
  g.strokeStyle = '#2c3445'; g.fillStyle = '#7d879b'; g.textAlign = 'left'; g.textBaseline = 'bottom';
  for (let r = 10; r <= ring; r += 10) { g.beginPath(); g.arc(cx, cy, r * k, 0, Math.PI * 2); g.stroke(); if (r % 20 === 0) g.fillText(`${r}`, cx + r * k * 0.71 + 2, cy - r * k * 0.71); }
  g.beginPath(); g.moveTo(cx - ring * k, cy); g.lineTo(cx + ring * k, cy); g.moveTo(cx, cy - ring * k); g.lineTo(cx, cy + ring * k); g.stroke();
  g.lineWidth = 2.5;
  for (let i = 1; i < samples.length; i++) {
    const band = BANDS.find(([zTop]) => samples[i].z <= zTop);
    if (!band) break;
    g.strokeStyle = band[1]; g.beginPath(); g.moveTo(cx + samples[i - 1].u * k, cy - samples[i - 1].v * k); g.lineTo(cx + samples[i].u * k, cy - samples[i].v * k); g.stroke();
  }
  const mark = (w: [number, number], label: string, color: string, square = false) => {
    const px = cx + (w[0] / KT) * k, py = cy - (w[1] / KT) * k;
    g.fillStyle = color; g.beginPath();
    if (square) g.rect(px - 4, py - 4, 8, 8); else g.arc(px, py, 4.5, 0, Math.PI * 2);
    g.fill(); g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.fillText(label, px + 7, py);
  };
  if (ix.storm) { mark(ix.storm.rm, 'RM', '#ff6060'); mark(ix.storm.lm, 'LM', '#6aa8ff'); mark(ix.storm.mean, 'MW', '#c8c8c8', true); }
  g.textBaseline = 'top'; g.textAlign = 'left';
  BANDS.forEach(([zTop, color], i) => { g.fillStyle = color; g.fillText(`${i ? BANDS[i - 1][0] / 1000 : 0}–${zTop / 1000} km`, 6, 6 + i * 13); });
  g.fillStyle = '#7d879b'; g.textAlign = 'right'; g.fillText('kt', W - 6, 6);
}

let panel: SoundingPanel | null = null;
/** Opens (or reuses) the sounding panel for a map point at the timeline time. */
export function openSounding(lon: number, lat: number) { (panel ??= new SoundingPanel()).open(lon, lat); }
