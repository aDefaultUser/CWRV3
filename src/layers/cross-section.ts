// Vertical cross-section / RHI tool of the NEXRAD layer: the A→B line (or a radial in RHI mode) placed and edited on
// the map, drawn with distance ticks, and its section through the Level 2 volume drawn now, rendered on the GPU from
// the layer's volume pack into the section panel each time the pack, line, moment or panel size changes. The line can
// follow storm motion (end points advected from the time they were placed with the shown volume's motion). The panel
// probe reads the TypeScript reference sampler on a CPU copy of the same pack.
import type { DrawContext, PrepassContext, Renderer } from '../render/renderer';
import { LineSet, PointSet, TextSet, GlyphAtlas, SHAPE, type Polyline, type PointSpec, type Label } from '../render/prims';
import { SectionView } from '../render/section-view';
import { Lut } from '../render/raster';
import { packKey, type GpuPack, type PackRequest } from '../render/volume';
import { lonLatToXYZ } from '../render/camera';
import { sampleVolume, stormRelativeCode } from '../radar/volume-sample';
import type { VolumePack } from '../radar/volume-pack';
import { VOLUME_MOMENTS, isothermHeights } from '../radar/l2products';
import { isothermsAt } from '../radar/environment';
import { L2, L2_PALETTE_KEYS } from '../radar/sources';
import { fmtHeight, fmtRange } from '../radar/beam';
import { toLocal, toLonLat, polarOf, rhiLine, advect, sectionAt, sectionLength, beamCurve, probeGeometry, tickStep, type EN, type LL, type Section, type Motion } from '../radar/section-geometry';
import { SectionPanel, SECTION_MOMENTS, SECTION_MOMENT_NAMES, BACKGROUND, type SectionMoment, type Overlay } from '../ui/section-panel';
import { getPalette } from '../palettes/library';
import { settings } from '../settings/store';
import { timeline } from '../app/timeline';
import { pool } from '../workers/pool';
import type { NexradLayer } from './nexrad';

const S = (k: string) => `ext.settings.nexradSection${k}`;
/** Map product whose palette and value range a section moment uses (the pack codes are that product's codes). */
export const SECTION_PRODUCT: Record<SectionMoment, number> = { REF: 0, VEL: 6, SRV: 7, ZDR: 3, CC: 5, KDP: 10 };
const MI = 1.609344;
const utc = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** A placed line: end points in the radar's plane as they were at `t0` (ms), on the radar `site`. */
export interface SectionLine { a: EN; b: EN; t0: number; site: string }

export class CrossSection {
  line: SectionLine | null = null;
  /** A line being placed: A, the rubber-band B, and whether A was placed by a click (B then comes from a second click). */
  placing: { a: EN; b: EN | null; clicked: boolean; site: string } | null = null;
  private panel: SectionPanel | null = null;
  private view: SectionView | null = null;
  private lines: LineSet; private pts: PointSet; private text: TextSet;
  private mapKey = ''; private viewKey = ''; private legendKey = ''; private overlayKey = '';
  /** Volume time of the pack the section shows, which the line's position follows; null while none is shown. */
  private shownMs: number | null = null;
  /** What the panel shows now (for the probe): the pack, the request it is the pack of, line, moment and motion. */
  private shown: { pack: GpuPack; req: PackRequest | null; section: Section; moment: SectionMoment; srv: Motion | null } | null = null;
  private cpu: { key: string; pack: VolumePack | null; error?: string } | null = null;
  private luts = new Map<string, Lut>();
  /** Called when the line is cleared (the app ends the tool). */
  onClear: () => void = () => {};

  constructor(private r: Renderer, atlas: GlyphAtlas, private nexrad: NexradLayer) {
    this.lines = new LineSet(r); this.pts = new PointSet(r); this.text = new TextSet(r, atlas);
  }

  private site() { const i = this.nexrad.siteInfo(); return i ? { id: i.id, lon: i.lon, lat: i.lat, elevM: i.elevFt * 0.3048 } : null; }
  moment(): SectionMoment { return SECTION_MOMENTS[settings.num(S('Moment'))] ?? 'REF'; }
  private local(ll: LL): EN | null { const s = this.site(); return s && toLocal(s, ll[0], ll[1]); }

