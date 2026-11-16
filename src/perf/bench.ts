// In-app benchmark: scripted scenarios with real layers, frame statistics, per-frame raw intervals
// and event marks, the display's RAF cadence, long tasks, adapter and backbuffer information, exported as JSON.
// Exposed as window.cwrv3bench. `useL2Fixture` loads fixed archive volumes (public/perf-fixtures.json) so Level 2 runs are
// reproducible and independent of the live feed.
import type { App } from '../app/app';
import { FrameMeter, type FrameSample } from './meter';
import { settings } from '../settings/store';
import { timeline } from '../app/timeline';
import type { L2File } from '../radar/sources';

/** `fps`: FPS limit for the run (0 = unlimited); omitted = the user's settings. */
export interface BenchOptions { scenario: 'idle' | 'panzoom' | 'l2loop' | 'l3probe' | 'stress'; seconds?: number; fps?: number; label?: string; raw?: boolean }

/** Summary of display cadence: RAF deltas and how many rendered frames spanned more than one display period. */
function cadence(raf: number[], frames: FrameSample[], capMs: number) {
  const d: number[] = [];
  for (let i = 1; i < raf.length; i++) d.push(raf[i] - raf[i - 1]);
  const s = [...d].sort((a, b) => a - b);
  const period = s.length ? s[s.length >> 1] : NaN;
  const late = frames.filter((f) => f.dt > Math.max(capMs, period) * 1.5);
  const evCount: Record<string, number> = {};
  const lateEv: Record<string, number> = {};
  for (const f of frames) for (const e of f.ev ?? []) { const k = e.replace(/\d+x\d+/, 'WxH'); evCount[k] = (evCount[k] ?? 0) + 1; }
  // Events in the late frame or the frame just before it (work recorded before a long interval).
  const idx = new Map(frames.map((f, i) => [f, i]));
  for (const f of late) {
    const i = idx.get(f)!;
    for (const e of new Set([...(f.ev ?? []), ...(frames[i - 1]?.ev ?? [])])) { const k = e.replace(/\d+x\d+/, 'WxH'); lateEv[k] = (lateEv[k] ?? 0) + 1; }
  }
  return { rafCallbacks: raf.length, rafPeriodMs: period, rafP99Ms: s[Math.floor(s.length * 0.99)] ?? NaN, rafMaxMs: s[s.length - 1] ?? NaN, lateFrames: late.length, lateFrameEvents: lateEv, frameEvents: evCount };
}

export function installBench(app: App) {
  const longTasks: { start: number; duration: number }[] = [];
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
  } catch { /* long-task API unavailable */ }

  async function waitReady(ms: number) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const busy = [...app.layers.values()].some((l) => 'status' in l && (l as { status: { state: string } }).status.state === 'loading');
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Loads the fixed archive volumes listed in public/perf-fixtures.json and anchors the timeline to them. */
  async function useL2Fixture(fixturesUrl = '/perf-fixtures.json') {
    const fx = await (await fetch(fixturesUrl)).json() as { l2: { site: string; base: string; files: { name: string }[] } };
    const files: L2File[] = fx.l2.files.map((f) => {
      const m = /(\d{8})_(\d{6})/.exec(f.name)!;
      const t = Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6));
      return { t, url: fx.l2.base + f.name, live: false, name: f.name };
    });
    app.nexrad.fixture = { site: fx.l2.site, files };
    timeline.anchor = files[files.length - 1].t + 60e3;
    settings.set('ext.layerState.LoopLength', 0.5);
    settings.set('settings.nexradSiteICAO', fx.l2.site);
    settings.set('settings.nexradLevel2MaxVolumeDownloadCount', Math.min(12, files.length));
    settings.set('settings.nexradLevel2VolumeCountMemory', Math.max(files.length, 5));
    app.refreshAll();
    return files.length;
  }

  async function run(o: BenchOptions) {
    const seconds = o.seconds ?? 60;
    const cam = app.renderer.camera;
    const start0 = { ...cam.target }; // copy: setView mutates target in place
    app.fpsOverride = o.fps ?? null;
    if (o.scenario === 'l2loop') { settings.set('layerState.NEXRADOn', true); settings.set('layerState.NEXRADLevel2', true); app.activeTab = 'NEXRADPro'; }
    if (o.scenario === 'l3probe') { settings.set('layerState.NEXRADOn', true); settings.set('layerState.NEXRADLevel2', false); settings.set('config.generalMapMode', 2); }
    await waitReady(90_000);
    if (o.scenario === 'l2loop' || o.scenario === 'l3probe' || o.scenario === 'stress') timeline.play(true);
    app.meter.recording = [];
    app.meter.rafRecording = [];
    const lt0 = longTasks.length;
    const t0 = performance.now();
    const c = app.renderer.gpu.canvas;
    await new Promise<void>((resolve) => {
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        if (o.scenario === 'panzoom' || o.scenario === 'stress') {
          cam.setView({ lon: start0.lon + Math.sin(t * 0.6) * 6, lat: start0.lat + Math.sin(t * 0.4) * 3, z: start0.z * (0.55 + 0.45 * Math.cos(t * 0.5)) }, true);
          app.poke();
        }
        if (o.scenario === 'l3probe') { const r = c.getBoundingClientRect(); app.renderer.probeRequest = { x: r.width / 2 + Math.cos(t * 2) * r.width / 4, y: r.height / 2 + Math.sin(t * 2) * r.height / 4 }; app.poke(); }
        if (t < seconds) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    const frames = app.meter.recording!;
    const raf = app.meter.rafRecording!;
    app.meter.recording = null; app.meter.rafRecording = null;
    timeline.play(false);
    cam.setView(start0, true);
    const fps = app.fpsOverride ?? settings.num('config.generalActiveFPS');
    const capMs = fps > 0 ? 1000 / fps : 0;
    app.fpsOverride = null;
    const g = app.renderer.gpu;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      label: o.label ?? o.scenario, scenario: o.scenario, seconds, fpsLimit: fps, timestamp: new Date().toISOString(),
      fixture: app.nexrad.fixture ? app.nexrad.fixture.files.map((f) => f.name) : null,
      adapter: g.info, backbuffer: { width: g.width, height: g.height, dpr: g.dpr, devicePixelRatio, cssWidth: c.clientWidth, cssHeight: c.clientHeight, msaa: g.sampleCount },
      userAgent: navigator.userAgent, stats: FrameMeter.stats(frames), cadence: cadence(raf, frames, capMs),
      longTasks: longTasks.slice(lt0).map((l) => ({ startMs: +(l.start - t0).toFixed(1), durationMs: +l.duration.toFixed(1) })),
      jsHeapMB: mem ? +(mem.usedJSHeapSize / 1e6).toFixed(1) : null,
      layers: [...app.layers.values()].filter((l) => 'status' in l).map((l) => ({ id: l.id, enabled: (l as { enabled: () => boolean }).enabled(), status: (l as { status: unknown }).status })),
      tiles: app.tiles.stats.tiles,
      raw: o.raw === false ? undefined : { frames: frames.map((f) => [+(f.t - t0).toFixed(2), +f.dt.toFixed(2), +f.cpu.toFixed(2), +f.gpu.toFixed(2), ...(f.ev ?? [])]), raf: raf.map((x) => +(x - t0).toFixed(2)) },
    };
  }

  function download(obj: unknown, name = `cwrv3-bench-${Date.now()}.json`) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
    a.download = name; a.click();
  }

  (window as unknown as { cwrv3bench: unknown }).cwrv3bench = { run, download, useL2Fixture, app, settings, timeline };
}
