// Globe camera: look-at point (lon/lat, degrees), distance in the original's camera units, tilt and swivel.
// World space is the unit sphere (Earth radius = 1). Matrices are computed in float64.
// Units: altitude_km = Z × KM_PER_UNIT; zoom scale = Z / 30 (bands: ≥4 national,
// 1..4 regional, <1 local). Look-at engine units X = lon·150·π/180, Y = lat·200·π/180 are
// exposed for parity tests only; the camera API stays in degrees.
export const EARTH_KM = 6371;
export const KM_PER_UNIT = 27.5;
export const ZOOM_SCALE_DIV = 30;
export const FOV_Y = (30 * Math.PI) / 180;

export type Vec3 = [number, number, number];
export type Mat4 = Float64Array;

export const lonLatToXYZ = (lonDeg: number, latDeg: number, r = 1): Vec3 => {
  const lo = (lonDeg * Math.PI) / 180, la = (latDeg * Math.PI) / 180;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
};
export const xyzToLonLat = (p: Vec3): [number, number] => {
  const r = Math.hypot(p[0], p[1], p[2]);
  return [(Math.atan2(p[1], p[0]) * 180) / Math.PI, (Math.asin(p[2] / r) * 180) / Math.PI];
};
export const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
export const engineLookAt = (lon: number, lat: number) => [(lon * 150 * Math.PI) / 180, (lat * 200 * Math.PI) / 180];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export interface View { lon: number; lat: number; z: number; tilt: number; swivel: number }

export class Camera {
  /** Current (smoothed) and target views. */
  cur: View = { lon: -95, lat: 39, z: 163.75, tilt: 0, swivel: 0 };
  target: View = { ...this.cur };
  width = 1; height = 1;
  smoothing = { pan: true, zoom: true, tilt: true, swivel: true, lookX: true, lookYZ: true, amount: 900 };
  private fly: { from: View; to: View; t0: number; ms: number; jerk: number; end: number; nonLinear: boolean } | null = null;
  viewProj: Mat4 = new Float64Array(16);
  /** Projection × view rotation (no translation): shaders compute clip = vpRot · (p − eye) for precision. */
  vpRot: Mat4 = new Float64Array(16);
  eye: Vec3 = [0, 0, 2];
  private invViewProj: Mat4 = new Float64Array(16);

  get altitudeKm() { return this.cur.z * KM_PER_UNIT; }
  get zoomScale() { return this.cur.z / ZOOM_SCALE_DIV; }
  /** Approximate ground metres per CSS pixel at the look-at point. */
  metersPerPixel(dpr = 1) { return ((2 * Math.tan(FOV_Y / 2) * this.altitudeKm * 1000) / this.height) * dpr; }

  setView(v: Partial<View>, immediate = false) {
    Object.assign(this.target, v);
    this.target.lon = wrapLon(this.target.lon);
    this.target.lat = Math.max(-89.5, Math.min(89.5, this.target.lat));
    this.target.z = Math.max(0.02, Math.min(2000, this.target.z));
    this.target.tilt = Math.max(0, Math.min(80, this.target.tilt));
    if (immediate) { this.cur = { ...this.target }; this.fly = null; }
  }

  flyTo(v: Partial<View>, ms: number, opts: { jerk?: number; end?: number; nonLinear?: boolean } = {}) {
    const to = { ...this.target, ...v };
    to.lon = wrapLon(to.lon);
    this.fly = { from: { ...this.cur }, to, t0: performance.now(), ms, jerk: opts.jerk ?? 0.45, end: opts.end ?? 20, nonLinear: !!opts.nonLinear };
    this.target = { ...to };
  }

