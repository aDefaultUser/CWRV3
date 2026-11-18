// Sounding thermodynamics and kinematics (pure). The formulations follow MetPy 1.7 (BSD-3-Clause,
// src/palettes/METPY-LICENSE.txt) so that its documented test values can serve as references: Ambaum (2020)
// saturation vapour pressure over liquid water, the exact Romps (2017) LCL, pseudo-adiabats from MetPy's moist lapse
// rate, CAPE/CIN with the virtual temperature correction, the pressure-weighted Bunkers et al. (2000) storm motion
// and storm-relative helicity as in SHARPpy. Temperatures are K, pressures hPa, heights m, winds m/s.

const R = 8.314462618, Mw = 18.015268e-3, Md = 28.96546e-3;
export const Rd = R / Md, Rv = R / Mw;
const Cp_d = (1.4 * Rd) / 0.4, Cp_v = (1.33 * Rv) / 0.33, Cp_l = 4219.4;
const Lv = 2.50084e6, T0 = 273.16, ES0 = 6.112, EPS = Mw / Md, KAPPA = Rd / Cp_d, G = 9.80665, RHO_L = 999.97495;
export const KT = 1852 / 3600;

/** Saturation vapour pressure over liquid water (hPa), Ambaum (2020) eq. 13. */
export function satVaporPressure(t: number): number {
  const L = Lv - (Cp_l - Cp_v) * (t - T0);
  return ES0 * (T0 / t) ** ((Cp_l - Cp_v) / Rv) * Math.exp((Lv / T0 - L / t) / Rv);
}
export const mixingRatio = (e: number, p: number) => (EPS * e) / (p - e);
/** Saturation mixing ratio (kg/kg); NaN where the vapour pressure reaches the total pressure. */
export function satMixingRatio(p: number, t: number): number { const e = satVaporPressure(t); return e >= p ? NaN : mixingRatio(e, p); }
export const vaporPressure = (p: number, w: number) => (p * w) / (EPS + w);
/** Dew point (K) of a vapour pressure, Bolton (1980) inverse (as MetPy's `dewpoint`). */
export function dewpointFromVaporPressure(e: number): number { const x = Math.log(e / ES0); return 273.15 + (243.5 * x) / (17.67 - x); }
export const virtualTemperature = (t: number, w: number) => (t * (w + EPS)) / (EPS * (1 + w));
export const potentialTemperature = (p: number, t: number) => t * (1000 / p) ** KAPPA;
/** Equivalent potential temperature (K), Bolton (1980) eq. 39. */
export function equivalentPotentialTemperature(p: number, t: number, td: number): number {
  const r = satMixingRatio(p, td), e = satVaporPressure(td);
  const tl = 56 + 1 / (1 / (td - 56) + Math.log(t / td) / 800);
  const thl = potentialTemperature(p - e, t) * (t / tl) ** (0.28 * r);
  return thl * Math.exp(r * (1 + 0.448 * r) * (3036 / tl - 1.78));
}

/** Lower branch W₋₁ of the Lambert W function for x in [−1/e, 0) (Halley iteration). */
export function lambertWm1(x: number): number {
  if (!(x < 0) || x < -1 / Math.E - 1e-12) return NaN;
  let w = x < -0.25 ? -1 - Math.sqrt(Math.max(0, 2 * (1 + Math.E * x))) : Math.log(-x) - Math.log(-Math.log(-x));
  for (let i = 0; i < 50; i++) {
    const ew = Math.exp(w), f = w * ew - x, d = ew * (w + 1) - ((w + 2) * f) / (2 * w + 2);
    if (!d) break;
    const next = w - f / d;
    if (Math.abs(next - w) <= 1e-13 * Math.abs(next)) return next;
    w = next;
  }
  return w;
}

