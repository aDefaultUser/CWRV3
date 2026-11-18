// GPU side of the volume packs (radar/volume-pack.ts): VolumeStore keeps uploaded packs under the identity they were
// requested for, VOLUME_WGSL mirrors the direct polar sampler of radar/volume-sample.ts, and VolumeSection renders a
// vertical section with it (the model for cross-section and volume passes run from a layer's prepass).
import type { Renderer, PrepassContext } from './renderer';
import { pool } from '../workers/pool';
import { PACK_ROWS, PACK_MAX_TILTS, type VolumePack, type PackTilt } from '../radar/volume-pack';
import { BEAM_DEG, KE_KM, BEAM_CURVE_KM } from '../radar/volume-sample';
import { AZ_BIN0, type VolumeMoment } from '../radar/l2products';
import type { L2VolumeArgs } from '../workers/l2-volumes';

/** What a pack is requested for. Two requests with equal packKey mean the same data. */
export interface PackRequest {
  site: string; url: string; live: boolean; chunks?: string[];
  moment: VolumeMoment;
  /** Tilt selection among SAILS / MRLE rescans (settings.nexradLatestUpdateMode ≥ 1) and the velocity dealiasing mode. */
  latest: boolean; qualityDealiasing: boolean;
  /** How much of a volume still arriving this request saw (e.g. sweep and radial counts); empty for a complete one. */
  version?: string;
  /** Radar position (deg, km above sea level), written to the pack's uniform. */
  lon: number; lat: number; heightKm: number;
}

/** Pack identity: site | volume | moment | algorithm inputs | tilt set. */
export const packKey = (q: PackRequest) =>
  `${q.site}|${q.url}|${q.moment}|${q.moment === 'VEL' ? q.qualityDealiasing : ''}|${q.latest ? 'latest' : 'first'}${q.version ? `:${q.version}` : ''}`;
/** The identity without the arrival state: equal for the successive states of one live volume. */
const baseKey = (q: PackRequest) => packKey({ ...q, version: '' });

export interface GpuPack {
  key: string; moment: VolumeMoment; width: number;
  /** Ascending elevation; tilt k is array layer k. */
  tilts: PackTilt[];
  /** r8unorm 2D-array texture, PACK_ROWS × width per layer: texel (gate, bin + 1) holds a byte code (VOLUME_MOMENTS). */
  tex: GPUTexture;
  /** The VolumeP uniform of VOLUME_WGSL (site, grid, motion, tilt table); see writeHead for the layout. */
  ubuf: GPUBuffer;
  /** Bind group on `renderer.layouts.volume` (binding 0 the uniform, binding 1 the texture). */
  bindGroup: GPUBindGroup;
  /** Earliest radial time of the pack (epoch ms); the uniform's scan times are seconds after it. */
  timeMs: number;
  bytes: number;
}

const HEAD_FLOATS = 12, TILT_FLOATS = 12, UNIFORM_FLOATS = HEAD_FLOATS + PACK_MAX_TILTS * TILT_FLOATS;
/** A pack nobody asked for during this many frames is dropped: its result is discarded and its upload abandoned. */
const STALE_FRAMES = 3;
const UPLOADS_PER_FRAME = 2;
const RETRY_MS = 10_000;

interface Entry { key: string; base: string; seq: number; used: number; gpu?: GpuPack; pending?: VolumePack; uploaded: number; error?: string; failedAt?: number; motion?: string }

/**
 * Volume packs on the GPU. `get` returns the pack for a request once every tilt is uploaded and requests it on first
 * use; a result is applied only under the identity it was requested for (clear() and requests no longer asked for
 * discard results in flight). While a newer state of a live volume loads, its previous state (the same identity but
 * for how much has arrived) stays in use and is freed when the newer one is ready. Packs are kept
 * least-recently-used within a VRAM budget. The owner calls `pump` once per frame (from its prepass); it uploads at
 * most two tilt layers.
 */
