// Point soundings from the Iowa Environmental Mesonet (CORS-enabled, contacted directly): observed radiosondes
// (json/raob.py, stations from the RAOB network list) and model BUFKIT profiles (api/1/nws/bufkit.json, IEM's
// nearest BUFKIT site to the point); and the VAD wind profile of the selected radar (NEXRAD Level 3 product 48,
// TGFTP DS.48vwp). Every result carries the identity the service returned: station, position, valid time and run.
import { fetchJson } from '../data/net';
import { gcDistanceKm } from '../gis/geodesy';
import { listL3 } from '../radar/sources';
import { pool } from '../workers/pool';
import { windComponents, standardPressure, KT, type Level } from './sounding-math';

const IEM = 'https://mesonet.agron.iastate.edu';
export const SOUNDING_SOURCES = ['RAOB', 'VAD', 'RAP', 'HRRR', 'GFS', 'NAM', 'RRFS'] as const;
export type SoundingSource = (typeof SOUNDING_SOURCES)[number];
export type ModelSource = Exclude<SoundingSource, 'RAOB' | 'VAD'>;

export interface Sounding {
  source: SoundingSource;
  /** Station (RAOB ICAO or BUFKIT site), its name when known and position. */
  station: string; name: string; lat: number; lon: number;
  validMs: number; runMs: number | null; fhour: number | null;
  /** Distance (km) from the requested point to the station. */
  distKm: number;
  url: string;
  levels: Level[];
}

export interface RaobStation { id: string; name: string; lat: number; lon: number }
/** Active upper-air stations of the IEM RAOB network list (aliases starting with "_" and closed sites removed). */
export function parseRaobStations(json: unknown): RaobStation[] {
  const data = (json as { data?: Record<string, unknown>[] })?.data;
  if (!Array.isArray(data)) throw new Error('RAOB station list: unexpected response');
  return data.filter((s) => s.online === true && !s.archive_end && typeof s.id === 'string' && !s.id.startsWith('_') && Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map((s) => ({ id: s.id as string, name: String(s.plot_name ?? s.name ?? s.id), lat: s.latitude as number, lon: s.longitude as number }));
}
/** The `n` stations nearest a point within `maxKm`, nearest first. */
export function nearestStations(list: RaobStation[], lon: number, lat: number, n = 3, maxKm = 800): (RaobStation & { km: number })[] {
  return list.map((s) => ({ ...s, km: gcDistanceKm(lon, lat, s.lon, s.lat) })).filter((s) => s.km <= maxKm).sort((a, b) => a.km - b.km).slice(0, n);
}
/** Synoptic launch times (00 and 12 UTC) at or before `t`, newest first. */
export function raobCycles(t: number, count = 3): number[] {
  const first = Math.floor(t / 43200e3) * 43200e3;
  return Array.from({ length: count }, (_, i) => first - i * 43200e3);
}
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 12);
export const raobUrl = (ms: number, station: string) => `${IEM}/json/raob.py?ts=${stamp(ms)}&station=${encodeURIComponent(station)}`;

