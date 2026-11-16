// Frame orchestration: uniforms, pipelines, ordered layer drawing, probe read-back and GPU timing.
import { Gpu } from './gpu';
import { Camera, invert, mul } from './camera';
import { SKY, TILES, RASTER, RADAR, LINES, POINTS, TEXT, SPRITES, POLYS } from './shaders';

export interface DrawContext { r: Renderer; pass: GPURenderPassEncoder; probe: boolean }
export interface Drawable {
  readonly id: string;
  /** Records draw calls. Called once per frame for visible layers in layer order. */
  draw(ctx: DrawContext): void;
  /** True when the layer can answer a probe (topmost such layer is probed). */
  probeKind?(): string | null;
}

const PREMUL: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

export interface ProbeResult { kind: string; value: number; layer: string }

export class Renderer {
  readonly gpu: Gpu;
  readonly camera = new Camera();
  frameBuf!: GPUBuffer;
  probeFrameBuf!: GPUBuffer;
  frameBG!: GPUBindGroup;
  probeFrameBG!: GPUBindGroup;
  frameBGL!: GPUBindGroupLayout;
  pipes: Record<string, GPURenderPipeline> = {};
  layouts!: Record<string, GPUBindGroupLayout>;
  probePipes: Record<string, GPURenderPipeline> = {};
  layers: Drawable[] = [];
  flashRow = 0;
  time0 = performance.now();
  light: [number, number, number, number] = [0, 0, 1, 6];
  globeLighting = true;
  diffuseIntensity = 1;
  /** Raster patch mesh (cells x, y); RasterObjectSphereMeshSpacing scales it (3.0 → 96 × 64). */
  rasterMesh: [number, number] = [96, 64];
  skyParams = { bg: [0, 0, 0], atmosphere: true, height: 180, intensity: 0.5, stars: true, innerLimit: 0.4 };
  private skyBuf!: GPUBuffer;
  private skyBG!: GPUBindGroup;
  private probeTex!: GPUTexture;
  private probeRead!: GPUBuffer;
  private probeBusy = false;
  probeRequest: { x: number; y: number } | null = null;
  lastProbe: ProbeResult | null = null;
  onProbe: ((r: ProbeResult | null) => void) | null = null;
  // timing
  private tsQuery: GPUQuerySet | null = null;
  private tsResolve: GPUBuffer | null = null;
  private tsRead: GPUBuffer | null = null;
  private tsBusy = false;
  gpuMs = 0;

  constructor(canvas: HTMLCanvasElement) { this.gpu = new Gpu(canvas); }

