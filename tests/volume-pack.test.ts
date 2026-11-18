// Volume packs and the column-max products: azimuth frame, tilt selection across split / SAILS / missing / 1° cuts,
// pack images, and products 17–19 against hand computations.
import { describe, expect, it } from 'vitest';
import { writeArchive2, splitSailsVolume, concat } from './helpers/archive2-writer';
import { decodeArchive2 } from '../src/decode/archive2';
import {
  recodeVolume, radialOfBin, tiltRows, dealias, kdp, volumetric, beamHeightKm, algorithmKey, usesIsotherms, isothermHeights, columnNote,
  COLUMN_RANGE, VOLUME_MOMENTS, type BuilderSweep,
} from '../src/radar/l2products';
import { volumeTilts, buildVolumePack, PACK_ROWS } from '../src/radar/volume-pack';
import { PRODUCTS } from '../src/generated/products-catalog';
import { SETTINGS } from '../src/generated/settings-catalog';
import { L2_PALETTE_KEYS, l2Moment } from '../src/radar/sources';
import { L2_MENU_INDEX } from '../src/ui/menus';

const volume = decodeArchive2(concat(writeArchive2(splitSailsVolume())));
const sweeps = recodeVolume(volume);

describe('azimuth frame', () => {
  it('maps half-degree radials one to one and lets a 1° radial fill two bins', () => {
    const half = Float32Array.from({ length: 720 }, (_, i) => (123.3 + i * 0.5) % 360);
    const m = radialOfBin(half, 720, true);
    for (let b = 0; b < 720; b++) expect(Math.abs((((half[m[b]] - (0.25 + b / 2)) % 360) + 540) % 360 - 180)).toBeLessThanOrEqual(0.25 + 1e-4);
    expect(new Set(m).size).toBe(720);
    const one = Float32Array.from({ length: 360 }, (_, i) => i + 0.5);
    expect(Array.from(radialOfBin(one, 360, false).subarray(0, 6))).toEqual([0, 0, 1, 1, 2, 2]);
  });
  it('uses true azimuths: a missing radial leaves its bins empty instead of shifting the rest', () => {
    const az = Float32Array.from([0.5, 1.5, 3.5, 4.5]); // 2.5° missing
    expect(Array.from(radialOfBin(az, 4, false).subarray(0, 10))).toEqual([0, 0, 1, 1, -1, -1, 2, 2, 3, 3]);
  });
  it('copies codes, never averages: every row of a 1° tilt is one of its radials', () => {
    const s = sweeps[2], rows = tiltRows(s, 'REF', false)!, n = rows.gates;
    for (const b of [0, 1, 2, 357, 719]) {
      const r = Math.floor((((0.25 + b / 2 - s.azimuths[0] + 0.5) % 360) + 360) % 360);
      expect(Array.from(rows.codes.subarray(b * n, (b + 1) * n))).toEqual(Array.from(s.ref!.codes.subarray(r * n, (r + 1) * n)));
    }
  });
});

describe('tilt selection', () => {
  const picked = (moment: Parameters<typeof volumeTilts>[1], latest: boolean, list = sweeps) => volumeTilts(list, moment, latest).map((t) => t.index);
  it('takes reflectivity and dual-pol from the surveillance cut and velocity from the Doppler cut of a split cut', () => {
    expect(picked('REF', false)).toEqual([0, 2, 5, 6, 7]);
    expect(picked('ZDR', false)).toEqual([0, 2, 5, 6, 7]);
    expect(picked('KDP', false)).toEqual([0, 2, 5, 6, 7]);
    expect(picked('VEL', false)).toEqual([1, 2, 5, 6, 7]);
  });
  it('takes the first or the latest SAILS rescan', () => {
    expect(picked('REF', true)).toEqual([3, 2, 5, 6, 7]);
    expect(picked('CC', true)).toEqual([3, 2, 5, 6, 7]);
    expect(picked('VEL', true)).toEqual([4, 2, 5, 6, 7]);
  });
  it('is ascending in elevation, skips missing tilts and falls back to the Doppler cut when it alone has the moment', () => {
    const els = volumeTilts(sweeps, 'REF', true).map((t) => t.sweep.elevation);
    expect(els).toEqual([...els].sort((a, b) => a - b));
    expect(picked('REF', false, sweeps.filter((_, i) => i !== 5))).toEqual([0, 2, 5, 6]); // 2.5° missing: indices shift
    expect(picked('REF', false, sweeps.slice(1))).toEqual([2, 1, 4, 5, 6]); // 0.5°: SAILS surveillance cut (index 2), not the Doppler cut
    expect(picked('REF', false, [sweeps[1], sweeps[2]])).toEqual([0, 1]); // only the Doppler cut has 0.5° reflectivity
    expect(picked('VEL', false, [sweeps[0]])).toEqual([]);
  });
  it('groups by nominal elevation even when the measured means differ', () => {
    expect(sweeps.slice(0, 5).map((s) => s.elevation.toFixed(2))).toEqual(['0.53', '0.48', '1.50', '0.52', '0.49']);
    expect(volumeTilts(sweeps, 'REF', false)).toHaveLength(5);
  });
});

