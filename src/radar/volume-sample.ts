// Direct polar sampling of a volume pack (volume-pack.ts): a point given by azimuth, ground range and height above the
// radar is mapped in closed form to the beam through it, then read from the nearest tilt(s) at the nearest gate and
// azimuth bin. This is the reference implementation; VOLUME_WGSL (render/volume.ts) mirrors it line for line.
import { AZ_BINS, AZ_BIN0, beamHeightKm, type VolumeMoment } from './l2products';

/** 4/3 earth radius (km): ground range ↔ slant range, as slantRange in the radar shader. */
export const KE_KM = 8494.666;
/** Beam curvature of beamHeightKm and the radar shader's beamH: h = r·sin(el) + r² / BEAM_CURVE_KM. */
export const BEAM_CURVE_KM = 15417.82;
/** Nominal beamwidth (deg): a tilt is used alone within half of it; tilts more than two beamwidths apart are not bridged. */
export const BEAM_DEG = 1;

const RAD = Math.PI / 180;

/** Slant range (km) along a beam at elevation `elDeg` that reaches ground range `sKm`. */
export function slantRangeKm(sKm: number, elDeg: number): number {
  const phi = sKm / KE_KM;
  return (KE_KM * Math.sin(phi)) / Math.cos(elDeg * RAD + phi);
}

/** Ground range (km along the surface) of slant range `rKm` on a beam at elevation `elDeg`; inverse of slantRangeKm. */
export function groundRangeKm(rKm: number, elDeg: number): number {
  return KE_KM * Math.atan2(rKm * Math.cos(elDeg * RAD), KE_KM + rKm * Math.sin(elDeg * RAD));
}

/**
 * The beam through the point at ground range `sKm` and height `hKm` above the radar: its slant range (km) and
 * elevation (deg), so that groundRangeKm(range, elevation) = sKm and beamHeightKm(range, elevation) = hKm. With
 * u = r·cos(el), w = r·sin(el) and t = tan(s / KE) the two relations are u = (KE + w)·t and w = h − (u² + w²) / C,
 * a quadratic in w whose small root is taken in its cancellation-free form.
 */
export function beamThrough(sKm: number, hKm: number): { rangeKm: number; elevation: number } {
  const t = Math.tan(sKm / KE_KM);
  const a = 1 + t * t, b = BEAM_CURVE_KM + 2 * KE_KM * t * t, c = KE_KM * KE_KM * t * t - BEAM_CURVE_KM * hKm;
  const w = (-2 * c) / (b + Math.sqrt(b * b - 4 * a * c));
  const u = (KE_KM + w) * t;
  return { rangeKm: Math.hypot(u, w), elevation: Math.atan2(w, u) / RAD };
}

/** Height (km above the radar) of a tilt's beam centre over ground range `sKm`. */
export const tiltHeightKm = (sKm: number, elDeg: number) => beamHeightKm(slantRangeKm(sKm, elDeg), elDeg);

/** What the sampler reads: a VolumePack, or any object with its tilt geometry and layer images. */
export interface SampleVolume {
  moment: VolumeMoment; width: number;
  tilts: { elevation: number; firstKm: number; gateKm: number; gates: number }[];
  layers: Uint8Array[];
}

/** Azimuth bin of the shared frame containing `azDeg`. */
export const azimuthBin = (azDeg: number) => ((Math.floor((azDeg - AZ_BIN0) * 2 + 0.5) % AZ_BINS) + AZ_BINS) % AZ_BINS;

/** Raw code of tilt `k` over ground range `sKm` at azimuth `azDeg` (nearest gate and bin); 0 outside its gates. */
export function tiltCode(v: SampleVolume, k: number, azDeg: number, sKm: number): number {
  const t = v.tilts[k];
  const g = Math.floor((slantRangeKm(sKm, t.elevation) - t.firstKm) / t.gateKm + 0.5);
  if (g < 0 || g >= t.gates) return 0;
  return v.layers[k][(azimuthBin(azDeg) + 1) * v.width + g];
}

/**
 * Samples the volume at azimuth `azDeg`, ground range `sKm` and height `hKm` above the radar. Returns a code
 * (value = code · scale + offset, VOLUME_MOMENTS; fractional where two tilts are blended) or 0 for no data.
 *  - Within half a beamwidth of a tilt, that tilt alone.
 *  - Between two tilts at most two beamwidths apart: reflectivity, ZDR, CC and KDP are blended linearly across the
 *    span between the two half-beam zones (continuous at both ends), and only where both tilts have a value;
 *    velocity takes the nearer tilt.
 *  - Below the lowest tilt, in the cone of silence, in wider gaps, and at codes 0 / 1: no data.
 * Each tilt is read over the same ground point (its own slant range), not at the point's slant range.
 */
export function sampleVolume(v: SampleVolume, azDeg: number, sKm: number, hKm: number, beamDeg = BEAM_DEG): number {
  const n = v.tilts.length;
  if (!n || !(sKm > 0)) return 0;
  const el = beamThrough(sKm, hKm).elevation, half = beamDeg / 2;
  let hi = 0;
  while (hi < n && v.tilts[hi].elevation < el) hi++;
  const lo = hi - 1;
  const below = lo >= 0 ? el - v.tilts[lo].elevation : Infinity, above = hi < n ? v.tilts[hi].elevation - el : Infinity;
  const valid = (c: number) => (c >= 2 ? c : 0);
  if (Math.min(below, above) <= half) return valid(tiltCode(v, below <= above ? lo : hi, azDeg, sKm));
  if (lo < 0 || hi >= n || below + above > 2 * beamDeg) return 0;
  const w = (below - half) / (below + above - beamDeg);
  if (v.moment === 'VEL') return valid(tiltCode(v, w < 0.5 ? lo : hi, azDeg, sKm));
  const a = tiltCode(v, lo, azDeg, sKm), b = tiltCode(v, hi, azDeg, sKm);
  return a >= 2 && b >= 2 ? a + (b - a) * w : 0;
}

/**
 * Storm-relative velocity code of a velocity code at azimuth `azDeg` for a storm moving from `fromDeg` at `speedKt`
 * (as stormRelative in l2products.ts, without its rounding). Applied when sampling, so a new motion needs no new pack.
 */
export function stormRelativeCode(code: number, azDeg: number, speedKt: number, fromDeg: number): number {
  return code < 2 ? code : Math.min(255, Math.max(2, code + speedKt * Math.cos((azDeg - fromDeg) * RAD)));
}
