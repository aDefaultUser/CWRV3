// Archive replay helpers: UTC date/time text, the status badge text and event presets (built-in and saved).
import type { View } from '../render/camera';
import { loadPref, savePref, isArray } from './persist';

/** "2024-05-06" + "22:30" (UTC) → epoch ms, or null when either part is not a valid date or time. */
export function parseUtc(date: string, time: string): number | null {
  const d = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(date), h = /^\s*(\d{1,2}):?(\d{2})\s*Z?\s*$/i.exec(time);
  if (!d || !h) return null;
  const t = Date.UTC(+d[1], +d[2] - 1, +d[3], +h[1], +h[2]), back = new Date(t);
  // Date.UTC rolls 02-31 or 25:00 over instead of failing.
  return back.getUTCMonth() === +d[2] - 1 && back.getUTCDate() === +d[3] && back.getUTCHours() === +h[1] && +h[2] < 60 ? t : null;
}
export const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);
export const utcTime = (t: number) => new Date(t).toISOString().slice(11, 16);
/** Status badge text: "ARCHIVE 2024-05-06 22:30Z". */
export const archiveBadge = (t: number) => `ARCHIVE ${utcDate(t)} ${utcTime(t)}Z`;

export interface ArchivePreset { name: string; t: number; site: string; view?: View }

/**
 * Built-in events; each was checked to have Level 2 volumes in the public archive at this time. Level 3, MRMS,
 * ProbSevere and GOES-R products exist only for the later ones and show as not available otherwise.
 */
export const BUILTIN_PRESETS: readonly ArchivePreset[] = [
  { name: '2011-04-27 Tuscaloosa–Birmingham, AL tornado', t: Date.UTC(2011, 3, 27, 22, 30), site: 'KBMX' },
  { name: '2013-05-20 Moore, OK tornado', t: Date.UTC(2013, 4, 20, 20, 30), site: 'KTLX' },
  { name: '2021-12-10 Mayfield, KY tornado', t: Date.UTC(2021, 11, 11, 3, 40), site: 'KPAH' },
  { name: '2024-05-06 Barnsdall, OK tornado', t: Date.UTC(2024, 4, 7, 2, 50), site: 'KINX' },
];

const KEY = 'archivePresets';
const valid = (p: unknown): p is ArchivePreset => !!p && typeof (p as ArchivePreset).name === 'string' && Number.isFinite((p as ArchivePreset).t) && typeof (p as ArchivePreset).site === 'string';
/** Presets the user saved (name, UTC time, radar site and map view). */
export const archivePresets = {
  list: loadPref<unknown[]>(KEY, [], isArray).filter(valid),
  add(p: ArchivePreset) { this.list.push(p); return savePref(KEY, this.list, 'archive presets'); },
  remove(i: number) { this.list.splice(i, 1); return savePref(KEY, this.list, 'archive presets'); },
};
