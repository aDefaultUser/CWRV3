// NDFD tab (: 19 regions, lists A/B with the Alaska switch quirk, forecast-hour slots, slider with
// interpolation, valid-time label) and Winter tab (28: WPC probabilistic snow / ice accumulation percentiles).
import type { DrawContext } from '../render/renderer';
import { GridLayer, uploadGrid, type GridDisplay, type GridFrame } from '../layers/grid';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';
import { XPRODUCTS } from '../generated/products-expanded';
import { getPalette } from '../palettes/library';
import { paletteRange } from '../render/palette';

export const NDFD = XPRODUCTS.ndfd;
const NDFD_BASE = 'https://tgftp.nws.noaa.gov/SL.us008001/';
/** Alaska uses ST.expr, every other region ST.opnl. */
export const ndfdUrl = (region: number, file: string, expr = region === 18) => `${NDFD_BASE}ST.${expr ? 'expr' : 'opnl'}/DF.gr2/DC.ndfd/AR.${NDFD.regions[region]}/VP.001-003/${file}`;

export interface NdfdEntry { caption: string; file: string; hours: number[] | null; paletteIndex: number }
/** Entry of the active list; list B takes hours and palette from the list-A entry with the same file (choose). */
export function ndfdEntry(listB: boolean, idx: number): NdfdEntry {
  if (!listB) { const e = NDFD.listA[idx] ?? NDFD.listA[12]; return { caption: e.caption, file: e.file, hours: e.hours ? [...e.hours] : null, paletteIndex: e.index }; }
  const b = NDFD.listB[idx] ?? NDFD.listB[0];
  const a = NDFD.listA.find((x) => x.file === b.file);
  return { caption: b.caption, file: b.file, hours: a?.hours ? [...a.hours] : null, paletteIndex: a?.index ?? 10 };
}

/** List switching quirk: to B when region 18 is chosen; back to A only when region 0 is chosen (parity). */
export function nextListB(current: boolean, region: number, corrected: boolean): boolean {
  if (region === 18) return true;
  if (corrected) return false;
  return region === 0 ? false : current;
}

/** Slot label: negative codes are whole days ("Time: Day N"), positive codes forecast hours ("Hour h"). */
export const slotLabel = (code: number | undefined) => (code === undefined ? 'Time: -' : code < 0 ? `Time: Day ${-code}` : `Hour ${code}`);

interface Slot { frame: GridFrame | null; validMs: number | null; strings: string[] }

