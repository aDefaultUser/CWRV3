// METAR and marine numerics of the Surface tab, implemented from the instruction-level addendum.
// Parity mode reproduces the recovered arithmetic, gates, storage units, rounding and display filters, including
// the vendor deviations (…). The optional corrected mode (off by default, ext setting
// ext.settings.surfaceCorrectedFormulas) uses the NWS forms instead and is reported as non-parity.
import { rne } from '../util/round';

export const MISSING = 9999;
const KT_MPH = 1.15077945;
const KT_MPH_PROBE = 1.15078;

export interface MetarReport {
  station: string; timeMs: number;
  /** knots, 255 missing */ wspeed: number; /** knots, 255 missing */ wgust: number;
  /** degrees, 65534 variable, 65535 missing */ wdir: number;
  /** class code, 255 = no weather group */ wx: number;
  /** whole °C, 32767 missing */ temp: number; dewpt: number;
  /** hPa, 0 missing */ alti: number;
  /** percent byte, 255 missing */ rh: number;
  /** whole °F, 32767 missing */ wchill: number; hindex: number;
  raw: string;
}

const isDigit = (c: string | undefined) => !!c && c >= '0' && c <= '9';

/** Splits weather text and classifies it. Returns 255 when no weather group remains. */
export function weatherClass(groups: string[], corrected = false): number {
  const g = [...groups];
  const sky = (x: string) => /^VV/.test(x) || (x.length > 2 && isDigit(x[x.length - 1])) || /^(NSC|NCD|CLR|BKN|FEW|SKC|OVC|SCT)/.test(x) || x === 'CAVOK';
  const nonWx = (x: string) => x.length === 1 || isDigit(x[0]) || isDigit(x[x.length - 1]) || /(SM|KM)$/.test(x) || x === 'CAVOK' || /^\d{4}$/.test(x);
  while (g.length && sky(g[g.length - 1])) g.pop();
  while (g.length && nonWx(g[0])) g.shift();
  if (!g.length) return 255;
  return classifyWeather(g.map((x) => x + ' ').join(''), corrected);
}

export function classifyWeather(text: string, corrected = false): number {
  if (text.length <= 1 || text.length >= 14 || isDigit(text[text.length - 1])) return 0;
  const ts = text.includes('TS');
  let t = text.replace(/VC/g, '').replace(/SH/g, '');
  if (ts) t = t.replace(/TS/g, '');
  const inten = t.includes('-') ? -1 : t.includes('+') ? 1 : 0;
  let c: number;
  if (t.includes('FC')) c = 21;
  else if (t.includes('GR') || t.includes('GS') || t.includes('PR') || t.includes('PE') || (corrected && t.includes('PL'))) c = 11;
  else if (t.includes('DZ') && t.includes('SN')) c = 12;
  else if (t.includes('FZDZ')) c = 17 + inten;
  else if (t.includes('DZ')) c = 6 + inten;
  else if (t.includes('RA') && t.includes('SN')) c = 12;
  else if (t.includes('FZRA')) c = 14 + inten;
  else if (t.includes('RA')) c = 3 + inten;
  else if (t.includes('SN')) c = 9 + inten;
  else if (t.includes('FG')) c = 20;
  else if (t.includes('BR')) c = 19;
  else c = 0;
  return ts ? c + 22 : c;
}