  /** Advances smoothing; returns true while the camera is still moving. */
  update(now: number, dtMs: number): boolean {
    if (this.fly) {
      const f = this.fly;
      let t = Math.min(1, (now - f.t0) / f.ms);
      // Smoothstep easing; the non-linear option shapes it with the jerk and end-smoothing settings.
      const e = f.nonLinear ? 1 - Math.pow(1 - t, 1 + f.end / 10) * (1 - f.jerk * t * (1 - t)) : t * t * (3 - 2 * t);
      let dLon = f.to.lon - f.from.lon;
      if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
      const zMid = Math.max(f.from.z, f.to.z) * (1 + Math.min(1.5, Math.hypot(dLon, f.to.lat - f.from.lat) / 40));
      const zEase = t < 0.5 ? f.from.z + (zMid - f.from.z) * (2 * e) : zMid + (f.to.z - zMid) * (2 * e - 1);
      this.cur = {
        lon: wrapLon(f.from.lon + dLon * e), lat: f.from.lat + (f.to.lat - f.from.lat) * e,
        z: Math.abs(dLon) + Math.abs(f.to.lat - f.from.lat) > 2 ? zEase : f.from.z + (f.to.z - f.from.z) * e,
        tilt: f.from.tilt + (f.to.tilt - f.from.tilt) * e, swivel: f.from.swivel + (f.to.swivel - f.from.swivel) * e,
      };
      if (t >= 1) { this.fly = null; this.cur = { ...f.to }; }
      return true;
    }
    const tau = Math.max(1e-3, this.smoothing.amount / 6000);
    const k = 1 - Math.exp(-dtMs / 1000 / tau);
    const c = this.cur, g = this.target, s = this.smoothing;
    let moving = false;
    const step = (cv: number, tv: number, on: boolean, eps: number) => {
      if (!on || Math.abs(tv - cv) < eps) return tv;
      moving = true;
      return cv + (tv - cv) * k;
    };
    let dLon = g.lon - c.lon;
    if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
    const lonEps = 1e-7 * Math.max(1, c.z);
    c.lon = wrapLon(Math.abs(dLon) < lonEps || !(s.pan && s.lookX) ? g.lon : (moving = true, c.lon + dLon * k));
    c.lat = step(c.lat, g.lat, s.pan && s.lookYZ, lonEps);
    c.z = step(c.z, g.z, s.zoom, 1e-5 * g.z);
    c.tilt = step(c.tilt, g.tilt, s.tilt, 1e-3);
    c.swivel = step(c.swivel, g.swivel, s.swivel, 1e-3);
    return moving;
  }

  /** Recomputes view/projection for the current view and viewport size (CSS px). */
  compute() {
    const v = this.cur;
    const d = (v.z * KM_PER_UNIT) / EARTH_KM;
    const P = lonLatToXYZ(v.lon, v.lat);
    const n = norm(P);
    const east = norm(cross([0, 0, 1], n));
    const north = cross(n, east);
    const h = (v.swivel * Math.PI) / 180, t = (v.tilt * Math.PI) / 180;
    const fwdH = add(scale(north, Math.cos(h)), scale(east, Math.sin(h)));
    this.eye = add(P, scale(add(scale(n, Math.cos(t)), scale(fwdH, -Math.sin(t))), d));
    const up = norm(add(scale(fwdH, Math.cos(t)), scale(n, Math.sin(t))));
    const view = lookAt(this.eye, P, up);
    const distToCenter = Math.hypot(...this.eye);
    const far = distToCenter + 1.5;
    const near = Math.max(1e-6, Math.min(d * 0.05, (distToCenter - 1) * 0.5));
    const proj = perspective(FOV_Y, this.width / this.height, near, far);
    this.viewProj = mul(proj, view);
    const rot = view.slice(); rot[12] = rot[13] = rot[14] = 0;
    this.vpRot = mul(proj, rot);
    this.invViewProj = invert(this.viewProj);
  }

  /** World point → CSS pixel (x, y, visible). */
  project(p: Vec3): [number, number, boolean] {
    const m = this.viewProj;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0) return [0, 0, false];
    const front = dot(sub(this.eye, p), p) > 0; // horizon test on the unit sphere
    return [((x / w) * 0.5 + 0.5) * this.width, (1 - ((y / w) * 0.5 + 0.5)) * this.height, front];
  }

  /** CSS pixel → lon/lat on the globe (null when the ray misses). */
  pick(px: number, py: number): [number, number] | null {
    const nx = (px / this.width) * 2 - 1, ny = 1 - (py / this.height) * 2;
    const a = unproject(this.invViewProj, nx, ny, 0), b = unproject(this.invViewProj, nx, ny, 1);
    const dir = norm(sub(b, a));
    const o = this.eye;
    const B = dot(o, dir), C = dot(o, o) - 1;
    const disc = B * B - C;
    if (disc < 0) return null;
    const tHit = -B - Math.sqrt(disc);
    if (tHit < 0) return null;
    return xyzToLonLat(add(o, scale(dir, tHit)));
  }
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const f = norm(sub(target, eye)), s = norm(cross(f, up)), u = cross(s, f);
  const m = new Float64Array(16);
  m[0] = s[0]; m[4] = s[1]; m[8] = s[2];
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2];
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
  m[12] = -dot(s, eye); m[13] = -dot(u, eye); m[14] = dot(f, eye); m[15] = 1;
  return m;
}

/** WebGPU clip space (z in [0,1]). */
function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2), m = new Float64Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = far / (near - far); m[11] = -1; m[14] = (near * far) / (near - far);
  return m;
}

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

function unproject(inv: Mat4, x: number, y: number, z: number): Vec3 {
  const X = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
  const Y = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
  const Z = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  const W = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  return [X / W, Y / W, Z / W];
}

export function invert(m: Mat4): Mat4 {
  const inv = new Float64Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  det = det ? 1 / det : 0;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}