export class VolumeStore {
  private entries = new Map<string, Entry>();
  private uploading: Entry[] = [];
  private gen = 0;
  private frame = 0;
  private seq = 0;
  constructor(private r: Renderer, private owner: string, public budgetBytes = 256 * 1048576) {}

  get(q: PackRequest): GpuPack | null {
    const key = packKey(q);
    let e = this.entries.get(key);
    if (e?.error && performance.now() - e.failedAt! > RETRY_MS) { this.entries.delete(key); e = undefined; }
    if (!e) { e = { key, base: baseKey(q), seq: ++this.seq, used: this.frame, uploaded: 0 }; this.entries.set(key, e); void this.load(e, q); }
    e.used = this.frame;
    const ready = (x: Entry) => !!x.gpu && !x.pending;
    if (e.key === e.base) return ready(e) ? e.gpu! : null; // a complete volume has no earlier states
    const earlier = [...this.entries.values()].filter((x) => x.base === e.base && x.seq < e.seq && ready(x)).sort((a, b) => b.seq - a.seq);
    if (ready(e)) { for (const x of earlier) this.drop(x); return e.gpu!; }
    if (earlier[0]) earlier[0].used = this.frame;
    return earlier[0]?.gpu ?? null;
  }

  /** State of the exact request: 'loading', 'uploading', 'ready' or the error. */
  state(q: PackRequest): string {
    const e = this.entries.get(packKey(q));
    return !e ? 'loading' : e.error ?? (e.pending ? 'uploading' : e.gpu ? 'ready' : 'loading');
  }

  private async load(e: Entry, q: PackRequest) {
    const gen = this.gen;
    const mine = () => gen === this.gen && this.entries.get(e.key) === e;
    try {
      const args: L2VolumeArgs = { url: q.url, live: q.live, chunks: q.chunks, moment: q.moment, latest: q.latest, qualityDealiasing: q.qualityDealiasing };
      const res = await pool.for(this.owner).run<{ pack: VolumePack | null }>('l2.volume', args, q.url);
      if (!mine()) return; // the store was cleared (another site) while this was in flight
      if (this.frame - e.used > STALE_FRAMES) { this.entries.delete(e.key); return; } // another product, tilt set or volume is wanted now
      if (!res.pack) { e.error = 'moment not in this volume'; e.failedAt = performance.now(); return; }
      this.begin(e, res.pack, q);
    } catch (err) {
      if (mine()) { e.error = (err as Error).message; e.failedAt = performance.now(); }
    }
  }

  private begin(e: Entry, pack: VolumePack, q: PackRequest) {
    const g = this.r.gpu, d = g.device, layers = pack.tilts.length;
    const tex = d.createTexture({ label: `volume ${e.key}`, size: [pack.width, PACK_ROWS, layers], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const bytes = pack.width * PACK_ROWS * layers;
    g.trackTexture(tex, bytes, this.owner);
    const timeMs = Math.min(...pack.tilts.map((t) => t.startMs));
    const ubuf = d.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(ubuf, 0, writeHead(pack, q, timeMs));
    const bindGroup = d.createBindGroup({ layout: this.r.layouts.volume, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: tex.createView({ dimension: '2d-array' }) }] });
    e.gpu = { key: e.key, moment: pack.moment, width: pack.width, tilts: pack.tilts, tex, ubuf, bindGroup, timeMs, bytes };
    e.pending = pack; e.uploaded = 0;
    this.uploading.push(e);
    this.evict();
  }

  /** Advances one frame: uploads up to two tilt layers and abandons uploads nobody asks for any more. */
  pump() {
    this.frame++;
    let left = UPLOADS_PER_FRAME;
    while (left > 0 && this.uploading.length) {
      const e = this.uploading[0], pack = e.pending!;
      if (this.frame - e.used > STALE_FRAMES) { this.drop(e); continue; }
      this.r.gpu.write(e.gpu!.tex, pack.width, PACK_ROWS, pack.layers[e.uploaded], 1, [0, 0, e.uploaded], this.owner);
      left--;
      if (++e.uploaded === pack.layers.length) { e.pending = undefined; this.uploading.shift(); }
    }
  }

