// Main timeline: loop window, frame stepping, playback with frame times, loop-time clamps and end delay.
import { settings } from '../settings/store';

export type TimelineListener = () => void;

export class Timeline {
  /** Current map time (epoch ms). */
  t = Date.now();
  start = Date.now() - 3 * 3600e3;
  end = Date.now();
  playing = false;
  /** Discrete frame times used for stepping; set by the controlling layer (NEXRAD when wrapping is on). */
  frames: number[] = [];
  /** Layer whose frames drive stepping: general, nexrad-l2/l3, mrms, model, … (wrap-to-loop rules). */
  controller: string = 'general';
  /** When set, "now" for the loop window (fixed archive data in benchmarks and recorded-reference playback). */
  anchor: number | null = null;
  private listeners = new Set<TimelineListener>();
  private holdUntil = 0;
  private live = true;

  on(fn: TimelineListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const f of this.listeners) f(); }

  get loopHours() { return settings.num('ext.layerState.LoopLength'); }

  /** Recomputes the loop window from "now" and the loop length; keeps live position when idle at the end. */
  refreshWindow(now = Date.now(), nexradOldest: number | null = null) {
    if (this.controller === 'model' && settings.num('ext.layerState.TimelineSelect') === 1) { this.emit(); return; }
    if (this.anchor !== null) now = this.anchor;
    this.end = now;
    this.start = now - this.loopHours * 3600e3;
    if (nexradOldest !== null && settings.bool('settings.nexradTimelineConstrain')) this.start = Math.max(this.start, nexradOldest);
    if (this.live && !this.playing) this.t = this.end;
    this.t = Math.min(this.end, Math.max(this.start, this.t));
    if (!this.frames.length || this.controller === 'general') this.frames = this.generalFrames();
    this.emit();
  }

  /** General timeline steps: 5-minute frames across the loop window. */
  generalFrames(): number[] {
    const step = 5 * 60e3, out: number[] = [];
    const first = Math.ceil(this.start / step) * step;
    for (let x = first; x <= this.end; x += step) out.push(x);
    if (!out.length || out[out.length - 1] < this.end) out.push(this.end);
    return out;
  }

  setFrames(frames: number[], controller: Timeline['controller']) {
    this.controller = controller;
    if (controller === 'model') {
      // The Model timeline spans the loaded forecast valid times (future), not the observation loop window.
      this.frames = [...frames].sort((a, b) => a - b);
      this.start = this.frames[0]; this.end = this.frames[this.frames.length - 1];
      if (this.t < this.start || this.t > this.end) this.t = this.start;
      this.emit();
      return;
    }
    const f = frames.filter((x) => x >= this.start - 1 && x <= this.end + 60e3).sort((a, b) => a - b);
    this.frames = f.length ? f : this.generalFrames();
    this.emit();
  }

  /** Per-frame display time in ms: setting by controller, adjusted to the min/max loop-time overrides. */
  frameMs(): number {
    const base = this.controller === 'nexrad-l2' ? settings.num('settings.generalLoopSpeedLevel2FrameTime')
      : this.controller === 'nexrad-l3' ? settings.num('settings.generalLoopSpeedLevel3FrameTime')
      : this.controller === 'mrms' ? settings.num('settings.mrmsFrameTime')
      : this.controller === 'model' ? this.modelFrameMs()
      : settings.num('settings.generalLoopSpeedFrameTime');
    const n = Math.max(1, this.frames.length);
    const loop = base * n;
    const minLoop = settings.num('settings.generalLoopSpeedMinLoopTime'), maxLoop = settings.num('settings.generalLoopSpeedMaxLoopTime');
    if (loop < minLoop) return minLoop / n;
    if (loop > maxLoop) return maxLoop / n;
    return base;
  }

  /**
   * Model timeline: modelLoopBase is spread over the loop and modelLoopPerFrame is added per forecast hour
   * between frames (interpretation of the LoopBaseTime / LoopPerHourFrameTime settings).
   */
  private modelFrameMs(): number {
    const f = this.frames, n = Math.max(1, f.length);
    let i = f.findIndex((x) => x > this.t + 1); if (i <= 0) i = 1;
    const gapH = f.length > 1 ? Math.max(1, (f[Math.min(i, f.length - 1)] - f[i - 1]) / 3600e3) : 1;
    return settings.num('settings.modelLoopBase') / n + settings.num('settings.modelLoopPerFrame') * gapH;
  }

  play(on = !this.playing) { this.playing = on; this.live = false; if (on && this.t >= this.end - 1) this.t = this.frames[0] ?? this.start; this.emit(); }
  first() { this.live = false; this.t = this.frames[0] ?? this.start; this.emit(); }
  last() { this.live = true; this.t = this.end; this.emit(); }
  step(dir: 1 | -1) {
    this.live = false;
    const f = this.frames;
    if (!f.length) return;
    let i = f.findIndex((x) => x > this.t + 1);
    if (i < 0) i = f.length;
    const cur = Math.max(0, i - 1);
    const next = Math.min(f.length - 1, Math.max(0, cur + dir));
    this.t = f[next];
    if (next === f.length - 1 && dir > 0) this.live = true;
    this.emit();
  }
  scrub(frac: number) { this.live = frac >= 0.999; this.t = this.start + (this.end - this.start) * frac; this.emit(); }

  /** Advances playback; returns true when the time changed. With interpolation on, time advances smoothly. */
  tick(now: number, dtMs: number, interpolate: boolean): boolean {
    if (!this.playing) return false;
    if (now < this.holdUntil) return false;
    const f = this.frames;
    if (f.length < 2) return false;
    const fm = this.frameMs();
    let i = f.findIndex((x) => x > this.t + 1);
    if (i < 0) {
      this.holdUntil = now + settings.num(this.controller === 'model' ? 'settings.modelLoopEndDelay' : 'settings.generalLoopSpeedEndDelay');
      this.t = f[0];
      this.emit();
      return true;
    }
    const prev = f[Math.max(0, i - 1)], next = f[i];
    if (interpolate) {
      this.t = Math.min(next, this.t + ((next - prev) * dtMs) / fm);
    } else {
      this.acc = (this.acc ?? 0) + dtMs;
      if (this.acc < fm) return false;
      this.acc = 0;
      this.t = next;
    }
    if (this.t >= f[f.length - 1] - 1) { this.t = f[f.length - 1]; this.holdUntil = now + settings.num(this.controller === 'model' ? 'settings.modelLoopEndDelay' : 'settings.generalLoopSpeedEndDelay'); }
    this.emit();
    return true;
  }
  private acc?: number;
}

/** Bracketing frames for a time: a ≤ t < b and the interpolation weight (0 when blending is off or the gap is large). */
export function bracket<T extends { t: number }>(frames: T[], t: number, blend: boolean, maxGapMs = 20 * 60e3): { a: T | null; b: T | null; w: number } {
  if (!frames.length) return { a: null, b: null, w: 0 };
  let a: T | null = null, b: T | null = null;
  for (const f of frames) { if (f.t <= t) a = f; else { b = f; break; } }
  if (!a) return { a: frames[0], b: null, w: 0 };
  if (!b || !blend || b.t - a.t > maxGapMs) return { a, b: null, w: 0 };
  return { a, b, w: (t - a.t) / (b.t - a.t) };
}

export const timeline = new Timeline();
