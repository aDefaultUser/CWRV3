// Globe base layer: Web Mercator tile quadtree with public imagery (NASA GIBS Blue Marble shaded relief +
// bathymetry, max level 8) and public elevation (AWS Terrain Tiles, Terrarium encoding) for hypsometric tint,
// shaded relief, ocean masking and lat/lon lines. Public substitutes for the vendor-hosted BMNG/NAIP/WELD/NED
// buckets (60).
import type { Renderer, DrawContext, Drawable } from './renderer';
import { lonLatToXYZ } from './camera';
import { bakeLut } from './palette';
import { getPalette } from '../palettes/library';
import { generateLayerMips, mipLevels } from './mips';

export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`;
export const TERRAIN_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_MAX = 8, TER_MAX = 11, SLOTS = 256, MAX_TILES = 600;

class TileCache {
  tex: GPUTexture;
  /** Land elevation range per loaded slot (terrain cache only, for dynamic hypsometric tinting). */
  ranges = new Map<number, [number, number]>();
  private slots = new Map<string, { slot: number; used: number }>();
  private free: number[] = [];
  private loading = new Set<string>();
  private failed = new Set<string>();
  private queue: { key: string; z: number; x: number; y: number; pri: number }[] = [];
  private active = 0;
  loaded = 0;
  /**
   * `elevation`: Terrarium height tiles, a single level (encoded heights are never averaged); otherwise colour imagery
   * with GPU-generated mip levels for minified and oblique views.
   */
  constructor(private r: Renderer, private url: (z: number, x: number, y: number) => string, readonly maxZ: number, private onLoad: () => void, private elevation = false) {
    this.tex = r.gpu.device.createTexture({
      size: [256, 256, SLOTS], format: 'rgba8unorm', mipLevelCount: elevation ? 1 : mipLevels(256),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | (elevation ? 0 : GPUTextureUsage.STORAGE_BINDING),
    });
    for (let i = SLOTS - 1; i >= 0; i--) this.free.push(i);
  }
  /** Returns [slot, z, x, y] of the best available ancestor (requests the tile itself). */
  lookup(z: number, x: number, y: number, frame: number, pri: number): [number, number, number, number] | null {
    const zz = Math.min(z, this.maxZ);
    const sx = x >> (z - zz), sy = y >> (z - zz);
    for (let k = zz; k >= 0; k--) {
      const key = `${k}/${sx >> (zz - k)}/${sy >> (zz - k)}`;
      const e = this.slots.get(key);
      if (k === zz && !e) this.request(key, k, sx >> (zz - k), sy >> (zz - k), pri);
      if (e) { e.used = frame; return [e.slot, k, sx >> (zz - k), sy >> (zz - k)]; }
    }
    return null;
  }
  private request(key: string, z: number, x: number, y: number, pri: number) {
    if (this.loading.has(key) || this.failed.has(key)) return;
    if (this.queue.some((q) => q.key === key)) return;
    this.queue.push({ key, z, x, y, pri });
  }
  pump(frame: number) {
    this.queue.sort((a, b) => a.pri - b.pri);
    while (this.active < 8 && this.queue.length) {
      const q = this.queue.shift()!;
      this.loading.add(q.key);
      this.active++;
      fetch(this.url(q.z, q.x, q.y)).then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        let slot = this.free.pop();
        if (slot === undefined) {
          let oldest: string | null = null, ou = Infinity;
          for (const [k, v] of this.slots) if (v.used < ou && v.used < frame - 2) { ou = v.used; oldest = k; }
          if (!oldest) { bmp.close(); return; }
          slot = this.slots.get(oldest)!.slot;
          this.slots.delete(oldest);
        }
        this.r.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: this.tex, origin: [0, 0, slot] }, [256, 256]);
        if (this.elevation) this.ranges.set(slot, terrariumRange(bmp));
        else generateLayerMips(this.r.gpu.device, this.tex, slot); // a reused slot gets the new tile's levels
        bmp.close();
        this.slots.set(q.key, { slot, used: frame });
        this.loaded++;
        this.onLoad();
      }).catch(() => this.failed.add(q.key)).finally(() => { this.loading.delete(q.key); this.active--; });
    }
    if (this.queue.length > 200) this.queue.length = 200;
  }
}

/** Min/max land elevation (m, ≥ 0) of a Terrarium tile, sampled every 4th pixel. */
function terrariumRange(bmp: ImageBitmap): [number, number] {
  const c = new OffscreenCanvas(64, 64), g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = false;
  g.drawImage(bmp, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < d.length; i += 4) { const e = d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; if (e > 0) { if (e < lo) lo = e; if (e > hi) hi = e; } }
  return hi >= lo ? [lo, hi] : [0, 0];
}

export interface TileSettings {
  imagery: boolean; terrain: boolean; tint: boolean; shading: number; ocean: boolean; oceanMode: number; oceanColor: number[];
  grid: boolean; gridColor: number[]; gridAlpha: number; gridWidth: number; gridDensity: number; gridOceanOnly: boolean; gridSecondary: boolean; gridAdd: boolean;
  brightness: number; contrast: number; saturation: number; height3D: number; surface3D: boolean;
  lightAz: number; lightZen: number; coastMode: number; coastColor: number[]; coastExp: number; gloss: number; highlight: number; waterCoef: number; shadeDepth: number; shadeBright: number;
  density: number; mapBg: number[]; tintPalette: string; enabled: boolean;
  fixedLight: boolean; alpha: number; tintBeforeLighting: boolean; dynamicRange: boolean; rescaleSpeed: number; oceanOnlyHeight: number;
  waterToLight: 0 | 1 | 2; performanceWater: boolean; lightWave: boolean; motionReduce: number;
  specExp: number; specIntensity: number; hdr: boolean; hdrWhite: number;
  /** Imagery sampler anisotropy, 1–16 (anisotropyOf). */
  anisotropy: number;
}

/** Visible-elevation range smoothing for dynamic hypsometric tinting: exponential approach at `speed` (1/s). */
export function rescaleRange(cur: [number, number] | null, target: [number, number], dtSec: number, speed: number): [number, number] {
  if (!cur) return target;
  const k = 1 - Math.exp(-Math.max(0, speed) * 0.1 * dtSec);
  return [cur[0] + (target[0] - cur[0]) * k, cur[1] + (target[1] - cur[1]) * k];
}

export class TileLayer implements Drawable {
  readonly id = 'basemap';
  img: TileCache; ter: TileCache;
  private tileBuf: GPUBuffer;
  private ubuf: GPUBuffer;
  private bg: GPUBindGroup | null = null;
  private imgSampler: GPUSampler | null = null;
  private imgAnisotropy = 0;
  private hypso: GPUTexture | null = null;
  private hypsoName = '';
  private frameNo = 0;
  private n = 0;
  private lastCam = '';
  private range: [number, number] | null = null;
  private lastDraw = 0;
  s!: TileSettings;
  onChange: () => void = () => {};
  stats = { tiles: 0 };

  constructor(private r: Renderer) {
    this.img = new TileCache(r, IMAGERY_URL, IMG_MAX, () => this.onChange());
    this.ter = new TileCache(r, TERRAIN_URL, TER_MAX, () => this.onChange(), true);
    this.tileBuf = r.gpu.device.createBuffer({ size: MAX_TILES * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.ubuf = r.gpu.device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private ensureHypso() {
    if (this.hypso && this.hypsoName === this.s.tintPalette) return;
    const p = getPalette(this.s.tintPalette);
    const lut = bakeLut(p, { low: -6000, high: 5000 });
    this.hypso?.destroy();
    this.hypso = this.r.gpu.texture2D(1024, p.frames.length, 'rgba8unorm', lut);
    this.hypsoName = this.s.tintPalette;
    this.bg = null;
  }

  /** Selects visible tiles (quadtree with screen-space size threshold). */
  private select(): number[][] {
    const cam = this.r.camera;
    const out: number[][] = [];
    // Reduced density while the camera moves (motion reduce amount in %), full density once it settles.
    const c = this.r.camera.cur, key = `${c.lon},${c.lat},${c.z},${c.tilt},${c.swivel}`;
    const moving = key !== this.lastCam; this.lastCam = key;
    const thresh = this.s.density * 1.15 * (moving ? 1 + this.s.motionReduce / 100 : 1);
    const look = cam.cur;
    const visit = (z: number, x: number, y: number) => {
      if (out.length >= MAX_TILES) return;
      const n = 2 ** z;
      const lonA = (x / n) * 360 - 180, lonB = ((x + 1) / n) * 360 - 180;
      const latA = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
      const latB = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
      let anyFront = false, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, cnt = 0;
      // A 3×3 grid misses large tiles whose visible part lies between samples (zoomed-in views), so the tile point
      // nearest the look-at point is sampled too, and the tile holding the look-at point is never culled.
      const nearLon = Math.max(lonA, Math.min(lonB, look.lon)), nearLat = Math.max(latB, Math.min(latA, look.lat));
      const holdsLook = nearLon === look.lon && nearLat === look.lat;
      for (let i = 0; i <= 9; i++) {
        const lon = i < 9 ? lonA + ((lonB - lonA) * (i % 3)) / 2 : nearLon, lat = i < 9 ? latA + ((latB - latA) * Math.floor(i / 3)) / 2 : nearLat;
        const [px, py, front] = cam.project(lonLatToXYZ(lon, lat));
        if (!front) continue;
        anyFront = true; cnt++;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      if (z >= 2 && !holdsLook && (!anyFront || maxX < -50 || minX > cam.width + 50 || maxY < -50 || minY > cam.height + 50)) return;
      const size = Math.max(maxX - minX, maxY - minY) * this.r.gpu.dpr;
      if (z < 2 || (z < TER_MAX + 1 && ((cnt >= 1 && size > thresh * 2) || (holdsLook && cnt < 10)))) {
        for (let k = 0; k < 4; k++) visit(z + 1, x * 2 + (k & 1), y * 2 + (k >> 1));
        return;
      }
      out.push([z, x, y]);
    };
    visit(0, 0, 0);
    return out;
  }

  /** Land elevation range over the drawn terrain tiles (null until any tile is measured). */
  private visibleRange(slots: number[]): [number, number] | null {
    let lo = Infinity, hi = -Infinity;
    for (const k of slots) { const r = this.ter.ranges.get(k); if (r && r[1] > 0) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); } }
    return hi > lo ? [lo, hi] : null;
  }

  draw(ctx: DrawContext) {
    if (!this.s?.enabled || ctx.probe) return;
    this.ensureHypso();
    this.frameNo++;
    const tiles = this.select();
    const f = new Float32Array(tiles.length * 16);
    const slots: number[] = [];
    const cam = this.r.camera;
    tiles.forEach(([z, x, y], i) => {
      const pri = z * 10 + i * 0.001;
      const im = this.s.imagery ? this.img.lookup(z, x, y, this.frameNo, pri) : null;
      const te = this.s.terrain || this.s.ocean ? this.ter.lookup(z, x, y, this.frameNo, pri) : null;
      const sub = (a: [number, number, number, number] | null) => {
        if (!a) return [-1, 0, 0, 1];
        const [slot, az] = a; const dz = z - az; const k = 2 ** dz;
        return [slot, (x % k) / k, (y % k) / k, 1 / k];
      };
      const I = sub(im), T = sub(te);
      if (te) slots.push(te[0]);
      f.set([z, x, y, I[0], I[1], I[2], I[3], 0, T[0], 0, 0, 0, T[1], T[2], T[3], 0], i * 16);
    });
    void cam;
    this.n = tiles.length;
    this.stats.tiles = tiles.length;
    const d = this.r.gpu.device;
    d.queue.writeBuffer(this.tileBuf, 0, f);
    const s = this.s;
    const u = new Float32Array(52);
    u.set([s.oceanColor[0] / 255, s.oceanColor[1] / 255, s.oceanColor[2] / 255, s.ocean ? s.oceanMode : -1], 0);
    u.set([s.gridColor[0] / 255, s.gridColor[1] / 255, s.gridColor[2] / 255, s.grid ? s.gridAlpha : 0], 4);
    u.set([150 / s.gridDensity, s.gridWidth, s.gridOceanOnly ? 1 : 0, s.gridSecondary ? 1 : 0], 8);
    u.set([s.brightness, s.contrast, s.saturation, s.imagery ? 1 : 0], 12);
    u.set([s.tint ? 1 : 0, s.shading, s.terrain ? 1 : 0, s.surface3D ? s.height3D : 0], 16);
    u.set([s.lightAz, s.lightZen, s.gridAdd ? 1 : 0, s.coastMode], 20);
    u.set([s.coastColor[0] / 255, s.coastColor[1] / 255, s.coastColor[2] / 255, s.coastExp], 24);
    u.set([s.gloss, s.highlight, s.waterCoef, (s.mapBg[0] + s.mapBg[1] + s.mapBg[2]) / 765], 28);
    // Hillshade range (TFrmTerrain depth / highlight sliders): darkest and brightest multipliers.
    u.set([1 - 0.9 * (s.shadeDepth / 900), 1 + 0.9 * (s.shadeBright / 450), s.fixedLight ? 1 : 0, Math.min(1, Math.max(0, s.alpha))], 32);
    const now = performance.now(), dt = this.lastDraw ? (now - this.lastDraw) / 1000 : 0; this.lastDraw = now;
    const tr = s.dynamicRange ? this.visibleRange(slots) : null;
    this.range = tr ? rescaleRange(this.range, tr, dt, s.rescaleSpeed) : null;
    u.set([this.range ? this.range[0] : -6000, this.range ? this.range[1] : 5000, s.tintBeforeLighting ? 1 : 0, s.oceanOnlyHeight], 36);
    u.set([s.waterToLight, s.performanceWater ? 1 : 0, s.lightWave ? 1 : 0, 0], 40);
    u.set([s.specExp, s.specIntensity, s.hdr ? 1 : 0, Math.max(1, s.hdrWhite)], 44);
    u.set([s.mapBg[0] / 255, s.mapBg[1] / 255, s.mapBg[2] / 255, 0], 48);
    d.queue.writeBuffer(this.ubuf, 0, u);
    if (this.imgAnisotropy !== s.anisotropy) {
      // Anisotropy needs linear min, mag and mip filters. A new sampler only rebuilds the bind group.
      this.imgSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: s.anisotropy, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      this.imgAnisotropy = s.anisotropy;
      this.bg = null;
    }
    if (!this.bg) this.bg = d.createBindGroup({ layout: this.r.layouts.tiles, entries: [
      { binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: { buffer: this.tileBuf } },
      { binding: 2, resource: this.img.tex.createView({ dimension: '2d-array' }) }, { binding: 3, resource: this.ter.tex.createView({ dimension: '2d-array' }) },
      { binding: 4, resource: this.r.gpu.samplers.linear }, { binding: 5, resource: this.hypso!.createView() }, { binding: 6, resource: this.imgSampler! }] });
    this.img.pump(this.frameNo); this.ter.pump(this.frameNo);
    ctx.pass.setPipeline(this.r.pipes.tiles);
    ctx.pass.setBindGroup(1, this.bg);
    ctx.pass.draw(16 * 16 * 6, this.n);
  }
}