  /**
   * Sets the storm motion volumeStormRelative applies to a velocity pack (null = ground-relative). Only the uniform
   * changes, so a new motion needs no new pack.
   */
  setMotion(pack: GpuPack, m: { speedKt: number; fromDeg: number } | null) {
    const e = this.entries.get(pack.key), key = m ? `${m.speedKt}/${m.fromDeg}` : '';
    if (pack.moment !== 'VEL' || !e || e.gpu !== pack || (e.motion ?? '') === key) return;
    e.motion = key;
    this.r.gpu.device.queue.writeBuffer(pack.ubuf, 32, new Float32Array([m?.speedKt ?? 0, m?.fromDeg ?? 0, m ? 1 : 0, 0]));
  }

  /** Bytes of pack textures held now. */
  get bytes() { let n = 0; for (const e of this.entries.values()) n += e.gpu?.bytes ?? 0; return n; }

  private drop(e: Entry) {
    e.gpu?.tex.destroy(); e.gpu?.ubuf.destroy();
    this.entries.delete(e.key);
    this.uploading = this.uploading.filter((x) => x !== e);
  }

  /** Least recently used packs go first; a pack asked for this frame or the last is never evicted. */
  private evict() {
    let total = this.bytes;
    const old = [...this.entries.values()].filter((e) => e.gpu && e.used < this.frame - 1).sort((a, b) => a.used - b.used);
    for (const e of old) { if (total <= this.budgetBytes) break; total -= e.gpu!.bytes; this.drop(e); }
  }

  /** Drops every pack and discards the results in flight (site change). */
  clear() {
    this.gen++;
    for (const e of [...this.entries.values()]) this.drop(e);
  }
}

/**
 * VolumeP as floats: site (lon, lat, height km, tilt count); grid (width, rows, beamwidth deg, velocity: nearest tilt
 * only); motion (speed kt, from deg, storm-relative on, 0) at byte 32; then per tilt geo (elevation deg, first gate km,
 * gate km, gates), scan (radials, first and last radial in seconds after `timeMs`, 0) and dir (cos and sin of the
 * elevation, 0, 0).
 */
function writeHead(pack: VolumePack, q: PackRequest, timeMs: number): Float32Array<ArrayBuffer> {
  const u = new Float32Array(UNIFORM_FLOATS);
  u.set([q.lon, q.lat, q.heightKm, pack.tilts.length, pack.width, PACK_ROWS, BEAM_DEG, pack.moment === 'VEL' ? 1 : 0], 0);
  pack.tilts.forEach((t, k) => {
    const el = (t.elevation * Math.PI) / 180;
    u.set([t.elevation, t.firstKm, t.gateKm, t.gates, t.radials, (t.startMs - timeMs) / 1000, (t.endMs - timeMs) / 1000, 0, Math.cos(el), Math.sin(el), 0, 0], HEAD_FLOATS + k * TILT_FLOATS);
  });
  return u;
}

/**
 * WGSL of the volume sampler for bind group `group` (layout `renderer.layouts.volume`, a GpuPack's bindGroup).
 * Entry points, mirroring radar/volume-sample.ts:
 *  - volumeSample(az deg, ground range km, height km above the radar) → code, 0 = no data (sampleVolume);
 *  - volTiltCode(tilt, az, ground range) → raw code of one tilt (tiltCode);
 *  - volBeamThrough(ground range, height) → vec2(slant range km, elevation deg) (beamThrough);
 *  - volumeStormRelative(code, az) → velocity code relative to VOL.motion (stormRelativeCode).
 * Values are code · scale + offset (VOLUME_MOMENTS). The sampler takes each tilt's sin and cos from the uniform and
 * evaluates the small earth-centre angle and elevation differences by series, so its result does not depend on the
 * precision of the driver's trigonometric functions.
 */
