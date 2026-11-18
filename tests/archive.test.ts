// Archive mode: timeline mode and window, the fail-closed layer guard, archive listings across a day boundary,
// IEM parsers on trimmed real responses (tests/fixtures/archive, 2024-05-06 Oklahoma) and the discard of results that
// were requested under another mode or archive time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { setStyles() {} setLines() {} draw() {} },
  PointSet: class { setPoints() {} draw() {} },
  TextSet: class { setLabels() {} draw() {} },
}));
vi.mock('../src/render/polys', async (orig) => ({ ...(await orig<object>()), PolySet: class { setStyles() {} setPolys() {} draw() {} } }));

import { Timeline, timeline } from '../src/app/timeline';
import { useStorage, PREFIX, type KV } from '../src/app/persist';
import { settings } from '../src/settings/store';
import { MapLayer, NOT_AVAILABLE, type ArchiveSupport } from '../src/layers/base';
import { listL2 } from '../src/radar/sources';
import { parseL3Key, l3ArchivePrefixes, l3ArchiveCodes, listL3Archive, iemStormProducts } from '../src/radar/archive';
import { matchVolume } from '../src/radar/overlay-match';
import { archiveAlerts, archiveWatches } from '../src/layers/warnings-archive';
import { WarningsLayer } from '../src/layers/warnings';
import { archiveLsrs, archiveDiscussions, outlookCandidates, outlookCategory } from '../src/sections/nwsspc-archive';
import { archiveCache } from '../src/data/iem';
import { goesAt } from '../src/layers/satellite';
import { parseUtc, archiveBadge } from '../src/app/archive';

