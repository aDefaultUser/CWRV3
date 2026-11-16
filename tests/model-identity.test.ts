// Model tab: loaded data keeps the identity it was requested for (configuration, run, product), superseded
// downloads are discarded, and contour appearance settings restyle the loaded geometry at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ runs: [] as { task: string; args: any; resolve: (v: unknown) => void; reject: (e: Error) => void }[], uploads: [] as { destroyed: boolean; destroy(): void }[], lineSets: [] as any[], rasterDraws: [] as any[] }));

vi.mock('../src/workers/pool', () => ({ pool: { run: vi.fn((task: string, args: unknown) => new Promise((resolve, reject) => h.runs.push({ task, args, resolve, reject }))) } }));
vi.mock('../src/layers/grid', () => ({ uploadGrid: vi.fn(() => { const t = { destroyed: false, destroy() { t.destroyed = true; } }; h.uploads.push(t); return t; }) }));
vi.mock('../src/render/raster', async (orig) => ({
  ...(await orig<object>()),
  RasterDraw: class { calls: any[] = []; constructor() { h.rasterDraws.push(this); } draw(_c: unknown, p: unknown) { this.calls.push(p); } invalidate() {} },
  Lut: class { constructor(_r: unknown, public palette: { name?: string }) {} },
}));
vi.mock('../src/render/prims', async (orig) => ({
  ...(await orig<object>()),
  LineSet: class { styles: any[] = []; lines: any[] = []; constructor() { h.lineSets.push(this); } setStyles(s: any[]) { this.styles = s; } setLines(l: any[]) { this.lines = l; } draw() {} },
  TextSet: class { labels: any[] = []; alpha: number[] = []; setLabels(l: any[]) { this.labels = l; } flushAlpha() {} draw() {} },
  declutter: () => new Uint8Array(0),
}));

import { ModelLayer } from '../src/sections/model';
import { parseModelConfig } from '../src/sections/model-config';
import { settings } from '../src/settings/store';

const CONFIG = `Caption\nTestModel\nForecastTiming\n0,1,2\nCycleTiming\n0,6,60\nProjectionFile\nP\nDimensions\n100,100\nDownloadURL\nhttps://h/f[FF]\nInventoryExt\n.idx\nParameters:
1,0,0,°F,Temperature,M_2MTGLOBAL,TMP:2 m above ground
1,1,0,mph,Wind,surfacewind,UGRD:10 m above ground@VGRD:10 m above ground
0,0,1,mb,MSLP,PRMSL:mean sea level
0,0,1,dam,Height500,HGT:500 mb`;

const renderer = { camera: { cur: { z: 5 }, metersPerPixel: () => 1000, zoomScale: 4 } } as never;
const ctx = { probe: false } as never;
const flush = () => new Promise((r) => setTimeout(r, 0));
const IDS = { fill: 'layerState.ModelDataColorFillIdx', fill2: 'layerState.ModelDataColorFill2Idx', vector: 'layerState.ModelDataVectorsIdx', contour: 'layerState.ModelDataContoursIdx' };
const grid = { nx: 2, ny: 2, data: new Uint16Array(4), proj: {}, bounds: [0, 0, 1, 1] };
const contours = [{ level: 1000, coords: [-100, 35, -99, 35, -98, 36] }];

let snapshot: ReturnType<typeof settings.exportDocument>;
let layer: ModelLayer;
beforeEach(() => {
  snapshot = settings.exportDocument();
  h.runs.length = 0; h.uploads.length = 0; h.lineSets.length = 0; h.rasterDraws.length = 0;
  layer = new ModelLayer(renderer, {} as never);
  layer.configs = [parseModelConfig(CONFIG, 'test.config').config!];
  settings.set('layerState.ModelIdx', 0);
  for (const id of Object.values(IDS)) settings.set(id, -1);
  settings.set('settings.modelFillLegend', true);
  settings.set('settings.modelTimestamp', true);
});
afterEach(() => { settings.importDocument(snapshot); vi.useRealTimers(); });

const fillDraws = () => h.rasterDraws[0].calls.length;

