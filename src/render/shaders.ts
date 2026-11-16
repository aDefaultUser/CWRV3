// WGSL sources (independently written for CWRV3).
export const COMMON = /* wgsl */ `
struct Frame {
  vpRot: mat4x4f,
  eye: vec4f,       // xyz eye (unit sphere world), w = seconds
  viewport: vec4f,  // width, height (device px), dpr, flash row (0|1)
  light: vec4f,     // xyz light direction (world), w = diffuse exponent
  misc: vec4f,      // zoom scale, metres per device px, diffuse intensity, globe lighting on
};
@group(0) @binding(0) var<uniform> F: Frame;
const PI = 3.14159265358979;
const DEG = 57.29577951308232;
fn toClip(p: vec3f) -> vec4f { return F.vpRot * vec4f(p - F.eye.xyz, 1.0); }
fn frontFacing(p: vec3f) -> bool { return dot(F.eye.xyz - p, p) > -1e-6; }
fn lonLatOf(p: vec3f) -> vec2f { let n = normalize(p); return vec2f(atan2(n.y, n.x), asin(clamp(n.z, -1.0, 1.0))) * DEG; }
fn xyzOf(lon: f32, lat: f32) -> vec3f { let lo = lon / DEG; let la = lat / DEG; return vec3f(cos(la) * cos(lo), cos(la) * sin(lo), sin(la)); }
fn globeShade(p: vec3f) -> f32 {
  if (F.misc.w < 0.5) { return 1.0; }
  let d = max(dot(normalize(p), normalize(F.light.xyz)), 0.0);
  return mix(0.35, 1.0, pow(d, 1.0 / max(F.light.w, 0.1))) * F.misc.z;
}
`;

// ------------------------------------------------------------------------------------------- sky
export const SKY = COMMON + /* wgsl */ `
struct Sky { invVP: mat4x4f, bg: vec4f, atm: vec4f, atm2: vec4f }; // atm: on, height, intensity, stars; atm2.x: inner glow limit
@group(1) @binding(0) var<uniform> S: Sky;
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var tri = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)); let p = tri[i];
  var o: VO; o.pos = vec4f(p, 0.0, 1.0); o.ndc = p; return o;
}
fn hash(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(12.9898, 78.233, 45.164))) * 43758.5453); }
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let a = S.invVP * vec4f(v.ndc, 0.0, 1.0); let b = S.invVP * vec4f(v.ndc, 1.0, 1.0);
  let o = F.eye.xyz; let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  var col = S.bg.rgb;
  let B = dot(o, dir); let dmin = length(o - dir * B);
  if (S.atm.w > 0.5 && dmin > 1.0) {
    let q = floor(dir * 700.0);
    let h = hash(q);
    if (h > 0.9985) { col += vec3f(0.55 + 0.45 * hash(q + 1.0)) * smoothstep(0.9985, 1.0, h) * 1.6; }
  }
  if (S.atm.x > 0.5 && B < 0.0) {
    let H = S.atm.y / 6371.0 * 3.0;
    let g = exp(-max(dmin - 1.0, 0.0) / H) * S.atm.z;
    col += vec3f(0.25, 0.5, 1.0) * g * select(S.atm2.x, 1.0, dmin > 1.0);
  }
  return vec4f(col, 1.0);
}
`;

