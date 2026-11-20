// Globe base layer: Web Mercator tile quadtree with public imagery (NASA GIBS Blue Marble shaded relief +
// bathymetry, max level 8) and public elevation (AWS Terrain Tiles, Terrarium encoding) for hypsometric tint,
// shaded relief, ocean masking and lat/lon lines. Public substitutes for the vendor-hosted BMNG/NAIP/WELD/NED
// buckets (60).
import type { Renderer, DrawContext, Drawable } from './renderer';
import { lonLatToXYZ, type Camera } from './camera';
import { bakeLut } from './palette';
import { getPalette } from '../palettes/library';
import { generateLayerMips, mipLevels } from './mips';

export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`;
export const TERRAIN_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_MAX = 8, TER_MAX = 11, SLOTS = 256, MAX_TILES = 600;
/** Levels 0–2 (21 tiles) cover the globe and are never evicted: the last fallback of every tile. */
const KEEP_Z = 2;
const FAIL_RETRY_MS = 30_000;
/** A tile loaded when every slot had become pinned is dropped and not requested again for this long. */
const FULL_RETRY_MS = 2_000;

export class TileCache {
  tex: GPUTexture;
  /** Land elevation range per loaded slot (terrain cache only, for dynamic hypsometric tinting). */
  ranges = new Map<number, [number, number]>();
  private slots = new Map<string, { slot: number; used: number; z: number }>();
  private free: number[] = [];
  private loading = new Set<string>();
  /** Failed or dropped loads (time they may be requested again): never retried in a tight loop. */
  private retryAt = new Map<string, number>();
  private queue: { key: string; z: number; x: number; y: number; pri: number }[] = [];
  private active = 0;
  /** Newest frame number seen (eviction never takes a slot drawn in the last frames). */
  private frame = 0;
  private coarseRequested = false;
  loaded = 0;
  /** Tiles fetched and decoded but dropped because no slot could be freed (should stay near zero). */
  dropped = 0;
  /**
   * `elevation`: Terrarium height tiles, a single level (encoded heights are never averaged); otherwise colour imagery
   * with GPU-generated mip levels for minified and oblique views.
   */
  constructor(private r: Renderer, private url: (z: number, x: number, y: number) => string, readonly maxZ: number, private onLoad: () => void, private elevation = false) {
    const levels = elevation ? 1 : mipLevels(256);
    this.tex = r.gpu.device.createTexture({
      size: [256, 256, SLOTS], format: 'rgba8unorm', mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | (elevation ? 0 : GPUTextureUsage.STORAGE_BINDING),
    });
    for (let i = SLOTS - 1; i >= 0; i--) this.free.push(i);
    let bytes = 0;
    for (let l = 0; l < levels; l++) bytes += (256 >> l) ** 2 * 4 * SLOTS;
    r.gpu.trackTexture(this.tex, bytes, 'basemap');
  }
  /**
   * Returns [slot, z, x, y] of the best available tile for (z, x, y): the tile itself or its nearest loaded ancestor.
   * Only that drawn tile is marked as used (pinned while drawn): pinning every ancestor of a wide view would pin the
   * whole atlas and leave no slot for the tiles it waits for. A missing tile is requested together with its
   * fallback: the next coarser level below the best one loaded (or the always-kept coarse level), which loads
   * first, so a tile in view is never left without imagery.
   */
  lookup(z: number, x: number, y: number, frame: number, pri: number): [number, number, number, number] | null {
    this.frame = Math.max(this.frame, frame);
    const zz = Math.min(z, this.maxZ);
    const sx = x >> (z - zz), sy = y >> (z - zz);
    let best: [number, number, number, number] | null = null;
    for (let k = zz; k >= 0; k--) {
      const ax = sx >> (zz - k), ay = sy >> (zz - k);
      const e = this.slots.get(`${k}/${ax}/${ay}`);
      if (e) { e.used = frame; best = [e.slot, k, ax, ay]; break; }
    }
    if (!best || best[1] < zz) {
      this.request(zz, sx, sy, pri);
      const fallback = best ? best[1] + 1 : Math.min(zz, KEEP_Z);
      if (fallback < zz) this.request(fallback, sx >> (zz - fallback), sy >> (zz - fallback), fallback * 10 - 5);
    }
    return best;
  }
  private request(z: number, x: number, y: number, pri: number) {
    const key = `${z}/${x}/${y}`;
    if (this.loading.has(key) || this.slots.has(key)) return;
    if (Date.now() < (this.retryAt.get(key) ?? 0)) return;
    const q = this.queue.find((e) => e.key === key);
    if (q) { q.pri = Math.min(q.pri, pri); return; }
    this.queue.push({ key, z, x, y, pri });
  }
  pump(frame: number) {
    this.frame = Math.max(this.frame, frame);
    // The kept coarse levels are loaded first, once, so every tile has a fallback wherever the view goes.
    if (!this.coarseRequested) { this.coarseRequested = true; for (let k = 0; k <= Math.min(KEEP_Z, this.maxZ); k++) for (let i = 0; i < 4 ** k; i++) this.request(k, i % 2 ** k, Math.floor(i / 2 ** k), k * 10 - 9); }
    this.queue.sort((a, b) => a.pri - b.pri);
    // Fetch only what a slot is available for (free, or evictable now), less the loads already in flight: tiles
    // that would be dropped on arrival are not fetched and decoded again every frame.
    let room = this.free.length - this.active;
    for (const v of this.slots.values()) if (this.evictable(v)) room++;
    while (this.active < 8 && this.queue.length && room-- > 0) {
      const q = this.queue.shift()!;
      this.loading.add(q.key);
      this.active++;
      fetch(this.url(q.z, q.x, q.y)).then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        let slot = this.free.pop();
        if (slot === undefined) {
          // Least recently drawn tile that is not part of the kept coarse coverage and not drawn in the last frames.
          let oldest: string | null = null, ou = Infinity;
          for (const [k, v] of this.slots) if (this.evictable(v) && v.used < ou) { ou = v.used; oldest = k; }
          // The view pinned every slot while this tile loaded: drop it and back off instead of refetching each frame.
          if (!oldest) { bmp.close(); this.dropped++; this.retryAt.set(q.key, Date.now() + FULL_RETRY_MS); return; }
          slot = this.slots.get(oldest)!.slot;
          this.slots.delete(oldest);
        }
        const t0 = performance.now();
        this.r.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: this.tex, origin: [0, 0, slot] }, [256, 256]);
        this.r.gpu.recordUpload('basemap', 256 * 256 * 4, performance.now() - t0);
        if (this.elevation) this.ranges.set(slot, terrariumRange(bmp));
        else generateLayerMips(this.r.gpu.device, this.tex, slot); // a reused slot gets the new tile's levels
        bmp.close();
        this.slots.set(q.key, { slot, used: this.frame, z: q.z });
        this.retryAt.delete(q.key);
        this.loaded++;
        this.onLoad();
      }).catch(() => this.retryAt.set(q.key, Date.now() + FAIL_RETRY_MS)).finally(() => { this.loading.delete(q.key); this.active--; });
    }
    if (this.queue.length > 200) this.queue.length = 200;
  }
  /** Not part of the kept coarse coverage and not drawn in the last frames. */
  private evictable(v: { used: number; z: number }) { return v.z > KEEP_Z && v.used < this.frame - 2; }
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

/** Degrees between two longitudes the shorter way round. */
const lonGap = (a: number, b: number) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180);

/** Times a kept tile's quarters are tested again with their own, tighter caps (fewer hidden tiles kept). */
const CULL_DEPTH = 3;

/**
 * Planes [nx, ny, nz, d] (unit normal, inside where n·p + d ≥ 0) that every visible point of the unit sphere lies
 * inside: the side and near planes of the view frustum, and the horizon plane (front-facing: eye·p > 1).
 */
function visibilityPlanes(cam: Camera): number[][] {
  const m = cam.viewProj, row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const [x, y, z, w] = [row(0), row(1), row(2), row(3)];
  const unit = (p: number[]) => { const l = Math.hypot(p[0], p[1], p[2]); return p.map((v) => v / l); };
  const e = cam.eye;
  return [...[x, y].flatMap((a) => [w.map((v, i) => v + a[i]), w.map((v, i) => v - a[i])]), z, [e[0], e[1], e[2], -1]].map(unit);
}

/**
 * Spherical cap around a tile's patch (lon lonA–lonB, lat latS–latN): centre and angular radius. The patch point
 * farthest from the centre is a corner, as a tile of level ≥ 1 spans at most half the longitudes.
 */
function patchCap(lonA: number, lonB: number, latS: number, latN: number): [number[], number] {
  const c = lonLatToXYZ((lonA + lonB) / 2, (latS + latN) / 2);
  let cosR = 1;
  for (const lon of [lonA, lonB]) for (const lat of [latS, latN]) {
    const p = lonLatToXYZ(lon, lat);
    cosR = Math.min(cosR, c[0] * p[0] + c[1] * p[1] + c[2] * p[2]);
  }
  return [c, Math.acos(Math.max(-1, cosR)) + 1e-9];
}

/**
 * False only when no point of the patch (lon lonA–lonB, lat latS–latN) of the unit sphere can be visible: the cap
 * around it lies wholly outside one of the visibility planes, or, `depth` times over, so does the cap around each
 * quarter of it (tighter caps). Conservative: a patch near a corner of the frustum may be kept although none of it
 * shows.
 */
function patchMayShow(lonA: number, lonB: number, latS: number, latN: number, planes: number[][], depth: number): boolean {
  const [c, theta] = patchCap(lonA, lonB, latS, latN);
  for (const [nx, ny, nz, d] of planes) {
    const a = Math.acos(Math.max(-1, Math.min(1, nx * c[0] + ny * c[1] + nz * c[2])));
    if (Math.cos(Math.max(0, a - theta)) + d < 0) return false; // the cap's greatest n·p is still outside
  }
  if (!depth) return true;
  const lonM = (lonA + lonB) / 2, latM = (latS + latN) / 2;
  return patchMayShow(lonA, lonM, latS, latM, planes, depth - 1) || patchMayShow(lonM, lonB, latS, latM, planes, depth - 1)
    || patchMayShow(lonA, lonM, latM, latN, planes, depth - 1) || patchMayShow(lonM, lonB, latM, latN, planes, depth - 1);
}

/**
 * Web Mercator tiles [z, x, y] in view: a quadtree split while a tile spans more than `splitPx` device pixels, from
 * level `minZ` down to level `maxZ`, culled outside the viewport from level 2 on, and at most `maxTiles` tiles. The
 * default cull projects a few points of each tile and can miss a tile whose visible part lies between them; with
 * `complete`, a tile is culled only when no point of it can be visible (every visible point lies in a listed tile).
 */
export function selectTiles(cam: Camera, dpr: number, maxZ: number, splitPx: number, maxTiles: number, minZ = 2, complete = false): number[][] {
  const out: number[][] = [];
  const look = cam.cur;
  const planes = complete ? visibilityPlanes(cam) : [];
  const visit = (z: number, x: number, y: number) => {
    if (out.length >= maxTiles) return;
    const n = 2 ** z;
    const lonA = (x / n) * 360 - 180, lonB = ((x + 1) / n) * 360 - 180;
    const latA = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const latB = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
    let anyFront = false, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, cnt = 0;
    // A 3×3 grid misses large tiles whose visible part lies between samples (zoomed-in views), so the tile point
    // nearest the look-at point is sampled too, and the tile holding the look-at point is never culled.
    // (Across the antimeridian the nearest edge is the one the shorter way round.)
    const nearLon = look.lon >= lonA && look.lon <= lonB ? look.lon : lonGap(look.lon, lonA) <= lonGap(look.lon, lonB) ? lonA : lonB;
    const nearLat = Math.max(latB, Math.min(latA, look.lat));
    const holdsLook = nearLon === look.lon && nearLat === look.lat;
    for (let i = 0; i <= 9; i++) {
      const lon = i < 9 ? lonA + ((lonB - lonA) * (i % 3)) / 2 : nearLon, lat = i < 9 ? latA + ((latB - latA) * Math.floor(i / 3)) / 2 : nearLat;
      const [px, py, front] = cam.project(lonLatToXYZ(lon, lat));
      if (!front) continue;
      anyFront = true; cnt++;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    if (z >= 2 && !holdsLook && (complete ? !patchMayShow(lonA, lonB, latB, latA, planes, CULL_DEPTH)
      : !anyFront || maxX < -50 || minX > cam.width + 50 || maxY < -50 || minY > cam.height + 50)) return;
    const size = Math.max(maxX - minX, maxY - minY) * dpr;
    if (z < minZ || (z < maxZ && ((cnt >= 1 && size > splitPx) || (holdsLook && cnt < 10)))) {
      for (let k = 0; k < 4; k++) visit(z + 1, x * 2 + (k & 1), y * 2 + (k >> 1));
      return;
    }
    out.push([z, x, y]);
  };
  visit(0, 0, 0);
  return out;
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
    this.hypso = this.r.gpu.texture2D(1024, p.frames.length, 'rgba8unorm', lut, 4, 'basemap');
    this.hypsoName = this.s.tintPalette;
    this.bg = null;
  }

  /** Selects visible tiles (quadtree with screen-space size threshold). */
  private select(): number[][] {
    // Reduced density while the camera moves (motion reduce amount in %), full density once it settles.
    const c = this.r.camera.cur, key = `${c.lon},${c.lat},${c.z},${c.tilt},${c.swivel}`;
    const moving = key !== this.lastCam; this.lastCam = key;
    const thresh = this.s.density * 1.15 * (moving ? 1 + this.s.motionReduce / 100 : 1);
    return selectTiles(this.r.camera, this.r.gpu.dpr, TER_MAX + 1, thresh * 2, MAX_TILES);
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
