// Ray geometry of the 3D volume view: the radar's site frame, the bounds a view ray is clipped to and the isosurface
// crossing search. This is the reference implementation; the march shader of render/volume-view.ts mirrors it.
import { EARTH_KM, invert, lonLatToXYZ } from './camera';
import { OCC_TOP_KM } from '../radar/volume-pack';

export type V3 = [number, number, number];

/** Heights the view covers: the globe surface up to this far above the radar (km, before vertical exaggeration). */
export const VIEW_TOP_KM = OCC_TOP_KM;
/** Bisection steps that refine an isosurface crossing found between two march samples. */
export const ISO_BISECTIONS = 4;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The site frame of a radar: east, north and up unit vectors at (lon, lat). Site coordinates are km from the earth's
 * centre along them, so the radar's vertical is the z axis and the globe is the sphere of radius EARTH_KM.
 */
export interface SiteFrame { east: V3; north: V3; up: V3 }
export function siteFrame(lon: number, lat: number): SiteFrame {
  const up = lonLatToXYZ(lon, lat), h = Math.hypot(up[0], up[1]);
  const east: V3 = [-up[1] / h, up[0] / h, 0];
  return { east, north: [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]], up };
}
/** A world vector (earth radii) in site coordinates, scaled by `scale` (EARTH_KM for positions, 1 for directions). */
export const toSite = (f: SiteFrame, v: V3, scale = EARTH_KM): V3 => [dot(v, f.east) * scale, dot(v, f.north) * scale, dot(v, f.up) * scale];

/**
 * Eye and ray directions of a camera in site coordinates: the direction through NDC (x, y) is d0 + x·dx + y·dy (not
 * normalised), exact for a perspective projection.
 */
export function viewRays(cam: { eye: V3; vpRot: Float64Array }, f: SiteFrame): { eye: V3; d0: V3; dx: V3; dy: V3 } {
  const inv = invert(cam.vpRot);
  const dir = (x: number, y: number): V3 => {
    const at = (z: number): V3 => { const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15]; return [0, 1, 2].map((i) => (inv[i] * x + inv[4 + i] * y + inv[8 + i] * z + inv[12 + i]) / w) as V3; };
    const a = at(0), b = at(1);
    return toSite(f, [b[0] - a[0], b[1] - a[1], b[2] - a[2]], 1);
  };
  const d0 = dir(0, 0), x1 = dir(1, 0), y1 = dir(0, 1);
  return { eye: toSite(f, cam.eye), d0, dx: [x1[0] - d0[0], x1[1] - d0[1], x1[2] - d0[2]], dy: [y1[0] - d0[0], y1[1] - d0[1], y1[2] - d0[2]] };
}

/**
 * Bounds of the view for rays from one eye: the constant terms |eye|² − R² of the globe and of the top sphere and
 * that of the range cylinder (computed here in float64; in float32 they would lose the eye's height), the radius of
 * the radar level and the vertical scale.
 */
export interface RayBounds { ground: number; top: number; cylinder: number; radarKm: number; vscale: number }
/**
 * `rangeKm` is the largest ground range with data. The cylinder around the radar's vertical is widened to hold
 * every point of that ground range below the top, where ground range is measured as the radar shader does
 * (EARTH_KM · the tangent of the angle from the radar's vertical).
 */
export function rayBounds(eye: V3, siteHeightKm: number, vscale: number, rangeKm: number): RayBounds {
  const radarKm = EARTH_KM + siteHeightKm, topKm = radarKm + VIEW_TOP_KM * vscale, e2 = dot(eye, eye);
  const radius = (rangeKm * topKm) / EARTH_KM;
  return { ground: e2 - EARTH_KM * EARTH_KM, top: e2 - topKm * topKm, cylinder: eye[0] * eye[0] + eye[1] * eye[1] - radius * radius, radarKm, vscale };
}

/**
 * Distances [enter, exit] (km) between which the ray o + t·d (d a unit vector, o outside the globe) is below the top
 * sphere, inside the range cylinder and has not reached the globe, as camera.pick finds it; null when there is no
 * such part.
 */
export function raySegment(o: V3, d: V3, b: RayBounds): [number, number] | null {
  const bd = dot(o, d), top = bd * bd - b.top;
  if (top <= 0) return null;
  let t0 = Math.max(-bd - Math.sqrt(top), 0), t1 = -bd + Math.sqrt(top);
  const ground = bd * bd - b.ground;
  if (ground > 0 && bd < 0) t1 = Math.min(t1, -bd - Math.sqrt(ground));
  const a = d[0] * d[0] + d[1] * d[1], h = o[0] * d[0] + o[1] * d[1];
  if (a < 1e-12) { if (b.cylinder > 0) return null; }
  else {
    const disc = h * h - a * b.cylinder;
    if (disc <= 0) return null;
    t0 = Math.max(t0, (-h - Math.sqrt(disc)) / a); t1 = Math.min(t1, (-h + Math.sqrt(disc)) / a);
  }
  return t1 > t0 ? [t0, t1] : null;
}

/**
 * Azimuth (deg), ground range (km) and height above the radar (km, exaggeration removed) of site point `p`: the
 * coordinates sampleVolume takes, with the ground range and azimuth of the radar shader's sweep mesh.
 */
export function polarOf(p: V3, b: RayBounds): { az: number; s: number; h: number } {
  const e = (EARTH_KM * p[0]) / p[2], n = (EARTH_KM * p[1]) / p[2];
  return { az: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360, s: Math.hypot(e, n), h: (Math.hypot(p[0], p[1], p[2]) - b.radarKm) / b.vscale };
}
/** The site point at those coordinates (inverse of polarOf). */
export function sitePoint(az: number, s: number, h: number, b: RayBounds): V3 {
  const a = (az * Math.PI) / 180, e = s * Math.sin(a), n = s * Math.cos(a), k = (b.radarKm + h * b.vscale) / Math.hypot(e, n, EARTH_KM);
  return [e * k, n * k, EARTH_KM * k];
}

/**
 * First isosurface crossing along a ray: `value(t)` is sampled every `step` from t0 to t1, and at the first sample at
 * or above `threshold` the crossing since the sample before it is refined by `bisections` halvings (a ray that starts
 * at or above the threshold crosses at t0). Returns the inside end of the last interval, at most step / 2^bisections
 * past the crossing, or null.
 */
export function firstCrossing(value: (t: number) => number, t0: number, t1: number, step: number, threshold: number, bisections = ISO_BISECTIONS): number | null {
  let prev = t0;
  for (let t = t0; t < t1; prev = t, t += step) {
    if (value(t) < threshold) continue;
    let a = prev, b = t;
    for (let i = 0; i < bisections; i++) { const m = (a + b) / 2; if (value(m) >= threshold) b = m; else a = m; }
    return b;
  }
  return null;
}