/** Parses one METAR/SPECI report. Returns null when the report is not accepted. */
export function parseMetar(raw: string, nowMs: number, corrected = false): MetarReport | null {
  let groups = raw.replace(/=\s*$/, '').trim().split(/\s+/);
  if (groups[0] === 'METAR' || groups[0] === 'SPECI') groups = groups.slice(1);
  if (groups.length <= 2 || groups[0].length !== 4 || groups[1].length !== 7 || !groups[1].endsWith('Z')) return null;
  const r: MetarReport = { station: groups[0], timeMs: reportTime(groups[1], nowMs), wspeed: 255, wgust: 255, wdir: 65535, wx: 255, temp: 32767, dewpt: 32767, alti: 0, rh: 255, wchill: 32767, hindex: 32767, raw };
  const wi = groups[2] === 'AUTO' ? 3 : 2;
  const wg = groups[wi] ?? '';
  if (wg.length > 6 && wg[0] !== '/') {
    r.wdir = wg[0] === 'V' || /[A-Z]/.test(wg[0]) ? 65534 : Number(wg.slice(0, 3));
    if (!Number.isFinite(r.wdir)) r.wdir = 65535;
    const three = isDigit(wg[3]) && isDigit(wg[5]);
    let sp = Number(wg.slice(3, three ? 6 : 5));
    const gm = /G(\d{1,3})/.exec(wg.slice(3));
    let gu = gm ? Number(gm[1]) : NaN;
    if (wg.endsWith('MPS')) { sp = rne(sp * 1.94384449); if (gu === gu) gu = rne(gu * 1.94384449); }
    if (Number.isFinite(sp) && sp >= 0 && sp < 255) r.wspeed = sp;
    if (Number.isFinite(gu) && gu >= 0 && gu < 255) r.wgust = gu;
  }
  // Temperature: first group after the wind group with "/" that does not end in M (skips 1/2SM).
  let ti = -1;
  for (let i = wi + 1; i < groups.length; i++) if (groups[i].includes('/') && !groups[i].endsWith('M')) { ti = i; break; }
  if (ti >= 0) {
    const [a, b] = groups[ti].split('/');
    const deg = (x: string | undefined) => { if (!x) return 32767; const n = x[0] === 'M' ? -Number(x.slice(1)) : Number(x); return Number.isInteger(n) && x.length > 0 && /^M?\d+$/.test(x) ? n : 32767; };
    r.temp = deg(a); r.dewpt = deg(b);
    const al = groups[ti + 1];
    if (al && al.length === 5) {
      if (al[0] === 'Q' && /^\d{4}$/.test(al.slice(1))) r.alti = Number(al.slice(1));
      else if (al[0] === 'A' && /^\d{4}$/.test(al.slice(1))) r.alti = (Number(al.slice(1)) / 100) * 33.8638866667;
    }
  }
  r.wx = weatherClass(groups.slice(wi + 1, ti >= 0 ? ti : groups.length), corrected);
  derive(r, corrected);
  return r;
}

/** Day/hour/minute with the current year and month; more than 60 minutes ahead → previous month. */
export function reportTime(g: string, nowMs: number): number {
  const d = Number(g.slice(0, 2)), h = Number(g.slice(2, 4)), m = Number(g.slice(4, 6));
  const now = new Date(nowMs);
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d, h, m);
  if (t - nowMs > 60 * 60e3) t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, d, h, m);
  return t;
}

/** RH, heat index and wind chill (corrected = NWS forms, /11). */
export function derive(r: MetarReport, corrected = false) {
  if (r.temp === 32767) return;
  const T = r.temp * 1.8 + 32;
  if (r.dewpt !== 32767) {
    const Tc = r.temp, Td = r.dewpt;
    let RH = (100 * Math.exp((17.625 * Td) / (243.04 + Td))) / Math.exp((17.625 * Tc) / (243.04 + Tc));
    if (corrected) RH = Math.min(100, RH);
    r.rh = rne(RH) & 0xff;
    r.hindex = rne(heatIndex(T, RH, corrected));
  }
  const gate = corrected ? r.wspeed !== 255 && r.wspeed * KT_MPH > 3 : r.wspeed !== 255 && r.wspeed > 2;
  if (T <= 50 && gate) {
    const V = r.wspeed * KT_MPH, p = Math.pow(V, 0.16);
    const wc = 35.74 + 0.6215 * T - 35.75 * p + 0.4275 * T * p;
    r.wchill = rne(corrected ? Math.min(wc, T) : wc);
  }
}

