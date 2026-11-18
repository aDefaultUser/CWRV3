// Radar analysis overlays drawn with the NEXRAD layer: range rings and azimuth spokes around the selected site, and
// the VR-shear measurement. Its two samples are read with the GPU probe of the NEXRAD layer (what Probe shows) and
// belong to the scan they were read from: a new scan at the timeline time is re-read, and a product, tilt or site
// change clears the measurement. With several panes the measurement reads the pane its first point was clicked in
// when that pane shows velocity, else the first pane that does; its points are drawn in every pane.
import type { DrawContext, ProbeResult, Renderer } from '../render/renderer';
import { LineSet, PointSet, TextSet, GlyphAtlas, SHAPE, type Polyline, type Label, type PointSpec } from '../render/prims';
import { settings } from '../settings/store';
import { lonLatToXYZ } from '../render/camera';
import { rangeRings, vrShear, beamAt, beamText, kmPerUnit, fmtRange, fmtHeight, type VrShear } from '../radar/beam';
import { KT } from '../sections/sounding-math';
import type { NexradLayer } from './nexrad';
import { panes } from '../app/panes';

type LL = [number, number];
/** Furthest ground range (km) at which the probe shows beam geometry (Level 2 and Level 3 reflectivity coverage). */
const BEAM_RANGE_KM = 460;
const S = (k: string) => `ext.settings.nexradRangeRings${k}`;

interface Shear {
  /** Pane whose product is measured, and the product identity (site, level, product, tilt) the points were placed on. */
  pane: number; id: string; pts: LL[];
  /** Scan key the samples were read from, and the samples in m/s (null = no data or range folded). */
  scan: string; values: (number | null)[] | null; pending: boolean; note: string;
  result: VrShear | null; elevation: number;
}

export class RadarTools {
  private lines: LineSet; private pts: PointSet; private text: TextSet;
  private key = '';
  shear: Shear | null = null;

  constructor(private r: Renderer, atlas: GlyphAtlas, private nexrad: NexradLayer) {
    this.lines = new LineSet(r); this.pts = new PointSet(r); this.text = new TextSet(r, atlas);
  }

  /** Identity of the NEXRAD product a pane displays; a measurement is cleared when it changes. */
  private productId(pane: number) { const n = this.nexrad; return n.isL2(pane) ? `L2|${n.l2Identity(pane)}` : `L3|${n.l3Identity(pane)}`; }
  /** A pane shows base, dealiased or storm-relative velocity (Level 2; never the live composite), or a Level 3 velocity product. */
  velocityShown(pane = 0) { const n = this.nexrad; return n.enabled() && (n.isL2(pane) ? [1, 6, 7].includes(n.product(pane)) : n.l3Entry(pane).category === 'Velocity'); }
  /** The pane a measurement started in `pane` reads: that pane when it shows velocity, else the first that does. */
  private velocityPane(pane: number): number | null {
    const shown = Array.from({ length: panes.count }, (_, p) => p).filter((p) => this.velocityShown(p));
    return shown.includes(pane) ? pane : shown[0] ?? null;
  }

  /** Starts a new measurement for the pane clicked (or the first velocity pane); returns why it cannot start, or null. */
  startShear(pane = 0): string | null {
    const p = this.velocityPane(pane);
    if (p === null) return 'VR shear needs a velocity product (Level 2 velocity/SRV or Level 3 velocity/SRM) on the map.';
    this.shear = { pane: p, id: this.productId(p), pts: [], scan: '', values: null, pending: false, note: 'Click the maximum inbound and outbound velocities', result: null, elevation: NaN };
    return null;
  }
  /** Adds a point of the measurement in progress, clicked in `pane`; true when both points are placed. */
  shearClick(ll: LL, pane = 0): boolean {
    // The first point decides the pane that is measured.
    if (!this.shear || this.shear.pts.length !== 1) { const err = this.startShear(pane); if (err) { this.cancelShear(); return true; } }
    const s = this.shear!;
    s.pts.push(ll);
    s.note = s.pts.length < 2 ? 'Click the second point' : 'Reading the scan…';
    this.key = '';
    return s.pts.length >= 2;
  }
  cancelShear() { this.shear = null; this.key = ''; }

  /** Clears a measurement whose product no longer is the displayed one; re-reads it when the shown scan changed. */
  private validate() {
    const s = this.shear;
    if (!s) return;
    if (s.pane >= panes.count || s.id !== this.productId(s.pane) || !this.velocityShown(s.pane)) { this.cancelShear(); return; }
    const scan = this.nexrad.shownScan(s.pane);
    if (s.pts.length === 2 && !s.pending && (scan?.key ?? '') !== s.scan) this.sample();
  }

