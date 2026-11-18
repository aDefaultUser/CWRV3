// Storm-attribute (Level 3 overlay) products matched to the displayed radar volume by volume start time.

/**
 * All products of one volume carry its start time: the Level 2 volume header and every Level 3 product of that volume
 * agree to within a second, while consecutive volumes are at least ~4 min apart (VCP 12/212 with SAILS). Half that
 * spacing finds the displayed volume's own product and never a neighbour's.
 */
export const VOLUME_MATCH_TOL_MS = 2 * 60e3;
/** Longest volume (VCP 31/35, ~10 min) with margin: a Level 3 cut is at most this long after its volume's start. */
export const VOLUME_MAX_MS = 15 * 60e3;
/** A product is listed (TGFTP modification time, whole minutes) 1–8 min after its volume starts; this bounds it. */
export const LISTING_LAG_MAX_MS = 20 * 60e3;

/**
 * The product of the displayed volume, or null; the input order does not matter. A volume start time (Level 2 frame)
 * matches the product nearest it within `tolMs`. A Level 3 frame gives its RPG volume scan number `scan` too: its
 * SAILS/MRLE cuts carry their own start time, so it matches the product of that scan number that started at most
 * VOLUME_MAX_MS before it (scan numbers repeat only after 80 volumes).
 */
export function matchVolume<T extends { volumeTimeMs: number; volumeScan?: number }>(products: Iterable<T>, frameT: number, tolMs = VOLUME_MATCH_TOL_MS, scan?: number): T | null {
  let best: T | null = null, bestD = Infinity;
  for (const p of products) {
    const d = Math.abs(p.volumeTimeMs - frameT);
    const same = scan === undefined ? d <= tolMs : p.volumeScan === scan && p.volumeTimeMs <= frameT + tolMs && frameT - p.volumeTimeMs <= VOLUME_MAX_MS;
    if (same && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/**
 * Listed product files worth reading for the loop, newest first: listed within [from, to] and, when radar frames are
 * given, listed up to LISTING_LAG_MAX_MS after one of them (a volume time is only known once read); at most `cap`.
 */
export function overlayFiles<T extends { t: number }>(files: T[], frames: number[], from: number, to: number, cap = Infinity): T[] {
  return files
    .filter((f) => f.t >= from && f.t <= to && (!frames.length || frames.some((ft) => f.t >= ft - 60e3 && f.t <= ft + LISTING_LAG_MAX_MS)))
    .sort((a, b) => b.t - a.t)
    .slice(0, cap);
}
