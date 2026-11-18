// Basic → Lightning: public GOES-19 GLM L2 LCFA flashes, colored by age through the strike palette, fading at
// "minutes visible", optional energy filter/scaling, flash-count box. Every strike is the vendored Tabler "bolt"
// SVG (public/assets/icons/tabler/bolt.svg, MIT) as a tinted sprite with a dark halo; glow mode adds a soft additive
// backdrop under each bolt. 3D mode adds vertical strike lines above the bolts.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer, NOT_AVAILABLE } from './base';
import { timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { listS3 } from '../data/net';
import { pool } from '../workers/pool';
import { PointSet, LineSet, SpriteAtlas, SpriteSet, SHAPE, type PointSpec, type LineStyle, type SpriteSpec } from '../render/prims';
import { evalPalette } from '../render/palette';
import { getPalette } from '../palettes/library';
import { lonLatToXYZ } from '../render/camera';
import { goesAt } from './satellite';

/** GLM of the GOES-East satellite at `t`. */
const bucketAt = (t: number) => `https://noaa-${goesAt('goes19', t)}.s3.amazonaws.com`;
const BOLT_SVG = '/assets/icons/tabler/bolt.svg';
/** Age buckets for bolt tints (one atlas sprite per bucket and variant). */
const AGE_BUCKETS = 16;
/** Raster size of a bolt sprite (CSS px; the atlas paints at 2×, the shader scales by the device pixel ratio). */
const BOLT_PX = 32;
/** Glow backdrop relative to the bolt: diameter and alpha factors. */
const GLOW_SIZE = 1.8, GLOW_ALPHA = 0.55;

/** Drawable geometry of the vendored bolt icon: its outlined paths in the SVG's 24-unit view box. */
interface BoltIcon { paths: Path2D[]; strokeWidth: number; viewBox: number }
async function loadBoltIcon(url = BOLT_SVG): Promise<BoltIcon> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
  const svg = doc.documentElement;
  const paths = [...doc.querySelectorAll('path')].filter((p) => p.getAttribute('stroke') !== 'none').map((p) => new Path2D(p.getAttribute('d') ?? ''));
  if (!paths.length) throw new Error(`${url}: no drawable path`);
  return { paths, strokeWidth: Number(svg.getAttribute('stroke-width') ?? 2), viewBox: Number((svg.getAttribute('viewBox') ?? '0 0 24 24').split(/\s+/)[2]) || 24 };
}
interface Batch { key: string; lat: Float32Array; lon: Float32Array; energy: Float32Array; timeMs: Float64Array }

