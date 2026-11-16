// User annotations: point markers, distance measurement, radial measure, manual storm track,
// storm-motion picking and telestration.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer } from './base';
import { LineSet, PointSet, TextSet, GlyphAtlas, SHAPE, type Polyline, type Label, type PointSpec } from '../render/prims';
import { settings } from '../settings/store';
import { markers, textAnnotations } from '../app/stores';
import { gcDistanceKm, bearingDeg, destination } from '../gis/geodesy';
import { PolySet, type FillStyle, type PolyFill } from '../render/polys';
import type { GpsFix } from '../data/gps';
import { cityImpacts, frontLine, swathBand, formatClock, type LL, type Motion, type CityPt, type Impact } from '../app/tracks';

export { gcDistanceKm, bearingDeg, destination };
export const fmtDist = (km: number) => (settings.bool('config.distanceMeasureImperial') ? `${(km * 0.621371).toFixed(km < 16 ? 1 : 0)} mi` : `${km.toFixed(km < 10 ? 1 : 0)} km`);

export class AnnotationLayer extends MapLayer {
  readonly id = 'annotations';
  readonly title = 'Annotations';
  private lines: LineSet; private pts: PointSet; private text: TextSet;
  measure: [number, number][] = [];
  radial: [number, number] | null = null;
  /** Manual storm track: the clicked cell point or line/path front, the time it was drawn and its motion. */
  manualTrack: { pts: LL[]; t0: number; motion: Motion; done: boolean } | null = null;
  /** Cities crossed by the manual track swath (minutes after t0), filled by tick(). */
  impacts: Impact[] = [];
  cities: () => CityPt[] = () => [];
  gpsFix: () => GpsFix | null = () => null;
  private fills: PolySet;
  private notes: TextSet;
  telestration: [number, number][][] = [];
  dirty = true;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r); this.lines = new LineSet(r); this.pts = new PointSet(r); this.text = new TextSet(r, atlas); this.fills = new PolySet(r); this.notes = new TextSet(r, atlas); this.notes.style = 'Annotations'; }
  styleChanged() { this.dirty = true; }
  enabled() { return true; }

  tick() {
    if (!this.dirty) return;
    this.dirty = false;
    const tc = settings.arr<number>('config.telestrateColor');
    const mc = settings.arr<number>('settings.nexradManualTracksColor');
    const ec = settings.arr<number>('settings.nexradManualTracksExtrusionColor');
    this.lines.setStyles([
      { color: [255, 255, 255, 230], width: 2 }, { color: [tc[0], tc[1], tc[2], 255], width: settings.num('config.telestrateWidth') / 2 },
      { color: [mc[0], mc[1], mc[2], 240], width: 2.2 }, { color: [ec[0], ec[1], ec[2], ec[3]], width: 2 }, { color: [255, 230, 120, 230], width: 1.6, dash: 10 },
      { color: [mc[0], mc[1], mc[2], 170], width: 1.2, dash: 6 },
    ]);
    const lines: Polyline[] = [], labels: Label[] = [], pts: PointSpec[] = [];
    const g = this.gpsFix();
    if (g && g.lat !== null && g.lon !== null) {
      // GPS position: ring + heading arrow (course over ground) when moving.
      pts.push({ lon: g.lon, lat: g.lat, size: 18, shape: SHAPE.ring, color: [60, 200, 255, 255] }, { lon: g.lon, lat: g.lat, size: 7, shape: SHAPE.circle, color: [60, 200, 255, 255], outline: 0.25 });
      if (g.headingDeg !== null && (g.speedKt ?? 0) > 1) { const e = destination(g.lon, g.lat, g.headingDeg, 3); lines.push({ coords: [g.lon, g.lat, ...e], style: 0, height: 0.00002 }); }
    }
    for (const m of markers.list) { pts.push({ lon: m.lon, lat: m.lat, size: 10, shape: SHAPE.diamond, color: [255, 220, 60, 255], outline: 0.2 }); labels.push({ lon: m.lon, lat: m.lat, text: m.label, size: 12, color: [255, 240, 180, 255], halo: [0, 0, 0, 220], dx: 9, align: 'left', priority: 9 }); }
    if (this.measure.length >= 2) {
      lines.push({ coords: this.measure.flat(), style: 0 });
      let total = 0;
      for (let i = 1; i < this.measure.length; i++) total += gcDistanceKm(...this.measure[i - 1], ...this.measure[i]);
      const last = this.measure[this.measure.length - 1];
      labels.push({ lon: last[0], lat: last[1], text: fmtDist(total), size: 13, color: [255, 255, 255, 255], halo: [0, 0, 0, 230], dx: 8, align: 'left', priority: 10 });
    }
    for (const p of this.measure) pts.push({ lon: p[0], lat: p[1], size: 6, shape: SHAPE.circle, color: [255, 255, 255, 255] });
    if (this.radial) {
      const [o, p] = [this.radialOrigin, this.radial];
      if (o) {
        lines.push({ coords: [...o, ...p], style: 4 });
        labels.push({ lon: p[0], lat: p[1], text: `${fmtDist(gcDistanceKm(...o, ...p))} @ ${bearingDeg(...o, ...p).toFixed(0)}°`, size: 13, color: [255, 240, 160, 255], halo: [0, 0, 0, 230], dx: 8, align: 'left', priority: 10 });
      }
    }
    for (const s of this.telestration) if (s.length >= 2) lines.push({ coords: s.flat(), style: 1, height: 0.00003 });
    this.buildManualTrack(lines, pts, labels, mc);
    this.lines.setLines(lines); this.pts.setPoints(pts); this.text.setLabels(labels);
    this.notes.setLabels(textAnnotations.list.map((a) => ({ lon: a.lon, lat: a.lat, text: a.text, size: 16, color: [255, 255, 255, 255], halo: [0, 0, 0, 230], priority: 1e9 })));
  }
  radialOrigin: [number, number] | null = null;

  /**
   * Manual track: the front swept along the storm motion for the extrapolation time, filled in gradient steps from
   * the extrusion colour to the fade colour (stepped, or smooth within each step with "inner gradient"); the leading
   * "flash upper" percentage of the swath pulses. Interval lines/markers every interval minutes with time captions.
   */
  private buildManualTrack(lines: Polyline[], pts: PointSpec[], labels: Label[], mc: number[]) {
    const mt = this.manualTrack;
    const styles: FillStyle[] = [], polys: PolyFill[] = [];
    this.impacts = [];
    if (mt && mt.pts.length) {
      const front = frontLine(mt.pts, mt.motion);
      const ext = Math.max(1, settings.num('settings.nexradManualTracksExtrapolationTime'));
      if (mt.pts.length > 1) lines.push({ coords: mt.pts.flat(), style: 2, height: 0.00002 });
      for (const p of mt.pts) pts.push({ lon: p[0], lat: p[1], size: 7, shape: SHAPE.circle, color: [mc[0], mc[1], mc[2], 255], outline: 0.25 });
      if (mt.done) {
        const c0 = settings.arr<number>('settings.nexradManualTracksExtrusionColor'), c1 = settings.arr<number>('settings.nexradManualTracksExtrusionFadeColor');
        const steps = Math.max(1, Math.round(settings.num('settings.nexradManualTracksExtrusionIntervals')));
        const sub = settings.bool('settings.nexradManualTracksExtrusionInnerGradient') ? 6 : 1;
        const n = steps * sub;
        const mix = (f: number) => c0.map((v, i) => Math.round(v + (c1[i] - v) * f)) as [number, number, number, number];
        for (let k = 0; k < n; k++) {
          // Stepped: step j has the j/(steps−1) colour. Inner gradient: continuous across each step's sub-bands.
          const f = sub === 1 ? (steps > 1 ? k / (steps - 1) : 0) : (k + 0.5) / n;
          styles.push({ color: mix(Math.min(1, f)) });
          polys.push({ tris: swathBand(front, mt.motion, (ext * k) / n, (ext * (k + 1)) / n), style: k, height: 0.000004 });
        }
        if (settings.bool('settings.nexradManualTracksExtrusionFlashUpper')) {
          const pct = Math.min(100, Math.max(1, settings.num('settings.nexradManualTracksExtrusionFlashUpperPercent')));
          const top = mix(0);
          styles.push({ color: [top[0], top[1], top[2], Math.min(255, top[3])], color2: [top[0], top[1], top[2], 0], interval: 1, nonLinear: true });
          polys.push({ tris: swathBand(front, mt.motion, 0, (ext * pct) / 100), style: styles.length - 1, height: 0.000005 });
        }
        lines.push({ coords: front.flat(), style: 2, height: 0.00002 });
        const step = Math.max(1, settings.num('settings.nexradManualTracksIntervalMinutes'));
        const captions = !settings.bool('settings.nexradManualTracksHideAllCaptions');
        const raised = settings.bool('settings.nexradManualTracksTimePoints3D') ? (settings.num('settings.nexradManualTracksTimePoints3DHeight') * 50) / 6371000 : 0;
        const fmt = settings.str('settings.nexradManualTracksTimeFormat') || 'hh:nn am/pm';
        const mid = (f: LL[]) => f[Math.floor((f.length - 1) / 2)];
        for (let m = step; m <= ext + 1e-6; m += step) {
          const moved = front.map((p) => destination(p[0], p[1], (mt.motion.fromDeg + 180) % 360, (mt.motion.speedKt * 1.852 * m) / 60));
          if (settings.bool('settings.nexradManualTracksShowIntervalLines')) lines.push({ coords: moved.flat(), style: 5, height: 0.00002 });
          const c = mt.pts.length === 1 ? destination(mt.pts[0][0], mt.pts[0][1], (mt.motion.fromDeg + 180) % 360, (mt.motion.speedKt * 1.852 * m) / 60) : mid(moved);
          if (settings.bool('settings.nexradManualTracksShowTimePoints')) {
            pts.push({ lon: c[0], lat: c[1], size: 7, shape: SHAPE.plus, color: [mc[0], mc[1], mc[2], 255] });
            if (captions) labels.push({ lon: c[0], lat: c[1], text: formatClock(mt.t0 + m * 60e3, fmt), size: 11, color: [255, 255, 255, 255], halo: [0, 0, 0, 220], dy: raised ? 0 : -10, height: raised || undefined, priority: 8 });
          }
        }
        if (settings.bool('settings.nexradManualTracksShowImpactedCities')) this.impacts = cityImpacts(front, mt.motion, ext, this.cities());
        if (captions) {
          const max = Math.max(0, settings.num('settings.nexradManualTracksImpactedCitiesMaxCount'));
          for (const c of this.impacts.slice(0, max)) {
            const city = this.cities().find((q) => q.n === c.name);
            if (city) labels.push({ lon: city.lon, lat: city.lat, text: formatClock(mt.t0 + c.minutes * 60e3, fmt), size: 11, color: [255, 220, 120, 255], halo: [0, 0, 0, 230], dy: 12, priority: 9 });
          }
        }
      }
    }
    this.fills.setStyles(styles); this.fills.setPolys(polys);
  }

  /** Minutes after the track's start at which the swath reaches a point (rollover tracking), or null. */
  trackEtaAt(lon: number, lat: number): number | null {
    const mt = this.manualTrack;
    if (!mt?.done) return null;
    const hit = cityImpacts(frontLine(mt.pts, mt.motion), mt.motion, Math.max(1, settings.num('settings.nexradManualTracksExtrapolationTime')), [{ n: '', lon, lat, pop: 0 }]);
    return hit.length ? hit[0].minutes : null;
  }
  draw(ctx: DrawContext) { if (ctx.probe) return; this.fills.draw(ctx); this.notes.draw(ctx); this.lines.draw(ctx); this.pts.draw(ctx); this.text.draw(ctx); }
}
