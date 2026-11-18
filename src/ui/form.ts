// Generic renderer for the original form layouts (design-time geometry from ui-controls.catalog.json, generated
// into src/generated/ui-forms.ts) with explicit control bindings. Captions are short functional labels only.
import { settingExclusion } from '../settings/exclusions';
import { FORMS } from '../generated/ui-forms';
import { ANALYSIS_FORMS } from '../generated/ui-forms-analysis';
import { ARCHIVE_FORMS } from '../generated/ui-forms-archive';
import type { ControlDef, FormDef } from './form-types';
import { settings, SETTING_DEFS } from '../settings/store';

export type Binding =
  | { kind: 'bool'; id: string; invert?: boolean; label?: string }
  | { kind: 'radio'; id: string; value: unknown }
  | { kind: 'num'; id: string; scale?: number; offset?: number; step?: number; min?: number; max?: number }
  | { kind: 'combo'; id: string; values?: unknown[] }
  | { kind: 'text'; id: string }
  | { kind: 'color'; id: string }
  | { kind: 'arrayItem'; id: string; index: number }
  | { kind: 'custom'; get: () => unknown; set: (v: any) => void; items?: () => string[]; disabled?: () => boolean; hidden?: () => boolean; max?: () => number }
  | { kind: 'action'; run: (el: HTMLElement) => void; down?: () => boolean; disabled?: () => boolean; caption?: () => string; icon?: () => string; label?: string; iconName?: string; title?: () => string }
  | { kind: 'status'; text: () => string }
  | { kind: 'busy'; on: () => boolean }
  | { kind: 'gauge'; value: () => number; max: number }
  | { kind: 'list'; items: () => { label: string; disabled?: boolean; checked?: boolean }[]; selected: () => number; select: (i: number, dbl: boolean) => void; check?: (i: number, on: boolean) => void }
  | { kind: 'na'; reason: string };

export type BindingMap = Record<string, Binding>;

/** Tabler icon slot per control (see theme.css); captions stay as text next to the glyph. */
const ICONS: Record<string, [string, boolean?]> = {
  'ui.TBasicLayersFrame.sSpeedButton9': ['satellite'], 'ui.TBasicLayersFrame.sSpeedButton2': ['bolt'],
  'ui.TFrmMap.mapMode0': ['map', true], 'ui.TFrmMap.mapMode1': ['pencil', true], 'ui.TFrmMap.mapMode2': ['crosshair', true],
  'ui.TFrmMap.sSpeedButton1': ['camera'], 'ui.TFrmMap.sSpeedButton2': ['record'], 'ui.TFrmMap.sBitBtn1': ['mapstyle', true],
  'ui.TFrmMap.ToolButton2': ['first'], 'ui.TFrmMap.ToolButton3': ['prev'], 'ui.TFrmMap.ToolButton9': ['next'], 'ui.TFrmMap.ToolButton10': ['last'],
};
/** Accessible names of icon-only controls. */
const ICON_LABELS: Record<string, string> = {
  'ui.TFrmMap.ToolButton2': 'First frame', 'ui.TFrmMap.ToolButton3': 'Previous frame', 'ui.TFrmMap.ToolButton5': 'Play or pause the loop',
  'ui.TFrmMap.ToolButton9': 'Next frame', 'ui.TFrmMap.ToolButton10': 'Skip to the newest frame (pauses)',
};

export const formDef = (name: string): FormDef => {
  const f = FORMS.find((x) => x.form === name) ?? ANALYSIS_FORMS.find((x) => x.form === name) ?? ARCHIVE_FORMS.find((x) => x.form === name);
  if (!f) throw new Error(`form ${name} not in catalog`);
  return f;
};

