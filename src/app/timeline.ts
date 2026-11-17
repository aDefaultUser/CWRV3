// Main timeline: loop window, frame stepping, playback with frame times, loop-time clamps and end delay.
import { settings } from '../settings/store';

export type TimelineListener = () => void;
export type TimelineController = 'general' | 'nexrad-l2' | 'nexrad-l3' | 'mrms' | 'model';

/**
 * Sources that can own the main timeline, highest priority first. A layer offers its loop only while it is shown and
 * its "Wrap timeline to … loop" option is on; the Model timeline owns it only while selected (TimelineSelect = 1).
 */
const OWNERS: Exclude<TimelineController, 'general'>[] = ['model', 'nexrad-l2', 'nexrad-l3', 'mrms'];

export class Timeline {
  /** Current map time (epoch ms). */
  t = Date.now();
  /** Displayed timeline range (scrub bar): the loop window, the wrapped layer's loop, or the model valid times. */
  start = Date.now() - 3 * 3600e3;
  end = Date.now();
  /** Observation loop window (now − loop length … now) that data layers load, whatever owns the display. */
  loopStart = Date.now() - 3 * 3600e3;
  loopEnd = Date.now();
  playing = false;
  /** Discrete frame times used for stepping and playback: the owner's frames, or 5-minute general frames. */
  frames: number[] = [];
  /** Owner of the frames and of the frame time (resolved from the offers; never set directly). */
  controller: TimelineController = 'general';
  /** When set, "now" for the loop window (fixed archive data in benchmarks and recorded-reference playback). */
  anchor: number | null = null;
  private listeners = new Set<TimelineListener>();
  private offers = new Map<TimelineController, number[]>();
  /** Start of the current end-of-loop hold (performance time), or null; its length is read when checked. */
  private holdFrom: number | null = null;
  /** Elapsed playback time towards the next discrete step (interpolation off). */
  private acc = 0;
  private resetAt: number | null = null;
  /** Following the newest frame: set by Last, by stepping onto the newest frame and at start-up. */
  private live = true;

  constructor(private clock: () => number = () => performance.now()) {
    settings.on('ext.layerState.TimelineSelect', () => this.resolve());
    settings.on('ext.layerState.LoopLength', () => this.resolve());
  }