describe('volume pack', () => {
  const o = { latest: false, qualityDealiasing: false };
  it('packs each tilt as 720 rows plus two wrap rows at the widest gate count', () => {
    const scan = volume.sweeps.map((s) => ({ startMs: s.timesMs[0], endMs: s.timesMs[s.timesMs.length - 1] }));
    const p = buildVolumePack(sweeps, 'REF', o, scan)!;
    expect(p.width).toBe(48);
    expect(p.tilts.map((t) => [t.sweep, t.gates, t.radials, t.firstKm, t.gateKm])).toEqual([[0, 48, 720, 2.125, 0.25], [2, 48, 360, 2.125, 0.25], [5, 48, 360, 2.125, 0.25], [6, 42, 360, 2.125, 0.25], [7, 36, 360, 2.125, 0.25]]);
    expect(p.tilts[1].startMs).toBe(volume.sweeps[2].timesMs[0]);
    expect(p.tilts.map((t) => +t.elevation.toFixed(2))).toEqual([0.53, 1.5, 2.5, 4, 8]);
    for (const img of p.layers) {
      expect(img.length).toBe(PACK_ROWS * 48);
      expect(Array.from(img.subarray(0, 48))).toEqual(Array.from(img.subarray(720 * 48, 721 * 48)));
      expect(Array.from(img.subarray(721 * 48))).toEqual(Array.from(img.subarray(48, 96)));
    }
    // Tilt 0: radial r is at 0.25 + r/2, so bin b is radial b; a shorter tilt is zero-filled past its gates.
    expect(Array.from(p.layers[0].subarray(48 * 11, 48 * 12))).toEqual(Array.from(sweeps[0].ref!.codes.subarray(48 * 10, 48 * 11)));
    expect(Array.from(p.layers[4].subarray(48 + 36, 96))).toEqual(Array(12).fill(0));
  });
  it('keeps the file codes of ZDR and CC, dealiases velocity per tilt and masks KDP gates without a result', () => {
    const zdr = buildVolumePack(sweeps, 'ZDR', o)!, raw = volume.sweeps[0].moments.ZDR!.raw;
    expect(Array.from(zdr.layers[0].subarray(40 * 6, 40 * 7))).toEqual(Array.from(raw.subarray(40 * 5, 40 * 6)));
    const vel = buildVolumePack(sweeps, 'VEL', { latest: false, qualityDealiasing: true })!;
    const dv = dealias(sweeps[1], true)!; // radial r at 0.3 + r/2 → bin r
    expect(Array.from(vel.layers[0].subarray(40 * 8, 40 * 9))).toEqual(Array.from(dv.subarray(40 * 7, 40 * 8)));
    const kd = buildVolumePack(sweeps, 'KDP', o)!, plain = kdp(sweeps[0])!, masked = kdp(sweeps[0], true)!;
    expect(Array.from(kd.layers[0].subarray(40, 80))).toEqual(Array.from(masked.subarray(0, 40)));
    expect(masked[2]).toBe(0); expect(plain[2]).toBe(46); // an edge gate has no result
    for (let i = 0; i < masked.length; i++) if (masked[i]) expect(masked[i]).toBe(Math.max(2, plain[i]));
    expect(masked.some((c) => c >= 2)).toBe(true);
  });
  it('requantises 16-bit ZDR to the 8-bit scale and keeps its reserved code', () => {
    const dB = [-7.5, 0, 2.5, 7.9375];
    const codes = Uint16Array.from([0, ...dB.map((v) => Math.round(((v + 7.875) / 15.8125) * 65535))]);
    const s: BuilderSweep = { elevation: 0.5, radials: 1, azimuths: Float32Array.of(0.25), half: true, vn: 40, complete: false, splitCutDoppler: false, supplemental: false, zdr16: { gates: 5, firstKm: 2.125, gateKm: 0.25, codes } };
    const row = tiltRows(s, 'ZDR', false)!.codes.subarray(0, 5);
    expect(row[0]).toBe(0);
    expect(Array.from(row.subarray(1)).map((c) => c * VOLUME_MOMENTS.ZDR.scale + VOLUME_MOMENTS.ZDR.offset)).toEqual(dB);
  });
  it('is null for a moment the volume lacks', () => {
    expect(buildVolumePack([sweeps[0]], 'VEL', o)).toBeNull();
  });
});

