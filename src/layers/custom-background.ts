// Custom background (Settings → Background → "Custom background"): a user image georeferenced by its world file
// (six lines: pixel size x, rotation y, rotation x, pixel size y, upper-left centre x, upper-left centre y) in
// geographic degrees. Both files are kept in the browser's Cache Storage and drawn over the base map when selected.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer } from './base';
import { settings } from '../settings/store';
import { RasterDraw, latLonProj } from '../render/raster';
import { USER_FILES_CACHE, reportSaveFailure } from '../app/persist';

const CACHE = USER_FILES_CACHE;
const KEY = { image: '/custom-bg/image', world: '/custom-bg/world' } as const;

/** Bounds [south, west, north, east] of a north-up world file for a w×h image; throws for rotated/projected files. */
export function worldFileBounds(text: string, w: number, h: number): [number, number, number, number] {
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length < 6 || v.some((x) => !Number.isFinite(x))) throw new Error('A world file has six numeric lines');
  const [A, D, B, E, C, F] = v;
  if (B !== 0 || D !== 0) throw new Error('Rotated world files are not supported');
  if (Math.abs(C) > 360 || Math.abs(F) > 90 || A <= 0 || E >= 0) throw new Error('The world file must be north-up in geographic degrees (longitude/latitude)');
  const west = C - A / 2, north = F - E / 2;
  return [north + E * h, west, north, west + A * w];
}

export class CustomBackgroundLayer extends MapLayer {
  readonly id = 'customBackground';
  readonly title = 'Custom background';
  private tex: GPUTexture | null = null;
  private bounds: [number, number, number, number] | null = null;
  private size: [number, number] = [1, 1];
  private draw_: RasterDraw;
  error = '';
  constructor(r: Renderer) { super(r); this.draw_ = new RasterDraw(r); }
  enabled() { return settings.bool('config.bgCustom') && !!this.tex && !!this.bounds; }

  /** Stores a picked file and reloads. */
  async store(kind: keyof typeof KEY, file: File, edit: (write: () => void) => void = (write) => write()) {
    const c = await caches.open(CACHE);
    try { await c.put(KEY[kind], new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } })); } catch (err) { reportSaveFailure(`custom background ${file.name}`, err); throw err; }
    edit(() => settings.set(kind === 'image' ? 'ext.config.bgCustomImage' : 'ext.config.bgCustomWorldFile', file.name));
    await this.load();
  }

  async load() {
    this.error = '';
    try {
      const c = await caches.open(CACHE);
      const [img, wld] = await Promise.all([c.match(KEY.image), c.match(KEY.world)]);
      if (!img || !wld) return;
      const bmp = await createImageBitmap(await img.blob());
      this.bounds = worldFileBounds(await wld.text(), bmp.width, bmp.height);
      this.size = [bmp.width, bmp.height];
      const d = this.r.gpu.device, max = d.limits.maxTextureDimension2D;
      if (bmp.width > max || bmp.height > max) throw new Error(`Image larger than ${max} px is not supported by this GPU`);
      this.tex?.destroy();
      this.tex = d.createTexture({ size: [bmp.width, bmp.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      d.queue.copyExternalImageToTexture({ source: bmp }, { texture: this.tex }, [bmp.width, bmp.height]);
      this.draw_.invalidate();
    } catch (e) { this.error = (e as Error).message; this.tex?.destroy(); this.tex = null; this.bounds = null; }
  }

  draw(ctx: DrawContext) {
    if (ctx.probe || !this.enabled()) return;
    const [s, w, n, e] = this.bounds!;
    this.draw_.draw(ctx, { mode: 4, w: 0, alpha: 1, smoothing: true, bounds: [s, w, n, e], proj: latLonProj(n, w, s, e, this.size[0], this.size[1]), luts: [null], data: [[this.tex, this.tex]] });
  }
}