/** Lifted condensation level of a parcel (p hPa, T K, Td K): exact solution of Romps (2017). */
export function lcl(p: number, t: number, td: number): { p: number; t: number } {
  const w = satMixingRatio(p, td), q = w / (1 + w);
  const ratio = (Cp_d + q * (Cp_v - Cp_d)) / (Rd + q * (Rv - Rd));
  const a = ratio + (Cp_l - Cp_v) / Rv, b = -(Lv + (Cp_l - Cp_v) * T0) / (Rv * t), c = b / a;
  const rh = satVaporPressure(td) / satVaporPressure(t);
  const tl = (c / lambertWm1(rh ** (1 / a) * c * Math.exp(c))) * t;
  return { p: p * (tl / t) ** ratio, t: tl };
}

export const dryLapse = (p: number, t0: number, p0: number) => t0 * (p / p0) ** KAPPA;

/** dT/d ln p along a pseudo-adiabat (MetPy moist_lapse). */
function moistSlope(lnp: number, t: number): number {
  const rs = satMixingRatio(Math.exp(lnp), t);
  return (Rd * t + Lv * rs) / (Cp_d + (Lv * Lv * rs * EPS) / (Rd * t * t));
}
/** Pseudo-adiabat through (p0, t0) evaluated at `pressures` (RK4 in ln p, steps ≤ 0.004). */
export function moistLapse(pressures: number[], t0: number, p0: number): number[] {
  const out = new Array<number>(pressures.length);
  const order = pressures.map((p, i) => [p, i] as const).sort((a, b) => (p0 >= a[0] ? b[0] - a[0] : a[0] - b[0]));
  // Upward targets (p < p0) in decreasing pressure, then downward ones from p0 again.
  for (const dir of [-1, 1]) {
    let x = Math.log(p0), t = t0;
    for (const [p, i] of order) {
      if (dir < 0 ? p > p0 : p <= p0) continue;
      const target = Math.log(p);
      while (Math.abs(target - x) > 1e-12) {
        const h = Math.sign(target - x) * Math.min(0.004, Math.abs(target - x));
        const k1 = moistSlope(x, t), k2 = moistSlope(x + h / 2, t + (h / 2) * k1), k3 = moistSlope(x + h / 2, t + (h / 2) * k2), k4 = moistSlope(x + h, t + h * k3);
        t += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
        x += h;
      }
      out[i] = t;
    }
  }
  return out;
}

/** Linear interpolation of y at x in a series (x monotonic either way); NaN outside. */
export function interp(x: number, xs: number[], ys: number[]): number {
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1];
    if ((x - a) * (x - b) <= 0) return a === b ? ys[i] : ys[i] + ((ys[i + 1] - ys[i]) * (x - a)) / (b - a);
  }
  return NaN;
}
/** Interpolation linear in ln p (pressures decreasing). */
export const interpLogP = (p: number, ps: number[], ys: number[]) => interp(Math.log(p), ps.map(Math.log), ys);

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-8 + 1e-5 * Math.abs(b);
const lessOrClose = (a: number, b: number) => a < b || isClose(a, b);
const greaterOrClose = (a: number, b: number) => a > b || isClose(a, b);

/** Zero crossings of a − b between consecutive points, interpolated in ln p; `dir` +1 = a becomes larger upward. */
function crossings(p: number[], a: number[], b: number[], dir: 1 | -1 | 0, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + 1 < p.length; i++) {
    const d0 = a[i] - b[i], d1 = a[i + 1] - b[i + 1];
    if (Math.sign(d0) === Math.sign(d1)) continue;
    if (dir && Math.sign(d1) !== dir) continue;
    const x0 = Math.log(p[i]), x1 = Math.log(p[i + 1]);
    const x = Math.exp((d1 * x0 - d0 * x1) / (d1 - d0));
    if (out[out.length - 1] !== x) out.push(x);
  }
  return out;
}