// ------------------------------------------------------------------------------------------- tiles
export const TILES = COMMON + /* wgsl */ `
struct Tile { z: f32, x: f32, y: f32, imgSlot: f32, img: vec4f, terSlot: f32, flags: f32, pad: vec2f, ter: vec4f };
struct TileParams {
  ocean: vec4f,          // rgb ocean color, a = ocean mode (-1 off)
  grid: vec4f,           // rgb color, a = alpha (0 off)
  gridP: vec4f,          // spacing deg, width px, oceanOnly, additive
  adj: vec4f,            // brightness, contrast, saturation, imagery on
  terr: vec4f,           // tint on, shading mode, terrain on, height exaggeration
  light: vec4f,          // light azimuth deg, zenith deg, tint before lighting, coast mode
  coast: vec4f,          // rgb coastline color, exponent
  extra: vec4f,          // ocean gloss, highlight, water coeff, mapBg mix
  shade: vec4f,          // hillshade darkest multiplier, brightest multiplier, fixed light on, terrain alpha
  tint2: vec4f,          // hypsometric range low m, high m, tint before lighting, ocean-only height m
  water: vec4f,          // constrain to light (0 off, 1 lit side, 2 unlit side), performance water, light wave, -
  spec: vec4f,           // globe specular exponent, intensity, HDR on, HDR white point
  bgc: vec4f,            // map background rgb (terrain alpha blends toward it)
};
@group(1) @binding(0) var<uniform> T: TileParams;
@group(1) @binding(1) var<storage, read> tiles: array<Tile>;
@group(1) @binding(2) var imgTex: texture_2d_array<f32>;
@group(1) @binding(3) var terTex: texture_2d_array<f32>;
@group(1) @binding(4) var samp: sampler;
@group(1) @binding(5) var hypso: texture_2d<f32>;
@group(1) @binding(6) var imgSamp: sampler; // mipmapped imagery, anisotropic per setting
struct VO { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) @interpolate(flat) inst: u32, @location(2) uv: vec2f };
const N = 16u;
fn elevAt(t: Tile, uv: vec2f) -> f32 {
  let c = textureSampleLevel(terTex, samp, t.ter.xy + uv * t.ter.z, i32(t.terSlot), 0.0) * 255.0;
  return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0;
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let t = tiles[ii];
  let q = vi % 6u; let cell = vi / 6u;
  let cx = cell % N; let cy = cell / N;
  var corners = array(vec2u(0u,0u), vec2u(1u,0u), vec2u(0u,1u), vec2u(0u,1u), vec2u(1u,0u), vec2u(1u,1u)); let corner = corners[q];
  let uv = vec2f(f32(cx + corner.x), f32(cy + corner.y)) / f32(N);
  let n = exp2(t.z);
  let X = (t.x + uv.x) / n; let Y = (t.y + uv.y) / n;
  let lon = X * 360.0 - 180.0;
  let lat = atan(sinh(PI * (1.0 - 2.0 * Y))) * DEG;
  var p = xyzOf(lon, lat);
  if (T.terr.z > 0.5 && T.terr.w > 0.0 && t.terSlot >= 0.0) {
    let e = max(elevAt(t, uv), 0.0);
    p = p * (1.0 + e * T.terr.w / 6371000.0);
  }
  var o: VO; o.pos = toClip(p); o.world = p; o.inst = ii; o.uv = uv; return o;
}
fn hillshade(t: Tile, uv: vec2f, lat: f32) -> f32 {
  let d = 1.0 / 256.0;
  let ex = elevAt(t, uv + vec2f(d, 0.0)) - elevAt(t, uv - vec2f(d, 0.0));
  let ey = elevAt(t, uv + vec2f(0.0, d)) - elevAt(t, uv - vec2f(0.0, d));
  let mpt = 40075016.0 * cos(lat / DEG) / (256.0 * exp2(t.z)) * t.ter.z * 2.0;
  let nrm = normalize(vec3f(-ex / mpt, ey / mpt, 1.0) * vec3f(1.5, 1.5, 1.0));
  let L = terrainLight(lat);
  return clamp(dot(nrm, normalize(vec3f(L.x, L.y, L.z + 0.6))), 0.0, 1.0);
}
var<private> gWorld: vec3f;
// Fixed light: azimuth/zenith in the local frame. Otherwise the globe light (light point) in the local east/north/up frame.
fn terrainLight(lat: f32) -> vec3f {
  if (T.shade.z > 0.5) {
    let az = T.light.x / DEG; let ze = T.light.y / DEG;
    return vec3f(sin(az) * sin(ze), cos(az) * sin(ze), cos(ze));
  }
  let up = normalize(gWorld); let east = normalize(vec3f(-up.y, up.x, 0.0) + vec3f(1e-6, 0.0, 0.0)); let north = cross(up, east);
  let l = normalize(F.light.xyz);
  return vec3f(dot(l, east), dot(l, north), max(dot(l, up), 0.15));
}
// Tint coordinate over the hypsometric palette: fixed −6000…5000 m, or the visible range when dynamic range is on.
fn tintCoord(elev: f32) -> f32 {
  let lo = T.tint2.x; let hi = T.tint2.y;
  if (elev <= 0.0 || lo < -5999.0) { return clamp((elev + 6000.0) / 11000.0, 0.0, 1.0); }
  let f = clamp((elev - max(lo, 0.0)) / max(hi - max(lo, 0.0), 1.0), 0.0, 1.0);
  return 6000.0 / 11000.0 + f * 5000.0 / 11000.0;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  if (!frontFacing(v.world)) { discard; }
  let t = tiles[v.inst];
  gWorld = v.world;
  let ll = lonLatOf(v.world);
  let fwx = fwidth(ll.x); let fwy = fwidth(ll.y);
  // Imagery texture gradients, taken in uniform control flow for the mip/anisotropic lookup below.
  let iuv = t.img.xy + v.uv * t.img.z;
  let igx = dpdx(iuv); let igy = dpdy(iuv);
  var col = vec3f(0.0, 0.0, 0.0);
  var elev = 1.0;
  let hasTer = t.terSlot >= 0.0 && T.terr.z > 0.5;
  if (hasTer) { elev = elevAt(t, v.uv); }
  let hasImg = T.adj.w > 0.5 && t.imgSlot >= 0.0;
  if (hasImg) {
    var c = textureSampleGrad(imgTex, imgSamp, iuv, i32(t.imgSlot), igx, igy).rgb;
    c = (c - 0.5) * (1.0 + T.adj.y * 0.5) + 0.5 + (T.adj.x - 0.39) * 0.25;
    let g = dot(c, vec3f(0.299, 0.587, 0.114));
    col = mix(vec3f(g), c, 0.45 + T.adj.z * 0.5) * 0.95;
  }
  if (hasTer) {
    if (T.terr.x > 0.5 && (!hasImg)) {
      let tint = textureSampleLevel(hypso, samp, vec2f(tintCoord(elev), 0.25), 0.0).rgb;
      col = tint;
    }
    if (T.terr.y > 0.5 && elev > 0.0) {
      let hs = hillshade(t, v.uv, ll.y);
      let k = select(0.75, 1.0, T.terr.y > 1.5);
      let m = mix(1.0, T.shade.x + (T.shade.y - T.shade.x) * hs, k);
      // Tint after lighting: relief is added to the flat tint instead of scaling it (tint keeps its colour).
      if (T.tint2.z > 0.5 || hasImg || T.terr.x < 0.5) { col = col * m; } else { col = clamp(col + vec3f((m - 1.0) * 0.35), vec3f(0.0), vec3f(1.0)); }
    }
    if (T.ocean.a >= 0.0 && elev <= T.tint2.w) {
      var oc = T.ocean.rgb;
      let nW = normalize(v.world);
      // Water effects can be limited to the lit (or, inverse, the unlit) side of the globe light.
      let lit = clamp(dot(nW, normalize(F.light.xyz)) * 4.0 + 0.5, 0.0, 1.0);
      let wk = select(1.0, select(lit, 1.0 - lit, T.water.x > 1.5), T.water.x > 0.5);
      var wave = 0.0;
      if (T.ocean.a >= 2.0) { wave = sin(ll.x * 900.0 + F.eye.w * 1.3) * sin(ll.y * 1100.0 - F.eye.w * 0.9); }
      if (T.ocean.a >= 1.0 && T.water.y < 0.5) {
        let vdir = normalize(F.eye.xyz - v.world);
        let h = normalize(vdir + normalize(F.light.xyz));
        // Light wave: the ripple also modulates the highlight (off: a steady highlight).
        let glint = select(1.0, 1.0 + 0.6 * wave, T.water.z > 0.5);
        oc += vec3f(pow(max(dot(nW, h), 0.0), 40.0 * T.extra.x)) * T.extra.y * 0.5 * glint * wk;
      }
      if (T.ocean.a >= 2.0) { oc *= 1.0 + wave * 0.06 * T.extra.z * wk; }
      if (T.light.w > 0.5) {
        let shallow = clamp(1.0 + elev / 400.0, 0.0, 1.0);
        let k = select(pow(shallow, 1.0 / max(T.coast.w, 0.01)), step(0.7, shallow), T.light.w > 1.5);
        oc = mix(oc, T.coast.rgb * 0.18 + oc, k * 0.5);
      }
      // With imagery, the ocean colour is lifted to a navy mid-tone and modulated by the bathymetry imagery's
      // brightness, so shelves stay visible (tuned toward the ocean tone of the supplied screenshot).
      // Deep water stays navy; shelves brighten moderately with the bathymetry brightness (no cyan wash).
      let shelf = 0.95 + 2.2 * dot(col, vec3f(0.299, 0.587, 0.114));
      col = select(oc, min((oc * 1.9 + vec3f(0.12, 0.19, 0.16)) * shelf, vec3f(1.0)), hasImg);
    }
  }
  if (!hasImg && !hasTer) { col = T.extra.www; }
  col *= globeShade(v.world);
  if (F.misc.w > 0.5 && T.spec.y > 0.0) {
    // Globe specular substitute: Blinn-Phong highlight of the globe light.
    let n = normalize(v.world); let h = normalize(normalize(F.eye.xyz - v.world) + normalize(F.light.xyz));
    col += vec3f(pow(max(dot(n, h), 0.0), T.spec.x)) * T.spec.y;
  }
  if (T.spec.z > 0.5) {
    // HDR substitute: extended Reinhard tone mapping with white point T.spec.w (keeps highlights from clipping).
    let w2 = T.spec.w * T.spec.w;
    col = col * (1.0 + col / w2) / (1.0 + col) * 2.0 / (1.0 + 1.0 / w2);
  }
  col = mix(T.bgc.rgb, col, T.shade.w);
  if (T.grid.a > 0.0 && (T.gridP.z < 0.5 || elev <= 0.0)) {
    let sp = T.gridP.x;
    let fx = abs(fract(ll.x / sp + 0.5) - 0.5) * sp; let fy = abs(fract(ll.y / sp + 0.5) - 0.5) * sp;
    let wx = fwx * T.gridP.y; let wy = fwy * T.gridP.y;
    var g = max(1.0 - smoothstep(0.0, wx, fx), 1.0 - smoothstep(0.0, wy, fy));
    let sp2 = sp * 0.5;
    let gx2 = abs(fract(ll.x / sp2 + 0.5) - 0.5) * sp2; let gy2 = abs(fract(ll.y / sp2 + 0.5) - 0.5) * sp2;
    g = max(g, 0.5 * T.gridP.w * max(1.0 - smoothstep(0.0, wx * 0.7, gx2), 1.0 - smoothstep(0.0, wy * 0.7, gy2)));
    if (T.light.z > 0.5) { col += T.grid.rgb * g * T.grid.a * 3.0; } else { col = mix(col, T.grid.rgb, g * T.grid.a * 3.0); }
  }
  return vec4f(col, 1.0);
}
`;

