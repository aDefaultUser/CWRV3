// Max-value trail of the NEXRAD layer: for a chosen Level 2 product, the per-gate maximum over the complete volumes of
// the loop (or of the last N minutes up to the volume shown) drawn over the radar like a sweep. Each volume's product
// is requested under the trail's own identity (site, product, tilt, algorithm inputs) and uploaded once; the blend is
// rebuilt on the GPU only when the identity or the set of volumes changes. A site change drops everything and discards
// results still in flight.
import type { DrawContext, PrepassContext, Renderer } from '../render/renderer';
import type { LegendSpec } from './base';
import { RadarDraw, Lut, uploadSweep, type SweepTex } from '../render/raster';
import { TrailBlend, TRAIL_ROWS, type TrailSource } from '../render/trail';
import { AZ_BINS, AZ_BIN0, algorithmKey, type L2BuildParams } from '../radar/l2products';
import { hailEnvironment } from '../radar/environment';
import { L2, L2_PALETTE_KEYS } from '../radar/sources';
import type { L2Meta } from '../workers/l2-volumes';
import { getPalette } from '../palettes/library';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';

const S = (k: string) => `ext.settings.nexradTrail${k}`;
/** Products a trail can be made of: 8-bit codes that grow with the value, so the largest code is the largest value. */
export const TRAIL_PRODUCTS = [19, 17, 18, 8, 13, 11, 12, 14, 15, 16, 0] as const;
export const TRAIL_NAMES: Record<number, string> = { 19: 'Hail core', 17: 'ZDR column', 18: 'KDP column', 8: 'Azimuthal shear', 13: 'VIL', 11: 'MEHS', 12: 'POSH', 14: 'VIL density', 15: 'Echo tops', 16: 'Gust potential', 0: 'Reflectivity' };
const MAX_IN_FLIGHT = 2;
const RETRY_MS = 30_000;
const hm = (t: number) => new Date(t).toISOString().slice(11, 16);

/** What the trail reads from the NEXRAD layer (NexradLayer has these). */
export interface TrailHost {
  readonly l2: readonly { t: number; file: { url: string; live: boolean; chunks?: string[] }; meta?: L2Meta }[];
  readonly liveComposite: boolean;
  readonly tiltAngle: number;
  enabled(): boolean; isL2(): boolean;
  siteInfo(): { id: string; lon: number; lat: number; elevFt: number } | null;
  sweepFor(meta: L2Meta, product: number): number | null;
  algorithmParams(volumeMs?: number | null): Omit<L2BuildParams, 'envIsotherms'>;
  shownScan(): { t: number } | null;
}

/** One volume's product: `key` is what it was requested for (trail identity, volume, sweep, build parameters). */
interface Frame { key: string; url: string; t: number; args: object; pending: boolean; sweep?: SweepTex & { elevation: number }; src?: TrailSource; error?: string; failedAt?: number }

export interface TrailTarget {
  tex: GPUTexture; sweep: SweepTex; key: string; product: number; elevation: number; from: number; to: number; n: number; label: string;
  /** The worker requests of the blended volumes and their images' geometry (for checks against trailReference). */
  inputs: { args: object; geom: SweepTex }[];
}

export class RadarTrail {
  private frames = new Map<string, Frame>();
  target: TrailTarget | null = null;
  private blend: TrailBlend; private radar: RadarDraw | null = null;
  private site = ''; private gen = 0;
  private luts = new Map<string, Lut>();

  constructor(private r: Renderer, private host: TrailHost) { this.blend = new TrailBlend(r); }

  product(): number { const p = settings.num(S('Product')); return (TRAIL_PRODUCTS as readonly number[]).includes(p) ? p : 19; }
  on(): boolean { const h = this.host; return settings.bool(S('')) && h.enabled() && h.isL2() && !h.liveComposite; }

  /** Site | product | tilt (single-tilt products) | algorithm inputs: frames and blends are kept only under it. */
  identity(product = this.product()): string {
    const tilt = product < 11 ? this.host.tiltAngle : '';
    return `${this.host.siteInfo()?.id ?? ''}|${product}|${tilt}|${algorithmKey(product, this.host.algorithmParams())}`;
  }

  /** The request of one volume's product, or null when the volume lacks it (no such tilt). */
  private requestOf(f: TrailHost['l2'][number], product: number, id: string) {
    const info = this.host.siteInfo()!, sweep = this.host.sweepFor(f.meta!, product);
    if (sweep === null) return null;
    const p = this.host.algorithmParams(f.t);
    const params: L2BuildParams = { ...p, envIsotherms: hailEnvironment(product, p.isothermAuto, { lon: info.lon, lat: info.lat, elevM: info.elevFt * 0.3048 }, f.t) };
    return { key: `${id}|${f.file.url}|${sweep}|${JSON.stringify(params)}`, sweep, params };
  }

  /** Volumes of the blend: the loop's (window 0) or those within the window ending at the volume shown. */
  private inWindow(t: number, shownT: number | null): boolean {
    const min = settings.num(S('Minutes'));
    return min <= 0 || (shownT !== null && t <= shownT && t > shownT - min * 60e3);
  }

