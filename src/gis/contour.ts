// Marching-squares isolines on a regular grid with segment chaining, Gaussian smoothing and Lambert inversion.
import type { LambertGrid } from '../decode/grib2';

export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.05) return src.slice();
  const r = Math.ceil(sigma * 2.5), k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, ws = 0;
    for (let i = -r; i <= r; i++) { const xx = x + i; if (xx < 0 || xx >= w) continue; const v = src[y * w + xx]; if (v !== v) continue; a += v * k[i + r]; ws += k[i + r]; }
    tmp[y * w + x] = ws ? a / ws : NaN;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, ws = 0;
    for (let i = -r; i <= r; i++) { const yy = y + i; if (yy < 0 || yy >= h) continue; const v = tmp[yy * w + x]; if (v !== v) continue; a += v * k[i + r]; ws += k[i + r]; }
    out[y * w + x] = ws ? a / ws : NaN;
  }
  return out;
}

/** Isolines at `levels`; returns polylines in grid coordinates (x, y interleaved) per level. */
export function isolines(v: Float32Array, w: number, h: number, levels: number[]): { level: number; lines: number[][] }[] {
  const out: { level: number; lines: number[][] }[] = [];
  for (const L of levels) {
    const segs: number[] = [];
    for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
      const a = v[y * w + x], b = v[y * w + x + 1], c = v[(y + 1) * w + x + 1], d = v[(y + 1) * w + x];
      if (a !== a || b !== b || c !== c || d !== d) continue;
      const idx = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (c >= L ? 2 : 0) | (d >= L ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const t = (p: number, q: number) => (L - p) / (q - p);
      const top = [x + t(a, b), y], right = [x + 1, y + t(b, c)], bottom = [x + t(d, c), y + 1], left = [x, y + t(a, d)];
      const add = (p: number[], q: number[]) => segs.push(p[0], p[1], q[0], q[1]);
      switch (idx) {
        case 1: case 14: add(left, bottom); break;
        case 2: case 13: add(bottom, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(top, right); break;
        case 5: add(left, top); add(bottom, right); break;
        case 6: case 9: add(top, bottom); break;
        case 7: case 8: add(left, top); break;
        case 10: add(top, right); add(left, bottom); break;
      }
    }
    out.push({ level: L, lines: chain(segs) });
  }
  return out;
}

function chain(segs: number[]): number[][] {
  const key = (x: number, y: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
  const n = segs.length / 4;
  const ends = new Map<string, number[]>();
  for (let i = 0; i < n; i++) for (const e of [0, 1]) {
    const k = key(segs[i * 4 + e * 2], segs[i * 4 + e * 2 + 1]);
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k)!.push(i * 2 + e);
  }
  const used = new Uint8Array(n);
  const lines: number[][] = [];
  const other = (ref: number) => { const i = ref >> 1, e = ref & 1; return [segs[i * 4 + (1 - e) * 2], segs[i * 4 + (1 - e) * 2 + 1]]; };
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const line = [segs[s * 4], segs[s * 4 + 1], segs[s * 4 + 2], segs[s * 4 + 3]];
    for (const dir of [1, -1]) {
      for (;;) {
        const px = dir > 0 ? line[line.length - 2] : line[0], py = dir > 0 ? line[line.length - 1] : line[1];
        const cand = (ends.get(key(px, py)) ?? []).find((r) => !used[r >> 1]);
        if (cand === undefined) break;
        used[cand >> 1] = 1;
        const [qx, qy] = other(cand);
        if (dir > 0) line.push(qx, qy); else line.unshift(qx, qy);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Inverse Lambert conformal: grid index (i, j) → lon/lat. */
export function lambertInverse(g: LambertGrid): (i: number, j: number) => [number, number] {
  const rad = Math.PI / 180;
  const p1 = g.latin1 * rad, p2 = g.latin2 * rad;
  const n = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  const FR = (g.radius * Math.cos(p1) * Math.tan(Math.PI / 4 + p1 / 2) ** n) / n;
  const rho = (lat: number) => FR / Math.tan(Math.PI / 4 + (lat * rad) / 2) ** n;
  const rho0 = rho(g.lad);
  const lov = g.lov > 180 ? g.lov - 360 : g.lov;
  let dl = (g.lo1 > 180 ? g.lo1 - 360 : g.lo1) - lov;
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  const r1 = rho(g.la1), th1 = n * dl * rad;
  const x0 = r1 * Math.sin(th1), y0 = rho0 - r1 * Math.cos(th1);
  return (i, j) => {
    const x = x0 + i * g.dx, y = y0 + j * g.dy;
    const r = Math.sign(n) * Math.hypot(x, rho0 - y);
    const th = Math.atan2(x, rho0 - y);
    return [lov + th / n / rad, (2 * Math.atan(Math.pow(FR / r, 1 / n)) - Math.PI / 2) / rad];
  };
}
