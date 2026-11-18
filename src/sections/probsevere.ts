// MRMS tab → ProbSevere v3 storm objects (NOAA/NCEP operational since MRMS v12.3): GeoJSON polygons about every
// 2 minutes from the public NOAA MRMS bucket (ProbSevere/YYYYMMDD/), or the NCEP real-time directory when the bucket
// cannot be listed. Polygons are coloured by the selected probability, with labels, motion arrows and a per-object
// trend in the probe text. A file is drawn only at times it is valid for (see pickProbSevereFrame).
import earcut from 'earcut';
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, NOT_AVAILABLE } from '../layers/base';
import { FrameStore } from '../layers/frames';
import { timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { fetchText, listS3, parseDirIndex } from '../data/net';
import { LineSet, TextSet, type GlyphAtlas, type Color, type Label, type LineStyle, type Polyline } from '../render/prims';
import { PolySet, type PolyFill } from '../render/polys';
import { destination } from '../gis/geodesy';
import { pointInRing } from '../layers/warnings';
import { MRMS_BUCKET } from './mrms';
import { pool } from '../workers/pool';
import { PS_TYPES, probSevereTime, ProbSevereVersionError, type PsFile, type PsObject } from './probsevere-data';

export { PS_TYPES, probSevereTime, ProbSevereVersionError, parseProbSevere, checkedProbSevere, type PsFile, type PsObject } from './probsevere-data';

export const PS_NCEP_DIR = 'https://mrms.ncep.noaa.gov/ProbSevere/PROBSEVERE/';
const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;
/** File-name time stamp (YYYYMMDD_HHMMSS) of an epoch ms. */
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
const fileTime = (name: string) => (/MRMS_PROBSEVERE_\d{8}_\d{6}\.json$/.test(name) ? probSevereTime(name) : null);

/** Tolerance for a file before the displayed time: about one cadence (files come every ~2 min). */
export const PS_MATCH_MS = 150e3;
/** The newest file stays current this long (its successor is not produced or listed yet: cadence + latency). */
export const PS_NEWEST_MS = 6 * 60e3;
/**
 * The file valid at time t: the newest one at or before t (30 s of slack for timeline steps), if no more than
 * PS_MATCH_MS older, or PS_NEWEST_MS when it is the newest file listed. Otherwise null: nothing is drawn.
 */
export function pickProbSevereFrame<T extends { t: number }>(frames: T[], t: number, newestListed: number): T | null {
  let best: T | null = null;
  for (const f of frames) if (f.t <= t + 30e3 && (!best || f.t > best.t)) best = f;
  if (!best) return null;
  return t - best.t <= (best.t === newestListed ? PS_NEWEST_MS : PS_MATCH_MS) ? best : null;
}

/** Values of one probability for an object over the span ending at `endT` (oldest first). */
export function probTrend(files: PsFile[], id: string, type: number, endT: number, spanMs = 60 * 60e3): number[] {
  return files.filter((f) => f.t <= endT && f.t > endT - spanMs).sort((a, b) => a.t - b.t)
    .map((f) => f.objects.find((o) => o.id === id)?.prob[type]).filter((p): p is number => p !== undefined && p === p);
}
/** Text sparkline on a fixed 0–100 % scale. */
export function sparkline(values: number[]): string {
  const B = '▁▂▃▄▅▆▇█';
  return values.map((p) => B[Math.max(0, Math.min(7, Math.floor((p / 100) * 8)))]).join('');
}

/** Motion as a compass direction toward which the object moves and a speed in knots. */
export function psMotion(o: Pick<PsObject, 'motionE' | 'motionN'>): { towardDeg: number; speedKt: number } | null {
  if (!(o.motionE === o.motionE && o.motionN === o.motionN)) return null;
  return { towardDeg: ((Math.atan2(o.motionE, o.motionN) * 180) / Math.PI + 360) % 360, speedKt: Math.hypot(o.motionE, o.motionN) * 1.943844 };
}

/** Probability colour ramp (CWRV3 choice): green → yellow → orange → red → magenta. */
const STOPS: [number, [number, number, number]][] = [[0, [70, 200, 90]], [25, [255, 230, 0]], [50, [255, 140, 0]], [75, [255, 20, 20]], [100, [255, 0, 255]]];
export function probColor(p: number): [number, number, number] {
  const x = Math.max(0, Math.min(100, p));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i], [p0, c0] = STOPS[i - 1];
    if (x <= p1) { const w = (x - p0) / (p1 - p0); return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * w)) as [number, number, number]; }
  }
  return STOPS[STOPS.length - 1][1];
}

