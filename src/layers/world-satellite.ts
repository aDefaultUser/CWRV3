// Worldwide Weather → Satellite: NOAA/NESDIS Global Mosaic of Geostationary Satellite Imagery (GMGSI) from the public
// bucket noaa-gmgsi-pds (anonymous S3, CORS-enabled). Hourly global mosaics of GOES-East/West, Meteosat and Himawari
// in four channels; decoded in a worker (decode/gmgsi.ts) and drawn as a grey-scale image on its Mercator grid.
// NOAA states the coverage as 60°S–60°N; the grid reaches ±72.7° and pixels there are drawn only where the file's
// quality flag marks them good. Values are NOAA's scaled 0–255 image values, so the probe shows them as such.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, NOT_AVAILABLE } from './base';
import { FrameStore } from './frames';
import { timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { listS3 } from '../data/net';
import { pool } from '../workers/pool';
import { RasterDraw, Lut, type ProjParams } from '../render/raster';
import { parsePalette } from '../render/palette';
import { GMGSI_PRODUCTS, gmgsiKeyTime, type GmgsiImage, type GmgsiProduct } from '../decode/gmgsi';
import { pickValidFrame, hhmmZ, dateTimeZ, type Attribution } from './world-common';

export const GMGSI_BUCKET = 'https://noaa-gmgsi-pds.s3.amazonaws.com';
export const GMGSI_INFO = 'https://www.ospo.noaa.gov/products/imagery/gmgsi/';
/** Frames kept for the loop (hourly; the loop window is at most 6 hours). */
export const GMGSI_MAX_FRAMES = 7;
/** A frame stays valid one cadence after its nominal hour, the newest one longer (published ~35–45 min late). */
const MATCH_MS = 65 * 60e3, NEWEST_MS = 150 * 60e3;
/** Listings of the same window are repeated at most this often (new files arrive once an hour). */
const LIST_INTERVAL_MS = 5 * 60e3;

interface SatFrame { tex: GPUTexture; proj: ProjParams; bounds: [number, number, number, number]; nominalMs: number; scanStartMs: number | null; scanEndMs: number | null; platforms: string }

/** Hour prefixes (`GMGSI_LW/YYYY/MM/DD/HH/`) covering [from, to]. */
export function gmgsiHourPrefixes(p: GmgsiProduct, from: number, to: number): string[] {
  const out: string[] = [];
  for (let h = Math.floor(from / 3600e3) * 3600e3; h <= to; h += 3600e3) {
    const d = new Date(h), pad = (n: number) => String(n).padStart(2, '0');
    out.push(`${p.prefix}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/`);
  }
  return out;
}

export class WorldSatelliteLayer extends MapLayer {
  readonly id = 'worldSatellite';
  readonly title = 'World satellite (NOAA GMGSI)';
  readonly archive = 'window';
  /**
   * One store for every channel, time and resolution: a change empties it, while decodes already running finish in
   * their slots (so switching back and forth never runs more than two at once) and are discarded before upload.
   */
  private store: FrameStore<SatFrame>;
  /** Mode/archive time, channel and resolution the store's frames were requested for ('' when none). */
  private identity = '';
  private identityFactor = 2;
  private listed = { at: 0, window: '' };
  /** The listing in flight: a refresh for the same identity and window joins it; a newer one supersedes it. */
  private listing: { key: string; done?: Promise<void> } | null = null;
  private newestListed = 0;
  private raster: RasterDraw;
  private lut: Lut | null = null;
  constructor(r: Renderer) {
    super(r);
    this.raster = new RasterDraw(r);
    this.store = new FrameStore<SatFrame>(async (f) => {
      const g = await pool.for(this.id).run('gmgsi', { url: f.key, factor: this.identityFactor }) as GmgsiImage;
      // Dropped while decoding (another channel, time or resolution, or switched off): never uploaded.
      if (!this.store.frames.includes(f)) throw new Error('superseded');
      const tex = this.r.gpu.texture2D(g.width, g.height, 'r8unorm', g.codes, 1, this.id);
      return { tex, proj: g.proj as ProjParams, bounds: g.bounds, nominalMs: g.nominalMs, scanStartMs: g.scanStartMs, scanEndMs: g.scanEndMs, platforms: g.platforms };
    }, (d) => d.tex.destroy(), 2, () => { this.updateStatus(); });
  }

  enabled() { return settings.bool('ext.layerState.WorldSatelliteOn'); }
  product(): GmgsiProduct { return GMGSI_PRODUCTS[settings.num('ext.layerState.WorldSatelliteProduct')] ?? GMGSI_PRODUCTS[0]; }
  /** Block-average factor of the 0.072° grid (performance mode: 0 fastest … 2 best). */
  factor() { const m = settings.num('config.performanceMode'); return m === 2 ? 1 : m === 0 ? 3 : 2; }
  invalidate() { this.raster.invalidate(); }

  private drop() { this.store.clear(); this.identity = ''; this.listed = { at: 0, window: '' }; this.listing = null; this.newestListed = 0; }

  async refresh() {
    if (!this.enabled()) { this.drop(); this.setStatus('off', ''); return; }
    const p = this.product();
    const identity = `${timeline.key}|${p.id}|${this.factor()}`;
    if (identity !== this.identity) {
      this.drop();
      this.identity = identity;
      this.identityFactor = this.factor();
    }
    // Include the newest published frame if it can still be valid at the first step of the loop.
    const lo = timeline.loopStart - MATCH_MS, to = timeline.loopEnd, from = timeline.loopStart - NEWEST_MS;
    const window = [from, lo, to].map((t) => Math.floor(t / 3600e3)).join('-');
    if (this.listed.window === window && Date.now() - this.listed.at < LIST_INTERVAL_MS) { this.listing = null; this.updateStatus(); return; }
    const key = `${identity}|${window}`;
    if (this.listing?.key === key) return this.listing.done;
    const listing: { key: string; done?: Promise<void> } = { key };
    this.listing = listing;
    return listing.done = this.list(listing, p, from, lo, to, window);
  }

  /** Lists the window's files and replaces the wanted frames, unless a newer listing (or drop) superseded this one. */
  private async list(listing: { key: string }, p: GmgsiProduct, from: number, lo: number, to: number, window: string) {
    if (!this.store.frames.length) this.setStatus('loading', `Listing GMGSI ${p.short}…`);
    const files: { t: number; key: string }[] = [];
    try {
      await Promise.all(gmgsiHourPrefixes(p, from, to).map(async (prefix) => {
        const { objects } = await listS3(GMGSI_BUCKET, prefix, { maxPages: 1 });
        for (const o of objects) {
          const t = gmgsiKeyTime(o.key);
          if (t !== null && o.key.startsWith(prefix) && o.key.slice(prefix.length).startsWith(`${p.file}_`)) files.push({ t, key: `${GMGSI_BUCKET}/${o.key}` });
        }
      }));
    } catch (e) {
      if (this.listing === listing) { this.listing = null; this.setStatus('error', `GMGSI listing failed: ${(e as Error).message}`); }
      return;
    }
    if (this.listing !== listing) return; // the channel, mode, archive time or loop window changed while listing
    this.listing = null;
    this.listed = { at: Date.now(), window };
    const listed = files.filter((f) => f.t >= from && f.t <= to + 60e3).sort((a, b) => a.t - b.t);
    // The newest file is kept even when older than the loop (valid up to NEWEST_MS while nothing newer is published).
    const wanted = listed.filter((f, i) => f.t >= lo || i === listed.length - 1).slice(-GMGSI_MAX_FRAMES);
    this.newestListed = wanted.length ? wanted[wanted.length - 1].t : 0;
    // A frame that failed (network, decode) is tried again with each listing while it is still wanted.
    for (const f of this.store.frames) if (f.state === 'error') f.state = 'pending';
    this.store.setWanted(wanted);
    this.updateStatus();
  }

  private updateStatus() {
    if (!this.identity || !this.enabled()) return;
    const p = this.product(), c = this.store.counts(), total = this.store.frames.length;
    if (!total) { this.setStatus(timeline.mode === 'archive' ? 'unavailable' : 'error', timeline.mode === 'archive' ? NOT_AVAILABLE : `no GMGSI ${p.short} files listed for the loop window`); return; }
    const err = c.error ? `, ${c.error} failed (${this.store.frames.find((f) => f.state === 'error')?.error ?? ''})` : '';
    const text = `GMGSI ${p.short}: ${c.ready}/${total} hourly frames, newest ${hhmmZ(this.newestListed)}${err}`;
    this.setStatus(c.ready ? 'ready' : c.error === total ? 'error' : 'loading', text, { frames: c.ready, newestMs: this.newestListed });
  }

  /** The frame drawn at the map time (null: none valid, nothing is drawn). */
  shown(): (SatFrame & { t: number }) | null {
    const f = pickValidFrame(this.store.ready(), timeline.t, this.newestListed, MATCH_MS, NEWEST_MS);
    return f ? { ...f.data, t: f.t } : null;
  }

  mapLabel(): string | null {
    if (!this.enabled() || !this.identity) return null;
    const f = this.shown(), p = this.product();
    if (!f) return this.store.ready().length ? `World satellite (GMGSI ${p.short}): no frame for this time` : null;
    const scans = f.scanStartMs !== null && f.scanEndMs !== null ? ` (scans start ${hhmmZ(f.scanStartMs).slice(0, 5)}–${hhmmZ(f.scanEndMs)})` : '';
    return `World satellite: NOAA GMGSI ${p.short} ${dateTimeZ(f.nominalMs)}${scans}`;
  }
  attribution(): Attribution[] { return [{ text: 'Satellite: NOAA/NESDIS GMGSI', href: GMGSI_INFO, title: 'NOAA Global Mosaic of Geostationary Satellite Imagery (public domain US government data)' }]; }

  probeKind() { return this.enabled() && this.shown() ? 'worldSat' : null; }
  probeText(v: number) {
    const value = Math.round(((v * 255 - 1) * 255) / 254);
    return `GMGSI ${this.product().short}: ${Math.max(0, Math.min(255, value))}/255 (NOAA scaled image value, not calibrated)`;
  }

  draw(ctx: DrawContext) {
    if (!this.enabled()) return;
    const f = this.shown();
    if (!f) return;
    this.lut ??= new Lut(this.r, parsePalette('GMGSI grey\n0,0,0,255|0\n255,255,255,255|255'), { low: -255 / 254, high: 255, raster: false });
    this.raster.draw(ctx, {
      mode: 0, w: 0, alpha: settings.num('ext.layerState.WorldSatelliteAlpha') / 255, smoothing: false,
      bounds: f.bounds, proj: f.proj, luts: [this.lut], data: [[f.tex, f.tex]],
    }, 2);
  }
}
