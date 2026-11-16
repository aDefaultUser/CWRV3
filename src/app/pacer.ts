// Frame pacing for requestAnimationFrame. The render loop runs on every RAF and asks the pacer whether this display
// refresh should render under the current FPS limit (0 = unlimited: every refresh renders, the browser's vsync is
// the only bound).
//
// The limit is applied in display refreshes, not milliseconds: each RAF delta is rounded to whole refreshes and a
// signed phase is carried between rendered frames. That keeps two properties that a millisecond threshold cannot:
//  * RAF timestamp jitter never skips a refresh (a delta of 5.4 or 5.7 ms is one 180 Hz refresh either way);
//  * fractional ratios average to the limit exactly (50 fps at 180 Hz alternates 4 and 3 refreshes; at 60 Hz it
//    renders 5 of every 6), instead of rounding up to the next divisor of the refresh rate.
// A limit within LOCK_TOLERANCE of an integer divisor of the measured refresh locks to that divisor, so a 60 fps
// limit on a 179.9 or 180.1 Hz panel renders every third refresh rather than inserting a periodic 4-refresh frame
// to correct a 0.05 % rate difference.

/** Relative tolerance for locking a limit to an integer number of refreshes. */
export const LOCK_TOLERANCE = 0.005;
const WINDOW = 120;

export class FramePacer {
  /** Display refresh period estimate (ms). */
  period = 1000 / 60;
  private deltas: number[] = [];
  private lastRaf = 0;
  /** Refreshes since the last rendered frame, plus the signed phase carried from earlier frames. */
  private phase = 0;

  /** Feeds one RAF timestamp; returns true when this refresh should render at `fps` (≤ 0 or non-finite = unlimited). */
  tick(now: number, fps: number): boolean {
    const first = this.lastRaf === 0;
    const dt = first ? 0 : now - this.lastRaf;
    this.lastRaf = now;
    if (first) { this.phase = 0; return true; }
    this.observe(dt);
    const step = this.refreshesPerFrame(fps);
    if (step <= 1) { this.phase = 0; return true; }
    this.phase += Math.max(1, Math.round(dt / this.period));
    if (this.phase < step - 0.5) return false;
    // Rendering at the nearest refresh leaves a signed error in [-0.5, 0.5) refreshes, carried to keep the average
    // exact. More than half a refresh behind means refreshes were missed (a stall): resynchronise instead of
    // catching up with a burst of short frames.
    const carry = this.phase - step;
    this.phase = carry >= 0.5 ? 0 : carry;
    return true;
  }

  /** Display refreshes per rendered frame for an FPS limit (1 = every refresh). */
  refreshesPerFrame(fps: number): number {
    if (!(fps > 0) || !Number.isFinite(fps)) return 1;
    const n = 1000 / fps / this.period;
    const k = Math.round(n);
    if (k >= 1 && Math.abs(n - k) <= k * LOCK_TOLERANCE) return k;
    return Math.max(1, n);
  }

  /** Refresh period: mean of recent deltas near their median (robust to missed refreshes and timer coarsening). */
  private observe(dt: number) {
    if (!(dt > 0) || dt > 250) return;
    this.deltas.push(dt);
    if (this.deltas.length > WINDOW) this.deltas.shift();
    if (this.deltas.length < 8) return;
    const sorted = [...this.deltas].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    let sum = 0, n = 0;
    for (const d of this.deltas) if (d > median * 0.75 && d < median * 1.25) { sum += d; n++; }
    this.period = n ? sum / n : median;
  }
}

export interface PacingState { interacting: boolean; loopPlaying: boolean; animating: boolean }
export interface FpsLimits { target: number; loop: number; idle: number }

/**
 * Effective FPS limit for the current state (0 = unlimited). `target` is the overall limit; the loop and idle
 * limits can only lower it (0 = follow the target), so there is a single ceiling and no competing cap.
 */
export function fpsLimit(l: FpsLimits, s: PacingState): number {
  const lower = (a: number, b: number) => (a > 0 && b > 0 ? Math.min(a, b) : a > 0 ? a : b > 0 ? b : 0);
  if (s.interacting) return l.target;
  if (s.loopPlaying) return lower(l.target, l.loop);
  if (s.animating) return l.target;
  return lower(l.target, l.idle);
}
