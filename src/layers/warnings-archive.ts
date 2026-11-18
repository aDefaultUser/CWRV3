// Warnings and watches for an archive time from the Iowa Environmental Mesonet: storm-based warning polygons with
// the period each polygon version was in effect, issuance impact tags, and SPC watch outlines.
import { iemFeatures, isoZ, polygonRings, type IemFeature } from '../data/iem';
import { WARN_TYPES, type Alert } from './warnings';

/** VTEC phenomena of the warning types drawn (Special Weather Statements have no VTEC and are not archived here). */
const PHENOMENA: Record<string, string> = { TO: 'TOR', SV: 'SVR', SQ: 'SQW', MA: 'SMW', FF: 'FFW', EW: 'EWW' };
const eventKey = (p: Record<string, any>) => `${p.wfo}.${p.phenomena}.${p.eventid}.${p.year}`;

/**
 * One alert per polygon version (`sbw_interval` with only_new=false): shown from utc_polygon_begin until
 * utc_polygon_end, when an update, cancellation or expiry replaced it. `issuance` (`geojson/sbw.php` over the same
 * period) carries the impact tags of the issuance product; they are attached to that product's polygon only, since a
 * later statement may have changed them.
 */
export function archiveAlerts(versions: IemFeature[], issuance: IemFeature[] = []): Alert[] {
  const tags = new Map(issuance.map((f) => [String(f.properties.product_id), f.properties]));
  const out: Alert[] = [];
  for (const f of versions) {
    const p = f.properties, type = WARN_TYPES.find((w) => w.code === PHENOMENA[p.phenomena]);
    const rings = polygonRings(f.geometry), sent = Date.parse(p.utc_polygon_begin), ends = Date.parse(p.utc_polygon_end);
    if (!type || p.significance !== 'W' || !rings.length || !(ends > sent)) continue;
    const t = tags.get(String(p.product_id)) ?? {};
    out.push({
      id: `${eventKey(p)}@${p.utc_polygon_begin}`, type, event: type.event, sent, ends, expires: Date.parse(p.utc_expire), rings,
      headline: `${type.event} ${p.wfo} ${p.eventid} (${p.status})`, description: '', area: p.locations ?? '', wfo: p.wfo ?? '', etn: String(p.eventid ?? '').padStart(4, '0'),
      hail: t.hailtag != null ? Number(t.hailtag).toFixed(2) : '', wind: t.windtag != null ? `${t.windtag} MPH` : '', damage: t.damagetag ?? t.floodtag_damage ?? '',
      tornado: t.tornadotag ?? '', motion: '', zones: String(p.ugclist ?? '').split(/,\s*/).filter(Boolean), pds: !!(t.is_pds || t.is_emergency), refs: [],
    });
  }
  return out.sort((a, b) => a.sent - b.sent);
}

/** SPC watch outlines (`spc_watch_outline`): the issued four-sided outline, in effect from issue to expiry. */
export function archiveWatches(features: IemFeature[]): Alert[] {
  const byId = new Map<string, Alert>();
  for (const f of features) {
    const p = f.properties, sent = Date.parse(p.utc_issued), ends = Date.parse(p.utc_expired), rings = polygonRings(f.geometry);
    if (!rings.length || !(ends > sent) || (p.type !== 'TOR' && p.type !== 'SVR')) continue;
    const event = p.type === 'TOR' ? 'Tornado Watch' : 'Severe Thunderstorm Watch', id = `watch.${p.num}.${p.utc_issued}`;
    byId.set(id, { id, type: null, event, sent, ends, expires: ends, rings, headline: `${event} ${p.num}`, description: '', area: '', wfo: 'SPC', etn: String(p.num ?? ''),
      hail: '', wind: '', damage: '', tornado: '', motion: '', zones: [], pds: !!p.is_pds, refs: [] });
  }
  return [...byId.values()];
}

/** Warnings and watches in effect at some time in [fromMs, toMs]; watch outlines are sampled every two hours. */
export async function loadArchiveWarnings(fromMs: number, toMs: number, watches: boolean): Promise<{ alerts: Alert[]; watches: Alert[] }> {
  // Warnings are searched by issuance time: flash-flood warnings issued up to six hours earlier can still be valid.
  const begin = isoZ(fromMs - 6 * 3600e3), end = isoZ(toMs + 60e3);
  const [versions, issuance] = await Promise.all([
    iemFeatures(`/api/1/vtec/sbw_interval.geojson?begints=${begin}&endts=${end}&only_new=false`, toMs),
    iemFeatures(`/geojson/sbw.php?sts=${begin}&ets=${end}`, toMs).catch(() => []), // tags are optional
  ]);
  const times: number[] = [];
  for (let t = toMs; watches && t > fromMs - 2 * 3600e3; t -= 2 * 3600e3) times.push(Math.max(fromMs, t));
  const outlines = (await Promise.all(times.map((t) => iemFeatures(`/api/1/spc_watch_outline.geojson?valid=${isoZ(t)}`, toMs)))).flat();
  return { alerts: archiveAlerts(versions, issuance).filter((a) => a.ends > fromMs && a.sent <= toMs), watches: archiveWatches(outlines) };
}