// ------------------------------------------------------------------------------------------- rasters
// Projection kinds: 0 regular lat/lon, 1 GOES fixed grid, 2 Lambert conformal.
export const PROJ = /* wgsl */ `
struct Proj { kind: f32, nx: f32, ny: f32, flip: f32, a: vec4f, b: vec4f, c: vec4f };
fn projUV(P: Proj, ll: vec2f) -> vec3f {
  if (P.kind < 0.5) {
    var lon = ll.x;
    if (lon < P.a.y - 180.0) { lon += 360.0; } if (lon > P.a.y + 180.0) { lon -= 360.0; }
    let u = (lon - P.a.y) / (P.a.w - P.a.y);
    let v = (P.a.x - ll.y) / (P.a.x - P.a.z);
    return vec3f(u, v, 1.0);
  }
  if (P.kind < 1.5) {
    // a: h, req, rpol, lon0 ; b: x0, dx, y0, dy
    let lat = ll.y / DEG; let lon = ll.x / DEG; let lon0 = P.a.w / DEG;
    let r2 = (P.a.z * P.a.z) / (P.a.y * P.a.y);
    let phic = atan(r2 * tan(lat));
    let e2 = 1.0 - r2;
    let rc = P.a.z / sqrt(1.0 - e2 * cos(phic) * cos(phic));
    let sx = P.a.x - rc * cos(phic) * cos(lon - lon0);
    let sy = -rc * cos(phic) * sin(lon - lon0);
    let sz = rc * sin(phic);
    if (P.a.x * (P.a.x - sx) < sy * sy + sz * sz / r2) { return vec3f(0.0, 0.0, 0.0); }
    let x = asin(-sy / sqrt(sx * sx + sy * sy + sz * sz));
    let y = atan(sz / sx);
    return vec3f(((x - P.b.x) / P.b.y + 0.5) / P.nx, ((y - P.b.z) / P.b.w + 0.5) / P.ny, 1.0);
  }
  var i = 0.0; var j = 0.0;
  if (P.kind < 2.5) {
    // Lambert: a: n, F*R, rho0, lov ; b: x0, y0, dx, dy
    var dl = ll.x - P.a.w;
    if (dl > 180.0) { dl -= 360.0; } if (dl < -180.0) { dl += 360.0; }
    let rho = P.a.y / pow(tan(PI / 4.0 + ll.y / DEG / 2.0), P.a.x);
    let th = P.a.x * dl / DEG;
    let x = rho * sin(th); let y = P.a.z - rho * cos(th);
    i = (x - P.b.x) / P.b.z; j = (y - P.b.y) / P.b.w;
  } else if (P.kind < 3.5) {
    // Polar stereographic: a: R*(1+sin|LaD|), hemisphere (+1 N, -1 S), lov ; b: x1, y1, dx, dy
    let h = P.a.y;
    if (h * ll.y < -89.0) { return vec3f(0.0); }
    let rho = P.a.x * tan(PI / 4.0 - h * ll.y / DEG / 2.0);
    var dl = ll.x - P.a.z;
    if (dl > 180.0) { dl -= 360.0; } if (dl < -180.0) { dl += 360.0; }
    let x = rho * sin(dl / DEG); let y = -h * rho * cos(dl / DEG);
    i = (x - P.b.x) / P.b.z; j = (y - P.b.y) / P.b.w;
  } else {
    // Mercator: a: R*cos(LaD), lo1, y1 ; b: -, -, di, dj
    var dl = ll.x - P.a.y;
    if (dl > 180.0) { dl -= 360.0; } if (dl < -180.0) { dl += 360.0; }
    let x = P.a.x * dl / DEG; let y = P.a.x * log(tan(PI / 4.0 + clamp(ll.y, -85.0, 85.0) / DEG / 2.0));
    i = x / P.b.z; j = (y - P.a.z) / P.b.w;
  }
  // flip: rows are stored southward (scan bit 0x40 clear).
  if (P.flip > 0.5) { j = -j; }
  return vec3f((i + 0.5) / P.nx, (j + 0.5) / P.ny, 1.0);
}
// Precipitation-typed colour from the rain/snow/freezing-rain/sleet palette colours and the HRRR p-type texel
// (r = frozen probability, g = category / 4 with 0 none, 1 rain, 2 snow, 3 sleet, 4 freezing rain; a = valid).
// pp: gradient width %, probability rendering on, sleet on.
fn ptypeMix(rain: vec4f, snow: vec4f, fr: vec4f, ip: vec4f, pt: vec4f, pp: vec3f) -> vec4f {
  let cat = round(pt.g * 4.0);
  if (pt.a < 0.5) { return rain; }
  if (cat > 3.5) { return fr; }
  if (cat > 2.5 && pp.z > 0.5) { return ip; }
  if (pp.y > 0.5) {
    let w = max(pp.x, 1.0) / 100.0;
    return mix(rain, snow, smoothstep(0.5 - w * 0.5, 0.5 + w * 0.5, pt.r));
  }
  return select(rain, snow, cat > 1.5 || pt.r > 0.5);
}
`;