export class LightningLayer extends MapLayer {
  readonly id = 'lightning';
  readonly archive = 'window';
  readonly title = 'Lightning (GLM)';
  private pts: PointSet;
  private strikes: LineSet;
  private boltAtlas: SpriteAtlas;
  private bolts: SpriteSet;
  private boltIcon: BoltIcon | null = null;
  private atlasKey = '';
  /** Bolt sprites drawn (the SVG loaded); otherwise procedural bolt points stand in. */
  private iconMode = false;
  /** Glow backdrop points under the bolts in the last rebuild. */
  private glowMode = false;
  private batches = new Map<string, Batch>();
  private loading = new Set<string>();
  private lastKey = '';
  newestMs = 0;
  /** Timeline epoch (mode and archive time) the batches belong to. */
  private epoch = timeline.epoch;
  visibleCount = 0;
  flashes: { lon: number; lat: number; t: number; e: number }[] = [];
  constructor(r: Renderer) {
    super(r); this.pts = new PointSet(r); this.strikes = new LineSet(r);
    this.boltAtlas = new SpriteAtlas(r); this.bolts = new SpriteSet(r, this.boltAtlas);
    loadBoltIcon().then((icon) => { this.boltIcon = icon; this.lastKey = ''; }, (e) => this.setStatus('error', `Lightning icon: ${(e as Error).message}`));
    // Any rendering option change rebuilds the icons and strike lines on the next tick.
    settings.on('settings.lightning', () => { this.lastKey = ''; });
  }
  enabled() { return settings.bool('layerState.LightningOn'); }

  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    const minutes = settings.num('settings.lightningRenderingMinutes');
    const from = timeline.loopStart - minutes * 60e3, to = timeline.loopEnd, epoch = timeline.epoch;
    if (epoch !== this.epoch) { this.epoch = epoch; this.batches.clear(); this.loading.clear(); this.newestMs = 0; this.lastKey = ''; }
    const BUCKET = bucketAt(to);
    const hours: number[] = [];
    for (let t = Math.floor(from / 3600e3) * 3600e3; t <= to; t += 3600e3) hours.push(t);
    const files: { key: string; t: number }[] = [];
    try {
      for (const h of hours) {
        const d = new Date(h);
        const doy = Math.floor((h - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400e3) + 1;
        const { objects } = await listS3(BUCKET, `GLM-L2-LCFA/${d.getUTCFullYear()}/${String(doy).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`, { maxPages: 3 });
        for (const o of objects) {
          const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/.exec(o.key);
          if (!m) continue;
          const t = Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 86400e3 + +m[3] * 3600e3 + +m[4] * 60e3 + +m[5] * 1000;
          if (t >= from && t <= to) files.push({ key: `${BUCKET}/${o.key}`, t });
        }
      }
    } catch (e) { this.setStatus('error', `GLM listing failed: ${(e as Error).message}`); return; }
    if (epoch !== timeline.epoch) return; // listed for another mode or archive time
    if (!files.length && timeline.mode === 'archive') { this.setStatus('unavailable', NOT_AVAILABLE); return; }
    files.sort((a, b) => b.t - a.t);
    const wanted = files.filter((f) => !this.batches.has(f.key) && !this.loading.has(f.key));
    // Newest first, in groups of 15 files per worker call.
    for (let i = 0; i < wanted.length; i += 15) {
      const group = wanted.slice(i, i + 15);
      group.forEach((g) => this.loading.add(g.key));
      pool.for(this.id).run('glm', { urls: group.map((g) => g.key) }).then((res) => {
        if (epoch !== timeline.epoch) return; // requested for another mode or archive time
        const key = group.map((g) => g.key).join('|');
        this.batches.set(key, { key, lat: res.lat, lon: res.lon, energy: res.energy, timeMs: res.timeMs });
        for (const g of group) { this.loading.delete(g.key); this.batches.set(g.key, { key: g.key, lat: new Float32Array(0), lon: new Float32Array(0), energy: new Float32Array(0), timeMs: new Float64Array(0) }); }
        this.newestMs = Math.max(this.newestMs, res.newestMs);
        this.lastKey = '';
        this.setStatus('ready', `GLM: ${this.loading.size ? `loading ${this.loading.size} files` : 'current'}`, { newestMs: this.newestMs });
      }, (e) => { if (epoch !== timeline.epoch) return; group.forEach((g) => this.loading.delete(g.key)); this.setStatus('error', `GLM: ${e.message}`); });
    }
    // Drop batches outside the window (older, or newer after the archive time moved back).
    for (const [k, b] of this.batches) if (b.timeMs.length && (b.timeMs[b.timeMs.length - 1] < from - 600e3 || b.timeMs[0] > to + 600e3)) this.batches.delete(k);
    if (wanted.length) this.setStatus('loading', `GLM: loading ${wanted.length} files`);
  }

  tick(t: number, now: number) {
    if (!this.enabled()) return;
    const minutes = settings.num('settings.lightningRenderingMinutes');
    const key = `${Math.round(t / 1000)}|${minutes}|${settings.num('settings.lightningRenderingEnergyFilterValue')}|${settings.bool('settings.lightningRenderingMinEnergyFilter')}`;
    const animate = settings.bool('settings.lightningRenderingFlashEffect') || settings.bool('settings.lightningRenderingTwinkle');
    if (key === this.lastKey && !animate) return;
    if (key !== this.lastKey) this.rebuild(t, minutes);
    this.lastKey = key;
    if (animate) {
      for (let i = 0; i < this.flashes.length; i++) {
        const f = this.flashes[i];
        const age = (t - f.t) / 1000;
        let a = this.baseAlpha[i];
        if (settings.bool('settings.lightningRenderingFlashEffect') && age < 20) a = Math.min(1, a + (1 - age / 20) * (0.5 + 0.5 * Math.sin(now / 60)));
        if (settings.bool('settings.lightningRenderingTwinkle')) a *= 0.75 + 0.25 * Math.sin(now / 90 + i);
        if (this.iconMode) this.bolts.setAlpha(i, a);
        if (!this.iconMode || this.glowMode) this.pts.setAlpha(i, this.iconMode ? a * GLOW_ALPHA : a);
      }
      if (this.iconMode) this.bolts.flushAlpha();
      if (!this.iconMode || this.glowMode) this.pts.flushAlpha();
    }
  }

