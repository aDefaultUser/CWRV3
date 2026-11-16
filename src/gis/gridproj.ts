// Grid geolocation from GRIB2 grid definitions (: projection files are replaced by the grid
// definition). Indices follow the decoded data order after scan normalisation: i from the first point eastward,
// j from the first row in the stored row direction (scan bit 0x40 set = northward, clear = southward).
import type { Grid } from '../decode/grib2';

/** Same shape as render/raster ProjParams (kept here so workers need no render code). */
export interface ProjParamsLike { kind: 0 | 1 | 2 | 3 | 4; nx: number; ny: number; flip?: boolean; a: number[]; b: number[]; c?: number[] }

const RAD = Math.PI / 180;
const wrap = (d: number) => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

export interface GridMap { fwd(lon: number, lat: number): [number, number]; inv(i: number, j: number): [number, number]; nx: number; ny: number }

export function gridMap(g: Grid): GridMap {
  const jSign = (g.scan & 0x40) ? 1 : -1;
  if (g.kind === 'latlon') {
    const lo1 = g.lo1, la1 = g.la1;
    let dlon = g.lo2 - g.lo1; if (dlon <= 0) dlon += 360;
    const di = dlon / Math.max(1, g.ni - 1), dj = (g.la2 - g.la1) / Math.max(1, g.nj - 1);
    return {
      nx: g.ni, ny: g.nj,
      fwd: (lon, lat) => { let d = lon - lo1; while (d < -di / 2) d += 360; while (d >= 360 - di / 2) d -= 360; return [d / di, (lat - la1) / dj]; },
      inv: (i, j) => [wrap(lo1 + i * di), la1 + j * dj],
    };
  }
  if (g.kind === 'mercator') {
    const R = g.radius, k = Math.cos(g.lad * RAD);
    const Y = (lat: number) => R * k * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
    const y1 = Y(g.la1);
    return {
      nx: g.nx, ny: g.ny,
      fwd: (lon, lat) => [(R * k * wrap(lon - g.lo1) * RAD) / g.di, (jSign * (Y(lat) - y1)) / g.dj],
      inv: (i, j) => [wrap(g.lo1 + (i * g.di) / (R * k) / RAD), (2 * Math.atan(Math.exp((y1 + jSign * j * g.dj) / (R * k))) - Math.PI / 2) / RAD],
    };
  }
  if (g.kind === 'polar') {
    // Spherical polar stereographic, true scale at LaD (GRIB2 template 3.20).
    const R = g.radius, h = g.south ? -1 : 1;
    const kd = 1 + Math.sin(h * g.lad * RAD);
    const xy = (lon: number, lat: number) => {
      const rho = R * kd * Math.tan(Math.PI / 4 - (h * lat * RAD) / 2);
      const a = wrap(lon - g.lov) * RAD;
      return [rho * Math.sin(a), -h * rho * Math.cos(a)];
    };
    const [x1, y1] = xy(g.lo1, g.la1);
    return {
      nx: g.nx, ny: g.ny,
      fwd: (lon, lat) => { const [x, y] = xy(lon, lat); return [(x - x1) / g.dx, (jSign * (y - y1)) / g.dy]; },
      inv: (i, j) => {
        const x = x1 + i * g.dx, y = y1 + jSign * j * g.dy;
        const rho = Math.hypot(x, y);
        const lat = h * (Math.PI / 2 - 2 * Math.atan(rho / (R * kd))) / RAD;
        const lon = wrap(g.lov + Math.atan2(x, -h * y) / RAD);
        return [lon, lat];
      },
    };
  }
  // Lambert conformal conic (template 3.30).
  const p1 = g.latin1 * RAD, p2 = g.latin2 * RAD;
  const n = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  const FR = (g.radius * Math.cos(p1) * Math.tan(Math.PI / 4 + p1 / 2) ** n) / n;
  const rho = (lat: number) => FR / Math.tan(Math.PI / 4 + (lat * RAD) / 2) ** n;
  const rho0 = rho(g.lad);
  const lov = wrap(g.lov);
  const xy = (lon: number, lat: number) => { const th = n * wrap(lon - lov) * RAD, r = rho(lat); return [r * Math.sin(th), rho0 - r * Math.cos(th)]; };
  const [x0, y0] = xy(g.lo1, g.la1);
  return {
    nx: g.nx, ny: g.ny,
    fwd: (lon, lat) => { const [x, y] = xy(lon, lat); return [(x - x0) / g.dx, (jSign * (y - y0)) / g.dy]; },
    inv: (i, j) => {
      const x = x0 + i * g.dx, y = y0 + jSign * j * g.dy;
      const r = Math.sign(n) * Math.hypot(x, rho0 - y);
      const th = Math.atan2(Math.sign(n) * x, Math.sign(n) * (rho0 - y));
      return [wrap(lov + th / n / RAD), (2 * Math.atan(Math.pow(FR / r, 1 / n)) - Math.PI / 2) / RAD];
    },
  };
}

