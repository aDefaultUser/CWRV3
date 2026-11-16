import { describe, it, expect } from 'vitest';
import { cityImpacts, frontLine, swathBand, formatClock, impactText, kmPerMin } from '../src/app/tracks';
import { gcDistanceKm, destination } from '../src/gis/geodesy';

const motion = { speedKt: 30, fromDeg: 270 }; // moving east at 55.56 km/h
describe('storm track geometry', () => {
  it('cell front is a segment across the motion, centred on the cell', () => {
    const f = frontLine([[-97, 35]], motion);
    expect(f).toHaveLength(2);
    expect(gcDistanceKm(...f[0], ...f[1])).toBeCloseTo(16, 3);
    expect((f[0][0] + f[1][0]) / 2).toBeCloseTo(-97, 6);
  });
  it('ETA equals along-track distance over speed; off-track and behind cities are excluded', () => {
    const ahead = destination(-97, 35, 90, 27.78); // 30 min at 55.56 km/h
    const cities = [
      { n: 'Ahead', lon: ahead[0], lat: ahead[1], pop: 1 },
      { n: 'Behind', lon: -97.3, lat: 35, pop: 1 },
      { n: 'Off', lon: ahead[0], lat: 35.3, pop: 1 },
      { n: 'TooFar', lon: -95, lat: 35, pop: 1 },
    ];
    const r = cityImpacts(frontLine([[-97, 35]], motion), motion, 60, cities);
    expect(r.map((x) => x.name)).toEqual(['Ahead']);
    expect(r[0].minutes).toBeCloseTo(30, 0);
    expect(kmPerMin(motion)).toBeCloseTo(0.926, 3);
  });
  it('a line front reaches cities along its whole length', () => {
    const front: [number, number][] = [[-97, 34.5], [-97, 35.5]];
    const r = cityImpacts(front, motion, 60, [{ n: 'N', lon: -96.8, lat: 35.4, pop: 1 }, { n: 'S', lon: -96.6, lat: 34.6, pop: 1 }]);
    expect(r.map((x) => x.name)).toEqual(['N', 'S']);
    expect(r[1].minutes).toBeGreaterThan(r[0].minutes);
  });
  it('swath band is two triangles per front piece', () => {
    expect(swathBand([[-97, 35], [-97, 35.1]], motion, 0, 10)).toHaveLength(12);
  });
  it('time format follows the Delphi tokens', () => {
    const t = new Date(2026, 4, 6, 15, 7, 9).getTime();
    expect(formatClock(t, 'hh:nn am/pm')).toBe('03:07 pm');
    expect(formatClock(t, 'h:nn AM/PM')).toBe('3:07 PM');
    expect(formatClock(t, 'hh:nn:ss')).toBe('15:07:09');
    expect(impactText(t + 12 * 60e3, t, true, '')).toBe('in 12 min');
    expect(impactText(t - 5 * 60e3, t, true, '')).toBe('5 min ago');
  });
});

import { formatDateTime } from '../src/util/datefmt';
describe('date-time format', () => {
  it('distinguishes months from minutes and formats the default WSV3 pattern', () => {
    const t = Date.UTC(2026, 10, 15, 18, 5, 9);
    expect(formatDateTime(t, 'mmm d yyyy hh:mm AMPM', true)).toBe('Nov 15 2026 06:05 PM');
    expect(formatDateTime(t, 'yyyy-mm-dd hh:nn:ss', true)).toBe('2026-11-15 18:05:09');
    expect(formatDateTime(t, 'dddd "at" h:nn a/p', true)).toBe('Sunday at 6:05 p');
  });
});

import { parseMotion } from '../src/layers/warnings';
describe('warning motion line', () => {
  it('parses NWS eventMotionDescription', () => {
    const m = parseMotion('2026-11-15T17:56:00-00:00...storm...262DEG...28KT...3292 9893 3270 9905')!;
    expect(m.fromDeg).toBe(262); expect(m.speedKt).toBe(28);
    expect(m.points).toEqual([[-98.93, 32.92], [-99.05, 32.7]]);
    expect(new Date(m.timeMs).toISOString()).toBe('2026-11-15T17:56:00.000Z');
    expect(parseMotion('')).toBeNull();
  });
});