export const RASTER = COMMON + PROJ + /* wgsl */ `
struct RP {
  mode: vec4f,      // mode, temporal w, layer alpha, smoothing
  lut: vec4f,       // lutRows, ptype gradient width, ptype prob on, sleet on
  ch: vec4f,        // x: 1 = missing is encoded as a negative value (0 is a valid value), else 0 = missing; y, z: mesh cells x, y
  bounds: vec4f,    // lat0, lon0, lat1, lon1 of the drawn patch
  range: vec4f,     // value low, high, reserve, probe kind
  P: Proj,
  A: Proj,          // auxiliary grid (p-type)
};
@group(1) @binding(0) var<uniform> R: RP;
@group(1) @binding(1) var d0a: texture_2d<f32>;
@group(1) @binding(2) var d0b: texture_2d<f32>;
@group(1) @binding(3) var d1a: texture_2d<f32>;
@group(1) @binding(4) var d1b: texture_2d<f32>;
@group(1) @binding(5) var d2a: texture_2d<f32>;
@group(1) @binding(6) var d2b: texture_2d<f32>;
@group(1) @binding(7) var lut0: texture_2d<f32>;
@group(1) @binding(8) var lut1: texture_2d<f32>;
@group(1) @binding(9) var lut2: texture_2d<f32>;
@group(1) @binding(10) var lut3: texture_2d<f32>;
@group(1) @binding(11) var aux: texture_2d<f32>;
@group(1) @binding(12) var ds: sampler;
@group(1) @binding(13) var ls: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) world: vec3f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let GX = u32(R.ch.y); let GY = u32(R.ch.z);
  let q = vi % 6u; let cell = vi / 6u;
  let cx = cell % GX; let cy = cell / GX;
  var corners = array(vec2u(0u,0u), vec2u(1u,0u), vec2u(0u,1u), vec2u(0u,1u), vec2u(1u,0u), vec2u(1u,1u)); let corner = corners[q];
  let f = vec2f(f32(cx + corner.x) / f32(GX), f32(cy + corner.y) / f32(GY));
  let lat = mix(R.bounds.x, R.bounds.z, f.y); let lon = mix(R.bounds.y, R.bounds.w, f.x);
  let p = xyzOf(lon, lat);
  var o: VO; o.pos = toClip(p); o.world = p; return o;
}
fn lutAt(t: texture_2d<f32>, x: f32) -> vec4f {
  let rows = R.lut.x;
  let row = select(0.5, (F.viewport.w + 0.5) / rows, rows > 1.5);
  return textureSampleLevel(t, ls, vec2f(clamp(x, 0.0, 1.0), row), 0.0);
}
fn missing(x: f32) -> bool { if (R.ch.x > 0.5) { return x < 0.0; } return x <= 0.0; }
fn sampleD(a: texture_2d<f32>, b: texture_2d<f32>, uv: vec2f) -> f32 {
  var va: f32; var vb: f32;
  if (R.mode.w > 0.5) { va = textureSampleLevel(a, ds, uv, 0.0).r; vb = textureSampleLevel(b, ds, uv, 0.0).r; }
  else { let da = vec2f(textureDimensions(a)); va = textureLoad(a, vec2i(clamp(uv, vec2f(0.0), vec2f(0.99999)) * da), 0).r;
         let db = vec2f(textureDimensions(b)); vb = textureLoad(b, vec2i(clamp(uv, vec2f(0.0), vec2f(0.99999)) * db), 0).r; }
  let w = R.mode.y;
  if (missing(va) || missing(vb)) { return select(va, vb, w >= 0.5); }
  return mix(va, vb, w);
}
// Returns (value 0..1, valid). Modes: 0 single LUT, 1 p-typed reflectivity, 2 GOES true color, 3 sandwich, 4 RGBA image.
fn dataValue(world: vec3f) -> vec2f {
  let ll = lonLatOf(world);
  let uvw = projUV(R.P, ll);
  if (uvw.z < 0.5 || any(uvw.xy < vec2f(0.0)) || any(uvw.xy > vec2f(1.0))) { return vec2f(0.0, 0.0); }
  let v = sampleD(d0a, d0b, uvw.xy);
  return vec2f(v, select(1.0, 0.0, missing(v)));
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  if (!frontFacing(v.world)) { discard; }
  let ll = lonLatOf(v.world);
  let uvw = projUV(R.P, ll);
  if (uvw.z < 0.5 || any(uvw.xy < vec2f(0.0)) || any(uvw.xy > vec2f(1.0))) { discard; }
  let uv = uvw.xy;
  let mode = R.mode.x;
  var c = vec4f(0.0);
  if (mode < 0.5) {
    let x = sampleD(d0a, d0b, uv);
    if (missing(x)) { discard; }
    c = lutAt(lut0, x);
  } else if (mode < 1.5) {
    let x = sampleD(d0a, d0b, uv);
    if (x <= 0.0) { discard; }
    let auv = projUV(R.A, ll);
    var pt = vec4f(0.0, 0.0, 0.0, 0.0);
    if (auv.z > 0.5 && all(auv.xy >= vec2f(0.0)) && all(auv.xy <= vec2f(1.0))) { pt = textureSampleLevel(aux, ls, auv.xy, 0.0); }
    c = ptypeMix(lutAt(lut0, x), lutAt(lut1, x), lutAt(lut2, x), lutAt(lut3, x), pt, R.lut.yzw);
  } else if (mode < 2.5) {
    let b1 = sampleD(d0a, d0b, uv); let b2 = sampleD(d1a, d1b, uv); let b3 = sampleD(d2a, d2b, uv);
    var rgb = vec3f(b2, 0.2 * b3 + 0.4 * b1 + 0.4 * b2, b1);
    rgb = pow(max(rgb, vec3f(0.0)), vec3f(1.0 / 2.2));
    rgb = (rgb - 0.5) * 1.7 + 0.5;
    c = vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), clamp((b1 + b2 + b3) / 0.2, 0.0, 1.0));
  } else if (mode < 3.5) {
    let vis = sampleD(d0a, d0b, uv); let ir = sampleD(d1a, d1b, uv);
    let ic = lutAt(lut1, ir);
    c = vec4f(clamp(vec3f(2.0 * vis) * ic.rgb, vec3f(0.0), vec3f(1.0)), clamp(vis / 0.25, 0.0, 1.0));
    if (ir <= 0.0) { discard; }
  } else {
    c = textureSampleLevel(d0a, ds, uv, 0.0);
  }
  c.a *= R.mode.z;
  if (c.a <= 0.002) { discard; }
  return vec4f(c.rgb * c.a, c.a);
}
@fragment fn fsProbe(v: VO) -> @location(0) vec4f {
  if (!frontFacing(v.world)) { discard; }
  let d = dataValue(v.world);
  if (d.y < 0.5) { discard; }
  return vec4f(d.x, 1.0, 0.0, 1.0);
}
`;

