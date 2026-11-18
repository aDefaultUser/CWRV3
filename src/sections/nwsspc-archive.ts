// NWS/SPC products for an archive time from the Iowa Environmental Mesonet: local storm reports, SPC mesoscale
// discussions, WPC mesoscale precipitation discussions and the SPC convective outlook that was current.
import { iemFeatures, isoZ, polygonRings, type IemFeature } from '../data/iem';
import { lsrTypeIndex, type Lsr } from './nwsspc';

const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace(/[-T:]/g, '');

export function archiveLsrs(features: IemFeature[]): Lsr[] {
  return features.flatMap((f) => {
    const p = f.properties, t = Date.parse(p.valid), lon = Number(p.lon), lat = Number(p.lat);
    if (!Number.isFinite(t) || !Number.isFinite(lon) || !Number.isFinite(lat)) return [];
    return [{ lon, lat, t, type: lsrTypeIndex(String(p.typetext ?? '')), typeText: String(p.typetext ?? ''), mag: typeof p.magf === 'number' ? p.magf : null, wfo: String(p.wfo ?? ''),
      city: String(p.city ?? ''), county: String(p.county ?? ''), state: String(p.st ?? p.state ?? ''), source: String(p.source ?? ''), remark: String(p.remark ?? '') }];
  });
}
/** Reports with an event time in [fromMs, toMs]. */
export const loadArchiveLsrs = async (fromMs: number, toMs: number) => archiveLsrs(await iemFeatures(`/geojson/lsr.php?sts=${stamp(fromMs)}&ets=${stamp(toMs + 60e3)}`, toMs));

export interface ArchiveDiscussion { title: string; text: string; t: number; until: number; ring: number[] }
/** MCD/MPD features → discussions with their polygon and the period (issue to expiry) they were in effect. */
export function archiveDiscussions(features: IemFeature[], kind: 'Mesoscale Discussion' | 'Mesoscale Precipitation Discussion'): ArchiveDiscussion[] {
  return features.flatMap((f) => {
    const p = f.properties, t = Date.parse(p.issue), until = Date.parse(p.expire), ring = polygonRings(f.geometry)[0];
    return ring && until > t ? [{ title: `${kind} ${p.num}`, text: `CONCERNING...${p.concerning ?? ''}`, t, until, ring }] : [];
  });
}
/** Discussions issued up to `hours` before `toMs` (IEM's `hours` look-back), which covers the loop and those still valid at its start. */
export async function loadArchiveDiscussions(toMs: number, hours: number): Promise<ArchiveDiscussion[]> {
  const q = `valid=${isoZ(toMs)}&hours=${Math.ceil(hours)}`;
  const [mcd, mpd] = await Promise.all([iemFeatures(`/api/1/nws/spc_mcd.geojson?${q}`, toMs), iemFeatures(`/api/1/nws/wpc_mpd.geojson?${q}`, toMs).catch(() => [])]);
  return [...archiveDiscussions(mcd, 'Mesoscale Discussion'), ...archiveDiscussions(mpd, 'Mesoscale Precipitation Discussion')];
}

/** Issuance hours (UTC) of the convective outlook by day index; IEM names an outlook by its valid date and this hour. */
const CYCLES = [[1, 6, 13, 16, 20], [6, 7, 17], [7, 8, 19, 20], [8, 9, 10]];
/**
 * Outlooks of day index `day` (0-based) that can have been issued by `t`, newest first, as IEM's (valid date, cycle).
 * The valid date is the first calendar day of the outlook period: the issuance day plus the day index, and for the
 * 01Z Day 1 update the day before it.
 */
export function outlookCandidates(day: number, t: number, backHours = 36): { valid: string; cycle: number }[] {
  const cycles = CYCLES[Math.min(day, 3)], out: { valid: string; cycle: number }[] = [];
  // Products go out up to an hour before their nominal time (the 2000Z outlook at about 1945Z).
  for (let h = Math.floor((t + 3600e3) / 3600e3) * 3600e3; h > t - backHours * 3600e3; h -= 3600e3) {
    const d = new Date(h), cycle = d.getUTCHours();
    if (!cycles.includes(cycle)) continue;
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (day === 0 && cycle < 5 ? -1 : day) * 86400e3;
    out.push({ valid: new Date(first).toISOString().slice(0, 10), cycle });
  }
  return out;
}
/** IEM outlook category of a display family (0 categorical, 1 tornado or Day 3+ probabilistic, 2 hail, 3 wind). */
export const outlookCategory = (day: number, fam: number) => (fam === 0 ? 'CATEGORICAL' : day >= 2 ? 'ANY SEVERE' : ['', 'TORNADO', 'HAIL', 'WIND'][fam]);

/** The newest outlook of the day index issued at or before `t`, or null when IEM has none. */
export async function loadArchiveOutlook(day: number, t: number): Promise<{ features: IemFeature[]; issued: number } | null> {
  for (const c of outlookCandidates(day, t)) {
    const features = await iemFeatures(`/api/1/nws/spc_outlook.geojson?day=${day + 1}&valid=${c.valid}&cycle=${c.cycle}`, t);
    const issued = Date.parse(features[0]?.properties.product_issue ?? '');
    if (features.length && issued <= t) return { features, issued };
  }
  return null;
}
