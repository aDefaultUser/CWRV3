// Level 2 derived products on hand-built inputs with hand-computed expectations.
import { describe, expect, it } from 'vitest';
import {
  roundEven, dealiasRadial, dealias2D, stormRelative, median3x3, gateToGate, azimuthalShear, kdp, volumetric, beamHeightKm,
  type BuilderSweep, type Codes8,
} from '../src/radar/l2products';

const codes8 = (gates: number, codes: number[]): Codes8 => ({ gates, firstKm: 2.125, gateKm: 0.25, codes: Uint8Array.from(codes) });
function sweep(radials: number, gates: number, fill: (i: number, g: number) => number, opts: Partial<BuilderSweep> = {}): BuilderSweep {
  const c = new Uint8Array(radials * gates);
  for (let i = 0; i < radials; i++) for (let g = 0; g < gates; g++) c[i * gates + g] = fill(i, g);
  const az = new Float32Array(radials);
  for (let i = 0; i < radials; i++) az[i] = (i * 360) / radials;
  return { elevation: 0.5, radials, azimuths: az, half: radials >= 720, vn: 40, complete: true, vel: { gates, firstKm: 2.125, gateKm: 0.25, codes: c }, splitCutDoppler: false, supplemental: false, ...opts };
}

describe('rounding', () => {
  it('rounds half to even like the x87 default', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(roundEven)).toEqual([0, 2, 2, -0, -2, 2, 3]);
  });
});

describe('radial-continuity dealiasing', () => {
  it('unfolds a single fold by one 2·Vn step and keeps the raw-vs-corrected history asymmetry', () => {
    // 1° sweep: W = 10, T = Vn / 1.2. Vn = 20 code units → T = 16.67.
    const vn = 20;
    const raw = [129 + 15, 129 + 17, 129 + 18, 129 - 19]; // last gate folded (true value +21)
    const out = dealiasRadial(codes8(4, raw), 1, false, vn);
    expect(Array.from(out)).toEqual([144, 146, 147, 150]); // 110 + 40 = 150 (v = +21)
  });
  it('passes codes 0 and 1 through without touching the history', () => {
    const out = dealiasRadial(codes8(5, [129, 0, 1, 130, 131]), 1, false, 20);
    expect(Array.from(out)).toEqual([129, 0, 1, 130, 131]);
  });
  it('uses the corrected value in the history only once the window is full (W = 10 for 1° sweeps)', () => {
    // 10 gates fill the window with raw values near +18; gate 10 folds to −19 (true +21) and is corrected to 150;
    // gate 11 (+20 raw) then compares against a mean that includes the corrected 150.
    const g = [...Array(10).fill(147), 129 - 19, 149];
    const out = dealiasRadial(codes8(12, g), 1, false, 20);
    expect(out[10]).toBe(150);
    expect(out[11]).toBe(149);
  });
  it('clamps corrected codes into [2, 255]', () => {
    const out = dealiasRadial(codes8(2, [250, 130]), 1, false, 70); // 130 − 250 < −T → 130 + 140 = 270 → 255
    expect(out[1]).toBe(255);
  });
});

describe('two-dimensional dealiasing', () => {
  it('returns null (codes stay raw) when no smooth radial has a positive mean', () => {
    const s = sweep(360, 50, () => 129 - 5);
    expect(dealias2D(s.vel!, 360, false, 40)).toBeNull();
  });
  it('unfolds a folded patch next to a smooth wind field in one ±2·Vn step', () => {
    // Uniform +10 wind (code 139) with a patch whose true velocity is +45 > Vn = 40 (folded to 45 − 80 = −35, code 94).
    const truth = (i: number, g: number) => (i >= 100 && i < 110 && g >= 20 && g < 30 ? 45 : 10);
    const s = sweep(360, 60, (i, g) => { const v = truth(i, g); return (v > 40 ? v - 80 : v) + 129; });
    const out = dealias2D(s.vel!, 360, false, 40)!;
    expect(out).not.toBeNull();
    let wrong = 0;
    for (let i = 0; i < 360; i++) for (let g = 0; g < 60; g++) if (out[i * 60 + g] !== truth(i, g) + 129) wrong++;
    expect(wrong).toBe(0);
  });
});

