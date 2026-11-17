// Frame timing: rendered-frame intervals, CPU encode time and GPU pass time (timestamp queries when available),
// plus per-frame event marks (uploads, DOM refreshes, timeline steps) for pacing analysis, and the raw
// requestAnimationFrame timestamps (display cadence, independent of rendering) while recording.
export interface FrameSample { t: number; dt: number; cpu: number; gpu: number; ev?: string[] }

const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : NaN);

export class FrameMeter {
  samples: FrameSample[] = [];
  /** Rendered frames since start. */
  total = 0;
  private last = 0;
  recording: FrameSample[] | null = null;
  /** Raw RAF timestamps while recording (display cadence, independent of the render cap). */
  rafRecording: number[] | null = null;
  private pendingEv: string[] = [];
  /** Called on every RAF callback, rendered or not. */
  raf(now: number) { this.rafRecording?.push(now); }
  /** Records an event for the frame being built (only while recording). */
  mark(ev: string) { if (this.recording) this.pendingEv.push(ev); }
  frame(now: number, cpu: number, gpu: number) {
    const dt = this.last ? now - this.last : 0;
    this.last = now;
    if (!dt) return;
    this.total++;
    const s: FrameSample = { t: now, dt, cpu, gpu };
    if (this.pendingEv.length) { s.ev = this.pendingEv; this.pendingEv = []; }
    this.samples.push(s);
    if (this.samples.length > 4000) this.samples.splice(0, 2000);
    this.recording?.push(s);
  }
  static stats(list: FrameSample[]) {
    const dts = list.map((s) => s.dt).sort((a, b) => a - b);
    const cpus = list.map((s) => s.cpu).sort((a, b) => a - b);
    const gpus = list.map((s) => s.gpu).filter((g) => g > 0).sort((a, b) => a - b);
    const mean = dts.reduce((s, x) => s + x, 0) / Math.max(1, dts.length);
    return {
      frames: dts.length, fps: 1000 / mean, meanMs: mean, p50Ms: pct(dts, 50), p95Ms: pct(dts, 95), p99Ms: pct(dts, 99), maxMs: dts[dts.length - 1] ?? NaN,
      dropped20ms: dts.filter((x) => x > 20).length,
      cpuMean: cpus.reduce((s, x) => s + x, 0) / Math.max(1, cpus.length), cpuP95: pct(cpus, 95),
      gpuMean: gpus.length ? gpus.reduce((s, x) => s + x, 0) / gpus.length : NaN, gpuP95: pct(gpus, 95),
    };
  }
  summary(windowMs: number) {
    const now = this.samples[this.samples.length - 1]?.t ?? 0;
    return FrameMeter.stats(this.samples.filter((s) => s.t > now - windowMs));
  }
}

/** Meter that receives marks from anywhere in the app (set by the App). */
let active: FrameMeter | null = null;
export function setActiveMeter(m: FrameMeter) { active = m; }
export function perfMark(ev: string) { active?.mark(ev); }