export function probeLines(o: PsObject, t: number, type: number, trend: number[]): string[] {
  const pct = (v: number) => (v === v ? `${v}%` : 'n/a');
  const m = psMotion(o);
  return [
    `ProbSevere v3 object ${o.id} · valid ${new Date(t).toISOString().slice(11, 16)}Z`,
    PS_TYPES.map((x, i) => `${x.short} ${pct(o.prob[i])}`).join(' · '),
    trend.length ? `${PS_TYPES[type].short} trend (1 h) ${sparkline(trend)} ${trend[0]}→${trend[trend.length - 1]}%` : `${PS_TYPES[type].short} trend: no earlier files`,
    [`MESH ${o.meshIn === o.meshIn ? o.meshIn.toFixed(2) + ' in' : 'n/a'}`, `max LL az shear ${o.maxLlaz === o.maxLlaz ? o.maxLlaz.toFixed(3) + ' /s' : 'n/a'}`,
      m ? `moving toward ${Math.round(m.towardDeg)}° at ${Math.round(m.speedKt)} kt` : 'motion n/a'].join(' · '),
  ];
}


export class ProbSevereLayer extends MapLayer {
  readonly id = 'probSevere';
  readonly archive = 'resolver';
  readonly title = 'MRMS ProbSevere v3';
  /** Set by the storm alerts: keep the newest file loaded while the layer is hidden. */
  keepLatest = false;
  private store: FrameStore<PsFile>;
  private listing: { at: number; key: string; files: { t: number; key: string }[] } | null = null;
  private gen = 0;
  private shown: PsFile | null = null;
  private builtKey = '';
  /**
   * Archive listing with files of an earlier ProbSevere version: those up to `t` (the newest such file) are not
   * downloaded, since older files of the bucket are of that version too.
   */
  private oldVersion: { key: string; t: number } | null = null;
  private lines: LineSet; private fills: PolySet; private text: TextSet;

  constructor(r: Renderer, atlas: GlyphAtlas) {
    super(r);
    this.lines = new LineSet(r); this.fills = new PolySet(r); this.text = new TextSet(r, atlas);
    this.store = new FrameStore<PsFile>(async (f) => {
      const r = await pool.for(this.id).run<{ file?: PsFile; oldVersion?: string }>('probsevere', { url: f.key, t: f.t }, f.key);
      if (r.file) return r.file;
      // Only a file of the listing shown now marks it: a download of an earlier archive time can fail late.
      const l = this.listing;
      if (timeline.mode === 'archive' && l?.files.some((x) => x.key === f.key)) {
        this.oldVersion = { key: l.key, t: Math.max(f.t, this.oldVersion?.key === l.key ? this.oldVersion.t : -Infinity) };
        queueMicrotask(() => void this.refresh());
      }
      throw new ProbSevereVersionError(r.oldVersion ?? 'not ProbSevere v3');
    }, () => {}, 4, () => { this.builtKey = ''; this.updateStatus(); });
  }

  enabled() { return settings.bool('ext.layerState.ProbSevereOn'); }
  type() { return Math.max(0, Math.min(3, settings.num('ext.settings.probSevereType'))); }
  private newestListed() { return this.listing?.files.at(-1)?.t ?? -Infinity; }

