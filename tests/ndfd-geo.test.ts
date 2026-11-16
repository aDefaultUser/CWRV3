// NDFD grids (Lambert CONUS sector, polar-stereographic Alaska; public NOAA tgftp ST.opnl files of 2026-11-15)
// decoded and geolocated against ecCodes corner coordinates and values.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { decodeGrib2 } from '../src/decode/grib2';
import { gridMap } from '../src/gis/gridproj';

const D = 'tests/fixtures/ndfd/';
const cases: [string, number, number, [number, number][]][] = [
  ['ndfd-midatlan-maxt.bin', 194, 200, [[-85.794, 31.39], [-75.627, 30.467], [-85.016, 40.28], [-74.008, 39.309]]],
  ['ndfd-alaska-maxt.bin', 1649, 1105, [[-178.571, 40.53], [-124.58, 41.74], [150.191, 61.4], [-93.689, 63.976]]],
];
describe('NDFD geolocation vs ecCodes', () => {
  const values: Record<string, Record<string, number | null>> = {
    // ecCodes `values` are in storage order and its iterator ignores alternative row scanning, so the reference
    // values here are ecCodes values with every second row reversed (scanning mode 0x50), i.e. geographic order.
    'ndfd-midatlan-maxt.bin': { 0: 289.3, 1940: 288.7, 11640: 289.8, 13580: 285.4, 15520: 286.5, 17460: 284.8, 18430: 285.4, 19400: 285.4, 199: 289.3, 589: 288.7, 389: 288.7, 777: 288.1 },
    'ndfd-alaska-maxt.bin': { 637742: 283.7, 683295: 278.7, 774401: null, 911060: 263.1, 1138825: 268.1, 1275484: 268.1, 1639908: 260.9, 1654: null, 4954: null },
  };
  for (const [file, nx, ny, corners] of cases) it(file, async () => {
    const [f] = await decodeGrib2(new Uint8Array(readFileSync(D + file)), async (b) => new Uint8Array(inflateSync(b)));
    const m = gridMap(f.grid);
    expect([m.nx, m.ny]).toEqual([nx, ny]);
    // null = bitmap-masked.
    for (const [k, v] of Object.entries(values[file])) { if (v === null) expect(f.values[Number(k)], `${file}[${k}]`).toBeNaN(); else expect(f.values[Number(k)], `${file}[${k}]`).toBeCloseTo(v, 2); }
    // Physical check independent of any reference tool: a temperature field is smooth between adjacent rows.
    let d = 0, n = 0;
    for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) { const a = f.values[j * nx + i], b = f.values[(j - 1) * nx + i]; if (a === a && b === b) { d += Math.abs(a - b); n++; } }
    expect(d / n, `${file} mean row-to-row difference (K)`).toBeLessThan(1);
    [[0, 0], [nx - 1, 0], [0, ny - 1], [nx - 1, ny - 1]].forEach(([i, j], k) => {
      const [lo, la] = m.inv(i, j);
      expect(((lo - corners[k][0] + 540) % 360) - 180, `${file} corner ${k} lon`).toBeCloseTo(0, 2);
      expect(la, `${file} corner ${k} lat`).toBeCloseTo(corners[k][1], 2);
    });
  });
});