export function heatIndex(T: number, RH: number, corrected = false): number {
  const S = 0.5 * ((T + 61) + (T - 68) * 1.2 + 0.094 * RH);
  const f = Math.fround;
  const A = corrected ? (T + S) / 2 : f(f(f(f(T) - f(S)) * 0.5) + f(S));
  if (corrected ? A < 80 : A <= 80) return A;
  const R = -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH - 0.00683783 * T * T - 0.05481717 * RH * RH
    + 0.00122874 * T * T * RH + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;
  const base = corrected ? R : T; // vendor deviation: adjustments act on the air temperature
  if (RH < 13 && T >= 80 && T <= 112) return base - ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  if (RH > 85 && T >= 80 && T <= 87) return base + ((RH - 85) / 10) * ((87 - T) / 5);
  return R;
}

/** Map value for METARFieldIndex; 9999 = no value. */
export function metarValue(r: MetarReport, field: number): number {
  switch (field) {
    case 0: return r.temp === 32767 ? MISSING : r.temp * 1.8 + 32;
    case 1: return r.dewpt === 32767 ? MISSING : r.dewpt * 1.8 + 32;
    case 2: return r.wspeed === 255 ? MISSING : r.wspeed * KT_MPH;
    case 3: return r.wx === 255 ? MISSING : r.wx;
    case 4: return r.alti === 0 ? MISSING : r.alti;
    case 5: return r.wgust === 255 ? MISSING : r.wgust * KT_MPH;
    case 6: return r.rh === 255 ? MISSING : r.rh;
    case 7: return r.wchill === 32767 ? MISSING : r.wchill;
    case 8: return r.hindex === 32767 ? MISSING : r.hindex;
  }
  return MISSING;
}

/** Display filter. */
export function metarDrawn(r: MetarReport, field: number): boolean {
  const v = metarValue(r, field);
  if (v === MISSING) return false;
  switch (field) {
    case 0: case 1: return v >= -100 && v <= 155;
    case 2: return r.wdir !== 65535;
    case 5: return v > 10 && v < 155;
    case 6: return v >= 0 && v <= 100;
    case 7: return v >= -100 && v <= 50;
    case 8: return v >= 70 && v <= 155;
  }
  return true;
}

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg: number) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

/** Probe lines: Temp/Dew Pt integer °F, Alti one decimal mb, Wind mph with direction, Gust, RH. */
export function metarProbe(r: MetarReport, fmtTime: (ms: number) => string): string[] {
  const deg = (c: number) => (c === 32767 ? '-' : `${rne(c * 1.8 + 32)}°F`);
  const wind = r.wspeed === 255 ? '-' : `${rne(r.wspeed * KT_MPH_PROBE)}mph, ${r.wdir === 65534 ? 'Variable' : r.wdir === 65535 ? '-' : `${r.wdir}° (${compass(r.wdir)})`}`;
  return ['METAR Report', `Station: ${r.station}`, `Time: ${fmtTime(r.timeMs)}`, `Temp: ${deg(r.temp)}`, `Dew Pt: ${deg(r.dewpt)}`,
    `Alti: ${r.alti > 0 ? `${r.alti.toFixed(1)}mb` : '-'}`, `Wind: ${wind}`, `Wind Gust: ${r.wgust === 255 ? '-' : `${rne(r.wgust * KT_MPH_PROBE)}mph`}`, `RH: ${r.rh === 255 ? '-' : `${r.rh}%`}`];
}

// ------------------------------------------------------------------------------------------- marine
export interface MarineObs {
  id: string; timeMs: number; lon: number; lat: number; ship: boolean;
  /** m/s; negative = missing */ wspd: number; gust: number; wdir: number | null;
  /** °C; 9999 = missing */ atmp: number; wtmp: number; dewp: number;
  /** hPa; ≤ −1 missing */ pres: number; /** m */ wvht: number; /** s */ dpd: number;
  /** continuous winds (fields 0/1) */ cwSpd?: number; cwGust?: number;
}