export interface ParcelPath { p: number[]; t: number[]; td: number[]; parcel: number[]; lclP: number; lclT: number }
/** Parcel lifted from the first level (dry to its LCL, then pseudo-adiabatic) with the LCL inserted. */
export function parcelPath(p: number[], t: number[], td: number[]): ParcelPath {
  const l = lcl(p[0], t[0], td[0]);
  const below = p.filter((x) => x >= l.p), above = p.filter((x) => x < l.p);
  // As MetPy: the pseudo-adiabat starts from the dry adiabat's temperature at the LCL pressure (within ~0.05 K of the
  // Romps LCL temperature, which is the value given at the LCL point itself).
  const parcel = [...below.map((x) => dryLapse(x, t[0], p[0])), l.t, ...moistLapse(above, dryLapse(l.p, t[0], p[0]), l.p)];
  const k = below.length;
  const ins = (ys: number[]) => [...ys.slice(0, k), interp(l.p, p, ys), ...ys.slice(k)];
  return { p: [...below, l.p, ...above], t: ins(t), td: ins(td), parcel, lclP: l.p, lclT: l.t };
}

export interface CapeResult { cape: number; cin: number; lfcP: number | null; elP: number | null }
/**
 * CAPE/CIN (J/kg) of a parcel path, with the bottom-most LFC and top-most EL. `virtual` applies the virtual
 * temperature correction (the panel's values); without it the plain temperatures are compared (MetPy's lfc/el).
 */
export function capeCin(path: ParcelPath, virtual = true): CapeResult {
  const { p, t, td, parcel, lclP } = path;
  const w0 = satMixingRatio(p[0], td[0]);
  const tvE = virtual ? p.map((x, i) => virtualTemperature(t[i], satMixingRatio(x, td[i]))) : t;
  const tvP = virtual ? p.map((x, i) => virtualTemperature(parcel[i], x > lclP ? w0 : satMixingRatio(x, parcel[i]))) : parcel;
  const n = p.length;
  // LFC: like MetPy, the LCL used to classify crossings is found from the parcel's virtual temperature.
  const lfcLcl = lcl(p[0], tvP[0], td[0]).p;
  let lfcP: number | null;
  const inc = crossings(p, tvP, tvE, 1, isClose(tvP[0], tvE[0]) ? 1 : 0);
  if (!inc.length) lfcP = p.every((x, i) => x >= lfcLcl || lessOrClose(tvP[i], tvE[i])) ? null : lfcLcl;
  else {
    const above = inc.filter((x) => x < lfcLcl);
    if (above.length) lfcP = above[0];
    else { const dec = crossings(p, tvP, tvE, -1, 1); lfcP = dec.length && Math.min(...dec) > lfcLcl ? null : lfcLcl; }
  }
  if (lfcP === null) return { cape: 0, cin: 0, lfcP: null, elP: null };
  let elP: number | null = null;
  if (tvP[n - 1] <= tvE[n - 1]) {
    const elLcl = lcl(p[0], tvE[0], td[0]).p;
    const dec = crossings(p, tvP, tvE, -1, 1).filter((x) => x < elLcl);
    if (dec.length) elP = dec[dec.length - 1];
  }
  const top = elP ?? p[n - 1];
  // Integrate (Tv,parcel − Tv,env) d ln p over the sample points plus every zero crossing.
  const y = tvP.map((v, i) => v - tvE[i]);
  const pts = p.map((x, i) => [x, y[i]]);
  for (const x of crossings(p.slice(1), y.slice(1), y.slice(1).map(() => 0), 0)) pts.push([x, 0]);
  pts.sort((a, b) => a[0] - b[0]);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < pts.length; i++) if (i === pts.length - 1 || pts[i + 1][0] - pts[i][0] > 1e-6) { xs.push(pts[i][0]); ys.push(pts[i][1]); }
  const area = (keep: (x: number) => boolean) => {
    let s = 0, prev = -1;
    for (let i = 0; i < xs.length; i++) {
      if (!keep(xs[i])) continue;
      if (prev >= 0) s += ((ys[i] + ys[prev]) / 2) * (Math.log(xs[i]) - Math.log(xs[prev]));
      prev = i;
    }
    return Rd * s;
  };
  const cape = area((x) => lessOrClose(x, lfcP!) && greaterOrClose(x, top));
  const cin = Math.min(0, area((x) => greaterOrClose(x, lfcP!)));
  return { cape, cin, lfcP, elP };
}

