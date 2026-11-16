import type { DrawContext, Drawable, Renderer } from '../render/renderer';
import type { Palette } from '../render/palette';
import type { Lut } from '../render/raster';

export interface LegendSpec {
  id: string; palette: Palette; low: number; high: number; unit: string; reserve?: boolean; lut: Lut;
  /** Extra p-type ramps shown under reflectivity unless hidden. */
  extra?: { label: string; palette: Palette; lut: Lut }[];
  /** One-line status under the legend (p-type source/valid time, or p-type unavailable). */
  note?: string;
}

export type LayerStatus = { state: 'off' | 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'; text: string; frames?: number; newestMs?: number };

/** Base class for map layers drawn by the renderer in layer order. */
export abstract class MapLayer implements Drawable {
  abstract readonly id: string;
  abstract readonly title: string;
  status: LayerStatus = { state: 'off', text: '' };
  onStatus: (l: MapLayer) => void = () => {};
  constructor(protected r: Renderer) {}
  abstract enabled(): boolean;
  abstract draw(ctx: DrawContext): void;
  /** Periodic refresh (listing, downloads). */
  async refresh(): Promise<void> {}
  /** Called once per animation frame before drawing (time-dependent CPU updates). */
  tick(_t: number, _now: number): void {}
  legends(): LegendSpec[] { return []; }
  probeKind(): string | null { return null; }
  /** Converts a probe sample (0..1) into display text. */
  probeText(_v: number): string { return ''; }
  setStatus(state: LayerStatus['state'], text: string, extra: Partial<LayerStatus> = {}) {
    this.status = { state, text, ...extra };
    this.onStatus(this);
  }
}
