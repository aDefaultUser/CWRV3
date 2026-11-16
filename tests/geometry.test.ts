// Camera, projection and antimeridian handling; GOES and Lambert projections; WPC bulletin; timeline bracketing.
import { describe, expect, it } from 'vitest';
import { Camera, lonLatToXYZ, xyzToLonLat, wrapLon, engineLookAt } from '../src/render/camera';
import { lambertProj } from '../src/render/raster';
import { lambertInverse } from '../src/gis/contour';
import { lambertIndex, type LambertGrid } from '../src/decode/grib2';
import { geosForward } from '../src/decode/goes';
import { parseCodsus } from '../src/decode/wpc';
import { bracket } from '../src/app/timeline';
import { encodeLineSet, decodeLineSet } from '../src/gis/lineset';
import { simplify } from '../src/decode/shapefile';
import { gcDistanceKm, bearingDeg, destination } from '../src/layers/annotations';

describe('camera', () => {
  it('lon/lat ↔ unit sphere round-trips, including across the antimeridian', () => {
    for (const [lon, lat] of [[-95, 39], [179.9, 10], [-179.9, -10], [0, 89]]) {
      const [lo, la] = xyzToLonLat(lonLatToXYZ(lon, lat));
      expect(lo).toBeCloseTo(lon, 9); expect(la).toBeCloseTo(lat, 9);
    }
    expect(wrapLon(190)).toBe(-170); expect(wrapLon(-181)).toBe(179); expect(wrapLon(540)).toBe(-180);
  });
  it('engine look-at units follow  (X = lon·150·π/180, Y = lat·200·π/180)', () => {
    const [x, y] = engineLookAt(-95, 39);
    expect(x).toBeCloseTo((-95 * 150 * Math.PI) / 180, 12); expect(y).toBeCloseTo((39 * 200 * Math.PI) / 180, 12);
  });
  it('projects the look-at point to the screen centre and picks it back', () => {
    const c = new Camera(); c.width = 1600; c.height = 900;
    c.setView({ lon: 179.5, lat: 20, z: 40, tilt: 30, swivel: 25 }, true); c.compute();
    const [x, y, front] = c.project(lonLatToXYZ(179.5, 20));
    expect(front).toBe(true); expect(x).toBeCloseTo(800, 3); expect(y).toBeCloseTo(450, 3);
    const ll = c.pick(800, 450)!;
    expect(ll[0]).toBeCloseTo(179.5, 5); expect(ll[1]).toBeCloseTo(20, 5);
    // A point just across the antimeridian is visible and to the right of centre.
    const [x2] = c.project(lonLatToXYZ(-179.5, 20));
    expect(x2).toBeGreaterThan(800);
  });
  it('rejects points behind the horizon', () => {
    const c = new Camera(); c.width = 1000; c.height = 1000;
    c.setView({ lon: -95, lat: 39, z: 163.75 }, true); c.compute();
    expect(c.project(lonLatToXYZ(85, -39))[2]).toBe(false);
  });
  it('wraps panning longitude through the antimeridian', () => {
    const c = new Camera();
    c.setView({ lon: 179 }, true); c.setView({ lon: c.target.lon + 3 }, true);
    expect(c.cur.lon).toBeCloseTo(-178, 9);
  });
  it('maps the default distance to the national zoom band', () => {
    const c = new Camera(); c.setView({ z: 163.75 }, true);
    expect(c.zoomScale).toBeGreaterThanOrEqual(4);
  });
});

describe('Lambert conformal (HRRR)', () => {
  const g: LambertGrid = { kind: 'lambert', nx: 1799, ny: 1059, la1: 21.138123, lo1: 237.280472, lad: 38.5, lov: 262.5, dx: 3000, dy: 3000, latin1: 38.5, latin2: 38.5, scan: 64, radius: 6371229 };
  it('inverse and forward projections agree', () => {
    const inv = lambertInverse(g);
    for (const [i, j] of [[0, 0], [900, 500], [1798, 1058]]) {
      const [lon, lat] = inv(i, j);
      const [ii, jj] = lambertIndex(g, lat, lon);
      expect(ii).toBeCloseTo(i, 4); expect(jj).toBeCloseTo(j, 4);
    }
    expect(inv(0, 0)[1]).toBeCloseTo(21.138123, 5);
  });
  it('shader parameters reproduce grid index 0 at the first grid point', () => {
    const p = lambertProj(g);
    const [n, FR, rho0] = p.a, [x0, y0] = p.b;
    const rho = FR / Math.tan(Math.PI / 4 + (21.138123 * Math.PI) / 360) ** n;
    const th = (n * (237.280472 - 360 + 97.5) * Math.PI) / 180;
    expect(rho * Math.sin(th) - x0).toBeCloseTo(0, 3);
    expect(rho0 - rho * Math.cos(th) - y0).toBeCloseTo(0, 3);
  });
});