  on(fn: TimelineListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const f of this.listeners) f(); }

  get loopHours() { return settings.num('ext.layerState.LoopLength'); }
  /** True while following the newest available frame (Last). */
  get following() { return this.live; }

  /** Recomputes the loop window from "now" (or the anchor) and the loop length, then the owner and its frames. */
  refreshWindow(now = Date.now()) { this.resolve(now); }

  /**
   * A layer offers its loop frames (null or empty withdraws the offer). The highest-priority offer owns the
   * timeline; with none, the general 5-minute timeline does.
   */
  offer(source: Exclude<TimelineController, 'general'>, frames: number[] | null) {
    const prev = this.offers.get(source);
    const next = frames?.length ? [...frames].sort((a, b) => a - b) : null;
    if (next && prev && next.length === prev.length && next.every((x, i) => x === prev[i])) return;
    if (!next && !prev) return;
    if (next) this.offers.set(source, next); else this.offers.delete(source);
    this.resolve();
  }

  private resolve(now = Date.now()) {
    if (this.anchor !== null) now = this.anchor;
    this.loopEnd = now;
    this.loopStart = now - this.loopHours * 3600e3;
    // An observation loop owns the timeline only with frames inside the loop window (an old or shortened loop falls
    // through to the next offer); the Model timeline's frames are future valid times and are not filtered.
    let owner: TimelineController = 'general', own: number[] | null = null;
    for (const o of OWNERS) {
      const offered = this.offers.get(o);
      if (!offered) continue;
      const frames = o === 'model' ? (settings.num('ext.layerState.TimelineSelect') === 1 ? offered : [])
        : offered.filter((x) => x >= this.loopStart - 10 * 60e3 && x <= now + 60e3);
      if (frames.length) { owner = o; own = frames; break; }
    }
    if (owner !== this.controller) { this.controller = owner; this.resetPlayback(); }
    if (owner === 'model') {
      this.frames = own!;
      this.start = own![0]; this.end = own![own!.length - 1];
    } else {
      this.end = now;
      // Wrapped to a layer's loop: the range and steps are that loop's frames.
      this.start = own ? own[0] : this.loopStart;
      this.frames = own ?? this.generalFrames();
    }
    if (this.live && !this.playing) this.t = this.latest();
    this.t = Math.min(this.end, Math.max(this.start, this.t));
    this.emit();
  }

  /** Newest available frame: the last frame of the owner (the general timeline's last frame is "now"). */
  latest(): number { return this.frames[this.frames.length - 1] ?? this.end; }

  /** General timeline steps: 5-minute frames across the loop window. */
  generalFrames(): number[] {
    const step = 5 * 60e3, out: number[] = [];
    const first = Math.ceil(this.loopStart / step) * step;
    for (let x = first; x <= this.loopEnd; x += step) out.push(x);
    if (!out.length || out[out.length - 1] < this.loopEnd) out.push(this.loopEnd);
    return out;
  }

  /**
   * Per-frame display time in ms. The Settings "Loop Speed" page has two columns: NEXRAD-controlled (Level 2,
   * Level 3 and MRMS frame times, applied as set) and General (frame time with the minimum/maximum loop-time
   * overrides, which stretch or shrink the general loop as a whole). The Model timeline has its own settings.
   */
  frameMs(): number { return this.frameTiming().applied; }

  /** The frame time the owner's setting asks for and the one applied (they differ only under a loop-time override). */
  frameTiming(): { setting: string; requested: number; applied: number; override: 'min' | 'max' | null } {
    const id = this.controller === 'nexrad-l2' ? 'settings.generalLoopSpeedLevel2FrameTime'
      : this.controller === 'nexrad-l3' ? 'settings.generalLoopSpeedLevel3FrameTime'
      : this.controller === 'mrms' ? 'settings.mrmsFrameTime'
      : this.controller === 'model' ? 'settings.modelLoopBase'
      : 'settings.generalLoopSpeedFrameTime';
    if (this.controller === 'model') { const ms = this.modelFrameMs(); return { setting: id, requested: ms, applied: ms, override: null }; }
    const base = Math.max(1, settings.num(id));
    if (this.controller !== 'general') return { setting: id, requested: base, applied: base, override: null };
    const n = Math.max(1, this.frames.length);
    const minLoop = settings.num('settings.generalLoopSpeedMinLoopTime'), maxLoop = settings.num('settings.generalLoopSpeedMaxLoopTime');
    if (base * n < minLoop) return { setting: id, requested: base, applied: minLoop / n, override: 'min' };
    if (base * n > maxLoop) return { setting: id, requested: base, applied: Math.max(1, maxLoop / n), override: 'max' };
    return { setting: id, requested: base, applied: base, override: null };
  }

  /** End-of-loop hold (ms): the model's own end delay on the Model timeline, the general end delay otherwise. */
  endDelayMs(): number { return Math.max(0, settings.num(this.controller === 'model' ? 'settings.modelLoopEndDelay' : 'settings.generalLoopSpeedEndDelay')); }

  /**
   * Model timeline: modelLoopBase is spread over the loop and modelLoopPerFrame is added per forecast hour
   * between frames (interpretation of the LoopBaseTime / LoopPerHourFrameTime settings).
   */
  private modelFrameMs(): number {
    const f = this.frames, n = Math.max(1, f.length);
    let i = f.findIndex((x) => x > this.t + 1); if (i <= 0) i = 1;
    const gapH = f.length > 1 ? Math.max(1, (f[Math.min(i, f.length - 1)] - f[i - 1]) / 3600e3) : 1;
    return Math.max(1, settings.num('settings.modelLoopBase') / n + settings.num('settings.modelLoopPerFrame') * gapH);
  }

  private resetPlayback() { this.acc = 0; this.holdFrom = null; this.resetAt = this.clock(); }
  play(on = !this.playing) {
    this.playing = on; this.live = false; this.resetPlayback();
    if (on && this.t >= this.latest() - 1) this.t = this.frames[0] ?? this.start;
    this.emit();
  }
  first() { this.live = false; this.resetPlayback(); this.t = this.frames[0] ?? this.start; this.emit(); }
  /** Skip to end: pauses and shows the newest available frame, then keeps following new frames. */
  last() { this.playing = false; this.live = true; this.resetPlayback(); this.t = this.latest(); this.emit(); }
  step(dir: 1 | -1) {
    this.live = false;
    this.resetPlayback();
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
  scrub(frac: number) { this.live = frac >= 0.999; this.resetPlayback(); this.t = this.live ? this.latest() : this.start + (this.end - this.start) * frac; this.emit(); }

  /**
   * Advances playback by the real elapsed time; returns true when the time changed. With interpolation on, time
   * advances smoothly; off, it steps one frame per frame time (the signed remainder is carried, so a render-rate
   * limit does not slow the loop). Either way a call advances at most one frame, so a stall cannot skip frames. The
   * newest frame is held for the end delay, then playback restarts at the first frame. Timing settings are read on
   * every call, so a change applies to the frame (or hold) in progress.
   */
  tick(now: number, dtMs: number, interpolate: boolean): boolean {
    if (!this.playing) return false;
    const f = this.frames;
    if (f.length < 2) return false;
    // A render interval may begin before Play, a seek or an owner change; count only time after that reset.
    if (this.resetAt !== null) { dtMs = Math.max(0, Math.min(dtMs, now - this.resetAt)); this.resetAt = null; }
    if (this.holdFrom !== null) {
      if (now - this.holdFrom < this.endDelayMs()) return false;
      this.holdFrom = null; this.acc = 0;
      this.t = f[0];
      this.emit();
      return true;
    }
    const i = f.findIndex((x) => x > this.t + 1);
    if (i < 0) { this.holdFrom = now; return false; } // at (or past) the newest frame: hold, then wrap
    const fm = this.frameMs();
    const prev = f[Math.max(0, i - 1)], next = f[i];
    if (interpolate) {
      const t = this.t + ((next - prev) * dtMs) / fm, after = f[i + 1];
      // Time past the next frame carries into the following interval (never beyond its end), so a low render rate
      // does not drop it and slow the loop.
      this.t = t <= next || after === undefined ? Math.min(next, t) : Math.min(after, next + ((t - next) / (next - prev)) * (after - next));
    } else {
      // Steps on the render frame nearest its due time: RAF timestamps jitter by fractions of a millisecond, and at a
      // low render rate waiting for the next render would stretch the frame by a whole render interval.
      this.acc += dtMs;
      if (this.acc < fm - dtMs / 2) return false;
      this.acc = this.acc >= 2 * fm ? 0 : this.acc - fm;
      this.t = next;
    }
    if (this.t >= f[f.length - 1] - 1) { this.t = f[f.length - 1]; this.holdFrom = now; }
    this.emit();
    return true;
  }
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
