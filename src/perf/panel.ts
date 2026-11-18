// Debug / performance panel (F8, CWRV3 menu → Advanced): global frame rate, frame times, GPU pass time and memory,
// and one row per owner (layer or shared resource) with its decode jobs, texture uploads, live texture memory and
// layer status. Sampled twice a second only while open; nothing is sent anywhere. Values a browser or owner does
// not provide are shown as "N/A", never as zero. GPU execution time is measured for the whole main pass plus the
// layers' prepass passes (offscreen targets drawn before it).
import type { OwnerStat } from '../workers/pool';
import type { FrameMeter } from './meter';

export interface PerfSnapshot {
  frames: ReturnType<typeof FrameMeter.stats>;
  /** Rendered frames since start (FrameMeter). */
  totalFrames: number;
  /** GPU time of the main pass plus the prepass passes from timestamp queries, or null without timestamp-query. */
  gpuMs: number | null;
  /** The prepass share of `gpuMs` (0 when no layer has a prepass). */
  gpuPrepassMs?: number;
  /** performance.memory (Chromium only), or null. */
  heap: { used: number; limit: number } | null;
  textureBytes: number;
  /** Live tracked texture bytes per owner (Gpu.textureBytes). */
  textures: [string, number][];
  uploads: [string, { count: number; bytes: number; cpuMs: number }][];
  jobs: [string, OwnerStat][];
  layers: { id: string; state: string; frames?: number; text: string }[];
  timeline: string;
  workers: number;
}

const ms = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : 'N/A');
/** MB, or KB below 0.1 MB so small live sizes (palette LUTs) do not read as zero. */
const mb = (b: number) => (b > 0 && b < 104858 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

/** Global rows of the panel (not attributable to one owner): [section, label, value]. */
export function perfRows(s: PerfSnapshot): [string, string, string][] {
  const f = s.frames, rows: [string, string, string][] = [];
  rows.push(['Frames (all layers)', 'Rendered frame rate (last 2 s)', f.frames ? `${f.fps.toFixed(1)} fps` : 'N/A']);
  rows.push(['Frames (all layers)', 'Frame interval p50 / p95 / max', f.frames ? `${ms(f.p50Ms)} / ${ms(f.p95Ms)} / ${ms(f.maxMs)}` : 'N/A']);
  rows.push(['Frames (all layers)', 'CPU per frame (update + encode + submit), mean / p95', f.frames ? `${ms(f.cpuMean)} / ${ms(f.cpuP95)}` : 'N/A']);
  rows.push(['Frames (all layers)', 'GPU main pass + prepasses (timestamp query)', s.gpuMs === null ? 'N/A (no timestamp-query feature)' : s.gpuPrepassMs ? `${ms(s.gpuMs)} (prepasses ${ms(s.gpuPrepassMs)})` : ms(s.gpuMs)]);
  rows.push(['Frames (all layers)', 'Frames rendered since start / > 20 ms in window', `${s.totalFrames} / ${f.dropped20ms}`]);
  rows.push(['Timeline', 'Loop', s.timeline]);
  rows.push(['Memory', 'JS heap used / limit', s.heap ? `${mb(s.heap.used)} / ${mb(s.heap.limit)}` : 'N/A (performance.memory unavailable)']);
  rows.push(['Memory', 'Tracked texture memory, all owners (data textures, palettes, basemap atlases)', mb(s.textureBytes)]);
  rows.push(['Workers', 'Decode workers', String(s.workers)]);
  return rows;
}

export const OWNER_COLUMNS = [
  'Owner', 'Decode jobs: done / in flight / failed', 'Decode mean / max (excl. network, queue)', 'Worker fetch + decode mean / max',
  'Queue + transfer mean', 'Texture uploads since start: count, MB, CPU submit (not GPU)', 'Live texture memory', 'Layer status',
];

/** One row per owner: the union of decode-job, upload, texture and enabled-layer owners; "N/A" where an owner has none. */
export function ownerMatrix(s: PerfSnapshot): string[][] {
  const jobs = new Map(s.jobs), uploads = new Map(s.uploads), textures = new Map(s.textures), layers = new Map(s.layers.map((l) => [l.id, l]));
  const owners = new Set([...layers.keys(), ...jobs.keys(), ...uploads.keys(), ...textures.keys()]);
  return [...owners].map((owner) => {
    const j = jobs.get(owner), u = uploads.get(owner), t = textures.get(owner), l = layers.get(owner);
    const n = j ? Math.max(1, j.jobs) : 1;
    // Asynchronous decode sections (stream inflate, WASM) are wall time; jobs with them are counted.
    const decode = j?.procJobs ? `${ms(j.procMs / j.procJobs)} / ${ms(j.maxProcMs)}${j.procWallJobs ? ` (${j.procWallJobs} with async wall)` : ''}` : 'N/A';
    return [
      owner,
      j ? `${j.jobs} / ${j.inFlight} / ${j.errors}` : 'N/A',
      decode,
      j ? `${ms(j.execMs / n)} / ${ms(j.maxExecMs)}` : 'N/A',
      j ? ms(j.waitMs / n) : 'N/A',
      u ? `${u.count}, ${mb(u.bytes)}, ${ms(u.cpuMs)}` : 'N/A',
      t !== undefined ? mb(t) : 'N/A',
      l ? `${l.state}${l.frames !== undefined ? `, ${l.frames} frames` : ''}${l.text ? ` · ${l.text.slice(0, 60)}` : ''}` : 'N/A (not an enabled layer)',
    ];
  });
}

/** The panel element: shown and hidden by toggle(); samples `snapshot` every `intervalMs` only while shown. */
export class PerfPanel {
  readonly el: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  refreshes = 0;
  constructor(host: HTMLElement, private snapshot: () => PerfSnapshot, private intervalMs = 500) {
    this.el = document.createElement('div');
    this.el.className = 'perfpanel';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Performance panel');
    this.el.style.display = 'none';
    host.appendChild(this.el);
  }
  get visible() { return this.timer !== null; }
  toggle(on = !this.visible) {
    if (on === this.visible) return;
    if (on) { this.el.style.display = ''; this.render(); this.timer = setInterval(() => this.render(), this.intervalMs); }
    else { clearInterval(this.timer!); this.timer = null; this.el.style.display = 'none'; this.el.textContent = ''; }
  }
  private render() {
    this.refreshes++;
    const snap = this.snapshot();
    const t = document.createElement('table');
    const cap = document.createElement('caption'); cap.textContent = 'Performance (F8 closes) · sampled every 0.5 s while open'; t.appendChild(cap);
    let section = '';
    for (const [sec, label, value] of perfRows(snap)) {
      if (sec !== section) { section = sec; const h = t.insertRow(); const th = document.createElement('th'); th.colSpan = 2; th.textContent = sec; h.appendChild(th); }
      const r = t.insertRow(); r.insertCell().textContent = label; r.insertCell().textContent = value;
    }
    const m = document.createElement('table'); m.className = 'perfmatrix';
    const mcap = document.createElement('caption'); mcap.textContent = 'Per owner (uploads and decode counts are cumulative since start)'; m.appendChild(mcap);
    const head = m.insertRow();
    for (const c of OWNER_COLUMNS) { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); }
    for (const row of ownerMatrix(snap)) { const r = m.insertRow(); for (const v of row) r.insertCell().textContent = v; }
    this.el.replaceChildren(t, m);
  }
}
