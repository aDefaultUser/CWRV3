// 3D view of a volume pack: a prepass ray-marches the pack (render/volume.ts) into a half-resolution rgba16float
// target, either as a semi-transparent volume or as lit isosurfaces, and the owning layer composites the target over
// the map in the main pass. Rays, bounds and the crossing search mirror render/volume-ray.ts; empty space is skipped
// with the pack's occupancy grid (radar/volume-pack.ts).
import type { Renderer, PrepassContext, DrawContext } from './renderer';
import { COMMON } from './shaders';
import { volumeWgsl, type GpuPack } from './volume';
import { EARTH_KM, FOV_Y } from './camera';
import { ISO_BISECTIONS, rayBounds, siteFrame, toSite, viewRays, type V3 } from './volume-ray';
import { OCC_N, OCC_COARSE, OCC_LAYERS, OCC_TOP_KM } from '../radar/volume-pack';
import { VOLUME_MOMENTS } from '../radar/l2products';
import { fromHalf } from './half';
import type { Lut } from './raster';

/** 1 volume rendering, 2 isosurfaces, 3 distance of the first isosurface crossing (read back by the checks). */
export type ViewMode = 1 | 2 | 3;
export interface ViewParams {
  mode: ViewMode;
  /** Largest number of march samples per ray. */
  steps: number;
  /** Vertical exaggeration: world height above the radar = true height · vscale. */
  vscale: number;
  /** Speeds instead of signed codes: the volume threshold and surface 2 (inbound) apply to both sides of zero. */
  velocity: boolean;
  /**
   * Codes below this are empty space; it is compared with the occupancy grid (speeds for a velocity pack, less the
   * storm speed when the view is storm-relative).
   */
  emptyCode: number;
  /** Volume rendering: transparent below `thresholdCode`, full density at `fullCode`, `opacity` per km there. */
  thresholdCode: number; fullCode: number; opacity: number; lut: Lut;
  /** Isosurface codes (0 = surface off) and colours (0..1, alpha = opacity). */
  iso: [number, number]; colors: [number[], number[]];
}

/**
 * March steps at DEFAULT_STEPS samples per ray: the shortest step (km), a little under the gate length of the packs,
 * and its growth per km of ground range, half the width of an azimuth bin. Both shrink as the samples per ray grow.
 */
