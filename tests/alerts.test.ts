import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAlert, type Alert } from '../src/layers/warnings';
import { parseProbSevere } from '../src/sections/probsevere';
import { settings } from '../src/settings/store';
import {
  distanceToRingsKm, arrivalMinutes, warningEvents, warningLevel, levelTags, probSevereEvents, tvsEvents, arrivalEvents,
  cellMovers, probSevereMovers, AlertMemory, AlertCenter, type AlertContext, type Place, type StormAttributes,
} from '../src/app/alerts';

const NOW = Date.UTC(2026, 10, 18, 1, 15, 0);
const iso = (t: number) => new Date(t).toISOString();
const ctx = (places: Place[], radiusKm = 16, now = NOW): AlertContext => ({ places, radiusKm, now, dist: (km) => `${km.toFixed(1)} km` });
// A box warning polygon around (-97.5, 35.5), as the NWS API sends it.
const ring = [[-97.7, 35.4], [-97.3, 35.4], [-97.3, 35.6], [-97.7, 35.6], [-97.7, 35.4]];
function warning(id: string, params: Record<string, string>, description = '', event = 'Tornado Warning'): Alert {
  return parseAlert({
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { id, event, sent: iso(NOW - 5 * 60e3), expires: iso(NOW + 40 * 60e3), ends: iso(NOW + 40 * 60e3), headline: event, description,
      senderName: 'NWS Norman OK', parameters: { VTEC: ['/O.NEW.KOUN.TO.W.0012.261118T0110Z-261118T0200Z/'], ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, [v]])) } },
  });
}
const home: Place = { name: 'Home', lon: -97.5, lat: 35.5 };
const north: Place = { name: 'North', lon: -97.5, lat: 35.6 + 20 / 110.574 }; // 20 km north of the polygon

describe('alert geometry', () => {
  it('measures 0 inside a polygon and the distance to the nearest edge outside', () => {
    expect(distanceToRingsKm(home.lon, home.lat, [ring.flat()])).toBe(0);
    expect(distanceToRingsKm(north.lon, north.lat, [ring.flat()])).toBeCloseTo(20, 1);
  });
  it('projects arrival along the motion, from the data time to now', () => {
    const place: Place = { name: 'P', lon: 0, lat: 0 };
    const west = { lon: -30 / 111.32, lat: 0, eastKmMin: 1, northKmMin: 0, t0: NOW };
    expect(arrivalMinutes(west, place, 5, NOW, 60)).toBeCloseTo(25, 5);
    expect(arrivalMinutes({ ...west, t0: NOW - 10 * 60e3 }, place, 5, NOW, 60)).toBeCloseTo(15, 5); // storm has moved on since its product time
    expect(arrivalMinutes(west, place, 5, NOW, 20)).toBeNull(); // beyond the horizon
    expect(arrivalMinutes({ ...west, eastKmMin: -1 }, place, 5, NOW, 60)).toBeNull(); // moving away
    expect(arrivalMinutes({ ...west, lon: 0.01 }, place, 5, NOW, 60)).toBe(0); // already within the radius
    expect(arrivalMinutes({ ...west, t0: NOW - 40 * 60e3 }, place, 5, NOW, 60)).toBeNull(); // already passed
  });
});

describe('warning triggers', () => {
  it('matches places inside the polygon or within the radius', () => {
    const w = warning('a1', { tornadoDetection: 'RADAR INDICATED' });
    expect(warningEvents([w], ctx([home, north])).map((e) => e.key)).toEqual(['w:TOR.Norman OK.0012@Home']);
    const e = warningEvents([w], ctx([north], 25));
    expect(e).toHaveLength(1);
    expect(e[0].text).toMatch(/^Tornado Warning 20\.0 km from North/);
    expect(e[0].tone).toBe('tornado');
  });
  it('ignores expired, not yet sent and non-alerting warnings', () => {
    const w = warning('a1', {});
    expect(warningEvents([{ ...w, ends: NOW - 1 }], ctx([home]))).toEqual([]);
    expect(warningEvents([{ ...w, sent: NOW + 60e3 }], ctx([home]))).toEqual([]);
    expect(warningEvents([warning('s1', {}, '', 'Special Weather Statement')], ctx([home]))).toEqual([]);
  });
  it('tags upgrades: observed, damage threats, PDS and emergencies', () => {
    expect(levelTags(warningLevel(warning('a', { tornadoDetection: 'OBSERVED', tornadoDamageThreat: 'CONSIDERABLE' })))).toEqual(['TORNADO OBSERVED', 'CONSIDERABLE DAMAGE']);
    expect(levelTags(warningLevel(warning('a', {}, 'THIS IS A TORNADO EMERGENCY FOR MOORE')))).toEqual(['EMERGENCY']);
    expect(levelTags(warningLevel(warning('a', {}, 'THIS IS A PARTICULARLY DANGEROUS SITUATION')))).toEqual(['PDS']);
    expect(levelTags(warningLevel(warning('a', { tornadoDamageThreat: 'CATASTROPHIC' })))).toEqual(['EMERGENCY']);
  });
  it('alerts once per warning and place, again only when an update adds a tag', () => {
    const m = new AlertMemory(), c = ctx([home]);
    expect(m.admit(warningEvents([warning('a1', { tornadoDetection: 'RADAR INDICATED' })], c), NOW)).toHaveLength(1);
    expect(m.admit(warningEvents([warning('a1', { tornadoDetection: 'RADAR INDICATED' })], c), NOW + 30e3)).toHaveLength(0);
    // A continuation message (new id, same office and ETN) adds "observed": an upgrade.
    const up = m.admit(warningEvents([warning('a2', { tornadoDetection: 'OBSERVED' })], c), NOW + 60e3);
    expect(up.map((e) => e.title)).toEqual(['Tornado Warning (TORNADO OBSERVED)']);
    expect(m.admit(warningEvents([warning('a3', { tornadoDetection: 'OBSERVED' })], c), NOW + 90e3)).toHaveLength(0);
    // Dropping back to radar-indicated is not an upgrade.
    expect(m.admit(warningEvents([warning('a4', { tornadoDetection: 'RADAR INDICATED' })], c), NOW + 120e3)).toHaveLength(0);
  });
});

