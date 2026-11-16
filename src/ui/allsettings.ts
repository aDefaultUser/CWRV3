// "All settings" editor (CWRV3 addition): every catalog setting with its stable ID, type, default, range,
// persistence document and an editor, so settings without a native control remain editable and exportable.
import { settings, SETTING_DEFS, docOf } from '../settings/store';
import type { SettingDef } from '../settings/types';
import { drag } from './dialogs';

export function openAllSettings(noteOf: (id: string) => string) {
  const old = document.getElementById('allsettings');
  if (old) { old.remove(); return; }
  const d = document.createElement('div');
  d.id = 'allsettings'; d.className = 'dlg';
  d.style.cssText = 'left:60px;top:40px;width:min(1100px,92vw);height:min(760px,88vh);display:flex;flex-direction:column;z-index:40';
  const title = document.createElement('div'); title.className = 'dlg-title'; title.textContent = 'All settings (stable IDs)';
  const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.onclick = () => d.remove(); title.appendChild(x);
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:6px;padding:6px;align-items:center';
  const q = document.createElement('input'); q.placeholder = 'Filter by ID, section or key…'; q.style.cssText = 'flex:1;background:#0a1020;border:1px solid #34436a;padding:3px';
  const exp = document.createElement('button'); exp.textContent = 'Export…';
  exp.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(settings.exportDocument(), null, 1)], { type: 'application/json' })); a.download = 'cwrv3-settings.json'; a.click(); };
  const imp = document.createElement('button'); imp.textContent = 'Import…';
  imp.onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json'; i.onchange = async () => {
    const f = i.files?.[0]; if (!f) return;
    // A file that is not valid JSON or not a settings export is reported and changes nothing.
    try { const r = settings.importDocument(JSON.parse(await f.text())); alert(`Applied ${r.applied}; ignored ${r.ignored.length}${r.ignored.length ? `: ${r.ignored.slice(0, 20).join(', ')}` : ''}`); } catch (e) { alert(`Not imported: ${f.name}: ${(e as Error).message}`); }
    render();
  }; i.click(); };
  bar.append(q, exp, imp);
  const body = document.createElement('div'); body.className = 'dlg-body'; body.style.cssText = 'flex:1;overflow:auto;max-height:none';
  d.append(title, bar, body);
  document.getElementById('app')!.appendChild(d);
  drag(d, title);
  const render = () => {
    const f = q.value.toLowerCase();
    body.textContent = '';
    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;font-size:11px';
    const head = table.insertRow();
    for (const h of ['ID', 'Value', 'Default', 'Range', 'Doc', 'Note']) { const th = document.createElement('th'); th.textContent = h; th.style.cssText = 'text-align:left;position:sticky;top:0;background:#16213a;padding:3px'; head.appendChild(th); }
    for (const def of SETTING_DEFS.values()) {
      if (def.type === 'aggregate') continue;
      const hay = `${def.id} ${def.section}/${def.key} ${def.label} ${noteOf(def.id)}`.toLowerCase();
      if (f && !hay.includes(f)) continue;
      const tr = table.insertRow();
      tr.style.borderBottom = '1px solid #1c2640';
      const c0 = tr.insertCell(); c0.textContent = def.id; c0.title = `${def.label} (${def.section ?? ''}/${def.key ?? ''})`;
      tr.insertCell().appendChild(editor(def));
      tr.insertCell().textContent = JSON.stringify(def.default).slice(0, 60);
      tr.insertCell().textContent = def.enum ? `{${def.enum.join(', ')}}` : def.min !== null || def.max !== null ? `${def.min ?? '−∞'} .. ${def.max ?? '∞'}` : '';
      tr.insertCell().textContent = docOf(def) ?? 'derived';
      tr.insertCell().textContent = noteOf(def.id);
    }
    body.appendChild(table);
  };
  q.oninput = render;
  render();
}

function editor(def: SettingDef): HTMLElement {
  const v = settings.get(def.id);
  const style = 'background:#0a1020;border:1px solid #34436a;color:inherit;width:100%';
  if (def.postLoad === 'derivedSiteIdx') { const s = document.createElement('span'); s.textContent = String(v); return s; }
  if (def.type === 'boolean') { const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!v; i.onchange = () => settings.set(def.id, i.checked); return i; }
  if (def.type === 'integer' || def.type === 'number') {
    const i = document.createElement('input'); i.type = 'number'; i.value = String(v); i.style.cssText = style;
    if (def.min !== null) i.min = String(def.min); if (def.max !== null) i.max = String(def.max);
    i.step = def.type === 'integer' ? '1' : 'any';
    i.onchange = () => { i.value = String(settings.set(def.id, Number(i.value))); };
    return i;
  }
  if (def.type === 'color' || def.type === 'rgba') {
    const i = document.createElement('input'); i.type = 'color';
    const a = v as number[]; i.value = '#' + a.slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('');
    i.oninput = () => { const rgb = [1, 3, 5].map((k) => parseInt(i.value.slice(k, k + 2), 16)); settings.set(def.id, def.type === 'rgba' ? [...rgb, a[3]] : rgb); };
    return i;
  }
  const i = document.createElement('input'); i.style.cssText = style;
  i.value = typeof v === 'string' ? v : JSON.stringify(v);
  i.onchange = () => { let val: unknown = i.value; if (def.type !== 'string') { try { val = JSON.parse(i.value); } catch { return; } } settings.set(def.id, val); };
  return i;
}
