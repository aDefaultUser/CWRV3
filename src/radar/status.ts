// Radar site status from api.weather.gov /radar/stations (WSR-88D and TDWR): the RDA's volume coverage pattern,
// operability and state, and the Level 2 feed latency. Fetched at most every 5 minutes while radar site labels or
// NEXRAD are on. Missing fields read "unknown"; a site is marked down only by the two rules in `parseRadarStations`.
import { fetchJson } from '../data/net';
import { timeline } from '../app/timeline';

export const RADAR_STATUS_URL = 'https://api.weather.gov/radar/stations';
export const RADAR_STATUS_INTERVAL_MS = 5 * 60e3;
/** A table older than this (failed refreshes) is no longer shown. */
const EXPIRE_MS = 15 * 60e3;
/** Level 2 data received longer ago than this (at fetch time) marks a site down. */
const STALE_L2_MS = 30 * 60e3;

export interface RadarStatus {
  id: string;
  /** As reported, e.g. "R35" (prefix: remote/local control) or "L90" (TDWR). */
  vcp: string | null;
  /** RDA operability without the "RDA - " prefix, e.g. "On-line", "Maintenance Action Required", "Inoperable". */
  operability: string | null;
  /** RDA state, e.g. "Operate", "Start-Up". */
  state: string | null;
  alarms: string | null;
  level2Ms: number | null;
  latencyS: number | null;
  /** Time the table was fetched. */
  checkedMs: number;
  down: boolean;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const time = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/** Status per site ID from the /radar/stations GeoJSON; `nowMs` is the fetch time. */
export function parseRadarStations(json: unknown, nowMs: number): Map<string, RadarStatus> {
  const features = (json as { features?: unknown })?.features;
  if (!Array.isArray(features)) throw new Error('radar stations: no features');
  const out = new Map<string, RadarStatus>();
  for (const f of features) {
    const p = f?.properties;
    const id = str(p?.id);
    if (!id) continue;
    const rda = p.rda?.properties;
    const operability = str(rda?.operabilityStatus)?.replace(/^RDA\s*-\s*/i, '') ?? null;
    const level2Ms = time(p.latency?.levelTwoLastReceivedTime);
    const latency = p.latency?.current?.value;
    out.set(id.toUpperCase(), {
      id: id.toUpperCase(), vcp: str(rda?.volumeCoveragePattern), operability, state: str(rda?.status), alarms: str(rda?.alarmSummary),
      level2Ms, latencyS: typeof latency === 'number' && Number.isFinite(latency) ? latency : null, checkedMs: nowMs,
      down: /inoperable|shut\s*down/i.test(operability ?? '') || (level2Ms !== null && nowMs - level2Ms > STALE_L2_MS),
    });
  }
  return out;
}

const hhmmZ = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)}Z`;

const known = (s: RadarStatus | undefined): s is RadarStatus => !!s && (s.vcp !== null || s.operability !== null || s.state !== null || s.level2Ms !== null);
const vcpText = (s: RadarStatus) => `VCP ${s.vcp === null ? 'unknown' : /^[A-Z]?(\d+)$/i.exec(s.vcp)?.[1] ?? s.vcp}`;

/** Compact form for the NEXRAD status line: "VCP 35", "VCP 35, Maintenance Action Required", "DOWN" or "unknown". */
export function radarStatusShort(s: RadarStatus | undefined): string {
  if (!known(s)) return 'unknown';
  if (s.down) return 'DOWN';
  return [vcpText(s), s.operability === 'On-line' ? '' : s.operability ?? 'operability unknown', s.state === 'Operate' ? '' : s.state ?? 'state unknown'].filter(Boolean).join(', ');
}

/** One line for tooltips, e.g. "VCP 35 · On-line · Operate · L2 latency 0.2 s", or "unknown". */
export function radarStatusLine(s: RadarStatus | undefined): string {
  if (!known(s)) return 'unknown';
  const l2 = s.level2Ms === null ? 'L2 unknown' : s.checkedMs - s.level2Ms > STALE_L2_MS ? `last L2 ${hhmmZ(s.level2Ms)}`
    : s.latencyS === null ? 'L2 latency unknown' : `L2 latency ${s.latencyS.toFixed(1)} s`;
  return [s.down ? 'DOWN' : '', vcpText(s), s.operability ?? 'operability unknown', s.state ?? 'state unknown', l2].filter(Boolean).join(' · ');
}

/** Tooltip text: the status line, active alarms and when/where it was checked. */
export function radarStatusDetail(s: RadarStatus | undefined): string {
  if (!s) return 'RDA: unknown';
  const alarms = s.alarms && !/^no alarms$/i.test(s.alarms) ? `\nAlarms: ${s.alarms.replace(/\|/g, ', ')}` : '';
  return `RDA: ${radarStatusLine(s)}${alarms}\nChecked ${hhmmZ(s.checkedMs)} (api.weather.gov)`;
}

export class RadarStatusStore {
  private sites = new Map<string, RadarStatus>();
  private checkedMs = -Infinity;
  private lastTry = -Infinity;
  private pending: Promise<boolean> | null = null;
  error: string | null = null;
  constructor(private load: () => Promise<unknown> = () => fetchJson(RADAR_STATUS_URL)) {}

  /** Status of a site, or undefined when unknown or the table is older than 15 minutes. */
  get(id: string, nowMs = Date.now()): RadarStatus | undefined {
    if (timeline.mode === 'archive') return undefined; // the table is the current status, not that of the archive time
    return nowMs - this.checkedMs > EXPIRE_MS ? undefined : this.sites.get(id.toUpperCase());
  }
  /** Fetches when the last attempt is at least 5 minutes old; resolves true when an attempt finished. */
  refresh(nowMs = Date.now()): Promise<boolean> {
    if (this.pending) return this.pending;
    if (timeline.mode === 'archive') return Promise.resolve(false);
    if (nowMs - this.lastTry < RADAR_STATUS_INTERVAL_MS) return Promise.resolve(false);
    this.lastTry = nowMs;
    this.pending = this.load().then((json) => {
      this.sites = parseRadarStations(json, nowMs); this.checkedMs = nowMs; this.error = null;
    }).catch((e) => { this.error = (e as Error).message; }).then(() => { this.pending = null; return true; });
    return this.pending;
  }
}

export const radarStatus = new RadarStatusStore();
