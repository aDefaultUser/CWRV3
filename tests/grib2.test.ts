// GRIB2 decoder against ecCodes reference values on a pinned public message (tests/fixtures/grib/expected.json).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { decodeGrib2, scanGribMessages, type GribField } from '../src/decode/grib2';
import { contourLines, unitConv } from '../src/workers/grid-tasks';
import { gridMap } from '../src/gis/gridproj';

const expected = JSON.parse(readFileSync('tests/fixtures/grib/expected.json', 'utf8'));
const inflate = async (b: Uint8Array) => new Uint8Array(inflateSync(b));

describe('GRIB2 JPEG 2000 (5.40) on RAP awp130 CAPE', () => {
  const e = expected['rap-cape-surface'];
  const bytes = new Uint8Array(readFileSync('tests/fixtures/grib/rap-cape-surface.grib2'));
  it('fixture matches its recorded SHA-256', () => { expect(createHash('sha256').update(bytes).digest('hex')).toBe(e.sha256); });
  it('decodes the same values as ecCodes', async () => {
    const [f] = await decodeGrib2(bytes, inflate);
    expect(f.drt).toBe(40);
    expect(f.grid.kind).toBe('lambert');
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const v of f.values) { mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; }
    expect(mn).toBe(e.min); expect(mx).toBe(e.max);
    expect(sum / f.values.length).toBeCloseTo(e.mean, 6);
    for (const [k, v] of Object.entries(e.samples)) expect(f.values[Number(k)], k).toBeCloseTo(v as number, 4);
  });
  it('geolocates grid points like ecCodes (grid definition, no projection file)', async () => {
    const [f] = await decodeGrib2(bytes, inflate);
    const m = gridMap(f.grid);
    for (const [k, [lon, lat]] of Object.entries(e.lonLat as Record<string, [number, number]>)) {
      const i = Number(k) % e.nx, j = Math.floor(Number(k) / e.nx);
      const [lo, la] = m.inv(i, j);
      expect(((lo - lon + 540) % 360) - 180, k).toBeCloseTo(0, 2);
      expect(la, k).toBeCloseTo(lat, 2);
      const [fi, fj] = m.fwd(lo, la);
      expect(fi).toBeCloseTo(i, 6); expect(fj).toBeCloseTo(j, 6);
    }
  });
});

describe('grid projections round-trip', () => {
  it('polar stereographic and Mercator inverse/forward agree', () => {
    const polar = gridMap({ kind: 'polar', nx: 1649, ny: 1105, la1: 40.53, lo1: 181.43, lad: 60, lov: 210, dx: 2976.56, dy: 2976.56, south: false, scan: 64, radius: 6371200 });
    const merc = gridMap({ kind: 'mercator', nx: 321, ny: 225, la1: 18.07, lo1: 198.48, la2: 23.09, lo2: 206.13, lad: 20, di: 2500, dj: 2500, scan: 64, radius: 6371200 });
    for (const m of [polar, merc]) for (const [i, j] of [[0, 0], [100, 50], [m.nx - 1, m.ny - 1]]) {
      const [lo, la] = m.inv(i, j); const [fi, fj] = m.fwd(lo, la);
      expect(fi).toBeCloseTo(i, 5); expect(fj).toBeCloseTo(j, 5);
    }
    expect(polar.inv(0, 0)[1]).toBeCloseTo(40.53, 6);
    expect(merc.inv(0, 0)[1]).toBeCloseTo(18.07, 6);
  });
});

describe('malformed GRIB2 input is bounded', () => {
  const good = new Uint8Array(readFileSync('tests/fixtures/grib/rap-cape-surface.grib2'));
  const header = (len: bigint) => { const b = new Uint8Array(24); b.set([0x47, 0x52, 0x49, 0x42, 0, 0, 0, 2]); new DataView(b.buffer).setBigUint64(8, len); return b; };
  const join = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  it('skips zero, short and past-the-end message lengths and keeps the valid message', async () => {
    const buf = join(header(0n), header(5n), header(1n << 40n), good, header(64n));
    expect(scanGribMessages(buf)).toEqual([{ offset: 72, length: good.length }]);
    const fields = await decodeGrib2(buf, inflate);
    expect(fields).toHaveLength(1);
  });
  it('rejects a zero-length section instead of looping', async () => {
    const bad = good.slice();
    new DataView(bad.buffer).setUint32(16, 0); // section 1 length
    await expect(decodeGrib2(bad, inflate)).rejects.toThrow(/bad section length/);
  });
});

describe('model contours use converted physical values', () => {
  it('K → °F keeps the affine offset (32 °F isotherm sits at 273.15 K)', () => {
    const f = { discipline: 0, category: 0, number: 0, grid: { kind: 'latlon', ni: 3, nj: 1, la1: 40, lo1: -100, la2: 40, lo2: -98, di: 1, dj: 1, scan: 64 }, values: new Float32Array([263.15, 273.15, 283.15]) } as unknown as GribField;
    const conv = unitConv('°F', f)!;
    expect(conv(273.15)).toBeCloseTo(32, 6);
    // 5×3 grid, 263.15 K … 283.15 K west to east (14 … 50 °F).
    const row = [263.15, 268.15, 273.15, 278.15, 283.15];
    const g = { ...f, grid: { ...f.grid, ni: 5, nj: 3, lo2: -96, la2: 42 }, values: new Float32Array([...row, ...row, ...row]) } as unknown as GribField;
    const lines = contourLines(g, 18, conv);
    const levels = [...new Set(lines.map((l) => l.level))];
    expect(levels).toContain(36); // 14..50 °F range → 18 °F interval levels 18 and 36
    const at36 = lines.find((l) => l.level === 36)!;
    // 36 °F = 275.37 K → between columns 2 (273.15 K, −98°) and 3 (278.15 K, −97°)
    expect(at36.coords[0]).toBeCloseTo(-98 + (275.372 - 273.15) / 5, 2);
    // A scale-only conversion (the old behaviour) would contour 1.8·K, i.e. the 486..510 range.
    expect(contourLines(g, 18, 1.8).every((l) => l.level > 400)).toBe(true);
  });
});
