// Native-looking floating dialogs and popup menus.
import { renderForm, formDef, type BindingMap, type FormEdit, type MenuNode, type RenderedForm } from './form';

const open = new Map<string, { el: HTMLElement; form: RenderedForm }>();
let z = 30;

export function openDialog(formName: string, bindings: BindingMap, opts: { title?: string; x?: number; y?: number; width?: number; height?: number; extra?: (body: HTMLElement) => void; edit?: FormEdit } = {}): HTMLElement {
  const existing = open.get(formName);
  if (existing) { existing.el.style.zIndex = String(++z); return existing.el; }
  const def = formDef(formName);
  const root = def.controls[0];
  const form = renderForm(formName, bindings, { width: opts.width, height: opts.height, edit: opts.edit });
  const dlg = document.createElement('div');
  dlg.className = 'dlg';
  dlg.style.zIndex = String(++z);
  const title = document.createElement('div');
  title.className = 'dlg-title';
  title.textContent = opts.title ?? root.caption ?? formName;
  const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.onclick = () => closeDialog(formName);
  title.appendChild(x);
  const body = document.createElement('div'); body.className = 'dlg-body';
  body.appendChild(form.el);
  opts.extra?.(body);
  dlg.append(title, body);
  document.getElementById('app')!.appendChild(dlg);
  // Placed by its rendered size (extra content included) so it opens inside the window; the body scrolls when taller.
  const w = dlg.offsetWidth || form.width + 14, h = dlg.offsetHeight || form.height + 36;
  dlg.style.left = `${opts.x ?? Math.max(4, Math.min((innerWidth - w) / 2, innerWidth - w - 4))}px`;
  dlg.style.top = `${opts.y ?? Math.max(4, Math.min(Math.max(30, (innerHeight - h) / 3), innerHeight - h - 4))}px`;
  dlg.onmousedown = () => (dlg.style.zIndex = String(++z));
  drag(dlg, title);
  open.set(formName, { el: dlg, form });
  return dlg;
}

export function closeDialog(formName: string) {
  const d = open.get(formName);
  if (!d) return;
  d.form.destroy();
  d.el.remove();
  open.delete(formName);
}
export const isOpen = (formName: string) => open.has(formName);
/** Re-reads dynamic (status/list) bindings of every open dialog. */
export function refreshDialogs() { for (const d of open.values()) d.form.refresh(); }

export function drag(el: HTMLElement, handle: HTMLElement, onEnd?: (x: number, y: number) => void) {
  handle.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).classList.contains('x')) return;
    e.preventDefault();
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    const move = (m: MouseEvent) => { el.style.left = `${m.clientX - sx}px`; el.style.top = `${m.clientY - sy}px`; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); onEnd?.(el.offsetLeft, el.offsetTop); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

export interface MenuAction { run?: () => void; checked?: () => boolean; disabled?: string | false; caption?: string }
let currentMenu: HTMLElement[] = [];
export function closeMenus() { for (const m of currentMenu) m.remove(); currentMenu = []; }
if (typeof window !== 'undefined') window.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement).closest('.menu')) closeMenus(); });

/** Shows a menu tree; `actions` keys are menu item names. Items without an action are shown disabled. */
export function showMenu(node: MenuNode, x: number, y: number, actions: Record<string, MenuAction>, level = 0) {
  if (level === 0) closeMenus();
  const m = document.createElement('div');
  m.className = 'menu';
  m.style.left = `${x}px`; m.style.top = `${y}px`;
  for (const c of node.children) {
    if (c.caption === '-') { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const a = actions[c.name];
    const it = document.createElement('div');
    it.className = 'mi';
    it.textContent = a?.caption ?? c.caption;
    if (c.children.length) {
      it.classList.add('sub');
      it.onmouseenter = () => { while (currentMenu.length > level + 1) currentMenu.pop()!.remove(); const r = it.getBoundingClientRect(); showMenu(c, r.right, r.top, actions, level + 1); };
    } else {
      it.onmouseenter = () => { while (currentMenu.length > level + 1) currentMenu.pop()!.remove(); };
      if (!a || a.disabled !== undefined && a.disabled !== false || !a.run) {
        it.classList.add('disabled');
        it.title = typeof a?.disabled === 'string' ? a.disabled : 'Not implemented in CWRV3';
      } else it.onclick = () => { closeMenus(); a.run!(); };
      if (a?.checked?.()) it.classList.add('checked');
    }
    m.appendChild(it);
  }
  document.getElementById('app')!.appendChild(m);
  currentMenu.push(m);
  const r = m.getBoundingClientRect();
  if (r.bottom > innerHeight) m.style.top = `${Math.max(0, innerHeight - r.height - 4)}px`;
  if (r.right > innerWidth) m.style.left = `${Math.max(0, innerWidth - r.width - 4)}px`;
}

export function toast(text: string, ms = 2500) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.getElementById('app')!.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** Small modal prompt (native look) returning the entered text. */
export function promptBox(title: string, label: string, value = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const d = document.createElement('div');
    d.className = 'dlg'; d.style.zIndex = String(++z); d.style.left = `${innerWidth / 2 - 150}px`; d.style.top = `${innerHeight / 3}px`;
    d.innerHTML = '<div class="dlg-title"></div><div class="dlg-body" style="width:300px"><div class="lab"></div><input style="width:100%;margin:6px 0;background:#0a1020;border:1px solid #34436a;padding:3px"><div style="display:flex;gap:6px;justify-content:flex-end"><button class="ok">OK</button><button class="cancel">Cancel</button></div></div>';
    (d.querySelector('.dlg-title') as HTMLElement).textContent = title;
    (d.querySelector('.lab') as HTMLElement).textContent = label;
    const inp = d.querySelector('input') as HTMLInputElement; inp.value = value;
    const done = (v: string | null) => { d.remove(); resolve(v); };
    (d.querySelector('.ok') as HTMLElement).onclick = () => done(inp.value);
    (d.querySelector('.cancel') as HTMLElement).onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
    document.getElementById('app')!.appendChild(d);
    inp.focus();
  });
}