describe('ProbSevere triggers', () => {
  const file = parseProbSevere(JSON.parse(readFileSync('tests/fixtures/probsevere/MRMS_PROBSEVERE_20261118_011438.json', 'utf8')));
  const o = file.objects[0]; // 34590: tor 19, hail 64, wind 70
  const at: Place = { name: 'Keys', lon: o.lon, lat: o.lat };
  it('fires per type at or above its threshold for objects within the radius', () => {
    expect(probSevereEvents(file, [15, 65, 70], ctx([at])).map((e) => e.key)).toEqual(['ps:34590:1@Keys', 'ps:34590:3@Keys']);
    expect(probSevereEvents(file, [15, 65, 70], ctx([{ name: 'Far', lon: -90, lat: 40 }]))).toEqual([]);
  });
  it('alerts again only when the probability reaches a higher 10 % band', () => {
    const m = new AlertMemory(), c = ctx([at]);
    const withTor = (p: number) => ({ ...file, objects: [{ ...o, prob: [o.prob[0], p, 0, 0] }] });
    expect(m.admit(probSevereEvents(withTor(19), [15, 99, 99], c), NOW)).toHaveLength(1);
    expect(m.admit(probSevereEvents(withTor(17), [15, 99, 99], c), NOW)).toHaveLength(0);
    expect(m.admit(probSevereEvents(withTor(25), [15, 99, 99], c), NOW)).toHaveLength(1);
    expect(m.admit(probSevereEvents(withTor(22), [15, 99, 99], c), NOW)).toHaveLength(0);
  });
  it('projects ProbSevere storms with their motion (MOTION_SOUTH positive north)', () => {
    const mover = probSevereMovers(file, 0).find((x) => x.key === 'ps:35243')!; // 5 m/s east
    expect(mover.eastKmMin).toBeCloseTo(0.3, 6);
    const place: Place = { name: 'East', lon: mover.lon + 10 / (111.32 * Math.cos((mover.lat * Math.PI) / 180)), lat: mover.lat };
    const ev = arrivalEvents([mover], 30, ctx([place], 3, file.t));
    expect(ev.map((e) => e.text)).toEqual(['ProbSevere storm 35243 (0%) expected within 3.0 km of East in about 23 minutes.']);
    expect(probSevereMovers(file, 50).map((x) => x.key)).toEqual([]); // 34590 (87 %) moves under 2 kt
  });
});

describe('NEXRAD triggers', () => {
  const storms: StormAttributes = { site: 'KTLX', timeMs: NOW, cells: [{ id: 'A3', lon: -97.9, lat: 35.5, fromDeg: 270, speedKt: 30 }], tvs: [{ id: 'A3', lon: -97.9, lat: 35.5 }] };
  it('fires for a TVS within the radius', () => {
    expect(tvsEvents(storms, ctx([home], 40)).map((e) => e.key)).toEqual(['tvs:KTLX:A3@Home']);
    expect(tvsEvents(storms, ctx([home], 30))).toEqual([]);
  });
  it('projects cell motion (direction from) to an arrival time', () => {
    const [m] = cellMovers(storms);
    expect(m.eastKmMin).toBeCloseTo((30 * 1.852) / 60, 6);
    expect(m.northKmMin).toBeCloseTo(0, 6);
    // 36.2 km west of Home at 0.926 km/min, radius 10 km: about 28 minutes.
    expect(arrivalEvents([m], 30, ctx([home], 10))[0].text).toMatch(/KTLX storm cell A3 expected within 10\.0 km of Home in about 28 minutes/);
  });
});

describe('alert center', () => {
  const tor = warning('a1', { tornadoDetection: 'OBSERVED' });
  const center = (live: boolean) => new AlertCenter({ warnings: async () => [tor], probSevere: () => null, storms: () => null, gps: () => ({ name: 'GPS position', lon: -97.45, lat: 35.45 }), live: () => live });
  it('checks only live data, once per event, from the GPS position', async () => {
    for (const [k, v] of Object.entries({ On: true, Toast: false, Sound: false, Speech: false, Notify: false, UseGps: true, Warnings: true, ProbSevere: false, Tvs: false, Arrival: false })) settings.set(`ext.config.alerts${k}`, v);
    expect(await center(false).poll(NOW)).toEqual([]);
    const c = center(true);
    const fired = await c.poll(NOW);
    expect(fired.map((e) => e.key)).toEqual(['w:TOR.Norman OK.0012@GPS position']);
    expect(c.last[0]).toMatch(/Tornado Warning for GPS position, tornado observed/);
    expect(await c.poll(NOW + 30e3)).toEqual([]);
    settings.set('ext.config.alertsOn', false);
    expect(await center(true).poll(NOW)).toEqual([]);
  });
});
