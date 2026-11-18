// Max-value trail on the GPU: the per-gate maximum of several polar product images of one site, max-blended into one
// r8unorm render target on the shared azimuth frame (AZ_BINS half-degree rows at AZ_BIN0, padded like an uploaded
// sweep), which RadarDraw then draws like any sweep. Each source is read at the target texel's azimuth and range the
// way the radar draw reads it without smoothing (nearest gate, nearest radial); trailTexel mirrors the shader.
import type { Renderer, PrepassContext } from './renderer';
import type { SweepTex } from './raster';
import { AZ_BINS, AZ_BIN0 } from '../radar/l2products';

/** Polar geometry of a padded sweep image (rows = radials + 2; row 0 wraps the last radial, row rows−1 the first). */
export type PolarGeom = Pick<SweepTex, 'firstKm' | 'gateKm' | 'gates' | 'rows' | 'az0' | 'spacing'>;

/** Rows of the trail target: the azimuth frame plus its two wrap rows. */
export const TRAIL_ROWS = AZ_BINS + 2;

/** Azimuth (deg) of target row `y`: row 0 is the last bin (wrap), rows 1…AZ_BINS the bins, the last row the first bin. */
export const trailRowAz = (y: number) => AZ_BIN0 + ((y + AZ_BINS - 1) % AZ_BINS) * 0.5;

/**
 * Texel (gate, row) of a source image read at azimuth `az` and range `rKm` (the radar draw's sampleSweep with
 * smoothing off: nearest gate, nearest radial), or null outside its gates.
 */
export function trailTexel(s: PolarGeom, az: number, rKm: number): [number, number] | null {
  const fg = (rKm - s.firstKm) / s.gateKm + 0.5;
  if (fg < 0 || fg / s.gates > 0.9992) return null;
  let rel = az - s.az0;
  rel -= 360 * Math.floor((rel + s.spacing * 0.5) / 360);
  return [Math.min(s.gates - 1, Math.floor(fg)), Math.min(s.rows - 1, Math.max(0, Math.floor(rel / s.spacing + 1.5)))];
}

/** CPU reference of the blend: the target image (TRAIL_ROWS × gates codes) of the per-texel maximum of the sources. */
export function trailReference(dst: Pick<PolarGeom, 'firstKm' | 'gateKm' | 'gates'>, sources: { geom: PolarGeom; image: Uint8Array }[]): Uint8Array {
  const out = new Uint8Array(TRAIL_ROWS * dst.gates);
  for (let y = 0; y < TRAIL_ROWS; y++) {
    const az = trailRowAz(y);
    for (let g = 0; g < dst.gates; g++) {
      const r = dst.firstKm + g * dst.gateKm;
      let best = 0;
      for (const s of sources) {
        const t = trailTexel(s.geom, az, r);
        if (t) best = Math.max(best, s.image[t[1] * s.geom.gates + t[0]]);
      }
      out[y * dst.gates + g] = best;
    }
  }
  return out;
}

const BLEND = /* wgsl */ `
struct TrailP { dst: vec4f, src: vec4f, srcAz: vec4f };  // dst: first km, gate km; src: first km, gate km, gates, rows; srcAz: az0, spacing
@group(0) @binding(0) var<uniform> T: TrailP;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var tri = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(tri[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let y = i32(floor(p.y));
  let az = ${AZ_BIN0} + f32((y + ${AZ_BINS - 1}) % ${AZ_BINS}) * 0.5;
  let r = T.dst.x + floor(p.x) * T.dst.y;
  let fg = (r - T.src.x) / T.src.y + 0.5;
  if (fg < 0.0 || fg / T.src.z > 0.9992) { discard; }
  var rel = az - T.srcAz.x;
  rel = rel - 360.0 * floor((rel + T.srcAz.y * 0.5) / 360.0);
  let row = clamp(i32(floor(rel / T.srcAz.y + 1.5)), 0, i32(T.src.w) - 1);
  return vec4f(textureLoad(srcTex, vec2i(min(i32(floor(fg)), i32(T.src.z) - 1), row), 0).r, 0.0, 0.0, 1.0);
}
`;

/** One source of a blend: its sweep image and a uniform/bind group made for it once. */
export interface TrailSource { sweep: SweepTex; ubuf: GPUBuffer; bg: GPUBindGroup }

export class TrailBlend {
  private pipe: GPURenderPipeline | null = null;
  private layout: GPUBindGroupLayout | null = null;
  constructor(private r: Renderer) {}

  private init() {
    const d = this.r.gpu.device;
    this.layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    const module = d.createShaderModule({ code: BLEND, label: 'trail blend' });
    module.getCompilationInfo().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error(`WGSL trail blend:${m.lineNum}:${m.linePos} ${m.message}`); });
    const max: GPUBlendComponent = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
    this.pipe = d.createRenderPipeline({
      label: 'trail blend', layout: d.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'r8unorm', blend: { color: max, alpha: max } }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** Makes the uniform and bind group of a source (once per source image). */
  source(sweep: SweepTex): TrailSource {
    if (!this.pipe) this.init();
    const d = this.r.gpu.device;
    const ubuf = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bg = d.createBindGroup({ layout: this.layout!, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: sweep.tex.createView() }] });
    return { sweep, ubuf, bg };
  }

  /** Clears `target` (geometry `dst`) and max-blends every source into it in one render pass. */
  encode(ctx: PrepassContext, target: GPUTexture, dst: Pick<PolarGeom, 'firstKm' | 'gateKm'>, sources: TrailSource[]) {
    if (!this.pipe) this.init();
    const q = this.r.gpu.device.queue;
    for (const { sweep: s, ubuf } of sources) q.writeBuffer(ubuf, 0, new Float32Array([dst.firstKm, dst.gateKm, 0, 0, s.firstKm, s.gateKm, s.gates, s.rows, s.az0, s.spacing, 0, 0]));
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }], timestampWrites: ctx.timing() });
    pass.setPipeline(this.pipe!);
    for (const s of sources) { pass.setBindGroup(0, s.bg); pass.draw(3); }
    pass.end();
  }
}