  prepass(ctx: PrepassContext) {
    const info = this.host.siteInfo(), site = info?.id ?? '';
    if (site !== this.site) { this.freeAll(); this.site = site; }
    if (!this.on() || !info) { if (this.frames.size || this.target) this.freeAll(); return; }
    const product = this.product(), id = this.identity(product), now = performance.now();
    // Every complete volume of the loop is requested (newest first), so moving the window needs no new requests.
    const volumes = this.host.l2.filter((f) => !f.file.live && f.meta).map((f) => ({ f, q: this.requestOf(f, product, id) }));
    const want = new Map(volumes.filter((v) => v.q).map((v) => [v.f.file.url, v.q!.key]));
    for (const [url, fr] of this.frames) if (want.get(url) !== fr.key || (fr.error && now - fr.failedAt! > RETRY_MS)) this.drop(url, fr);
    let inFlight = [...this.frames.values()].filter((x) => x.pending).length;
    for (const { f, q } of [...volumes].reverse()) {
      if (inFlight >= MAX_IN_FLIGHT) break;
      if (q && !this.frames.has(f.file.url)) { this.request(f, q, product); inFlight++; }
    }
    const shownT = this.host.shownScan()?.t ?? null;
    const ready = volumes.map((v) => this.frames.get(v.f.file.url)).filter((fr): fr is Frame => !!fr?.src && this.inWindow(fr.t, shownT)).sort((a, b) => a.t - b.t);
    if (!ready.length) { this.dropTarget(); return; }
    const key = JSON.stringify([id, ready.map((fr) => fr.key)]);
    if (this.target?.key !== key) this.rebuild(ctx, ready, key, product);
  }

  private request(f: TrailHost['l2'][number], q: { key: string; sweep: number; params: L2BuildParams }, product: number) {
    const gen = this.gen, url = f.file.url, args = { url, live: false, chunks: f.file.chunks, sweep: q.sweep, product, params: q.params };
    const fr: Frame = { key: q.key, url, t: f.t, args, pending: true };
    this.frames.set(url, fr);
    pool.for('radar-trail').run('l2.product', args, url).then((res) => {
      fr.pending = false;
      if (gen !== this.gen || this.frames.get(url) !== fr) return; // another site, or no longer wanted under this key
      if (!res.sweep) { fr.error = 'product unavailable'; fr.failedAt = performance.now(); return; }
      fr.sweep = { ...uploadSweep(this.r, res.sweep, 'radar-trail'), elevation: res.sweep.elevation };
      fr.src = this.blend.source(fr.sweep);
      if (res.meta?.volumeTimeMs) fr.t = res.meta.volumeTimeMs;
    }, (e) => {
      fr.pending = false;
      if (gen === this.gen && this.frames.get(url) === fr) { fr.error = (e as Error).message; fr.failedAt = performance.now(); }
    });
  }

  private rebuild(ctx: PrepassContext, ready: Frame[], key: string, product: number) {
    const newest = ready[ready.length - 1].sweep!, firstKm = newest.firstKm, gateKm = newest.gateKm;
    const gates = Math.max(...ready.map((fr) => Math.round((fr.sweep!.maxRangeKm - firstKm) / gateKm)));
    let tex = this.target?.tex;
    if (!tex || this.target!.sweep.gates !== gates) { tex?.destroy(); tex = this.r.gpu.renderTarget(gates, TRAIL_ROWS, 'r8unorm', 1, 'radar-trail'); }
    this.blend.encode(ctx, tex, { firstKm, gateKm }, ready.map((fr) => fr.src!));
    const sweep: SweepTex = { tex, firstKm, gateKm, gates, rows: TRAIL_ROWS, az0: AZ_BIN0, spacing: 0.5, radials: AZ_BINS, maxRangeKm: firstKm + gates * gateKm };
    const label = product === 0 ? `${TRAIL_NAMES[0]} ${newest.elevation.toFixed(1)}°` : TRAIL_NAMES[product];
    this.target = { tex, sweep, key, product, elevation: newest.elevation, from: ready[0].t, to: ready[ready.length - 1].t, n: ready.length, label, inputs: ready.map((fr) => ({ args: fr.args, geom: fr.sweep! })) };
  }

  private lut(product: number): Lut {
    const p = L2[product], name = settings.str(L2_PALETTE_KEYS[product]), key = `${name}|${p.low}|${p.high}|${p.reserve}`;
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low: p.low, high: p.high, reserve: p.reserve, showRF: p.reserve, topCode: 255 }); this.luts.set(key, l); }
    return l;
  }

  draw(ctx: DrawContext, site: { lon: number; lat: number; elevFt: number }) {
    const t = this.target;
    if (ctx.probe || !t || !this.on()) return;
    (this.radar ??= new RadarDraw(this.r)).draw(ctx, {
      site: { lon: site.lon, lat: site.lat, heightKm: (site.elevFt * 0.3048) / 1000 }, elevation: t.elevation, a: t.sweep, b: null, w: 0, wipe: -1, progress: 1,
      alpha: settings.num(S('Opacity')) / 100, smoothing: settings.bool('settings.nexradSmoothing'), tilt3D: settings.bool('settings.nexrad3DTilt'),
      exaggeration: settings.num('settings.nexrad3DTiltExaggeration'), shadow: false, azOffset: 0, lut: this.lut(t.product),
    });
  }

  /** Legend of the trail drawn now, naming the span and number of volumes it is the maximum of. */
  legend(): LegendSpec | null {
    const t = this.target;
    if (!t || !this.on()) return null;
    const p = L2[t.product];
    return { id: 'nexrad-trail', palette: getPalette(settings.str(L2_PALETTE_KEYS[t.product])), low: p.low, high: p.high, unit: p.unit, reserve: p.reserve, lut: this.lut(t.product),
      note: `${t.label}: max over ${hm(t.from)}–${hm(t.to)}Z (${t.n} volume${t.n === 1 ? '' : 's'})` };
  }

  private drop(url: string, fr: Frame) { fr.sweep?.tex.destroy(); fr.src?.ubuf.destroy(); this.frames.delete(url); }
  private dropTarget() { this.target?.tex.destroy(); this.target = null; }
  /** Drops every frame and the blend; results still in flight are discarded. */
  freeAll() {
    this.gen++;
    for (const [url, fr] of [...this.frames]) this.drop(url, fr);
    this.dropTarget();
  }
}