  async init() {
    await this.gpu.init();
    const d = this.gpu.device;
    this.frameBuf = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.probeFrameBuf = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameBGL = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.frameBG = d.createBindGroup({ layout: this.frameBGL, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] });
    this.probeFrameBG = d.createBindGroup({ layout: this.frameBGL, entries: [{ binding: 0, resource: { buffer: this.probeFrameBuf } }] });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    type E = 'u' | 's' | 't' | 'ta' | 'smp';
    const bgl = (kinds: E[]) => d.createBindGroupLayout({
      entries: kinds.map((k, binding): GPUBindGroupLayoutEntry => {
        if (k === 'u') return { binding, visibility: VF, buffer: { type: 'uniform' } };
        if (k === 's') return { binding, visibility: VF, buffer: { type: 'read-only-storage' } };
        if (k === 't') return { binding, visibility: VF, texture: { sampleType: 'float' } };
        if (k === 'ta') return { binding, visibility: VF, texture: { sampleType: 'float', viewDimension: '2d-array' } };
        return { binding, visibility: VF, sampler: { type: 'filtering' } };
      }),
    });
    this.layouts = {
      sky: bgl(['u']),
      tiles: bgl(['u', 's', 'ta', 'ta', 'smp', 't', 'smp']),
      raster: bgl(['u', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 'smp', 'smp']),
      radar: bgl(['u', 't', 't', 't', 'smp', 'smp', 't', 't', 't', 't']),
      lines: bgl(['s', 's']),
      polys: bgl(['s', 's', 'ta', 'smp']),
      points: bgl(['s']),
      text: bgl(['s', 's', 't', 'smp']),
      sprites: bgl(['s', 't', 'smp']),
    };
    const mk = (name: string, code: string, opts: { probe?: boolean; layout?: string; fs?: string } = {}) => {
      const module = d.createShaderModule({ code, label: name });
      module.getCompilationInfo().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error(`WGSL ${name}:${m.lineNum}:${m.linePos} ${m.message}`); });
      const layout = d.createPipelineLayout({ bindGroupLayouts: [this.frameBGL, this.layouts[opts.layout ?? name]] });
      this.pipes[name] = d.createRenderPipeline({
        label: name, layout,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: opts.fs ?? 'fs', targets: [{ format: this.gpu.format, blend: name === 'sky' || name === 'tiles' ? undefined : PREMUL }] },
        primitive: { topology: 'triangle-list' },
        multisample: { count: this.gpu.sampleCount },
      });
      if (opts.probe) this.probePipes[name] = d.createRenderPipeline({
        label: name + '-probe', layout,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fsProbe', targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    this.buildPipelines = () => {
      mk('sky', SKY); mk('tiles', TILES); mk('raster', RASTER, { probe: true }); mk('radar', RADAR, { probe: true });
      mk('polys', POLYS); mk('lines', LINES); mk('points', POINTS); mk('text', TEXT); mk('sprites', SPRITES);
      mk('spritesAdd', SPRITES, { layout: 'sprites', fs: 'fsAdd' });
    };
    this.buildPipelines();
    this.skyBuf = d.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.skyBG = d.createBindGroup({ layout: this.layouts.sky, entries: [{ binding: 0, resource: { buffer: this.skyBuf } }] });
    this.probeTex = d.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.probeRead = d.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    if (this.gpu.timestamps) {
      this.tsQuery = d.createQuerySet({ type: 'timestamp', count: 2 });
      this.tsResolve = d.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.tsRead = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    this.gpu.resize();
  }

  buildPipelines: () => void = () => {};

  /** Raster pipelines with a generated fragment entry (user RGB recipes), cached by key; errors go to `onError`. */
  private variants = new Map<string, GPURenderPipeline>();
  rasterVariant(key: string, code: string, entry: string, onError: (msg: string) => void): GPURenderPipeline {
    let p = this.variants.get(key);
    if (p) return p;
    const d = this.gpu.device;
    const module = d.createShaderModule({ code, label: `raster:${key}` });
    module.getCompilationInfo().then((info) => { const errs = info.messages.filter((m) => m.type === 'error'); if (errs.length) onError(errs.map((m) => m.message).join('; ')); });
    p = d.createRenderPipeline({
      label: `raster:${key}`, layout: d.createPipelineLayout({ bindGroupLayouts: [this.frameBGL, this.layouts.raster] }),
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: entry, targets: [{ format: this.gpu.format, blend: PREMUL }] },
      primitive: { topology: 'triangle-list' }, multisample: { count: this.gpu.sampleCount },
    });
    if (this.variants.size > 16) this.variants.clear();
    this.variants.set(key, p);
    return p;
  }

  /** Re-creates pipelines when the MSAA sample count changes (performance mode). */
  setSampleCount(n: 1 | 4) {
    if (n === this.gpu.sampleCount) return;
    this.gpu.setSampleCount(n);
    this.buildPipelines();
    this.variants.clear();
    for (const l of this.layers) (l as unknown as { invalidate?: () => void }).invalidate?.();
    this.skyBG = this.gpu.device.createBindGroup({ layout: this.layouts.sky, entries: [{ binding: 0, resource: { buffer: this.skyBuf } }] });
  }

  private writeFrame(buf: GPUBuffer, vpRot: Float64Array) {
    const g = this.gpu, c = this.camera;
    const f = new Float32Array(64);
    f.set(vpRot, 0);
    f.set([c.eye[0], c.eye[1], c.eye[2], (performance.now() - this.time0) / 1000], 16);
    f.set([g.width, g.height, g.dpr, this.flashRow], 20);
    f.set(this.light, 24);
    f.set([c.zoomScale, c.metersPerPixel(1) / g.dpr, this.diffuseIntensity, this.globeLighting ? 1 : 0], 28);
    g.device.queue.writeBuffer(buf, 0, f);
  }

  /** Renders one frame. */
  frame() {
    const g = this.gpu, d = g.device, c = this.camera;
    g.resize();
    c.width = g.width / g.dpr; c.height = g.height / g.dpr;
    c.compute();
    this.writeFrame(this.frameBuf, c.vpRot);
    const sky = new Float32Array(28);
    sky.set(invert(c.viewProj), 0);
    sky.set([...this.skyParams.bg, 1], 16);
    sky.set([this.skyParams.atmosphere ? 1 : 0, this.skyParams.height, this.skyParams.intensity, this.skyParams.stars ? 1 : 0], 20);
    sky.set([this.skyParams.innerLimit, 0, 0, 0], 24);
    d.queue.writeBuffer(this.skyBuf, 0, sky);

    const enc = d.createCommandEncoder();
    const view = g.context.getCurrentTexture().createView();
    const pass = enc.beginRenderPass({
      colorAttachments: [g.msaa
        ? { view: g.msaa.createView(), resolveTarget: view, loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 1 } }
        : { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      timestampWrites: this.tsQuery && !this.tsBusy ? { querySet: this.tsQuery, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
    });
    pass.setBindGroup(0, this.frameBG);
    pass.setPipeline(this.pipes.sky);
    pass.setBindGroup(1, this.skyBG);
    pass.draw(3);
    const ctx: DrawContext = { r: this, pass, probe: false };
    for (const l of this.layers) { pass.setBindGroup(0, this.frameBG); l.draw(ctx); }
    pass.end();

    let probeLayer: Drawable | null = null;
    if (this.probeRequest && !this.probeBusy) {
      for (let i = this.layers.length - 1; i >= 0; i--) if (this.layers[i].probeKind?.()) { probeLayer = this.layers[i]; break; }
      if (probeLayer) {
        const { x, y } = this.probeRequest;
        const W = g.width, H = g.height;
        const cx = ((x * g.dpr) / W) * 2 - 1, cy = 1 - ((y * g.dpr) / H) * 2;
        const M = new Float64Array([W, 0, 0, 0, 0, H, 0, 0, 0, 0, 1, 0, -cx * W, -cy * H, 0, 1]);
        this.writeFrame(this.probeFrameBuf, mul(M, c.vpRot));
        const pp = enc.beginRenderPass({ colorAttachments: [{ view: this.probeTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pp.setBindGroup(0, this.probeFrameBG);
        probeLayer.draw({ r: this, pass: pp, probe: true });
        pp.end();
        enc.copyTextureToBuffer({ texture: this.probeTex }, { buffer: this.probeRead, bytesPerRow: 256 }, [1, 1]);
      }
    }
    const doTs = this.tsQuery && !this.tsBusy;
    if (doTs) { enc.resolveQuerySet(this.tsQuery!, 0, 2, this.tsResolve!, 0); enc.copyBufferToBuffer(this.tsResolve!, 0, this.tsRead!, 0, 16); }
    d.queue.submit([enc.finish()]);

    if (doTs) {
      this.tsBusy = true;
      this.tsRead!.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(this.tsRead!.getMappedRange());
        const ms = Number(t[1] - t[0]) / 1e6;
        if (ms >= 0 && ms < 1000) this.gpuMs = ms;
        this.tsRead!.unmap();
        this.tsBusy = false;
      }, () => { this.tsBusy = false; });
    }
    if (probeLayer) {
      this.probeBusy = true;
      const kind = probeLayer.probeKind!()!;
      const layer = probeLayer.id;
      this.probeRequest = null;
      this.probeRead.mapAsync(GPUMapMode.READ).then(() => {
        const v = new Float32Array(this.probeRead.getMappedRange().slice(0, 16));
        this.probeRead.unmap();
        this.probeBusy = false;
        this.lastProbe = v[1] > 0 ? { kind, value: v[0], layer } : null;
        this.onProbe?.(this.lastProbe);
      }, () => { this.probeBusy = false; });
    } else if (this.probeRequest && !this.probeBusy) {
      this.probeRequest = null;
      this.lastProbe = null;
      this.onProbe?.(null);
    }
  }
}