export class NdfdLayer extends GridLayer {
  readonly id = 'ndfd';
  readonly title = 'NDFD';
  listB = settings.num('layerState.NDFDRegionIdx') === 18;
  slots: Slot[] = [];
  /** Slider position: slot × 100 + fraction. */
  pos = settings.num('layerState.NDFDTimeIdx') * 100;
  unit = '';
  private key = ''; private at = 0;
  enabled() { return settings.bool('layerState.NDFDOn'); }
  entry() { return ndfdEntry(this.listB, settings.num('layerState.NDFDProductIdx')); }
  setRegion(region: number) {
    const prevB = this.listB, cap = this.entry().caption;
    this.listB = nextListB(this.listB, region, settings.bool('ext.settings.ndfdCorrectedListSwitch'));
    settings.set('layerState.NDFDRegionIdx', region);
    if (prevB !== this.listB) {
      // The product combo is refilled with the other list; the selection is kept by caption.
      const list = this.listB ? NDFD.listB : NDFD.listA;
      const i = list.findIndex((e) => e.caption === cap);
      settings.set('layerState.NDFDProductIdx', i >= 0 ? i : 0);
    }
  }
  slotCodes(): number[] { const e = this.entry(); return e.hours ?? this.slots.map((_, i) => i); }
  display(): GridDisplay {
    const e = this.entry();
    const pal = settings.arr<string>('settings.ndfdPalettes')[e.paletteIndex] ?? 'M_2MTGLOBAL';
    const [low, high] = paletteRange(getPalette(pal));
    return { low, high, unit: this.unit, palette: pal, label: e.caption, alpha: settings.num('settings.ndfdAlpha') / 255, smoothing: settings.bool('settings.ndfdSmoothing'), legend: settings.bool('settings.ndfdLegend'), blend: settings.bool('settings.ndfdInterpolate') };
  }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const region = settings.num('layerState.NDFDRegionIdx');
    const e = this.entry();
    const d = this.display();
    const key = `${region}|${e.file}|${d.palette}`;
    // The region/product file is re-downloaded when older than 5 minutes.
    if (key === this.key && Date.now() - this.at < 5 * 60e3) return;
    this.setStatus('loading', `NDFD ${e.caption} (${NDFD.regions[region]})`);
    try {
      let res: { frames: { nx: number; ny: number; data: Uint16Array; proj: any; bounds: [number, number, number, number]; refTimeMs: number; validMs: number; unit: string; strings: string[] }[] };
      const byCode = /ds\.(wx|wwa|conhazo|critfireo|dryfireo)\.bin/.test(e.file);
      try { res = await pool.run('grid.all', { url: ndfdUrl(region, e.file), lo: d.low, hi: d.high, byCode }); }
      catch (err) { if (region !== 18) throw err; res = await pool.run('grid.all', { url: ndfdUrl(region, e.file, false), lo: d.low, hi: d.high, byCode }); }
      for (const s of this.slots) s.frame?.tex.destroy();
      const frames = res.frames.sort((a, b) => a.validMs - b.validMs);
      this.unit = frames[0]?.unit ?? '';
      const codes = e.hours;
      const mk = (f: (typeof frames)[number]): Slot => ({ frame: { t: f.validMs, key: `${key}|${f.validMs}`, tex: uploadGrid(this.r, f.nx, f.ny, f.data), proj: f.proj, bounds: f.bounds }, validMs: f.validMs, strings: f.strings });
      if (!codes) this.slots = frames.map(mk);
      else if (codes[0] < 0) this.slots = codes.map((_, k) => (frames[k] ? mk(frames[k]) : { frame: null, validMs: null, strings: [] }));
      else {
        const ref = frames[0]?.refTimeMs ?? 0;
        this.slots = codes.map((h) => { const f = frames.find((x) => Math.abs((x.validMs - ref) / 3600e3 - h) < 1.6); return f ? mk(f) : { frame: null, validMs: null, strings: [] }; });
      }
      this.frames = this.slots.flatMap((s) => (s.frame ? [s.frame] : []));
      this.key = key; this.at = Date.now();
      this.pos = Math.min(this.pos, (this.slots.length - 1) * 100);
      this.setStatus('ready', `NDFD ${e.caption}: ${this.frames.length}/${this.slots.length} slots`);
    } catch (err) { this.setStatus('error', `NDFD: ${(err as Error).message}`); }
  }
  setPos(p: number) {
    const max = Math.max(0, (this.slots.length - 1) * 100);
    this.pos = Math.max(0, Math.min(max, settings.bool('settings.ndfdInterpolate') ? p : Math.round(p / 100) * 100));
    settings.set('layerState.NDFDTimeIdx', Math.floor(this.pos / 100));
  }
  /** Blend of slot k and k+1 with weight (pos mod 100)/100 when Interpolate is on. */
  current(): { a: GridFrame | null; b: GridFrame | null; w: number } {
    const k = Math.floor(this.pos / 100), w = (this.pos % 100) / 100;
    const a = this.slots[k]?.frame ?? null, b = settings.bool('settings.ndfdInterpolate') && w > 0 ? this.slots[k + 1]?.frame ?? null : null;
    return { a, b, w: b ? w : 0 };
  }
  validMs(): number | null {
    const k = Math.floor(this.pos / 100), w = (this.pos % 100) / 100;
    const a = this.slots[k]?.validMs ?? null, b = this.slots[k + 1]?.validMs ?? null;
    return a !== null && b !== null && settings.bool('settings.ndfdInterpolate') ? a + (b - a) * w : a;
  }
  timeText() { return slotLabel(this.slotCodes()[Math.floor(this.pos / 100)]); }
  validText() { const v = this.validMs(); return `Forecast Valid: ${v ? new Date(v).toLocaleString([], { year: '2-digit', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-'}`; }
  mapLabel() { return this.enabled() && settings.bool('settings.ndfdTimeLabel') ? `NDFD ${this.entry().caption} — ${this.validText().replace('Forecast ', '')}` : null; }
  probeText(x: number) {
    const s = this.slots[Math.floor(this.pos / 100)];
    if (s?.strings.length && /ds\.(wx|wwa)/.test(this.entry().file)) { const d = this.display(); const code = Math.round(d.low + (d.high - d.low) * x); return `${this.entry().caption}: ${s.strings[code] ?? code}`; }
    return super.probeText(x);
  }
  draw(ctx: DrawContext) { super.draw(ctx); }
}

