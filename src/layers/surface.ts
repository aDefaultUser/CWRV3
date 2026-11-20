// Basic → Surface: MSLP contours, 10 m wind, high-res fill from hourly HRRR analyses (public NOAA
// bucket) and fronts/centers from the WPC coded surface bulletin (via the loopback proxy).
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, type LegendSpec } from './base';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';
import { fetchText } from '../data/net';
import { hrrrUrl, type HrrrField } from '../decode/hrrr';
import { latestCycle } from '../data/hrrr-service';
import { parseCodsus, type SurfaceAnalysis } from '../decode/wpc';
import { LineSet, PointSet, TextSet, GlyphAtlas, SHAPE, declutter, type Polyline, type Label, type PointSpec } from '../render/prims';
import { WIND_BINS } from '../gis/wind-arrows';
import { RasterDraw, Lut, lambertProj, type ProjParams } from '../render/raster';
import { getPalette } from '../palettes/library';
import { evalPalette } from '../render/palette';
import { lonLatToXYZ } from '../render/camera';

const NO_SEGS = new Float32Array(0);

const FILL_FIELDS: { field: HrrrField; min: number; max: number; unit: 'F' | 'J'; label: string }[] = [
  { field: 't2m', min: -40, max: 120, unit: 'F', label: '°F' },
  { field: 'td2m', min: -20, max: 85, unit: 'F', label: '°F' },
  { field: 'sbcape', min: 0, max: 6000, unit: 'J', label: 'J/kg' },
  { field: 'mucape', min: 0, max: 6000, unit: 'J', label: 'J/kg' },
  { field: 'mlcape', min: 0, max: 6000, unit: 'J', label: 'J/kg' },
];

/** One HRRR hour; the line segments (built by the worker) are only uploaded when the shown hour changes. */
interface Hour { t: number; contours?: { level: number; coords: number[] }[]; mslpSegs?: Float32Array; windSegs?: Float32Array; fill?: GPUTexture; fillIdx?: number; proj?: ProjParams }