/** Plain VCL classes of the expanded forms render like their AlphaControls counterparts. */
const VCL: Record<string, string> = { TCheckBox: 'TsCheckBox', TButton: 'TsButton', TPanel: 'TsPanel', TLabel: 'TsLabel', TMemo: 'TsMemo', TCheckListBox: 'TsCheckListBox', TListView: 'TsListView', TListBox: 'TsListBox', TEdit: 'TsEdit', TComboBox: 'TsComboBox', TTrackBar: 'TsTrackBar', TPageControl: 'TsPageControl', TTabSheet: 'TsTabSheet', TGroupBox: 'TsGroupBox', TRadioButton: 'TsRadioButton', TSpinEdit: 'TsSpinEdit', TBitBtn: 'TsBitBtn', TSpeedButton: 'TsSpeedButton', TBevel: 'TsBevel', TRadioGroup: 'TsRadioGroup', TUpDown: 'TsUpDown' };
export const normCls = (cls: string) => VCL[cls] ?? cls;
const CONTAINERS = new Set(['TsPanel', 'TsGroupBox', 'TsTabSheet', 'TsPageControl', 'TsToolBar', 'TsFrameBar', 'TsRadioGroup']);
const MENU = new Set(['TPopupMenu', 'TMenuItem']);
const SKIP = new Set(['TsAlphaImageList', 'TImageList', 'TShape', 'TsImage', 'TsStatusBar']);

export interface RenderedForm {
  el: HTMLElement; refresh: () => void; controls: Map<string, HTMLElement>; destroy: () => void;
  width: number; height: number;
}

function caption(c: ControlDef): string { return (c.caption ?? '').replace(/&&/g, '&').replace(/&(?=\S)/g, ''); }

/**
 * Fits text controls to their design boxes: a caption wider than its control is set in a smaller size (down to
 * 8 px, then condensed letter spacing) instead of overflowing into its neighbours.
 */
export function fitLabels(root: HTMLElement) {
  for (const n of root.querySelectorAll<HTMLElement>('.ctl.chk, .ctl.radio, .ctl.label, .ctl.labelfx, .ctl.speedbtn, .ctl.btn')) {
    const text = n.textContent ?? '';
    if (!n.clientWidth || n.dataset.fit === text) continue;
    n.dataset.fit = text;
    n.style.fontSize = ''; n.style.letterSpacing = '';
    if (n.scrollWidth <= n.clientWidth + 1) continue;
    let size = parseFloat(getComputedStyle(n).fontSize) || 11;
    while (n.scrollWidth > n.clientWidth + 1 && size > 8) { size -= 0.5; n.style.fontSize = `${size}px`; }
    if (n.scrollWidth > n.clientWidth + 1) n.style.letterSpacing = '-0.4px';
  }
}

/** Runs one write made through a form (a dialog's edit transaction wraps it; see SettingsStore.record). */
export type FormEdit = (write: () => void) => void;
const direct: FormEdit = (write) => write();

/** The binding with each of its own write functions run inside `edit`. */
function editing(b: Binding, edit: FormEdit): Binding {
  switch (b.kind) {
    case 'custom': return { ...b, set: (v) => edit(() => b.set(v)) };
    case 'action': return { ...b, run: (el) => edit(() => b.run(el)) };
    case 'list': return { ...b, select: (i, dbl) => edit(() => b.select(i, dbl)), check: b.check && ((i, on) => edit(() => b.check!(i, on))) };
    default: return b;
  }
}