// ------------------------------------------------------------------------------------------- Winter
export const WINTER_LEVELS = [5, 10, 25, 50, 75, 90, 95];
/** URL from the four selectors (L interval, snow/ice, percentile, end hour). */
export function pwpfUrl(L: number, snow: boolean, pct: number, endH: number) {
  return `https://ftp-wpc.ncep.noaa.gov/pwpf/conus_2.5km/2.5kmpwpf_${L}hr/2.5kmprcntil_${L}${snow ? 'hsnow' : 'hicez'}_${String(pct).padStart(2, '0')}pt_latestf${String(endH).padStart(3, '0')}.grb`;
}
/** Valid end hours: L … 72 in 6-hour steps (same rule chosen for 48/72). */
export const winterEndHours = (L: number) => { const out: number[] = []; for (let h = L; h <= 72; h += 6) out.push(h); return out; };

export class WinterLayer extends GridLayer {
  readonly id = 'winter';
  readonly title = 'Winter accumulations';
  validRange: [number, number] | null = null;
  private key = ''; private at = 0;
  enabled() { return settings.bool('layerState.WinterAccumulationsOn'); }
  private palette() { return settings.arr<string>('settings.wpcWinterColorPalette')[settings.bool('layerState.WinterSnowAccumulationsVsIce') ? 0 : 1] ?? 'DefaultSnowDepth'; }
  display(): GridDisplay {
    const pal = this.palette();
    const [low, high] = paletteRange(getPalette(pal));
    const snow = settings.bool('layerState.WinterSnowAccumulationsVsIce');
    return { low, high, unit: 'in', palette: pal, label: `${settings.num('layerState.WinterProbabilityLevel')}th percentile ${snow ? 'snow' : 'ice'}`, alpha: settings.num('settings.wpcWinterAlpha') / 255, smoothing: true, legend: settings.bool('settings.wpcWinterShowLegend'), blend: false };
  }
  url() {
    const L = settings.num('layerState.WinterIntervalLengthHours');
    const end = Math.max(L, Math.min(72, settings.num('layerState.WinterIntervalEndHour')));
    return pwpfUrl(L, settings.bool('layerState.WinterSnowAccumulationsVsIce'), settings.num('layerState.WinterProbabilityLevel'), end);
  }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const url = this.url(), d = this.display();
    if (url + d.palette === this.key && Date.now() - this.at < 10 * 60e3) return;
    this.setStatus('loading', 'WPC winter accumulation');
    try {
      const res = await pool.run('grid.all', { url, lo: d.low, hi: d.high, maxFrames: 1 });
      const f = res.frames[0];
      this.setFrames([{ t: f.validMs, key: url, tex: uploadGrid(this.r, f.nx, f.ny, f.data), proj: f.proj, bounds: f.bounds }]);
      this.validRange = [f.validMs - settings.num('layerState.WinterIntervalLengthHours') * 3600e3, f.validMs];
      this.key = url + d.palette; this.at = Date.now();
      this.setStatus('ready', `WPC PWPF ${url.split('/').pop()}`);
    } catch (e) { this.clearFrames(); this.setStatus('error', `WPC PWPF: ${(e as Error).message}`); }
  }
  current() { return { a: this.frames[0] ?? null, b: null, w: 0 }; }
  mapLabel() {
    if (!this.enabled() || !settings.bool('settings.wpcWinterShowTimestamp') || !this.validRange) return null;
    const f = (t: number) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `${f(this.validRange[0])} – ${f(this.validRange[1])}`;
  }
}
