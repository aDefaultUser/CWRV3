// Geometry of the vertical cross-section / RHI tool (pure): map points ↔ the radar's plane (km east and north, the
// plane the radar draw places its polar data in), RHI lines, storm-motion advection of the end points, beam-centre
// curves and the point under a section pixel, as the GPU section view samples it.
import { beamThrough, slantRangeKm, tiltHeightKm } from './volume-sample';

const RAD = Math.PI / 180;
/** Earth radius of the radar draw's plane (shaders.ts: p = normalize(c + (east·e + north·n) / 6371)). */
const R_PLANE = 6371;
export type LL = [number, number];
export type EN = [number, number];

/** Unit vectors of the radar site: position c and the local east and north (as the radar vertex shader). */
function frame(site: { lon: number; lat: number }) {
  const lo = site.lon * RAD, la = site.lat * RAD;
  const c = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const len = Math.hypot(c[0], c[1]) || 1, east = [-c[1] / len, c[0] / len, 0];
  const north = [c[1] * east[2] - c[2] * east[1], c[2] * east[0] - c[0] * east[2], c[0] * east[1] - c[1] * east[0]];
  return { c, east, north };
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Map point → km east and north of the radar in the radar draw's plane (inverse of toLonLat). */
export function toLocal(site: { lon: number; lat: number }, lon: number, lat: number): EN {
  const { c, east, north } = frame(site), lo = lon * RAD, la = lat * RAD;
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)], k = R_PLANE / dot(u, c);
  return [dot(u, east) * k, dot(u, north) * k];
}

/** Km east and north of the radar → map point where the radar draw puts that ground position. */
export function toLonLat(site: { lon: number; lat: number }, [e, n]: EN): LL {
  const { c, east, north } = frame(site);
  const p = [0, 1, 2].map((i) => c[i] + (east[i] * e + north[i] * n) / R_PLANE), len = Math.hypot(p[0], p[1], p[2]);
  return [Math.atan2(p[1], p[0]) / RAD, Math.asin(p[2] / len) / RAD];
}

/** Azimuth (deg from north) and ground range (km) of a plane point, as the radar draw reads them. */
export const polarOf = ([e, n]: EN) => ({ az: ((Math.atan2(e, n) / RAD) % 360 + 360) % 360, s: Math.hypot(e, n) });
const pointAt = (az: number, s: number): EN => [s * Math.sin(az * RAD), s * Math.cos(az * RAD)];

/**
 * RHI line: both end points on the radial through `toward` (the point just placed or dragged), each keeping its own
 * ground range from the radar.
 */
export function rhiLine(a: EN, b: EN, toward: EN): [EN, EN] {
  const { az } = polarOf(toward);
  return [pointAt(az, polarOf(a).s), pointAt(az, polarOf(b).s)];
}

/** Storm motion as meteorologists give it: the direction it comes from (deg) and its speed (kt). */
export interface Motion { speedKt: number; fromDeg: number }
/** Moves a plane point with a storm motion for `dtMs` (negative goes back in time). */
export function advect([e, n]: EN, m: Motion, dtMs: number): EN {
  const km = ((m.speedKt * 1.852) / 3600e3) * dtMs, toward = (m.fromDeg + 180) * RAD;
  return [e + km * Math.sin(toward), n + km * Math.cos(toward)];
}

/** A section: end points in the radar's plane and the height (km above the radar) of its top. */
export interface Section { a: EN; b: EN; topKm: number }

/**
 * Azimuth, ground range and height (km above the radar) at fraction `fx` along the section and `fy` of its height
 * (0 = bottom). The GPU section view samples pixel (x, y) of a W × H image (row 0 at the bottom) at
 * fx = (x + 0.5) / W, fy = (y + 0.5) / H.
 */
export function sectionAt(l: Section, fx: number, fy: number): { az: number; s: number; h: number; e: number; n: number } {
  const e = l.a[0] + (l.b[0] - l.a[0]) * fx, n = l.a[1] + (l.b[1] - l.a[1]) * fx;
  return { ...polarOf([e, n]), h: fy * l.topKm, e, n };
}

/** Length of the section along the ground (km). */
export const sectionLength = (l: Pick<Section, 'a' | 'b'>) => Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);

/**
 * Beam-centre height of a tilt along the section: `n + 1` samples of [fx, height km above the radar], NaN beyond
 * `maxRangeKm` (the tilt's last gate) so the curve breaks there.
 */
export function beamCurve(l: Section, elevation: number, maxRangeKm: number, n = 128): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const fx = i / n, { s } = sectionAt(l, fx, 0);
    out.push([fx, slantRangeKm(s, elevation) <= maxRangeKm ? tiltHeightKm(s, elevation) : NaN]);
  }
  return out;
}

/** Probe geometry of a section point: slant range and elevation of the beam through it, and the nearest tilt. */
export function probeGeometry(s: number, h: number, tilts: { elevation: number }[]): { slantKm: number; elevation: number; nearest: number; offDeg: number } {
  const b = beamThrough(s, h);
  let nearest = -1, off = Infinity;
  tilts.forEach((t, k) => { const d = b.elevation - t.elevation; if (Math.abs(d) < Math.abs(off)) { off = d; nearest = k; } });
  return { slantKm: b.rangeKm, elevation: b.elevation, nearest, offDeg: off };
}

/** Distances (in the display unit, km per unit `kmPerUnit`) of the ticks along a section of `lengthKm`. */
export function tickStep(lengthKm: number, kmPerUnit: number, targetTicks = 8): number {
  const units = lengthKm / kmPerUnit / targetTicks;
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200]) if (s >= units) return s;
  return 500;
}
