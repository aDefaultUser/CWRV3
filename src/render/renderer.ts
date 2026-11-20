// Frame orchestration: uniforms, pipelines, ordered layer drawing, probe read-back and GPU timing.
import { Gpu } from './gpu';
import { Camera, invert, mul } from './camera';
import { SKY, TILES, RASTER, RADAR, LINES, POINTS, TEXT, SPRITES, POLYS, OVERLAY_TILES } from './shaders';
import { MAX_PANES, SINGLE_PANE, paneCount, paneOrigin, paneSize, type PaneGrid } from './panes';

/**
 * `pass` takes the draw commands a render bundle can record too (pipeline, bind groups, draws): with more than one
 * pane a layer's commands are recorded once and replayed in every pane. `pane` is the pane drawn (0 in a recording).
 */
export interface DrawContext { r: Renderer; pass: GPURenderCommandsMixin & GPUBindingCommandsMixin; probe: boolean; pane: number }
export interface PrepassContext {
  r: Renderer; enc: GPUCommandEncoder;
  /**
   * Timestamp writes for one render or compute pass of a prepass, so that its GPU time is part of `gpuMs`. Undefined
   * when timing is off this frame or more than TIMED_PREPASSES passes asked (the pass then runs untimed).
   */
  timing(): GPURenderPassTimestampWrites | undefined;
}
export interface Drawable {
  readonly id: string;
  /**
   * Encodes this layer's own offscreen passes (section images, volume targets) on the frame's encoder before the
   * main pass begins. Called once per frame for visible layers in layer order; the main pass may sample the result.
   */
  prepass?(ctx: PrepassContext): void;
  /** Draws differently from pane to pane: draw() is then called for every pane (ctx.pane), in the pane's viewport. */
  readonly perPane?: boolean;
  /** Records draw calls. Called once per frame for visible layers in layer order (once per pane for a perPane layer). */
  draw(ctx: DrawContext): void;
  /** True when the layer can answer a probe (topmost such layer is probed). */
  probeKind?(): string | null;
}

