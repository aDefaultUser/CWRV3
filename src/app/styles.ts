// Map-object style registry: one editable style per named map object (outlook categories, CIG,
// MD types, ERO, fire outlooks, NHC objects, watch boxes, …). The original's style files are installer-delivered
// and unknown, so the defaults below are independently chosen from public NWS/SPC/WPC/NHC conventions.
// User edits persist locally (the original's geodata\MapObjectSettings) and can be reset per object.
import type { Color } from '../render/prims';
import { loadPref, savePref, isArray, isRecord } from './persist';

export interface MapObjectStyle {
  fill: Color; line: Color; width: number;
  /** 0 solid, 1 hatch, 2 cross-hatch, 3 dots */ pattern: 0 | 1 | 2 | 3; patternSize: number;
  dash: number; border?: Color; visible: boolean;
}

const S = (fill: string, line: string, o: Partial<MapObjectStyle> = {}): MapObjectStyle => ({ fill: hex(fill), line: hex(line), width: 2, pattern: 0, patternSize: 8, dash: 0, visible: true, ...o });
function hex(h: string): Color {
  const v = h.replace('#', '');
  const n = parseInt(v.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, v.length > 6 ? parseInt(v.slice(6, 8), 16) : 255];
}

export const STYLE_DEFAULTS: Record<string, MapObjectStyle> = {
  // SPC categorical (choose: SPC web colours).
  COCatTSTM: S('#C1E9C180', '#55BB55'), COCatMRGL: S('#66A36680', '#005500'), COCatSLGT: S('#FFE06680', '#DDAA00'),
  COCatENH: S('#FFA36680', '#FF6600'), COCatMDT: S('#E0666680', '#CC0000'), COCatHIGH: S('#EE99EE80', '#FF00FF'),
  // SPC probabilistic tornado.
  COTorn2: S('#008B0070', '#008B00'), COTorn5: S('#8B472670', '#8B4726'), COTorn10: S('#FFC80070', '#E6B400'), COTorn15: S('#FF000070', '#FF0000'),
  COTorn30: S('#FF00FF70', '#FF00FF'), COTorn45: S('#912CEE70', '#912CEE'), COTorn60: S('#104E8B70', '#104E8B'),
  // SPC probabilistic wind / hail (also day-3 probabilistic, day 4-8 15/30 %).
  COWH5: S('#8B472670', '#8B4726'), COWH15: S('#FFC80070', '#E6B400'), COWH30: S('#FF000070', '#FF0000'), COWH45: S('#FF00FF70', '#FF00FF'), COWH60: S('#912CEE70', '#912CEE'),
  // Conditional intensity groups (hatched), legacy significant-severe hatching.
  COCIG1: S('#000000B0', '#000000', { pattern: 1, patternSize: 10, width: 1 }), COCIG2: S('#000000C0', '#000000', { pattern: 2, patternSize: 9, width: 1.5 }), COCIG3: S('#000000D0', '#000000', { pattern: 2, patternSize: 6, width: 2 }),
  COSigTorn: S('#000000B0', '#000000', { pattern: 1, patternSize: 8, width: 1 }), COSigHail: S('#000000B0', '#000000', { pattern: 1, patternSize: 8, width: 1 }), COSigWind: S('#000000B0', '#000000', { pattern: 1, patternSize: 8, width: 1 }),
  // WPC excessive rainfall (choose).
  EROMRGL: S('#80C58080', '#3C8C3C'), EROSLGT: S('#F6F67F80', '#C8C800'), EROMDT: S('#E67F7F80', '#C00000'), EROHIGH: S('#FF80FF80', '#C000C0'),
  // Mesoscale discussions (choose).
  MDSevere: S('#3060FF20', '#3060FF', { width: 2.5 }), MDWinter: S('#A040E020', '#A040E0', { width: 2.5 }), MDHeavyRain: S('#20A04020', '#20A040', { width: 2.5 }),
  // SPC fire weather.
  FOElevated: S('#FFC08070', '#E08030'), FOCritical: S('#FF404070', '#D00000'), FOExtreme: S('#FF40FF70', '#C000C0'),
  FOIsoDryT: S('#A0702070', '#805010', { pattern: 1 }), FOScatDryT: S('#D0902070', '#A06010', { pattern: 2 }),
  // NHC (choose).
  NHCCone: S('#FFFFFF66', '#FFFFFF', { width: 1.5 }), NHCTSWatch: S('#00000000', '#FFFF00', { width: 4 }), NHCTSWarn: S('#00000000', '#0060FF', { width: 4 }),
  NHCHurWatch: S('#00000000', '#FF80C0', { width: 4 }), NHCHurWarn: S('#00000000', '#FF0000', { width: 4 }),
  TropBestTrack: S('#00000000', '#FFFFFF', { width: 2 }), TropForecastTrack: S('#00000000', '#FFFFFF', { width: 2, dash: 10 }),
  WindRadii34Kt: S('#FFFF0040', '#FFFF00', { width: 1.5 }), WindRadii50Kt: S('#FF800050', '#FF8000', { width: 1.5 }), WindRadii64Kt: S('#FF000060', '#FF0000', { width: 1.5 }),
  GTwo0: S('#FFFF0050', '#E0E000'), GTwo1: S('#FF900060', '#FF9000'), GTwo2: S('#FF000070', '#FF0000'),
  // Watches.
  TORWatch: S('#00000000', '#FFFF00E6', { width: 2, border: [0, 0, 0, 180] }), TORPDSWatch: S('#00000000', '#FFFF00', { width: 3.4, border: [0, 0, 0, 180] }), TORAVWatch: S('#00000000', '#FFFF00C8', { width: 1.5, dash: 10 }),
  SVRWatch: S('#00000000', '#DB7093E6', { width: 2, border: [0, 0, 0, 180] }), SVRPDSWatch: S('#00000000', '#DB7093', { width: 3.4, border: [0, 0, 0, 180] }), SVRAVWatch: S('#00000000', '#DB7093C8', { width: 1.5, dash: 10 }),
  // Warnings (frozen /: TORWarn etc. are installer-delivered; NWS-conventional colours chosen).
  TORWarn: S('#FF000000', '#FF0000', { width: 2.6, border: [0, 0, 0, 200] }), SVRWarn: S('#FFE10000', '#FFE100', { width: 2.6, border: [0, 0, 0, 200] }),
  SQWWarn: S('#C7158500', '#C71585', { width: 2.6, border: [0, 0, 0, 200] }), SMWWarn: S('#FFA50000', '#FFA500', { width: 2.6, border: [0, 0, 0, 200] }),
  FFWWarn: S('#00D23C00', '#00D23C', { width: 2.6, border: [0, 0, 0, 200] }), SWSWarn: S('#FFE4B500', '#FFE4B5', { width: 2.6, border: [0, 0, 0, 200] }),
  EWWWarn: S('#FF8C0000', '#FF8C00', { width: 2.6, border: [0, 0, 0, 200] }),
  // Roads (TFrmRoadsControl style buttons).
  RoadInterstate: S('#00000000', '#BE785A96', { width: 1.2 }), RoadUS: S('#00000000', '#AA8C6E6E', { width: 0.9 }), RoadState: S('#00000000', '#A096825A', { width: 0.7 }),
  RoadStreet: S('#00000000', '#D2D2D28C', { width: 0.8 }), RoadRamp: S('#00000000', '#C8B4A08C', { width: 0.7 }),
  // Products without vendor object names (CWRV3 choices).
  QPF: S('#00000000', '#FFFFFF', { width: 1 }), WPCWinter: S('#00000000', '#FFFFFF', { width: 1 }), CPC: S('#00000000', '#202020', { width: 1 }),
  DroughtD0: S('#FFFF0090', '#C8C800', { width: 1 }), DroughtD1: S('#FCD37F90', '#D0A040', { width: 1 }), DroughtD2: S('#FFAA0090', '#D08000', { width: 1 }),
  DroughtD3: S('#E6000090', '#B00000', { width: 1 }), DroughtD4: S('#73000090', '#500000', { width: 1 }),
  LSR: S('#00000000', '#FFFFFF', { width: 1 }), Earthquake: S('#00000000', '#FF8000', { width: 1 }), Fire: S('#00000000', '#FF4000', { width: 1 }),
  River: S('#00000000', '#00C000', { width: 1 }), Advisory: S('#80808040', '#808080', { width: 1.5 }), Recon: S('#00000000', '#FFFFFF', { width: 1 }),
  Placefile: S('#FFFFFF40', '#FFFFFF', { width: 1.5 }), UserShape: S('#00000000', '#FFC040', { width: 1.5 }),
};

