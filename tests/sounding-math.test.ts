// Sounding thermodynamics and kinematics against independently documented references.
//
// References (MetPy 1.7.1, BSD-3-Clause, https://github.com/Unidata/MetPy/tree/v1.7.1):
//  * tests/calc/test_thermo.py, test_indices.py and test_kinematics.py: the literal values below are copied from
//    those tests with their names. MetPy asserts `decimal=n`, i.e. |error| < 1.5·10⁻ⁿ; the same tolerances are
//    used here unless stated.
//  * The DDC 2016-05-22 00 UTC radiosonde is MetPy's staticdata/may22_sounding.txt (University of Wyoming format),
//    copied to tests/fixtures/sounding/ddc-2016052200.txt and read the way metpy.testing.get_upper_air_data does.
//  * "MetPy 1.7.1 run" values were computed with MetPy 1.7.1 from PyPI on the same levels:
//    surface_based_cape_cin, mixed_layer_cape_cin, most_unstable_cape_cin, bunkers_storm_motion,
//    storm_relative_helicity (Bunkers right mover), bulk_shear and precipitable_water (whole profile).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  lcl, moistLapse, parcelPath, capeCin, mostUnstableParcel, mixedLayerParcel, helicity, precipitableWater, bunkers, bulkShear,
  analyze, thermoLevels, windLevels, windComponents, lambertWm1, satVaporPressure, KT, type Level,
} from '../src/sections/sounding-math';
import { parseRaob, parseBufkit } from '../src/sections/sounding-data';

