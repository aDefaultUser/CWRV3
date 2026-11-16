// 16-bit sweep upload precision (static review finding): words survive exactly, incl. reserved codes 0/1.
import { describe, it, expect } from 'vitest';
import { padSweep } from '../src/radar/sweep-pad';
import { toHalf } from '../src/render/gpu';

describe('padSweep', () => {
  it('keeps every 16-bit word exactly (float32 = word / 65535)', () => {
    const radials = 3, gates = 4;
    const codes = Uint16Array.from([0, 1, 2, 3, 255, 256, 257, 4095, 32767, 32768, 65534, 65535]);
    const out = padSweep(codes, radials, gates, true, 16) as Float32Array;
    expect(out.length).toBe((radials + 2) * gates);
    for (let i = 0; i < codes.length; i++) expect(Math.round(out[gates + i] * 65535)).toBe(codes[i]);
    // distinct words map to distinct texel values
    expect(new Set(out.slice(gates, gates + codes.length)).size).toBe(codes.length);
  });
  it('pads complete sweeps with wrap rows and partial sweeps with clamp rows', () => {
    const codes = Uint8Array.from([1, 1, 2, 2, 3, 3]);
    expect([...padSweep(codes, 3, 2, true, 8)]).toEqual([3, 3, 1, 1, 2, 2, 3, 3, 1, 1]);
    expect([...padSweep(codes, 3, 2, false, 8)]).toEqual([1, 1, 1, 1, 2, 2, 3, 3, 3, 3]);
  });
});

describe('toHalf (r16float fallback)', () => {
  it('keeps small values as subnormals instead of flushing them to zero', () => {
    const h = toHalf(Float32Array.from([1 / 65535, 2 / 65535, 0, 1, 0.5]));
    expect(h[0]).toBeGreaterThan(0);
    expect(h[1]).toBeGreaterThan(h[0]);
    expect(h[2]).toBe(0);
    expect(h[3]).toBe(0x3c00);
    expect(h[4]).toBe(0x3800);
  });
});
