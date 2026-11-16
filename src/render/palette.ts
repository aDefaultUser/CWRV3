// Palette model, color evaluation, lookup bake and legend ticks.
export type RGBA = [number, number, number, number];
export interface Stop { v: number; a: RGBA; b: RGBA; own: boolean }
export interface Palette { name: string; frames: Stop[][]; flashMs: number; flag: boolean }

/** Parses the line format of (`name`, `R,G,B,A[;R,G,B,A]|value[|]`, `@ms|flag`). */
export function parsePalette(text: string): Palette {
  const lines = text.split(/\r?\n/);
  const name = (lines[0] ?? '').trim();
  if (!name) throw new Error('palette: lacks required name on first line');
  const frames: Stop[][] = [[]];
  let flashMs = 400, flag = true;
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    const f = line.split('|');
    if (f.length < 2) continue;
    if (f[0].startsWith('@')) {
      const ms = parseInt(f[0].slice(1), 10);
      flashMs = Number.isFinite(ms) ? ms : 400;
      flag = Number(f[1]) !== 0;
      frames.push([]);
      continue;
    }
    const col = (s: string): RGBA => {
      const p = s.split(',').map((x) => parseInt(x.trim(), 10));
      if (p.length < 3 || p.some((x) => !Number.isFinite(x))) throw new Error(`palette ${name}: syntax error in line ${li + 1}`);
      return [p[0], p[1], p[2], p.length >= 4 ? p[3] : 255];
    };
    const parts = f[0].split(';');
    const a = col(parts[0]);
    const b = parts.length > 1 ? col(parts[1]) : a;
    const v = parseFloat(f[1]);
    if (!Number.isFinite(v)) throw new Error(`palette ${name}: syntax error in line ${li + 1}`);
    frames[frames.length - 1].push({ v, a, b, own: f.length >= 3 });
  }
  if (!frames[0].length) throw new Error(`palette ${name}: no stops`);
  return { name, frames, flashMs, flag };
}

export function paletteRange(p: Palette): [number, number] {
  const s = p.frames[0];
  return [s[0].v, s[s.length - 1].v];
}

/** Color at value v. `stepped` selects the stepped mode used by some point-data callers. */
export function evalPalette(stops: Stop[], v: number, stepped = false): RGBA {
  const n = stops.length;
  if (v < stops[0].v) return [...stops[0].a];
  if (v >= stops[n - 1].v) return [...stops[n - 1].a];
  let i = 0;
  while (i + 1 < n && !(stops[i].v <= v && v < stops[i + 1].v)) i++;
  const s = stops[i], s1 = stops[i + 1];
  if (stepped) return [...s.a];
  const t = (v - s.v) / (s1.v - s.v);
  const from = s.own ? s.a : s.b, to = s.own ? s.b : s1.a;
  return [0, 1, 2, 3].map((k) => from[k] + Math.round((to[k] - from[k]) * t)) as RGBA;
}

export const LUT_WIDTH = 1024;
export const RANGE_FOLDED: RGBA = [90, 0, 100, 200];

export interface BakeOptions {
  low: number; high: number;
  /** Codes 0/1 reserved; code 2 ↔ low and the top code ↔ high (Level 2 velocity family etc.). */
  reserve?: boolean;
  showRF?: boolean;
  /** General raster bake: texels at or below the first stop are transparent unless fillBelow. */
  raster?: boolean;
  fillBelow?: boolean;
  topCode?: number;
}

/** Bakes the palette into RGBA8 rows of LUT_WIDTH texels (one row per frame). */
export function bakeLut(p: Palette, o: BakeOptions): Uint8Array {
  const rows = p.frames.length;
  const out = new Uint8Array(rows * LUT_WIDTH * 4);
  const top = o.topCode ?? 255;
  for (let r = 0; r < rows; r++) {
    const stops = p.frames[r].length ? p.frames[r] : p.frames[0];
    for (let i = 0; i < LUT_WIDTH; i++) {
      let c: RGBA;
      const x = i / (LUT_WIDTH - 1);
      if (o.reserve) {
        const code = x * top;
        if (code < 0.5) c = [0, 0, 0, 0];
        else if (code < 1.5) c = o.showRF ? RANGE_FOLDED : [0, 0, 0, 0];
        else c = evalPalette(stops, o.low + ((o.high - o.low) * (code - 2)) / (top - 2));
      } else {
        const v = o.low + (o.high - o.low) * x;
        c = o.raster && v <= stops[0].v && !o.fillBelow ? [0, 0, 0, 0] : evalPalette(stops, v);
      }
      out.set(c, (r * LUT_WIDTH + i) * 4);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ legend
export interface LegendTick { value: number; x: number; label: string; small: boolean; raised: boolean; hidden: boolean; alignRight: boolean }

export function legendRange(p: Palette, low: number, high: number): [number, number, boolean] {
  const [a, b] = paletteRange(p);
  return a >= low && b <= high ? [a, b, true] : [low, high, false];
}

export function formatTick(value: number, stopValue: number): { text: string; small: boolean } {
  const a = Math.abs(value);
  if (value !== 0 && a < 0.1) return { text: value.toFixed(2), small: true };
  if (Math.abs(stopValue) < 10) return { text: String(Math.round(value * 10) / 10), small: false };
  const r = Math.round(value);
  return { text: (r < 0 ? '-' : '') + String(Math.abs(r)).padStart(2, '0'), small: false };
}

/**
 * Legend ticks: ticks are palette stops. `measure` returns a label's pixel width for a style.
 * `width` is the bar width W = window width − (units-label width + 16).
 */
export function legendTicks(p: Palette, low: number, high: number, width: number, measure: (s: string, small: boolean) => number): LegendTick[] {
  const [lo, hi, own] = legendRange(p, low, high);
  const stops = p.frames[0];
  const ticks: LegendTick[] = [];
  stops.forEach((s, i) => {
    let value: number | null = null;
    if (own) value = s.v;
    else if (s.v >= lo && s.v <= hi) value = s.v;
    else if (s.v < lo && stops[i + 1] && stops[i + 1].v > lo) value = lo;
    else if (s.v > hi && stops[i - 1] && stops[i - 1].v < hi) value = hi;
    if (value === null) return;
    const f = formatTick(value, s.v);
    ticks.push({ value, x: Math.round(((value - lo) / (hi - lo)) * width), label: f.text, small: f.small, raised: false, hidden: false, alignRight: false });
  });
  // 1–2: raise a tick whose label is wider than the gap to the next tick (unless the previous is raised).
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i], next = ticks[i + 1];
    if (!next) continue;
    if (measure(t.label, t.small) > next.x - t.x) {
      if (i > 0 && ticks[i - 1].raised) t.small = true;
      else { t.raised = true; t.small = true; if (i > 0) ticks[i - 1].small = true; }
    }
  }
  // 3: last tick right-aligned.
  const last = ticks[ticks.length - 1];
  if (last) { last.alignRight = true; last.x = last.x - 2 - measure(last.label, last.small); }
  // 4: a label passing the right edge hides the previous tick.
  for (let i = 1; i < ticks.length; i++) if (ticks[i].x + measure(ticks[i].label, ticks[i].small) > width) ticks[i - 1].hidden = true;
  // 5: per row, an overlap hides the earlier tick.
  for (const raised of [false, true]) {
    let prev: LegendTick | null = null;
    for (const t of ticks) {
      if (t.raised !== raised || t.hidden) continue;
      if (prev && t.x < prev.x + measure(prev.label, prev.small)) prev.hidden = true;
      prev = t;
    }
  }
  return ticks;
}
