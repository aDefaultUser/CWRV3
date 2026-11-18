// Linked panes: grid geometry and the pane-relative pointer mapping, the pane store (layout, views of panes 1–3,
// presets, saved layouts and their persistence), and the legend strip of each pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paneAt, paneCount, paneOrigin, paneSize, SINGLE_PANE } from '../src/render/panes';
import { LAYOUTS, PaneStore, lowestTilts, panes, presets, viewOf, MAX_OFFSET_MIN, type RadarView } from '../src/app/panes';
import { formDef } from '../src/ui/form';
import { paneBindings } from '../src/ui/pane-forms';
import { PRODUCTS } from '../src/generated/products-catalog';
import { useStorage, PREFIX } from '../src/app/persist';
import { legendBar } from '../src/ui/legend';
import { legendTicks, parsePalette } from '../src/render/palette';

class Mem {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
let mem: Mem;
beforeEach(() => { mem = new Mem(); useStorage(mem); });
afterEach(() => useStorage(null));
const stored = (key: string) => JSON.parse(mem.getItem(PREFIX + key)!);
const QUAD = LAYOUTS[3].grid, SIDE = LAYOUTS[1].grid, STACKED = LAYOUTS[2].grid;

describe('pane grid', () => {
  it('lays out 1, 2 side by side, 2 stacked and 2 × 2 panes in row-major order', () => {
    expect(LAYOUTS.map((l) => paneCount(l.grid))).toEqual([1, 2, 2, 4]);
    expect(paneSize(SINGLE_PANE, 3840, 2160)).toEqual([3840, 2160]);
    expect(paneSize(SIDE, 3840, 2160)).toEqual([1920, 2160]);
    expect(paneSize(STACKED, 3840, 2160)).toEqual([3840, 1080]);
    const [w, h] = paneSize(QUAD, 3840, 2160);
    expect([0, 1, 2, 3].map((p) => paneOrigin(QUAD, p, w, h))).toEqual([[0, 0], [1920, 0], [0, 1080], [1920, 1080]]);
    expect([0, 1].map((p) => paneOrigin(STACKED, p, 3840, 1080))).toEqual([[0, 0], [0, 1080]]);
  });

  it('gives every pane the same whole device-pixel size when the area does not divide evenly', () => {
    expect(paneSize(QUAD, 1435, 579)).toEqual([717, 289]);
    expect(paneSize(QUAD, 1435, 579, false)).toEqual([717.5, 289.5]);
    expect(paneSize(QUAD, 1, 1)).toEqual([1, 1]); // never empty
  });

  it('maps a pointer position to its pane and the same pane-relative point in each', () => {
    const [w, h] = [600, 400];
    // The same map point in each pane: 150, 90 from the pane's corner.
    for (let p = 0; p < 4; p++) {
      const [ox, oy] = paneOrigin(QUAD, p, w, h);
      expect(paneAt(QUAD, w, h, ox + 150, oy + 90)).toEqual({ pane: p, x: 150, y: 90 });
    }
    expect(paneAt(QUAD, w, h, 600, 400)).toEqual({ pane: 3, x: 0, y: 0 }); // a pane starts at its corner
    expect(paneAt(QUAD, w, h, 599.5, 399.5)).toEqual({ pane: 0, x: 599.5, y: 399.5 });
    expect(paneAt(SINGLE_PANE, 1200, 800, 700, 500)).toEqual({ pane: 0, x: 700, y: 500 });
    expect(paneAt(SIDE, w, 800, 900, 500)).toEqual({ pane: 1, x: 300, y: 500 });
    expect(paneAt(STACKED, 1200, h, 900, 500)).toEqual({ pane: 1, x: 900, y: 100 });
  });

  it('keeps a point outside the grid in the nearest pane (a drag that leaves the map)', () => {
    expect(paneAt(QUAD, 600, 400, -20, 950)).toEqual({ pane: 2, x: -20, y: 550 });
    expect(paneAt(QUAD, 600, 400, 1300, -5)).toEqual({ pane: 1, x: 700, y: -5 });
  });
});

describe('pane store', () => {
  it('starts with one pane and SRV, ZDR and CC ready for the other panes', () => {
    const s = new PaneStore();
    expect([s.layout, s.count, s.grid]).toEqual([0, 1, { cols: 1, rows: 1 }]);
    expect(s.views.map((v) => [v.level2, v.product, v.tilt, v.offsetMin])).toEqual([[true, 7, 0.5, 0], [true, 3, 0.5, 0], [true, 5, 0.5, 0]]);
    expect(mem.length).toBe(0); // nothing is written until something changes
  });

  it('persists the layout and the views under one preference and restores them', () => {
    const s = new PaneStore();
    let changes = 0;
    s.on(() => changes++);
    s.setLayout(3);
    s.setView(2, { level2: false, l3: 11, offsetMin: 15 });
    s.setView(1, { product: 6, tilt: 1.3 });
    expect(changes).toBe(3);
    expect(stored('panes').layout).toBe(3);
    const again = new PaneStore();
    expect(again.count).toBe(4);
    expect(again.views[0]).toEqual({ level2: true, product: 6, l3: 0, tilt: 1.3, offsetMin: 0 });
    expect(again.views[1]).toEqual({ level2: false, product: 3, l3: 11, tilt: 0.5, offsetMin: 15 });
    // Views are kept while the layout shows fewer panes.
    again.setLayout(1);
    expect(new PaneStore().views[1].l3).toBe(11);
  });

  it('does not write or notify when nothing changes', () => {
    const s = new PaneStore();
    let changes = 0;
    s.on(() => changes++);
    s.setLayout(0); s.setView(1, { product: 7 }); s.setView(0, { product: 3 }); s.setView(4, { product: 3 });
    expect(changes).toBe(0);
    expect(mem.length).toBe(0);
  });

  it('cycles through the four layouts', () => {
    const s = new PaneStore(), seen: number[] = [];
    for (let i = 0; i < 5; i++) { s.cycle(); seen.push(s.count); }
    expect(seen).toEqual([2, 2, 4, 1, 2]);
    expect(stored('panes').layout).toBe(1);
  });

  it('keeps every stored field in range and falls back on defaults for what is not', () => {
    mem.setItem(PREFIX + 'panes', JSON.stringify({ layout: 9, views: [{ level2: 'yes', product: 99, l3: -1, tilt: 'x', offsetMin: 1e9 }, null, { product: 10, tilt: 2.4, offsetMin: 5 }] }));
    const s = new PaneStore();
    expect(s.layout).toBe(0);
    expect(s.views[0]).toEqual({ level2: true, product: 7, l3: 0, tilt: 0.5, offsetMin: MAX_OFFSET_MIN });
    expect(s.views[1].product).toBe(3);
    expect(s.views[2]).toEqual({ level2: true, product: 10, l3: 0, tilt: 2.4, offsetMin: 5 });
    s.setView(1, { offsetMin: -30, product: 4.5 });
    expect(s.views[0]).toMatchObject({ offsetMin: 0, product: 7 });
    mem.setItem(PREFIX + 'panes', 'not json');
    expect(new PaneStore().count).toBe(1);
  });

  it('saves the layout shown with the main view, recalls and deletes it', () => {
    const s = new PaneStore(), main: RadarView = { level2: true, product: 0, l3: 0, tilt: 0.9, offsetMin: 30 };
    s.setLayout(1); s.setView(1, { product: 1, tilt: 0.9 });
    expect(s.save('REF and base velocity', main)).toBe(true);
    expect(stored('paneLayouts')).toEqual([{ name: 'REF and base velocity', layout: 1, views: [{ ...main, offsetMin: 0 }, { level2: true, product: 1, l3: 0, tilt: 0.9, offsetMin: 0 }] }]);
    s.setLayout(0); s.setView(1, { product: 5 });
    const again = new PaneStore();
    expect(again.saved).toHaveLength(1);
    expect(again.apply(again.saved[0])).toEqual({ ...main, offsetMin: 0 }); // the caller applies pane 0 to the radar settings
    expect([again.layout, again.views[0].product, again.views[0].tilt]).toEqual([1, 1, 0.9]);
    expect(stored('panes').layout).toBe(1);
    again.remove(0);
    expect(new PaneStore().saved).toEqual([]);
  });

  it('drops saved layouts that are not usable', () => {
    mem.setItem(PREFIX + 'paneLayouts', JSON.stringify([{ name: 'short', layout: 3, views: [{}] }, 7, { name: 'ok', layout: 1, views: [{ product: 0 }, { product: 99 }] }, { layout: 1, views: [] }]));
    const s = new PaneStore();
    expect(s.saved.map((l) => l.name)).toEqual(['ok']);
    expect(s.saved[0].views.map((v) => v.product)).toEqual([0, 0]);
  });
});

describe('pane presets', () => {
  const main: RadarView = { level2: true, product: 1, l3: 4, tilt: 1.3, offsetMin: 0 };
  // KTLX VCP 212 with one SAILS rescan of 0.5°, as the tilt tabs list it.
  const tilts = [0.5, 0.9, 1.3, 0.5, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4];

  it('REF / SRV side by side and the four base moments at the main view’s tilt', () => {
    const [srv, four] = presets(main, tilts);
    expect([srv.layout, srv.views.map((v) => v.product), srv.views.map((v) => v.tilt)]).toEqual([1, [0, 7], [1.3, 1.3]]);
    expect([four.layout, four.views.map((v) => v.product)]).toEqual([3, [0, 6, 3, 5]]);
    expect(four.views.every((v) => v.level2 && v.tilt === 1.3 && v.offsetMin === 0)).toBe(true);
  });

  it('assigns the four lowest tilts of the main product, counting a SAILS rescan once', () => {
    const t = presets(main, tilts)[2];
    expect([t.layout, t.views.map((v) => v.tilt), t.views.map((v) => v.product)]).toEqual([3, [0.5, 0.9, 1.3, 1.8], [1, 1, 1, 1]]);
    // A volume product or Level 3 in the main view has no tilt: reflectivity is used.
    expect(presets({ ...main, product: 13 }, tilts)[2].views.map((v) => v.product)).toEqual([0, 0, 0, 0]);
    expect(presets({ ...main, level2: false }, tilts)[2].views.every((v) => v.level2 && v.product === 0)).toBe(true);
  });

  it('lowest tilts: distinct angles lowest first, filled from the common cuts while a volume has fewer', () => {
    expect(lowestTilts(tilts, 4)).toEqual([0.5, 0.9, 1.3, 1.8]);
    expect(lowestTilts([0.5, 0.52, 1.45, 0.5], 4)).toEqual([0.5, 0.9, 1.3, 1.45]);
    expect(lowestTilts([], 4)).toEqual([0.5, 0.9, 1.3, 1.8]);
    expect(lowestTilts([0.3, 1.0, 2.5, 6.1, 8.0], 2)).toEqual([0.3, 1.0]); // TDWR-like cuts
  });

  it('a stored view never leaves the product tables', () => {
    const d: RadarView = { level2: true, product: 0, l3: 0, tilt: 0.5, offsetMin: 0 };
    expect(viewOf({ product: 19, l3: 62 }, d)).toMatchObject({ product: 19, l3: 62 });
    expect(viewOf({ product: 20, l3: 63 }, d)).toMatchObject({ product: 0, l3: 0 });
    expect(viewOf('x', d)).toEqual(d);
  });
});

describe('legend strip of each pane', () => {
  const measure = (s: string) => s.length * 6;
  const pal = parsePalette('T\n0,0,0,255|0\n0,255,0,255|10\n255,255,0,255|20\n255,0,0,255|30');

  it('spans its pane: the bar keeps the unit text’s offset and the pane’s width', () => {
    const W = 1436, H = 578;
    const [w, h] = paneSize(QUAD, W, H, false);
    const strips = [0, 1, 2, 3].map((p) => ({ origin: paneOrigin(QUAD, p, w, h), bar: legendBar(measure('dBz'), w) }));
    expect(strips.map((s) => s.origin)).toEqual([[0, 0], [718, 0], [0, 289], [718, 289]]);
    for (const s of strips) expect(s.bar).toEqual({ x0: 34, barW: 684 });
    // The single view's strip is the whole map's width.
    expect(legendBar(measure('dBz'), W)).toEqual({ x0: 34, barW: 1402 });
    // A value sits at the same fraction of the bar in a pane as in the single view.
    const at = (bar: { x0: number; barW: number }, v: number) => bar.x0 + ((v - 0) / 30) * bar.barW;
    expect((at(strips[1].bar, 15) - 34) / 684).toBeCloseTo((at(legendBar(18, W), 15) - 34) / 1402, 12);
  });

  it('places the palette ticks inside the narrower bar of a pane', () => {
    const { barW } = legendBar(measure('dBz'), 718);
    const ticks = legendTicks(pal, 0, 30, barW, (s) => measure(s));
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) { expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x).toBeLessThanOrEqual(barW); }
    // A strip narrower than its unit text still has a bar.
    expect(legendBar(60, 40).barW).toBe(10);
  });
});