  private baseAlpha = new Float32Array(0);
  private rebuild(t: number, minutes: number) {
    const palName = settings.str('settings.lightningRenderingPalette');
    const pal = getPalette(palName);
    const minE = settings.bool('settings.lightningRenderingMinEnergyFilter') ? settings.num('settings.lightningRenderingEnergyFilterValue') * 1e-15 : 0;
    const glow = settings.bool('settings.lightningRenderingGlow');
    const scaleE = settings.bool('settings.lightningRenderingScaleByEnergy');
    const scaleA = settings.bool('settings.lightningRenderingScaleByAlpha');
    const alpha = settings.num('settings.lightningRenderingAlpha');
    const size = 10 + settings.num('settings.lightningRenderingBoltSize') * 500; // sprite CSS px: 20 at the default 0.02
    const variety = Math.max(1, Math.round(settings.num('settings.lightningRenderingIconIdx')));
    const additive = settings.bool('settings.lightningIconAdditive');
    this.iconMode = !!this.boltIcon;
    this.glowMode = glow && this.iconMode;
    if (this.iconMode && this.atlasKey !== `${palName}|${variety}`) { this.boltAtlas.reset(); this.atlasKey = `${palName}|${variety}`; }
    const pts: PointSpec[] = [], sprites: SpriteSpec[] = [], base: number[] = [];
    this.flashes = [];
    for (const b of this.batches.values()) {
      for (let i = 0; i < b.lat.length; i++) {
        const ft = b.timeMs[i];
        if (ft > t || ft < t - minutes * 60e3) continue;
        if (b.energy[i] < minE) continue;
        const ageMin = (t - ft) / 60e3;
        const fade = 1 - ageMin / minutes;
        const s = scaleE ? size * (0.7 + 0.25 * Math.max(0, Math.log10(b.energy[i] / 1e-15 + 1) - 2)) : size;
        if (this.iconMode) {
          // Tint by age bucket; the palette alpha and fade go to the sprite alpha.
          const k = Math.min(AGE_BUCKETS - 1, Math.floor((ageMin / minutes) * AGE_BUCKETS));
          const c = evalPalette(pal.frames[0], ((k + 0.5) / AGE_BUCKETS) * minutes);
          const variant = variety > 1 ? Math.floor(Math.abs(Math.sin(b.lon[i] * 12.9898 + b.lat[i] * 78.233) * 43758.5453) % 1 * variety) : 0;
          const key = this.boltSprite(variant, variety, c);
          const a = (evalPalette(pal.frames[0], ageMin)[3] / 255) * (scaleA ? fade : 1) * Math.min(1, alpha * 2.2);
          sprites.push({ lon: b.lon[i], lat: b.lat[i], key, w: s, h: s, alpha: a });
          if (glow) pts.push({ lon: b.lon[i], lat: b.lat[i], size: s * GLOW_SIZE, color: [c[0], c[1], c[2], Math.round(a * GLOW_ALPHA * 255)], shape: SHAPE.dot, glow: 1.5, additive: true });
          base.push(a);
        } else {
          // Until the SVG has loaded (or if it fails), procedural bolt points stand in.
          const c = evalPalette(pal.frames[0], ageMin);
          const a = (c[3] / 255) * (scaleA ? fade : 1) * Math.min(1, alpha * 2.2);
          pts.push({ lon: b.lon[i], lat: b.lat[i], size: s, color: [c[0], c[1], c[2], Math.round(a * 255)], shape: SHAPE.bolt, glow: glow ? 1.5 : 0, rot: 0.35, additive });
          base.push(a);
        }
        this.flashes.push({ lon: b.lon[i], lat: b.lat[i], t: ft, e: b.energy[i] });
      }
    }
    if (this.iconMode) { this.boltAtlas.flush(); this.bolts.additive = additive; }
    this.bolts.setSprites(sprites);
    this.pts.setPoints(pts);
    this.baseAlpha = Float32Array.from(base);
    this.buildStrikeLines(t, minutes, pal);
  }