export const volumeWgsl = (group: number) => /* wgsl */ `
struct VolumeTilt { geo: vec4f, scan: vec4f, dir: vec4f };
struct VolumeP { site: vec4f, grid: vec4f, motion: vec4f, tilts: array<VolumeTilt, ${PACK_MAX_TILTS}> };
@group(${group}) @binding(0) var<uniform> VOL: VolumeP;
@group(${group}) @binding(1) var volTex: texture_2d_array<f32>;
const VOL_KE = ${KE_KM};
const VOL_CURVE = ${BEAM_CURVE_KM};
const VOL_RAD = 0.017453292519943295;
// sin and cos of the earth-centre angle of ground range s (under 0.12 rad within 1000 km, where the series are exact in f32).
fn volArc(s: f32) -> vec2f {
  let p = s / VOL_KE; let q = p * p;
  return vec2f(p * (1.0 - q / 6.0 * (1.0 - q / 20.0)), 1.0 - q / 2.0 * (1.0 - q / 12.0 * (1.0 - q / 30.0)));
}
// Slant range (km) along tilt k's beam over the ground range with arc sin/cos sc.
fn volSlantRange(k: i32, sc: vec2f) -> f32 { let d = VOL.tilts[k].dir; return VOL_KE * sc.x / (d.x * sc.y - d.y * sc.x); }
// (r·cos(el), r·sin(el)) of the beam through that ground range at height h.
fn volBeam(sc: vec2f, h: f32) -> vec2f {
  let t = sc.x / sc.y;
  let a = 1.0 + t * t; let b = VOL_CURVE + 2.0 * VOL_KE * t * t; let c = VOL_KE * VOL_KE * t * t - VOL_CURVE * h;
  let w = -2.0 * c / (b + sqrt(b * b - 4.0 * a * c));
  return vec2f((VOL_KE + w) * t, w);
}
fn volBeamThrough(s: f32, h: f32) -> vec2f { let uw = volBeam(volArc(s), h); return vec2f(length(uw), atan2(uw.y, uw.x) / VOL_RAD); }
// Degrees by which the beam uw lies above tilt k; ±90 when more than about 5° apart (farther than any zone reaches).
fn volAbove(k: i32, uw: vec2f) -> f32 {
  let d = VOL.tilts[k].dir;
  let num = uw.y * d.x - uw.x * d.y; let den = uw.x * d.x + uw.y * d.y;
  if (abs(num) > 0.09 * den) { return sign(num) * 90.0; }
  let q = num / den; let q2 = q * q;
  return q * (1.0 - q2 / 3.0 * (1.0 - 0.6 * q2)) / VOL_RAD;
}
fn volTiltCode(k: i32, az: f32, s: f32) -> f32 {
  let t = VOL.tilts[k].geo;
  let g = i32(floor((volSlantRange(k, volArc(s)) - t.y) / t.z + 0.5));
  if (g < 0 || g >= i32(t.w)) { return 0.0; }
  let bins = i32(VOL.grid.y) - 2;
  let bin = ((i32(floor((az - ${AZ_BIN0}) * 2.0 + 0.5)) % bins) + bins) % bins;
  return round(textureLoad(volTex, vec2i(g, bin + 1), k, 0).r * 255.0);
}
fn volValid(c: f32) -> f32 { return select(0.0, c, c >= 2.0); }
fn volumeSample(az: f32, s: f32, h: f32) -> f32 {
  let n = i32(VOL.site.w);
  if (n == 0 || !(s > 0.0)) { return 0.0; }
  let uw = volBeam(volArc(s), h); let beam = VOL.grid.z; let half = beam * 0.5;
  var hi = 0; var below = 1e9; var above = 1e9;
  while (hi < n) {
    let d = volAbove(hi, uw);
    if (d <= 0.0) { above = -d; break; }
    below = d; hi++;
  }
  let lo = hi - 1;
  if (min(below, above) <= half) { return volValid(volTiltCode(select(hi, lo, below <= above), az, s)); }
  if (lo < 0 || hi >= n || below + above > 2.0 * beam) { return 0.0; }
  let w = (below - half) / (below + above - beam);
  if (VOL.grid.w > 0.5) { return volValid(volTiltCode(select(hi, lo, w < 0.5), az, s)); }
  let a = volTiltCode(lo, az, s); let b = volTiltCode(hi, az, s);
  if (a < 2.0 || b < 2.0) { return 0.0; }
  return a + (b - a) * w;
}
fn volumeStormRelative(code: f32, az: f32) -> f32 {
  if (code < 2.0 || VOL.motion.z < 0.5) { return code; }
  return clamp(code + VOL.motion.x * cos((az - VOL.motion.y) * VOL_RAD), 2.0, 255.0);
}
`;

