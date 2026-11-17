// Environmental isotherms for the hail algorithms (MEHS, POSH): HRRR analyses of the 0 °C and −20 °C (253 K) heights
// sampled at a radar's own coordinates for up to three hourly cycles around the volume time, linearly interpolated in
// time and returned in metres above that radar. Shared by the NEXRAD and custom radar engines; each request names
// its own site, so one engine never receives heights sampled at the other's radar.
import { pool } from '../workers/pool';
import { hrrrUrl } from '../decode/hrrr';

export interface RadarPoint { lon: number; lat: number; elevM: number }
export interface Isotherms { h0: number; hm20: number }

/** Heights above mean sea level per HRRR cycle at one point; `tried` holds cycles requested (loaded, pending or missing). */
interface Table { entries: { t: number; h0: number; hm20: number }[]; tried: Set<number> }

const MAX_POINTS = 8;
const MAX_ENTRIES = 48;
/** Entries more than this far from the volume time are not used (the custom heights apply instead). */
const MAX_GAP_MS = 3.5 * 3600e3;
const tables = new Map<string, Table>();
const listeners = new Set<(key: string) => void>();

export const pointKey = (p: Pick<RadarPoint, 'lon' | 'lat'>) => `${p.lon.toFixed(3)},${p.lat.toFixed(3)}`;

/** Subscribes to newly loaded isotherms; `key` is the pointKey of the radar they were sampled at. */
export function onIsotherms(fn: (key: string) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

function table(key: string): Table {
  let t = tables.get(key);
  if (t) { tables.delete(key); tables.set(key, t); return t; } // most recently used last
  t = { entries: [], tried: new Set() };
  tables.set(key, t);
  for (const k of tables.keys()) { if (tables.size <= MAX_POINTS) break; tables.delete(k); }
  return t;
}

/**
 * Isotherm heights above the radar at `p` for a volume scanned at `t` (ms), or null when no HRRR cycle within
 * 3.5 h is loaded yet. Missing cycles are requested; listeners hear when one arrives.
 */
export function isothermsAt(p: RadarPoint, t: number): Isotherms | null {
  const key = pointKey(p), tab = table(key);
  const h = Math.floor(t / 3600e3) * 3600e3;
  for (const c of [h - 3600e3, h, h + 3600e3]) {
    if (c > Date.now() - 50 * 60e3 || tab.tried.has(c)) continue; // not published yet, or already requested
    tab.tried.add(c);
    const url = hrrrUrl(new Date(c)).replace('wrfsfcf', 'wrfprsf');
    pool.for('environment').run('grib.point', { url, fields: [['HGT', '0C isotherm'], ['HGT', '253 K level']], lon: p.lon, lat: p.lat }).then((r: { values: (number | null)[] }) => {
      const [h0, hm20] = r.values;
      if (tables.get(key) !== tab || h0 === null || hm20 === null) return; // evicted meanwhile, or no data
      tab.entries.push({ t: c, h0, hm20 });
      tab.entries.sort((a, b) => a.t - b.t);
      if (tab.entries.length > MAX_ENTRIES) tab.entries.splice(0, tab.entries.length - MAX_ENTRIES);
      for (const fn of listeners) fn(key);
    }, () => { /* missing cycle: the table simply has fewer entries */ });
  }
  const e = tab.entries;
  if (!e.length) return null;
  const after = e.findIndex((x) => x.t >= t);
  const a = after <= 0 ? e[Math.max(0, after)] : e[after - 1], b = after < 0 ? e[e.length - 1] : e[after];
  if (Math.min(Math.abs(a.t - t), Math.abs(b.t - t)) > MAX_GAP_MS) return null;
  const w = b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  return { h0: Math.max(0, a.h0 + (b.h0 - a.h0) * w - p.elevM), hm20: Math.max(0, a.hm20 + (b.hm20 - a.hm20) * w - p.elevM) };
}

/** Loaded table entries at `p`, for status text. */
export function isothermStatus(name: string, p: RadarPoint): string {
  const e = tables.get(pointKey(p))?.entries ?? [];
  return e.length ? `HRRR isotherms at ${name}: ${e.map((x) => `${new Date(x.t).toISOString().slice(11, 16)}Z 0°C ${Math.round(x.h0 - p.elevM)} m / −20°C ${Math.round(x.hm20 - p.elevM)} m`).join('; ')} (above radar)` : 'No environmental isotherm data loaded';
}

/** The environmental isotherms a Level 2 build of `product` uses: hail products with automatic isotherms only. */
export function hailEnvironment(product: number, isothermAuto: boolean, p: RadarPoint | null, t: number): Isotherms | null {
  return isothermAuto && p && (product === 11 || product === 12) ? isothermsAt(p, t) : null;
}