  /**
   * Atlas sprite for one bolt variant and tint: the SVG's own paths, stroke width, round caps and joins, filled and
   * stroked in the tint over a dark halo. Variants ("strike icon variety") are mirrored / slightly rotated copies.
   */
  private boltSprite(variant: number, variety: number, c: number[]): string {
    const key = `${variant}|${c[0]},${c[1]},${c[2]}`;
    if (this.boltAtlas.get(key)) return key;
    const icon = this.boltIcon!;
    const angle = variety > 1 ? ((variant / (variety - 1)) - 0.5) * 0.5 : 0;
    const mirror = variant % 2 === 1;
    this.boltAtlas.draw(key, BOLT_PX, BOLT_PX, (g, k) => {
      const px = BOLT_PX * k;
      g.translate(px / 2, px / 2); g.rotate(angle); if (mirror) g.scale(-1, 1);
      // The bolt spans ~18 of the 24 view-box units; with its halo it fills the sprite.
      const u = px / (icon.viewBox * 0.92);
      g.scale(u, u); g.translate(-icon.viewBox / 2, -icon.viewBox / 2);
      g.lineJoin = 'round'; g.lineCap = 'round';
      const tint = `rgb(${c[0]},${c[1]},${c[2]})`;
      for (const p of icon.paths) {
        g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = icon.strokeWidth + 2.2; g.stroke(p);
        g.fillStyle = tint; g.fill(p);
        g.strokeStyle = tint; g.lineWidth = icon.strokeWidth; g.stroke(p);
      }
    });
    return key;
  }

  /**
   * 3D strike lines (TFrmGLMTiltStrikes): a vertical line above each flash, coloured by age, with a dashed "texture"
   * that scrolls upward (animate) over an optional stationary copy (underneath). Height may scale with the age fade.
   * Scale: height km = setting / 4, dash period px = repeat × 10, scroll px/s = speed × 15. Bolt markers stay at the
   * flash location at the foot of each line.
   */
  private buildStrikeLines(t: number, minutes: number, pal: ReturnType<typeof getPalette>) {
    if (!settings.bool('settings.lightningRendering3D') || !this.flashes.length) { this.strikes.setSegments([]); return; }
    const BUCKETS = 16;
    const width = settings.num('settings.lightningRendering3DWidth'), dash = settings.num('settings.lightningRendering3DRepeat') * 10;
    const speed = settings.bool('settings.lightningRendering3DAnimate') ? settings.num('settings.lightningRendering3DSpeed') * 15 : 0;
    const additive = settings.bool('settings.lightningRendering3DAdditive'), under = settings.bool('settings.lightningRendering3DUnderneath');
    const scaleA = settings.bool('settings.lightningRendering3DScaleAlpha');
    const alpha = Math.min(1, settings.num('settings.lightningRenderingAlpha') * 2.2);
    const styles: LineStyle[] = [];
    for (let k = 0; k < BUCKETS; k++) {
      const c = evalPalette(pal.frames[0], ((k + 0.5) / BUCKETS) * minutes);
      const a = Math.round(c[3] * alpha * (1 - (k + 0.5) / BUCKETS));
      styles.push({ color: [c[0], c[1], c[2], a], width, dash, dashMode: 1, dashSpeed: -speed, additive });
      styles.push({ color: [c[0], c[1], c[2], Math.round(a * 0.45)], width, dash, dashMode: 1, dashSpeed: 0, additive, visible: under });
    }
    this.strikes.setStyles(styles);
    const hR = settings.num('settings.lightningRendering3DHeight') / 4 / 6371;
    const segs: number[] = [];
    for (const f of this.flashes) {
      const age = Math.min(0.999, Math.max(0, (t - f.t) / (minutes * 60e3)));
      const k = Math.floor(age * BUCKETS);
      const h = hR * (scaleA ? 1 - age : 1);
      const a = lonLatToXYZ(f.lon, f.lat, 1.000002), b = lonLatToXYZ(f.lon, f.lat, 1 + h);
      if (under) segs.push(...a, ...b, k * 2 + 1);
      segs.push(...a, ...b, k * 2);
    }
    this.strikes.setSegments(segs);
  }

  /** Flashes visible in the current view (for the "N Strikes" box). */
  countInView(): number {
    let n = 0;
    const cam = this.r.camera;
    for (const f of this.flashes) {
      const [x, y, front] = cam.project(lonLatToXYZ(f.lon, f.lat));
      if (front && x >= 0 && y >= 0 && x <= cam.width && y <= cam.height) n++;
    }
    this.visibleCount = n;
    return n;
  }

  /** Nearest flash to a screen point (rollover info). */
  nearest(x: number, y: number) {
    let best: (typeof this.flashes)[number] | null = null, bd = 10;
    for (const f of this.flashes) {
      const [px, py, front] = this.r.camera.project(lonLatToXYZ(f.lon, f.lat));
      if (!front) continue;
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  draw(ctx: DrawContext) { if (ctx.probe) return; this.strikes.draw(ctx); this.pts.draw(ctx); this.bolts.draw(ctx); }
}