export function marineValue(o: MarineObs, field: number): number {
  const ms = (v: number) => (v < 0 ? MISSING : v * 2.23694);
  const c = (v: number) => (v === 9999 ? MISSING : v * 1.8 + 32);
  switch (field) {
    case 0: return o.cwSpd === undefined ? MISSING : ms(o.cwSpd);
    case 1: return o.cwGust === undefined ? MISSING : ms(o.cwGust);
    case 2: return ms(o.wspd);
    case 3: return ms(o.gust);
    case 4: return c(o.atmp);
    case 5: return c(o.wtmp);
    case 6: return c(o.dewp);
    case 7: return o.pres <= -1 ? MISSING : o.pres;
    case 8: return o.wvht <= -1 ? MISSING : o.wvht * 3.28084;
    case 9: return o.dpd <= -1 ? MISSING : o.dpd;
  }
  return MISSING;
}

/** Marine display filter; fields 0/1 use the field 2/3 rules (bounded unknown, choose). */
export function marineDrawn(o: MarineObs, field: number): boolean {
  const v = marineValue(o, field);
  if (v === MISSING) return false;
  switch (field) {
    case 0: case 2: return v >= 0 && v < 300;
    case 1: case 3: return v > 0 && v < 300;
    case 4: case 6: return v >= -100 && v <= 155;
    case 5: return v >= -20 && v <= 130;
    case 7: return v > 800 && v < 1200;
    case 8: case 9: return v >= 0 && v <= 200;
  }
  return false;
}

/** Probe lines. Parity: wave height prints metres rounded with the label "ft". */
export function marineProbe(o: MarineObs, fmtTime: (ms: number) => string, corrected = false): string[] {
  const deg = (c: number) => (c === 9999 ? '-' : `${rne(c * 1.8 + 32)}°F`);
  const wind = o.wspd < 0 ? '-' : `${rne(o.wspd * 2.23694)}mph${o.wdir === null ? ', Variable' : `, ${o.wdir}° (${compass(o.wdir)})`}`;
  return [o.ship ? 'Ship Observation' : 'Buoy Observation', `Station: ${o.id}`, `Time: ${fmtTime(o.timeMs)}`, `Wind: ${wind}`, `Wind Gust: ${o.gust < 0 ? '-' : `${rne(o.gust * 2.23694)}mph`}`,
    `Air Temp: ${deg(o.atmp)}`, `Water Temp: ${deg(o.wtmp)}`, `Dew Pt: ${deg(o.dewp)}`, `MSLP: ${o.pres > 0 ? `${o.pres.toFixed(1)}mb` : '-'}`,
    `Wave Height: ${o.wvht <= -1 ? '-' : `${rne(corrected ? o.wvht * 3.28084 : o.wvht)}ft`}`, `Wave Period: ${o.dpd > 0 ? `${o.dpd.toFixed(1)}s` : '-'}`];
}

/**
 * METAR temporal interpolation (layerState.METARTemporalInterpolation; the original's blend was not transcribed,
 * table): between the report at or before `t` (a) and the next report (b, ≤ 2 h later) the displayed
 * value is linear in time. Weather class (field 3) is categorical and stays at a; a missing side keeps a.
 */
export function interpolateMetar(a: MetarReport, b: MetarReport | null, t: number, field: number): number {
  const va = metarValue(a, field);
  if (!b || field === 3 || b.timeMs <= a.timeMs || b.timeMs - a.timeMs > 2 * 3600e3) return va;
  const vb = metarValue(b, field);
  if (va === MISSING || vb === MISSING) return va;
  const w = Math.min(1, Math.max(0, (t - a.timeMs) / (b.timeMs - a.timeMs)));
  return va + (vb - va) * w;
}