const user = loadPref<Record<string, Partial<MapObjectStyle>>>('mapObjectStyles', {}, isRecord);
const listeners = new Set<(name: string) => void>();
STYLE_DEFAULTS['WarnCustom:Tornado Emergency'] = S('#FF00FF30', '#FF00FF', { width: 3.5, border: [0, 0, 0, 220] });
STYLE_DEFAULTS['WarnCustom:PDS'] = S('#FF000020', '#FF4040', { width: 3.2, border: [80, 0, 0, 220] });

const resolvers: [string, (rest: string) => MapObjectStyle][] = [];
/** Dynamic styles for families of objects (e.g. "Advisory:<event>") with their own editors. */
export function registerStyleResolver(prefix: string, fn: (rest: string) => MapObjectStyle) { resolvers.push([prefix, fn]); }

export function mapObjectStyle(name: string): MapObjectStyle {
  for (const [p, fn] of resolvers) if (name.startsWith(p)) return { ...fn(name.slice(p.length)), ...(user[name] ?? {}) };
  const base = STYLE_DEFAULTS[name] ?? STYLE_DEFAULTS[name.replace(/\d+$/, '')] ?? S('#80808060', '#C0C0C0');
  return { ...base, ...(user[name] ?? {}) };
}
export function onStyleChange(fn: (name: string) => void) { listeners.add(fn); return () => listeners.delete(fn); }