/** Levels from surface up with T ≤ Td clamped, sorted by decreasing pressure, duplicates removed. */
function ordered(levels: Level[]): Level[] {
  const out = levels.filter((l) => Number.isFinite(l.p) && l.p > 0).sort((a, b) => b.p - a.p).filter((l, i, a) => i === 0 || l.p < a[i - 1].p);
  for (const l of out) if (l.td > l.t) l.td = l.t;
  return out;
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
function level(p: unknown, z: unknown, tc: unknown, tdc: unknown, dir: unknown, kt: unknown): Level {
  const [u, v] = windComponents(num(dir), num(kt) * KT);
  return { p: num(p), z: num(z), t: num(tc) + 273.15, td: num(tdc) + 273.15, u, v };
}

/** The radiosonde of an IEM raob.py response; levels below the first with a temperature (below ground) are dropped. */
export function parseRaob(json: unknown): { station: string; validMs: number; levels: Level[] } | null {
  const prof = (json as { profiles?: { station?: string; valid?: string; profile?: Record<string, unknown>[] }[] })?.profiles?.[0];
  if (!prof?.profile?.length) return null;
  const all = ordered(prof.profile.map((r) => level(r.pres, r.hght, r.tmpc, r.dwpc, r.drct, r.sknt)));
  const sfc = all.findIndex((l) => Number.isFinite(l.t) && Number.isFinite(l.z));
  const validMs = Date.parse(prof.valid ?? '');
  return sfc < 0 || !Number.isFinite(validMs) ? null : { station: prof.station ?? '', validMs, levels: all.slice(sfc) };
}

export const MODEL_CYCLE_H: Record<ModelSource, number> = { RAP: 1, HRRR: 1, RRFS: 1, GFS: 6, NAM: 6 };
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + 'Z';
/** BUFKIT request (no other parameters: the service rejects unknown ones with HTTP 422). */
export function bufkitUrl(model: string, lon: number, lat: number, validMs: number, runMs?: number): string {
  return `${IEM}/api/1/nws/bufkit.json?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&model=${model}${runMs !== undefined ? `&runtime=${iso(runMs)}` : ''}&time=${iso(validMs)}`;
}
/** The first profile of an IEM BUFKIT JSON response with the station and run the service picked. */
export function parseBufkit(json: unknown): Omit<Sounding, 'source' | 'distKm' | 'url' | 'name'> | null {
  const j = json as { source?: { station?: string; run_time?: string }; profiles?: { forecast_hour?: number; time?: string; levels?: Record<string, unknown>[]; parameters?: Record<string, unknown> }[]; lat?: number; lon?: number };
  const prof = j?.profiles?.[0];
  if (!prof?.levels?.length) return null;
  const levels = ordered(prof.levels.map((r) => level(r.PRES, r.HGHT, r.TMPC, r.DWPC, r.DRCT, r.SKNT)));
  const validMs = Date.parse(prof.time ?? ''), runMs = Date.parse(j.source?.run_time ?? '');
  const lat = num(prof.parameters?.SLAT ?? j.lat), lon = num(prof.parameters?.SLON ?? j.lon);
  if (!levels.length || !Number.isFinite(validMs)) return null;
  return { station: j.source?.station ?? '', lat, lon, validMs, runMs: Number.isFinite(runMs) ? runMs : null, fhour: typeof prof.forecast_hour === 'number' ? prof.forecast_hour : null, levels };
}

let stations: Promise<RaobStation[]> | null = null;
function raobStations(): Promise<RaobStation[]> {
  stations ??= fetchJson(`${IEM}/api/1/network/RAOB.json`, { timeoutMs: 30_000 }).then(parseRaobStations);
  stations.catch(() => { stations = null; });
  return stations;
}

/**
 * The radiosonde nearest the point at or before `timeMs`: the nearest active stations in turn (up to three within
 * 800 km), each tried at the 00/12 UTC launches of the last 36 hours, newest first.
 */
export async function observedSounding(lon: number, lat: number, timeMs: number, signal?: AbortSignal): Promise<Sounding> {
  const near = nearestStations(await raobStations(), lon, lat);
  if (!near.length) throw new Error('no active radiosonde station within 800 km');
  for (const s of near) for (const t of raobCycles(timeMs)) {
    const url = raobUrl(t, s.id);
    const r = parseRaob(await fetchJson(url, { signal, timeoutMs: 30_000 }));
    if (r && r.levels.length >= 5) return { source: 'RAOB', station: r.station || s.id, name: s.name, lat: s.lat, lon: s.lon, validMs: r.validMs, runMs: null, fhour: null, distKm: s.km, url, levels: r.levels };
  }
  throw new Error(`no radiosonde at or before ${iso(timeMs)} from ${near.map((s) => s.id).join(', ')}`);
}

/**
 * A model profile valid at `timeMs` rounded to the hour. The service picks the run when only the valid time is
 * given; when it finds none (forecast hours past its search window), the recent cycles are named explicitly.
 */
export async function modelSounding(model: ModelSource, lon: number, lat: number, timeMs: number, signal?: AbortSignal, now = Date.now()): Promise<Sounding> {
  const valid = Math.round(timeMs / 3600e3) * 3600e3, cycle = MODEL_CYCLE_H[model] * 3600e3;
  const runs: (number | undefined)[] = [undefined];
  for (let run = Math.floor(Math.min(now, valid) / cycle) * cycle, k = 0; k < 4; k++, run -= cycle) runs.push(run);
  let last: Error | null = null;
  for (const run of runs) {
    const url = bufkitUrl(model, lon, lat, valid, run);
    try {
      const r = parseBufkit(await fetchJson(url, { signal, timeoutMs: 30_000 }));
      if (r) return { ...r, source: model, name: `${model} BUFKIT site`, distKm: gcDistanceKm(lon, lat, r.lon, r.lat), url };
    } catch (e) {
      if ((e as Error).name === 'AbortError' || !/HTTP 4\d\d/.test((e as Error).message)) throw e;
      last = e as Error;
    }
  }
  throw new Error(`${model}: no profile valid ${iso(valid)}${last ? ` (${last.message.replace(/ for https.*/, '')})` : ''}`);
}

/**
 * VAD winds of a VWP product's "VAD Algorithm Output" pages: altitude (100 ft MSL), U and V (m/s), lowest first.
 * The product has no pressures; the standard atmosphere's are used for the pressure-weighted means.
 */
export function parseVad(pages: string[][]): Level[] {
  const out: Level[] = [];
  for (const pg of pages) if (pg.some((l) => /VAD Algorithm Output/i.test(l))) for (const line of pg) {
    const m = /^\s*(\d{3})\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s/.exec(line);
    if (m) { const z = Number(m[1]) * 30.48; out.push({ p: standardPressure(z), z, t: NaN, td: NaN, u: Number(m[2]), v: Number(m[3]) }); }
  }
  return out.sort((a, b) => a.z - b.z).filter((l, i, a) => i === 0 || l.z > a[i - 1].z);
}

/** The newest VAD wind profile of a radar valid at or before `timeMs` (up to three products tried, newest first). */
export async function vadSounding(site: { id: string; name: string; lat: number; lon: number }, lon: number, lat: number, timeMs: number): Promise<Sounding> {
  const files = (await listL3(site.id, '48vwp')).filter((f) => f.t <= timeMs + 10 * 60e3).slice(-3).reverse();
  for (const f of files) {
    const p = await pool.for('sounding').run<{ volumeTimeMs: number; pages: string[][] }>('l3', { url: f.url, live: true });
    if (!(p.volumeTimeMs <= timeMs)) continue;
    const levels = parseVad(p.pages);
    if (levels.length >= 2) return { source: 'VAD', station: site.id, name: site.name, lat: site.lat, lon: site.lon, validMs: p.volumeTimeMs, runMs: null, fhour: null, distKm: gcDistanceKm(lon, lat, site.lon, site.lat), url: f.url, levels };
  }
  throw new Error(`no VAD wind profile of ${site.id} at or before ${iso(timeMs)} with two or more levels`);
}