export function renderForm(formName: string, bindings: BindingMap, opts: { root?: string; width?: number; height?: number; edit?: FormEdit } = {}): RenderedForm {
  const form = formDef(formName);
  const byParent = new Map<string | null, ControlDef[]>();
  for (const c0 of form.controls) {
    const c = c0.cls in VCL ? { ...c0, cls: VCL[c0.cls] } : c0;
    if (!byParent.has(c.parent)) byParent.set(c.parent, []);
    byParent.get(c.parent)!.push(c);
  }
  const rootName = opts.root ?? form.controls[0].name;
  const controls = new Map<string, HTMLElement>();
  const refreshers: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  const el = document.createElement('div');
  el.className = 'form';

  const edit = opts.edit ?? direct;
  const bindFor = (c: ControlDef) => { const b = bindings[c.id.replace(/^ui\./, '')] ?? bindings[c.id] ?? autoBinding(c); return b && opts.edit ? editing(b, edit) : b; };

  const place = (node: HTMLElement, c: ControlDef) => {
    node.style.left = `${c.l ?? 0}px`;
    node.style.top = `${c.t ?? 0}px`;
    if (c.w !== undefined) node.style.width = `${Math.max(0, c.w)}px`;
    if (c.h !== undefined) node.style.height = `${Math.max(0, c.h)}px`;
  };

  const build = (parentEl: HTMLElement, parentName: string) => {
    for (const c of byParent.get(parentName) ?? []) {
      if (c.nonvisual || MENU.has(c.cls) || SKIP.has(c.cls)) continue;
      const bnd = bindings[c.id.replace(/^ui\./, '')];
      if (c.visible === false && (!bnd || bnd.kind === 'na')) continue;
      const node = renderControl(c, bindFor(c), refreshers, edit);
      place(node, c);
      controls.set(c.name, node);
      parentEl.appendChild(node);
      if (CONTAINERS.has(c.cls) && c.cls !== 'TsPageControl') build(node, c.name);
      if (c.cls === 'TsPageControl') buildPages(node, c);
    }
  };

  const buildPages = (node: HTMLElement, pc: ControlDef) => {
    node.classList.add('pages');
    const sheets = (byParent.get(pc.name) ?? []).filter((x) => x.cls === 'TsTabSheet');
    const row = document.createElement('div'); row.className = 'tabsrow';
    const area = document.createElement('div'); area.className = 'sheet';
    node.append(row, area);
    // A page control without design-time sheets whose binding lists items gets one tab per item (e.g. tilts).
    const dyn = bindings[pc.id.replace(/^ui\./, '')];
    if (!sheets.length && dyn?.kind === 'custom' && dyn.items) {
      let last = '';
      refreshers.push(() => {
        const items = dyn.items!(), cur = Number(dyn.get());
        const sig = items.join('|') + cur;
        if (sig === last) return;
        last = sig; row.textContent = '';
        items.forEach((label, i) => { const t = document.createElement('div'); t.textContent = label; if (i === cur) t.className = 'on'; t.onclick = () => edit(() => dyn.set(i)); keyboardClick(t, 'tab'); row.appendChild(t); });
      });
      return;
    }
    const bodies: HTMLElement[] = [];
    let active = Math.max(0, sheets.findIndex((s) => s.name === pc.activePage));
    sheets.forEach((s, i) => {
      const tab = document.createElement('div');
      tab.textContent = caption(s);
      tab.onclick = () => { active = i; show(); };
      keyboardClick(tab, 'tab');
      row.appendChild(tab);
      const body = document.createElement('div');
      body.style.position = 'absolute'; body.style.inset = '0';
      controls.set(s.name, body);
      build(body, s.name);
      bodies.push(body);
      area.appendChild(body);
    });
    const show = () => { bodies.forEach((b, i) => (b.style.display = i === active ? '' : 'none')); [...row.children].forEach((t, i) => t.classList.toggle('on', i === active)); };
    show();
  };

  build(el, rootName);
  // Size: explicit, root geometry, or the bounding box of the children.
  const root = form.controls.find((c) => c.name === rootName)!;
  let W = opts.width ?? (root.w && root.parent !== null ? root.w : 0), H = opts.height ?? (root.h && root.parent !== null ? root.h : 0);
  if (!W || !H) {
    for (const c of byParent.get(rootName) ?? []) {
      if (c.nonvisual || MENU.has(c.cls) || SKIP.has(c.cls) || c.visible === false) continue;
      W = Math.max(W, (c.l ?? 0) + (c.w ?? 0)); H = Math.max(H, (c.t ?? 0) + (c.h ?? 0));
    }
    if (root.w && root.h && root.parent === null && (root.cls.endsWith('Frame') || root.cls.endsWith('Panel'))) { W = root.w; H = root.h; }
  }
  el.style.width = `${W}px`; el.style.height = `${H}px`;
  let fitAt = 0;
  // Captions are re-fitted when their text changes (status labels), at most twice a second.
  const refresh = () => { for (const r of refreshers) r(); const now = performance.now(); if (now - fitAt > 500 && el.isConnected) { fitAt = now; fitLabels(el); } };
  refresh();
  const off = settings.on('', () => queueMicrotask(refresh));
  cleanups.push(off);
  return { el, refresh, controls, destroy: () => cleanups.forEach((f) => f()), width: W, height: H };
}