// ------------------------------------------------------------------------------------------- polar radar
export const RADAR = COMMON + PROJ + /* wgsl */ `
struct RadarP {
  site: vec4f,     // lon, lat, height km, elevation deg
  geo: vec4f,      // first gate km, gate km, gates, rows (radials + 2)
  az: vec4f,       // az0 deg, spacing deg, radials, max range km (ground)
  mode: vec4f,     // alpha, smoothing, 3D (0 flat, 1 tilt), exaggeration
  wipe: vec4f,     // temporal w, wipe progress (-1 off), progress of live sweep (1 full), shadow pass
  lut: vec4f,      // rows, azimuth offset deg (shadow), update flash 0..1, beam fade trail width deg (0 off)
  geoB: vec4f,     // second sweep: first gate, gate km, gates, rows
  azB: vec4f,      // second sweep az0, spacing, radials, valid
  pt: vec4f,       // p-typing on, gradient width %, probability rendering, sleet
  A: Proj,         // HRRR p-type grid
};
@group(1) @binding(0) var<uniform> R: RadarP;
@group(1) @binding(1) var texA: texture_2d<f32>;
@group(1) @binding(2) var texB: texture_2d<f32>;
@group(1) @binding(3) var lut: texture_2d<f32>;
@group(1) @binding(4) var ds: sampler;
@group(1) @binding(5) var ls: sampler;
@group(1) @binding(6) var aux: texture_2d<f32>;
@group(1) @binding(7) var lutSnow: texture_2d<f32>;
@group(1) @binding(8) var lutFr: texture_2d<f32>;
@group(1) @binding(9) var lutIp: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) en: vec2f };
const RINGS = 96u; const SEGS = 360u;
const KE = 8494.666;
fn slantRange(s: f32, el: f32) -> f32 { let phi = s / KE; return KE * sin(phi) / cos(el / DEG + phi); }
fn beamH(r: f32, el: f32) -> f32 { return r * sin(el / DEG) + r * r / 15417.82; }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let q = vi % 6u; let cell = vi / 6u;
  let cr = cell % RINGS; let cs = cell / RINGS;
  var corners = array(vec2u(0u,0u), vec2u(1u,0u), vec2u(0u,1u), vec2u(0u,1u), vec2u(1u,0u), vec2u(1u,1u)); let corner = corners[q];
  let fr = f32(cr + corner.x) / f32(RINGS); let fa = f32(cs + corner.y) / f32(SEGS);
  let s = R.az.w * fr * fr * 0.15 + R.az.w * fr * 0.85;
  let a = fa * 2.0 * PI;
  let e = s * sin(a); let n = s * cos(a);
  let c = xyzOf(R.site.x, R.site.y);
  let east = normalize(vec3f(-c.y, c.x, 0.0)); let north = cross(c, east);
  var p = normalize(c + (east * e + north * n) / 6371.0);
  var h = R.site.z;
  if (R.mode.z > 0.5 && R.wipe.w < 0.5) { h += beamH(slantRange(s, R.site.w), R.site.w) * (1.0 + R.mode.w / 25.0); }
  p = p * (1.0 + h / 6371.0);
  var o: VO; o.pos = toClip(p); o.world = p; o.en = vec2f(e, n); return o;
}
fn rowCoord(az: f32, az0: f32, sp: f32, radials: f32, rows: f32) -> f32 {
  var rel = az - az0;
  rel = rel - 360.0 * floor((rel + sp * 0.5) / 360.0);
  let fi = rel / sp;
  return (fi + 1.5) / rows;
}
fn sampleSweep(t: texture_2d<f32>, az: f32, s: f32, g: vec4f, a: vec4f) -> f32 {
  let r = slantRange(s, R.site.w);
  let fg = (r - g.x) / g.y + 0.5;
  if (fg < 0.0 || fg / g.z > 0.9992) { return 0.0; }
  let uv = vec2f(fg / g.z, rowCoord(az, a.x, a.y, a.z, g.w));
  if (R.mode.y > 0.5) { return textureSampleLevel(t, ds, uv, 0.0).r; }
  let dim = vec2f(textureDimensions(t));
  return textureLoad(t, vec2i(clamp(uv, vec2f(0.0), vec2f(0.99999)) * dim), 0).r;
}
fn radarValue(en: vec2f) -> f32 {
  let s = length(en);
  var az = atan2(en.x, en.y) * DEG + R.lut.y;
  az = az - 360.0 * floor(az / 360.0);
  if (R.wipe.z < 0.999) {
    var rel = az - R.az.x; rel = rel - 360.0 * floor(rel / 360.0);
    let tol = select(1.0, 2.5, R.wipe.z >= 0.9) * R.az.y;
    if (rel > R.wipe.z * 360.0 + tol) { return 0.0; }
  }
  let va = sampleSweep(texA, az, s, R.geo, R.az);
  if (R.azB.w < 0.5) { return va; }
  let vb = sampleSweep(texB, az, s, R.geoB, R.azB);
  if (R.wipe.y >= 0.0) {
    var rel = az - R.az.x; rel = rel - 360.0 * floor(rel / 360.0);
    let front = R.wipe.y * 360.0;
    let k = smoothstep(front - 6.0, front, rel);
    return select(vb, va, k > 0.5);
  }
  let w = R.wipe.x;
  if (va <= 0.0 || vb <= 0.0) { return select(va, vb, w >= 0.5); }
  return mix(va, vb, w);
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  if (!frontFacing(v.world)) { discard; }
  let x = radarValue(v.en);
  if (x <= 0.0) { discard; }
  let rows = R.lut.x;
  let row = select(0.5, (F.viewport.w + 0.5) / rows, rows > 1.5);
  var c = textureSampleLevel(lut, ls, vec2f(x, row), 0.0);
  if (R.pt.x > 0.5) {
    let auv = projUV(R.A, lonLatOf(v.world));
    var pt = vec4f(0.0);
    if (auv.z > 0.5 && all(auv.xy >= vec2f(0.0)) && all(auv.xy <= vec2f(1.0))) { pt = textureSampleLevel(aux, ls, auv.xy, 0.0); }
    c = ptypeMix(c, textureSampleLevel(lutSnow, ls, vec2f(x, row), 0.0), textureSampleLevel(lutFr, ls, vec2f(x, row), 0.0), textureSampleLevel(lutIp, ls, vec2f(x, row), 0.0), pt, R.pt.yzw);
  }
  // Beam fade trail: echoes just behind the update/live sweep front are brightened, fading over the trail width.
  let front = select(select(-1.0, R.wipe.z * 360.0, R.wipe.z < 0.999), R.wipe.y * 360.0, R.wipe.y >= 0.0);
  if (R.lut.w > 0.0 && front >= 0.0) {
    var az = atan2(v.en.x, v.en.y) * DEG + R.lut.y; az = az - 360.0 * floor(az / 360.0);
    var rel = az - R.az.x; rel = rel - 360.0 * floor(rel / 360.0);
    let behind = front - rel;
    if (behind >= 0.0 && behind < R.lut.w) { c = vec4f(mix(c.rgb, vec3f(1.0), 0.45 * (1.0 - behind / R.lut.w)), c.a); }
  }
  // Live-composite update flash: the whole updated composite is lifted toward white.
  if (R.lut.z > 0.0) { c = vec4f(mix(c.rgb, vec3f(1.0), R.lut.z), max(c.a, R.lut.z)); }
  c.a *= R.mode.x;
  if (c.a <= 0.002) { discard; }
  return vec4f(c.rgb * c.a, c.a);
}
@fragment fn fsProbe(v: VO) -> @location(0) vec4f {
  if (!frontFacing(v.world)) { discard; }
  let x = radarValue(v.en);
  if (x <= 0.0) { discard; }
  return vec4f(x, 2.0, 0.0, 1.0);
}
`;