  /** End points now: as placed, or advected with the shown volume's storm motion from the time they were placed. */
  endpoints(t = this.shownMs ?? timeline.t): [EN, EN] | null {
    const l = this.line;
    if (!l) return null;
    if (!settings.bool(S('Follow'))) return [l.a, l.b];
    const m = this.nexrad.stormMotion(t), dt = t - l.t0;
    return [advect(l.a, m, dt), advect(l.b, m, dt)];
  }

  // ------------------------------------------------------------------------------------------- placement and editing
  /** Mouse down of the tool: starts a line at A (a second click's press does nothing; its release sets B). */
  press(ll: LL) {
    const p = this.local(ll), site = this.site();
    if (p && site && !this.placing) this.placing = { a: p, b: null, clicked: false, site: site.id };
  }
  /** Pointer moves while placing: B follows it. */
  move(ll: LL) {
    const p = this.local(ll);
    if (this.placing && p) { this.placing.b = p; this.mapKey = ''; }
  }
  /** Mouse up of the tool: a drag or a second click sets B and places the line (true); a first click waits for B. */
  release(ll: LL, moved: boolean): boolean {
    const pl = this.placing, b = this.local(ll), site = this.site();
    if (!pl || !b || !site) return false;
    if (!moved && !pl.clicked) { pl.clicked = true; return false; }
    if (Math.hypot(b[0] - pl.a[0], b[1] - pl.a[1]) < 0.5) return false; // keep waiting for a distinct B
    const [a, bb] = settings.bool(S('Rhi')) ? rhiLine(pl.a, b, b) : [pl.a, b];
    this.placing = null;
    this.line = { a, b: bb, t0: this.shownMs ?? timeline.t, site: site.id };
    return true;
  }
  cancelPlacing() { this.placing = null; this.mapKey = ''; }

  /** End point handle under a CSS pixel of the map, or null. */
  handleAt(x: number, y: number): 'a' | 'b' | null {
    const ends = this.endpoints(), site = this.site();
    if (!ends || !site) return null;
    const cam = this.r.camera;
    for (const [i, which] of [[0, 'a'], [1, 'b']] as const) {
      const [lon, lat] = toLonLat(site, ends[i]), [px, py, front] = cam.project(lonLatToXYZ(lon, lat));
      if (front && Math.hypot(px - x, py - y) <= 9) return which;
    }
    return null;
  }
  /** Moves an end point to a map point; in RHI mode both turn onto its radial. The motion reference becomes now. */
  dragHandle(which: 'a' | 'b', ll: LL) {
    const ends = this.endpoints(), p = this.local(ll);
    if (!ends || !p || !this.line) return;
    let [a, b] = ends;
    if (which === 'a') a = p; else b = p;
    if (settings.bool(S('Rhi'))) [a, b] = rhiLine(a, b, p);
    this.line = { ...this.line, a, b, t0: this.shownMs ?? timeline.t };
    this.mapKey = '';
  }

  /** Removes the line and closes the panel (Esc, site change, the panel's close box). */
  clear() {
    const had = !!(this.line || this.placing);
    this.line = null; this.placing = null; this.shown = null; this.shownMs = null; this.cpu = null;
    this.viewKey = ''; this.mapKey = ''; this.legendKey = ''; this.overlayKey = '';
    this.view?.destroy(); this.view = null;
    this.panel?.destroy(); this.panel = null;
    if (had) this.onClear();
  }

  private open() {
    const p = this.panel = new SectionPanel();
    p.onClose = () => this.clear();
    p.onProbe = (fx, fy) => this.probeText(fx, fy);
    p.open();
    this.view = new SectionView(this.r, p.gpuCanvas);
  }