/** Default binding from the settings catalog's ui_controls when a control maps to exactly one simple setting. */
const AUTO = new Map<string, string>();
for (const d of SETTING_DEFS.values()) for (const u of d.ui) if (/^ui\.[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(u) && !AUTO.has(u)) AUTO.set(u, d.id);
function autoBinding(c: ControlDef): Binding | undefined {
  const id = AUTO.get(c.id);
  if (!id) return undefined;
  const d = SETTING_DEFS.get(id)!;
  if (['TsCheckBox', 'TsSlider'].includes(c.cls) && d.type === 'boolean') return { kind: 'bool', id };
  if (['TsSpinEdit', 'TsDecimalSpinEdit', 'TsTrackBar', 'TsTrackEdit'].includes(c.cls) && (d.type === 'integer' || d.type === 'number')) return { kind: 'num', id };
  if (c.cls === 'TsEdit' && d.type === 'string') return { kind: 'text', id };
  if (c.cls === 'TsColorSelect') return { kind: 'color', id };
  return undefined;
}

const hex = (rgb: number[]) => '#' + rgb.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function readBinding(b: Binding): unknown {
  switch (b.kind) {
    case 'bool': { const v = settings.bool(b.id); return b.invert ? !v : v; }
    case 'radio': return settings.get(b.id) === b.value;
    case 'num': return (settings.num(b.id) - (b.offset ?? 0)) * (b.scale ?? 1);
    case 'combo': { const v = settings.get(b.id); return b.values ? b.values.findIndex((x) => x === v) : Number(v); }
    case 'text': return settings.str(b.id);
    case 'color': return settings.arr<number>(b.id);
    case 'arrayItem': return settings.arr<string>(b.id)[b.index];
    case 'custom': return b.get();
    default: return undefined;
  }
}

function writeSetting(b: Binding, v: any) {
  switch (b.kind) {
    case 'bool': settings.set(b.id, b.invert ? !v : !!v); break;
    case 'radio': settings.set(b.id, b.value); break;
    case 'num': settings.set(b.id, v / (b.scale ?? 1) + (b.offset ?? 0)); break;
    case 'combo': settings.set(b.id, b.values ? b.values[v] : v); break;
    case 'text': settings.set(b.id, v); break;
    case 'color': {
      const def = SETTING_DEFS.get(b.id);
      settings.set(b.id, def?.type === 'rgba' ? [...(v as number[]).slice(0, 3), settings.arr<number>(b.id)[3] ?? 255] : v);
      break;
    }
    case 'arrayItem': { const a = [...settings.arr<string>(b.id)]; a[b.index] = v; settings.set(b.id, a); break; }
    case 'custom': b.set(v); break;
  }
}

/** Makes a clickable element reachable and operable from the keyboard (Tab, then Enter or Space). */
export function keyboardClick(el: HTMLElement, role = 'button') {
  el.tabIndex = 0;
  el.setAttribute('role', role);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); el.click(); } });
}

/** Range and increment of a spin control: binding overrides, then the design values, then the setting's range. */
export function spinRange(c: ControlDef, b: Binding | undefined): { min: number | null; max: number | null; step: number } {
  const def = b && 'id' in b ? SETTING_DEFS.get(b.id) : undefined;
  const scale = b?.kind === 'num' ? b.scale ?? 1 : 1, offset = b?.kind === 'num' ? b.offset ?? 0 : 0;
  const designRange = c.min !== undefined && c.max !== undefined && c.max > c.min;
  const fromDef = (v: number | null | undefined) => (v === null || v === undefined || Math.abs(v) >= 2 ** 31 - 1 ? null : (v - offset) * scale);
  const min = b?.kind === 'num' && b.min !== undefined ? b.min : designRange ? c.min! : fromDef(def?.min);
  const max = b?.kind === 'num' && b.max !== undefined ? b.max : c.max !== undefined && c.max > (c.min ?? -Infinity) ? c.max : fromDef(def?.max);
  let step = b?.kind === 'num' && b.step ? b.step : c.cls === 'TsDecimalSpinEdit' ? c.inc ?? 0.1 : c.inc ?? 1;
  // An integer setting shown unscaled moves by whole units (a fractional step would round back to the same value).
  if (def?.type === 'integer' && scale === 1) step = Math.max(1, Math.round(step));
  return { min, max, step };
}
export const clampSpin = (v: number, r: { min: number | null; max: number | null }) => Math.min(r.max ?? Infinity, Math.max(r.min ?? -Infinity, v));

