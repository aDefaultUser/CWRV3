// Direct polar sampler: closed-form inverse geometry, tilt choice and blending, empty regions and reserved codes.
import { describe, expect, it } from 'vitest';
import { beamHeightKm } from '../src/radar/l2products';
import { beamThrough, groundRangeKm, slantRangeKm, tiltHeightKm, tiltCode, sampleVolume, stormRelativeCode, azimuthBin, type SampleVolume } from '../src/radar/volume-sample';
import { sectionPoint } from '../src/render/volume';

const WIDTH = 400, ROWS = 722;
/** A volume of uniform tilts (code per tilt), 0.25 km gates from 2.125 km. */
function volume(elevations: number[], codes: number[], moment: SampleVolume['moment'] = 'REF'): SampleVolume {
  return {
    moment, width: WIDTH,
    tilts: elevations.map((elevation) => ({ elevation, firstKm: 2.125, gateKm: 0.25, gates: WIDTH })),
    layers: codes.map((c) => new Uint8Array(ROWS * WIDTH).fill(c)),
  };
}
/** Samples at ground range `s` on the beam of elevation `el`. */
const at = (v: SampleVolume, el: number, s = 40, az = 123.4) => sampleVolume(v, az, s, tiltHeightKm(s, el));

describe('beam geometry', () => {
  it('inverts ground range and height to slant range and elevation within a metre', () => {
    for (const r of [0.5, 5, 50, 150, 300, 460]) for (const el of [-0.2, 0.5, 2.4, 6.4, 10, 19.5]) {
      const s = groundRangeKm(r, el), h = beamHeightKm(r, el), b = beamThrough(s, h);
      expect(Math.abs(b.rangeKm - r)).toBeLessThan(1e-3);
      expect(Math.abs(beamHeightKm(b.rangeKm, b.elevation) - h)).toBeLessThan(1e-3);
      expect(Math.abs(groundRangeKm(b.rangeKm, b.elevation) - s)).toBeLessThan(1e-3);
      expect(Math.abs(b.elevation - el)).toBeLessThan(1e-6);
    }
  });
  it('uses the radar shader slant range: KE·sin(φ) / cos(el + φ)', () => {
    const s = 120, el = 1.5, phi = s / 8494.666;
    expect(slantRangeKm(s, el)).toBeCloseTo((8494.666 * Math.sin(phi)) / Math.cos((el * Math.PI) / 180 + phi), 12);
    expect(groundRangeKm(slantRangeKm(s, el), el)).toBeCloseTo(s, 9);
  });
});