/** One sounding level; missing values are NaN. p hPa, z m MSL, t/td K, u/v m/s. */
export interface Level { p: number; z: number; t: number; td: number; u: number; v: number }
export interface Parcel extends CapeResult { kind: 'SB' | 'ML' | 'MU'; p0: number; t0: number; td0: number; path: ParcelPath }

/** Thermodynamic levels (p, z, T, Td valid), surface first. */
export const thermoLevels = (lv: Level[]) => lv.filter((l) => [l.p, l.z, l.t, l.td].every(Number.isFinite));
/** Wind levels (p, z, u, v valid), surface first. */
export const windLevels = (lv: Level[]) => lv.filter((l) => [l.p, l.z, l.u, l.v].every(Number.isFinite));

function parcelFrom(kind: Parcel['kind'], p: number[], t: number[], td: number[]): Parcel {
  const path = parcelPath(p, t, td);
  return { kind, p0: p[0], t0: t[0], td0: td[0], path, ...capeCin(path) };
}
export function surfaceParcel(th: Level[]): Parcel { return parcelFrom('SB', th.map((l) => l.p), th.map((l) => l.t), th.map((l) => l.td)); }

/** Mixed-layer parcel: θ and mixing ratio averaged (trapezoid in p) over the lowest `depth` hPa. */
export function mixedLayerParcel(th: Level[], depth = 100): Parcel {
  const p = th.map((l) => l.p), p0 = p[0], top = p0 - depth;
  const theta = th.map((l) => potentialTemperature(l.p, l.t)), w = th.map((l) => satMixingRatio(l.p, l.td));
  const layer = p.filter((x) => lessOrClose(x, p0) && greaterOrClose(x, top));
  if (!layer.some((x) => isClose(x, top))) layer.push(top);
  const mean = (ys: number[]) => {
    let s = 0;
    for (let i = 1; i < layer.length; i++) s += ((interpLogP(layer[i], p, ys) + interpLogP(layer[i - 1], p, ys)) / 2) * (layer[i - 1] - layer[i]);
    return s / (layer[0] - layer[layer.length - 1]);
  };
  const t0 = mean(theta) * (p0 / 1000) ** KAPPA, td0 = dewpointFromVaporPressure(vaporPressure(p0, mean(w)));
  const rest = th.filter((l) => l.p < top);
  return parcelFrom('ML', [p0, ...rest.map((l) => l.p)], [t0, ...rest.map((l) => l.t)], [td0, ...rest.map((l) => l.td)]);
}

/** Most-unstable parcel: the level of highest θe within `depth` hPa of the surface (nearest level as the top). */
export function mostUnstableParcel(th: Level[], depth = 300): Parcel {
  const top = th.reduce((best, l) => (Math.abs(l.p - (th[0].p - depth)) < Math.abs(best.p - (th[0].p - depth)) ? l : best), th[0]).p;
  let k = 0, best = -Infinity;
  th.forEach((l, i) => { if (l.p >= top) { const te = equivalentPotentialTemperature(l.p, l.t, l.td); if (te > best) { best = te; k = i; } } });
  const s = th.slice(k);
  return parcelFrom('MU', s.map((l) => l.p), s.map((l) => l.t), s.map((l) => l.td));
}