describe('storm-relative velocity', () => {
  it('adds S·cos(az − D) in code units (knots used as code units)', () => {
    const s = sweep(4, 1, () => 129);
    s.azimuths = Float32Array.from([0, 90, 180, 270]);
    const out = stormRelative(s.vel!.codes, s, 30, 270); // storm from the west
    expect(Array.from(out)).toEqual([129, 99, 129, 159]);
  });
});

describe('shear', () => {
  it('median filter treats invalid cells as 0 and only fills gates 3 … n−2', () => {
    const N = 3, n = 8, c = new Uint8Array(N * n).fill(140);
    c[1 * n + 4] = 0; c[0 * n + 4] = 0; c[2 * n + 4] = 0; c[1 * n + 3] = 0; c[1 * n + 5] = 0;
    const M = median3x3(c, N, n);
    expect(M[1 * n + 2]).toBe(0);
    expect(M[1 * n + 4]).toBe(0); // five zeros + four 140 → median 0
    c[1 * n + 5] = 140;
    expect(median3x3(c, N, n)[1 * n + 4]).toBe(140); // four zeros + five 140 → median 140
  });
  it('gate-to-gate is half the median difference between adjacent radials, coded value + 127', () => {
    const s = sweep(10, 30, (i) => (i === 5 ? 160 : 140));
    const out = gateToGate(s.vel!.codes, s);
    // Radial 4 → 5: (160 − 140) / 2 = 10; value = 2·G = 20; code = 147. Medians smear the step across radials 4..6.
    expect(out[4 * 30 + 10]).toBe(127 + 2 * ((140 - 140) / 2));
    expect(out[5 * 30 + 10]).toBe(127);
    expect(out[0 * 30 + 3]).toBe(127); // gates < 7: no result → value 0 → code 127
  });
  it('azimuthal shear needs at least 15 valid samples', () => {
    const s = sweep(20, 40, (i, g) => (g >= 12 && g <= 14 ? 0 : 129 + (i >= 10 ? 10 : -10)));
    const out = azimuthalShear(s.vel!.codes, s);
    // Gate 16 samples gates 13, 19, 14, 18 (c = 1); the median is 0 at gates 13 and 14 → k = 8 < 15 → value 0.
    expect(out[10 * 40 + 16]).toBe(roundEven(((0 + 40) * 255) / 80));
  });
  it('masks shear where reflectivity is below code 45 when the radial has enough reflectivity gates', () => {
    const s = sweep(20, 40, (i) => 129 + (i >= 10 ? 10 : -10));
    s.ref = codes8(40, Array(20 * 40).fill(30));
    const out = gateToGate(s.vel!.codes, s);
    expect(out[9 * 40 + 20]).toBe(127);
  });
});

describe('KDP', () => {
  it('computes a constant phase slope: K = Δw′ per gate → ° per gate, doubled for 0.5° sweeps', () => {
    const n = 40, step = 182; // ≈ 1° of phase per gate in w′ units (65533 / 360)
    const phi = new Uint16Array(n).map((_, g) => 1000 + g * step);
    const s: BuilderSweep = { elevation: 0.5, radials: 1, azimuths: Float32Array.of(0), half: false, vn: 40, complete: false, splitCutDoppler: false, supplemental: false,
      phi: { gates: n, firstKm: 2.125, gateKm: 0.25, codes: phi }, ref: codes8(n, Array(n).fill(80)) };
    const out = kdp(s)!;
    const kdpVal = (step * 360) / 65535; // ≈ 1.0
    expect(out[15]).toBe(roundEven(((kdpVal + 2) / 11) * 255));
    expect(out[2]).toBe(46); // edge gate: no result → KDP 0 → code 46
    const half = kdp({ ...s, half: true })!;
    expect(half[15]).toBe(roundEven(((2 * kdpVal + 2) / 11) * 255));
  });
  it('skips gates whose reflectivity code is ≤ 50', () => {
    const n = 40, phi = new Uint16Array(n).map((_, g) => 1000 + g * 182);
    const s: BuilderSweep = { elevation: 0.5, radials: 1, azimuths: Float32Array.of(0), half: false, vn: 40, complete: false, splitCutDoppler: false, supplemental: false,
      phi: { gates: n, firstKm: 2.125, gateKm: 0.25, codes: phi }, ref: codes8(n, Array(n).fill(50)) };
    expect(kdp(s)![15]).toBe(46);
  });
});

