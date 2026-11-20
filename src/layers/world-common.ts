// Shared pieces of the Worldwide Weather layers (RainViewer radar mosaic, NOAA GMGSI satellite mosaic): frame choice
// for a map time, on-map attribution links and short UTC labels.

/** A source credit shown on the map while a layer is enabled. */
export interface Attribution { text: string; href: string; title: string }

export const hhmmZ = (t: number) => `${new Date(t).toISOString().slice(11, 16)} UTC`;
/** Date and time for map labels (archive times are days or years back). */
export const dateTimeZ = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The frame shown at map time `t`: the newest one at or before `t` (one minute of slack for timeline steps) that is
 * at most `matchMs` older, or at most `newestMs` older when it is the newest frame listed (its successor is not
 * published yet). Null when no frame is valid: the layer then draws nothing rather than an older or newer frame.
 */
export function pickValidFrame<T extends { t: number }>(frames: readonly T[], t: number, newestListed: number, matchMs: number, newestMs: number): T | null {
  let best: T | null = null;
  for (const f of frames) if (f.t <= t + 60e3 && (!best || f.t > best.t)) best = f;
  if (!best) return null;
  return t - best.t <= (best.t >= newestListed ? newestMs : matchMs) ? best : null;
}