// ------------------------------------------------------------------------------------------- lines
export const LINES = COMMON + /* wgsl */ `
struct Seg { a: vec4f, b: vec4f };            // xyz + style index in a.w
// Style (map-object line pass): colours with animation keyframe, widths, dash and offset.
struct Style { color: vec4f, color2: vec4f, w: vec4f, d: vec4f, o: vec4f };
// w: width px, width2 px, interval s (0 = static), non-linear pulse; d: dash px, dash mode (0 solid, 1 stretch, 2 round,
// 3 hard), dash speed px/s, feather px; o: visible, offset x px, offset y px, additive
@group(1) @binding(0) var<storage, read> segs: array<Seg>;
@group(1) @binding(1) var<storage, read> styles: array<Style>;
struct VO { @builtin(position) pos: vec4f, @location(0) across: f32, @location(1) @interpolate(flat) style: u32, @location(2) along: f32, @location(3) halfW: f32, @location(4) pulse: f32 };
fn pulseOf(st: Style) -> f32 {
  if (st.w.z <= 0.0) { return 0.0; }
  let ph = fract(F.eye.w / st.w.z);
  if (st.w.w > 0.5) { return 0.5 - 0.5 * cos(ph * 6.2831853); }
  return 1.0 - abs(ph * 2.0 - 1.0);
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let s = segs[ii];
  let st = styles[u32(s.a.w)];
  var o: VO;
  o.style = u32(s.a.w);
  if (st.o.x < 0.5 || !frontFacing(s.a.xyz) || !frontFacing(s.b.xyz)) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let ca = toClip(s.a.xyz); let cb = toClip(s.b.xyz);
  if (ca.w <= 0.0 || cb.w <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let res = F.viewport.xy;
  let off = vec2f(st.o.y, -st.o.z) * F.viewport.z;
  let pa = ca.xy / ca.w * res * 0.5 + off; let pb = cb.xy / cb.w * res * 0.5 + off;
  var d = pb - pa; let len = length(d);
  d = select(vec2f(1.0, 0.0), d / len, len > 1e-6);
  let nrm = vec2f(-d.y, d.x);
  let pulse = pulseOf(st);
  let width = mix(st.w.x, st.w.y, pulse);
  let hw = width * F.viewport.z * 0.5 + 1.0 + st.d.w * F.viewport.z;
  let q = vi % 6u;
  var sides = array(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0); var ends = array(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  let side = sides[q]; let end = ends[q];
  var p = mix(pa, pb, end) + nrm * side * hw + d * (end * 2.0 - 1.0) * hw * 0.5;
  let cw = mix(ca, cb, end);
  o.pos = vec4f(p / res * 2.0 * cw.w, cw.z, cw.w);
  o.across = side * hw; o.along = s.b.w + end * len; o.halfW = hw; o.pulse = pulse;
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let st = styles[v.style];
  let feather = st.d.w * F.viewport.z;
  let edge = v.halfW - 1.0 - feather;
  var a = 1.0 - smoothstep(edge - 0.5, edge + 0.5 + feather, abs(v.across));
  let dash = st.d.x * F.viewport.z;
  if (dash > 0.0) {
    let ph = fract((v.along + F.eye.w * st.d.z * F.viewport.z) / (dash * 2.0));
    let mode = st.d.y;
    if (mode < 1.5) { a *= smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.42, 0.5, ph)); }
    else if (mode < 2.5) { let x = (ph - 0.25) * dash * 2.0; let r = length(vec2f(x, v.across)); a *= 1.0 - smoothstep(v.halfW - 1.5, v.halfW, r); }
    else if (ph > 0.5) { discard; }
  }
  let col = mix(st.color, st.color2, v.pulse);
  a *= col.a;
  if (a <= 0.003) { discard; }
  // Additive passes: premultiplied colour with zero alpha adds onto the destination.
  return vec4f(col.rgb * a, select(a, 0.0, st.o.w > 0.5));
}
`;

