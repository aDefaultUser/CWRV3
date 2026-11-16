import { describe, expect, it } from 'vitest';
import { FramePacer, fpsLimit } from '../src/app/pacer';
import { Timeline } from '../src/app/timeline';

/**
 * Simulated display: RAF timestamps at `hz` with small jitter, coarsened to 0.1 ms like Chromium's timers
 * without cross-origin isolation. Returns the refresh index of every rendered frame.
 */
function run(hz: number, fps: number | ((i: number) => number), seconds = 10, opts: { jitter?: number; skip?: Set<number>; pacer?: FramePacer } = {}) {
  const pacer = opts.pacer ?? new FramePacer();
  const period = 1000 / hz;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
  const rendered: number[] = [];
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    if (opts.skip?.has(i)) continue; // the browser missed this refresh
    const t = 1000 + Math.round((i * period + rand() * (opts.jitter ?? 0.2)) * 10) / 10;
    if (pacer.tick(t, typeof fps === 'function' ? fps(i) : fps)) rendered.push(i);
  }
  return { rendered, intervals: rendered.slice(1).map((r, i) => r - rendered[i]), pacer };
}
const settled = (x: { rendered: number[]; intervals: number[] }) => x.intervals.slice(20);
const hist = (xs: number[]) => xs.reduce<Record<number, number>>((h, x) => ((h[x] = (h[x] ?? 0) + 1), h), {});

describe('FramePacer', () => {
  it('renders every refresh when unlimited (0) at any refresh rate', () => {
    for (const hz of [60, 120, 144, 165, 180]) {
      const r = run(hz, 0, 3);
      expect(r.rendered.length).toBe(Math.round(3 * hz));
    }
  });

  it('locks integer ratios to a constant refresh count without periodic long frames', () => {
    // 60 fps at 60/120/180 Hz, including panels slightly off nominal (59.94, 179.9, 180.1 Hz).
    for (const [hz, k] of [[60, 1], [59.94, 1], [120, 2], [119.88, 2], [180, 3], [179.9, 3], [180.1, 3]] as const) {
      const r = run(hz, 60, 60);
      expect(new Set(settled(r)), `${hz} Hz`).toEqual(new Set([k]));
    }
  });

  it('averages fractional ratios to the limit using only the two adjacent refresh counts', () => {
    for (const [hz, fps] of [[144, 60], [165, 60], [60, 50], [120, 50], [144, 50], [165, 50], [180, 50], [180, 144]] as const) {
      const r = run(hz, fps, 30);
      const iv = settled(r);
      const n = hz / fps;
      expect(Object.keys(hist(iv)).map(Number).sort(), `${fps} fps @ ${hz} Hz`).toEqual([Math.floor(n), Math.ceil(n)]);
      const rate = hz / (iv.reduce((s, x) => s + x, 0) / iv.length);
      expect(Math.abs(rate - fps), `${fps} fps @ ${hz} Hz → ${rate.toFixed(2)}`).toBeLessThan(fps * 0.002);
    }
  });

  it('never renders faster than the display or below a limit it can meet', () => {
    for (const hz of [60, 120, 144, 165, 180]) for (const fps of [15, 24, 30, 45, 60, 90, 144, 240]) {
      const iv = settled(run(hz, fps, 20));
      const rate = hz / (iv.reduce((s, x) => s + x, 0) / iv.length);
      expect(rate, `${fps} fps @ ${hz} Hz`).toBeLessThanOrEqual(Math.min(fps, hz) * 1.002 + (Math.min(fps, hz) * 0.005));
      expect(rate, `${fps} fps @ ${hz} Hz`).toBeGreaterThan(Math.min(fps, hz) * 0.99);
    }
  });

  it('does not burst after missed refreshes', () => {
    // A 100 ms main-thread stall at 180 Hz with a 60 fps limit: the next frames resume the 3-refresh cadence.
    const skip = new Set(Array.from({ length: 18 }, (_, i) => 900 + i));
    const r = run(180, 60, 10, { skip });
    const after = r.intervals.filter((_, i) => r.rendered[i] >= 917);
    expect(Math.min(...after)).toBe(3);
  });

  it('applies limit changes on the next eligible refresh', () => {
    // 180 Hz: idle limit 15 (12 refreshes) until refresh 600, then the 60 fps target (3 refreshes).
    const r = run(180, (i) => (i < 600 ? 15 : 60), 6);
    const firstAfter = r.rendered.find((i) => i >= 600)!;
    expect(firstAfter - 600).toBeLessThan(3);
    expect(new Set(r.intervals.filter((_, i) => r.rendered[i] > firstAfter))).toEqual(new Set([3]));
    expect(new Set(r.intervals.slice(5, 40))).toEqual(new Set([12]));
    // Unlimited → 30: the cadence drops at once, without a long gap.
    const u = run(120, (i) => (i < 300 ? 0 : 30), 5);
    const gaps = u.intervals.filter((_, i) => u.rendered[i] >= 300);
    expect(Math.max(...gaps)).toBe(4);
  });

  it('follows a refresh-rate change (window moved to another monitor)', () => {
    const pacer = new FramePacer();
    run(60, 60, 2, { pacer });
    let t = 1000 + 2000;
    const rendered: number[] = [];
    for (let i = 0; i < 1440; i++) { t += 1000 / 144; if (pacer.tick(Math.round(t * 10) / 10, 72)) rendered.push(i); }
    const iv = rendered.slice(-200).map((r, i, a) => (i ? r - a[i - 1] : 2)).slice(1);
    expect(new Set(iv)).toEqual(new Set([2]));
  });
});