// ------------------------------------------------------------------------------------------- full style records
// Record shapes follow (TVectorLineStyle: levels of zoom + six passes; TVectorPolygonStyle: levels
// with colour, animation, pattern and texture). Unedited objects derive one zoom level from the seed style above.
import type { LineStyle } from '../render/prims';
import type { FillStyle } from '../render/polys';

export type RGBA = [number, number, number, number];
export interface LinePass {
  on: boolean; color: RGBA; color2: RGBA; width: number; width2: number;
  /** Animation keyframe interval in seconds (0 = off) and non-linear pulse. */
  interval: number; nonLinear: boolean;
  /** 0 solid, 1 stretch dash, 2 round dash, 3 hard dash. */
  dashMode: number; dashSpeed: number; dashSize: number;
  /** 0 normal, 1 shadow/glow, 2 additive (TFrmVectorStyle shading combo). */
  shading: number; perf: boolean; offset: [number, number];
}
export interface LineLevel { zoom: number; passes: LinePass[] }
export const PASS_NAMES = ['Interior Line', 'Line Border 1', 'Line Border 2', 'Bevel', 'Glow 1', 'Glow 2'];
export interface LineStyleDef { levels: LineLevel[]; hardTransitions: boolean; interpolateInvisible: boolean }
export interface PolyLevel {
  zoom: number; color: RGBA; color2: RGBA; interval: number; nonLinear: boolean;
  /** 0 normal, 1 additive. */ blend: number;
  pattern: { on: boolean; type: number; color: RGBA; speed: number; size: number; fixed: boolean };
  texture: { on: boolean; path: string; intensity: number; speed: number; size: number; mode: number };
}
/** Pattern types of TFrmPolygonStyle: 0 Horiz, 1 Vert, 2 Wave, 3 Bubbles, 4 Square Bubbles, 5 Hatch, 6 Dots. */
export const PATTERN_TYPES = ['Horiz', 'Vert', 'Wave', 'Bubbles', 'Square Bubbles', 'Hatch', 'Dots'];
export interface PolyStyleDef { levels: PolyLevel[]; hardTransitions: boolean }
export interface ObjectStyle { line: LineStyleDef; poly: PolyStyleDef; minZoom: number; maxZoom: number; mode: number }

