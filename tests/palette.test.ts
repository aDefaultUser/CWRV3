// Palette color evaluation, lookup bake with reserved codes, and legend ticks.
import { describe, expect, it } from 'vitest';
import { parsePalette, evalPalette, bakeLut, legendTicks, formatTick, RANGE_FOLDED, LUT_WIDTH, type Stop } from '../src/render/palette';

describe('palette parsing and evaluation', () => {
  const p = parsePalette(`Test
0,0,0,255;100,100,100,255|0|
200,0,0,255;0,0,200,255|10
50,50,50,255|20
@900|0
1,1,1,255|0
2,2,2,255|20`);
  it('parses frames, own-ramp flags, single colors and the flash header', () => {
    expect(p.frames.length).toBe(2);
    expect(p.flashMs).toBe(900);
    expect(p.flag).toBe(false);
    expect(p.frames[0].map((s) => s.own)).toEqual([true, false, false]);
    expect(p.frames[0][2].b).toEqual([50, 50, 50, 255]);
  });
  it('own-ramp set: ramps from the stop’s first to its second color', () => {
    expect(evalPalette(p.frames[0], 5)).toEqual([50, 50, 50, 255]);
  });
  it('own-ramp clear: ramps from the stop’s second color to the next stop’s first color', () => {
    expect(evalPalette(p.frames[0], 15)).toEqual([25, 25, 125, 255]);
  });
  it('below the first stop → first color; at/above the last → last first color', () => {
    expect(evalPalette(p.frames[0], -5)).toEqual([0, 0, 0, 255]);
    expect(evalPalette(p.frames[0], 99)).toEqual([50, 50, 50, 255]);
  });
  it('stepped mode returns the segment’s first color', () => {
    expect(evalPalette(p.frames[0], 15, true)).toEqual([200, 0, 0, 255]);
  });
  it('rejects a missing name; skips short lines; defaults flash interval to 400 ms', () => {
    expect(() => parsePalette('\n0,0,0|1')).toThrow(/name/);
    expect(parsePalette('N\nbad\n1,2,3|0\n@x|1\n4,5,6|1').flashMs).toBe(400);
  });
  it('equal-value stops form an empty segment (a jump)', () => {
    const q = parsePalette('J\n0,0,0,255|0\n10,10,10,255;10,10,10,255|5\n200,200,200,255|5\n255,255,255,255|10');
    expect(evalPalette(q.frames[0], 4.99)[0]).toBeLessThan(15);
    expect(evalPalette(q.frames[0], 5)[0]).toBe(200);
  });
});

describe('lookup bake', () => {
  const p = parsePalette('L\n0,0,0,0|-10\n255,255,255,255|10');
  it('maps texel i to low + (high−low)·i/1023 and bakes one row per frame', () => {
    const lut = bakeLut(p, { low: -10, high: 10 });
    expect(lut.length).toBe(LUT_WIDTH * 4);
    const mid = 512 * 4;
    expect(lut[mid]).toBeGreaterThan(120);
    expect(lut[mid]).toBeLessThan(135);
  });
  it('reserve products: texel 0 transparent, code-1 texels range-folded, code 2 ↔ low', () => {
    const lut = bakeLut(p, { low: -10, high: 10, reserve: true, showRF: true });
    expect(Array.from(lut.slice(0, 4))).toEqual([0, 0, 0, 0]);
    const t1 = Math.round((1 / 255) * 1023);
    expect(Array.from(lut.slice(t1 * 4, t1 * 4 + 4))).toEqual(RANGE_FOLDED);
    const noRF = bakeLut(p, { low: -10, high: 10, reserve: true, showRF: false });
    expect(noRF[t1 * 4 + 3]).toBe(0);
  });
  it('general raster bake: at or below the first stop is transparent unless filled', () => {
    const lut = bakeLut(parsePalette('R\n10,20,30,255|0\n255,255,255,255|10'), { low: -5, high: 10, raster: true });
    expect(lut[3]).toBe(0);
    const filled = bakeLut(parsePalette('R\n10,20,30,255|0\n255,255,255,255|10'), { low: -5, high: 10, raster: true, fillBelow: true });
    expect(filled[3]).toBe(255);
  });
});

describe('legend ticks', () => {
  const measure = (s: string, small: boolean) => s.length * (small ? 5 : 7);
  const stopsPal = (vals: number[]) => ({ name: 'T', flashMs: 400, flag: true, frames: [vals.map((v): Stop => ({ v, a: [0, 0, 0, 255], b: [0, 0, 0, 255], own: false }))] });
  it('uses the palette range and one tick per stop when it lies inside the display range', () => {
    const t = legendTicks(stopsPal([0, 10, 20]), -50, 50, 1000, measure);
    expect(t.map((x) => x.value)).toEqual([0, 10, 20]);
    expect(t[1].x).toBe(500);
  });
  it('clips to the display range with ticks at low/high for straddling stops', () => {
    const t = legendTicks(stopsPal([-100, 0, 100]), -50, 50, 1000, measure);
    expect(t.map((x) => x.value)).toEqual([-50, 0, 50]);
  });
  it('formats labels: 0.# below 10, two-digit integers otherwise, small style below 0.1', () => {
    expect(formatTick(7.5, 7.5)).toEqual({ text: '7.5', small: false });
    expect(formatTick(5, 5)).toEqual({ text: '5', small: false });
    expect(formatTick(35, 35)).toEqual({ text: '35', small: false });
    expect(formatTick(0.05, 0.05)).toEqual({ text: '0.05', small: true });
  });
  it('raises crowded labels, right-aligns the last tick and hides earlier overlapping ones', () => {
    const t = legendTicks(stopsPal([0, 1, 2, 3, 100]), 0, 100, 200, measure);
    expect(t.some((x) => x.raised)).toBe(true);
    expect(t[t.length - 1].alignRight).toBe(true);
  });
});