export const MIN_STEP_KM = 0.2, STEP_PER_RANGE_KM = (0.25 * Math.PI) / 180, DEFAULT_STEPS = 160;
/** A ray ends once it has gathered this much opacity. */
const OPAQUE = 0.96;
/** A skip over an empty part of the occupancy grid ends this far (km) past its wall, inside the next cell. */
const EXIT_PAST_KM = 0.02;
/** Central-difference offset (km, before exaggeration) of the isosurface normal. */
const GRADIENT_KM = 0.6;
const UNIFORM_FLOATS = 48;
const PREMUL: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
const TRIANGLE = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var tri = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(tri[i], 0.0, 1.0);
}
`;

const MARCH = /* wgsl */ `
struct ViewP {
  eye: vec4f,    // eye in site coordinates (km from the earth's centre; x east, y north, z up at the radar), w = vertical scale
  d0: vec4f,     // ray direction at the target's centre, w = target width (px)
  dx: vec4f,     // its change per NDC unit to the right, w = target height (px)
  dy: vec4f,     // and upward, w = radius of the radar level (km)
  bound: vec4f,  // RayBounds: ground, top, cylinder; w = diffuse intensity
  occ: vec4f,    // occupancy grid: cell km, world height of a bin (km), empty-space code; w = step km per km of ground range
  step: vec4f,   // mode, samples, shortest step km, step km per km of distance (one target pixel)
  tf: vec4f,     // volume: threshold code, full-density code, opacity per km, palette row
  iso: vec4f,    // code of surface 1 and of surface 2 (0 = off), velocity view, 0
  col1: vec4f, col2: vec4f,
  light: vec4f,  // light direction (site frame), diffuse exponent
};
@group(0) @binding(0) var<uniform> V: ViewP;
@group(0) @binding(1) var occTex: texture_2d_array<f32>;
@group(0) @binding(2) var lutTex: texture_2d<f32>;
@group(0) @binding(3) var lutS: sampler;
const EARTH = ${EARTH_KM}.0;
const VEL_ZERO = ${-VOLUME_MOMENTS.VEL.offset / VOLUME_MOMENTS.VEL.scale}.0;
${TRIANGLE}
// volume-ray.ts raySegment; (0, 0) when the ray misses.
fn raySegment(o: vec3f, d: vec3f) -> vec2f {
  let bd = dot(o, d); let top = bd * bd - V.bound.y;
  if (top <= 0.0) { return vec2f(0.0); }
  var t0 = max(-bd - sqrt(top), 0.0); var t1 = -bd + sqrt(top);
  let ground = bd * bd - V.bound.x;
  if (ground > 0.0 && bd < 0.0) { t1 = min(t1, -bd - sqrt(ground)); }
  let a = dot(d.xy, d.xy); let h = dot(o.xy, d.xy);
  if (a < 1e-12) { if (V.bound.z > 0.0) { return vec2f(0.0); } }
  else {
    let disc = h * h - a * V.bound.z;
    if (disc <= 0.0) { return vec2f(0.0); }
    t0 = max(t0, (-h - sqrt(disc)) / a); t1 = min(t1, (-h + sqrt(disc)) / a);
  }
  return vec2f(t0, t1);
}
// volume-ray.ts polarOf: azimuth (deg), ground range (km), height above the radar (km).
fn polarOf(p: vec3f) -> vec3f {
  let en = p.xy * (EARTH / p.z);
  var az = atan2(en.x, en.y) / VOL_RAD; az = az - 360.0 * floor(az / 360.0);
  return vec3f(az, length(en), (length(p) - V.dy.w) / V.eye.w);
}
// The pack's code at a site point (0 = no data); storm-relative when the pack has a motion set.
fn field(p: vec3f) -> f32 { let q = polarOf(p); return volumeStormRelative(volumeSample(q.x, q.y, q.z), q.x); }
// A code as surface k tests it: no data is below every surface, and the inbound surface (1) of a velocity view
// mirrors the code about zero velocity.
fn surfaceCode(c: f32, k: i32) -> f32 {
  if (c < 2.0) { return 0.0; }
  return select(c, 2.0 * VEL_ZERO - c, k == 1 && V.iso.z > 0.5);
}
fn occupancy(cell: vec2i, layer: i32) -> f32 { return textureLoad(occTex, cell, layer, 0).r * 255.0; }
// Distance (km) from p along d to where the ray's ground point leaves the square of occupancy cells with low corner
// lo and side n (cells). The ground point p.xy · EARTH / p.z moves along a straight line in one sense (ahead), so
// each of the two walls ahead is one linear equation; a wall the ray runs along is never reached.
fn cellExit(p: vec3f, d: vec3f, lo: vec2f, n: f32, ahead: vec2<bool>) -> f32 {
  let wall = (lo + select(vec2f(0.0), vec2f(n), ahead) - ${OCC_N / 2}.0) * V.occ.x;
  let den = EARTH * d.xy - wall * d.z;
  let tau = select((wall * p.z - EARTH * p.xy) / den, vec2f(1e9), abs(den) < vec2f(1e-3));
  return max(min(tau.x, tau.y), 0.0);
}
// Distance (km) from p (at radius r) along d to where the ray leaves height bin j: the sphere above it, or the one
// below it when the ray descends that far. The first and last bin are open downward and upward.
fn binExit(p: vec3f, d: vec3f, r: f32, j: i32) -> f32 {
  let pd = dot(p, d); let lo = V.dy.w + f32(j) * V.occ.y; let hi = lo + V.occ.y;
  var exit = 1e9;
  if (j < ${OCC_LAYERS - 1}) { exit = -pd + sqrt(max(pd * pd - (r - hi) * (r + hi), 0.0)); }
  let disc = pd * pd - (r - lo) * (r + lo);
  if (j > 0 && pd < 0.0 && disc > 0.0) { exit = min(exit, -pd - sqrt(disc)); }
  return max(exit, 0.0);
}
// Diffuse shade of surface k at distance t: the normal is the central-difference gradient towards lower codes.
fn shade(o: vec3f, d: vec3f, t: f32, k: i32) -> f32 {
  let p = o + d * t; let e = vec3f(${GRADIENT_KM}, ${GRADIENT_KM}, ${GRADIENT_KM} * V.eye.w);
  let g = vec3f(
    surfaceCode(field(p + vec3f(e.x, 0.0, 0.0)), k) - surfaceCode(field(p - vec3f(e.x, 0.0, 0.0)), k),
    surfaceCode(field(p + vec3f(0.0, e.y, 0.0)), k) - surfaceCode(field(p - vec3f(0.0, e.y, 0.0)), k),
    surfaceCode(field(p + vec3f(0.0, 0.0, e.z)), k) - surfaceCode(field(p - vec3f(0.0, 0.0, e.z)), k)) / e;
  let l = length(g);
  var n = -d;
  if (l > 1e-6) { n = -g / l; }
  return mix(0.35, 1.0, pow(max(dot(n, V.light.xyz), 0.0), 1.0 / max(V.light.w, 0.1))) * V.bound.w;
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ndc = vec2f(pos.x / V.d0.w * 2.0 - 1.0, 1.0 - pos.y / V.dx.w * 2.0);
  let d = normalize(V.d0.xyz + ndc.x * V.dx.xyz + ndc.y * V.dy.xyz);
  let o = V.eye.xyz;
  let seg = raySegment(o, d);
  if (seg.y <= seg.x) { return vec4f(0.0); }
  let mode = i32(V.step.x); let steps = i32(V.step.y); let vs = V.eye.w;
  var t = seg.x;
  // Volume rendering starts each ray, and resumes it after empty space, at a different fraction of a step, so that
  // banding becomes fine noise.
  var jitter = 0.0;
  if (mode == 1) { jitter = fract(52.9829189 * fract(dot(pos.xy, vec2f(0.06711056, 0.00583715)))); t += jitter * max(V.step.z, t * V.step.w); }
  var last = seg.x;       // a distance at or before t where the ray was outside every surface it is outside of
  var was = vec2f(0.0);   // surfaceCode of the previous sample
  var acc = vec4f(0.0);
  let ahead = d.xy * o.z - o.xy * d.z > vec2f(0.0);
  for (var i = 0; i < steps; i++) {
    if (t >= seg.y || acc.a > ${OPAQUE}) { break; }
    // The step: one target pixel at this distance, no finer than the data here (the shortest step near the radar,
    // growing with the ground range as the azimuth bins widen), and long enough to end within the samples left.
    let p = o + d * t;
    let base = max(max(max(V.step.z, V.occ.w * length(p.xy)), t * V.step.w), (seg.y - t) / f32(steps - i));
    // Empty space: where the occupancy grid is below the empty-space code over the point (its coarse column, its
    // column, then its cell), the ray goes on to just past where it leaves that part of the grid.
    var skip = -1.0;
    let cell = clamp(vec2i(floor(p.xy * (EARTH / p.z) / V.occ.x + ${OCC_N / 2}.0)), vec2i(0), vec2i(${OCC_N - 1}));
    let block = cell / ${OCC_COARSE};
    if (occupancy(block, ${OCC_LAYERS + 1}) < V.occ.z) { skip = cellExit(p, d, vec2f(block * ${OCC_COARSE}), ${OCC_COARSE}.0, ahead); }
    else if (occupancy(cell, ${OCC_LAYERS}) < V.occ.z) { skip = cellExit(p, d, vec2f(cell), 1.0, ahead); }
    else {
      let r = length(p); let j = clamp(i32(floor((r - V.dy.w) / V.occ.y)), 0, ${OCC_LAYERS - 1});
      if (occupancy(cell, j) < V.occ.z) { skip = min(cellExit(p, d, vec2f(cell), 1.0, ahead), binExit(p, d, r, j)); }
    }
    if (skip >= 0.0) { let adv = max(base, skip + ${EXIT_PAST_KM} + jitter * base); last = t + adv - base; t += adv; was = vec2f(0.0); continue; }
    let c = field(p);
    if (mode == 1) {
      let f = select(c, VEL_ZERO + abs(c - VEL_ZERO), V.iso.z > 0.5);
      if (c >= 2.0 && f >= V.tf.x) {
        let k = clamp((f - V.tf.x) / max(V.tf.y - V.tf.x, 1e-3), 0.0, 1.0);
        let col = textureSampleLevel(lutTex, lutS, vec2f(c / 255.0, V.tf.w), 0.0);
        // Opacity follows the true path length: the vertical part of the step is not exaggerated.
        let up = dot(d, p) / length(p);
        let len = base * sqrt(1.0 - up * up + up * up / (vs * vs));
        let a = (1.0 - exp(-V.tf.z * (0.015 + 0.985 * k * k * k) * len)) * col.a;
        acc += (1.0 - acc.a) * vec4f(col.rgb * a, a);
      }
    } else {
      // Isosurfaces: a surface is crossed where the ray comes from below its code; the crossing is refined by
      // bisection (volume-ray.ts firstCrossing) and the nearer of two crossings in one step is drawn first.
      var hit = vec2f(-1.0);
      for (var k = 0; k < 2; k++) {
        let g = surfaceCode(c, k);
        if (V.iso[k] > 0.0 && g >= V.iso[k] && was[k] < V.iso[k]) {
          var a = last; var b = t;
          for (var j = 0; j < ${ISO_BISECTIONS}; j++) {
            let m = 0.5 * (a + b);
            if (surfaceCode(field(o + d * m), k) >= V.iso[k]) { b = m; } else { a = m; }
          }
          hit[k] = b;
        }
        was[k] = g;
      }
      let first = select(0, 1, hit.y >= 0.0 && (hit.x < 0.0 || hit.y < hit.x));
      for (var n = 0; n < 2; n++) {
        let k = select(first, 1 - first, n == 1);
        if (hit[k] < 0.0) { continue; }
        if (mode == 3) { return vec4f(floor(hit[k]), fract(hit[k]), f32(k + 1), 1.0); }
        var col = V.col1;
        if (k == 1) { col = V.col2; }
        acc += (1.0 - acc.a) * vec4f(col.rgb * shade(o, d, hit[k], k) * col.a, col.a);
      }
    }
    last = t; t += base;
  }
  return acc;
}
`;

const COMPOSITE = COMMON + TRIANGLE + /* wgsl */ `
@group(1) @binding(0) var img: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = textureSampleLevel(img, smp, p.xy / F.viewport.xy, 0.0);
  if (c.a <= 0.002) { discard; }
  return c;
}
`;

/** Prepass GPU time (ms, smoothed) above which the target gets coarser, and below which it may get finer again. */
export const PREPASS_BUDGET_MS = 4, PREPASS_RELAX_MS = 2.5;
/**
 * Divisor of the backbuffer size for the next frame: 2 normally, 3 or 4 while the march costs more than the budget.
 * `ms` is the smoothed measured prepass time at `divisor`; the cost follows the number of target pixels, so a finer
 * target is tried only when its predicted time is under the relax level.
 */
export function nextDivisor(divisor: number, ms: number): number {
  if (ms > PREPASS_BUDGET_MS && divisor < 4) return divisor + 1;
  if (divisor > 2 && ms * (divisor / (divisor - 1)) ** 2 < PREPASS_RELAX_MS) return divisor - 1;
  return divisor;
}

/** The march target of one layer and its two pipelines. */
export class VolumeView {
  /**
   * The backbuffer size over `divisor` in each direction, premultiplied alpha; re-created when either changes.
   */
  target: GPUTexture | null = null;
  width = 0; height = 0;
  divisor = 2;
  private smoothedMs = 0; private settle = 0;
  private march: GPURenderPipeline;
  private marchLayout: GPUBindGroupLayout;
  private ubuf: GPUBuffer;
  private marchBG: { occ: GPUTexture; lut: GPUTexture; bg: GPUBindGroup } | null = null;
  private composite: GPURenderPipeline | null = null;
  private compositeLayout: GPUBindGroupLayout;
  private compositeBG: GPUBindGroup | null = null;

  constructor(private r: Renderer, private owner: string) {
    const d = r.gpu.device, F = GPUShaderStage.FRAGMENT;
    this.marchLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: F, buffer: { type: 'uniform' } }, { binding: 1, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 2, visibility: F, texture: { sampleType: 'float' } }, { binding: 3, visibility: F, sampler: { type: 'filtering' } }] });
    this.compositeLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: 'float' } }, { binding: 1, visibility: F, sampler: { type: 'filtering' } }] });
    const module = this.module('volume view', MARCH + volumeWgsl(1));
    this.march = d.createRenderPipeline({
      label: 'volume view', layout: d.createPipelineLayout({ bindGroupLayouts: [this.marchLayout, r.layouts.volume] }),
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.ubuf = d.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private module(label: string, code: string) {
    const module = this.r.gpu.device.createShaderModule({ code, label });
    module.getCompilationInfo().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error(`WGSL ${label}:${m.lineNum}:${m.linePos} ${m.message}`); });
    return module;
  }

  /**
   * Follows the measured GPU time of the prepasses (where the adapter has timestamp queries): the target gets
   * coarser while the march costs more than the budget. A change waits for the measurements of the new size.
   */
  private govern() {
    const r = this.r;
    if (!r.gpu.timestamps) return;
    this.smoothedMs += (r.gpuPrepassMs - this.smoothedMs) * 0.2;
    if (this.settle-- > 0) return;
    const next = nextDivisor(this.divisor, this.smoothedMs);
    if (next !== this.divisor) { this.smoothedMs *= (this.divisor / next) ** 2; this.divisor = next; this.settle = 20; }
  }

  private resize() {
    const g = this.r.gpu, w = Math.ceil(g.width / this.divisor), h = Math.ceil(g.height / this.divisor);
    if (this.target && w === this.width && h === this.height) return;
    this.target?.destroy();
    this.width = w; this.height = h;
    this.target = g.device.createTexture({ label: 'volume view', size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    g.trackTexture(this.target, w * h * 8, this.owner);
    this.compositeBG = null;
  }

  /** Step (km) per km of distance from the eye: the footprint of one target pixel. */
  get stepPerKm() { return (2 * Math.tan(FOV_Y / 2)) / Math.max(1, this.height); }
  /** The longest step (km) the march takes at distance `t` along a ray of length `length`, `axisKm` from the radar's vertical. */
  stepAt(t: number, length: number, axisKm: number, steps: number) {
    const fine = DEFAULT_STEPS / steps;
    return Math.max(MIN_STEP_KM * fine, STEP_PER_RANGE_KM * fine * axisKm, t * this.stepPerKm, length / steps);
  }

  /** The ViewP uniform for the renderer's camera and light, the pack's radar and `p`. */
  uniform(pack: GpuPack, site: { lon: number; lat: number; heightKm: number }, p: ViewParams): Float32Array<ArrayBuffer> {
    const r = this.r, frame = siteFrame(site.lon, site.lat), rays = viewRays(r.camera, frame);
    const b = rayBounds(rays.eye, site.heightKm, p.vscale, (pack.occKm * OCC_N) / 2);
    const l = r.light, ln = Math.hypot(l[0], l[1], l[2]) || 1, light = toSite(frame, [l[0] / ln, l[1] / ln, l[2] / ln] as V3, 1);
    const u = new Float32Array(UNIFORM_FLOATS);
    u.set([...rays.eye, p.vscale, ...rays.d0, this.width, ...rays.dx, this.height, ...rays.dy, b.radarKm, b.ground, b.top, b.cylinder, r.diffuseIntensity], 0);
    const fine = DEFAULT_STEPS / p.steps;
    u.set([pack.occKm, (OCC_TOP_KM / OCC_LAYERS) * p.vscale, p.emptyCode, STEP_PER_RANGE_KM * fine, p.mode, p.steps, MIN_STEP_KM * fine, this.stepPerKm], 20);
    u.set([p.thresholdCode, p.fullCode, p.opacity, p.lut.rows > 1 ? (r.flashRow + 0.5) / p.lut.rows : 0.5, p.iso[0], p.iso[1], p.velocity ? 1 : 0, 0], 28);
    u.set([...p.colors[0], ...p.colors[1], ...light, l[3]], 36);
    return u;
  }

  /** Encodes the march of `pack` (a radar at `site`) into the target. Called from the owner's prepass. */
  encode(ctx: PrepassContext, pack: GpuPack, site: { lon: number; lat: number; heightKm: number }, p: ViewParams) {
    const g = this.r.gpu, d = g.device;
    this.govern();
    this.resize();
    d.queue.writeBuffer(this.ubuf, 0, this.uniform(pack, site, p));
    if (this.marchBG?.occ !== pack.occ || this.marchBG.lut !== p.lut.tex) {
      this.marchBG = { occ: pack.occ, lut: p.lut.tex, bg: d.createBindGroup({ layout: this.marchLayout, entries: [
        { binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: pack.occ.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: p.lut.tex.createView() }, { binding: 3, resource: g.samplers.lut }] }) };
    }
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: this.target!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }], timestampWrites: ctx.timing() });
    pass.setPipeline(this.march);
    pass.setBindGroup(0, this.marchBG.bg);
    pass.setBindGroup(1, pack.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Composites the target over what the main pass has drawn so far. */
  draw(ctx: DrawContext) {
    if (!this.target || ctx.probe) return;
    const g = this.r.gpu, d = g.device;
    if (!this.composite) {
      const module = this.module('volume view composite', COMPOSITE);
      this.composite = d.createRenderPipeline({
        label: 'volume view composite', layout: d.createPipelineLayout({ bindGroupLayouts: [this.r.frameBGL, this.compositeLayout] }),
        vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: g.format, blend: PREMUL }] },
        primitive: { topology: 'triangle-list' }, multisample: { count: g.sampleCount },
      });
    }
    this.compositeBG ??= d.createBindGroup({ layout: this.compositeLayout, entries: [{ binding: 0, resource: this.target.createView() }, { binding: 1, resource: g.samplers.linear }] });
    ctx.pass.setPipeline(this.composite);
    ctx.pass.setBindGroup(1, this.compositeBG);
    ctx.pass.draw(3);
  }

  /** The composite pipeline follows the main pass's sample count. */
  invalidate() { this.composite = null; }

  /** Reads the target back (after the frame that encoded it was submitted): width × height RGBA, row 0 at the top. */
  async read(): Promise<Float32Array> {
    const d = this.r.gpu.device, stride = Math.ceil((this.width * 8) / 256) * 256;
    const buf = d.createBuffer({ size: stride * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.target! }, { buffer: buf, bytesPerRow: stride }, [this.width, this.height]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const rows = new Uint16Array(buf.getMappedRange()), out = new Float32Array(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) out.set(fromHalf(rows.subarray((y * stride) / 2, (y * stride) / 2 + this.width * 4)), y * this.width * 4);
    buf.unmap(); buf.destroy();
    return out;
  }

  destroy() { this.target?.destroy(); this.target = null; this.ubuf.destroy(); }
}