/** Lat/lon bounds of a grid from its border points ([south, west, north, east]; west may exceed east across 180°). */
export function gridBounds(g: Grid): [number, number, number, number] {
  const m = gridMap(g);
  let s = 90, n = -90, w = 999, e = -999;
  const lons: number[] = [];
  const add = (i: number, j: number) => { const [lo, la] = m.inv(i, j); s = Math.min(s, la); n = Math.max(n, la); lons.push(lo); };
  const steps = 64;
  for (let k = 0; k <= steps; k++) {
    const fi = (k / steps) * (m.nx - 1), fj = (k / steps) * (m.ny - 1);
    add(fi, 0); add(fi, m.ny - 1); add(0, fj); add(m.nx - 1, fj);
  }
  // Polar grids contain the pole when the pole maps inside the grid.
  if (g.kind === 'polar') { const [pi, pj] = m.fwd(0, g.south ? -90 : 90); if (pi >= 0 && pj >= 0 && pi <= m.nx - 1 && pj <= m.ny - 1) { if (g.south) s = -90; else n = 90; return [s, -180, n, 180]; } }
  // Choose the longitude span (allowing a wrap across 180°) that is smallest.
  const a = Math.min(...lons), b = Math.max(...lons);
  const shifted = lons.map((x) => (x < 0 ? x + 360 : x));
  const a2 = Math.min(...shifted), b2 = Math.max(...shifted);
  if (b2 - a2 < b - a) { w = a2; e = b2; } else { w = a; e = b; }
  return [s, w, n, e];
}

/** GPU projection parameters for any decoded GRIB2 grid (after scan normalisation; see gis/gridproj). */
export function gridProj(g: Grid): ProjParamsLike {
  const rad = Math.PI / 180;
  const flip = !(g.scan & 0x40);
  if (g.kind === 'latlon') {
    let lo2 = g.lo2; if (lo2 <= g.lo1) lo2 += 360;
    // Cell-centred: extend half a cell beyond the first/last points.
    const di = (lo2 - g.lo1) / Math.max(1, g.ni - 1), dj = (g.la2 - g.la1) / Math.max(1, g.nj - 1);
    const lo1 = g.lo1 > 180 ? g.lo1 - 360 : g.lo1;
    return { kind: 0, nx: g.ni, ny: g.nj, a: [g.la1 - dj / 2, lo1 - di / 2, g.la2 + dj / 2, lo1 + (lo2 - g.lo1) + di / 2], b: [0, 0, 0, 0] };
  }
  if (g.kind === 'lambert') {
    const p1 = g.latin1 * rad, p2 = g.latin2 * rad;
    const n = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
    const FR = (g.radius * Math.cos(p1) * Math.tan(Math.PI / 4 + p1 / 2) ** n) / n;
    const rho = (lat: number) => FR / Math.tan(Math.PI / 4 + (lat * rad) / 2) ** n;
    const rho0 = rho(g.lad);
    const lov = g.lov > 180 ? g.lov - 360 : g.lov;
    let dl = (g.lo1 > 180 ? g.lo1 - 360 : g.lo1) - lov;
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    const th = n * dl * rad, r1 = rho(g.la1);
    return { kind: 2, nx: g.nx, ny: g.ny, flip, a: [n, FR, rho0, lov], b: [r1 * Math.sin(th), rho0 - r1 * Math.cos(th), g.dx, g.dy] };
  }
  if (g.kind === 'polar') {
    const h = g.south ? -1 : 1, kd = g.radius * (1 + Math.sin(h * g.lad * rad));
    const lov = g.lov > 180 ? g.lov - 360 : g.lov;
    let a = (g.lo1 - lov) % 360; if (a > 180) a -= 360; if (a < -180) a += 360;
    const rho = kd * Math.tan(Math.PI / 4 - (h * g.la1 * rad) / 2);
    return { kind: 3, nx: g.nx, ny: g.ny, flip, a: [kd, h, lov, 0], b: [rho * Math.sin(a * rad), -h * rho * Math.cos(a * rad), g.dx, g.dy] };
  }
  const Rk = g.radius * Math.cos(g.lad * rad);
  const lo1 = g.lo1 > 180 ? g.lo1 - 360 : g.lo1;
  return { kind: 4, nx: g.nx, ny: g.ny, flip, a: [Rk, lo1, Rk * Math.log(Math.tan(Math.PI / 4 + (g.la1 * rad) / 2)), 0], b: [0, 0, g.di, g.dj] };
}