  private sample() {
    const s = this.shear!, scan = this.nexrad.shownScan(s.pane), info = this.nexrad.siteInfo();
    const unread = (note: string) => { if (s.values || s.result || s.note !== note) { s.values = null; s.result = null; s.note = note; this.key = ''; } };
    if (!scan || scan.elevation === null || !info) { s.scan = scan?.key ?? ''; unread('No velocity scan at the timeline time'); return; }
    const cam = this.r.camera;
    const xy = s.pts.map(([lon, lat]) => cam.project(lonLatToXYZ(lon, lat)));
    // Off screen: nothing is read, and the next frames try again (the scan key stays unread).
    if (xy.some(([x, y, front]) => !front || x < 0 || y < 0 || x > cam.width || y > cam.height)) { unread('Both points must be on screen to read the scan'); return; }
    s.scan = scan.key; s.values = null; s.result = null; this.key = '';
    s.pending = true;
    const got: (ProbeResult | null)[] = [];
    let n = 0;
    const done = () => {
      s.pending = false;
      // A newer measurement, another product or another scan: this read is stale (validate() reads again).
      if (this.shear !== s || s.id !== this.productId(s.pane) || this.nexrad.shownScan(s.pane)?.key !== scan.key) return;
      s.values = got.map((g) => (g && g.layer === 'nexrad' ? this.ms(g.value, s.pane) : null));
      s.elevation = scan.elevation!;
      if (s.values.some((v) => v === null)) { s.note = 'No velocity (no data or range folded) at a point'; this.key = ''; return; }
      const site = { lon: info.lon, lat: info.lat, elevM: info.elevFt * 0.3048 };
      s.result = vrShear({ lon: s.pts[0][0], lat: s.pts[0][1], ms: s.values[0]! }, { lon: s.pts[1][0], lat: s.pts[1][1], ms: s.values[1]! }, site, s.elevation);
      s.note = '';
      this.key = '';
    };
    xy.forEach(([x, y], i) => this.r.probeOnce.push({ x, y, layer: 'nexrad', pane: s.pane, done: (res) => { got[i] = res; if (++n === xy.length) done(); } }));
  }

  /** Probe sample (0..1) → m/s, null for range folded (the value mapping of NexradLayer.probeText). */
  private ms(f: number, pane: number): number | null {
    if (Math.abs(f * 65535 - 256) <= 2) return null;
    const d = this.nexrad.displayRange(pane), v = d.low + (d.high - d.low) * f;
    return d.unit === 'kts' ? v * KT : v;
  }
  /** Velocity in the probe's unit (product unit, or mph when forced). */
  private vel(ms: number, signed = true) {
    const unit = this.nexrad.displayRange(this.shear?.pane ?? 0).unit;
    const [v, u] = settings.bool('config.generalRadarVelocityMPHForce') ? [ms * 2.23694, 'mph'] : unit === 'kts' ? [ms / KT, 'kt'] : [ms, 'm/s'];
    return `${signed && v > 0 ? '+' : ''}${v.toFixed(1)} ${u}`;
  }

  /** Readout of the measurement for the analysis dialog. */
  shearText(): string {
    this.validate();
    const s = this.shear;
    if (!s) return 'No measurement. Start it, then click the maximum inbound and outbound velocities (Esc cancels).';
    const r = s.result;
    if (!r) return s.note;
    const imp = settings.bool('config.distanceMeasureImperial');
    const scan = this.nexrad.shownScan(s.pane), site = this.nexrad.siteInfo();
    return [
      `Vin ${this.vel(r.vin)} · Vout ${this.vel(r.vout)} · ΔV ${this.vel(r.dv, false)}`,
      r.vr !== null ? `Vr ${this.vel(r.vr, false)}` : 'Same sign: no couplet, Vr not computed',
      `Distance ${fmtRange(r.distKm, imp, 2)} · Shear ${r.shear.toExponential(2)} s⁻¹`,
      `Mean range ${fmtRange(r.meanRangeKm, imp)} · Beam ${fmtHeight(r.beam.arlKm, imp)} ARL (${fmtHeight(r.beam.mslKm, imp)} MSL)`,
      `${site?.id ?? ''} ${s.elevation.toFixed(1)}° scan ${scan ? new Date(scan.t).toISOString().slice(11, 16) : '--'}Z${panes.count > 1 ? ` · pane ${s.pane + 1}` : ''}`,
    ].join('\n');
  }