describe('linked panes dialog', () => {
  const main: RadarView = { level2: true, product: 0, l3: 0, tilt: 0.9, offsetMin: 0 };
  const app = { nexrad: { tilts: [0.5, 0.9, 1.3, 0.5, 1.8].map((angle) => ({ angle })), view: () => main, paneLabel: () => 'KTLX · Reflectivity 0.9°' }, applyPaneLayout: vi.fn(), prompt: vi.fn(), dialog: vi.fn(), cyclePanes: vi.fn() };
  const bindings = () => paneBindings(app as never).TFrmPanes as Record<string, any>;
  afterEach(() => { panes.setLayout(0); [7, 3, 5].forEach((product, i) => panes.setView(i + 1, { level2: true, product, l3: 0, tilt: 0.5, offsetMin: 0 })); });

  it('binds every control of the form', () => {
    const controls = formDef('TFrmPanes').controls, b = bindings();
    const names = new Set(controls.map((c) => `TFrmPanes.${c.name}`));
    for (const key of Object.keys(b)) expect(names.has(key), key).toBe(true);
    for (const c of controls) if (['TsComboBox', 'TsSpinEdit', 'TsButton', 'TsListBox'].includes(c.cls)) expect(b[`TFrmPanes.${c.name}`], c.name).toBeTruthy();
  });

  it('edits the layout and each pane’s level, product, tilt and time offset in the store', () => {
    const b = bindings();
    b['TFrmPanes.layout'].set(3);
    expect([panes.count, b['TFrmPanes.layout'].get(), b['TFrmPanes.layout'].items()]).toEqual([4, 3, LAYOUTS.map((l) => l.name)]);
    b['TFrmPanes.product2'].set(10);
    b['TFrmPanes.offset2'].set(15);
    expect(panes.views[1]).toMatchObject({ level2: true, product: 10, offsetMin: 15 });
    // Tilts offered: the volume's distinct angles; a volume product has none.
    expect(b['TFrmPanes.tilt1'].items()).toEqual(['0.5°', '0.9°', '1.3°', '1.8°']);
    b['TFrmPanes.tilt1'].set(2);
    expect([panes.views[0].tilt, b['TFrmPanes.tilt1'].get(), b['TFrmPanes.tilt1'].disabled()]).toEqual([1.3, 2, false]);
    b['TFrmPanes.product1'].set(13);
    expect(b['TFrmPanes.tilt1'].disabled()).toBe(true);
    // Level 3: the product list is the enabled Level 3 products, stored by catalog index.
    b['TFrmPanes.level3'].set(1);
    const l3 = PRODUCTS.level3.filter((p) => !p.disabled);
    expect(b['TFrmPanes.product3'].items()).toEqual(l3.map((p) => p.name));
    b['TFrmPanes.product3'].set(5);
    expect(panes.views[2]).toMatchObject({ level2: false, l3: l3[5].index });
    expect([b['TFrmPanes.product3'].get(), b['TFrmPanes.level3'].get(), b['TFrmPanes.tilt3'].disabled()]).toEqual([5, 1, true]);
    expect(b['TFrmPanes.lblPane3'].text()).toBe('Pane 4');
    panes.setLayout(1);
    expect(b['TFrmPanes.lblPane3'].text()).toBe('Pane 4 (hidden)');
  });

  it('the preset buttons apply the presets for the main view and the volume’s tilts', () => {
    const b = bindings();
    app.applyPaneLayout.mockClear();
    b['TFrmPanes.btnPreset0'].run(); b['TFrmPanes.btnPreset2'].run();
    const [srv, tilts] = app.applyPaneLayout.mock.calls.map((c) => c[0]);
    expect([srv.name, srv.layout, srv.views.map((v: RadarView) => [v.product, v.tilt])]).toEqual(['REF / SRV', 1, [[0, 0.9], [7, 0.9]]]);
    expect(tilts.views.map((v: RadarView) => v.tilt)).toEqual([0.5, 0.9, 1.3, 1.8]);
  });
});