describe('volumetric products', () => {
  // Three 1° sweeps at 0.5/1.5/2.5° with uniform reflectivity: closed-form VIL and echo tops.
  function volume(dbz: number[]): BuilderSweep[] {
    return [0.5, 1.5, 2.5].map((el, k) => ({
      elevation: el, radials: 360, azimuths: Float32Array.from({ length: 360 }, (_, i) => i), half: false, vn: 40, complete: true, splitCutDoppler: false, supplemental: false,
      ref: { gates: 400, firstKm: 2.125, gateKm: 0.25, codes: new Uint8Array(360 * 400).fill(dbz[k] + 31) },
    }));
  }
  it('VIL integrates 0.00344·10^(4·min(Z,56)/70)·Δh over gates with Z > 18', () => {
    const p = { hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 4000, hm20Custom: 6000, envIsotherms: null, etThreshold: 18.5, gust1991: true };
    const g = volume([40, 40, 40]);
    const out = volumetric(13, g, p)!;
    // Output gate og takes max of source gates 2og, 2og+1; at source gate 201 (rG = 50.25 km):
    const rG = 201 / 4, rad = Math.PI / 180, thm = 1 * rad;
    const dh = [rG * Math.tan(thm) + (rG * rG) / (16989.33 * Math.cos(thm) ** 2), 0.5 * rG * (Math.tan(2.5 * rad) - Math.tan(0.5 * rad)), 0.5 * rG * (Math.tan(3.0 * rad) - Math.tan(1.5 * rad))];
    const vil = dh.reduce((s, h) => s + 0.00344 * 10 ** ((4 * 40) / 70) * h, 0);
    expect(out.codes[0 * out.gates + 100]).toBe(roundEven((Math.min(vil, 80) / 80) * 255));
  });
  it('echo top = height of the highest beam with Z ≥ threshold, snapped to 1,000 ft', () => {
    const p = { hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 4000, hm20Custom: 6000, envIsotherms: null, etThreshold: 18.5, gust1991: true };
    const out = volumetric(15, volume([30, 30, 10]), p)!;
    const r = 2.125 + 201 / 4;
    const h = beamHeightKm(r, 1.5) * 1000;
    const etM = Math.round(h / 304.8) * 304.8;
    expect(out.codes[100]).toBe(roundEven((etM / 21000) * 255));
  });
  it('needs at least three increasing sweeps', () => {
    const p = { hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 4000, hm20Custom: 6000, envIsotherms: null, etThreshold: 18.5, gust1991: true };
    expect(volumetric(13, volume([40, 40, 40]).slice(0, 2), p)).toBeNull();
  });
  it('MEHS/POSH follow SHI = 0.1·Σ W_T·Ė·Δh with inverted thresholds reset to 40/50', () => {
    const p = { hailZLower: 55, hailZUpper: 45, isothermAuto: false, h0Custom: 200, hm20Custom: 400, envIsotherms: null, etThreshold: 18.5, gust1991: true };
    const out = volumetric(11, volume([60, 60, 60]), p)!;
    // Output gate 150 = max of source gates 300/301; at 301 every beam is above H₋₂₀ (W_T = 1) and Z ≥ Z_U (W = 1).
    const og = 150, r = 2.125 + 301 / 4;
    const hM = [0.5, 1.5, 2.5].map((e) => beamHeightKm(r, e) * 1000);
    expect(hM[0]).toBeGreaterThan(400);
    const E = 5e-6 * 10 ** (0.084 * 60);
    const dh = [hM[0] <= 200 ? hM[1] - hM[0] : (hM[0] + hM[1]) / 2 - 200, (hM[2] - hM[0]) / 2, hM[2] - hM[1]];
    const shi = 0.1 * dh.reduce((s, h) => s + E * h, 0);
    const mehs = Math.min(7, 2.54 * Math.sqrt(shi) * 0.0393701);
    expect(out.codes[og]).toBe(roundEven((mehs / 7) * 255));
  });
});
