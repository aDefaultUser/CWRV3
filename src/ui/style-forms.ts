// Bindings for the original style dialogs: TFrmStyleEditor (object hub: line and fill
// style selection, zoom range, display mode), TFrmVectorStyle (line passes, zoom levels, animation, dashes),
// TFrmPolygonStyle (fill, animation, pattern, texture), TFrmTextAppearance and TFrmFontControl (text styles).
import type { Binding, BindingMap } from './form';
import { objectStyle, setObjectStyle, textStyle, setTextStyle, PASS_NAMES, PATTERN_TYPES, type ObjectStyle, type LinePass, type PolyLevel, type RGBA, type TextStyleDef, type LineStyleDef, type PolyStyleDef } from '../app/styles';
import { openDialog, closeDialog, promptBox } from './dialogs';
import type { App } from '../app/app';
import { loadPref, savePref, isRecord } from '../app/persist';

export const editor = { obj: 'COCatSLGT', title: 'COCatSLGT', level: 0, pass: 0, text: 'CityLabels', resolution: 0 };
interface Library { line: Record<string, LineStyleDef>; poly: Record<string, PolyStyleDef> }
const lib: Library = { line: {}, poly: {}, ...loadPref<Partial<Library>>('styleLibrary', {}, isRecord) };
const saveLib = () => savePref('styleLibrary', lib, 'style library');

const cur = () => objectStyle(editor.obj);
const put = (fn: (s: ObjectStyle) => void) => { const s = cur(); fn(s); setObjectStyle(editor.obj, s); };
const lvl = (s: ObjectStyle) => s.line.levels[Math.min(editor.level, s.line.levels.length - 1)];
const plvl = (s: ObjectStyle) => s.poly.levels[Math.min(editor.level, s.poly.levels.length - 1)];
const pass = (s: ObjectStyle) => lvl(s).passes[editor.pass];
const c3 = (c: RGBA) => [c[0], c[1], c[2]];

function custom(get: () => unknown, set: (v: any) => void, items?: () => string[], extra: Partial<Extract<Binding, { kind: 'custom' }>> = {}): Binding { return { kind: 'custom', get, set, items, ...extra }; }
const act = (run: () => void, caption?: () => string): Binding => ({ kind: 'action', run, caption });
const status = (text: () => string): Binding => ({ kind: 'status', text });

/** Number field of a pass / level; colours as RGB with separate alpha fields. */
const passNum = (k: keyof LinePass) => custom(() => pass(cur())[k], (v) => put((s) => { (pass(s) as unknown as Record<string, number>)[k as string] = Number(v); }));
const passColor = (k: 'color' | 'color2') => custom(() => c3(pass(cur())[k]), (v: number[]) => put((s) => { const p = pass(s); p[k] = [v[0], v[1], v[2], p[k][3]]; }));
const passAlpha = (k: 'color' | 'color2') => custom(() => pass(cur())[k][3], (v) => put((s) => { pass(s)[k][3] = Math.max(0, Math.min(255, Number(v))); }));

function zoomItems(levels: { zoom: number }[]) { return levels.length === 1 ? ['All zooms'] : levels.map((l, i) => (i === 0 ? `Below ${levels[1].zoom.toFixed(1)}` : `Zoom ≥ ${l.zoom.toFixed(1)}`)); }