const SECTION = /* wgsl */ `
struct SectionP { line: vec4f, ext: vec4f };  // line: a east, a north, b east, b north (km); ext: width, height, top km, 0
@group(0) @binding(0) var<uniform> S: SectionP;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var tri = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(tri[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let f = p.xy / S.ext.xy;
  let q = mix(S.line.xy, S.line.zw, f.x);
  var az = atan2(q.x, q.y) / VOL_RAD; az = az - 360.0 * floor(az / 360.0);
  return vec4f(volumeStormRelative(volumeSample(az, length(q), f.y * S.ext.z), az), 0.0, 0.0, 1.0);
}
`;

/** A section line: end points in km east and north of the radar, and the height (km above the radar) of the top row. */
export interface SectionLine { a: [number, number]; b: [number, number]; topKm: number }

/** Azimuth (deg), ground range (km) and height (km) of section pixel (x, y) of `width` × `height`; row 0 is lowest. */
export function sectionPoint(l: SectionLine, x: number, y: number, width: number, height: number): { az: number; s: number; h: number } {
  const fx = (x + 0.5) / width, e = l.a[0] + (l.b[0] - l.a[0]) * fx, n = l.a[1] + (l.b[1] - l.a[1]) * fx;
  return { az: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360, s: Math.hypot(e, n), h: ((y + 0.5) / height) * l.topKm };
}

/**
 * Vertical section of a pack along a line, sampled on the GPU into an r32float target of codes (0 = no data; velocity
 * packs with a motion set are storm-relative). `encode` is called from a prepass; `tex` can then be drawn in the main
 * pass or read back.
 */
export class VolumeSection {
  readonly tex: GPUTexture;
  private pipe: GPURenderPipeline;
  private ubuf: GPUBuffer;
  private bg: GPUBindGroup;
  constructor(private r: Renderer, readonly width: number, readonly height: number, owner: string) {
    const g = r.gpu, d = g.device;
    this.tex = d.createTexture({ size: [width, height], format: 'r32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    g.trackTexture(this.tex, width * height * 4, owner);
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const module = d.createShaderModule({ code: SECTION + volumeWgsl(1), label: 'volume section' });
    module.getCompilationInfo().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error(`WGSL volume section:${m.lineNum}:${m.linePos} ${m.message}`); });
    this.pipe = d.createRenderPipeline({
      label: 'volume section', layout: d.createPipelineLayout({ bindGroupLayouts: [layout, r.layouts.volume] }),
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.ubuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bg = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });
  }

  encode(ctx: PrepassContext, pack: GpuPack, line: SectionLine) {
    this.r.gpu.device.queue.writeBuffer(this.ubuf, 0, new Float32Array([...line.a, ...line.b, this.width, this.height, line.topKm, 0]));
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: this.tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }], timestampWrites: ctx.timing() });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bg);
    pass.setBindGroup(1, pack.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Reads the target back (after the frame that encoded it was submitted): width × height codes, row 0 lowest. */
  async read(): Promise<Float32Array> {
    const d = this.r.gpu.device, stride = Math.ceil((this.width * 4) / 256) * 256;
    const buf = d.createBuffer({ size: stride * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.tex }, { buffer: buf, bytesPerRow: stride }, [this.width, this.height]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const rows = new Float32Array(buf.getMappedRange()), out = new Float32Array(this.width * this.height);
    for (let y = 0; y < this.height; y++) out.set(rows.subarray((y * stride) / 4, (y * stride) / 4 + this.width), y * this.width);
    buf.unmap(); buf.destroy();
    return out;
  }

  destroy() { this.tex.destroy(); this.ubuf.destroy(); }
}