describe('column maxima (products 17–19)', () => {
  // Three complete 1° sweeps with uniform fields; custom isotherms 0.5 km and 1.5 km put the estimated −10 °C height at 1 km.
  const p = { hailZLower: 40, hailZUpper: 50, isothermAuto: false, h0Custom: 500, hm20Custom: 1500, envIsotherms: null, etThreshold: 18.5, gust1991: true };
  const gates = 400, el = [0.5, 1.5, 2.5];
  const uniform = (v: number) => ({ gates, firstKm: 2.125, gateKm: 0.25, codes: new Uint8Array(360 * gates).fill(v) });
  const zdrCode = (dB: number) => 255 - (dB * 16 + 128), ccCode = (cc: number) => Math.round(cc * 300 - 60.5);
  const stack = (dbz: number[], zdr: number[], cc: number[]): BuilderSweep[] => el.map((elevation, k) => ({
    elevation, radials: 360, azimuths: Float32Array.from({ length: 360 }, (_, i) => i + 0.5), half: false, vn: 40, complete: true, splitCutDoppler: false, supplemental: false,
    ref: uniform(dbz[k] + 31), zdr: uniform(zdrCode(zdr[k])), rho: uniform(ccCode(cc[k])),
  }));
  const code = (product: 17 | 19, v: number) => { const r = COLUMN_RANGE[product]; return Math.round(((v - r.low) / (r.high - r.low)) * 255); };
  /** Output gate whose two source gates both have the given tilts (and only those) at or above `baseM`. */
  const gateWith = (above: number[], baseM: number) => {
    for (let og = 0; og < gates / 2; og++) {
      const both = [2 * og, 2 * og + 1].every((g) => el.every((e, k) => (beamHeightKm(2.125 + g * 0.25, e) * 1000 >= baseM) === above.includes(k)));
      if (both) return og;
    }
    throw new Error('no such gate');
  };

  it('takes the largest ZDR among the beams at or above the −10 °C height', () => {
    const out = volumetric(17, stack([40, 40, 40], [3, 1, 2], [0.95, 0.95, 0.95]), p)!;
    expect([out.gates, out.gateKm, out.firstKm, out.az0]).toEqual([690, 0.5, 2.125, 0.25]);
    expect(out.codes[gateWith([], 1000)]).toBe(0);              // every beam below 1 km: nothing
    expect(out.codes[gateWith([2], 1000)]).toBe(code(17, 2));   // only the 2.5° beam
    expect(out.codes[gateWith([1, 2], 1000)]).toBe(code(17, 2)); // 1.5° (1 dB) and 2.5° (2 dB)
    expect(out.codes[gateWith([0, 1, 2], 1000)]).toBe(code(17, 3));
    expect(code(17, 2)).toBe(135);                              // (2 + 4.75) / 12.75 · 255
    const far = 300 * out.gates + gateWith([0, 1, 2], 1000);    // every azimuth bin alike
    expect(out.codes[far]).toBe(code(17, 3));
  });
  it('skips gates that fail the reflectivity or correlation gate', () => {
    const g = gateWith([0, 1, 2], 1000);
    expect(volumetric(17, stack([40, 40, 40], [3, 1, 2], [0.7, 0.95, 0.95]), p)!.codes[g]).toBe(code(17, 2)); // CC 0.70 < 0.80
    expect(volumetric(17, stack([15, 40, 15], [3, 1, 2], [0.95, 0.95, 0.95]), p)!.codes[g]).toBe(code(17, 1)); // 15 dBZ < 20
    expect(volumetric(17, stack([15, 15, 15], [3, 1, 2], [0.95, 0.95, 0.95]), p)!.codes[g]).toBe(0);
  });
  it('uses the model −10 °C height when there is one and says when it is estimated', () => {
    const auto = { ...p, isothermAuto: true, envIsotherms: { h0: 500, hm20: 1500, hm10: 800 } };
    expect(isothermHeights(auto)).toEqual({ h0: 500, hm10: 800, hm20: 1500, estimated: false });
    expect(isothermHeights({ ...auto, envIsotherms: { h0: 500, hm20: 1500, hm10: null } })).toEqual({ h0: 500, hm10: 1000, hm20: 1500, estimated: true });
    expect(isothermHeights(p).estimated).toBe(true);
    expect(columnNote(17, () => p)).toMatch(/^Estimated/);
    expect(columnNote(18, () => auto)).toBeUndefined();
    expect(columnNote(19, () => p)).toBeUndefined(); // the hail core uses the −20 °C height
    const s = stack([40, 40, 40], [3, 1, 2], [0.95, 0.95, 0.95]);
    const g = gateWith([0, 1, 2], 800); // the 0.5° beam has just passed 0.8 km and is still under 1 km
    expect(beamHeightKm(2.125 + (2 * g + 1) * 0.25, 0.5) * 1000).toBeLessThan(1000);
    expect(volumetric(17, s, p)!.codes[g]).toBe(code(17, 2));    // estimated base 1 km: 1.5° and 2.5° only
    expect(volumetric(17, s, auto)!.codes[g]).toBe(code(17, 3)); // model base 0.8 km: the 0.5° beam counts too
  });
  it('hail core: the largest reflectivity at or above the −20 °C height, without the dual-pol gate', () => {
    const out = volumetric(19, stack([50, 45, 60], [0, 0, 0], [0.5, 0.5, 0.5]), p)!;
    expect(out.codes[gateWith([2], 1500)]).toBe(code(19, 60));
    expect(out.codes[gateWith([1, 2], 1500)]).toBe(code(19, 60));
    expect(out.codes[gateWith([], 1500)]).toBe(0);
    expect(code(19, 60)).toBe(184); // (60 + 32) · 2
    const weak = volumetric(19, stack([50, 45, 5], [0, 0, 0], [0.5, 0.5, 0.5]), p)!;
    expect(weak.codes[gateWith([2], 1500)]).toBe(code(19, 5));
  });
  it('KDP column reads kdp() results above the −10 °C height', () => {
    const s = stack([40, 40, 40], [0, 0, 0], [0.95, 0.95, 0.95]);
    const step = 91; // ≈ 0.5° of phase per gate
    for (const t of s) t.phi = { gates, firstKm: 2.125, gateKm: 0.25, codes: Uint16Array.from({ length: 360 * gates }, (_, i) => 1000 + (i % gates) * step) };
    const out = volumetric(18, s, p)!, expected = (step * 360) / 65535;
    const got = out.codes[gateWith([0, 1, 2], 1000)] / 255 * 11 - 2;
    expect(got).toBeCloseTo(expected, 1);
    expect(out.codes[gateWith([], 1000)]).toBe(0);
  });
});