/** Precipitable water (mm) from the dew points of the levels down to `top` hPa (dew point log-p interpolated there). */
export function precipitableWater(p: number[], td: number[], top = p[p.length - 1]): number {
  const ps = p.filter((x) => greaterOrClose(x, top)), tds = td.slice(0, ps.length);
  if (!ps.some((x) => isClose(x, top))) { ps.push(top); tds.push(interpLogP(top, p, td)); }
  let s = 0, prev = 0;
  ps.forEach((x, i) => { const w = mixingRatio(satVaporPressure(tds[i]), x); if (i) s += ((w + prev) / 2) * (ps[i - 1] - x) * 100; prev = w; });
  return (s / (G * RHO_L)) * 1000;
}

/** u, v (m/s) of a wind from `dirDeg` at `speed` (any unit, returned in the same unit). */
export const windComponents = (dirDeg: number, speed: number): [number, number] => [-speed * Math.sin((dirDeg * Math.PI) / 180), -speed * Math.cos((dirDeg * Math.PI) / 180)];

/**
 * Wind layer between heights `bottom` and `bottom + depth` (m MSL) as MetPy's get_layer does with heights: the bound
 * pressures linear in height, winds at the bounds linear in ln p. Returns pressures (decreasing) and u, v.
 */
function windLayer(wl: Level[], bottom: number, depth: number): { p: number[]; u: number[]; v: number[] } | null {
  const z = wl.map((l) => l.z), p = wl.map((l) => l.p);
  const pb = interp(bottom, z, p), pt = interp(bottom + depth, z, p);
  if (!Number.isFinite(pb) || !Number.isFinite(pt)) return null;
  const ps = p.filter((x) => lessOrClose(x, pb) && greaterOrClose(x, pt));
  if (!ps.some((x) => isClose(x, pt))) ps.push(pt);
  if (!ps.some((x) => isClose(x, pb))) ps.unshift(pb);
  ps.sort((a, b) => b - a);
  const at = (ys: number[]) => ps.map((x) => interpLogP(x, p, ys));
  return { p: ps, u: at(wl.map((l) => l.u)), v: at(wl.map((l) => l.v)) };
}
/** Pressure-weighted mean wind of a height layer (m MSL bounds). */
export function meanWind(wl: Level[], bottom: number, depth: number): [number, number] | null {
  const L = windLayer(wl, bottom, depth);
  if (!L) return null;
  const avg = (ys: number[]) => { let s = 0; for (let i = 1; i < ys.length; i++) s += ((ys[i] + ys[i - 1]) / 2) * (L.p[i] - L.p[i - 1]); return s / (L.p[L.p.length - 1] - L.p[0]); };
  return [avg(L.u), avg(L.v)];
}
/** Bulk wind difference (top − bottom) over `depth` m above the lowest wind level. */
export function bulkShear(wl: Level[], depth: number): [number, number] | null {
  const L = windLayer(wl, wl[0]?.z ?? NaN, depth);
  return L ? [L.u[L.u.length - 1] - L.u[0], L.v[L.v.length - 1] - L.v[0]] : null;
}
/** Bunkers et al. (2000) right and left movers and the 0–6 km pressure-weighted mean wind. */
export function bunkers(wl: Level[]): { rm: [number, number]; lm: [number, number]; mean: [number, number] } | null {
  const z0 = wl[0]?.z ?? NaN;
  const mean = meanWind(wl, z0, 6000), low = meanWind(wl, z0, 500), high = meanWind(wl, z0 + 5500, 500);
  if (!mean || !low || !high) return null;
  const su = high[0] - low[0], sv = high[1] - low[1], mag = Math.hypot(su, sv) || 1;
  const du = (7.5 * sv) / mag, dv = (-7.5 * su) / mag;
  return { rm: [mean[0] + du, mean[1] + dv], lm: [mean[0] - du, mean[1] - dv], mean };
}
/** Storm-relative helicity (m²/s²) from `bottom` to `bottom + depth` m above ground for storm motion (cu, cv). */
export function helicity(wl: Level[], depth: number, storm: [number, number], bottom = 0): number | null {
  const z0 = wl[0]?.z ?? NaN, h = wl.map((l) => l.z - z0);
  if (!(h[h.length - 1] >= bottom + depth)) return null;
  const hs = h.filter((x) => x >= bottom && x <= bottom + depth);
  if (!hs.includes(bottom + depth)) hs.push(bottom + depth);
  if (!hs.includes(bottom)) hs.unshift(bottom);
  hs.sort((a, b) => a - b);
  const u = hs.map((x) => interp(x, h, wl.map((l) => l.u)) - storm[0]), v = hs.map((x) => interp(x, h, wl.map((l) => l.v)) - storm[1]);
  let s = 0;
  for (let i = 1; i < hs.length; i++) s += u[i] * v[i - 1] - u[i - 1] * v[i];
  return s;
}