const pass = (o: Partial<LinePass> = {}): LinePass => ({ on: false, color: [255, 255, 255, 255], color2: [255, 255, 255, 255], width: 2, width2: 2, interval: 0, nonLinear: false, dashMode: 0, dashSpeed: 0, dashSize: 8, shading: 0, perf: true, offset: [0, 0], ...o });
/** Seed → full record: interior pass from the line colour/width, border 1 from the seed border, fill level. */
export function fromSeed(s: MapObjectStyle): ObjectStyle {
  const passes = PASS_NAMES.map(() => pass());
  passes[0] = pass({ on: s.visible && s.width > 0, color: s.line, color2: s.line, width: s.width, width2: s.width, dashMode: s.dash ? 3 : 0, dashSize: s.dash || 8 });
  if (s.border) passes[1] = pass({ on: s.visible, color: s.border, color2: s.border, width: s.width + 2, width2: s.width + 2 });
  // Seed pattern 1 hatch, 2 cross-hatch, 3 dots → TFrmPolygonStyle types (Hatch, Square Bubbles grid, Dots).
  const ptype = s.pattern === 1 ? 5 : s.pattern === 2 ? 4 : s.pattern === 3 ? 6 : 5;
  const fill: PolyLevel = { zoom: 0, color: s.pattern ? [0, 0, 0, 0] : s.fill, color2: s.pattern ? [0, 0, 0, 0] : s.fill, interval: 0, nonLinear: false, blend: 0,
    pattern: { on: s.pattern > 0, type: ptype, color: s.fill, speed: 0, size: s.patternSize, fixed: false }, texture: { on: false, path: '', intensity: 100, speed: 0, size: 64, mode: 0 } };
  return { line: { levels: [{ zoom: 0, passes }], hardTransitions: false, interpolateInvisible: true }, poly: { levels: [fill], hardTransitions: false }, minZoom: 0, maxZoom: 100000, mode: 0 };
}

