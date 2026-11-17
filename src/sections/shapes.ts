// Shapefile / GeoJSON product layers shared by the Forecast, Misc and Tropical tabs: one archive (or several) per
// selection, decoded in a worker, mapped to map-object styles, with an update check interval (WPC: 10 m).
import type { Renderer } from '../render/renderer';
import type { GlyphAtlas } from '../render/prims';
import { VectorLayer, type VShape } from '../layers/vector';
import { pool } from '../workers/pool';
import type { VectorLayer as Decoded, VectorFeature } from '../workers/shape-tasks';

export interface ShapeSource { url: string; kind: 'zip' | 'tar' | 'tgz'; match?: string; tol?: number }
export interface ShapeConfig {
  id: string; title: string;
  enabled: () => boolean;
  /** Sources for the current selection (null = nothing to load). */
  sources: () => ShapeSource[] | null;
  /** Feature → shape (null = skip). `layer` is the shapefile name inside the archive. */
  shape: (f: VectorFeature, layer: string) => VShape | null;
  refreshMin?: number;
  filled?: (s: VShape) => boolean;
  labels?: () => boolean;
  alpha?: () => number;
  after?: (shapes: VShape[]) => void;
}

export class ShapeLayer extends VectorLayer {
  readonly id: string;
  readonly title: string;
  private key = '';
  private at = 0;
  constructor(r: Renderer, atlas: GlyphAtlas, readonly cfg: ShapeConfig) { super(r, atlas); this.id = cfg.id; this.title = cfg.title; }
  enabled() { return this.cfg.enabled(); }
  filled(s: VShape) { return this.cfg.filled ? this.cfg.filled(s) : true; }
  labelsOn() { return this.cfg.labels ? this.cfg.labels() : true; }
  alpha() { return this.cfg.alpha ? this.cfg.alpha() : 1; }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const src = this.cfg.sources();
    if (!src) { this.setShapes([]); this.setStatus('idle', 'nothing selected'); return; }
    const key = JSON.stringify(src);
    if (key === this.key && Date.now() - this.at < (this.cfg.refreshMin ?? 10) * 60e3) return;
    this.setStatus('loading', this.title);
    try {
      const shapes: VShape[] = [];
      for (const s of src) {
        const layers = await pool.for(this.id).run<Decoded[]>('shapes', s);
        for (const l of layers) for (const f of l.features) { const v = this.cfg.shape(f, l.name); if (v) shapes.push(v); }
      }
      this.key = key; this.at = Date.now();
      this.setShapes(shapes);
      this.cfg.after?.(shapes);
      this.setStatus('ready', `${this.title}: ${shapes.length} features`);
    } catch (e) { this.setStatus('error', `${this.title}: ${(e as Error).message}`); }
  }
  /** Forces a reload on the next refresh (selection or style changes). */
  reset() { this.key = ''; }
}
