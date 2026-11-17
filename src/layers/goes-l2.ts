// Extended GOES Level 2+ products from the public NOAA GOES-R buckets (noaa-goes19 / noaa-goes18): Cloud Top Height
// (ABI-L2-ACHA), Cloud Top Temperature (ABI-L2-ACHT) and Fire/Hot Spot Characterization (ABI-L2-FDC, with fire
// radiative power). Shares the Extended GOES dialog's satellite and sector; a product is listed only for the
// sectors NOAA produces it for (no CONUS cloud-top temperature).
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, type LegendSpec } from './base';
import { FrameStore } from './frames';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { listS3 } from '../data/net';
import { pool } from '../workers/pool';
import { RasterDraw, Lut, geosProj, type ProjParams } from '../render/raster';
import { PointSet, SHAPE, type PointSpec } from '../render/prims';
import { getPalette } from '../palettes/library';
import { evalPalette } from '../render/palette';
import { lonLatToXYZ } from '../render/camera';
import { FIRE_CATEGORY, type AbiFires } from '../decode/goes';
import { thinGoesFiles } from './satellite';

export interface GoesL2Product { key: 'ACHA' | 'ACHT' | 'FDC'; name: string; unit: string; low: number; high: number; sectors: readonly number[] }
/** Sector indices as in the Extended GOES dialog: 0 CONUS, 1 Full Disk, 2 Mesoscale 1, 3 Mesoscale 2. */
export const GOES_L2: readonly GoesL2Product[] = [
  { key: 'ACHA', name: 'Cloud Top Height', unit: 'km', low: 0, high: 20, sectors: [0, 1, 2, 3] },
  { key: 'ACHT', name: 'Cloud Top Temperature', unit: '°C', low: -100, high: 40, sectors: [1, 2, 3] },
  { key: 'FDC', name: 'Fire / Hot Spot (FRP)', unit: 'MW', low: 0, high: 1000, sectors: [0, 1, 2, 3] },
];
const SECTOR_NAME = ['CONUS', 'Full Disk', 'Mesoscale 1', 'Mesoscale 2'];
const SECTOR_TAG = ['C', 'F', 'M1', 'M2'];

/** Bucket prefix and file-name tag of a product in a sector (mesoscale 1 and 2 share the M prefix). */
export function goesL2Names(key: GoesL2Product['key'], sector: number): { prefix: string; tag: string } {
  return { prefix: `ABI-L2-${key}${sector >= 2 ? 'M' : SECTOR_TAG[sector]}`, tag: `${key}${SECTOR_TAG[sector]}` };
}
/** Start time (epoch ms) of an ABI L2 file name of the given tag, or null for another product or sector. */
export function goesL2FileTime(name: string, tag: string): number | null {
  const m = new RegExp(`OR_ABI-L2-${tag}-M\\d+_G\\d+_s(\\d{4})(\\d{3})(\\d{2})(\\d{2})(\\d{2})`).exec(name);
  return m ? Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 86400e3 + +m[3] * 3600e3 + +m[4] * 60e3 + +m[5] * 1000 : null;
}

interface GridFrame { kind: 'grid'; tex: GPUTexture; proj: ProjParams; good: number; marginal: number; startMs: number }
interface FireFrame { kind: 'fire'; fires: AbiFires; startMs: number }
type L2Frame = GridFrame | FireFrame;

export class GoesL2Layer extends MapLayer {
  readonly id = 'satelliteL2';
  readonly title = 'Extended GOES Level 2';
  private store: FrameStore<L2Frame> | null = null;
  /** Identity (product, satellite, sector) the store's frames were requested for. */
  private identity = '';
  private raster: RasterDraw;
  private points: PointSet;
  private pointsKey = '';
  private shown: FireFrame | null = null;
  private luts = new Map<string, Lut>();
  constructor(r: Renderer) { super(r); this.raster = new RasterDraw(r); this.points = new PointSet(r); }