export class SurfaceLayer extends MapLayer {
  readonly id = 'surface';
  readonly title = 'Surface analysis';
  private hours = new Map<number, Hour>();
  private loading = new Set<string>();
  private mslpLines: LineSet; private mslpText: TextSet;
  private windLines: LineSet;
  private frontLines: LineSet; private frontPts: PointSet; private centerText: TextSet;
  private fillDraw: RasterDraw;
  private luts = new Map<string, Lut>();
  private wpc: SurfaceAnalysis | null = null;
  private lastKey = ''; private lastCam = '';
  constructor(r: Renderer, atlas: GlyphAtlas) {
    super(r);
    this.mslpLines = new LineSet(r); this.mslpText = new TextSet(r, atlas); this.windLines = new LineSet(r);
    this.frontLines = new LineSet(r); this.frontPts = new PointSet(r); this.centerText = new TextSet(r, atlas); this.fillDraw = new RasterDraw(r);
  }
  enabled() { return ['layerState.MSLPOn', 'layerState.10mWindVectorsOn', 'layerState.FrontsOn', 'layerState.CentersOn', 'layerState.saFillOn'].some((k) => settings.bool(k)); }
  invalidate() { this.fillDraw.invalidate(); }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const latest = await latestCycle();
    if (latest === null) { this.setStatus('error', 'HRRR: no recent cycle found'); return; }
    const hours: number[] = [];
    for (let t = Math.floor(timeline.loopStart / 3600e3) * 3600e3; t <= Math.min(latest, timeline.loopEnd); t += 3600e3) hours.push(t);
    // The newest analysis is added only for a live window (an archived loop keeps its own hours).
    if (!hours.includes(latest) && latest <= timeline.loopEnd + 3600e3 && latest >= timeline.loopStart) hours.push(latest);
    const wantM = settings.bool('layerState.MSLPOn'), wantW = settings.bool('layerState.10mWindVectorsOn'), wantF = settings.bool('layerState.saFillOn');
    const fillIdx = settings.num('layerState.saFillIdx');
    for (const h of hours.slice(-7)) {
      const cur = this.hours.get(h) ?? { t: h };
      this.hours.set(h, cur);
      const needM = wantM && !cur.contours, needW = wantW && !cur.windSegs, needF = wantF && (cur.fillIdx !== fillIdx);
      if (!needM && !needW && !needF) continue;
      const key = `${h}|${needM}|${needW}|${needF}|${fillIdx}`;
      if (this.loading.has(key)) continue;
      this.loading.add(key);
      const ff = FILL_FIELDS[fillIdx];
      pool.for(this.id).run('surface', {
        url: hrrrUrl(new Date(h)),
        mslp: needM ? { interval: settings.num('settings.generalMSLPContourInterval'), kernel: settings.num('settings.generalContourKernel') } : undefined,
        wind: needW ? { step: 14 } : undefined,
        fill: needF ? { field: ff.field, min: ff.min, max: ff.max, unit: ff.unit } : undefined,
      }).then((res) => {
        if (res.contours) { cur.contours = res.contours; cur.mslpSegs = res.mslpSegs; }
        if (res.windSegs) cur.windSegs = res.windSegs;
        if (res.fill) { cur.fill?.destroy(); cur.fill = this.r.gpu.texture2D(res.nx, res.ny, 'r8unorm', res.fill, 1, this.id); cur.fillIdx = fillIdx; cur.proj = lambertProj(res.grid); this.fillDraw.invalidate(); }
        this.lastKey = '';
        this.setStatus('ready', `HRRR ${new Date(h).toISOString().slice(0, 13)}Z loaded`);
      }, (e) => this.setStatus('error', `HRRR: ${e.message}`)).finally(() => this.loading.delete(key));
    }
    for (const k of [...this.hours.keys()]) if (k < timeline.loopStart - 3600e3) { this.hours.get(k)!.fill?.destroy(); this.hours.delete(k); }
    if (settings.bool('layerState.FrontsOn') || settings.bool('layerState.CentersOn')) {
      try { this.wpc = parseCodsus(await fetchText('https://tgftp.nws.noaa.gov/data/raw/as/asus01.kwbc.cod.sus.txt')); this.lastKey = ''; }
      catch (e) { this.setStatus('error', `WPC fronts: ${(e as Error).message}`); }
    }
    if (this.loading.size) this.setStatus('loading', `HRRR: ${this.loading.size} requests`);
    else if (this.status.state !== 'error') this.setStatus('ready', 'HRRR current');
  }

  /** Contour interval changes require re-contouring. */
  resetContours() { for (const h of this.hours.values()) h.contours = h.mslpSegs = undefined; }

  private frameAt(t: number) {
    const frames = [...this.hours.values()].filter((h) => h.contours || h.windSegs || h.fill).sort((a, b) => a.t - b.t);
    return bracket(frames, t, false, 3 * 3600e3).a;
  }

  tick(t: number) {
    if (!this.enabled()) return;
    const h = this.frameAt(t);
    const cam = this.r.camera;
    const camKey = `${cam.cur.lon.toFixed(3)},${cam.cur.lat.toFixed(3)},${cam.cur.z.toFixed(2)},${cam.cur.swivel.toFixed(1)}`;
    const key = `${h?.t}|${!!h?.contours}|${!!h?.windSegs}|${!!this.wpc}|${['MSLPOn', '10mWindVectorsOn', 'FrontsOn', 'CentersOn'].map((k) => +settings.bool('layerState.' + k)).join('')}|${settings.num('settings.generalContourWidth')}|${settings.num('settings.generalContourAlpha')}`;
    if (key !== this.lastKey) { this.lastKey = key; this.lastCam = ''; this.rebuild(h); }
    if (camKey !== this.lastCam) { this.lastCam = camKey; this.placeFrontSymbols(); }
    if (settings.bool('layerState.MSLPOn')) {
      const vis = declutter(this.r, this.mslpText, 120);
      for (let i = 0; i < vis.length; i++) this.mslpText.alpha[i] = vis[i];
      this.mslpText.flushAlpha();
    }
  }

  private rebuild(h: Hour | null) {
    // MSLP
    const cc = settings.arr<number>('settings.generalContourColor'), bc = settings.arr<number>('settings.generalContourBorderColor');
    const a = Math.round(settings.num('settings.generalContourAlpha') * 255), w = settings.num('settings.generalContourWidth');
    this.mslpLines.setStyles([{ color: [bc[0], bc[1], bc[2], settings.bool('settings.generalContourBorders') ? a : 0], width: w + 2.2 }, { color: [cc[0], cc[1], cc[2], Math.min(255, a + 60)], width: w }]);
    const labels: Label[] = [];
    const contours = settings.bool('layerState.MSLPOn') ? h?.contours : undefined;
    for (const c of contours ?? []) {
      const n = c.coords.length / 2;
      for (let k = Math.floor(n / 2) % 40; k < n; k += 80) labels.push({ lon: c.coords[k * 2], lat: c.coords[k * 2 + 1], text: c.level.toFixed(0), size: 11, color: [230, 235, 255, 255], halo: [20, 30, 60, 220], priority: 1 });
    }
    this.mslpLines.setTessellated((contours && h?.mslpSegs) || NO_SEGS);
    this.mslpText.setLabels(labels);
    // Wind vectors (arrows colored by speed through the 10 m wind palette).
    const pal = getPalette(settings.str('settings.saWindPalette'));
    const alpha = settings.num('settings.saWindAlpha') / 255;
    this.windLines.setStyles(WIND_BINS.map((b) => { const c = evalPalette(pal.frames[0], b); return { color: [c[0], c[1], c[2], Math.round(Math.max(120, c[3]) * alpha)], width: 1.4 }; }));
    this.windLines.setTessellated(settings.bool('layerState.10mWindVectorsOn') && h?.windSegs ? h.windSegs : NO_SEGS);
    // Fronts and centers.
    const fl: Polyline[] = [];
    this.frontLines.setStyles([
      { color: [30, 100, 255, 255], width: 2.4 }, { color: [235, 30, 30, 255], width: 2.4 }, { color: [170, 40, 200, 255], width: 2.4 },
      { color: [160, 110, 60, 230], width: 1.8, dash: 12 }, { color: [235, 30, 30, 255], width: 2.4, dash: 18 }, { color: [210, 150, 60, 255], width: 2.0, dash: 6 },
    ]);
    const ct: Label[] = [];
    if (this.wpc) {
      if (settings.bool('layerState.FrontsOn')) for (const f of this.wpc.fronts) {
        const coords = f.points.flat();
        const style = f.type === 'COLD' ? 0 : f.type === 'WARM' ? 1 : f.type === 'OCFNT' ? 2 : f.type === 'TROF' ? 3 : f.type === 'DRYLINE' ? 5 : 0;
        fl.push({ coords, style });
        if (f.type === 'STNRY') fl.push({ coords, style: 4 });
      }
      if (settings.bool('layerState.CentersOn')) for (const c of this.wpc.centers) {
        const alphaC = settings.num('settings.saCentersAlpha');
        const col: [number, number, number, number] = c.kind === 'H' ? [60, 120, 255, alphaC] : [240, 40, 40, alphaC];
        ct.push({ lon: c.lon, lat: c.lat, text: c.kind, size: 26, color: col, halo: [0, 0, 0, 200], priority: 5 });
        ct.push({ lon: c.lon, lat: c.lat, text: String(c.mb), size: 11, color: col, halo: [0, 0, 0, 200], dy: 16, priority: 4 });
      }
    }
    this.frontLines.setLines(fl);
    this.centerText.setLabels(ct);
  }

  /** Front symbols are oriented in screen space, so they are re-placed when the camera moves. */
  private placeFrontSymbols() {
    const pts: PointSpec[] = [];
    if (this.wpc && settings.bool('layerState.FrontsOn')) {
      const cam = this.r.camera;
      for (const f of this.wpc.fronts) {
        if (!['COLD', 'WARM', 'OCFNT', 'STNRY'].includes(f.type)) continue;
        let n = 0;
        for (let i = 0; i + 1 < f.points.length; i++) {
          const [a, b] = [f.points[i], f.points[i + 1]];
          const pa = cam.project(lonLatToXYZ(a[0], a[1])), pb = cam.project(lonLatToXYZ(b[0], b[1]));
          if (!pa[2] || !pb[2]) continue;
          const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
          const segPx = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
          const count = Math.max(1, Math.floor(segPx / 34));
          for (let k = 0; k < count; k++) {
            const t = (k + 0.5) / count;
            const kind = f.type === 'COLD' ? 0 : f.type === 'WARM' ? 1 : f.type === 'OCFNT' ? n % 2 : n % 2;
            const color: [number, number, number, number] = f.type === 'OCFNT' ? [170, 40, 200, 255] : kind === 0 ? [30, 100, 255, 255] : [235, 30, 30, 255];
            const flip = f.type === 'STNRY' && kind === 1 ? Math.PI : 0;
            pts.push({ lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, size: 13, shape: kind === 0 ? SHAPE.frontTri : SHAPE.semicircle, color, rot: -ang + flip });
            n++;
          }
        }
      }
    }
    this.frontPts.setPoints(pts);
  }

  private lut(name: string, min: number, max: number) {
    const key = `${name}|${min}|${max}`;
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low: min - (max - min) / 254, high: max }); this.luts.set(key, l); }
    return l;
  }

  legends(): LegendSpec[] {
    if (!settings.bool('layerState.saFillOn') || !settings.bool('settings.saLegend')) return [];
    const ff = FILL_FIELDS[settings.num('layerState.saFillIdx')];
    const name = settings.arr<string>('settings.saFillPalettes')[settings.num('layerState.saFillIdx')];
    return [{ id: 'sa', palette: getPalette(name), low: ff.min, high: ff.max, unit: ff.label, lut: this.lut(name, ff.min, ff.max) }];
  }
  hasFill() { return settings.bool('layerState.saFillOn') && [...this.hours.values()].some((h) => h.fill); }
  fillProbeText(v: number) { const ff = FILL_FIELDS[settings.num('layerState.saFillIdx')]; return `${(ff.min + ((ff.max - ff.min) * (v * 255 - 1)) / 254).toFixed(ff.unit === 'F' ? 1 : 0)} ${ff.label}`; }

  drawFill(ctx: DrawContext) {
    if (settings.bool('layerState.saFillOn')) {
      const fills = [...this.hours.values()].filter((h) => h.fill && h.fillIdx === settings.num('layerState.saFillIdx')).sort((a, b) => a.t - b.t);
      const { a, b, w } = bracket(fills, timeline.t, settings.bool('layerState.RasterDataTemporalInterpolation'), 2 * 3600e3);
      if (a?.fill && a.proj) {
        const ff = FILL_FIELDS[settings.num('layerState.saFillIdx')];
        const name = settings.arr<string>('settings.saFillPalettes')[settings.num('layerState.saFillIdx')];
        this.fillDraw.draw(ctx, { mode: 0, w, alpha: settings.num('settings.saFillAlpha') / 255, smoothing: true, bounds: [20, -135, 55, -60], proj: a.proj, luts: [this.lut(name, ff.min, ff.max)], data: [[a.fill, (b ?? a).fill!]] }, 3);
      }
    }
  }

  draw(ctx: DrawContext) {
    if (ctx.probe) return;
    this.mslpLines.draw(ctx); this.mslpText.draw(ctx);
    this.windLines.draw(ctx);
    this.frontLines.draw(ctx); this.frontPts.draw(ctx); this.centerText.draw(ctx);
  }
}

/** The fill part of the surface layer, drawn lower in the layer order (under radar). */
export class SurfaceFillLayer extends MapLayer {
  readonly id = 'surfaceFill';
  readonly title = 'High-res fill';
  constructor(r: Renderer, private s: SurfaceLayer) { super(r); }
  enabled() { return settings.bool('layerState.saFillOn'); }
  draw(ctx: DrawContext) { this.s.drawFill(ctx); }
  probeKind() { return this.s.hasFill() ? 'fill' : null; }
  probeText(v: number) { return this.s.fillProbeText(v); }
}
