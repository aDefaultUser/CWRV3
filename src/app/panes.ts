// Linked map panes: the layout (one pane, two side by side, two stacked, 2 × 2), what NEXRAD shows in panes 1–3
// (pane 0 is the radar settings and tilt of the single view), the quick presets and the saved layouts. Persisted as
// the `panes` (layout and views) and `paneLayouts` (saved layouts) preferences.
import { loadPref, savePref, isArray, isRecord } from './persist';
import { MAX_PANES, paneCount, type PaneGrid } from '../render/panes';
import { PRODUCTS } from '../generated/products-catalog';

/** What NEXRAD shows in one pane: a Level 2 product and tilt or a Level 3 product, `offsetMin` before the timeline time. */
export interface RadarView { level2: boolean; product: number; l3: number; tilt: number; offsetMin: number }
/** A layout with the view of each of its panes (pane 0 first). */
export interface PaneLayout { name: string; layout: number; views: RadarView[] }

export const LAYOUTS: readonly { name: string; grid: PaneGrid }[] = [
  { name: 'Single', grid: { cols: 1, rows: 1 } }, { name: '2 side by side', grid: { cols: 2, rows: 1 } },
  { name: '2 stacked', grid: { cols: 1, rows: 2 } }, { name: '4 (2 × 2)', grid: { cols: 2, rows: 2 } },
];
/** Longest time offset of a pane (minutes). */
export const MAX_OFFSET_MIN = 180;
/** Level 2 products of the presets: reflectivity, dealiased velocity, storm-relative velocity, ZDR, CC. */
const REF = 0, VEL = 6, SRV = 7, ZDR = 3, CC = 5;
/** Lowest cuts of the common precipitation VCPs, used until a volume's own tilts are known. */
const DEFAULT_TILTS = [0.5, 0.9, 1.3, 1.8];

const l2View = (product: number, tilt = 0.5): RadarView => ({ level2: true, product, l3: 0, tilt, offsetMin: 0 });
const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const index = (v: unknown, n: number, dflt: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < n ? (v as number) : dflt);
/** A stored view with every field in range; fields that are not take `dflt`'s. */
export function viewOf(v: unknown, dflt: RadarView): RadarView {
  const s = (isRecord(v) ? v : {}) as Record<string, unknown>;
  return {
    level2: typeof s.level2 === 'boolean' ? s.level2 : dflt.level2, product: index(s.product, PRODUCTS.level2.length, dflt.product),
    l3: index(s.l3, PRODUCTS.level3.length, dflt.l3), tilt: num(s.tilt, -1, 90, dflt.tilt), offsetMin: num(s.offsetMin, 0, MAX_OFFSET_MIN, dflt.offsetMin),
  };
}

/** The `n` lowest distinct tilt angles (SAILS/MRLE rescans and split cuts of one angle count once), lowest first. */
export function lowestTilts(angles: readonly number[], n: number): number[] {
  const out: number[] = [];
  for (const a of [...angles].sort((x, y) => x - y)) if (!out.length || a - out[out.length - 1] > 0.05) out.push(a);
  for (const a of DEFAULT_TILTS) if (out.length < n && out.every((x) => Math.abs(x - a) > 0.05)) out.push(a);
  return out.sort((x, y) => x - y).slice(0, n);
}

/**
 * Quick presets for the main view `main` and the tilt angles of the volume shown: reflectivity beside storm-relative
 * velocity, the four base moments, and the four lowest tilts of the main view's product (reflectivity when that has
 * no tilt). The products keep the main view's tilt.
 */
export function presets(main: RadarView, tilts: readonly number[]): PaneLayout[] {
  const at = (product: number) => l2View(product, main.tilt);
  const product = main.level2 && main.product < 11 ? main.product : REF;
  return [
    { name: 'REF / SRV', layout: 1, views: [at(REF), at(SRV)] },
    { name: 'REF / VEL / ZDR / CC', layout: 3, views: [at(REF), at(VEL), at(ZDR), at(CC)] },
    { name: 'Four lowest tilts', layout: 3, views: lowestTilts(tilts, MAX_PANES).map((t) => l2View(product, t)) },
  ];
}

export class PaneStore {
  /** Index into LAYOUTS. */
  layout = 0;
  /** Views of panes 1–3 (kept while the layout shows fewer panes). */
  views: RadarView[] = [l2View(SRV), l2View(ZDR), l2View(CC)];
  saved: PaneLayout[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    const s = loadPref<Record<string, unknown>>('panes', {}, isRecord);
    this.layout = index(s.layout, LAYOUTS.length, 0);
    const stored = isArray(s.views) ? (s.views as unknown[]) : [];
    this.views = this.views.map((d, i) => viewOf(stored[i], d));
    this.saved = loadPref<unknown[]>('paneLayouts', [], isArray).filter((l): l is PaneLayout => isRecord(l) && typeof (l as PaneLayout).name === 'string' && isArray((l as PaneLayout).views))
      .map((l) => ({ name: l.name, layout: index(l.layout, LAYOUTS.length, 0), views: l.views.slice(0, MAX_PANES).map((v) => viewOf(v, l2View(REF))) }))
      .filter((l) => l.views.length >= paneCount(LAYOUTS[l.layout].grid));
  }

  get grid(): PaneGrid { return LAYOUTS[this.layout].grid; }
  get count() { return paneCount(this.grid); }
  /** Subscribes to layout and view changes. */
  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() {
    savePref('panes', { layout: this.layout, views: this.views }, 'pane layout');
    for (const f of this.listeners) f();
  }

  setLayout(i: number) { const next = index(i, LAYOUTS.length, this.layout); if (next !== this.layout) { this.layout = next; this.changed(); } }
  cycle() { this.setLayout((this.layout + 1) % LAYOUTS.length); }
  /** Changes what pane 1–3 shows. */
  setView(pane: number, patch: Partial<RadarView>) {
    const cur = this.views[pane - 1];
    if (!cur) return;
    const next = viewOf({ ...cur, ...patch }, cur);
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    this.views[pane - 1] = next;
    this.changed();
  }
  /** Shows a preset or saved layout; returns its pane 0 view, which the caller applies to the radar settings. */
  apply(l: PaneLayout): RadarView {
    this.layout = index(l.layout, LAYOUTS.length, 0);
    l.views.slice(1, MAX_PANES).forEach((v, i) => { this.views[i] = viewOf(v, this.views[i]); });
    this.changed();
    return l.views[0];
  }
  /** Saves the layout shown now under `name`; `main` is the view of pane 0. */
  save(name: string, main: RadarView) {
    this.saved.push({ name, layout: this.layout, views: [{ ...main, offsetMin: 0 }, ...this.views.slice(0, this.count - 1).map((v) => ({ ...v }))] });
    return savePref('paneLayouts', this.saved, 'saved pane layouts');
  }
  remove(i: number) { this.saved.splice(i, 1); return savePref('paneLayouts', this.saved, 'saved pane layouts'); }
}

export const panes = new PaneStore();
