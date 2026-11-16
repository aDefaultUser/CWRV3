// Worked examples for the METAR, marine and MESO numerics. The expectations are computed by hand from the
// documented formulas, not captured from the original program: they show formula agreement, not runtime equivalence.
import { describe, it, expect } from 'vitest';
import { parseMetar, derive, heatIndex, metarValue, metarDrawn, classifyWeather, weatherClass, marineValue, marineDrawn, marineProbe, type MetarReport, type MarineObs } from '../src/sections/surface-math';
import { severeCell, severeCodes, mesoCode, mesoDecoderUnits, severeFrameTime } from '../src/sections/meso-math';
import { rne } from '../src/util/round';

const rep = (temp: number, dewpt: number, wspeed: number): MetarReport => ({ station: 'TEST', timeMs: 0, wspeed, wgust: 255, wdir: 180, wx: 255, temp, dewpt, alti: 0, rh: 255, wchill: 32767, hindex: 32767, raw: '' });

describe('METAR derived fields ( worked examples)', () => {
  const rows: [number, number, number, number, number, number | null][] = [
    // temp °C, dew °C, wind kt, RH, heat index, wind chill
    [32, 24, 10, 63, 100, null], [35, 2, 5, 13, 95, null], [29, 27, 0, 89, 84, null], [21, 10, 8, 49, 69, null],
    [-5, -10, 15, 68, 21, 9], [10, 5, 2, 71, 49, null], [10, 5, 3, 71, 49, 49],
  ];
  for (const [t, d, w, rh, hi, wc] of rows) it(`${t}/${d} °C, ${w} kt`, () => {
    const r = rep(t, d, w); derive(r);
    expect(r.rh).toBe(rh); expect(r.hindex).toBe(hi); expect(r.wchill).toBe(wc ?? 32767);
  });
  it('vendor heat-index adjustments act on the air temperature, the corrected mode on the regression', () => {
    expect(rne(heatIndex(95, 10))).toBe(94);
    expect(rne(heatIndex(95, 10, true))).toBe(89);
    expect(rne(heatIndex(84, 90))).toBe(84);
    expect(rne(heatIndex(84, 90, true))).toBe(98);
  });
  it('round half to even', () => { expect([rne(0.5), rne(1.5), rne(2.5), rne(-0.5) + 0, rne(-1.5), rne(2.4999)]).toEqual([0, 2, 2, 0, -2, 2]); });
});

describe('METAR parsing, classes and filters ()', () => {
  const now = Date.UTC(2026, 10, 15, 14, 0);
  it('parses wind, temperature, altimeter and weather', () => {
    const r = parseMetar('KOKC 151353Z 18010G22KT 10SM -TSRA BKN030 OVC080 24/20 A2992 RMK AO2', now)!;
    expect([r.wdir, r.wspeed, r.wgust, r.temp, r.dewpt]).toEqual([180, 10, 22, 24, 20]);
    expect(r.alti).toBeCloseTo(29.92 * 33.8638866667, 6);
    expect(r.wx).toBe(2 + 22);
    expect(r.timeMs).toBe(Date.UTC(2026, 10, 15, 13, 53));
  });
  it('handles AUTO, variable wind, MPS, Q altimeter, negative temps and fractions', () => {
    const r = parseMetar('EFHK 151350Z AUTO VRB03MPS 1 1/2SM BR M02/M04 Q1013', now)!;
    expect(r.wdir).toBe(65534); expect(r.wspeed).toBe(rne(3 * 1.94384449)); expect([r.temp, r.dewpt, r.alti, r.wx]).toEqual([-2, -4, 1013, 19]);
    expect(parseMetar('KOKC 151353', now)).toBeNull();
    expect(parseMetar('KOKC 15135Z 18010KT', now)).toBeNull();
  });
  it('weather classes keep the PR/PE quirk and add PL only in corrected mode', () => {
    expect(classifyWeather('PL ')).toBe(0); expect(classifyWeather('PL ', true)).toBe(11);
    expect(classifyWeather('PRFG ')).toBe(11); expect(classifyWeather('+SN ')).toBe(10); expect(classifyWeather('FZRA ')).toBe(14);
    expect(classifyWeather('TS ')).toBe(22); expect(classifyWeather('HZ ')).toBe(0); expect(weatherClass(['10SM', 'CLR'])).toBe(255);
  });
  it('map values and display filters', () => {
    const r = rep(21, 10, 8); derive(r);
    expect(metarValue(r, 8)).toBe(69); expect(metarDrawn(r, 8)).toBe(false);
    expect(metarValue(r, 2)).toBeCloseTo(8 * 1.15077945, 9);
    const g = { ...r, wgust: 8 }; expect(metarDrawn(g, 5)).toBe(false);
    const hot = rep(30, 35, 5); derive(hot); expect(hot.rh).toBeGreaterThan(100); expect(metarDrawn(hot, 6)).toBe(false);
  });
});

