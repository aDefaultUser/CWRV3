// Main timeline: owner resolution (wrap options, Model timeline), frame times and loop-time overrides, end delay,
// immediate timing changes and Skip to end.
import { afterEach, describe, expect, it } from 'vitest';
import { Timeline } from '../src/app/timeline';
import { timingText } from '../src/ui/bindings';
import { settings } from '../src/settings/store';

const T0 = Date.UTC(2024, 4, 6, 22, 30);
const MIN = 60e3;
/** `n` frames ending at the anchor, `gap` minutes apart. */
const loop = (n: number, gap = 4) => Array.from({ length: n }, (_, i) => T0 - (n - 1 - i) * gap * MIN);
function timeline() { const tl = new Timeline(() => 0); tl.anchor = T0; tl.refreshWindow(); return tl; }

/** Plays at a fixed render interval and returns the times (ms) at which the displayed frame changed. */
function stepTimes(tl: Timeline, ms: number, renderMs = 1000 / 60, interpolate = false, from = 0) {
  const out: number[] = [];
  let last = tl.t;
  for (let now = from + renderMs; now <= from + ms; now += renderMs) {
    tl.tick(now, renderMs, interpolate);
    if (tl.t !== last) { out.push(now); last = tl.t; }
  }
  return out;
}
const gaps = (a: number[]) => a.slice(1).map((x, i) => Math.round(x - a[i]));

const touched = ['settings.generalLoopSpeedLevel2FrameTime', 'settings.generalLoopSpeedLevel3FrameTime', 'settings.generalLoopSpeedFrameTime', 'settings.generalLoopSpeedMinLoopTime',
  'settings.generalLoopSpeedMaxLoopTime', 'settings.generalLoopSpeedEndDelay', 'settings.mrmsFrameTime', 'ext.layerState.TimelineSelect', 'ext.layerState.LoopLength'];
afterEach(() => { for (const id of touched) settings.reset(id); });

describe('timeline frame time', () => {
  it.each([false, true])('does not count idle time before Play (interpolation %s)', (interpolate) => {
    const tl = new Timeline(() => 900), f = loop(6);
    tl.anchor = T0; tl.offer('nexrad-l2', f);
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 1000);
    tl.play(true);
    tl.tick(905, 905, interpolate);
    expect(tl.t - f[0]).toBe(interpolate ? (f[1] - f[0]) * 0.005 : 0);
    tl.tick(1900, 995, interpolate);
    expect(tl.t).toBe(f[1]);
  });

  it('drops a long stall backlog instead of stepping again on the next render', () => {
    const tl = timeline(), f = loop(6);
    tl.offer('nexrad-l2', f);
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 1000);
    tl.play(true);
    tl.tick(1000, 1000, false);
    expect(tl.t).toBe(f[1]);
    tl.tick(11000, 10000, false);
    expect(tl.t).toBe(f[2]);
    expect(tl.tick(11016, 16, false)).toBe(false);
    expect(tl.t).toBe(f[2]);
    tl.tick(12000, 984, false);
    expect(tl.t).toBe(f[3]);
  });

  it('applies the default Level 2 frame time and a change to 70 ms, unclamped by the general loop-time overrides', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', loop(12));
    expect(tl.controller).toBe('nexrad-l2');
    // 12 × 140 ms = 1.68 s is below the 3 s minimum loop time, which belongs to the General timeline only.
    expect(tl.frameTiming()).toEqual({ setting: 'settings.generalLoopSpeedLevel2FrameTime', requested: 140, applied: 140, override: null });
    tl.play(true);
    const at140 = gaps(stepTimes(tl, 1000, 5));
    expect(at140.every((g) => Math.abs(g - 140) <= 5)).toBe(true);
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 70);
    const at70 = gaps(stepTimes(tl, 300, 5, false, 1000));
    expect(at70.length).toBeGreaterThanOrEqual(3);
    expect(at70.every((g) => Math.abs(g - 70) <= 5)).toBe(true);
  });

  it('applies the Level 3 and MRMS frame times to their own loops', () => {
    const tl = timeline();
    tl.offer('nexrad-l3', loop(6));
    settings.set('settings.generalLoopSpeedLevel3FrameTime', 90);
    expect(tl.frameMs()).toBe(90);
    tl.offer('nexrad-l3', null);
    tl.offer('mrms', loop(6, 2));
    settings.set('settings.mrmsFrameTime', 200);
    expect(tl.controller).toBe('mrms');
    expect(tl.frameMs()).toBe(200);
  });

  it('stretches or shrinks only the general loop with the minimum and maximum loop-time overrides', () => {
    const tl = timeline();
    settings.set('ext.layerState.LoopLength', 0.5); // 7 general frames
    expect(tl.controller).toBe('general');
    const n = tl.frames.length;
    expect(n).toBe(7);
    expect(tl.frameTiming()).toEqual({ setting: 'settings.generalLoopSpeedFrameTime', requested: 140, applied: 3000 / n, override: 'min' });
    settings.set('settings.generalLoopSpeedMinLoopTime', 20);
    expect(tl.frameTiming().override).toBe(null);
    expect(tl.frameMs()).toBe(140);
    settings.set('settings.generalLoopSpeedMaxLoopTime', 700);
    expect(tl.frameTiming()).toMatchObject({ applied: 100, override: 'max' });
  });

  it('carries the step remainder so a render-rate limit does not slow a discrete loop', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', loop(12));
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 100);
    tl.play(true);
    // 15 fps rendering (66.7 ms): steps land on render frames but average 100 ms.
    const s = stepTimes(tl, 1000, 1000 / 15);
    const mean = (s[s.length - 1] - s[0]) / (s.length - 1);
    expect(Math.abs(mean - 100)).toBeLessThan(8);
  });
});

