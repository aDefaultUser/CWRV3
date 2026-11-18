// Radar beam geometry and analysis helpers (pure): beam position under a map point, VR-shear of a velocity couplet,
// range-ring and azimuth-spoke geometry, and their display formatting in the app's distance units.
import { beamHeightKm } from './l2products';
import { gcDistanceKm, bearingDeg, destination } from '../gis/geodesy';

/** Effective earth radius (km) of the radar draw (shaders.ts slantRange). */
const KE = 8494.666;
export interface RadarSitePos { lon: number; lat: number; elevM: number }

/** Slant range (km) to the beam centre above a point `groundKm` away along a beam at `elDeg` (as the radar draw). */
export function slantRangeKm(groundKm: number, elDeg: number): number {
  const phi = groundKm / KE;
  return (KE * Math.sin(phi)) / Math.cos((elDeg * Math.PI) / 180 + phi);
}

export interface BeamPoint { groundKm: number; slantKm: number; azDeg: number; arlKm: number; mslKm: number }
/** Beam centre over a map point for a tilt: ground and slant range, azimuth, height above radar level and sea level. */
export function beamAt(site: RadarSitePos, lon: number, lat: number, elDeg: number): BeamPoint {
  const groundKm = gcDistanceKm(site.lon, site.lat, lon, lat);
  const slantKm = slantRangeKm(groundKm, elDeg);
  const arlKm = beamHeightKm(slantKm, elDeg);
  return { groundKm, slantKm, azDeg: bearingDeg(site.lon, site.lat, lon, lat), arlKm, mslKm: arlKm + site.elevM / 1000 };
}

export interface ShearSample { lon: number; lat: number; ms: number }
export interface VrShear {
  /** Most negative (inbound) and most positive (outbound) of the two samples, m/s. */
  vin: number; vout: number; dv: number;
  /** Rotational velocity (m/s); null when both samples have the same sign (no couplet). */
  vr: number | null;
  distKm: number; shear: number; meanRangeKm: number; beam: BeamPoint;
}
/** VR-shear of two velocity samples on one tilt: ΔV, Vr = (|Vin| + |Vout|) / 2 for opposite signs, ΔV / distance. */
export function vrShear(a: ShearSample, b: ShearSample, site: RadarSitePos, elDeg: number): VrShear {
  const vin = Math.min(a.ms, b.ms), vout = Math.max(a.ms, b.ms), dv = vout - vin;
  const distKm = gcDistanceKm(a.lon, a.lat, b.lon, b.lat);
  const meanRangeKm = (gcDistanceKm(site.lon, site.lat, a.lon, a.lat) + gcDistanceKm(site.lon, site.lat, b.lon, b.lat)) / 2;
  // Beam over the midpoint, at the mean ground range.
  const mid = destination(a.lon, a.lat, bearingDeg(a.lon, a.lat, b.lon, b.lat), distKm / 2);
  const az = bearingDeg(site.lon, site.lat, mid[0], mid[1]);
  const at = destination(site.lon, site.lat, az, meanRangeKm);
  return { vin, vout, dv, vr: vin < 0 && vout > 0 ? (Math.abs(vin) + Math.abs(vout)) / 2 : null, distKm, shear: distKm > 0 ? dv / (distKm * 1000) : NaN, meanRangeKm, beam: beamAt(site, at[0], at[1], elDeg) };
}

export interface RingGeometry { rings: number[][]; spokes: number[][]; labels: { lon: number; lat: number; km: number }[] }
/**
 * Range rings every `intervalKm` (count rings) around a site, labelled on the north side, and azimuth spokes every
 * `spokeDeg` degrees (0 = none) out to the outermost ring. Coordinates are lon/lat interleaved.
 */
export function rangeRings(site: { lon: number; lat: number }, intervalKm: number, count: number, spokeDeg: number): RingGeometry {
  const rings: number[][] = [], labels: RingGeometry['labels'] = [], spokes: number[][] = [];
  for (let k = 1; k <= count; k++) {
    const km = k * intervalKm, ring: number[] = [];
    for (let a = 0; a <= 360; a += 2) ring.push(...destination(site.lon, site.lat, a % 360, km));
    rings.push(ring);
    const [lon, lat] = destination(site.lon, site.lat, 0, km);
    labels.push({ lon, lat, km });
  }
  const outer = count * intervalKm;
  if (spokeDeg > 0 && outer > 0) for (let a = 0; a < 360 - 1e-9; a += spokeDeg) {
    const line: number[] = [];
    for (let s = 0; s <= 16; s++) line.push(...destination(site.lon, site.lat, a, (outer * s) / 16));
    spokes.push(line);
  }
  return { rings, spokes, labels };
}

const MI = 1.609344, FT = 0.3048;
/** A distance in the app's units (mi or km). */
export const fmtRange = (km: number, imperial: boolean, digits = 1) => (imperial ? `${(km / MI).toFixed(digits)} mi` : `${km.toFixed(digits)} km`);
/** A beam height in the app's units (ft or m). */
export const fmtHeight = (km: number, imperial: boolean) => (imperial ? `${Math.round((km * 1000) / FT).toLocaleString('en-US')} ft` : `${Math.round(km * 1000).toLocaleString('en-US')} m`);
/** Kilometres per display unit (ring intervals are entered in mi or km). */
export const kmPerUnit = (imperial: boolean) => (imperial ? MI : 1);

/** Probe/rollover lines for a single-tilt product. */
export function beamText(b: BeamPoint, elDeg: number, imperial: boolean): string[] {
  return [
    `${fmtRange(b.groundKm, imperial)} @ ${b.azDeg.toFixed(0)}° (slant ${fmtRange(b.slantKm, imperial)})`,
    `Beam ${elDeg.toFixed(1)}°: ${fmtHeight(b.arlKm, imperial)} ARL / ${fmtHeight(b.mslKm, imperial)} MSL`,
  ];
}