describe('fpsLimit', () => {
  const base = { target: 0, loop: 0, idle: 15 };
  it('uses one target; idle and loop limits can only lower it', () => {
    expect(fpsLimit(base, { interacting: true, loopPlaying: true, animating: false })).toBe(0);
    expect(fpsLimit(base, { interacting: false, loopPlaying: true, animating: false })).toBe(0);
    expect(fpsLimit(base, { interacting: false, loopPlaying: false, animating: false })).toBe(15);
    expect(fpsLimit({ target: 60, loop: 50, idle: 15 }, { interacting: false, loopPlaying: true, animating: false })).toBe(50);
    expect(fpsLimit({ target: 30, loop: 50, idle: 90 }, { interacting: false, loopPlaying: true, animating: false })).toBe(30);
    expect(fpsLimit({ target: 30, loop: 50, idle: 90 }, { interacting: false, loopPlaying: false, animating: false })).toBe(30);
    expect(fpsLimit({ target: 0, loop: 0, idle: 0 }, { interacting: false, loopPlaying: false, animating: false })).toBe(0);
    expect(fpsLimit({ target: 120, loop: 0, idle: 0 }, { interacting: false, loopPlaying: false, animating: true })).toBe(120);
  });

  it('keeps one cadence through real loop playback with end-of-loop holds (the visible 180 Hz regression)', () => {
    // The l2loop benchmark dropped to the 50 fps loop limit for ~100 ms of every 500 ms end-of-loop hold, because
    // the timeline's per-frame updates (absent during holds) counted as interaction. Drive the real Timeline
    // through several loops at 180 Hz with a 60 fps target and a lower 50 fps loop limit: the loop limit applies
    // for the whole playback, holds included.
    const tl = new Timeline();
    tl.anchor = Date.UTC(2024, 4, 6, 23);
    tl.refreshWindow();
    tl.setFrames(Array.from({ length: 8 }, (_, i) => tl.end - (7 - i) * 6 * 60e3), 'nexrad-l2');
    tl.play(true);
    const pacer = new FramePacer();
    const limits = { target: 60, loop: 50, idle: 15 };
    const rendered: number[] = [];
    let held = 0, last = 0;
    for (let i = 0; i < 180 * 30; i++) {
      const now = 1000 + Math.round((i * 1000) / 180 * 10) / 10;
      if (!pacer.tick(now, fpsLimit(limits, { interacting: false, loopPlaying: tl.playing, animating: false }))) continue;
      if (!tl.tick(now, last ? now - last : 16, true)) held++;
      last = now;
      rendered.push(i);
    }
    expect(held).toBeGreaterThan(100); // holds happened (≥ 4 loops × 0.5 s at 50 fps)
    const iv = rendered.slice(1).map((r, i) => r - rendered[i]).slice(10);
    expect(hist(iv)).toEqual({ 3: iv.filter((x) => x === 3).length, 4: iv.filter((x) => x === 4).length });
    const rate = 180 / (iv.reduce((s, x) => s + x, 0) / iv.length);
    expect(Math.abs(rate - 50)).toBeLessThan(0.1);
  });
});
