// Radar site status: api.weather.gov /radar/stations records (tests/fixtures/radar/stations.json, trimmed from the
// live response of 2026-11-18 01:25Z), the "down" rules, tooltip text and the 5-minute refresh store.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRadarStations, radarStatusLine, radarStatusShort, radarStatusDetail, RadarStatusStore, RADAR_STATUS_INTERVAL_MS } from '../src/radar/status';

const json = JSON.parse(readFileSync('tests/fixtures/radar/stations.json', 'utf8'));
const NOW = Date.parse('2026-11-18T01:26:00Z');

describe('radar station status', () => {
  const m = parseRadarStations(json, NOW);
  it('reads VCP, operability, state and Level 2 latency as reported', () => {
    expect(m.get('KTLX')).toMatchObject({ vcp: 'R35', operability: 'On-line', state: 'Operate', alarms: 'No Alarms', down: false });
    expect(radarStatusLine(m.get('KTLX'))).toBe('VCP 35 · On-line · Operate · L2 latency 0.2 s');
    expect(radarStatusLine(m.get('TMKE'))).toMatch(/^VCP 90 · On-line · Operate/);
    // Status line: VCP, plus operability/state only when not on-line/operating.
    expect(radarStatusShort(m.get('KTLX'))).toBe('VCP 35');
    expect(radarStatusShort(m.get('KPUX'))).toBe('VCP 35, Maintenance Action Mandatory');
    expect(radarStatusShort(m.get('KMXX'))).toBe('DOWN');
    expect(radarStatusShort(m.get('ROCO2'))).toBe('unknown');
  });
  it('marks a site down when inoperable or its Level 2 feed is stale, not for maintenance flags', () => {
    expect(m.get('KMXX')!.down).toBe(true);
    expect(radarStatusLine(m.get('KMXX'))).toBe('DOWN · VCP 35 · Inoperable · Start-Up · last L2 20:13Z');
    expect(m.get('KPUX')).toMatchObject({ operability: 'Maintenance Action Mandatory', down: false });
    expect(radarStatusDetail(m.get('KPUX'))).toContain('Alarms: Tower/Utilities, Receiver');
    // Stale Level 2 alone (operability still on-line) is down too.
    expect(parseRadarStations(json, Date.parse('2026-11-18T02:00:00Z')).get('KTLX')!.down).toBe(true);
  });
  it('says unknown for records without RDA data and for sites not in the response', () => {
    for (const id of ['ROCO2', 'RODN']) { expect(m.get(id)!.down).toBe(false); expect(radarStatusLine(m.get(id))).toBe('unknown'); }
    expect(m.get('KXYZ')).toBeUndefined();
    expect(radarStatusDetail(undefined)).toBe('RDA: unknown');
    expect(radarStatusDetail(m.get('KTLX'))).toBe('RDA: VCP 35 · On-line · Operate · L2 latency 0.2 s\nChecked 01:26Z (api.weather.gov)');
  });
  it('rejects a response without features', () => { expect(() => parseRadarStations({ title: 'error' }, NOW)).toThrow(/no features/); });
});

describe('radar status store', () => {
  it('fetches at most every 5 minutes and expires a table that could not be refreshed', async () => {
    const load = vi.fn(async () => json);
    const s = new RadarStatusStore(load);
    expect(s.get('KTLX', NOW)).toBeUndefined();
    expect(await s.refresh(NOW)).toBe(true);
    expect(s.get('ktlx', NOW)?.vcp).toBe('R35');
    expect(await s.refresh(NOW + RADAR_STATUS_INTERVAL_MS - 1)).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    load.mockRejectedValue(new Error('HTTP 503'));
    expect(await s.refresh(NOW + RADAR_STATUS_INTERVAL_MS)).toBe(true);
    expect(s.error).toBe('HTTP 503');
    expect(s.get('KTLX', NOW + 10 * 60e3)?.vcp).toBe('R35');
    expect(s.get('KTLX', NOW + 16 * 60e3)).toBeUndefined();
  });
  it('shares one request between concurrent callers', async () => {
    let release!: (v: unknown) => void;
    const load = vi.fn(() => new Promise((r) => (release = r)));
    const s = new RadarStatusStore(load);
    const a = s.refresh(NOW), b = s.refresh(NOW);
    release(json);
    expect(await a).toBe(true); expect(await b).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