  async refresh() {
    const on = this.enabled();
    const gen = ++this.gen;
    if (!on && !this.keepLatest) { this.store.setWanted([]); this.shown = null; this.setStatus('off', ''); return; }
    const key = `${timeline.key}|${timeline.loopStart}`, archive = timeline.mode === 'archive';
    // Archive files do not change: one listing per archive time and loop length. Live: at most every 50 s.
    if (this.listing && this.listing.key.split('|')[0] !== timeline.key) { this.listing = null; this.store.setWanted([]); this.shown = null; }
    if (!this.listing || (archive ? this.listing.key !== key : Date.now() - this.listing.at > 50e3)) {
      if (on) this.setStatus('loading', 'ProbSevere: listing files…');
      try {
        const files = await this.list(Math.min(timeline.loopStart, timeline.loopEnd - 65 * 60e3), timeline.loopEnd);
        if (gen !== this.gen) return; // a newer refresh (or a switch off) superseded this listing
        this.listing = { at: Date.now(), key, files };
      } catch (e) {
        if (gen === this.gen && on) this.setStatus('error', `ProbSevere listing failed: ${(e as Error).message}`);
        return;
      }
    }
    if (!on) this.setStatus('off', '');
    const oldUntil = archive && this.oldVersion?.key === this.listing.key ? this.oldVersion.t : -Infinity;
    const files = this.listing.files.filter((f) => f.t > oldUntil);
    // Shown: the loop window plus the hour before the newest file (trends); hidden for alerts: the newest file only.
    const from = Math.min(timeline.loopStart, (files.at(-1)?.t ?? 0) - 62 * 60e3);
    this.store.setWanted(on ? files.filter((f) => f.t >= from).slice(-200) : archive ? [] : files.slice(-1));
    this.builtKey = '';
    this.updateStatus();
  }

  /** Files from `from` to `to` (sorted): the NOAA bucket, else the NCEP real-time directory. */
  private async list(from: number, to: number): Promise<{ t: number; key: string }[]> {
    const out: { t: number; key: string }[] = [];
    try {
      for (let day = Math.floor(from / 86400e3) * 86400e3; day <= to; day += 86400e3) {
        const d = stamp(day).slice(0, 8);
        const after = day < from ? `ProbSevere/${d}/MRMS_PROBSEVERE_${stamp(from)}` : undefined;
        const { objects } = await listS3(MRMS_BUCKET, `ProbSevere/${d}/`, { startAfter: after, maxPages: 3 });
        for (const o of objects) { const t = fileTime(o.key); if (t !== null && t >= from) out.push({ t, key: `${MRMS_BUCKET}/${o.key}` }); }
      }
    } catch (e) {
      if (timeline.mode === 'archive') throw e; // the real-time directory holds only the newest files
      const dir = parseDirIndex(await fetchText(PS_NCEP_DIR, { cache: 'none' }).catch(() => { throw e; }));
      out.length = 0;
      for (const f of dir) { const t = fileTime(f.name); if (t !== null && t >= from) out.push({ t, key: PS_NCEP_DIR + f.name }); }
    }
    return out.filter((f) => f.t <= to + 60e3).sort((a, b) => a.t - b.t);
  }

  /** The newest file when it is the newest listed and at most `maxAgeMs` old (live data for the alerts), else null. */
  latestLive(maxAgeMs = 10 * 60e3): PsFile | null {
    const f = this.store.ready().at(-1);
    return timeline.mode === 'live' && f && f.t === this.newestListed() && Date.now() - f.t <= maxAgeMs ? f.data : null;
  }

  private updateStatus() {
    if (!this.enabled()) return;
    const c = this.store.counts(), n = this.store.frames.length;
    if (!n) {
      const old = timeline.mode === 'archive' && this.oldVersion !== null && this.oldVersion.key === this.listing?.key;
      this.setStatus('unavailable', old ? `ProbSevere v3: ${NOT_AVAILABLE} (the archived files are an earlier version)` : timeline.mode === 'archive' ? NOT_AVAILABLE : 'ProbSevere: no files in the loop period');
      return;
    }
    const shown = this.shown ? `showing ${hhmm(this.shown.t)}, ${this.visible(this.shown).length} objects ≥ ${settings.num('ext.settings.probSevereMinProb')}%`
      : `no file within ${PS_MATCH_MS / 60e3} min of ${hhmm(timeline.t)}`;
    this.setStatus(c.ready ? 'ready' : c.error && !c.loading && !c.pending ? 'error' : 'loading', `ProbSevere v3: ${c.ready}/${n} files${c.error ? `, ${c.error} failed` : ''}; ${shown}`, { frames: c.ready, newestMs: this.store.ready().at(-1)?.t });
  }
  statusText() { return this.status.text || (this.enabled() ? 'Waiting for data…' : 'Off'); }