  enabled() { return settings.bool('layerState.ExtendedSatelliteOn') && settings.bool('ext.layerState.ExtendedSatelliteUseL2') && settings.num('ext.layerState.ExtendedSatellitePlatform') !== 2; }
  product(): GoesL2Product { return GOES_L2[settings.num('ext.layerState.ExtendedSatelliteL2Product')] ?? GOES_L2[0]; }
  platform() { return settings.num('ext.layerState.ExtendedSatellitePlatform') === 1 ? 'goes18' : 'goes19'; }
  sector() { return settings.num('ext.layerState.ExtendedSatelliteDomain'); }
  /** Why the selected product cannot be shown in the selected sector, or null. */
  unavailable(): string | null {
    const p = this.product(), s = this.sector();
    return p.sectors.includes(s) ? null : `${p.name} is not produced for ${SECTOR_NAME[s]}; choose ${p.sectors.map((x) => SECTOR_NAME[x]).join(' or ')}.`;
  }
  palette() { return settings.arr<string>('ext.settings.goesL2Palettes')[settings.num('ext.layerState.ExtendedSatelliteL2Product')] ?? 'GOESL2CloudTopHeight'; }
  invalidate() { this.raster.invalidate(); }
  /** Product, satellite, sector and resolution the frames are requested for. */
  private selection() { return `${this.product().key}|${this.platform()}|${this.sector()}|${settings.num('config.performanceMode')}`; }
  /** The store while it still matches the settings (they can change before the next refresh), else null. */
  private current() { return this.enabled() && this.store && this.identity === this.selection() ? this.store : null; }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const p = this.product(), sector = this.sector(), platform = this.platform();
    const why = this.unavailable();
    const id = this.selection();
    if (id !== this.identity) { this.store?.clear(); this.store = null; this.identity = id; this.shown = null; this.pointsKey = ''; }
    if (why) { this.setStatus('unavailable', why); return; }
    const store: FrameStore<L2Frame> = this.store ??= new FrameStore<L2Frame>((f) => this.load(f.key, p), (d) => { if (d.kind === 'grid') d.tex.destroy(); }, 2,
      () => { if (store === this.current()) this.updateStatus(); });
    // A listing that settles after the selection changed (or the layer was turned off) must not touch the status.
    const stale = () => store !== this.current();
    const bucket = `https://noaa-${platform}.s3.amazonaws.com`;
    const { prefix, tag } = goesL2Names(p.key, sector);
    const hours: number[] = [];
    for (let t = Math.floor(timeline.loopStart / 3600e3) * 3600e3; t <= timeline.loopEnd; t += 3600e3) hours.push(t);
    const files: { key: string; t: number }[] = [];
    this.setStatus('loading', `Listing ${prefix}…`);
    try {
      await Promise.all(hours.map(async (h) => {
        const d = new Date(h);
        const doy = Math.floor((h - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400e3) + 1;
        const { objects } = await listS3(bucket, `${prefix}/${d.getUTCFullYear()}/${String(doy).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`, { maxPages: 3 });
        for (const o of objects) { const t = goesL2FileTime(o.key, tag); if (t !== null) files.push({ key: `${bucket}/${o.key}`, t }); }
      }));
    } catch (e) {
      if (!stale()) this.setStatus('error', `GOES ${p.name} listing failed: ${(e as Error).message}`);
      return;
    }
    if (stale()) return;
    let fs = files.filter((f) => f.t >= timeline.loopStart - 10 * 60e3).sort((a, b) => a.t - b.t);
    fs = thinGoesFiles(fs, sector).slice(-(settings.bool('settings.goesExtendedForce60fps') ? 60 : 36));
    if (!fs.length) { this.setStatus('unavailable', `No ${platform.toUpperCase()} ${p.name} files for ${SECTOR_NAME[sector]} in the loop period.`); return; }
    store.setWanted(fs);
    this.updateStatus();
  }

  private async load(url: string, p: GoesL2Product): Promise<L2Frame> {
    const factor = Math.max(1, Math.round((this.sector() === 1 ? 2 : 1) * (settings.num('config.performanceMode') === 2 ? 0.5 : 1)));
    const res = await pool.for(this.id).run('goes.l2', { url, factor, min: p.low, max: p.high });
    if (res.kind !== p.key) throw new Error(`file holds ${res.kind}, not ${p.key}`);
    if (res.kind === 'FDC') return { kind: 'fire', fires: res as AbiFires, startMs: res.startMs };
    return { kind: 'grid', tex: this.r.gpu.texture2D(res.width, res.height, 'r8unorm', res.codes, 1, this.id), proj: geosProj(res.proj, res.width, res.height), good: res.good, marginal: res.marginal, startMs: res.startMs };
  }

  private updateStatus() {
    if (!this.store) return;
    const c = this.store.counts(), n = this.store.frames.length, p = this.product();
    const newest = this.store.ready().at(-1)?.data;
    const extra = newest?.kind === 'fire' ? ` · ${newest.fires.lat.length} fire pixels in the newest scan` : '';
    this.setStatus(c.ready ? 'ready' : c.error && !c.loading && !c.pending ? 'error' : 'loading', `${this.platform().toUpperCase()} ${p.name} ${SECTOR_NAME[this.sector()]}: ${c.ready}/${n}${c.error ? `, ${c.error} failed` : ''}${extra}`, { frames: c.ready, newestMs: newest?.startMs });
  }