describe('column products in the catalogs', () => {
  it('have a catalog entry, palette setting, menu item, display range and algorithm key', () => {
    expect(PRODUCTS.level2.map((x) => x.index)).toEqual([...Array(20).keys()]);
    expect(L2_PALETTE_KEYS).toHaveLength(PRODUCTS.level2.length);
    for (const k of L2_PALETTE_KEYS) expect(SETTINGS.some((s) => s.id === k), k).toBe(true);
    expect(Object.values(L2_MENU_INDEX).sort((a, b) => a - b)).toEqual([...Array(20).keys()]);
    expect(SETTINGS.find((s) => s.id === 'layerState.NEXRADLevel2Product')!.max).toBe(19);
    for (const i of [17, 18, 19] as const) {
      expect([PRODUCTS.level2[i].low, PRODUCTS.level2[i].high]).toEqual([COLUMN_RANGE[i].low, COLUMN_RANGE[i].high]);
      expect(l2Moment(i)).toBeNull();
      expect(usesIsotherms(i)).toBe(true);
    }
    const base = { qualityDealiasing: true, stormMotion: { speedKt: 0, fromDeg: 0 }, hailZLower: 40, hailZUpper: 50, isothermAuto: true, h0Custom: 4000, hm20Custom: 6000, etThreshold: 18.5, gust1991: true };
    expect(algorithmKey(17, base)).not.toBe(algorithmKey(17, { ...base, h0Custom: 4100 }));
    expect(algorithmKey(19, base)).not.toBe(algorithmKey(19, { ...base, isothermAuto: false }));
    expect(algorithmKey(17, base)).toBe(algorithmKey(17, { ...base, hailZLower: 45 })); // hail thresholds do not enter
    expect(algorithmKey(11, base)).toBe('40,50,true,4000,6000');
  });
});