  // ------------------------------------------------------------------------------------------- per frame
  /** The map's palette lookup of a moment's product (8-bit codes), and its key. */
  private lut(m: SectionMoment): [Lut, string] {
    const p = L2[SECTION_PRODUCT[m]], name = settings.str(L2_PALETTE_KEYS[SECTION_PRODUCT[m]]), key = `${name}|${p.low}|${p.high}|${p.reserve}`;
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low: p.low, high: p.high, reserve: p.reserve, showRF: p.reserve, topCode: 255 }); this.luts.set(key, l); }
    return [l, key];
  }

  /** Renders the section of the drawn volume into the panel when the pack, line, moment, motion or size changed. */
  prepass(ctx: PrepassContext) {
    const site = this.site(), owner = this.line?.site ?? this.placing?.site;
    if (owner !== undefined && owner !== site?.id) this.clear(); // another radar: the line belonged to the old one
    if (!this.line || !site) return;
    if (!this.panel) this.open();
    const panel = this.panel!, view = this.view!;
    const moment = this.moment(), pm = moment === 'SRV' ? 'VEL' : moment;
    const q = this.nexrad.volumeRequest(pm), pack = q && this.nexrad.volumes.get(q);
    const resized = panel.layout();
    if (!q) {
      // Nothing of Level 2 is drawn: no section is shown rather than one of a volume no longer on the map.
      if (this.shown || resized) { view.clear(ctx, BACKGROUND); this.shown = null; this.viewKey = this.overlayKey = this.legendKey = ''; panel.drawOverlay(null); panel.setLegend(null); }
      this.shownMs = null;
      panel.setStatus('Shows the NEXRAD Level 2 volume drawn on the map (select Level 2).');
      return;
    }
    if (!pack) {
      // The previous section stays (labelled with its own volume) until this one is uploaded, unless resizing wiped it.
      panel.setStatus(`Loading the ${SECTION_MOMENT_NAMES[moment].toLowerCase()} volume (${this.nexrad.volumes.state(q)})…`);
      if (resized) { view.clear(ctx, BACKGROUND); this.shown = null; this.viewKey = this.overlayKey = ''; panel.drawOverlay(null); }
      return;
    }
    this.shownMs = pack.timeMs;
    const ends = this.endpoints(pack.timeMs)!, topKm = settings.num(S('Top'));
    const section: Section = { a: ends[0], b: ends[1], topKm };
    const [lut, lutKey] = this.lut(moment);
    const srv = moment === 'SRV' ? this.nexrad.stormMotion(pack.timeMs) : null;
    const key = JSON.stringify([pack.key, section, srv, panel.gpuCanvas.width, panel.gpuCanvas.height, lutKey]);
    if (key !== this.viewKey) { view.encode(ctx, { pack, section, lut, srv }, BACKGROUND); this.viewKey = key; }
    this.shown = { pack, req: packKey(q) === pack.key ? q : null, section, moment, srv };
    panel.setStatus(pack.key === packKey(q) ? '' : 'Newer radials of the live volume are loading…');
    if (lutKey !== this.legendKey) {
      const p = L2[SECTION_PRODUCT[moment]];
      this.legendKey = lutKey;
      panel.setLegend({ id: 'section', palette: getPalette(lutKey.split('|')[0]), low: p.low, high: p.high, unit: p.unit, reserve: p.reserve, lut });
    }
    const iso = this.isotherms(site, pack.timeMs);
    const overlayKey = JSON.stringify([key, iso, settings.bool('config.distanceMeasureImperial'), ...['Beams', 'Follow', 'Rhi'].map((k) => settings.bool(S(k)))]);
    if (overlayKey !== this.overlayKey) { this.overlayKey = overlayKey; panel.drawOverlay(this.overlay(site, pack, section, moment, srv, iso)); }
  }

  /** The 0/−10/−20 °C heights (km above the radar) for a volume time, as the column products use them; [] when off. */
  private isotherms(site: { lon: number; lat: number; elevM: number }, timeMs: number): Overlay['isotherms'] {
    if (!settings.bool(S('Isotherms'))) return [];
    const auto = !settings.bool('settings.nexradAlgorithmHailIsothermCustom');
    const env = auto ? isothermsAt(site, timeMs) : null;
    const h = isothermHeights({ isothermAuto: auto, envIsotherms: env, h0Custom: settings.num('settings.nexradAlgorithmHailIsotherm0CCustom'), hm20Custom: settings.num('settings.nexradAlgorithmHailIsothermM20CCustom') });
    const src = env ? 'HRRR' : 'custom';
    return [{ label: `0 °C (${src})`, km: h.h0 / 1000 }, { label: `−10 °C (${h.estimated ? 'estimated' : src})`, km: h.hm10 / 1000 }, { label: `−20 °C (${src})`, km: h.hm20 / 1000 }];
  }

  private overlay(site: { id: string }, pack: GpuPack, section: Section, moment: SectionMoment, srv: Motion | null, isotherms: Overlay['isotherms']): Overlay {
    const imperial = settings.bool('config.distanceMeasureImperial'), lengthKm = sectionLength(section), axis = this.axis(section.a, section.b);
    const beams = settings.bool(S('Beams')) ? pack.tilts.map((t) => ({ elevation: t.elevation, pts: beamCurve(section, t.elevation, t.firstKm + t.gates * t.gateKm, 96) })) : [];
    const motion = srv ? ` (motion ${Math.round(srv.fromDeg)}°/${Math.round(srv.speedKt)} kt)` : '';
    const follow = settings.bool(S('Follow')) ? ' · line follows storm motion' : '';
    return {
      header: `${site.id} ${utc(pack.timeMs)}Z · ${SECTION_MOMENT_NAMES[moment]}${motion} · ${fmtRange(lengthKm, imperial)}${follow}`,
      topKm: section.topKm, imperial, axis, beams, isotherms, tickStep: tickStep(lengthKm, imperial ? MI : 1),
    };
  }

  /** Distance axis of a line: the range from the radar for an RHI (a line along one radial), else the distance from A. */
  private axis(a: EN, b: EN): Overlay['axis'] {
    const pa = polarOf(a), pb = polarOf(b), radial = Math.min(pa.s, pb.s) < 0.1 || Math.abs(((pa.az - pb.az + 540) % 360) - 180) < 0.05;
    return settings.bool(S('Rhi')) && radial ? { fromKm: pa.s, toKm: pb.s, origin: 'the radar' } : { fromKm: 0, toKm: sectionLength({ a, b }), origin: 'A' };
  }

  /** Probe readout of a panel point: value (reference sampler), height, ground and slant range, nearest tilt. */
  probeText(fx: number, fy: number): string | null {
    const s = this.shown;
    if (!s) return null;
    const imperial = settings.bool('config.distanceMeasureImperial');
    const p = sectionAt(s.section, fx, fy), g = probeGeometry(p.s, p.h, s.pack.tilts);
    const site = this.site();
    const value = this.probeValue(s, p.az, p.s, p.h);
    const tilt = g.nearest >= 0 ? `nearest tilt ${s.pack.tilts[g.nearest].elevation.toFixed(1)}° (beam ${g.offDeg >= 0 ? '+' : ''}${g.offDeg.toFixed(2)}°)` : '';
    return [
      value,
      `height ${fmtHeight(p.h, imperial)} ARL${site ? ` (${fmtHeight(p.h + site.elevM / 1000, imperial)} MSL)` : ''}`,
      `ground ${fmtRange(p.s, imperial)} · slant ${fmtRange(g.slantKm, imperial)} · az ${p.az.toFixed(1)}° · ${tilt}`,
    ].join('\n');
  }

  private probeValue(s: NonNullable<CrossSection['shown']>, az: number, sKm: number, hKm: number): string {
    const name = SECTION_MOMENT_NAMES[s.moment];
    if (!s.req) return `${name}: waiting for the volume`;
    const key = s.pack.key;
    if (this.cpu?.key !== key) {
      const q = s.req, cpu = this.cpu = { key, pack: null as VolumePack | null, error: undefined as string | undefined };
      pool.for('nexrad').run<{ pack: VolumePack | null }>('l2.volume', { url: q.url, live: q.live, chunks: q.chunks, moment: q.moment, latest: q.latest, qualityDealiasing: q.qualityDealiasing }, q.url)
        .then((r) => { cpu.pack = r.pack; if (!r.pack) cpu.error = 'moment not in this volume'; }, (e) => { cpu.error = (e as Error).message; });
    }
    const cpu = this.cpu!;
    if (!cpu.pack) return `${name}: ${cpu.error ?? 'reading the volume…'}`;
    let code = sampleVolume(cpu.pack, az, sKm, hKm);
    if (s.srv) code = stormRelativeCode(code, az, s.srv.speedKt, s.srv.fromDeg);
    if (code < 2) return `${name}: no data`;
    const m = VOLUME_MOMENTS[cpu.pack.moment];
    let v = code * m.scale + m.offset, unit = m.unit;
    if (cpu.pack.moment === 'VEL' && settings.bool('config.generalRadarVelocityMPHForce')) { v *= 1.15078; unit = 'mph'; }
    const digits = cpu.pack.moment === 'CC' ? 3 : cpu.pack.moment === 'REF' || cpu.pack.moment === 'VEL' ? 1 : 2;
    return `${name}: ${v.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
  }

  // ------------------------------------------------------------------------------------------- map
  draw(ctx: DrawContext) {
    const site = this.site();
    if (ctx.probe || !site || (!this.line && !this.placing)) return;
    const imperial = settings.bool('config.distanceMeasureImperial');
    const ends = this.placing ? (this.placing.b ? [this.placing.a, this.placing.b] : [this.placing.a]) : this.endpoints()!;
    const key = JSON.stringify([site.id, ends, imperial, settings.bool(S('Rhi'))]);
    if (key !== this.mapKey) { this.mapKey = key; this.build(site, ends as EN[], imperial); }
    this.lines.draw(ctx); this.pts.draw(ctx); this.text.draw(ctx);
  }

  private build(site: { lon: number; lat: number }, ends: EN[], imperial: boolean) {
    this.lines.setStyles([{ color: [0, 0, 0, 200], width: 4.5 }, { color: [255, 216, 74, 255], width: 2 }, { color: [255, 216, 74, 255], width: 1.5 }]);
    const lines: Polyline[] = [], pts: PointSpec[] = [], labels: Label[] = [];
    const ll = (p: EN) => toLonLat(site, p);
    if (ends.length === 2) {
      const [a, b] = ends, L = sectionLength({ a, b }), along: number[] = [];
      for (let i = 0; i <= 48; i++) along.push(...ll([a[0] + ((b[0] - a[0]) * i) / 48, a[1] + ((b[1] - a[1]) * i) / 48]));
      lines.push({ coords: along, style: 0, height: 0.00003 }, { coords: along, style: 1, height: 0.00003 });
      // Ticks at round values of the panel's distance axis (from A, or the range from the radar of an RHI).
      const unit = imperial ? MI : 1, step = tickStep(L, unit), half = Math.max(0.4, L / 90), axis = this.axis(a, b);
      const u0 = axis.fromKm / unit, u1 = axis.toKm / unit, ux = L ? (b[0] - a[0]) / L : 0, uy = L ? (b[1] - a[1]) / L : 0;
      for (let d = Math.ceil((Math.min(u0, u1) + 1e-6) / step) * step; d < Math.max(u0, u1) - 1e-6; d += step) {
        const f = (d - u0) / (u1 - u0), c: EN = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        lines.push({ coords: [...ll([c[0] - uy * half, c[1] + ux * half]), ...ll([c[0] + uy * half, c[1] - ux * half])], style: 2, height: 0.00003 });
        const [lon, lat] = ll(c);
        labels.push({ lon, lat, text: String(d), size: 10, color: [255, 236, 170, 255], halo: [0, 0, 0, 220], dy: -9, priority: 6 });
      }
    }
    ends.forEach((p, i) => {
      const [lon, lat] = ll(p);
      pts.push({ lon, lat, size: 11, shape: SHAPE.circle, color: [255, 216, 74, 255], outline: 0.3, height: 0.00003 });
      labels.push({ lon, lat, text: i ? 'B' : 'A', size: 13, color: [255, 255, 255, 255], halo: [0, 0, 0, 230], dx: 9, align: 'left', priority: 14 });
    });
    this.lines.setLines(lines); this.pts.setPoints(pts); this.text.setLabels(labels);
  }
}
