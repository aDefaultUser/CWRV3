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
    this.dummy2D = this.texture2D(1, 1, 'rgba8unorm', new Uint8Array([0, 0, 0, 0]));
    this.dummyArray = d.createTexture({ size: [1, 1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, dimension: '2d' });
  }

  /** Resizes the backbuffer to CSS size × DPR (or the fixed size). Returns true when it changed. */
  resize(): boolean {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const [w, h] = this.fixedSize ?? [Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr))];
    const max = this.device.limits.maxTextureDimension2D;
    const W = Math.min(w, max), H = Math.min(h, max);
    if (W === this.width && H === this.height && dpr === this.dpr && this.msaa) return false;
    this.width = W; this.height = H; this.dpr = this.fixedSize ? W / Math.max(1, r.width) : dpr;
    this.canvas.width = W; this.canvas.height = H;
    this.msaa?.destroy();
    this.msaa = this.sampleCount > 1 ? this.device.createTexture({ size: [W, H], format: this.format, sampleCount: this.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
    return true;
  }

  setSampleCount(n: 1 | 4) { if (n !== this.sampleCount) { this.sampleCount = n; this.msaa?.destroy(); this.msaa = null; this.resize(); } }

  texture2D(w: number, h: number, format: GPUTextureFormat, data: ArrayBufferView | null, bytesPerTexel = 4): GPUTexture {
    perfMark(`tex ${w}x${h}`);
    const t = this.device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    if (data) this.write(t, w, h, data, bytesPerTexel);
    return t;
  }

  write(t: GPUTexture, w: number, h: number, data: ArrayBufferView, bytesPerTexel: number, origin: [number, number, number] = [0, 0, 0]) {
    this.device.queue.writeTexture({ texture: t, origin }, data as BufferSource, { bytesPerRow: w * bytesPerTexel, rowsPerImage: h }, [w, h, 1]);
  }

  buffer(data: ArrayBufferView | number, usage: number): GPUBuffer {
    const size = typeof data === 'number' ? data : data.byteLength;
    const b = this.device.createBuffer({ size: Math.max(16, (size + 3) & ~3), usage: usage | GPUBufferUsage.COPY_DST });
    if (typeof data !== 'number') this.device.queue.writeBuffer(b, 0, data as BufferSource);
    return b;
  }
}

export { toHalf } from './half';