function renderControl(c: ControlDef, b: Binding | undefined, refreshers: (() => void)[], edit: FormEdit): HTMLElement {
  const writeBinding = (b: Binding, v: any) => edit(() => writeSetting(b, v));
  const n = document.createElement('div');
  n.className = 'ctl';
  n.dataset.id = c.id;
  const ic = ICONS[c.id];
  if (ic) { n.dataset.icon = ic[0]; if (ic[1]) n.dataset.iconCol = '1'; }
  if (ICON_LABELS[c.id]) { n.setAttribute('aria-label', ICON_LABELS[c.id]); n.title = ICON_LABELS[c.id]; }
  if (/^More|^Warnings/.test(c.caption ?? '') && /Speed|Btn/.test(c.cls)) n.dataset.more = '1';
  const cap = caption(c);
  // A control bound to a setting that has no runtime effect in the browser is shown disabled with the reason.
  const ex = b && 'id' in b && typeof b.id === 'string' ? settingExclusion(b.id) : undefined;
  if (ex) b = { kind: 'na', reason: ex[1] };
  const na = !b || b.kind === 'na';
  if (b?.kind === 'na') { n.classList.add('na'); n.title = ex ? `No effect in the browser: ${b.reason}` : `Not implemented: ${b.reason}`; }
  const interactive = !['TsLabel', 'TsLabelFX', 'TsBevel', 'TsPanel', 'TsGroupBox', 'TsTabSheet', 'TsPageControl', 'TsToolBar', 'TsFrameBar', 'TsGauge', 'TsArcPreloader'].includes(c.cls);
  if (!b && interactive) { n.classList.add('na'); n.title = 'Not bound'; }
  const cls = c.cls === 'TsFrameBar' && b?.kind === 'list' ? 'TsListBox' : c.cls;
  switch (cls) {
    case 'TsLabel': case 'TsLabelFX': {
      n.classList.add(c.cls === 'TsLabelFX' ? 'labelfx' : 'label');
      n.textContent = cap;
      if (b?.kind === 'status') refreshers.push(() => { n.textContent = b.text(); });
      if (b?.kind === 'action') { n.style.cursor = 'pointer'; n.onclick = () => b.run(n); }
      break;
    }
    case 'TsBevel': n.classList.add('bevel'); break;
    case 'TsPanel': case 'TsTabSheet': case 'TsToolBar': case 'TsFrameBar': {
      n.classList.add('panel');
      if (c.cls === 'TsPanel' && cap.trim()) { const t = document.createElement('div'); t.className = 'labelfx'; t.textContent = cap.trim(); t.style.cssText = 'position:absolute;top:8px;width:100%;text-align:center'; n.appendChild(t); }
      if (b?.kind === 'custom' && b.disabled) refreshers.push(() => { n.style.display = b.disabled!() ? 'none' : ''; });
      break;
    }
    case 'TsGroupBox': case 'TsRadioGroup': {
      n.classList.add('group');
      const head = document.createElement('div'); head.className = 'cap';
      if (b && (b.kind === 'bool' || b.kind === 'custom' || b.kind === 'radio')) {
        const box = document.createElement('span'); box.className = 'ctl chk'; box.style.position = 'static';
        head.appendChild(box);
        head.style.cursor = 'pointer';
        head.onclick = () => writeBinding(b, !readBinding(b));
        keyboardClick(head, 'checkbox');
        refreshers.push(() => { const on = !!readBinding(b); box.classList.toggle('on', on); head.setAttribute('aria-checked', String(on)); });
      }
      const text = document.createElement('span'); text.textContent = cap;
      if (b?.kind === 'status') refreshers.push(() => { text.textContent = b.text(); });
      head.append(text);
      n.appendChild(head);
      if (c.cls === 'TsRadioGroup' && c.items && b) {
        c.items.forEach((it, i) => {
          const r = document.createElement('div'); r.className = 'ctl radio';
          r.style.cssText = `left:${10 + (i % 2) * 140}px;top:${18 + Math.floor(i / 2) * 21}px`;
          r.textContent = it;
          r.onclick = () => writeBinding(b, i);
          refreshers.push(() => r.classList.toggle('on', readBinding(b) === i));
          n.appendChild(r);
        });
      }
      break;
    }
    case 'TsCheckBox': case 'TsSlider': {
      n.classList.add('chk');
      // Two-line captions of tall check boxes keep their line break (design geometry: 30 px high, ~70 px wide).
      if (b?.kind === 'bool' && b.label) n.append(b.label);
      else if (cap.includes('\n') && (c.h ?? 0) >= 26) { const t = document.createElement('span'); t.className = 'lines'; t.textContent = cap; n.append(t); }
      else n.append(cap.replace(/\n/g, ' '));
      if (b && !na) {
        n.onclick = () => { if (b.kind === 'action') b.run(n); else writeBinding(b, !readBinding(b)); };
        refreshers.push(() => n.classList.toggle('on', b.kind === 'action' ? !!b.down?.() : !!readBinding(b)));
      } else if (c.checked) n.classList.add('on');
      break;
    }
    case 'TsRadioButton': {
      n.classList.add('radio');
      n.append(cap.replace(/\n/g, ' '));
      if (b && !na) {
        n.onclick = () => { if (b.kind === 'action') b.run(n); else if (b.kind === 'radio') writeBinding(b, true); else if (b.kind === 'custom') b.set(true); else writeBinding(b, true); };
        refreshers.push(() => n.classList.toggle('on', b.kind === 'action' ? !!b.down?.() : !!readBinding(b)));
      } else if (c.checked) n.classList.add('on');
      break;
    }
    case 'TsSpeedButton': case 'TsBitBtn': case 'TsButton': case 'TButton': case 'TToolButton': case 'TsBadgeBtn': {
      n.classList.add(c.cls === 'TsSpeedButton' || c.cls === 'TToolButton' ? 'speedbtn' : 'btn');
      if ((c.h ?? 0) >= 34) n.classList.add('big');
      if (c.cls === 'TToolButton') { n.style.width = '33px'; n.style.height = '33px'; }
      if (c.cls === 'TsBadgeBtn') { n.style.width = '18px'; n.style.height = '18px'; n.style.borderRadius = '50%'; }
      n.textContent = cap || (c.cls === 'TsBadgeBtn' ? 'i' : '');
      // Captionless buttons (the original drew skin glyphs) get an approved Tabler icon and an accessible name.
      if (!cap && b?.kind === 'action' && !b.caption && !n.dataset.icon) {
        n.dataset.icon = b.iconName ?? 'dots';
        n.classList.add('iconbtn');
        const name = b.label ?? 'Options';
        n.setAttribute('aria-label', name); n.setAttribute('role', 'button'); n.title = name;
      }
      if (b && !na) {
        if (b.kind === 'action') {
          n.onclick = () => b.run(n);
          refreshers.push(() => { if (b.down) n.classList.toggle('down', b.down()); if (b.disabled) n.classList.toggle('disabled', b.disabled()); if (b.caption) n.textContent = b.caption(); if (b.icon) n.dataset.icon = b.icon(); });
        } else if (b.kind === 'bool' || b.kind === 'radio' || b.kind === 'custom') {
          n.onclick = () => writeBinding(b, b.kind === 'radio' ? true : !readBinding(b));
          refreshers.push(() => n.classList.toggle('down', !!readBinding(b)));
        } else if (b.kind === 'status') refreshers.push(() => { n.textContent = b.text(); });
      } else if (c.down) n.classList.add('down');
      break;
    }
    case 'TsMemo': {
      n.classList.add('memo');
      const ta = document.createElement('textarea');
      ta.spellcheck = false;
      n.appendChild(ta);
      if (b && (b.kind === 'text' || b.kind === 'custom')) {
        ta.onchange = () => writeBinding(b, ta.value);
        refreshers.push(() => { if (document.activeElement !== ta) { const v = String(readBinding(b) ?? ''); if (ta.value !== v) ta.value = v; } });
      } else if (b?.kind === 'status') { ta.readOnly = true; refreshers.push(() => { const v = b.text(); if (ta.value !== v) ta.value = v; }); }
      else { ta.readOnly = true; ta.value = c.text ?? ''; }
      break;
    }
    case 'TsEdit': case 'TsFilenameEdit': {
      n.classList.add('edit');
      const inp = document.createElement('input');
      inp.value = c.text ?? '';
      n.appendChild(inp);
      if (c.cls === 'TsFilenameEdit' && b && (b.kind === 'text' || b.kind === 'custom')) {
        // Browse button: a local file becomes an object URL (the page cannot read file paths).
        const pick = document.createElement('span'); pick.className = 'browse'; pick.textContent = '…'; pick.title = 'Choose a local file';
        pick.onclick = () => { const f = document.createElement('input'); f.type = 'file'; f.onchange = () => { const file = f.files?.[0]; if (file) writeBinding(b, URL.createObjectURL(file)); }; f.click(); };
        n.appendChild(pick);
      }
      if (b && (b.kind === 'text' || b.kind === 'custom')) {
        inp.onchange = () => writeBinding(b, inp.value);
        refreshers.push(() => { if (document.activeElement !== inp) inp.value = String(readBinding(b) ?? ''); });
      } else inp.disabled = true;
      break;
    }
    case 'TsSpinEdit': case 'TsDecimalSpinEdit': case 'TsTrackEdit': case 'TsUpDown': {
      n.classList.add('spin');
      const inp = document.createElement('input');
      inp.type = 'number';
      const r = spinRange(c, b);
      // The original spin edits add the increment to the current value and clamp it to the range. A native number
      // input steps on a grid from its `min` attribute (35 + 5 became 36 with min 1), so the bounds are announced
      // with ARIA and enforced on commit, and the step base is the value shown (its value attribute).
      inp.step = String(r.step);
      if (r.min !== null) inp.setAttribute('aria-valuemin', String(r.min));
      if (r.max !== null) inp.setAttribute('aria-valuemax', String(r.max));
      const shown = (v: string) => { inp.value = v; inp.defaultValue = v; };
      shown(String(c.value ?? c.text ?? ''));
      n.appendChild(inp);
      if (b && !na && b.kind !== 'action') {
        const show = () => { const v = Number(readBinding(b)); shown(Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : ''); };
        // A typed value is the base for the next arrow step; it is committed (written) on change: spinner, arrow
        // key, Enter or leaving the field.
        inp.oninput = () => { if (Number.isFinite(inp.valueAsNumber)) inp.defaultValue = inp.value; };
        inp.onchange = () => { const v = Number(inp.value); if (inp.value !== '' && Number.isFinite(v)) writeBinding(b, clampSpin(v, r)); show(); };
        refreshers.push(() => { if (document.activeElement !== inp) show(); });
      } else inp.disabled = true;
      break;
    }
    case 'TsTrackBar': case 'TsScrollBar': {
      n.classList.add('track');
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = String(c.min ?? 0); inp.max = String(c.max ?? 100); inp.step = b?.kind === 'num' && b.step ? String(b.step) : '1';
      inp.value = String(c.position ?? 0);
      n.appendChild(inp);
      if (b && !na && b.kind !== 'action' && b.kind !== 'status') {
        inp.oninput = () => writeBinding(b, Number(inp.value));
        refreshers.push(() => { if (b.kind === 'custom' && b.max) inp.max = String(Math.max(0, b.max())); if (document.activeElement !== inp) inp.value = String(readBinding(b)); });
      } else inp.disabled = true;
      break;
    }
    case 'TsComboBox': case 'TsFontComboBox': {
      n.classList.add('combo');
      const sel = document.createElement('select');
      const items = b?.kind === 'custom' && b.items ? b.items() : c.items ?? (c.cls === 'TsFontComboBox' ? ['Segoe UI', 'Noto Sans', 'DejaVu Sans'] : []);
      const fill = (list: string[]) => { sel.innerHTML = ''; list.forEach((it, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = it; sel.appendChild(o); }); };
      fill(items);
      n.appendChild(sel);
      if (b && !na) {
        sel.onchange = () => writeBinding(b, Number(sel.value));
        refreshers.push(() => {
          if (b.kind === 'custom' && b.items) { const cur = b.items(); if (cur.length !== sel.options.length || cur.some((x, i) => sel.options[i].textContent !== x)) fill(cur); }
          sel.value = String(readBinding(b));
        });
      } else sel.disabled = true;
      break;
    }
    case 'TsColorSelect': {
      n.classList.add('color');
      n.textContent = cap.trim();
      const inp = document.createElement('input'); inp.type = 'color'; inp.style.cssText = 'position:absolute;opacity:0;inset:0;cursor:pointer';
      n.appendChild(inp);
      if (b && (b.kind === 'color' || b.kind === 'custom')) {
        inp.oninput = () => writeBinding(b, unhex(inp.value));
        refreshers.push(() => { const v = readBinding(b) as number[]; if (v) { n.style.background = hex(v); inp.value = hex(v); } });
      } else inp.disabled = true;
      break;
    }
    case 'TsListBox': case 'TsListView': case 'TsCheckListBox': {
      n.classList.add('list');
      if (b?.kind === 'list') {
        let last = '';
        refreshers.push(() => {
          const items = b.items(), sel = b.selected();
          const sig = JSON.stringify(items) + sel;
          if (sig === last) return;
          last = sig;
          n.innerHTML = '';
          items.forEach((it, i) => {
            const d = document.createElement('div');
            d.className = 'item' + (i === sel ? ' sel' : '') + (it.disabled ? ' disabled' : '');
            // Check boxes: check-list boxes, and list views whose binding reports a checked state (e.g. "Fixed").
            if (b.check && (c.cls === 'TsCheckListBox' || it.checked !== undefined)) {
              const box = document.createElement('input'); box.type = 'checkbox'; box.checked = !!it.checked;
              box.onclick = (e) => { e.stopPropagation(); b.check!(i, box.checked); };
              d.appendChild(box);
            }
            d.append(it.label);
            d.onclick = () => b.select(i, false);
            d.ondblclick = () => b.select(i, true);
            n.appendChild(d);
          });
        });
      } else for (const it of c.items ?? (c.collection as { caption?: string }[] | undefined)?.map((x) => x.caption ?? '') ?? []) { const d = document.createElement('div'); d.className = 'item'; d.textContent = it; n.appendChild(d); }
      break;
    }
    case 'TsGauge': case 'TsProgressBar': {
      n.classList.add('gauge');
      const bar = document.createElement('div'); n.appendChild(bar);
      if (b?.kind === 'gauge') refreshers.push(() => { bar.style.width = `${Math.max(0, Math.min(1, b.value() / b.max)) * 100}%`; });
      break;
    }
    case 'TsArcPreloader': {
      n.classList.add('spinner');
      if (b?.kind === 'busy') refreshers.push(() => n.classList.toggle('busy', b.on()));
      break;
    }
    case 'TsPageControl': break;
    default: n.textContent = cap;
  }
  if (b && 'disabled' in b && b.disabled && c.cls !== 'TsPanel') refreshers.push(() => n.classList.toggle('disabled', b.disabled!()));
  if (n.onclick && !n.classList.contains('na')) {
    const role = n.classList.contains('chk') ? 'checkbox' : n.classList.contains('radio') ? 'radio' : 'button';
    keyboardClick(n, role);
    if (role !== 'button') refreshers.push(() => n.setAttribute('aria-checked', String(n.classList.contains('on'))));
    else if (b?.kind === 'action' && b.down) refreshers.push(() => n.setAttribute('aria-pressed', String(n.classList.contains('down'))));
  }
  if (b?.kind === 'action' && b.title) refreshers.push(() => { const t = b.title!(); if (n.title !== t) { n.title = t; n.setAttribute('aria-label', t); } });
  if (b && 'hidden' in b && b.hidden) refreshers.push(() => { n.style.display = b.hidden!() ? 'none' : ''; });
  return n;
}

/** Collects TPopupMenu / TMenuItem trees of a form. */
export interface MenuNode { id: string; name: string; caption: string; checked?: boolean; shortcut?: number; children: MenuNode[] }
export function formMenus(formName: string): Map<string, MenuNode> {
  const form = formDef(formName);
  const nodes = new Map<string, MenuNode>();
  for (const c of form.controls) if (c.cls === 'TPopupMenu' || c.cls === 'TMenuItem') nodes.set(c.name, { id: c.id, name: c.name, caption: caption(c), checked: c.checked, shortcut: c.shortcut, children: [] });
  for (const c of form.controls) if (c.cls === 'TMenuItem' && c.parent && nodes.has(c.parent)) nodes.get(c.parent)!.children.push(nodes.get(c.name)!);
  return new Map([...nodes].filter(([k]) => form.controls.find((c) => c.name === k)!.cls === 'TPopupMenu'));
}
