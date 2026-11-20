import { perfMark } from '../perf/meter';
// WebGPU device, canvas configuration (DPR-aware or fixed backbuffer), shared samplers and texture helpers.
export interface GpuInfo { vendor: string; architecture: string; device: string; description: string; features: string[]; isFallback: boolean; limits: Record<string, number> }

export class Gpu {
  device!: GPUDevice;
  context!: GPUCanvasContext;
  format!: GPUTextureFormat;
  info!: GpuInfo;
  timestamps = false;
  /** r32float can be linearly filtered (feature float32-filterable); otherwise 16-bit sweeps fall back to r16float. */
  float32Filterable = false;
  samplers!: { linear: GPUSampler; nearest: GPUSampler; lut: GPUSampler; repeat: GPUSampler };
  dummy2D!: GPUTexture;
  dummyArray!: GPUTexture;
  /** Device pixel size of the backbuffer. */
  width = 1; height = 1; dpr = 1;
  /** When set, the backbuffer has this fixed size regardless of the canvas CSS size (4K acceptance runs). */
  fixedSize: [number, number] | null = null;
  sampleCount = 4;
  msaa: GPUTexture | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {}

  async init(): Promise<void> {
    if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const ai = adapter.info;
    const wanted: GPUFeatureName[] = ['timestamp-query', 'float32-filterable'];
    const features = wanted.filter((f) => adapter.features.has(f));
    // Large vector products (all-hazard advisories, shapefiles) need storage buffers above the 128 MiB default.
    const big = (k: 'maxStorageBufferBindingSize' | 'maxBufferSize') => Math.min(adapter.limits[k], 1024 * 1024 * 1024);
    this.device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: { maxStorageBufferBindingSize: big('maxStorageBufferBindingSize'), maxBufferSize: big('maxBufferSize') } });
    this.timestamps = features.includes('timestamp-query');
    this.float32Filterable = features.includes('float32-filterable');
    this.device.lost.then((l) => console.error('GPU device lost', l.message));
    this.device.addEventListener('uncapturederror', (e) => console.error('GPU error:', (e as GPUUncapturedErrorEvent).error.message));
    this.info = {
      vendor: ai.vendor, architecture: ai.architecture, device: ai.device, description: ai.description,
      features: [...adapter.features] as string[], isFallback: (ai as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? false,
      limits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
    };
    this.context = this.canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    const d = this.device;
    this.samplers = {
      linear: d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
      nearest: d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
      lut: d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
      repeat: d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' }),
    };
    this.dummy2D = this.texture2D(1, 1, 'rgba8unorm', new Uint8Array([0, 0, 0, 0]), 4, 'renderer');
    this.dummyArray = d.createTexture({ size: [1, 1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, dimension: '2d' });
  }

  /** CSS size of the canvas, kept by a ResizeObserver so that a frame does not force a layout to read it. */
  private css: [number, number] | null = null;
  private observer: ResizeObserver | null = null;

  /** Resizes the backbuffer to CSS size × DPR (or the fixed size). Returns true when it changed. */
  resize(): boolean {
    if (!this.observer && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => { const r = entries[entries.length - 1].contentRect; this.css = [r.width, r.height]; });
      this.observer.observe(this.canvas);
    }
    const dpr = window.devicePixelRatio || 1;
    // Until the observer has seen the canvas laid out (it reports 0 × 0 while detached), the size is read directly.
    let css = this.css && this.css[0] > 0 && this.css[1] > 0 ? this.css : null;
    if (!css) { const r = this.canvas.getBoundingClientRect(); css = [r.width, r.height]; }
    const [w, h] = this.fixedSize ?? [Math.max(1, Math.round(css[0] * dpr)), Math.max(1, Math.round(css[1] * dpr))];
    const max = this.device.limits.maxTextureDimension2D;
    const W = Math.min(w, max), H = Math.min(h, max);
    // Backbuffer pixels per CSS pixel: a fixed size keeps its pixels while the CSS width changes this ratio.
    const effDpr = this.fixedSize ? W / Math.max(1, css[0]) : dpr;
    // Assigning the canvas size reallocates its drawing buffer, so it happens only on a real change.
    const same = W === this.canvas.width && H === this.canvas.height;
    if (same && W === this.width && H === this.height && effDpr === this.dpr && !!this.msaa === this.sampleCount > 1) return false;
    this.dpr = effDpr; this.width = W; this.height = H;
    if (!same) { this.canvas.width = W; this.canvas.height = H; }
    if (this.msaa && (this.sampleCount === 1 || this.msaa.width !== W || this.msaa.height !== H)) { this.msaa.destroy(); this.msaa = null; }
    if (this.sampleCount > 1 && !this.msaa) this.msaa = this.device.createTexture({ size: [W, H], format: this.format, sampleCount: this.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    return true;
  }

  setSampleCount(n: 1 | 4) { if (n !== this.sampleCount) { this.sampleCount = n; this.msaa?.destroy(); this.msaa = null; this.resize(); } }

  /**
   * Texture data uploads per owner (the layer that passed its ID). `cpuMs` is the time to submit the copy on the CPU
   * (queue.writeTexture / copyExternalImageToTexture return before the GPU executes it), not GPU execution time.
   */
  readonly uploads = new Map<string, { count: number; bytes: number; cpuMs: number }>();
  /**
   * Bytes of live textures per owner: those created by texture2D plus registered atlases (trackTexture), added on
   * creation and subtracted once when destroyed. An owner stays listed (at 0) after its last texture is released.
   */
  readonly textureBytes = new Map<string, number>();
  get trackedTextureBytes() { let n = 0; for (const b of this.textureBytes.values()) n += b; return n; }

  recordUpload(owner: string, bytes: number, cpuMs: number) {
    let u = this.uploads.get(owner);
    if (!u) { u = { count: 0, bytes: 0, cpuMs: 0 }; this.uploads.set(owner, u); }
    u.count++; u.bytes += bytes; u.cpuMs += cpuMs;
  }
  /** Counts a texture's memory under `owner` until it is destroyed. */
  trackTexture(t: GPUTexture, bytes: number, owner: string) {
    const add = (d: number) => this.textureBytes.set(owner, (this.textureBytes.get(owner) ?? 0) + d);
    add(bytes);
    const destroy = t.destroy.bind(t);
    let live = true;
    t.destroy = () => { if (live) { live = false; add(-bytes); } destroy(); };
  }

  texture2D(w: number, h: number, format: GPUTextureFormat, data: ArrayBufferView | null, bytesPerTexel = 4, owner = 'unattributed'): GPUTexture {
    perfMark(`tex ${w}x${h}`);
    const t = this.device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.trackTexture(t, w * h * bytesPerTexel, owner);
    if (data) this.write(t, w, h, data, bytesPerTexel, [0, 0, 0], owner);
    return t;
  }

  /** A tracked texture the GPU renders into (render passes, blending) and that can be sampled and read back. */
  renderTarget(w: number, h: number, format: GPUTextureFormat, bytesPerTexel: number, owner = 'unattributed'): GPUTexture {
    const t = this.device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    this.trackTexture(t, w * h * bytesPerTexel, owner);
    return t;
  }

  write(t: GPUTexture, w: number, h: number, data: ArrayBufferView, bytesPerTexel: number, origin: [number, number, number] = [0, 0, 0], owner = 'unattributed') {
    const t0 = performance.now();
    this.device.queue.writeTexture({ texture: t, origin }, data as BufferSource, { bytesPerRow: w * bytesPerTexel, rowsPerImage: h }, [w, h, 1]);
    this.recordUpload(owner, w * h * bytesPerTexel, performance.now() - t0);
  }

  buffer(data: ArrayBufferView | number, usage: number): GPUBuffer {
    const size = typeof data === 'number' ? data : data.byteLength;
    const b = this.device.createBuffer({ size: Math.max(16, (size + 3) & ~3), usage: usage | GPUBufferUsage.COPY_DST });
    if (typeof data !== 'number') this.device.queue.writeBuffer(b, 0, data as BufferSource);
    return b;
  }
}

export { toHalf } from './half';