const fx = (name: string) => readFileSync(new URL(`./fixtures/archive/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fx(name));
const utc = (s: string) => Date.parse(s);
const memory = (): KV & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get length() { return map.size; }, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k), key: (i) => [...map.keys()][i] ?? null };
};
const T = utc('2024-05-06T22:30:00Z');

beforeEach(() => useStorage(memory()));
afterEach(() => { timeline.setArchive(null); useStorage(null); vi.unstubAllGlobals(); });

describe('timeline archive mode', () => {
  it('anchors the loop window at the archive time and returns to the wall clock', () => {
    const tl = new Timeline(() => 0);
    expect(tl.mode).toBe('live');
    expect(tl.key).toBe('live');
    const e0 = tl.epoch;
    tl.setArchive(T);
    expect(tl.mode).toBe('archive');
    expect(tl.now()).toBe(T);
    expect(tl.loopEnd).toBe(T);
    expect(tl.loopStart).toBe(T - tl.loopHours * 3600e3);
    expect(tl.t).toBe(T); // follows the newest frame, which is the archive time on the general timeline
    expect(tl.key).toBe(`archive@${T}`);
    expect(tl.epoch).toBe(e0 + 1);
    tl.refreshWindow(Date.now()); // the periodic refresh keeps the anchor
    expect(tl.loopEnd).toBe(T);
    tl.setArchive(T - 3600e3);
    expect(tl.epoch).toBe(e0 + 2);
    expect(tl.loopEnd).toBe(T - 3600e3);
    tl.setArchive(null);
    expect(tl.mode).toBe('live');
    expect(tl.epoch).toBe(e0 + 3);
    expect(Math.abs(tl.loopEnd - Date.now())).toBeLessThan(5000);
    expect(Math.abs(tl.now() - Date.now())).toBeLessThan(5000);
  });

  it('keeps the epoch when the time does not change and ignores a non-finite time', () => {
    const tl = new Timeline(() => 0);
    tl.setArchive(T);
    const e = tl.epoch;
    tl.setArchive(T); tl.setArchive(NaN);
    expect([tl.epoch, tl.archive]).toEqual([e, T]);
  });

  it('persists the mode and time, so a reload stays in archive mode', () => {
    const mem = memory();
    useStorage(mem);
    new Timeline(() => 0).setArchive(T);
    expect(JSON.parse(mem.map.get(`${PREFIX}archiveTime`)!)).toBe(T);
    const reloaded = new Timeline(() => 0);
    expect([reloaded.mode, reloaded.archive, reloaded.anchor]).toEqual(['archive', T, T]);
    reloaded.setArchive(null);
    expect(new Timeline(() => 0).mode).toBe('live');
  });

  it('wraps to a radar loop inside the archive window and never to forecast valid times', () => {
    const tl = new Timeline(() => 0);
    tl.setArchive(T);
    settings.set('ext.layerState.TimelineSelect', 1);
    tl.offer('model', [T + 3600e3, T + 2 * 3600e3]);
    expect(tl.controller).toBe('general');
    tl.offer('nexrad-l2', [T - 20 * 60e3, T - 10 * 60e3, T - 60e3]);
    expect(tl.controller).toBe('nexrad-l2');
    expect(tl.t).toBe(T - 60e3);
    tl.offer('nexrad-l2', [Date.now() - 60e3]); // a live frame is outside the archive window
    expect(tl.controller).toBe('general');
    settings.set('ext.layerState.TimelineSelect', 0);
  });
});

describe('fail-closed layer guard', () => {
  class Probe extends MapLayer {
    readonly id = 'probe'; readonly title = 'Probe';
    calls = { refresh: 0, draw: 0, tick: 0 };
    constructor(readonly archive: ArchiveSupport = 'none') { super({} as never); }
    enabled() { return true; }
    async refresh() { this.calls.refresh++; this.setStatus('ready', 'live data'); }
    draw(_ctx: unknown) { this.calls.draw++; }
    tick(_t: number, _now: number) { this.calls.tick++; }
    legends() { return [{ id: 'probe' } as never]; }
    probeKind() { return 'probe'; }
  }

  it('never refreshes, ticks, draws, probes or reports data for a layer without an archive', async () => {
    const l = new Probe();
    await l.refresh(); l.draw({} as never);
    expect(l.calls).toEqual({ refresh: 1, draw: 1, tick: 0 });
    timeline.setArchive(T);
    await l.refresh(); l.draw({} as never); l.tick(0, 0);
    expect(l.calls).toEqual({ refresh: 1, draw: 1, tick: 0 });
    expect(l.status).toEqual({ state: 'unavailable', text: NOT_AVAILABLE });
    expect(l.legends()).toEqual([]);
    expect(l.probeKind()).toBeNull();
    l.setStatus('ready', 'a live request settled late');
    expect(l.status).toEqual({ state: 'unavailable', text: NOT_AVAILABLE });
    timeline.setArchive(null);
    l.draw({} as never);
    expect(l.calls.draw).toBe(1); // not before its refresh has started for live mode
    await l.refresh(); l.draw({} as never); l.tick(0, 0);
    expect(l.calls).toEqual({ refresh: 2, draw: 2, tick: 1 });
    expect(l.status.text).toBe('live data');
    expect(l.probeKind()).toBe('probe');
  });

  it('is the default, and a layer with an archive draws again once its refresh has started for the new time', async () => {
    expect(new (class extends MapLayer { readonly id = 'x'; readonly title = 'x'; enabled() { return true; } draw(_ctx: unknown) {} })({} as never).archive).toBe('none');
    const w = new Probe('window'), s = new Probe('static');
    await w.refresh();
    timeline.setArchive(T);
    w.draw({} as never); s.draw({} as never);
    expect([w.calls.draw, s.calls.draw]).toEqual([0, 1]); // what the window layer holds belongs to another time
    void w.refresh(); w.draw({} as never);
    expect([w.calls.refresh, w.calls.draw]).toEqual([2, 1]);
  });
});

describe('archive listings', () => {
  const stubS3 = (byPrefix: Record<string, string>) => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { const p = new URL(url).searchParams.get('prefix')!; asked.push(p); return new Response(byPrefix[p] ?? '<ListBucketResult></ListBucketResult>'); });
    return asked;
  };

  it('lists Level 2 volumes around the archive time across the day boundary', async () => {
    const asked = stubS3({ '2024/05/06/KTLX/': fx('l2-ktlx-20240506.xml'), '2024/05/07/KTLX/': fx('l2-ktlx-20240507.xml') });
    const until = utc('2024-05-07T00:20:00Z'), files = await listL2('KTLX', 3, '', until - 3600e3, until);
    expect(asked.sort()).toEqual(['2024/05/06/KTLX/', '2024/05/07/KTLX/']); // never today's listing
    expect(files.map((f) => f.name)).toEqual(['KTLX20240506_233726_V06', 'KTLX20240506_234208_V06', 'KTLX20240506_234817_V06', 'KTLX20240506_235439_V06', 'KTLX20240507_000047_V06', 'KTLX20240507_000709_V06', 'KTLX20240507_001447_V06']);
    expect(files.every((f) => !f.live && f.t <= until)).toBe(true);
    expect(files[4]).toMatchObject({ t: utc('2024-05-07T00:00:47Z'), url: 'https://unidata-nexrad-level2.s3.amazonaws.com/2024/05/07/KTLX/KTLX20240507_000047_V06' });
  });

  it('accepts the gzip volumes of older years', async () => {
    stubS3({ '2013/05/20/KTLX/': fx('l2-ktlx-20130520.xml') });
    const until = utc('2013-05-20T20:30:00Z');
    expect((await listL2('KTLX', 3, '', until - 3600e3, until)).map((f) => [f.name, f.t])).toEqual([
      ['KTLX20130520_202058_V06.gz', utc('2013-05-20T20:20:58Z')], ['KTLX20130520_202511_V06.gz', utc('2013-05-20T20:25:11Z')], ['KTLX20130520_202928_V06.gz', utc('2013-05-20T20:29:28Z')]]);
  });

  it('accepts the unversioned volumes before 2008', async () => {
    stubS3({ '1999/05/03/KTLX/': fx('l2-ktlx-19990503.xml') });
    const until = utc('1999-05-03T23:35:00Z');
    expect((await listL2('KTLX', 3, '', until - 1200e3, until)).map((f) => [f.name, f.t])).toEqual([
      ['KTLX19990503_231633.gz', utc('1999-05-03T23:16:33Z')], ['KTLX19990503_232134.gz', utc('1999-05-03T23:21:34Z')],
      ['KTLX19990503_232635.gz', utc('1999-05-03T23:26:35Z')], ['KTLX19990503_233134.gz', utc('1999-05-03T23:31:34Z')]]);
  });

  it('parses Level 3 archive keys and lists by day prefix', async () => {
    expect(parseL3Key('TLX_N0B_2024_05_06_22_03_20')).toEqual({ site: 'TLX', code: 'N0B', t: utc('2024-05-06T22:03:20Z') });
    expect(parseL3Key('TLX_N0B_2024_05_06_22_03')).toBeNull();
    expect(parseL3Key('2024/05/06/KTLX/KTLX20240506_220320_V06')).toBeNull();
    expect(l3ArchivePrefixes('KTLX', 'NST', utc('2024-05-06T23:40:00Z'), utc('2024-05-07T00:05:00Z'))).toEqual(['TLX_NST_2024_05_06', 'TLX_NST_2024_05_07']);
    expect(l3ArchiveCodes('58sti')).toEqual(['NST']);
    expect(l3ArchiveCodes('p94r0', 'N0Q')).toEqual(['N0Q', 'N0B']);
    expect(l3ArchiveCodes('p99vb', 'NBU')).toEqual(['NBU', 'NBG']);
    expect(l3ArchiveCodes('135et', 'EET')).toEqual(['EET']);
    stubS3({ TLX_NST_2024_05_06: fx('l3-tlx-nst-20240506.xml'), TLX_NST_2024_05_07: fx('l3-tlx-nst-20240507.xml') });
    const files = await listL3Archive('KTLX', 'NST', utc('2024-05-06T23:45:00Z'), utc('2024-05-07T00:05:00Z'));
    expect(files.map((f) => f.name)).toEqual(['TLX_NST_2024_05_06_23_48_17', 'TLX_NST_2024_05_07_00_00_47']);
    expect(files[1]).toEqual({ t: utc('2024-05-07T00:00:47Z'), url: 'https://unidata-nexrad-level3.s3.amazonaws.com/TLX_NST_2024_05_07_00_00_47', name: 'TLX_NST_2024_05_07_00_00_47' });
  });

  it('names the GOES satellite that held the position at the time', () => {
    expect(goesAt('goes19', utc('2024-05-06T22:00:00Z'))).toBe('goes16');
    expect(goesAt('goes19', utc('2025-04-08T00:00:00Z'))).toBe('goes19');
    expect(goesAt('goes18', utc('2021-05-06T22:00:00Z'))).toBe('goes17');
    expect(goesAt('goes18', utc('2024-05-06T22:00:00Z'))).toBe('goes18');
  });
});

describe('IEM parsers', () => {
  it('turns storm-based warning versions into alerts shown only while each polygon was in effect', () => {
    const alerts = archiveAlerts(json('iem-sbw-interval.json').features, json('iem-sbw-issuance.json').features);
    expect(alerts).toHaveLength(8);
    const tor94 = alerts.filter((a) => a.type!.code === 'TOR' && a.etn === '0094');
    expect(tor94.map((a) => [new Date(a.sent).toISOString().slice(11, 16), new Date(a.ends).toISOString().slice(11, 16)])).toEqual([['21:33', '21:45'], ['21:45', '21:52'], ['21:52', '22:15']]);
    // Exactly one version of an event is in effect at a time.
    const at = (t: string) => tor94.filter((a) => a.sent <= utc(t) && utc(t) < a.ends);
    expect(at('2024-05-06T21:45:00Z')).toHaveLength(1);
    expect(at('2024-05-06T22:15:00Z')).toHaveLength(0);
    // Issuance tags belong to the issuance polygon only; a later statement may have changed them.
    expect(tor94.map((a) => [a.tornado, a.hail])).toEqual([['RADAR INDICATED', '1.75'], ['', ''], ['', '']]);
    expect(tor94[0]).toMatchObject({ event: 'Tornado Warning', wfo: 'OUN', expires: utc('2024-05-06T22:15:00Z'), pds: false });
    expect(tor94[0].rings[0].length).toBeGreaterThanOrEqual(8);
    expect(alerts.find((a) => a.type!.code === 'SVR' && a.etn === '0368')!.hail).toBe('1.25');
    expect(new Set(alerts.map((a) => a.id)).size).toBe(8);
  });

  it('skips products that are not one of the warning types drawn', () => {
    const f = json('iem-sbw-interval.json').features[0];
    expect(archiveAlerts([{ ...f, properties: { ...f.properties, phenomena: 'FA', significance: 'Y' } }, { ...f, properties: { ...f.properties, significance: 'A' } }, { ...f, geometry: null }])).toEqual([]);
  });

  it('reads watch outlines with their period', () => {
    const w = archiveWatches(json('iem-watch.json').features);
    expect(w.map((a) => [a.event, a.etn, a.sent, a.ends, a.zones.length, a.rings.length > 0])).toEqual([
      ['Tornado Watch', '187', utc('2024-05-06T16:35:00Z'), utc('2024-05-07T00:03:00Z'), 0, true], ['Severe Thunderstorm Watch', '188', utc('2024-05-06T17:15:00Z'), utc('2024-05-07T01:04:00Z'), 0, true]]);
  });

  it('reads local storm reports and mesoscale discussions', () => {
    const lsr = archiveLsrs(json('iem-lsr.json').features);
    expect(lsr.map((l) => [l.typeText, l.type, l.mag, l.t, l.wfo])).toEqual([['TSTM WND GST', 6, 61, utc('2024-05-06T22:15:00Z'), 'OUN'], ['TSTM WND GST', 6, 82, utc('2024-05-06T22:09:00Z'), 'OUN']]);
    expect(Math.abs(lsr[0].lat)).toBeGreaterThan(30);
    const md = archiveDiscussions(json('iem-mcd.json').features, 'Mesoscale Discussion');
    expect(md.map((m) => [m.title, m.t, m.until, m.text])).toEqual([
      ['Mesoscale Discussion 655', utc('2024-05-06T20:35:00Z'), utc('2024-05-06T21:30:00Z'), 'CONCERNING...TORNADO WATCH 189'],
      ['Mesoscale Discussion 656', utc('2024-05-06T20:51:00Z'), utc('2024-05-06T22:45:00Z'), 'CONCERNING...SEVERE THUNDERSTORM WATCH 188']]);
    expect(md[0].ring.length).toBeGreaterThanOrEqual(8);
  });

  it('names the outlooks that can have been issued by a time, newest first', () => {
    // 22:30Z on 6 May: the 2000Z Day 1 outlook is current; the 0100Z update of the same day is not out yet.
    expect(outlookCandidates(0, T).slice(0, 4)).toEqual([{ valid: '2024-05-06', cycle: 20 }, { valid: '2024-05-06', cycle: 16 }, { valid: '2024-05-06', cycle: 13 }, { valid: '2024-05-06', cycle: 6 }]);
    expect(outlookCandidates(0, utc('2024-05-07T00:30:00Z'))[0]).toEqual({ valid: '2024-05-06', cycle: 1 }); // issued about 0050Z for the day that began on the 6th
    expect(outlookCandidates(1, T)[0]).toEqual({ valid: '2024-05-07', cycle: 17 });
    expect(outlookCandidates(2, T)[0]).toEqual({ valid: '2024-05-08', cycle: 20 });
    expect(outlookCandidates(4, T)[0]).toEqual({ valid: '2024-05-10', cycle: 10 });
    expect([outlookCategory(0, 0), outlookCategory(0, 1), outlookCategory(1, 2), outlookCategory(2, 1), outlookCategory(5, 1)]).toEqual(['CATEGORICAL', 'TORNADO', 'HAIL', 'ANY SEVERE', 'ANY SEVERE']);
    const o = json('iem-spc-outlook.json').features;
    expect(o.map((f: any) => `${f.properties.category} ${f.properties.threshold}`).sort()).toEqual(['CATEGORICAL HIGH', 'CATEGORICAL MDT', 'TORNADO 0.30', 'TORNADO SIGN']);
    expect(Date.parse(o[0].properties.product_issue)).toBeLessThanOrEqual(T);
  });

  it('builds storm-attribute products of one radar under their own volume time', () => {
    const sets = iemStormProducts(json('iem-nexrad-attr.json'), 'KTLX');
    expect(sets).toHaveLength(1);
    const vol = utc('2024-05-06T22:29:59Z'), sti = sets[0].get('58sti') as any, hail = sets[0].get('p59hi') as any, md = sets[0].get('141md') as any, tvs = sets[0].get('61tvs') as any;
    expect([...sets[0].values()].every((p) => p.volumeTimeMs === vol)).toBe(true);
    expect(sti.cells.map((c: any) => c.id)).toEqual(['L1', 'N0', 'J0', 'D0', 'P1']); // the two KINX cells are not this radar's
    // N0: 294° at 170 nm → west-northwest of the radar.
    expect(sti.cells[1].x).toBeCloseTo(170 * 1.852 * Math.sin((294 * Math.PI) / 180), 3);
    expect(sti.cells[1].y).toBeCloseTo(170 * 1.852 * Math.cos((294 * Math.PI) / 180), 3);
    // The rows parse like the Level 3 STI and storm-structure tables (the layer's own patterns).
    expect(/^\s*([A-Z]\d)\s+\d+\/\s*\d+\s+(\d+)\/\s*(\d+)/.exec(sti.pages[0][1])!.slice(1)).toEqual(['N0', '245', '35']);
    expect(/^\s*([A-Z]\d)\s+\d+\/\s*\d+\s+[\d.]+\s+[\d.]+\s+\d+\s+(\d+)/.exec((sets[0].get('p62ss') as any).pages[0][1])!.slice(1)).toEqual(['N0', '63']);
    expect(hail.hail[1]).toMatchObject({ poh: 100, posh: 80, maxSizeIn: 8 }); // 2.00 in, in quarter inches
    expect(md.features).toHaveLength(5);
    expect(tvs.tvs).toEqual([]);
    // Matched to a radar frame by volume time, with or without a Level 3 scan number; never to a neighbouring volume.
    expect(matchVolume([sti], vol + 800)).toBe(sti);
    expect(matchVolume([sti], vol + 800, undefined, 17)).toBe(sti);
    expect(matchVolume([sti], vol + 4 * 60e3)).toBeNull();
    expect(iemStormProducts(json('iem-nexrad-attr.json'), 'KOKC')).toEqual([]);
  });

  it('caches only periods that ended more than a day ago, and validates the dialog time', () => {
    const now = utc('2026-11-18T12:00:00Z');
    expect([archiveCache(T, now), archiveCache(now - 3600e3, now)]).toEqual(['immutable', 'none']);
    expect(parseUtc('2024-05-06', '22:30')).toBe(T);
    expect(parseUtc('2024-5-6', '2230z')).toBe(T);
    expect([parseUtc('2024-02-31', '10:00'), parseUtc('2024-05-06', '25:00'), parseUtc('06/05/2024', '10:00'), parseUtc('2024-05-06', '')]).toEqual([null, null, null, null]);
    expect(archiveBadge(T)).toBe('ARCHIVE 2024-05-06 22:30Z');
  });
});

describe('results requested under another mode or archive time', () => {
  /** Requests wait until the test answers them. */
  const held = () => {
    const calls: { url: string; answer: (body: unknown) => void }[] = [];
    vi.stubGlobal('fetch', (url: string) => new Promise((resolve) => calls.push({ url: String(url), answer: (body) => resolve(new Response(JSON.stringify(body))) })));
    return calls;
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const layer = () => { settings.set('layerState.TORWarningsOn', true); settings.set('layerState.SevereWatchesOn', false); return new WarningsLayer({ camera: { cur: { z: 5 } } } as never, {} as never); };
  const answerIem = (calls: ReturnType<typeof held>) => {
    for (const c of calls) c.answer(c.url.includes('sbw_interval') ? json('iem-sbw-interval.json') : c.url.includes('sbw.php') ? json('iem-sbw-issuance.json') : { features: [] });
  };

  it('archived warnings are applied for their own time and discarded after a switch to live or another time', async () => {
    const calls = held(), l = layer();
    timeline.setArchive(T);
    const first = l.refresh();
    await flush();
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['mesonet.agron.iastate.edu', 'mesonet.agron.iastate.edu']); // never the active-alerts API
    expect(calls[0].url).toContain('begints=2024-05-06T13:30:00Z&endts=2024-05-06T22:31:00Z&only_new=false');
    answerIem(calls);
    await first;
    expect(l.alerts).toHaveLength(8);
    expect(l.activeAt(utc('2024-05-06T21:40:00Z')).map((a) => `${a.type!.code} ${a.etn}`).sort()).toEqual(['SVR 0367', 'SVR 0369', 'TOR 0094']);

    // Moving the archive time drops what is held at once; the answer for the old time is not applied.
    calls.length = 0;
    timeline.setArchive(T - 86400e3);
    const second = l.refresh();
    expect(l.alerts).toEqual([]);
    await flush();
    timeline.setArchive(null);
    answerIem(calls);
    await second;
    expect(l.alerts).toEqual([]);
  });

  it('a live poll that settles in archive mode is discarded and announces nothing', async () => {
    const calls = held(), l = layer(), announced: unknown[] = [];
    l.onNew = (a) => announced.push(a);
    const live = l.refresh();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('api.weather.gov/alerts?');
    timeline.setArchive(T);
    const feature = { properties: { id: 'urn:live', event: 'Tornado Warning', sent: new Date().toISOString(), expires: new Date(Date.now() + 1800e3).toISOString(), parameters: {} }, geometry: { type: 'Polygon', coordinates: [[[-97, 35], [-96, 35], [-96, 36], [-97, 35]]] } };
    calls[0].answer({ features: [feature] });
    await flush();
    calls[1]?.answer({ features: [feature] }); // the active-alerts request, when it was made
    await live;
    expect(l.alerts).toEqual([]);
    expect(announced).toEqual([]);
  });
});
