// Cross-section view: a vertical section of a volume pack drawn on the GPU straight into a panel canvas (a second
// GPUCanvasContext on the renderer's device), coloured with the map's palette lookup. Encoded from a prepass, so its
// GPU time counts in the frame's gpuMs. Each pixel is sampled at the point sectionAt (radar/section-geometry.ts) gives.
import type { Renderer, PrepassContext } from './renderer';
import type { GpuPack } from './volume';
import { volumeWgsl } from './volume';
import type { Lut } from './raster';
import type { Section, Motion } from '../radar/section-geometry';

const VIEW = /* wgsl */ `
// line: a east, a north, b east, b north (km); ext: width, height (px), top km, LUT row; srv: speed kt, from deg, on, 0
struct ViewP { line: vec4f, ext: vec4f, srv: vec4f, bg: vec4f };
@group(0) @binding(0) var<uniform> V: ViewP;
@group(0) @binding(1) var lut: texture_2d<f32>;
@group(0) @binding(2) var ls: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var tri = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(tri[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let f = vec2f(p.x / V.ext.x, 1.0 - p.y / V.ext.y);
  let q = mix(V.line.xy, V.line.zw, f.x);
  var az = atan2(q.x, q.y) / VOL_RAD; az = az - 360.0 * floor(az / 360.0);
  var code = volumeSample(az, length(q), f.y * V.ext.z);
  // Storm-relative velocity with this view's own motion (stormRelativeCode); the pack's shared motion is not used.
  if (V.srv.z > 0.5 && code >= 2.0) { code = clamp(code + V.srv.x * cos((az - V.srv.y) * VOL_RAD), 2.0, 255.0); }
  if (code < 2.0) { return V.bg; }
  let c = textureSampleLevel(lut, ls, vec2f(code / 255.0, V.ext.w), 0.0);
  return vec4f(mix(V.bg.rgb, c.rgb, c.a), 1.0);
}
`;

export interface SectionDraw { pack: GpuPack; section: Section; lut: Lut; srv: Motion | null }

export class SectionView {
  readonly context: GPUCanvasContext;
  private pipe: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private ubuf: GPUBuffer;
  private bg: GPUBindGroup | null = null; private bgLut: Lut | null = null;

  constructor(private r: Renderer, readonly canvas: HTMLCanvasElement) {
    const g = r.gpu, d = g.device;
    this.context = canvas.getContext('webgpu')!;
    this.context.configure({ device: d, format: g.format, alphaMode: 'opaque' });
    this.layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }] });
    const module = d.createShaderModule({ code: VIEW + volumeWgsl(1), label: 'section view' });
    module.getCompilationInfo().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error(`WGSL section view:${m.lineNum}:${m.linePos} ${m.message}`); });
    this.pipe = d.createRenderPipeline({
      label: 'section view', layout: d.createPipelineLayout({ bindGroupLayouts: [this.layout, r.layouts.volume] }),
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: g.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.ubuf = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Renders the section into the canvas (its current backing size) and presents it with the frame. */
  encode(ctx: PrepassContext, p: SectionDraw, background: [number, number, number]) {
    const d = this.r.gpu.device, { a, b, topKm } = p.section, W = this.canvas.width, H = this.canvas.height;
    if (this.bgLut !== p.lut) {
      this.bgLut = p.lut;
      this.bg = d.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: p.lut.tex.createView() }, { binding: 2, resource: this.r.gpu.samplers.lut }] });
    }
    d.queue.writeBuffer(this.ubuf, 0, new Float32Array([...a, ...b, W, H, topKm, 0.5 / p.lut.rows, p.srv?.speedKt ?? 0, p.srv?.fromDeg ?? 0, p.srv ? 1 : 0, 0, ...background, 1]));
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: background[0], g: background[1], b: background[2], a: 1 } }], timestampWrites: ctx.timing() });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bg!);
    pass.setBindGroup(1, p.pack.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Clears the canvas to the background (nothing to show). */
  clear(ctx: PrepassContext, background: [number, number, number]) {
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: background[0], g: background[1], b: background[2], a: 1 } }] });
    pass.end();
  }

  destroy() { this.ubuf.destroy(); this.context.unconfigure(); }
}