describe('timeline end delay', () => {
  it('holds the newest frame once for the end delay, then shows the first frame for one frame time', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', loop(4));
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 100);
    settings.set('settings.generalLoopSpeedEndDelay', 500);
    tl.play(true);
    const shown: [number, number][] = [];
    let last = tl.t;
    for (let now = 5; now < 2400; now += 5) { tl.tick(now, 5, false); if (tl.t !== last) { shown.push([now, tl.frames.indexOf(tl.t)]); last = tl.t; } }
    // 0→1→2→3 at 100 ms each, newest held 500 ms, then 0, and 1 again 100 ms later (no second hold on the first frame).
    const at = (i: number) => shown.filter(([, k]) => k === i).map(([t]) => t);
    expect(at(1)[0]).toBe(100);
    expect(at(3)[0]).toBe(300);
    expect(at(0)[0]).toBe(800);
    expect(at(1)[1]).toBe(900);
  });

  it('applies an end delay change to the hold in progress', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', loop(3));
    settings.set('settings.generalLoopSpeedEndDelay', 20000);
    tl.play(true);
    let now = 0;
    for (; tl.t !== tl.frames[2]; now += 10) tl.tick(now, 10, false);
    for (let k = 0; k < 50; k++, now += 10) tl.tick(now, 10, false);
    expect(tl.t).toBe(tl.frames[2]); // still holding (20 s)
    settings.set('settings.generalLoopSpeedEndDelay', 100);
    tl.tick(now, 10, false);
    expect(tl.t).toBe(tl.frames[0]);
  });
});

describe('timeline owner', () => {
  it('follows the wrap offers: NEXRAD before MRMS, general when withdrawn', () => {
    const tl = timeline();
    tl.offer('mrms', loop(5, 2));
    tl.offer('nexrad-l2', loop(6));
    expect(tl.controller).toBe('nexrad-l2');
    expect(tl.start).toBe(loop(6)[0]);
    tl.offer('nexrad-l2', null); // NEXRAD off or its wrap option cleared
    expect(tl.controller).toBe('mrms');
    tl.offer('mrms', null);
    expect(tl.controller).toBe('general');
    expect(tl.frames).toEqual(tl.generalFrames());
    expect(tl.start).toBe(tl.loopStart);
  });

  it('gives the Model timeline the timeline only while selected, without disturbing the observation window', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', loop(6));
    const future = [T0 + 3600e3, T0 + 2 * 3600e3, T0 + 3 * 3600e3];
    tl.offer('model', future);
    expect(tl.controller).toBe('nexrad-l2');
    settings.set('ext.layerState.TimelineSelect', 1);
    expect(tl.controller).toBe('model');
    expect([tl.start, tl.end]).toEqual([future[0], future[2]]);
    expect([tl.loopStart, tl.loopEnd]).toEqual([T0 - 3 * 3600e3, T0]); // data layers keep loading the loop window
    settings.set('ext.layerState.TimelineSelect', 0);
    expect(tl.controller).toBe('nexrad-l2');
    expect(tl.end).toBe(T0);
  });

  it('uses the model end delay on the Model timeline', () => {
    const tl = timeline();
    settings.set('ext.layerState.TimelineSelect', 1);
    tl.offer('model', [T0, T0 + 3600e3]);
    expect(tl.endDelayMs()).toBe(settings.num('settings.modelLoopEndDelay'));
  });
});