describe('model data identity', () => {
  it('shows a fill only while its product is selected; selecting another product before Load shows nothing', async () => {
    settings.set(IDS.fill, 0);
    const load = layer.load(0);
    h.runs[0].resolve(grid);
    await load;
    layer.draw(ctx);
    expect(fillDraws()).toBe(1);
    expect(layer.legends().map((l) => l.unit)).toEqual(['°F']);
    expect(layer.probeText(0)).toMatch(/^Temperature/);

    settings.set(IDS.fill, 1); // Wind selected, not loaded: the temperature texture must not appear as wind
    layer.draw(ctx);
    expect(fillDraws()).toBe(1);
    expect(layer.legends()).toEqual([]);
    expect(layer.probeKind()).toBeNull();
    expect(layer.mapLabel()).toBeNull();

    settings.set(IDS.fill, 0); // back to the loaded product: shown again under its own identity
    layer.draw(ctx);
    expect(fillDraws()).toBe(2);
  });

  it('keeps fill and fill-2 apart and does not show either under a changed configuration', async () => {
    settings.set(IDS.fill, 0); settings.set(IDS.fill2, 1);
    const load = layer.load(0);
    h.runs[0].resolve(grid); await flush();
    h.runs[1].resolve(grid); await load;
    layer.draw(ctx);
    expect(h.rasterDraws[0].calls).toHaveLength(1);
    expect(h.rasterDraws[1].calls).toHaveLength(1);
    expect(h.rasterDraws[1].calls[0].luts[0].palette.name).toBe('surfacewind');
    layer.configs = [parseModelConfig(CONFIG.replace('TestModel', 'OtherModel'), 'other.config').config!];
    layer.draw(ctx);
    expect(h.rasterDraws[0].calls).toHaveLength(1);
    expect(layer.enabled()).toBe(false);
  });

  it('discards a result whose product was deselected while downloading, and keeps the others', async () => {
    settings.set(IDS.vector, 0); settings.set(IDS.contour, 0);
    const load = layer.load(0);
    expect(h.runs[0].args.kind).toBe('vector');
    settings.set(IDS.contour, 1); // MSLP → Height500 while the vector download runs
    h.runs[0].resolve({ vectors: new Float32Array([-98, 35, 5, 5]) });
    await load; // the MSLP request is never made
    expect(h.runs).toHaveLength(1);
    layer.tick(0);
    expect(h.lineSets[0].lines).toEqual([]); // no contours shown as Height500
    expect(h.lineSets[1].lines.length).toBeGreaterThan(0); // wind vectors kept
    expect(layer.busy).toBe(false);

    const load2 = layer.load(0); // Load again: the new selection is requested under its own identity
    h.runs[1].resolve({ vectors: new Float32Array([-98, 35, 5, 5]) }); await flush();
    expect(h.runs[2].args.matches).toEqual(['HGT:500 mb']);
    settings.set(IDS.contour, 0); // changed again before that result arrives
    h.runs[2].resolve({ contours });
    await load2;
    layer.tick(0);
    expect(h.lineSets[0].lines).toEqual([]);
  });

  it('discards results of a cleared or aborted load; an old load never resets a newer one', async () => {
    settings.set(IDS.fill, 0);
    const first = layer.load(0);
    layer.clear();
    expect(layer.busy).toBe(false);
    const second = layer.load(1);
    expect(layer.busy).toBe(true);
    h.runs[0].resolve(grid); await first;
    expect(h.uploads).toHaveLength(0);
    expect(layer.busy).toBe(true); // the cleared load's finally left the new load alone
    h.runs[1].resolve(grid); await second;
    expect(h.uploads).toHaveLength(1);
    expect(layer.busy).toBe(false);
    expect([...layer.frames.keys()]).toEqual([1]);

    const third = layer.load(2);
    layer.setAbort();
    expect(layer.busy).toBe(false);
    h.runs[2].resolve(grid); await third;
    expect(h.uploads).toHaveLength(1);
    expect(layer.frames.has(2)).toBe(false);
  });

  it('labels loaded frames with their own run after the current cycle rolls over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 15, 7, 30)); // newest cycle 06Z
    settings.set(IDS.fill, 0);
    const load = layer.load(0);
    h.runs[0].resolve({ ...grid, validMs: Date.UTC(2026, 10, 15, 6) });
    await load;
    expect(layer.mapLabel()).toMatch(/^TestModel 06Z \+0HR/);
    vi.setSystemTime(Date.UTC(2026, 10, 15, 13, 30)); // 12Z is now current
    expect(layer.runText()).toBe('Current run: 12Z');
    expect(layer.mapLabel()).toMatch(/^TestModel 06Z \+0HR/);
    const reload = layer.load(0); // loading the new cycle replaces the 06Z frames
    expect(h.uploads[0].destroyed).toBe(true);
    h.runs[1].resolve(grid); await reload;
    expect(layer.mapLabel()).toMatch(/^TestModel 12Z/);
  });
});

describe('contour appearance', () => {
  it('restyles loaded contours at once when colour, border colour, borders or alpha change', async () => {
    settings.set(IDS.contour, 0);
    const load = layer.load(0);
    h.runs[0].resolve({ contours });
    await load;
    const lines = h.lineSets[0];
    layer.tick(0);
    expect(lines.lines).toHaveLength(2);
    const style = () => JSON.stringify(lines.styles);
    const steps: [string, unknown, (s: any[]) => unknown][] = [
      ['settings.generalContourColor', [10, 20, 30], (s) => s[1].color.slice(0, 3)],
      ['settings.generalContourBorderColor', [40, 50, 60], (s) => s[0].color.slice(0, 3)],
      ['settings.generalContourBorders', !settings.bool('settings.generalContourBorders'), (s) => s[0].color[3] > 0],
      ['settings.generalContourAlpha', 0.25, (s) => s[0].color[3] || s[1].color[3]],
    ];
    for (const [id, value, read] of steps) {
      const before = style();
      settings.set(id, value);
      layer.tick(0); // no pan, zoom or reload
      expect(style(), id).not.toBe(before);
      if (id === 'settings.generalContourBorders') expect(read(lines.styles), id).toBe(value);
      else if (id === 'settings.generalContourAlpha') expect(read(lines.styles), id).toBe(Math.min(255, Math.round(0.25 * 255) + 60));
      else expect(read(lines.styles), id).toEqual(value);
      expect(lines.lines, id).toHaveLength(2);
    }
  });
});
