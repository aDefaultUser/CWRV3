import type { DrawContext, Drawable, Renderer } from '../render/renderer';
import type { Palette } from '../render/palette';
import type { Lut } from '../render/raster';
import { timeline } from '../app/timeline';

export interface LegendSpec {
  id: string; palette: Palette; low: number; high: number; unit: string; reserve?: boolean; lut: Lut;
  /** Extra p-type ramps shown under reflectivity unless hidden. */
  extra?: { label: string; palette: Palette; lut: Lut }[];
  /** One-line status under the legend (p-type source/valid time, or p-type unavailable). */
  note?: string;
}

export type LayerStatus = { state: 'off' | 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'; text: string; frames?: number; newestMs?: number };

/**
 * What a layer shows in archive mode: 'static' is not time-dependent (map furniture, user files); 'window' loads by
 * the timeline window from a source that keeps the past; 'resolver' has its own source for an archive time; 'none'
 * has no archive and is never refreshed or drawn there.
 */
export type ArchiveSupport = 'static' | 'window' | 'resolver' | 'none';
export const NOT_AVAILABLE = 'not available for this time';

/** Base class for map layers drawn by the renderer in layer order. */
export abstract class MapLayer implements Drawable {
  abstract readonly id: string;
  abstract readonly title: string;
  /** Archive support; 'none' unless a layer declares otherwise, so an unconverted layer shows nothing, never live data. */
  readonly archive: ArchiveSupport = 'none';
  status: LayerStatus = { state: 'off', text: '' };
  /** What the layer itself last reported while the archive guard shows it as not available. */
  private ownStatus: LayerStatus | null = null;
  onStatus: (l: MapLayer) => void = () => {};
  constructor(protected r: Renderer) {
    // The archive guard wraps the subclass methods here, so no call site (timers, setting listeners, a layer's own
    // refresh calls) can reach a layer without an archive while a past time is shown.
    const { refresh, draw, tick, legends, probeKind } = this;
    let refreshed = timeline.epoch;
    this.refresh = async () => {
      refreshed = timeline.epoch;
      // Blocked: the status reads "not available"; back in live mode the layer's own status returns (its refresh
      // may be throttled and leave it alone).
      if (this.ownStatus || this.archiveBlocked()) { const own = this.ownStatus ?? this.status; this.ownStatus = null; this.setStatus(own.state, own.text, own); }
      if (!this.archiveBlocked()) return refresh.call(this);
    };
    // After a mode or archive-time change a data layer draws again only once its refresh has started (and dropped
    // what it held for the other time).
    this.draw = (ctx) => { if (!this.archiveBlocked() && (this.archive === 'static' || refreshed === timeline.epoch)) draw.call(this, ctx); };
    this.tick = (t, now) => { if (!this.archiveBlocked()) tick.call(this, t, now); };
    this.legends = (pane) => (this.archiveBlocked() ? [] : legends.call(this, pane));
    this.probeKind = () => (this.archiveBlocked() ? null : probeKind.call(this));
  }
  /** True while a past time is shown and this layer has no archive for it. */
  archiveBlocked() { return timeline.mode === 'archive' && this.archive === 'none'; }
  abstract enabled(): boolean;
  abstract draw(ctx: DrawContext): void;
  /** Periodic refresh (listing, downloads). */
  async refresh(): Promise<void> {}
  /** Called once per animation frame before drawing (time-dependent CPU updates). */
  tick(_t: number, _now: number): void {}
  /** Legends of the layer as drawn in `pane` (the same in every pane unless the layer is perPane). */
  legends(_pane = 0): LegendSpec[] { return []; }
  probeKind(): string | null { return null; }
  /** Converts a probe sample (0..1) read in `pane` into display text. */
  probeText(_v: number, _pane = 0): string { return ''; }
  setStatus(state: LayerStatus['state'], text: string, extra: Partial<LayerStatus> = {}) {
    const own: LayerStatus = { state, text, ...extra };
    // A live request that settles while a past time is shown must not report the layer as showing data.
    const blocked = this.archiveBlocked();
    if (blocked) this.ownStatus = own;
    this.status = !blocked ? own : this.enabled() ? { state: 'unavailable', text: NOT_AVAILABLE } : { state: 'off', text: '' };
    this.onStatus(this);
  }
}