export function styleFormBindings(app: App): Record<string, BindingMap> {
  const z = () => app.renderer.camera.cur.z;
  const addLevel = (kind: 'line' | 'poly') => put((s) => {
    const levels = (kind === 'line' ? s.line.levels : s.poly.levels) as { zoom: number }[];
    const src = kind === 'line' ? lvl(s) : plvl(s);
    levels.push({ ...structuredClone(src), zoom: Math.round(z() * 10) / 10 });
    levels.sort((a, b) => a.zoom - b.zoom);
    editor.level = levels.findIndex((l) => l.zoom === Math.round(z() * 10) / 10);
  });
  const delLevel = (kind: 'line' | 'poly') => put((s) => {
    const levels = kind === 'line' ? s.line.levels : s.poly.levels;
    if (levels.length > 1) { levels.splice(editor.level, 1); editor.level = Math.max(0, editor.level - 1); }
    if (levels[0]) levels[0].zoom = 0;
  });

  // ------------------------------------------------------------------- TFrmVectorStyle (line style)
  const V = 'TFrmVectorStyle.';
  const vector: BindingMap = {
    [V + 'sSpeedButton40']: act(() => addLevel('line')),
    [V + 'sSpeedButton1']: act(() => delLevel('line')),
    [V + 'sLabelFX1']: status(() => `Current map zoom:\n${z().toFixed(1)}`),
    [V + 'sListBox1']: { kind: 'list', items: () => zoomItems(cur().line.levels).map((label) => ({ label })), selected: () => editor.level, select: (i) => { editor.level = i; } },
    [V + 'rPasses']: { kind: 'list', items: () => PASS_NAMES.map((label, i) => ({ label, checked: lvl(cur()).passes[i].on })), selected: () => editor.pass, select: (i) => { editor.pass = i; }, check: (i, on) => put((s) => { lvl(s).passes[i].on = on; }) },
    [V + 'sSpinEdit5']: custom(() => pass(cur()).offset[0], (v) => put((s) => { pass(s).offset[0] = Number(v); })),
    [V + 'sSpinEdit6']: custom(() => pass(cur()).offset[1], (v) => put((s) => { pass(s).offset[1] = Number(v); })),
    [V + 'sComboBox1']: custom(() => pass(cur()).shading, (v) => put((s) => { pass(s).shading = Number(v); })),
    [V + 'sCheckBox2']: custom(() => cur().line.interpolateInvisible, (v) => put((s) => { s.line.interpolateInvisible = !!v; })),
    [V + 'sCheckBox3']: custom(() => cur().line.hardTransitions, (v) => put((s) => { s.line.hardTransitions = !!v; })),
    [V + 'sColorSelect1']: passColor('color'), [V + 'sTrackEdit1']: passNum('width'), [V + 'sTrackEdit3']: passAlpha('color'),
    // Animation keyframe group: its check box turns the animation on (interval > 0).
    [V + 'sGroupBox1']: custom(() => pass(cur()).interval > 0, (v) => put((s) => { pass(s).interval = v ? Math.max(0.2, pass(s).interval || 1) : 0; })),
    [V + 'sColorSelect2']: passColor('color2'), [V + 'sTrackEdit2']: passNum('width2'), [V + 'sTrackEdit4']: passAlpha('color2'),
    [V + 'sTrackEdit5']: custom(() => pass(cur()).interval || 1, (v) => put((s) => { pass(s).interval = Math.max(0.2, Number(v)); })),
    [V + 'sCheckBox1']: custom(() => pass(cur()).nonLinear, (v) => put((s) => { pass(s).nonLinear = !!v; })),
    [V + 'sTrackEdit6']: passNum('dashSpeed'), [V + 'sTrackEdit7']: passNum('dashSize'),
    [V + 'sCheckBox4']: custom(() => pass(cur()).perf, (v) => put((s) => { pass(s).perf = !!v; })),
    [V + 'sSpeedButton2']: act(() => app.toast('Dash modes: Stretch = soft-ended dashes, Round = dots, Hard = sharp dashes. Dash speed moves the pattern along the line (px/s).')),
  };
  ['sRadioButton1', 'sRadioButton2', 'sRadioButton3', 'sRadioButton4'].forEach((r, i) => { vector[V + r] = custom(() => pass(cur()).dashMode === i, () => put((s) => { pass(s).dashMode = i; })); });

  // ------------------------------------------------------------------- TFrmPolygonStyle (fill style)
  const P = 'TFrmPolygonStyle.';
  const pnum = (fn: (l: PolyLevel) => number, set: (l: PolyLevel, v: number) => void) => custom(() => fn(plvl(cur())), (v) => put((s) => set(plvl(s), Number(v))));
  const polygon: BindingMap = {
    [P + 'sSpeedButton40']: act(() => addLevel('poly')),
    [P + 'sSpeedButton1']: act(() => delLevel('poly')),
    [P + 'sLabelFX1']: status(() => `Current map zoom:\n${z().toFixed(1)}`),
    [P + 'sListBox1']: { kind: 'list', items: () => zoomItems(cur().poly.levels).map((label) => ({ label })), selected: () => editor.level, select: (i) => { editor.level = i; } },
    [P + 'sColorSelect1']: custom(() => c3(plvl(cur()).color), (v: number[]) => put((s) => { const l = plvl(s); l.color = [v[0], v[1], v[2], l.color[3]]; if (!l.interval) l.color2 = [...l.color]; })),
    [P + 'sTrackEdit3']: pnum((l) => l.color[3], (l, v) => { l.color[3] = v; if (!l.interval) l.color2[3] = v; }),
    [P + 'sGroupBox1']: custom(() => plvl(cur()).interval > 0, (v) => put((s) => { const l = plvl(s); l.interval = v ? Math.max(0.2, l.interval || 1) : 0; })),
    [P + 'sColorSelect2']: custom(() => c3(plvl(cur()).color2), (v: number[]) => put((s) => { const l = plvl(s); l.color2 = [v[0], v[1], v[2], l.color2[3]]; })),
    [P + 'sTrackEdit4']: pnum((l) => l.color2[3], (l, v) => { l.color2[3] = v; }),
    [P + 'sTrackEdit5']: pnum((l) => l.interval || 1, (l, v) => { l.interval = Math.max(0.2, v); }),
    [P + 'sCheckBox1']: custom(() => plvl(cur()).nonLinear, (v) => put((s) => { plvl(s).nonLinear = !!v; })),
    [P + 'sComboBox1']: custom(() => plvl(cur()).blend, (v) => put((s) => { plvl(s).blend = Number(v); })),
    [P + 'sCheckBox3']: custom(() => cur().poly.hardTransitions, (v) => put((s) => { s.poly.hardTransitions = !!v; })),
    [P + 'sGroupBox2']: custom(() => plvl(cur()).pattern.on, (v) => put((s) => { plvl(s).pattern.on = !!v; })),
    [P + 'sColorSelect3']: custom(() => c3(plvl(cur()).pattern.color), (v: number[]) => put((s) => { const p = plvl(s).pattern; p.color = [v[0], v[1], v[2], p.color[3]]; })),
    [P + 'sTrackEdit1']: pnum((l) => l.pattern.color[3], (l, v) => { l.pattern.color[3] = v; }),
    [P + 'sTrackEdit6']: pnum((l) => l.pattern.speed, (l, v) => { l.pattern.speed = v; }),
    [P + 'sTrackEdit7']: pnum((l) => l.pattern.size, (l, v) => { l.pattern.size = v; }),
    [P + 'sCheckBox4']: custom(() => plvl(cur()).pattern.fixed, (v) => put((s) => { plvl(s).pattern.fixed = !!v; })),
    [P + 'sCheckBox5']: custom(() => plvl(cur()).texture.on, (v) => put((s) => { plvl(s).texture.on = !!v; })),
    [P + 'sFilenameEdit1']: custom(() => plvl(cur()).texture.path.startsWith('blob:') ? '(local image)' : plvl(cur()).texture.path, (v) => put((s) => { plvl(s).texture.path = String(v); })),
    [P + 'sTrackEdit2']: pnum((l) => l.texture.intensity, (l, v) => { l.texture.intensity = v; }),
    [P + 'sTrackEdit8']: pnum((l) => l.texture.speed, (l, v) => { l.texture.speed = v; }),
    [P + 'sTrackEdit9']: pnum((l) => l.texture.size, (l, v) => { l.texture.size = v; }),
  };
  // Pattern radios: Horiz, Vert, Wave, Bubbles, Square Bubbles, Hatch, Dots (PATTERN_TYPES order).
  ['sRadioButton1', 'sRadioButton2', 'sRadioButton3', 'sRadioButton4', 'sRadioButton5', 'sRadioButton6', 'sRadioButton7'].forEach((r, i) => { polygon[P + r] = custom(() => plvl(cur()).pattern.type === i, () => put((s) => { plvl(s).pattern.type = i; plvl(s).pattern.on = true; })); });
  ['sRadioButton8', 'sRadioButton9', 'sRadioButton10', 'sRadioButton11'].forEach((r, i) => { polygon[P + r] = custom(() => plvl(cur()).texture.mode === i, () => put((s) => { plvl(s).texture.mode = i; })); });
  void PATTERN_TYPES;

  // ------------------------------------------------------------------- TFrmStyleEditor (object hub)
  const E = 'TFrmStyleEditor.';
  const lineNames = () => ['(this object)', ...Object.keys(lib.line)];
  const polyNames = () => ['(this object)', ...Object.keys(lib.poly)];
  const hub: BindingMap = {
    [E + 'sLabelFX1']: status(() => `Current map zoom: ${z().toFixed(1)}`),
    [E + 'sLabelFX3']: status(() => `Max zoom: ${cur().maxZoom >= 100000 ? '∞' : cur().maxZoom.toFixed(1)}`),
    [E + 'sLabelFX5']: status(() => `Min zoom:   ${cur().minZoom.toFixed(1)}`),
    [E + 'sBitBtn1']: act(() => put((s) => { s.maxZoom = z(); })),
    [E + 'sBitBtn2']: act(() => put((s) => { s.minZoom = z(); })),
    [E + 'sCheckBox1']: custom(() => cur().minZoom > 0 || cur().maxZoom < 100000, (v) => put((s) => { if (!v) { s.minZoom = 0; s.maxZoom = 100000; } })),
    [E + 'sSpinEdit1']: custom(() => editor.resolution, (v) => { editor.resolution = Number(v); app.styleResolution(editor.obj, editor.resolution); }),
    [E + 'sBitBtn7']: act(() => app.styleResolution(editor.obj, editor.resolution, true)),
    [E + 'sRadioButton1']: custom(() => cur().mode === 0, () => put((s) => { s.mode = 0; })),
    [E + 'sRadioButton2']: custom(() => cur().mode === 1, () => put((s) => { s.mode = 1; })),
    [E + 'sRadioButton3']: custom(() => cur().mode === 2, () => put((s) => { s.mode = 2; })),
    [E + 'sComboBox1']: custom(() => 0, (i: number) => { const n = lineNames()[i]; if (i > 0 && lib.line[n]) put((s) => { s.line = structuredClone(lib.line[n]); }); }, lineNames),
    [E + 'sComboBox2']: custom(() => 0, (i: number) => { const n = polyNames()[i]; if (i > 0 && lib.poly[n]) put((s) => { s.poly = structuredClone(lib.poly[n]); }); }, polyNames),
    [E + 'sBitBtn3']: act(() => { closeDialog('TFrmVectorStyle'); openDialog('TFrmVectorStyle', app.bindings.TFrmVectorStyle, { title: `Line Style Editor — ${editor.title}` }); }),
    [E + 'sBitBtn5']: act(() => { closeDialog('TFrmPolygonStyle'); openDialog('TFrmPolygonStyle', app.bindings.TFrmPolygonStyle, { title: `Polygon Style Editor — ${editor.title}` }); }),
    [E + 'sBitBtn4']: act(async () => { const n = await promptBox('New line style', 'Name of the new line style (saved from this object):'); if (n) { lib.line[n] = structuredClone(cur().line); saveLib(); } }),
    [E + 'sBitBtn6']: act(async () => { const n = await promptBox('New fill style', 'Name of the new fill style (saved from this object):'); if (n) { lib.poly[n] = structuredClone(cur().poly); saveLib(); } }),
    [E + 'sBitBtn8']: act(async () => { const n = await promptBox('Duplicate line style', 'Name of the copy:', `${editor.title} copy`); if (n) { lib.line[n] = structuredClone(cur().line); saveLib(); } }),
    [E + 'sBitBtn9']: act(async () => { const n = await promptBox('Duplicate fill style', 'Name of the copy:', `${editor.title} copy`); if (n) { lib.poly[n] = structuredClone(cur().poly); saveLib(); } }),
  };

  // ------------------------------------------------------------------- text styles
  const T = 'TFrmTextAppearance.';
  const ts = () => textStyle(editor.text);
  const tput = (fn: (t: TextStyleDef) => void) => { const t = ts(); fn(t); setTextStyle(editor.text, t); };
  const tcol = (k: 'color' | 'stroke' | 'color2' | 'outerColor' | 'boxColor' | 'boxColor2') => custom(() => c3(ts()[k]), (v: number[]) => tput((t) => { t[k] = [v[0], v[1], v[2], t[k][3]]; }));
  const talpha = (k: 'color' | 'stroke' | 'color2' | 'outerColor' | 'boxColor' | 'boxColor2') => custom(() => ts()[k][3], (v) => tput((t) => { t[k][3] = Math.max(0, Math.min(255, Number(v))); }));
  const tnum = (get: (t: TextStyleDef) => number, set: (t: TextStyleDef, v: number) => void) => custom(() => get(ts()), (v) => tput((t) => set(t, Number(v))));
  const tbool = (k: 'gradient' | 'outer' | 'flashing' | 'box' | 'boxGradient' | 'bold' | 'italic') => custom(() => ts()[k], (v) => tput((t) => { t[k] = !!v; }));
  const text: BindingMap = {
    [T + 'sColorSelect1']: tcol('color'), [T + 'sSpinEdit1']: talpha('color'),
    [T + 'sCheckBox1']: tbool('gradient'), [T + 'sColorSelect2']: tcol('color2'), [T + 'sSpinEdit2']: talpha('color2'),
    [T + 'sColorSelect3']: tcol('stroke'), [T + 'sSpinEdit3']: talpha('stroke'),
    [T + 'sCheckBox2']: tbool('outer'), [T + 'sColorSelect4']: tcol('outerColor'), [T + 'sSpinEdit4']: talpha('outerColor'),
    [T + 'sTrackBar5']: tnum((t) => t.kerning, (t, v) => { t.kerning = v; }),
    [T + 'sTrackBar3']: tnum((t) => t.outerSize, (t, v) => { t.outerSize = v; }),
    [T + 'sTrackBar4']: tnum((t) => t.outerMix ?? 0, (t, v) => { t.outerMix = v; }),
    [T + 'sDecimalSpinEdit1']: tnum((t) => t.outerExp / 25, (t, v) => { t.outerExp = v * 25; }),
    [T + 'sSpinEdit5']: tnum((t) => t.outerOffset[0], (t, v) => { t.outerOffset[0] = v; }),
    [T + 'sSpinEdit6']: tnum((t) => t.outerOffset[1], (t, v) => { t.outerOffset[1] = v; }),
    [T + 'sCheckBox3']: tbool('flashing'),
    [T + 'sTrackBar1']: tnum((t) => t.gradWidth, (t, v) => { t.gradWidth = v; }),
    [T + 'sTrackBar2']: tnum((t) => t.gradPos, (t, v) => { t.gradPos = v; }),
    [T + 'sGroupBox1']: tbool('box'),
    [T + 'sColorSelect5']: tcol('boxColor'), [T + 'sSpinEdit9']: talpha('boxColor'),
    [T + 'sCheckBox4']: tbool('boxGradient'), [T + 'sColorSelect6']: tcol('boxColor2'), [T + 'sSpinEdit10']: talpha('boxColor2'),
    [T + 'sSpinEdit7']: tnum((t) => t.boxPad[0], (t, v) => { t.boxPad[0] = v; }),
    [T + 'sSpinEdit8']: tnum((t) => t.boxPad[1], (t, v) => { t.boxPad[1] = v; }),
  };
  const F = 'TFrmFontControl.';
  const FONTS = ['Noto Sans Condensed', 'Noto Sans', 'DejaVu Sans', 'DejaVu Sans Condensed', 'Liberation Sans', 'Segoe UI', 'Arial', 'Verdana', 'monospace', 'serif'];
  const font: BindingMap = {
    [F + 'sFontComboBox1']: custom(() => Math.max(0, FONTS.indexOf(ts().font)), (i: number) => tput((t) => { t.font = FONTS[i]; }), () => FONTS),
    [F + 'sDecimalSpinEdit1']: tnum((t) => t.size, (t, v) => { t.size = v; }),
    [F + 'sCheckBox1']: tbool('bold'), [F + 'sCheckBox2']: tbool('italic'),
    [F + 'sListBox1']: { kind: 'list', items: () => ['Miter', 'Bevel', 'Round', 'Miter Clipped'].map((label) => ({ label })), selected: () => ts().corner, select: (i) => tput((t) => { t.corner = i; }) },
    [F + 'sRadioButton1']: custom(() => ts().glowPasses === 1, () => tput((t) => { t.glowPasses = 1; })),
    [F + 'sRadioButton2']: custom(() => ts().glowPasses === 2, () => tput((t) => { t.glowPasses = 2; })),
    [F + 'sRadioButton3']: custom(() => ts().glowPasses === 3, () => tput((t) => { t.glowPasses = 3; })),
    [F + 'sDecimalSpinEdit2']: tnum((t) => t.strokeWidth * 10, (t, v) => { t.strokeWidth = v / 10; }),
  };
  return { TFrmVectorStyle: vector, TFrmPolygonStyle: polygon, TFrmStyleEditor: hub, TFrmTextAppearance: text, TFrmFontControl: font };
}

/** Opens the style hub for a named map object (TFrmStyleEditor; EDIT buttons open the line / fill editors). */
export function openObjectStyle(app: App, name: string, title = name) {
  editor.obj = name; editor.title = title; editor.level = 0; editor.pass = 0;
  closeDialog('TFrmStyleEditor');
  openDialog('TFrmStyleEditor', app.bindings.TFrmStyleEditor, { title: `Style Editor — ${title}` });
}
export function openTextStyle(app: App, name: string, which: 'appearance' | 'font') {
  editor.text = name;
  const form = which === 'font' ? 'TFrmFontControl' : 'TFrmTextAppearance';
  closeDialog(form);
  openDialog(form, app.bindings[form], { title: `${which === 'font' ? 'Font Control' : 'Text Appearance'} — ${name}` });
}