describe('GOES fixed grid', () => {
  it('maps the sub-satellite point to scan angle (0, 0) and hides the far side', () => {
    const p = { h: 42164160, req: 6378137, rpol: 6356752.31414, lon0: -75, x0: 0, dx: 1, y0: 0, dy: 1 };
    const [x, y] = geosForward(p, 0, -75)!;
    expect(x).toBeCloseTo(0, 12); expect(y).toBeCloseTo(0, 12);
    expect(geosForward(p, 0, 105)).toBeNull();
    // PUG Vol. 3 worked example: 33.846162° N, 84.690932° W → x = −0.024052 rad, y = 0.095340 rad (GOES-16 at −75°).
    const [ex, ey] = geosForward(p, 33.846162, -84.690932)!;
    expect(ex).toBeCloseTo(-0.024052, 5); expect(ey).toBeCloseTo(0.09534, 5);
  });
});

describe('WPC coded surface bulletin', () => {
  it('parses centers, fronts and the valid time', () => {
    const a = parseCodsus('VALID 111509Z\nHIGHS 1030 4691 1017 33111\nLOWS 962 52138\nCOLD 48125 44124\n40125\nSTNRY 2894 2899', 2026, 10);
    expect(a.validMs).toBe(Date.UTC(2026, 10, 15, 9));
    expect(a.centers[0]).toEqual({ kind: 'H', mb: 1030, lon: -91, lat: 46 });
    expect(a.centers[1]).toEqual({ kind: 'H', mb: 1017, lon: -111, lat: 33 });
    expect(a.fronts[0].points).toEqual([[-125, 48], [-124, 44], [-125, 40]]);
    expect(a.fronts[1].type).toBe('STNRY');
  });
});

describe('timeline bracketing', () => {
  const f = [{ t: 0 }, { t: 100 }, { t: 1e9 }];
  it('returns the bracketing frames and the data-space weight', () => {
    expect(bracket(f, 25, true, 1000)).toEqual({ a: f[0], b: f[1], w: 0.25 });
    expect(bracket(f, 25, false, 1000)).toEqual({ a: f[0], b: null, w: 0 });
    expect(bracket(f, 500, true, 1000).b).toBeNull(); // gap too large
  });
});

describe('GIS helpers', () => {
  it('line sets round-trip and Douglas–Peucker removes collinear points', () => {
    const bin = encodeLineSet([{ cls: 2, value: 95, coords: Float64Array.of(0, 0, 1, 1) }, { cls: 0, value: -1, coords: Float64Array.of(5, 5, 6, 6, 7, 7) }]);
    const ls = decodeLineSet(bin.buffer as ArrayBuffer);
    expect(Array.from(ls.offsets)).toEqual([0, 2, 5]); expect(ls.cls[0]).toBe(2); expect(ls.value[1]).toBe(-1);
    expect(Array.from(simplify(Float64Array.of(0, 0, 1, 1, 2, 2, 3, 3), 0.01))).toEqual([0, 0, 3, 3]);
  });
  it('great-circle distance, bearing and destination are consistent', () => {
    const d = gcDistanceKm(-97.5, 35.3, -95.9, 36.15);
    expect(d).toBeGreaterThan(160); expect(d).toBeLessThan(175);
    const [lon, lat] = destination(-97.5, 35.3, bearingDeg(-97.5, 35.3, -95.9, 36.15), d);
    expect(lon).toBeCloseTo(-95.9, 6); expect(lat).toBeCloseTo(36.15, 6);
  });
});