describe('marine values ()', () => {
  const o: MarineObs = { id: '42001', timeMs: 0, lon: -89, lat: 25, ship: false, wspd: 5, gust: 7, wdir: 90, atmp: 25, wtmp: 27, dewp: 20, pres: 1012.3, wvht: 1.6, dpd: 7 };
  it('converts for the map and filters', () => {
    expect(marineValue(o, 2)).toBeCloseTo(11.1847, 4); expect(marineValue(o, 8)).toBeCloseTo(5.249, 3);
    expect(marineDrawn({ ...o, pres: 790 }, 7)).toBe(false); expect(marineDrawn({ ...o, wtmp: 9999 }, 5)).toBe(false);
  });
  it('probe prints wave height in metres labelled ft in parity mode', () => {
    expect(marineProbe(o, () => '')).toContain('Wave Height: 2ft');
    expect(marineProbe(o, () => '', true)).toContain('Wave Height: 5ft');
  });
});

describe('STP / SCP ( worked examples)', () => {
  const rows = [
    { cape: 2000, srh1: 200, u6: 15, v6: 20, tF: 86, tdF: 72, pPa: 100000, srh3: 300, pl: 977.45, stp: 2.27232, scp: 15.0, stpCode: 14892, scpCode: 19660 as number | null },
    { cape: 3500, srh1: -150, u6: 20, v6: 0, tF: 90, tdF: 50, pPa: 95000, srh3: -80, pl: 888.98, stp: 2.59239, scp: -5.6, stpCode: 0, scpCode: null },
    { cape: 1000, srh1: 50, u6: 6, v6: 8, tF: 70, tdF: 68, pPa: 101000, srh3: 900, pl: 1006.78, stp: 0.11036, scp: 9.0, stpCode: 723, scpCode: 11796 },
    { cape: 5000, srh1: 400, u6: 30, v6: 40, tF: 95, tdF: 75, pPa: 98000, srh3: 600, pl: 948.26, stp: 23.37202, scp: 150.0, stpCode: 65534, scpCode: null },
  ];
  for (const r of rows) it(`CAPE ${r.cape} SRH1 ${r.srh1} SRH3 ${r.srh3}`, () => {
    const c = severeCell(r);
    expect(c.pl).toBeCloseTo(r.pl, 2); expect(c.stp).toBeCloseTo(r.stp, 4); expect(c.scp).toBeCloseTo(r.scp, 6);
    const k = severeCodes(c.stp, c.scp);
    expect(k.stp).toBe(r.stpCode);
    if (r.scpCode === null) expect(k.scpWritten).toBe(false); else expect(k.scp).toBe(r.scpCode);
  });
  it('corrected mode codes the grids independently and uses SPC caps', () => {
    const k = severeCodes(2.59239, -5.6, true); expect(k.stp).toBe(rne((2.59239 / 10) * 65535)); expect(k.scp).toBe(0);
    expect(severeCell({ cape: 2000, srh1: 200, u6: 5, v6: 5, tF: 86, tdF: 72, pPa: 100000, srh3: 300 }, true).stp).toBe(0);
  });
  it('frame time: current hour from minute 51', () => {
    expect(severeFrameTime(Date.UTC(2026, 0, 1, 12, 51))).toBe(Date.UTC(2026, 0, 1, 12));
    expect(severeFrameTime(Date.UTC(2026, 0, 1, 12, 50))).toBe(Date.UTC(2026, 0, 1, 11));
  });
});

describe('MESO quantisation and decoder units ()', () => {
  it('quantises over the table range and clamps to 0..65534', () => {
    expect(mesoCode(0, 0, 6000)).toBe(0); expect(mesoCode(6000, 0, 6000)).toBe(65534); expect(mesoCode(3000, 0, 6000)).toBe(rne(32767.5));
    expect(mesoCode(-3000, -2500, 100)).toBe(0);
  });
  it('converts like the decoder: K → °F, m → mi, gust m/s → kt (parity) or mph (corrected)', () => {
    expect(mesoDecoderUnits('TMP:850 mb', 273.15)).toBeCloseTo(32, 9);
    expect(mesoDecoderUnits('VIS:surface', 1609.344)).toBeCloseTo(1, 9);
    expect(mesoDecoderUnits('GUST:surface', 10)).toBeCloseTo(19.4384, 4);
    expect(mesoDecoderUnits('GUST:surface', 10, true)).toBeCloseTo(22.3694, 4);
    expect(mesoDecoderUnits('CAPE:surface', 1234)).toBe(1234);
  });
});
