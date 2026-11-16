// Storm-track geometry shared by manual tracks and Storm Cell Tracking Mode: the swept swath
// of a moving front and the time at which it reaches each city. A front is a cell (one point, widened to a
// short perpendicular segment) or a user-drawn line/path; it moves with one storm-motion vector.
import { destination } from '../gis/geodesy';
import { formatDateTime } from '../util/datefmt';

export type LL = [number, number];
export interface Motion { speedKt: number; fromDeg: number }
export interface CityPt { n: string; lon: number; lat: number; pop: number }
export interface Impact { name: string; minutes: number; pop: number }

/** Half-width (km) of the swath of a single-point cell track: a web choice (no catalog setting), about 5 mi. */
export const CELL_HALF_WIDTH_KM = 8;

const KM_PER_DEG_LAT = 110.574, KM_PER_DEG_LON_EQ = 111.32;
export const towardDeg = (m: Motion) => (m.fromDeg + 180) % 360;
export const kmPerMin = (m: Motion) => (m.speedKt * 1.852) / 60;

/** The front as a polyline: the drawn points, or for a single point a segment across the motion. */
export function frontLine(pts: LL[], m: Motion, halfWidthKm = CELL_HALF_WIDTH_KM): LL[] {
  if (pts.length !== 1) return pts;
  const b = towardDeg(m), p = pts[0];
  return [destination(p[0], p[1], b - 90, halfWidthKm), destination(p[0], p[1], b + 90, halfWidthKm)];
}

/**
 * Minutes after the front's start time at which it crosses each city, for crossings in [0, maxMinutes].
 * Solved exactly in a local tangent plane: city − v·t lies on a front segment (the front is rigid and
 * translates with v), so each segment gives a 2×2 linear system in (u along the segment, t).
 */
export function cityImpacts(front: LL[], m: Motion, maxMinutes: number, cities: CityPt[]): Impact[] {
  if (front.length < 2 || !(m.speedKt > 0) || !(maxMinutes > 0)) return [];
  const lat0 = front[0][1], lon0 = front[0][0], kx = KM_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  const xy = (lon: number, lat: number): LL => [(lon - lon0) * kx, (lat - lat0) * KM_PER_DEG_LAT];
  const b = (towardDeg(m) * Math.PI) / 180, s = kmPerMin(m);
  const vx = Math.sin(b) * s, vy = Math.cos(b) * s;
  const P = front.map((p) => xy(p[0], p[1]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of P) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  // Bounding box of the whole swath, for a cheap pre-filter over the city list.
  const ex = vx * maxMinutes, ey = vy * maxMinutes;
  const bx0 = Math.min(minX, minX + ex) - 1, bx1 = Math.max(maxX, maxX + ex) + 1, by0 = Math.min(minY, minY + ey) - 1, by1 = Math.max(maxY, maxY + ey) + 1;
  const out: Impact[] = [];
  for (const c of cities) {
    const [cx, cy] = xy(c.lon, c.lat);
    if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1) continue;
    let best = Infinity;
    for (let i = 0; i + 1 < P.length; i++) {
      const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1];
      const det = dx * vy - dy * vx;
      if (Math.abs(det) < 1e-9) continue;
      const rx = cx - P[i][0], ry = cy - P[i][1];
      const u = (rx * vy - ry * vx) / det, t = (dx * ry - dy * rx) / det;
      if (u >= 0 && u <= 1 && t >= 0 && t <= maxMinutes && t < best) best = t;
    }
    if (best < Infinity) out.push({ name: c.n, minutes: best, pop: c.pop });
  }
  return out.sort((a, b) => a.minutes - b.minutes || b.pop - a.pop);
}

/** Split long front segments so swath triangles follow the globe (≤ 0.25° per piece). */
function densify(front: LL[]): LL[] {
  const out: LL[] = [front[0]];
  for (let i = 1; i < front.length; i++) {
    const [a, b] = [front[i - 1], front[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Lon/lat triangles of the swath swept between minutes t0 and t1 (one parallelogram per front segment). */
export function swathBand(front: LL[], m: Motion, t0: number, t1: number): number[] {
  const f = densify(front), brg = towardDeg(m), s = kmPerMin(m);
  const A = f.map((p) => destination(p[0], p[1], brg, s * t0)), B = f.map((p) => destination(p[0], p[1], brg, s * t1));
  const tris: number[] = [];
  for (let i = 0; i + 1 < f.length; i++) tris.push(...A[i], ...A[i + 1], ...B[i + 1], ...A[i], ...B[i + 1], ...B[i]);
  return tris;
}

/** Clock time in the manual-track time format (Delphi FormatDateTime tokens, local time). */
export function formatClock(ms: number, fmt: string): string { return formatDateTime(ms, fmt); }

/** One city-list line: arrival clock time, or a countdown ("in 12 min" / "8 min ago"). */
export function impactText(arrivalMs: number, nowMs: number, countdown: boolean, fmt: string): string {
  if (!countdown) return formatClock(arrivalMs, fmt);
  const m = Math.round((arrivalMs - nowMs) / 60e3);
  return m > 0 ? `in ${m} min` : m === 0 ? 'now' : `${-m} min ago`;
}