  private visible(f: PsFile) {
    const type = this.type(), min = settings.num('ext.settings.probSevereMinProb');
    return f.objects.filter((o) => o.prob[type] >= min);
  }

  tick(t: number) {
    const ready = this.store.ready();
    const f = pickProbSevereFrame(ready, t, this.newestListed())?.data ?? null;
    if (f !== this.shown) { this.shown = f; this.updateStatus(); }
    const key = f ? `${f.t}|${['Type', 'MinProb', 'Labels', 'Motion', 'Fill', 'Alpha', 'LineWidth'].map((k) => settings.get(`ext.settings.probSevere${k}`)).join('|')}` : '';
    if (key === this.builtKey) return;
    this.builtKey = key;
    this.build(f);
  }

  private build(f: PsFile | null) {
    const type = this.type(), alpha = settings.num('ext.settings.probSevereAlpha'), width = settings.num('ext.settings.probSevereLineWidth');
    // One line/fill style per 5 % step of the ramp.
    const styles: LineStyle[] = [], fillStyles: { color: Color }[] = [];
    for (let i = 0; i <= 20; i++) { const c = probColor(i * 5); styles.push({ color: [...c, alpha] as Color, width }); fillStyles.push({ color: [...c, Math.round(alpha * 0.3)] as Color }); }
    const lines: Polyline[] = [], polys: PolyFill[] = [], labels: Label[] = [];
    for (const o of f ? this.visible(f) : []) {
      const p = o.prob[type], s = Math.round(p / 5);
      for (const r of o.rings) {
        lines.push({ coords: r, style: s });
        if (settings.bool('ext.settings.probSevereFill')) { const tris: number[] = []; for (const i of earcut(r, undefined, 2)) tris.push(r[i * 2], r[i * 2 + 1]); polys.push({ tris, style: s }); }
      }
      const m = psMotion(o);
      if (settings.bool('ext.settings.probSevereMotion') && m && m.speedKt >= 2) {
        // Arrow over the distance covered in 30 minutes.
        const km = (m.speedKt * 1.852) / 2, end = destination(o.lon, o.lat, m.towardDeg, km);
        lines.push({ coords: [o.lon, o.lat, ...end], style: s, height: 0.00002 });
        for (const a of [-150, 150]) lines.push({ coords: [...end, ...destination(end[0], end[1], m.towardDeg + a, Math.max(1.5, km * 0.2))], style: s, height: 0.00002 });
      }
      if (settings.bool('ext.settings.probSevereLabels')) {
        let top = 0; for (let i = 3; i < o.rings[0].length; i += 2) if (o.rings[0][i] > o.rings[0][top + 1]) top = i - 1;
        labels.push({ lon: o.rings[0][top], lat: o.rings[0][top + 1], dy: -8, text: `${p}%`, size: 12, color: [...probColor(p), alpha] as Color, halo: [0, 0, 0, Math.round(alpha * 0.9)], priority: p });
      }
    }
    this.lines.setStyles(styles); this.lines.setLines(lines);
    this.fills.setStyles(fillStyles); this.fills.setPolys(polys);
    this.text.setLabels(labels);
  }

  draw(ctx: DrawContext) {
    if (ctx.probe || !this.shown) return;
    this.fills.draw(ctx); this.lines.draw(ctx); this.text.draw(ctx);
  }

  /** Object under the cursor: probabilities, MESH, shear, motion, ID, valid time and the trend of the selected type. */
  probeAt(lon: number, lat: number): string[] | null {
    const f = this.shown;
    if (!f) return null;
    const type = this.type();
    const hit = this.visible(f).filter((o) => o.rings.some((r) => pointInRing(lon, lat, r))).sort((a, b) => b.prob[type] - a.prob[type])[0];
    return hit ? probeLines(hit, f.t, type, probTrend(this.store.ready().map((x) => x.data), hit.id, type, f.t)) : null;
  }
}