  private lut(): Lut {
    const name = this.palette(), p = this.product(), key = `${name}|${p.key}`;
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low: p.low - (p.high - p.low) / 254, high: p.high, raster: false }); this.luts.set(key, l); }
    return l;
  }

  legends(): LegendSpec[] {
    if (!this.enabled() || !settings.bool('settings.goesLegend') || this.unavailable()) return [];
    const p = this.product();
    return [{ id: this.id, palette: getPalette(this.palette()), low: p.low, high: p.high, unit: p.unit, lut: this.lut(), note: p.key === 'FDC' ? 'Fire radiative power; detections without a power value are drawn grey' : 'Good-quality pixels only (product DQF 0)' }];
  }

  probeKind() { return this.product().key !== 'FDC' && this.current()?.ready().length ? 'satL2' : null; }
  probeText(v: number) {
    const p = this.product(), val = p.low + ((p.high - p.low) * (v * 255 - 1)) / 254;
    return `${p.name} ${val.toFixed(p.key === 'ACHA' ? 1 : 0)} ${p.unit}`;
  }

  /** Fire detection under the cursor (within 8 px): category, power, temperature and area. */
  probeAt(_lon: number, _lat: number, x: number, y: number): string[] | null {
    const f = this.current() && this.shown?.fires;
    if (!f) return null;
    let best = -1, bd = 64;
    for (let i = 0; i < f.lat.length; i++) {
      const [px, py, front] = this.r.camera.project(lonLatToXYZ(f.lon[i], f.lat[i]));
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (front && d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    const v = (x: number, unit: string, digits = 0) => (x === x ? `${x.toFixed(digits)} ${unit}` : 'n/a');
    const area = f.areaM2[best];
    return [`GOES ${FIRE_CATEGORY[f.mask[best]] ?? 'fire'}`, `Fire radiative power ${v(f.power[best], 'MW', 1)}`, `Fire temperature ${v(f.tempK[best], 'K')}`,
      `Fire area ${area === 4000 ? '≤ 4000 m² (packing minimum)' : v(area, 'm²')}`, `Scan ${new Date(this.shown!.startMs).toISOString().slice(11, 16)}Z, quality flag ${f.dqf[best]}`];
  }

  draw(ctx: DrawContext) {
    const store = this.current();
    if (!store || this.unavailable()) return;
    const ready = store.ready();
    const fire = this.product().key === 'FDC';
    const { a, b, w } = bracket(ready.map((f) => ({ t: f.t, f: f.data })), timeline.t, !fire && settings.bool('layerState.RasterDataTemporalInterpolation'), 30 * 60e3);
    if (!a) return;
    if (a.f.kind === 'grid') {
      // A mesoscale sector can move between scans; one projection can blend only matching fixed grids.
      const ap = a.f.proj, bp = b?.f.kind === 'grid' ? b.f.proj : null;
      const bf = b?.f.kind === 'grid' && bp && ap.nx === bp.nx && ap.ny === bp.ny
        && ap.a.every((v, i) => v === bp.a[i]) && ap.b.every((v, i) => v === bp.b[i]) ? b.f : null;
      this.raster.draw(ctx, { mode: 0, w: bf ? w : 0, alpha: settings.num('settings.goesExtendedAlpha') / 255, smoothing: true, bounds: [-81, a.f.proj.a[3] - 81, 81, a.f.proj.a[3] + 81], proj: a.f.proj, luts: [this.lut()], data: [[a.f.tex, (bf ?? a.f).tex]] }, 2);
      return;
    }
    if (ctx.probe) return;
    this.shown = a.f;
    const key = `${a.f.startMs}|${this.palette()}|${settings.num('settings.goesExtendedAlpha')}`;
    if (key !== this.pointsKey) { this.pointsKey = key; this.points.setPoints(this.firePoints(a.f.fires)); }
    this.points.draw(ctx);
  }

  private firePoints(f: AbiFires): PointSpec[] {
    const pal = getPalette(this.palette()), p = this.product(), alpha = settings.num('settings.goesExtendedAlpha');
    const out: PointSpec[] = [];
    for (let i = 0; i < f.lat.length; i++) {
      if (f.lat[i] !== f.lat[i]) continue;
      const mw = f.power[i];
      const c = mw === mw ? evalPalette(pal.frames[0], Math.min(p.high, Math.max(p.low, mw))) : [150, 150, 150, 255];
      // Size grows with power (log scale); low-probability and cloud-contaminated detections are drawn as rings.
      const weak = [12, 15, 32, 35].includes(f.mask[i]);
      out.push({ lon: f.lon[i], lat: f.lat[i], size: 7 + (mw === mw ? Math.min(9, 2.2 * Math.log10(1 + mw)) : 0), color: [c[0], c[1], c[2], alpha], shape: weak ? SHAPE.ring : SHAPE.circle, outline: 1 });
    }
    return out;
  }
}
