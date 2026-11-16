import { describe, it, expect } from 'vitest';
import { fixedGridMismatch } from '../src/layers/goes-manual';

const east = { h: 35786023, req: 6378137, rpol: 6356752.31414, lon0: -75, x0: -0.101332, dx: 5.6e-5, y0: 0.128212, dy: -5.6e-5 };
describe('GOES manual loader fixed grid', () => {
  it('accepts identical grids and names the differing parameters', () => {
    expect(fixedGridMismatch(east, { ...east })).toEqual([]);
    expect(fixedGridMismatch(east, { ...east, lon0: -137 })).toEqual(['lon0 -137 ≠ -75']);
    expect(fixedGridMismatch(east, { ...east, x0: -0.15, y0: 0.1 }).map((s) => s.split(' ')[0])).toEqual(['x0', 'y0']);
  });
});