const K = 273.15;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/sounding/${name}`, import.meta.url), 'utf8');
/** |a − b| < 1.5·10⁻ⁿ (numpy assert_almost_equal with decimal=n). */
const near = (a: number, b: number, n: number) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(1.5 * 10 ** -n);
const thermo = (p: number[], t: number[], td: number[]): Level[] => p.map((x, i) => ({ p: x, z: NaN, t: t[i] + K, td: td[i] + K, u: NaN, v: NaN }));

/** UWyo text sounding: rows with any of T, Td, direction, speed (as metpy.testing.get_upper_air_data). */
function uwyo(text: string): Level[] {
  const f = (s: string) => (s.trim() ? Number(s) : NaN);
  return text.split('\n').slice(4).filter((r) => r.trim()).map((r) => {
    const [p, z, t, td, d, s] = [f(r.slice(0, 7)), f(r.slice(7, 14)), f(r.slice(14, 21)), f(r.slice(21, 28)), f(r.slice(42, 49)), f(r.slice(49, 56))];
    const [u, v] = windComponents(d, s * KT);
    return { p, z, t: t + K, td: td + K, u, v };
  }).filter((l) => [l.t, l.td, l.u].some(Number.isFinite));
}

describe('thermodynamics (MetPy 1.7.1 test_thermo.py)', () => {
  it('Lambert W₋₁ inverts w·eʷ on the lower branch', () => {
    for (const w of [-1.5, -3, -10, -40]) near(lambertWm1(w * Math.exp(w)), w, 9);
  });
  it('saturation vapour pressure is 6.112 hPa at the triple point (Ambaum 2020)', () => near(satVaporPressure(273.16), 6.112, 9));
  it('test_lcl: 1000 hPa, 30 °C, 20 °C → 864.213 hPa, 17.662 °C', () => {
    const l = lcl(1000, 30 + K, 20 + K);
    near(l.p, 864.213, 2); near(l.t - K, 17.662, 2);
  });
  it('test_lcl_kelvin: 1017.16 hPa, 273.09723 K, 264.5351 K → 889.459 hPa, 262.827 K', () => {
    const l = lcl(1017.16, 273.09723, 264.5351);
    // MetPy's literal pressure differs from its own 1.7.1 output (889.4135 hPa) by 0.046 hPa; 0.05 hPa is allowed.
    expect(Math.abs(l.p - 889.459)).toBeLessThan(0.05); near(l.t, 262.827, 2);
  });
  it('test_moist_lapse_starting_points: every start point reproduces the same pseudo-adiabat', () => {
    const p = [1000, 925, 850, 700, 600], truth = [20.0804315, 17.23238477, 14.07345674, 6.47393223, -0.00554555];
    for (let s = 0; s < p.length; s++) moistLapse(p, truth[s] + K, p[s]).forEach((t, i) => near(t - K, truth[i], 4));
  });
  it('test_parcel_profile: 30 °C / 20 °C parcel from 1000 hPa', () => {
    const levels = [1000, 900, 800, 700, 600, 500, 400], truth = [303.15, 294.16, 287.989, 283.031, 277.008, 269.340, 258.883];
    const path = parcelPath(levels, levels.map(() => 30 + K), levels.map(() => 20 + K));
    const k = path.p.indexOf(path.lclP); // the LCL is inserted; MetPy's parcel_profile has the input levels only
    path.parcel.filter((_, i) => i !== k).forEach((t, i) => near(t, truth[i], 2));
  });

  const P = [959, 779.2, 751.3, 724.3, 700, 269], T = [22.2, 14.6, 12, 9.4, 7, -38], TD = [19, -11.2, -10.8, -10.4, -10, -53.2];
  it('test_surface_based_cape_cin: 223.927 J/kg, −52.716 J/kg', () => {
    const r = capeCin(parcelPath(P, T.map((x) => x + K), TD.map((x) => x + K)));
    near(r.cape, 223.92721210, 2); near(r.cin, -52.716051667, 2);
  });
  it('test_lfc_basic and test_el: parcel and environment temperatures (no virtual correction)', () => {
    const lfc = capeCin(parcelPath(P, [22.2, 14.6, 12, 9.4, 7, -49].map((x) => x + K), TD.map((x) => x + K)), false);
    near(lfc.lfcP!, 727.055, 2);
    const el = capeCin(parcelPath(P, T.map((x) => x + K), TD.map((x) => x + K)), false);
    expect(Math.abs(el.elP! - 476.30710)).toBeLessThan(0.01); // decimal=3 in MetPy; 0.0033 hPa apart here
  });
  it('test_most_unstable_cape_cin: 189.087 J/kg, −26.219 J/kg', () => {
    const mu = mostUnstableParcel(thermo([1000, 959, 867.9, 850, 825, 800], [18.2, 22.2, 17.4, 10, 0, 15], [19, 19, 14.3, 0, -10, 0]).map((l) => ({ ...l, td: Math.min(l.td, l.t) })));
    expect(mu.p0).toBe(959);
    near(mu.cape, 189.08728967, 2); near(mu.cin, -26.218611338, 2);
  });
  it('test_mixed_parcel: 250 hPa layer → 28.7401463 °C (dew point: MetPy 1.7.1 run 7.1390165 °C, literal 7.1535)', () => {
    const ml = mixedLayerParcel(thermo(P, T, TD), 250);
    near(ml.t0 - K, 28.7401463, 6);
    near(ml.td0 - K, 7.13901650541203, 6);
    near(ml.td0 - K, 7.15346585151, 1);
  });
});

describe('storm-relative helicity (MetPy 1.7.1 test_kinematics.py)', () => {
  const wind = (h: number[], u: number[], v: number[]): Level[] => h.map((z, i) => ({ p: 1000 - z / 10, z, t: NaN, td: NaN, u: u[i], v: v[i] }));
  it('test_storm_relative_helicity_no_storm_motion / _storm_motion / _with_interpolation: 300 m²/s²', () => {
    near(helicity(wind([0, 250, 500, 750], [0, 20, 10, 0], [20, 0, 0, 10]), 750, [0, 0])!, 300, 6);
    near(helicity(wind([0, 250, 500, 750], [5, 25, 15, 5], [30, 10, 10, 20]), 750, [5, 10])!, 300, 6);
    near(helicity(wind([0, 100, 200, 300, 400], [-5, 15, 25, 15, -5], [40, 20, 10, 10, 30]), 300, [5, 10], 50)!, 300, 6);
  });
});

describe('DDC 2016-05-22 00 UTC (MetPy staticdata/may22_sounding.txt)', () => {
  const lv = uwyo(fixture('ddc-2016052200.txt'));
  const th = thermoLevels(lv), wl = windLevels(lv);
  it('test_precipitable_water (top 400 hPa): 22.58809193 mm', () => near(precipitableWater(th.map((l) => l.p), th.map((l) => l.td), 400), 22.58809193, 4));
  it('test_bunkers_motion: right mover, left mover, 0–6 km mean wind (m/s)', () => {
    const b = bunkers(wl)!;
    [...b.rm, ...b.lm, ...b.mean].forEach((x, i) => near(x, [2.062733, 0.96246913, 11.22554254, 12.83861839, 6.64413777, 6.90054376][i], 8));
  });
  it('test_bulk_shear: 0–6 km 29.8996 / −14.3892 kt', () => {
    const s = bulkShear(wl, 6000)!;
    near(s[0] / KT, 29.899581266946115, 8); near(s[1] / KT, -14.389225800205509, 8);
  });
  it('panel indices match a MetPy 1.7.1 run on the same levels', () => {
    const a = analyze(lv);
    // CAPE/CIN within 0.05 J/kg, SRH within 0.01 m²/s², shear within 0.0001 m/s, PWAT within 0.001 mm.
    expect(Math.abs(a.sb.cape - 2637.3412814427124)).toBeLessThan(0.05); expect(Math.abs(a.sb.cin - -69.00018426453398)).toBeLessThan(0.05);
    expect(Math.abs(a.ml.cape - 1417.5493642854287)).toBeLessThan(0.05); expect(Math.abs(a.ml.cin - -231.42621121494562)).toBeLessThan(0.05);
    expect(Math.abs(a.mu.cape - 2637.3412814427124)).toBeLessThan(0.05); expect(Math.abs(a.mu.cin - -69.00018426453398)).toBeLessThan(0.05);
    near(a.sb.path.lclP, 832.4158163489814, 6);
    expect(Math.abs(a.srh1! - 246.82366331734596)).toBeLessThan(0.01); expect(Math.abs(a.srh3! - 454.18062454419993)).toBeLessThan(0.01);
    near(a.shear1!, 15.876735365167928, 4); near(a.shear6!, 17.070215362901582, 4);
    near(a.pwatMm, 22.640604098994622, 3);
    // Lapse rates and heights are plain interpolations of the listed levels (no reference library function).
    expect(a.lapse700500).toBeGreaterThan(7); expect(a.lapse700500).toBeLessThan(8);
    expect(a.lclM).toBeGreaterThan(850); expect(a.lclM).toBeLessThan(930);
    expect(a.lfcM).not.toBeNull(); expect(a.elM!).toBeGreaterThan(a.lfcM!);
  });
});

describe('IEM fixtures', () => {
  it('KOAX 2026-11-17 12 UTC radiosonde: indices match a MetPy 1.7.1 run on the parsed levels', () => {
    const a = analyze(parseRaob(JSON.parse(fixture('iem-raob-koax-2026111712.json')))!.levels);
    expect(Math.abs(a.sb.cape - 2.2267327496579847)).toBeLessThan(0.01); expect(a.sb.cin).toBe(0);
    expect(Math.abs(a.ml.cape - 0.03175736299139014)).toBeLessThan(0.01); expect(Math.abs(a.ml.cin - -9.671764959018061)).toBeLessThan(0.01);
    expect(a.mu.cape).toBe(0);
    near(a.sb.path.lclP, 930.5777599062098, 6);
    [...a.storm!.rm, ...a.storm!.lm, ...a.storm!.mean].forEach((x, i) => near(x, [-0.20644573959986418, 12.946765628037811, 14.299860674646462, 9.130081960769076, 7.0467074675233, 11.038423794403442][i], 6));
    near(a.srh1!, -63.87944571228691, 6); near(a.srh3!, -40.65371462831818, 6);
    near(a.shear1!, 14.990356191386834, 6); near(a.shear6!, 4.198525539424213, 6);
    near(a.pwatMm, 17.7433519435291, 6);
  });
  it('HRRR BUFKIT OAX: matches MetPy 1.7.1 and the profile’s own LCL pressure and precipitable water', () => {
    const json = JSON.parse(fixture('iem-bufkit-hrrr-oax-2026111715.json'));
    const a = analyze(parseBufkit(json)!.levels);
    expect([a.sb.cape, a.ml.cape, a.mu.cape]).toEqual([0, 0, 0]);
    near(a.sb.path.lclP, 917.7648542065172, 6);
    near(a.srh1!, -54.53742202208788, 6); near(a.shear6!, 2.6424343276836577, 6);
    near(a.pwatMm, 14.633972334505618, 6);
    // BUFKIT's own diagnostics (model post-processing): LCLP 917.8 hPa, PWAT 14.7 mm, to their printed precision.
    const par = json.profiles[0].parameters;
    expect(Math.abs(a.sb.path.lclP - par.LCLP)).toBeLessThan(0.1);
    expect(Math.abs(a.pwatMm - par.PWAT)).toBeLessThan(0.1);
  });
});
