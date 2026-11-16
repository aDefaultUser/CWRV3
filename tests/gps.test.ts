import { describe, it, expect } from 'vitest';
import { applyNmea, emptyFix, nmeaValid } from '../src/data/gps';

// Sentences from the public NMEA 0183 examples (checksums computed per the standard).
const GGA = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
const RMC = '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A';
describe('NMEA parsing', () => {
  it('validates checksums', () => {
    expect(nmeaValid(GGA)).toBe(true);
    expect(nmeaValid(GGA.replace('*47', '*48'))).toBe(false);
  });
  it('GGA gives position, altitude, satellites and time', () => {
    const f = emptyFix();
    expect(applyNmea(f, GGA)).toBe(true);
    expect(f.lat).toBeCloseTo(48.1173, 4);
    expect(f.lon).toBeCloseTo(11.516667, 5);
    expect(f.altM).toBe(545.4);
    expect(f.sats).toBe(8);
    expect(new Date(f.fixMs!).getUTCHours()).toBe(12);
  });
  it('RMC gives speed, course, magnetic variation and date', () => {
    const f = emptyFix();
    expect(applyNmea(f, RMC)).toBe(true);
    expect(f.speedKt).toBe(22.4);
    expect(f.headingDeg).toBe(84.4);
    expect(f.magVarDeg).toBe(-3.1);
    expect(new Date(f.fixMs!).toISOString()).toBe('1994-03-23T12:35:19.000Z');
  });
  it('ignores void RMC and no-fix GGA', () => {
    const f = emptyFix();
    expect(applyNmea(f, '$GPRMC,123519,V,,,,,,,230394,,*35'.replace(/\*..$/, ''))).toBe(false);
    expect(applyNmea(f, '$GPGGA,123519,,,,,0,00,,,M,,M,,')).toBe(false);
  });
});