  /** Probe lines for the beam of a pane's tilt over a pane-relative CSS pixel when it shows a single-tilt product; [] otherwise. */
  beamProbe(x: number, y: number, pane = 0): string[] {
    const scan = this.nexrad.shownScan(pane), info = this.nexrad.siteInfo(), ll = this.r.camera.pick(x, y);
    if (!scan || scan.elevation === null || !info || !ll) return [];
    const b = beamAt({ lon: info.lon, lat: info.lat, elevM: info.elevFt * 0.3048 }, ll[0], ll[1], scan.elevation);
    return b.groundKm <= BEAM_RANGE_KM ? beamText(b, scan.elevation, settings.bool('config.distanceMeasureImperial')) : [];
  }

  draw(ctx: DrawContext, site: { id: string; lon: number; lat: number }) {
    this.validate();
    const on = settings.bool(S(''));
    const imp = settings.bool('config.distanceMeasureImperial');
    const s = this.shear;
    const key = JSON.stringify([site.id, on && [S('Interval'), S('Count'), S('Color'), S('Width'), S('Labels'), S('Spokes'), S('SpokeInterval')].map((k) => settings.get(k)), imp, s && [s.pts, s.values, settings.bool('config.generalRadarVelocityMPHForce')]]);
    if (key !== this.key) { this.key = key; this.build(site, on, imp); }
    this.lines.draw(ctx); this.pts.draw(ctx); this.text.draw(ctx);
  }

  private build(site: { lon: number; lat: number }, on: boolean, imp: boolean) {
    const c = settings.arr<number>(S('Color')), w = settings.num(S('Width'));
    const col: [number, number, number, number] = [c[0], c[1], c[2], c[3] ?? 255];
    this.lines.setStyles([
      { color: col, width: w }, { color: [c[0], c[1], c[2], Math.round(col[3] * 0.7)], width: Math.max(0.5, w * 0.75), dash: 8 },
      { color: [255, 230, 120, 240], width: 2, dash: 6 },
    ]);
    const lines: Polyline[] = [], labels: Label[] = [], pts: PointSpec[] = [];
    if (on) {
      const step = settings.num(S('Interval')), g = rangeRings(site, step * kmPerUnit(imp), settings.num(S('Count')), settings.bool(S('Spokes')) ? settings.num(S('SpokeInterval')) : 0);
      for (const ring of g.rings) lines.push({ coords: ring, style: 0, height: 0.00001 });
      for (const sp of g.spokes) lines.push({ coords: sp, style: 1, height: 0.00001 });
      if (settings.bool(S('Labels'))) g.labels.forEach((l, i) => labels.push({ lon: l.lon, lat: l.lat, text: `${+(step * (i + 1)).toFixed(2)} ${imp ? 'mi' : 'km'}`, size: 11, color: [col[0], col[1], col[2], 255], halo: [0, 0, 0, 220], dy: -7, priority: 3 }));
    }
    const s = this.shear;
    if (s) {
      if (s.pts.length === 2) lines.push({ coords: s.pts.flat(), style: 2, height: 0.00003 });
      s.pts.forEach((p, i) => {
        const v = s.values?.[i] ?? null;
        pts.push({ lon: p[0], lat: p[1], size: 9, shape: SHAPE.circle, color: v === null ? [255, 255, 255, 255] : v < 0 ? [40, 230, 120, 255] : [255, 80, 80, 255], outline: 0.3, height: 0.00003 });
        if (v !== null) labels.push({ lon: p[0], lat: p[1], text: this.vel(v), size: 12, color: [255, 255, 255, 255], halo: [0, 0, 0, 230], dx: 9, align: 'left', priority: 12 });
      });
      const r = s.result;
      if (r && s.pts.length === 2) {
        const mid: LL = [(s.pts[0][0] + s.pts[1][0]) / 2, (s.pts[0][1] + s.pts[1][1]) / 2];
        labels.push({ lon: mid[0], lat: mid[1], text: r.vr !== null ? `Vr ${this.vel(r.vr, false)}` : `ΔV ${this.vel(r.dv, false)}`, size: 13, color: [255, 240, 160, 255], halo: [0, 0, 0, 230], dy: 14, priority: 13 });
      }
    }
    this.lines.setLines(lines); this.pts.setPoints(pts); this.text.setLabels(labels);
  }
}
