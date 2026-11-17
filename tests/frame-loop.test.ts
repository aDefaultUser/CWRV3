// App frame loop → timeline playback at low loop FPS limits: each loop frame lasts its frame time (not stretched by
// a per-frame time cap), with interpolation on or off, and a frame time change applies to the next frame. Drives the
// real App.loop with the real pacer, settings and timeline over a 60 Hz display whose RAF timestamps jitter by up to
// 0.4 ms, as real ones do (renderer and HUD stubbed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  class El { style = {}; children = []; classList = { add() {}, remove() {}, toggle() {}, contains: () => false }; setAttribute() {} addEventListener() {} appendChild(n: unknown) { return n; } }
  Object.assign(globalThis, { document: { createElement: () => new El(), getElementById: () => new El() }, innerWidth: 1200, innerHeight: 800 });
});
import { App } from '../src/app/app';
import { FramePacer } from '../src/app/pacer';
import { FrameMeter } from '../src/perf/meter';
import { timeline } from '../src/app/timeline';
import { settings } from '../src/settings/store';

const T0 = Date.UTC(2024, 4, 6, 22, 30), MIN = 60e3, HZ = 60;
const frames = Array.from({ length: 40 }, (_, i) => T0 - (39 - i) * 4 * MIN);
const touched = ['config.generalRestingFPSLoop', 'settings.generalLoopSpeedLevel2FrameTime', 'layerState.RasterDataTemporalInterpolation', 'settings.generalLoopSpeedEndDelay'];

/** App with its private frame loop reachable (a stand-in instance: no renderer, layers or DOM). */
let app: { loop(now: number): void } & Record<string, any>;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(performance, 'now').mockReturnValue(0);
  app = Object.create(App.prototype);
  Object.assign(app, {
    meter: new FrameMeter(), pacer: new FramePacer(), lastFrame: 0, lastInteract: -1e9, cameraMoving: false, fpsOverride: null, flashT: 0,
    recorder: null, recordCanvas: null, viewPlaying: false, nexrad: { liveScan: false }, layers: new Map(), tiles: {},
    renderer: { camera: { update: () => false }, probeRequest: null, layers: [], frame() {}, gpuMs: null, flashRow: 0 },
    applyTileSettings() {}, applyLighting() {}, updateHud() {},
  });
  timeline.anchor = T0;
  timeline.offer('nexrad-l2', frames);
  settings.set('settings.generalLoopSpeedEndDelay', 0);
});
afterEach(() => { timeline.play(false); timeline.offer('nexrad-l2', null); for (const id of touched) settings.reset(id); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Runs the RAF loop from `from` for `ms` and returns the display times at which a new loop frame was first shown. */
function run(from: number, ms: number) {
  const shown: number[] = [];
  let idx = frames.findIndex((x) => x > timeline.t) - 1;
  for (let k = Math.ceil((from * HZ) / 1000); (k * 1000) / HZ <= from + ms; k++) {
    const now = (k * 1000) / HZ + Math.sin(k * 12.9898) * 0.4;
    app.loop(now);
    const i = frames.findIndex((x) => x > timeline.t) - 1;
    if (i > idx) { shown.push(now); idx = i; }
  }
  return shown;
}
/** Intervals between shown frames, to the nearest ms (the jitter of two timestamps is under 1 ms). */
const gaps = (a: number[]) => a.slice(1).map((x, i) => Math.round(x - a[i]));
const near = (want: number) => (g: number) => Math.abs(g - want) <= 1;

describe('frame loop playback at low loop FPS', () => {
  for (const interpolate of [false, true]) {
    it(`shows each 1000 ms loop frame for 1000 ms at 2 and 1 FPS (interpolation ${interpolate ? 'on' : 'off'})`, () => {
      settings.set('layerState.RasterDataTemporalInterpolation', interpolate);
      settings.set('settings.generalLoopSpeedLevel2FrameTime', 1000);
      settings.set('config.generalRestingFPSLoop', 2);
      timeline.play(true);
      run(0, 1000); // the pacer learns the 60 Hz refresh
      const at2 = gaps(run(1000, 6000));
      expect(at2.length).toBeGreaterThanOrEqual(4);
      expect(at2.every(near(1000))).toBe(true);
      settings.set('config.generalRestingFPSLoop', 1);
      const at1 = gaps(run(7000, 6000).slice(1));
      expect(at1.length).toBeGreaterThanOrEqual(3);
      expect(at1.every(near(1000))).toBe(true);
    });
  }

  it('applies a frame time change to the next loop frame at 2 FPS', () => {
    settings.set('layerState.RasterDataTemporalInterpolation', false);
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 1500);
    settings.set('config.generalRestingFPSLoop', 2);
    timeline.play(true);
    run(0, 1000);
    expect(gaps(run(1000, 6000)).every(near(1500))).toBe(true);
    settings.set('settings.generalLoopSpeedLevel2FrameTime', 500);
    const fast = gaps(run(7000, 3000).slice(1));
    expect(fast.length).toBeGreaterThanOrEqual(4);
    expect(fast.every(near(500))).toBe(true);
  });
});
