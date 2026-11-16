// Shared vector-product layer: filled polygons (solid / hatched), outlines, point icons and labels from
// shapefiles, GeoJSON or text products, with per-object styles from the map-object style registry, CPU hit
// testing for Interact rollover and Probe text, and screen-space label declutter.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer } from './base';
import { PolySet, type FillStyle } from '../render/polys';
import { LineSet, PointSet, TextSet, GlyphAtlas, declutter, type LineStyle, type PointSpec, type Label, type Color } from '../render/prims';
import { objectStyle, linePasses, polyFill, zoomDependent } from '../app/styles';
import { lonLatToXYZ } from '../render/camera';

export interface VShape {
  kind: 'polygon' | 'line' | 'point';
  parts: number[][];
  tris?: ArrayLike<number>;
  /** Map-object style name, e.g. COCatSLGT. */
  style: string;
  /** Draw order inside the layer (higher on top). */
  z?: number;
  point?: Omit<PointSpec, 'lon' | 'lat'>;
  label?: string;
  /** Lines for rollover / probe. */
  info?: string[];
  t?: number;
}

export function pointInRing(x: number, y: number, r: ArrayLike<number>): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export abstract class VectorLayer extends MapLayer {
  shapes: VShape[] = [];
  protected fills: PolySet; protected lines: LineSet; protected pts: PointSet; protected text: TextSet;
  protected labelSpacing = 80;
  private styleKey = '';
  constructor(r: Renderer, atlas: GlyphAtlas) {
    super(r);
    this.fills = new PolySet(r); this.lines = new LineSet(r); this.pts = new PointSet(r); this.text = new TextSet(r, atlas);
  }
  /** Overall alpha multiplier (0..1). */
  alpha() { return 1; }
  /** Whether polygons are filled (outlines only otherwise). */
  filled(_s: VShape) { return true; }
  labelsOn() { return true; }

  setShapes(shapes: VShape[]) { this.shapes = shapes; this.build(); }

  private styleNames: string[] = [];
  private zoomStyles = false;
  private styleZoom = -1;
  private passIdx = new Map<string, number[]>();

  /** Writes fill and line-pass style buffers for the current zoom (map-object styles). */
  private writeStyles() {
    const z = this.r.camera.cur.z;
    this.styleZoom = z;
    const a = this.alpha();
    const sc = (c: Color): Color => [c[0], c[1], c[2], Math.round(c[3] * a)];
    const fills: FillStyle[] = [], lines: LineStyle[] = [];
    for (const n of this.styleNames) {
      const f = polyFill(n, z);
      fills.push({ ...f, color: sc(f.color), color2: f.color2 && sc(f.color2), patternColor: f.patternColor && sc(f.patternColor) });
      for (const ls of linePasses(n, z)) lines.push({ ...ls, color: sc(ls.color), color2: ls.color2 && sc(ls.color2) });
    }
    this.fills.setStyles(fills); this.lines.setStyles(lines);
  }

  /** Rebuilds GPU geometry (call after style changes). */
  build() {
    this.styleNames = [...new Set(this.shapes.map((s) => s.style))];
    this.zoomStyles = this.styleNames.some(zoomDependent);
    this.styleKey = this.styleNames.map((n) => JSON.stringify(objectStyle(n))).join('|');
    const sIdx = new Map(this.styleNames.map((n, i) => [n, i]));
    // Only passes switched on at some zoom level get geometry; the outermost pass is drawn first.
    this.passIdx = new Map(this.styleNames.map((n) => { const st = objectStyle(n); const on = [5, 4, 3, 2, 1, 0].filter((k) => st.line.levels.some((l) => l.passes[k]?.on)); return [n, on.map((k) => 5 - k)]; }));
    this.writeStyles();
    const sorted = [...this.shapes].sort((x, y) => (x.z ?? 0) - (y.z ?? 0));
    // Style display mode (TFrmStyleEditor): 0 layer default, 1 filled polygon, 2 outlined polygon.
    const fillOf = (s: VShape) => { const m = objectStyle(s.style).mode; return m === 1 ? true : m === 2 ? false : this.filled(s); };
    this.fills.setPolys(sorted.filter((s) => s.kind === 'polygon' && s.tris && fillOf(s)).map((s) => ({ tris: s.tris!, style: sIdx.get(s.style)! })));
    const lines = sorted.filter((s) => s.kind !== 'point').flatMap((s) => { const base = sIdx.get(s.style)! * 6; return s.parts.flatMap((p) => this.passIdx.get(s.style)!.map((k) => ({ coords: p, style: base + k }))); });
    this.lines.setLines(lines);
    const pts: PointSpec[] = [], labels: Label[] = [];
    for (const s of sorted) {
      if (s.kind === 'point' && s.parts[0]) pts.push({ lon: s.parts[0][0], lat: s.parts[0][1], size: 9, shape: 0, color: objectStyle(s.style).line.levels[0].passes[0].color, outline: 0.15, ...s.point } as PointSpec);
      if (s.label && this.labelsOn()) for (const [lon, lat] of this.labelAnchors(s)) labels.push({ lon, lat, text: s.label, size: 11, color: [255, 255, 255, 235], halo: [0, 0, 0, 220], priority: s.z ?? 0 });
    }
    this.pts.setPoints(pts);
    this.text.setLabels(labels);
    this.declutterKey = '';
  }

  /** Label anchors: points at their position, lines/polygons along the first part (several along long edges). */
  protected labelAnchors(s: VShape): [number, number][] {
    const p = s.parts[0];
    if (!p || p.length < 2) return [];
    if (s.kind === 'point') return [[p[0], p[1]]];
    const n = p.length / 2, out: [number, number][] = [];
    const step = Math.max(8, Math.floor(n / 4));
    for (let k = Math.floor(step / 2); k < n; k += step) out.push([p[k * 2], p[k * 2 + 1]]);
    return out.slice(0, 6);
  }

  private declutterKey = '';
  tick(_t: number, _now: number) {
    if (!this.enabled()) return;
    if (this.zoomStyles && Math.abs(this.r.camera.cur.z - this.styleZoom) > this.styleZoom * 0.02) this.writeStyles();
    if (!this.text.labels.length) return;
    // Declutter only when the view or the labels change (screen-space greedy placement).
    const c = this.r.camera.cur;
    const key = `${c.lon.toFixed(3)},${c.lat.toFixed(3)},${c.z.toFixed(2)},${c.tilt.toFixed(1)},${c.swivel.toFixed(1)},${this.text.labels.length},${this.r.camera.width}`;
    if (key === this.declutterKey) return;
    this.declutterKey = key;
    const vis = declutter(this.r, this.text, this.labelSpacing);
    for (let i = 0; i < vis.length; i++) this.text.alpha[i] = vis[i];
    this.text.flushAlpha();
  }

  draw(ctx: DrawContext) {
    if (!this.enabled() || ctx.probe) return;
    this.fills.draw(ctx); this.lines.draw(ctx); this.pts.draw(ctx); this.text.draw(ctx);
  }

  /** Topmost shape at a lon/lat (polygons by containment, points/lines within `pxTol` screen pixels). */
  hitShape(lon: number, lat: number, x: number, y: number, pxTol = 8): VShape | null {
    const cam = this.r.camera;
    let best: VShape | null = null, bestD = pxTol;
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.kind === 'polygon') { if (s.parts.some((p) => pointInRing(lon, lat, p)) && (!best || (s.z ?? 0) > (best.z ?? 0))) best = s; continue; }
      for (const p of s.parts) for (let k = 0; k + 1 < p.length; k += 2) {
        const q = cam.project(lonLatToXYZ(p[k], p[k + 1]));
        if (!q[2]) continue;
        const d = Math.hypot(q[0] - x, q[1] - y);
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    return best;
  }
  probeAt(lon: number, lat: number, x: number, y: number): string[] | null { return this.enabled() ? this.hitShape(lon, lat, x, y)?.info ?? null : null; }
  /** Style edits: only the style buffers change unless the set of drawn passes or the display mode changed. */
  styleChanged() {
    const key = this.styleNames.map((n) => { const st = objectStyle(n); return `${n}:${st.mode}:${st.line.levels.map((l) => l.passes.map((p) => +p.on).join('')).join('/')}`; }).join('|');
    if (key !== this.passKey) { this.passKey = key; this.build(); } else this.writeStyles();
  }
  private passKey = '';
  get styleSignature() { return this.styleKey; }
}