const full = loadPref<Record<string, ObjectStyle>>('objectStyles', {}, isRecord);
export function objectStyle(name: string): ObjectStyle { return full[name] ? structuredClone(full[name]) : fromSeed(mapObjectStyle(name)); }
export function setObjectStyle(name: string, s: ObjectStyle | null) {
  if (s) full[name] = s; else delete full[name];
  const ok = savePref('objectStyles', full, 'object styles');
  for (const f of listeners) f(name);
  return ok;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpC = (a: RGBA, b: RGBA, t: number): RGBA => [0, 1, 2, 3].map((i) => Math.round(lerp(a[i], b[i], t))) as RGBA;
/** The two levels around a zoom and the blend weight (0 with hard transitions). Levels are sorted by zoom. */
function around<T extends { zoom: number }>(levels: T[], z: number, hard: boolean): [T, T, number] {
  const ls = [...levels].sort((a, b) => a.zoom - b.zoom);
  if (ls.length === 1 || z <= ls[0].zoom) return [ls[0], ls[0], 0];
  for (let i = 1; i < ls.length; i++) if (z < ls[i].zoom) {
    if (hard) return [ls[i - 1], ls[i - 1], 0];
    return [ls[i - 1], ls[i], (z - ls[i - 1].zoom) / (ls[i].zoom - ls[i - 1].zoom)];
  }
  return [ls[ls.length - 1], ls[ls.length - 1], 0];
}

/** Render passes (outermost first) for LineSet at camera zoom z. */
export function linePasses(name: string, z: number): LineStyle[] {
  const s = objectStyle(name);
  const visible = z >= s.minZoom && z <= s.maxZoom;
  const [a, b, t] = around(s.line.levels, z, s.line.hardTransitions);
  const out: LineStyle[] = [];
  for (let i = PASS_NAMES.length - 1; i >= 0; i--) {
    const pa = a.passes[i], pb = b.passes[i];
    const on = visible && (pa.on || (!s.line.hardTransitions && s.line.interpolateInvisible && pb.on && t > 0));
    const mix = (k: keyof LinePass) => lerp(pa[k] as number, pb[k] as number, t);
    out.push({ color: lerpC(pa.color, pb.color, t), color2: lerpC(pa.color2, pb.color2, t), width: mix('width'), width2: mix('width2'), interval: pa.interval, nonLinear: pa.nonLinear,
      dash: pa.dashMode ? mix('dashSize') : 0, dashMode: pa.dashMode, dashSpeed: pa.dashSpeed, feather: pa.shading === 1 ? Math.max(2, mix('width') * 0.6) : 0, additive: pa.shading === 2, offset: pa.offset, visible: on && (pa.on ? 1 : t) > 0 } as LineStyle);
  }
  return out;
}

/** Fill for PolySet at camera zoom z. */
export function polyFill(name: string, z: number): FillStyle {
  const s = objectStyle(name);
  const [a, b, t] = around(s.poly.levels, z, s.poly.hardTransitions);
  return {
    color: lerpC(a.color, b.color, t), color2: lerpC(a.color2, b.color2, t), interval: a.interval, nonLinear: a.nonLinear, additive: a.blend === 1,
    pattern: a.pattern.on ? 1 + a.pattern.type : 0, patternColor: lerpC(a.pattern.color, b.pattern.color, t), spacing: lerp(a.pattern.size, b.pattern.size, t), patternSpeed: a.pattern.speed, patternFixed: a.pattern.fixed,
    texture: a.texture.on && a.texture.path ? a.texture.path : '', textureIntensity: a.texture.intensity / 100, textureSpeed: a.texture.speed, textureSize: a.texture.size, textureMode: a.texture.mode,
    visible: z >= s.minZoom && z <= s.maxZoom,
  };
}
/** True when the style changes with zoom (layers then refresh their style buffers as the camera zooms). */
export function zoomDependent(name: string) { const s = objectStyle(name); return s.line.levels.length > 1 || s.poly.levels.length > 1 || s.minZoom > 0 || s.maxZoom < 100000; }

// ------------------------------------------------------------------------------------------- text styles
export interface TextStyleDef {
  font: string; size: number; bold: boolean; italic: boolean; strokeWidth: number; corner: number; glowPasses: number;
  color: RGBA; stroke: RGBA; gradient: boolean; color2: RGBA; gradWidth: number; gradPos: number; kerning: number;
  outer: boolean; outerColor: RGBA; outerSize: number; outerExp: number; outerMix?: number; outerOffset: [number, number]; flashing: boolean;
  box: boolean; boxColor: RGBA; boxColor2: RGBA; boxGradient: boolean; boxPad: [number, number];
}
/** Named text styles (city labels, map timestamp, probe and rollover boxes, warning captions, road labels, annotations). */
export const TEXT_STYLE_DEFAULTS: Record<string, Partial<TextStyleDef>> = {
  CityLabels: { size: 15, bold: true, color: [255, 255, 255, 255], stroke: [0, 0, 0, 200], kerning: 1200 },
  MapTimestamp: { size: 21, bold: true, color: [255, 255, 255, 255], stroke: [0, 0, 0, 255], outer: true, outerColor: [61, 123, 255, 200], outerSize: 8, kerning: 3000 },
  ProbeFont: { size: 13, bold: true, color: [255, 255, 255, 255], stroke: [0, 0, 0, 230] },
  RolloverFont: { size: 12, color: [230, 236, 250, 255], stroke: [0, 0, 0, 200], box: true, boxColor: [8, 12, 24, 215] },
  WarningCaptions: { size: 12, bold: true, color: [255, 255, 255, 255], stroke: [0, 0, 0, 230] },
  RoadLabels: { size: 12, bold: true, color: [255, 245, 220, 255], stroke: [30, 20, 10, 230] },
  Annotations: { size: 16, bold: true, color: [255, 255, 255, 255], stroke: [0, 0, 0, 230] },
};
const TEXT_BASE: TextStyleDef = { font: 'Noto Sans Condensed', size: 12, bold: false, italic: false, strokeWidth: 3.5, corner: 2, glowPasses: 3, color: [255, 255, 255, 255], stroke: [0, 0, 0, 220], gradient: false, color2: [200, 220, 255, 255], gradWidth: 50, gradPos: 50, kerning: 0, outer: false, outerColor: [0, 0, 0, 160], outerSize: 6, outerExp: 50, outerOffset: [0, 0], flashing: false, box: false, boxColor: [0, 0, 0, 160], boxColor2: [30, 40, 70, 160], boxGradient: false, boxPad: [4, 2] };
const textUser = loadPref<Record<string, TextStyleDef>>('textStyles', {}, isRecord);
/** True once the user edited a text style (layers keep their native look until then). */
export function hasTextStyle(name: string) { return !!textUser[name]; }
export function textStyle(name: string): TextStyleDef { return structuredClone(textUser[name] ?? { ...TEXT_BASE, ...(TEXT_STYLE_DEFAULTS[name] ?? {}) }); }
export function setTextStyle(name: string, s: TextStyleDef | null) {
  if (s) textUser[name] = s; else delete textUser[name];
  const ok = savePref('textStyles', textUser, 'text styles');
  for (const f of listeners) f(`text:${name}`);
  return ok;
}
/** CSS for DOM text (timestamp, probe, rollover) from a text style. */
export function textCss(name: string): Partial<CSSStyleDeclaration> {
  const t = textStyle(name);
  const rgba = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})`;
  const shadows = [`0 0 ${t.strokeWidth / 2}px ${rgba(t.stroke)}`, `0 0 ${t.strokeWidth}px ${rgba(t.stroke)}`];
  if (t.outer) shadows.push(`${t.outerOffset[0]}px ${t.outerOffset[1]}px ${Math.max(0, t.outerSize)}px ${rgba(t.outerColor)}`);
  return {
    fontFamily: `"${t.font}", "Noto Sans", sans-serif`, fontSize: `${t.size}px`, fontWeight: t.bold ? '700' : '400', fontStyle: t.italic ? 'italic' : 'normal',
    color: rgba(t.color), letterSpacing: `${t.kerning / 1000}px`, textShadow: shadows.join(', '),
    background: t.box ? (t.boxGradient ? `linear-gradient(${rgba(t.boxColor)}, ${rgba(t.boxColor2)})` : rgba(t.boxColor)) : '', padding: t.box ? `${t.boxPad[1]}px ${t.boxPad[0]}px` : '',
    animation: t.flashing ? 'wsvflash 1s steps(2) infinite' : '',
  };
}

/** Line style buffers for a set of object names at zoom z: six passes per name, outermost first. */
export function passTable(names: string[], z: number): { styles: LineStyle[]; idx: (name: string) => number[] } {
  const styles: LineStyle[] = [];
  const on = new Map<string, number[]>();
  names.forEach((n, i) => {
    styles.push(...linePasses(n, z));
    const st = objectStyle(n);
    on.set(n, [5, 4, 3, 2, 1, 0].filter((k) => st.line.levels.some((l) => l.passes[k]?.on)).map((k) => i * 6 + (5 - k)));
  });
  return { styles, idx: (n) => on.get(n) ?? [] };
}

/** Custom warning styles matched by text phrases (TFrmWarningControl "Styles" page). */
export interface WarnCustomStyle { name: string; phrases: string[] }
export const warningCustomStyles = loadPref<WarnCustomStyle[]>('warningCustomStyles', [{ name: 'Tornado Emergency', phrases: ['TORNADO EMERGENCY'] }, { name: 'PDS', phrases: ['PARTICULARLY DANGEROUS SITUATION'] }], isArray);
export function saveWarningCustomStyles() { const ok = savePref('warningCustomStyles', warningCustomStyles, 'custom warning styles'); for (const f of listeners) f('WarnCustom'); return ok; }