describe('volume sampler', () => {
  it('finds a point target at beamHeightKm of its gate and nowhere else', () => {
    const v = volume([0.5, 1.5, 2.5], [0, 0, 0]);
    const gate = 180, bin = 431, r = 2.125 + gate * 0.25, el = 1.5;
    v.layers[1][(bin + 1) * WIDTH + gate] = 200;
    const s = groundRangeKm(r, el), h = beamHeightKm(r, el), az = 0.25 + bin / 2;
    expect(azimuthBin(az)).toBe(bin);
    expect(sampleVolume(v, az, s, h)).toBe(200);
    expect(sampleVolume(v, az + 0.2, s + 0.1, h + 0.3)).toBe(200); // same bin and gate, still within half a beamwidth
    expect(sampleVolume(v, az + 0.5, s, h)).toBe(0);               // next azimuth bin
    expect(sampleVolume(v, az, s + 0.25, h)).toBe(0);              // next gate
    expect(sampleVolume(v, az, s, beamHeightKm(r, 0.5))).toBe(0);  // the tilt below
    expect(tiltCode(v, 1, az, s)).toBe(200);
  });
  it('uses a tilt alone within half a beamwidth and blends linearly between the half-beam zones', () => {
    const v = volume([0.5, 1.5, 3.0], [50, 100, 200]);
    expect(at(v, 0.5)).toBe(50);
    expect(at(v, 0.99)).toBe(50);   // tilts 1° apart meet with no blended span
    expect(at(v, 1.01)).toBe(100);
    expect(at(v, 1.99)).toBe(100);  // 1.5° → 3.0°: alone up to 2.0°, blended 2.0°–2.5°, alone from 2.5°
    expect(at(v, 2.25)).toBeCloseTo(150, 3);
    expect(at(v, 2.1)).toBeCloseTo(120, 3);
    expect(at(v, 2.51)).toBe(200);
    expect(at(v, 3.4)).toBe(200);
  });
  it('leaves the region below the lowest tilt, the cone of silence and gaps over two beamwidths empty', () => {
    const v = volume([0.5, 1.5, 3.0, 6.0], [50, 100, 200, 250]);
    expect(at(v, -0.1)).toBe(0);
    expect(at(v, 0.01)).toBe(50);
    expect(at(v, 3.49)).toBe(200);
    expect(at(v, 3.6)).toBe(0);  // 3.0° → 6.0° is 3° apart: not bridged
    expect(at(v, 5.4)).toBe(0);
    expect(at(v, 5.6)).toBe(250);
    expect(at(v, 6.6)).toBe(0);  // above the highest tilt
    expect(at(v, 1.5, 150)).toBe(0); // beyond the last gate (102 km)
    expect(at(v, 1.5, 0)).toBe(0);
  });
  it('never blends with or returns the reserved codes 0 and 1', () => {
    for (const reserved of [0, 1]) {
      const v = volume([1.5, 3.0], [reserved, 200]);
      expect(at(v, 1.6)).toBe(0);    // the tilt itself has no value
      expect(at(v, 2.25)).toBe(0);   // not 100.5: one side is missing
      expect(at(v, 2.49)).toBe(0);
      expect(at(v, 2.6)).toBe(200);
      expect(at(volume([1.5, 3.0], [200, reserved]), 2.25)).toBe(0);
    }
  });
  it('takes the nearer tilt for velocity instead of blending', () => {
    const v = volume([1.5, 3.0], [100, 200], 'VEL');
    expect(at(v, 2.2)).toBe(100);
    expect(at(v, 2.3)).toBe(200);
    expect(at(volume([1.5, 3.0], [1, 200], 'VEL'), 2.2)).toBe(0); // range folded stays empty
  });
  it('reads each tilt over the same ground point, at its own slant range and gate size', () => {
    const v = volume([0.5, 4.0], [0, 0]);
    v.tilts[1] = { elevation: 4.0, firstKm: 1, gateKm: 1, gates: 100 };
    const s = 60, g = Math.floor(slantRangeKm(s, 4.0) - 1 + 0.5);
    v.layers[1].fill(0); v.layers[1][(azimuthBin(10) + 1) * WIDTH + g] = 77;
    expect(sampleVolume(v, 10, s, tiltHeightKm(s, 4.0))).toBe(77);
    expect(slantRangeKm(s, 4.0)).toBeGreaterThan(slantRangeKm(s, 0.5));
  });
});

describe('storm-relative velocity code', () => {
  it('adds the motion component along the azimuth and keeps the reserved codes', () => {
    expect(stormRelativeCode(129, 270, 30, 270)).toBe(159);
    expect(stormRelativeCode(129, 90, 30, 270)).toBe(99);
    expect(stormRelativeCode(129, 0, 30, 270)).toBeCloseTo(129, 9);
    expect(stormRelativeCode(250, 270, 30, 270)).toBe(255);
    expect(stormRelativeCode(0, 270, 30, 270)).toBe(0);
    expect(stormRelativeCode(1, 270, 30, 270)).toBe(1);
  });
});

describe('section pixels', () => {
  it('map to azimuth, ground range and height along the line, row 0 lowest', () => {
    const line = { a: [0, 0] as [number, number], b: [100, 100] as [number, number], topKm: 20 };
    const p = sectionPoint(line, 49, 0, 100, 40);
    expect(p.az).toBeCloseTo(45, 9);
    expect(p.s).toBeCloseTo(Math.hypot(49.5, 49.5), 9);
    expect(p.h).toBeCloseTo(0.25, 9);
    expect(sectionPoint({ a: [-10, 0], b: [-20, 0], topKm: 20 }, 0, 39, 10, 40).az).toBeCloseTo(270, 9);
  });
});
