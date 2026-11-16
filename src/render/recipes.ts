// User GOES multispectral RGB recipes (TFrmGOESMultispectralRGB, template behaviour): up to four channels
// (band each), a recipe of r/g/b/a expressions over ch1..ch4 (physical values: bands 1–6 reflectance 0–1, bands
// 7–16 °C) and pr/pg/pb (the band palette colour of the palette channel), then optional contrast and gamma and
// additive blending. Expressions use a small whitelisted language compiled into a WGSL entry point appended to the
// raster shader, so user text can never inject other shader code.
import { RASTER } from './shaders';

export interface Recipe {
  name: string;
  bands: [number, number, number, number];
  enabled: [boolean, boolean, boolean, boolean];
  text: string;
  /** Channel (0–3) whose band palette colour is exposed as pr/pg/pb, or −1. */
  paletteChannel: number;
  contrast: { on: boolean; value: number }; gamma: { on: boolean; value: number };
  additive: boolean;
}

export const bandRange = (b: number): [number, number] => (b <= 6 ? [0, 1.2] : [-110, 57]);
const FUNCS = new Set(['min', 'max', 'clamp', 'mix', 'pow', 'abs', 'sqrt', 'smoothstep', 'step', 'exp', 'log', 'sin', 'cos', 'floor', 'fract', 'sign']);
const VARS = new Set(['ch1', 'ch2', 'ch3', 'ch4', 'pr', 'pg', 'pb']);

/** One expression → WGSL (floats only); throws with a readable message for anything outside the language. */
export function compileExpr(src: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const m of src.matchAll(/\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/(),])|(\S))/g)) {
    const [, num, id, op, bad] = m;
    if (bad) throw new Error(`unexpected "${bad}"`);
    if (num) out.push(/[.eE]/.test(num) ? num : `${num}.0`);
    else if (id) {
      if (VARS.has(id)) out.push(id);
      else if (FUNCS.has(id)) out.push(id);
      else throw new Error(`unknown name "${id}" (use ch1–ch4, pr/pg/pb and ${[...FUNCS].join(', ')})`);
    } else if (op) {
      if (op === '(') depth++;
      if (op === ')' && --depth < 0) throw new Error('unbalanced parentheses');
      out.push(op);
    }
  }
  if (depth !== 0) throw new Error('unbalanced parentheses');
  if (!out.length) throw new Error('empty expression');
  return out.join(' ');
}

/** Parses "r = …" / "g = …" / "b = …" / "a = …" lines (alpha optional, default 1). */
export function parseRecipeText(text: string): Record<'r' | 'g' | 'b' | 'a', string> {
  const e: Partial<Record<'r' | 'g' | 'b' | 'a', string>> = {};
  for (const raw of text.split(/\r?\n|;/)) {
    const line = raw.replace(/\/\/.*$|#.*$/, '').trim();
    if (!line) continue;
    const m = /^([rgba])\s*=\s*(.+)$/i.exec(line);
    if (!m) throw new Error(`"${line}": expected r = …, g = …, b = … or a = …`);
    e[m[1].toLowerCase() as 'r'] = compileExpr(m[2]);
  }
  for (const k of ['r', 'g', 'b'] as const) if (!e[k]) throw new Error(`missing "${k} = …"`);
  return { r: e.r!, g: e.g!, b: e.b!, a: e.a ?? '1.0' };
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Full WGSL module (raster shader + fsUser entry) for a recipe. Contrast/gamma sliders 0–100 map to 0–4. */
export function recipeShader(r: Recipe): string {
  const e = parseRecipeText(r.text);
  const ch = [0, 1, 2, 3].map((i) => {
    const tex = ['d0a', 'd0b', 'd1a', 'd1b'][i], [lo, hi] = bandRange(r.bands[i]);
    return r.enabled[i]
      ? `let k${i + 1} = sampleD(${tex}, ${tex}, uv); let ch${i + 1} = ${f(lo)} + ${f(hi - lo)} * (k${i + 1} * 255.0 - 1.0) / 254.0;`
      : `let k${i + 1} = 0.0; let ch${i + 1} = 0.0;`;
  }).join('\n  ');
  const anyData = r.enabled.map((on, i) => (on ? `k${i + 1} > 0.0` : '')).filter(Boolean).join(' || ') || 'false';
  const pc = r.paletteChannel >= 0 && r.enabled[r.paletteChannel] ? `lutAt(lut0, k${r.paletteChannel + 1}).rgb` : 'vec3f(0.0)';
  const c = r.contrast.on && r.contrast.value > 0 ? `rgb = (rgb - 0.5) * ${f(r.contrast.value / 25)} + 0.5;` : '';
  const g = r.gamma.on && r.gamma.value > 0 ? `rgb = pow(max(rgb, vec3f(0.0)), vec3f(${f(25 / r.gamma.value)}));` : '';
  return `${RASTER}
@fragment fn fsUser(v: VO) -> @location(0) vec4f {
  if (!frontFacing(v.world)) { discard; }
  let uvw = projUV(R.P, lonLatOf(v.world));
  if (uvw.z < 0.5 || any(uvw.xy < vec2f(0.0)) || any(uvw.xy > vec2f(1.0))) { discard; }
  let uv = uvw.xy;
  ${ch}
  if (!(${anyData})) { discard; }
  let pcol = ${pc}; let pr = pcol.r; let pg = pcol.g; let pb = pcol.b;
  var rgb = vec3f(f32(${e.r}), f32(${e.g}), f32(${e.b}));
  ${c}
  ${g}
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  let a = clamp(f32(${e.a}), 0.0, 1.0) * R.mode.z;
  if (a <= 0.002) { discard; }
  return vec4f(rgb * a, ${r.additive ? '0.0' : 'a'});
}
`;
}