/** Prepass passes per frame whose GPU time can be measured (the main pass uses its own pair of queries). */
export const TIMED_PREPASSES = 7;
const TS_QUERIES = 2 * (1 + TIMED_PREPASSES);
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
  /**
   * Pane grid of the map. Every pane shows the scene through the one camera, sized to a pane, so camera
   * coordinates (pick, project, declutter) and probe points are relative to a pane and hold for each of them.
   */
  grid: PaneGrid = SINGLE_PANE;
  /** Pointer probe at a pane-relative CSS pixel, read in every pane. */
  probeRequest: { x: number; y: number } | null = null;
  /** The probe result of each pane (the same in all for a layer that is not perPane). */
  onProbe: ((r: (ProbeResult | null)[]) => void) | null = null;
  /** One-shot probes of a named layer at a pane-relative CSS pixel of `pane` (analysis tools); served before the pointer probe. */
  probeOnce: { x: number; y: number; layer: string; pane?: number; done: (r: ProbeResult | null) => void }[] = [];
  // timing
  private tsQuery: GPUQuerySet | null = null;
  private tsResolve: GPUBuffer | null = null;
  private tsRead: GPUBuffer | null = null;
  private tsBusy = false;
  /** GPU time of the last measured frame: the main pass plus the timed prepass passes (`gpuPrepassMs` of it). */
  gpuMs = 0;
  gpuPrepassMs = 0;

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
      overlayTiles: bgl(['u', 's', 'ta', 'smp']),
      raster: bgl(['u', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 'smp', 'smp']),
      radar: bgl(['u', 't', 't', 't', 'smp', 'smp', 't', 't', 't', 't']),
      lines: bgl(['s', 's']),
      polys: bgl(['s', 's', 'ta', 'smp']),
      points: bgl(['s']),
      text: bgl(['s', 's', 't', 'smp']),
      sprites: bgl(['s', 't', 'smp']),
      // Volume pack (render/volume.ts): its uniform and tilt texture array, also for compute passes.
      volume: d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: VF | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VF | GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } }] }),
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
      for (const name of Object.keys(this.lazyPipes)) delete this.pipes[name];
    };
    // Pipelines of layers that are off by default are built when first drawn (not at start-up).
    this.lazyPipes = { overlayTiles: () => mk('overlayTiles', OVERLAY_TILES) };
    this.buildPipelines();
    this.skyBuf = d.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.skyBG = d.createBindGroup({ layout: this.layouts.sky, entries: [{ binding: 0, resource: { buffer: this.skyBuf } }] });
    this.probeTex = d.createTexture({ size: [MAX_PANES, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.probeRead = d.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    if (this.gpu.timestamps) {
      this.tsQuery = d.createQuerySet({ type: 'timestamp', count: TS_QUERIES });
      this.tsResolve = d.createBuffer({ size: TS_QUERIES * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.tsRead = d.createBuffer({ size: TS_QUERIES * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    this.gpu.resize();
  }

  buildPipelines: () => void = () => {};
  private lazyPipes: Record<string, () => void> = {};
  /** A pipeline by name, building a lazily created one on first use. */
  pipe(name: string): GPURenderPipeline { if (!this.pipes[name]) this.lazyPipes[name]?.(); return this.pipes[name]; }

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

  /** Device-pixel size of one pane (the whole backbuffer when there is one). */
  paneSize(): [number, number] { return paneSize(this.grid, this.gpu.width, this.gpu.height); }

  private writeFrame(buf: GPUBuffer, vpRot: Float64Array) {
    const g = this.gpu, c = this.camera;
    const f = new Float32Array(64);
    f.set(vpRot, 0);
    f.set([c.eye[0], c.eye[1], c.eye[2], (performance.now() - this.time0) / 1000], 16);
    f.set([...this.paneSize(), g.dpr, this.flashRow], 20);
    f.set(this.light, 24);
    f.set([c.zoomScale, c.metersPerPixel(1) / g.dpr, this.diffuseIntensity, this.globeLighting ? 1 : 0], 28);
    g.device.queue.writeBuffer(buf, 0, f);
  }

  /** Renders one frame. */
  frame() {
    const g = this.gpu, d = g.device, c = this.camera;
    g.resize();
    const [pw, ph] = this.paneSize(), panes = paneCount(this.grid);
    c.width = pw / g.dpr; c.height = ph / g.dpr;
    c.compute();
    this.writeFrame(this.frameBuf, c.vpRot);
    const sky = new Float32Array(28);
    sky.set(invert(c.viewProj), 0);
    sky.set([...this.skyParams.bg, 1], 16);
    sky.set([this.skyParams.atmosphere ? 1 : 0, this.skyParams.height, this.skyParams.intensity, this.skyParams.stars ? 1 : 0], 20);
    sky.set([this.skyParams.innerLimit, 0, 0, 0], 24);
    d.queue.writeBuffer(this.skyBuf, 0, sky);

    const enc = d.createCommandEncoder();
    // Queries 0 and 1 time the main pass; each timed prepass pass takes the next pair.
    const doTs = !!this.tsQuery && !this.tsBusy;
    let timed = 1;
    const timing = () => (doTs && timed <= TIMED_PREPASSES ? { querySet: this.tsQuery!, beginningOfPassWriteIndex: 2 * timed, endOfPassWriteIndex: 2 * timed++ + 1 } : undefined);
    for (const l of this.layers) l.prepass?.({ r: this, enc, timing });
    const view = g.context.getCurrentTexture().createView();
    const pass = enc.beginRenderPass({
      colorAttachments: [g.msaa
        ? { view: g.msaa.createView(), resolveTarget: view, loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 1 } }
        : { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      timestampWrites: doTs ? { querySet: this.tsQuery!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
    });
    const drawSky = (p: GPURenderPassEncoder) => { p.setBindGroup(0, this.frameBG); p.setPipeline(this.pipes.sky); p.setBindGroup(1, this.skyBG); p.draw(3); };
    if (panes === 1) {
      drawSky(pass);
      for (const l of this.layers) { pass.setBindGroup(0, this.frameBG); l.draw({ r: this, pass, probe: false, pane: 0 }); }
    } else {
      // Layers that look the same in every pane are recorded once (their draw() runs once, as with a single pane)
      // and replayed in each viewport; a perPane layer draws into each pane itself.
      const steps: (GPURenderBundle | Drawable)[] = [];
      let rec: GPURenderBundleEncoder | null = null;
      for (const l of this.layers) {
        if (l.perPane) { if (rec) steps.push(rec.finish()); rec = null; steps.push(l); continue; }
        rec ??= d.createRenderBundleEncoder({ colorFormats: [g.format], sampleCount: g.sampleCount });
        rec.setBindGroup(0, this.frameBG);
        l.draw({ r: this, pass: rec, probe: false, pane: 0 });
      }
      if (rec) steps.push(rec.finish());
      for (let p = 0; p < panes; p++) {
        const [x, y] = paneOrigin(this.grid, p, pw, ph);
        pass.setViewport(x, y, pw, ph, 0, 1);
        pass.setScissorRect(x, y, pw, ph);
        drawSky(pass);
        for (const s of steps) {
          if (s instanceof GPURenderBundle) pass.executeBundles([s]);
          else { pass.setBindGroup(0, this.frameBG); s.draw({ r: this, pass, probe: false, pane: p }); }
        }
      }
    }
    pass.end();

    let probeLayer: Drawable | null = null, probed: number[] = [];
    const once = this.probeBusy ? undefined : this.probeOnce.shift();
    if (once || (this.probeRequest && !this.probeBusy)) {
      if (once) probeLayer = this.layers.find((l) => l.id === once.layer && l.probeKind?.()) ?? null;
      else for (let i = this.layers.length - 1; i >= 0; i--) if (this.layers[i].probeKind?.()) { probeLayer = this.layers[i]; break; }
      if (probeLayer) {
        const { x, y } = once ?? this.probeRequest!;
        const cx = ((x * g.dpr) / pw) * 2 - 1, cy = 1 - ((y * g.dpr) / ph) * 2;
        const M = new Float64Array([pw, 0, 0, 0, 0, ph, 0, 0, 0, 0, 1, 0, -cx * pw, -cy * ph, 0, 1]);
        this.writeFrame(this.probeFrameBuf, mul(M, c.vpRot));
        // One texel per pane, each the same pane-relative point; a layer that is not perPane is read once.
        probed = once ? [Math.min(panes - 1, once.pane ?? 0)] : probeLayer.perPane ? Array.from({ length: panes }, (_, p) => p) : [0];
        const pp = enc.beginRenderPass({ colorAttachments: [{ view: this.probeTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        for (const p of probed) {
          pp.setViewport(p, 0, 1, 1, 0, 1);
          pp.setScissorRect(p, 0, 1, 1);
          pp.setBindGroup(0, this.probeFrameBG);
          probeLayer.draw({ r: this, pass: pp, probe: true, pane: p });
        }
        pp.end();
        enc.copyTextureToBuffer({ texture: this.probeTex }, { buffer: this.probeRead, bytesPerRow: 256 }, [MAX_PANES, 1]);
      }
    }
    if (doTs) { enc.resolveQuerySet(this.tsQuery!, 0, 2 * timed, this.tsResolve!, 0); enc.copyBufferToBuffer(this.tsResolve!, 0, this.tsRead!, 0, 16 * timed); }
    d.queue.submit([enc.finish()]);

    if (doTs) {
      this.tsBusy = true;
      this.tsRead!.mapAsync(GPUMapMode.READ, 0, 16 * timed).then(() => {
        const t = new BigUint64Array(this.tsRead!.getMappedRange(0, 16 * timed));
        const span = (i: number) => Number(t[2 * i + 1] - t[2 * i]) / 1e6;
        let pre = 0;
        for (let i = 1; i < timed; i++) pre += span(i);
        const ms = span(0) + pre;
        if (ms >= 0 && ms < 1000) { this.gpuMs = ms; this.gpuPrepassMs = pre; }
        this.tsRead!.unmap();
        this.tsBusy = false;
      }, () => { this.tsBusy = false; });
    }
    if (probeLayer) {
      this.probeBusy = true;
      const kind = probeLayer.probeKind!()!;
      const layer = probeLayer.id;
      if (!once) this.probeRequest = null;
      this.probeRead.mapAsync(GPUMapMode.READ).then(() => {
        const v = new Float32Array(this.probeRead.getMappedRange().slice(0, 16 * MAX_PANES));
        this.probeRead.unmap();
        this.probeBusy = false;
        const at = (p: number): ProbeResult | null => (v[4 * p + 1] > 0 ? { kind, value: v[4 * p], layer } : null);
        if (once) { once.done(at(probed[0])); return; }
        this.onProbe?.(Array.from({ length: panes }, (_, p) => at(probed.includes(p) ? p : 0)));
      }, () => { this.probeBusy = false; once?.done(null); });
    } else if (once) once.done(null);
    else if (this.probeRequest && !this.probeBusy) {
      this.probeRequest = null;
      this.onProbe?.(Array.from({ length: panes }, () => null));
    }
  }
}
