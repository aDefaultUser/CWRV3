// Polylines on the globe → line segments for LineSet: lon/lat vertices on a sphere of radius 1 + height, edges split
// so that no step exceeds MAX_STEP_DEG. Pure, so that the decode worker can build large sets (the prebuilt GIS).

export interface LineInput { coords: ArrayLike<number>; style: number; height?: number }

const MAX_STEP_DEG = 0.75;
const D = Math.PI / 180;

/** Move the end longitude to within 180° of the normalized start, including multiple full turns. */
function wrapLon(lo0: number, lo1: number) {
  const delta = ((lo1 % 360) - lo0) % 360;
  return lo0 + (delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta);
}

function stepsOf(lo0: number, la0: number, lo1: number, la1: number) {
  if (!Number.isFinite(lo0) || !Number.isFinite(lo1) || !(Math.abs(la0) <= 90 && Math.abs(la1) <= 90)) return 0;
  return Math.max(1, Math.ceil(Math.max(Math.abs(lo1 - lo0), Math.abs(la1 - la0)) / MAX_STEP_DEG));
}

/** Segments of `lines`, 8 floats each: a xyz, style, b xyz, 0 (in input order). */
export function tessellate(lines: readonly LineInput[]): Float32Array {
  let n = 0;
  // Counted with the same wrap and steps as written below, so the array fits every segment.
  for (const { coords: c } of lines) {
    for (let i = 0; i + 3 < c.length; i += 2) {
      const lo0 = c[i] % 360;
      n += stepsOf(lo0, c[i + 1], wrapLon(lo0, c[i + 2]), c[i + 3]);
    }
  }
  const f = new Float32Array(n * 8);
  let k = 0;
  // Written in place without per-segment arrays; a vertex shared by two edges is converted once (its position
  // carries over: a longitude moved by ±360° across the antimeridian is the same point).
  for (const l of lines) {
    const rr = 1 + (l.height ?? 0.000004), c = l.coords;
    let ax = 0, ay = 0, az = 0, connected = false;
    for (let i = 0; i + 3 < c.length; i += 2) {
      const lo0 = c[i] % 360, la0 = c[i + 1], lo1 = wrapLon(lo0, c[i + 2]), la1 = c[i + 3];
      const steps = stepsOf(lo0, la0, lo1, la1);
      if (!steps) { connected = false; continue; }
      if (!connected) {
        const cl = Math.cos(la0 * D);
        ax = rr * cl * Math.cos(lo0 * D); ay = rr * cl * Math.sin(lo0 * D); az = rr * Math.sin(la0 * D);
        connected = true;
      }
      for (let s = 1; s <= steps; s++) {
        const lo = (lo0 + ((lo1 - lo0) * s) / steps) * D, la = (la0 + ((la1 - la0) * s) / steps) * D, cl = Math.cos(la);
        const bx = rr * cl * Math.cos(lo), by = rr * cl * Math.sin(lo), bz = rr * Math.sin(la), o = k * 8;
        f[o] = ax; f[o + 1] = ay; f[o + 2] = az; f[o + 3] = l.style; f[o + 4] = bx; f[o + 5] = by; f[o + 6] = bz; f[o + 7] = 0;
        ax = bx; ay = by; az = bz; k++;
      }
    }
  }
  return f;
}
