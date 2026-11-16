// HRRR from the public NOAA bucket: newest published cycle, and p-type fields valid at a given hour.
import { pool } from '../workers/pool';
import { hrrrUrl } from '../decode/hrrr';
import { fetchText } from './net';
import type { LambertGrid } from '../decode/grib2';


let latestKnown: number | null = null;

/** Newest cycle hour whose .idx is published (checks up to 4 hours back). */
export async function latestCycle(now = Date.now()): Promise<number | null> {
  const h0 = Math.floor(now / 3600e3) * 3600e3;
  for (let k = 0; k < 5; k++) {
    const t = h0 - k * 3600e3;
    if (latestKnown !== null && t <= latestKnown) return latestKnown;
    try { await fetchText(hrrrUrl(new Date(t)) + '.idx'); latestKnown = t; return t; } catch { /* not yet published */ }
  }
  return latestKnown;
}


export interface PtypeGrid { cycleMs: number; fh: number; nx: number; ny: number; grid: LambertGrid; packed: Uint8Array }

/** HRRR valid hour for a data time: the nearest whole hour (the field is used within ±30 min of its valid time). */
export const ptypeValidHour = (t: number) => Math.round(t / 3600e3) * 3600e3;

/**
 * Runs whose forecast is valid at `validMs`, preferred first: f01 of the previous cycle, then f02 and f03 of older
 * cycles (still valid at the same hour, used when the newer run is not yet published or missing from the archive).
 * f00 is never used: its categorical precipitation-type fields are usually empty.
 */
export function ptypeCandidates(validMs: number): { cycleMs: number; fh: number }[] {
  return [1, 2, 3].map((fh) => ({ cycleMs: validMs - fh * 3600e3, fh }));
}

/**
 * Loads the first available HRRR p-type forecast valid at `validMs` (null when none is published). Decoding and
 * packing run in a worker, which returns only the packed RGBA8 texels and the grid definition.
 */
export async function loadPtypeGrid(validMs: number, run: typeof pool.run = pool.run.bind(pool)): Promise<PtypeGrid | null> {
  for (const c of ptypeCandidates(validMs)) {
    let r: { grid: LambertGrid; packed: Uint8Array } | null = null;
    try { r = await run('hrrr.ptype', { url: hrrrUrl(new Date(c.cycleMs), c.fh) }); } catch (err) { console.info(`HRRR p-type f${String(c.fh).padStart(2, '0')} unavailable`, (err as Error).message); continue; }
    if (r) return { cycleMs: c.cycleMs, fh: c.fh, nx: r.grid.nx, ny: r.grid.ny, grid: r.grid, packed: r.packed };
  }
  return null;
}