// ------------------------------------------------------------------------------------------- points / icons
export const POINTS = COMMON + /* wgsl */ `
struct Pt { pos: vec4f, color: vec4f, p: vec4f };  // pos.w = size px; p: shape (+100 additive), rotation rad, outline, glow
@group(1) @binding(0) var<storage, read> pts: array<Pt>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) i: u32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let p = pts[ii];
  var o: VO; o.i = ii;
  if (p.color.a <= 0.0 || !frontFacing(p.pos.xyz)) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let c = toClip(p.pos.xyz);
  var corners = array(vec2f(-1.0,-1.0), vec2f(1.0,-1.0), vec2f(-1.0,1.0), vec2f(-1.0,1.0), vec2f(1.0,-1.0), vec2f(1.0,1.0)); let corner = corners[vi % 6u];
  let r = p.p.y; let rc = vec2f(corner.x * cos(r) - corner.y * sin(r), corner.x * sin(r) + corner.y * cos(r));
  let px = rc * p.pos.w * 0.5 * F.viewport.z * (1.0 + p.p.w * 2.0);
  o.pos = vec4f(c.xy + px / F.viewport.xy * 2.0 * c.w, c.z, c.w);
  o.uv = corner * (1.0 + p.p.w * 2.0);
  return o;
}
fn sdTri(p: vec2f) -> f32 { let k = sqrt(3.0); var q = vec2f(abs(p.x) - 1.0, p.y + 1.0 / k); if (q.x + k * q.y > 0.0) { q = vec2f(q.x - k * q.y, -k * q.x - q.y) / 2.0; } q.x -= clamp(q.x, -2.0, 0.0); return -length(q) * sign(q.y); }
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let p = pts[v.i];
  let shape = u32(p.p.x) % 100u;
  let uv = v.uv;
  var d: f32;
  switch shape {
    case 0u: { d = length(uv) - 0.8; }
    case 1u: { d = abs(length(uv) - 0.7) - 0.15; }
    case 2u: { d = sdTri(vec2f(uv.x, -uv.y) * 1.15); }
    case 3u: { d = sdTri(uv * 1.15); }
    case 4u: { d = abs(uv.x) + abs(uv.y) - 0.85; }
    case 5u: { d = max(abs(uv.x), abs(uv.y)) - 0.75; }
    case 6u: { d = min(max(abs(uv.x) - 0.85, abs(uv.y) - 0.22), max(abs(uv.y) - 0.85, abs(uv.x) - 0.22)); }
    case 7u: { let q = uv * vec2f(1.0, 1.0); d = max(abs(q.x + q.y * 0.45) - 0.28, abs(q.y) - 0.9); }
    case 8u: { d = max(length(uv - vec2f(0.0, -0.3)) - 0.7, -(uv.y + 0.3)); }
    case 9u: { d = sdTri(vec2f(uv.x, -(uv.y + 0.25)) * 1.4); }
    default: { d = length(uv) - 0.3; }
  }
  let aa = fwidth(d);
  var a = 1.0 - smoothstep(-aa, aa, d);
  var col = p.color.rgb;
  if (p.p.z > 0.0) { let o = 1.0 - smoothstep(-aa, aa, d - p.p.z); col = mix(vec3f(0.0), col, a); a = max(a, o * 0.85); }
  if (p.p.w > 0.0) { a = max(a, exp(-max(d, 0.0) * 3.0 / p.p.w) * 0.6); }
  a *= p.color.a;
  if (a <= 0.003) { discard; }
  // Additive icons: premultiplied colour with zero alpha adds onto the destination.
  return vec4f(col * a, select(a, 0.0, p.p.x >= 100.0));
}
`;

// ------------------------------------------------------------------------------------------- text
export const TEXT = COMMON + /* wgsl */ `
// Glyph record: pos.w = label index; rect = atlas uv; off = x, y, w, h px; color/halo = fill/stroke; color2 = gradient;
// glow = outer-effect colour; fx = gradient width, position, flags (1 flashing, 2 gradient, 4 box), glow exponent;
// gofs = glow uv offset (shadow).
struct Glyph { pos: vec4f, rect: vec4f, off: vec4f, color: vec4f, halo: vec4f, color2: vec4f, glow: vec4f, fx: vec4f, gofs: vec4f };
@group(1) @binding(0) var<storage, read> glyphs: array<Glyph>;
@group(1) @binding(1) var<storage, read> labelAlpha: array<f32>;
@group(1) @binding(2) var atlas: texture_2d<f32>;
@group(1) @binding(3) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) i: u32, @location(2) a: f32, @location(3) local: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let g = glyphs[ii];
  var o: VO; o.i = ii;
  let la = labelAlpha[u32(g.pos.w)];
  o.a = la;
  if (la <= 0.0 || !frontFacing(g.pos.xyz)) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let c = toClip(g.pos.xyz);
  var corners = array(vec2f(0.0,0.0), vec2f(1.0,0.0), vec2f(0.0,1.0), vec2f(0.0,1.0), vec2f(1.0,0.0), vec2f(1.0,1.0)); let corner = corners[vi % 6u];
  let px = (g.off.xy + corner * g.off.zw) * F.viewport.z;
  o.pos = vec4f(c.xy + vec2f(px.x, -px.y) / F.viewport.xy * 2.0 * c.w, c.z, c.w);
  o.uv = g.rect.xy + corner * g.rect.zw;
  o.local = corner;
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let g = glyphs[v.i];
  let flags = u32(g.fx.z + 0.5);
  var top = g.color;
  if ((flags & 2u) != 0u) {
    let y = select(v.local.y, v.local.y, true);
    top = mix(g.color, g.color2, smoothstep(g.fx.y - g.fx.x * 0.5, g.fx.y + g.fx.x * 0.5 + 1e-4, y));
  }
  if ((flags & 4u) != 0u) { let a = top.a * v.a; if (a <= 0.003) { discard; } return vec4f(top.rgb * a, a); }
  let t = textureSampleLevel(atlas, smp, v.uv, 0.0);
  let gl = textureSampleLevel(atlas, smp, v.uv + g.gofs.xy, 0.0).b;
  var flash = 1.0;
  if ((flags & 1u) != 0u) { flash = step(0.5, fract(F.eye.w)); }
  let fill = t.r * top.a; let halo = t.g * g.halo.a; let glow = pow(gl, g.fx.w) * g.glow.a * flash;
  // glow under stroke under fill
  var rgb = g.glow.rgb * glow; var a = glow;
  rgb = g.halo.rgb * halo + rgb * (1.0 - halo); a = halo + a * (1.0 - halo);
  rgb = top.rgb * fill + rgb * (1.0 - fill); a = fill + a * (1.0 - fill);
  a *= v.a; rgb *= v.a;
  if (a <= 0.003) { discard; }
  return vec4f(rgb, a);
}
`;