/** Height (m MSL) at pressure p, linear in ln p. */
const heightAt = (th: Level[], p: number) => interpLogP(p, th.map((l) => l.p), th.map((l) => l.z));

export interface WindIndices {
  /** 0–1 and 0–3 km storm-relative helicity (Bunkers right mover), 0–1 and 0–6 km bulk shear magnitude (m/s). */
  srh1: number | null; srh3: number | null; shear1: number | null; shear6: number | null;
  storm: ReturnType<typeof bunkers>;
}
export interface SoundingIndices extends WindIndices {
  sb: Parcel; ml: Parcel; mu: Parcel;
  /** Heights above ground (m) of the surface-based LCL, LFC and EL; null when absent. */
  lclM: number; lfcM: number | null; elM: number | null;
  pwatMm: number; lapse700500: number | null; lapse03: number | null;
}

/** Wind indices; layers start at the lowest wind level. */
export function windIndices(levels: Level[]): WindIndices {
  const wl = windLevels(levels);
  if (wl.length < 2) return { srh1: null, srh3: null, shear1: null, shear6: null, storm: null };
  const storm = bunkers(wl);
  const mag = (s: [number, number] | null) => (s ? Math.hypot(s[0], s[1]) : null);
  return {
    srh1: storm ? helicity(wl, 1000, storm.rm) : null, srh3: storm ? helicity(wl, 3000, storm.rm) : null,
    shear1: mag(bulkShear(wl, 1000)), shear6: mag(bulkShear(wl, 6000)), storm,
  };
}

/** Every index of the panel from one profile (surface first). Throws when there are too few levels. */
export function analyze(levels: Level[]): SoundingIndices {
  const th = thermoLevels(levels);
  if (th.length < 3) throw new Error('too few temperature/dew point levels');
  const sb = surfaceParcel(th), ml = mixedLayerParcel(th), mu = mostUnstableParcel(th);
  const z0 = th[0].z, agl = (p: number | null) => (p === null ? null : heightAt(th, p) - z0);
  const p = th.map((l) => l.p), t = th.map((l) => l.t);
  const lapse = (pa: number, pb: number) => { const ta = interpLogP(pa, p, t), tb = interpLogP(pb, p, t), za = heightAt(th, pa), zb = heightAt(th, pb); return [ta, tb, za, zb].every(Number.isFinite) ? ((ta - tb) / (zb - za)) * 1000 : null; };
  const t3 = interp(z0 + 3000, th.map((l) => l.z), t);
  return {
    ...windIndices(levels), sb, ml, mu, lclM: agl(sb.path.lclP)!, lfcM: agl(sb.lfcP), elM: agl(sb.elP),
    pwatMm: precipitableWater(p, th.map((l) => l.td)), lapse700500: lapse(700, 500), lapse03: Number.isFinite(t3) ? (t[0] - t3) / 3 : null,
  };
}

/** Pressure (hPa) of the ICAO standard atmosphere at a height (m MSL), for profiles that carry no pressure (VAD). */
export const standardPressure = (z: number) => 1013.25 * (1 - 2.25577e-5 * z) ** 5.25588;