describe('timeline owner after the loop window', () => {
  const HOUR = 3600e3;
  it('skips an observation loop with no frames in the window and falls back by priority with that owner\'s timing', () => {
    const tl = timeline();
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 333);
    settings.set('settings.mrmsFrameTime', 250);
    tl.offer('nexrad-l2', loop(6).map((x) => x - 5 * HOUR)); // an old archive loop, before the 3 h window
    expect(tl.controller).toBe('general');
    expect(tl.frames).toEqual(tl.generalFrames());
    expect(tl.frameTiming().setting).toBe('settings.generalLoopSpeedFrameTime');
    expect(timingText(tl)).toMatch(/^General timeline: \d+ frames, \d+ ms\/frame/);
    tl.offer('mrms', loop(5, 2));
    expect([tl.controller, tl.frameMs(), tl.frames]).toEqual(['mrms', 250, loop(5, 2)]);
    expect(tl.start).toBe(loop(5, 2)[0]);
    // A frame of the NEXRAD loop inside the window gives it the timeline again, with only its in-window frames.
    tl.offer('nexrad-l2', [...loop(6).map((x) => x - 5 * HOUR), T0 - 20 * MIN, T0]);
    expect([tl.controller, tl.frameMs(), tl.frames]).toEqual(['nexrad-l2', 333, [T0 - 20 * MIN, T0]]);
  });

  it('hands the timeline on when the loop length is shortened below the owner\'s frames, and back when lengthened', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', [T0 - 2 * HOUR, T0 - 1.5 * HOUR]); // newest volume 90 minutes old
    tl.offer('nexrad-l3', loop(4));
    expect(tl.controller).toBe('nexrad-l2');
    settings.set('ext.layerState.LoopLength', 1);
    expect(tl.controller).toBe('nexrad-l3');
    expect(tl.frames).toEqual(loop(4));
    tl.offer('nexrad-l3', null);
    expect(tl.controller).toBe('general');
    expect(tl.frames[tl.frames.length - 1]).toBe(T0);
    settings.set('ext.layerState.LoopLength', 3);
    expect([tl.controller, tl.frames]).toEqual(['nexrad-l2', [T0 - 2 * HOUR, T0 - 1.5 * HOUR]]);
  });

  it('never filters the Model timeline\'s future valid times by the observation window', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', loop(4).map((x) => x - 6 * HOUR)); // outside the window
    const future = [T0 + 6 * HOUR, T0 + 12 * HOUR];
    tl.offer('model', future);
    expect(tl.controller).toBe('general'); // Model timeline not selected
    settings.set('ext.layerState.TimelineSelect', 1);
    expect([tl.controller, tl.frames, tl.start, tl.end]).toEqual(['model', future, future[0], future[1]]);
  });
});

describe('skip to end', () => {
  it('pauses on the newest available frame (not the wall-clock end), during a hold and with interpolation', () => {
    const tl = timeline();
    const f = loop(8);
    tl.offer('nexrad-l2', f.map((x) => x - 2 * MIN)); // newest volume 2 min before "now"
    tl.play(true);
    let now = 0;
    for (; now < 300; now += 16) tl.tick(now, 16, true);
    expect(tl.t).toBeGreaterThan(tl.frames[0]);
    tl.last();
    expect(tl.playing).toBe(false);
    expect(tl.t).toBe(f[7] - 2 * MIN);
    for (; now < 2000; now += 16) expect(tl.tick(now, 16, true)).toBe(false);
    expect(tl.t).toBe(f[7] - 2 * MIN);
    // A newer volume arrives: Last keeps following the newest frame.
    tl.offer('nexrad-l2', [...f.map((x) => x - 2 * MIN), T0]);
    expect(tl.t).toBe(T0);
    // Playing from the newest frame restarts the loop; stepping back leaves the newest frame.
    tl.step(-1);
    expect(tl.t).toBe(f[7] - 2 * MIN);
    tl.step(1);
    expect(tl.following).toBe(true);
    tl.play(true);
    expect(tl.t).toBe(tl.frames[0]);
  });

  it('pauses during an end-of-loop hold and stays there', () => {
    const tl = timeline();
    tl.offer('nexrad-l2', loop(3));
    settings.set('settings.generalLoopSpeedEndDelay', 5000);
    tl.play(true);
    let now = 0;
    for (; tl.t !== tl.frames[2]; now += 10) tl.tick(now, 10, false);
    tl.last();
    for (let k = 0; k < 1000; k++, now += 10) tl.tick(now, 10, false);
    expect([tl.playing, tl.t]).toEqual([false, tl.frames[2]]);
  });
});