// ------------------------------------------------------------------------------------------- sprites (colour atlas)
export const SPRITES = COMMON + /* wgsl */ `
struct Spr { pos: vec4f, rect: vec4f, size: vec4f }; // pos.w = alpha; rect = atlas uv; size = w, h px, dx, dy
@group(1) @binding(0) var<storage, read> spr: array<Spr>;
@group(1) @binding(1) var atlas: texture_2d<f32>;
@group(1) @binding(2) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let s = spr[ii];
  var o: VO; o.a = s.pos.w;
  if (s.pos.w <= 0.0 || !frontFacing(s.pos.xyz)) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let c = toClip(s.pos.xyz);
  var corners = array(vec2f(0.0,0.0), vec2f(1.0,0.0), vec2f(0.0,1.0), vec2f(0.0,1.0), vec2f(1.0,0.0), vec2f(1.0,1.0)); let k = corners[vi % 6u];
  let px = (vec2f(s.size.z, s.size.w) + (k - vec2f(0.5)) * s.size.xy) * F.viewport.z;
  o.pos = vec4f(c.xy + vec2f(px.x, -px.y) / F.viewport.xy * 2.0 * c.w, c.z, c.w);
  o.uv = s.rect.xy + k * s.rect.zw;
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let t = textureSampleLevel(atlas, smp, v.uv, 0.0);
  let a = t.a * v.a;
  if (a <= 0.003) { discard; }
  return vec4f(t.rgb * a, a);
}
// Additive variant (premultiplied blend with zero alpha adds the colour).
@fragment fn fsAdd(v: VO) -> @location(0) vec4f {
  let t = textureSampleLevel(atlas, smp, v.uv, 0.0);
  let a = t.a * v.a;
  if (a <= 0.003) { discard; }
  return vec4f(t.rgb * a, 0.0);
}
`;

// ------------------------------------------------------------------------------------------- filled polygons
export const POLYS = COMMON + /* wgsl */ `
// Polygon fill style (TFrmPolygonStyle): colour with animation keyframe, pattern layer and texture layer.
struct Style { color: vec4f, color2: vec4f, pcolor: vec4f, p: vec4f, q: vec4f, t: vec4f, t2: vec4f };
// p: pattern type (0 none, 1 horiz, 2 vert, 3 wave, 4 bubbles, 5 square bubbles, 6 hatch, 7 dots), size px, speed px/s, visible
// q: interval s, non-linear, fixed (world-anchored), additive; t: texture layer (-1 none), intensity, speed, size px; t2.x: texture mode
@group(1) @binding(0) var<storage, read> verts: array<vec4f>;   // xyz on the sphere, w = style index
@group(1) @binding(1) var<storage, read> styles: array<Style>;
@group(1) @binding(2) var tex: texture_2d_array<f32>;
@group(1) @binding(3) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) @interpolate(flat) style: u32 };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let v = verts[vi];
  var o: VO;
  o.style = u32(v.w);
  o.world = v.xyz;
  if (styles[o.style].p.w < 0.5) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  o.pos = toClip(v.xyz);
  return o;
}
fn patternHit(kind: f32, q: vec2f, sp: f32) -> f32 {
  let c = q / sp;
  if (kind < 1.5) { return step(fract(c.y), 0.3); }
  if (kind < 2.5) { return step(fract(c.x), 0.3); }
  if (kind < 3.5) { return step(abs(fract(c.y + 0.25 * sin(c.x * 3.14159)) - 0.5), 0.15); }
  if (kind < 4.5) { let f = fract(c) - vec2f(0.5); return step(abs(length(f) - 0.32), 0.07); }
  if (kind < 5.5) { let f = abs(fract(c) - vec2f(0.5)); return step(abs(max(f.x, f.y) - 0.3), 0.07); }
  if (kind < 6.5) { return step(fract((q.x + q.y) / (sp * 1.4142)), 0.3); }
  let f = fract(c) - vec2f(0.5); return step(dot(f, f), 0.04);
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  if (!frontFacing(v.world)) { discard; }
  let st = styles[v.style];
  var pulse = 0.0;
  if (st.q.x > 0.0) { let ph = fract(F.eye.w / st.q.x); pulse = select(1.0 - abs(ph * 2.0 - 1.0), 0.5 - 0.5 * cos(ph * 6.2831853), st.q.y > 0.5); }
  var col = mix(st.color, st.color2, pulse);
  var rgb = col.rgb * col.a; var a = col.a;
  // World-anchored ("Fixed") patterns use map metres; others screen pixels.
  var q = v.pos.xy;
  if (st.q.z > 0.5) { let ll = lonLatOf(v.world); q = vec2f(ll.x * cos(ll.y / DEG), -ll.y) * 111320.0 / max(F.misc.y * F.viewport.z, 1e-3); }
  q += vec2f(F.eye.w * st.p.z * F.viewport.z, 0.0);
  if (st.p.x > 0.5) {
    let h = patternHit(st.p.x, q, max(st.p.y, 2.0) * F.viewport.z) * st.pcolor.a;
    rgb = rgb * (1.0 - h) + st.pcolor.rgb * h; a = a + h * (1.0 - a);
  }
  if (st.t.x >= 0.0) {
    let uv = (v.pos.xy + vec2f(F.eye.w * st.t.z * F.viewport.z)) / max(st.t.w * F.viewport.z, 2.0);
    let tc = textureSampleLevel(tex, smp, fract(uv), i32(st.t.x), 0.0);
    let k = st.t.y * tc.a;
    let mode = st.t2.x;
    if (mode < 0.5) { rgb = rgb * (1.0 - k) + tc.rgb * k; a = a + k * (1.0 - a); }
    else if (mode < 1.5) { rgb += tc.rgb * k; }
    else if (mode < 2.5) { rgb = max(rgb - tc.rgb * k, vec3f(0.0)); }
    else { rgb = rgb * (1.0 - k * 0.5) + tc.rgb * k; a = a + k * 0.5 * (1.0 - a); }
  }
  if (a <= 0.003 && dot(rgb, rgb) < 1e-5) { discard; }
  return vec4f(rgb, select(a, 0.0, st.q.w > 0.5));
}
`;
