// Archive replay dialog (geometry in generated/ui-forms-archive.ts): bindings and the menu entry that opens it.
import type { App } from '../app/app';
import type { BindingMap, MenuNode } from './form';
import type { MenuAction } from './dialogs';
import { NOT_AVAILABLE, type MapLayer } from '../layers/base';
import { settings } from '../settings/store';
import { timeline } from '../app/timeline';
import { BUILTIN_PRESETS, archivePresets, parseUtc, utcDate, utcTime, archiveBadge, type ArchivePreset } from '../app/archive';

const F = 'TFrmArchive';

export function archiveBindings(app: App): Record<string, BindingMap> {
  // The edits start at the archive time (or now) and keep what the user types until Go.
  const start = timeline.archive ?? Date.now();
  const edit = { date: utcDate(start), time: utcTime(start), site: settings.str('settings.nexradSiteICAO') };
  let sel = -1;
  const presets = (): ArchivePreset[] => [...BUILTIN_PRESETS, ...archivePresets.list];
  const show = (t: number | null) => { if (t !== null) { edit.date = utcDate(t); edit.time = utcTime(t); } edit.site = settings.str('settings.nexradSiteICAO'); };
  // The edits follow the archive time and site when they change elsewhere (preset, menu, site selector).
  let shown = '';
  const sync = () => { const now = `${timeline.epoch}|${settings.str('settings.nexradSiteICAO')}`; if (now !== shown) { shown = now; show(timeline.archive); } };
  const field = (k: keyof typeof edit, upper = false): BindingMap[string] => ({ kind: 'custom', get: () => { sync(); return edit[k]; }, set: (v) => { edit[k] = upper ? String(v).toUpperCase() : String(v); } });
  /** Layer titles on lines of at most about 64 characters. */
  const lines = (names: string[]) => names.reduce<string[]>((out, n) => { const last = out[out.length - 1]; if (last !== undefined && last.length + n.length < 62) out[out.length - 1] = `${last}, ${n}`; else out.push(n); return out; }, []).join(',\n');
  const go = () => {
    const t = parseUtc(edit.date, edit.time);
    if (t === null) { app.toast('Enter the date as YYYY-MM-DD and the time as HH:MM (UTC)'); return; }
    app.setArchive(t, edit.site);
  };
  const act = (run: () => void, disabled?: () => boolean): BindingMap[string] => ({ kind: 'action', run, disabled });
  const layersBy = (pick: (l: MapLayer) => boolean) => [...app.layers.values()].filter((l): l is MapLayer => 'status' in l && l.enabled() && pick(l)).map((l) => l.title);
  return {
    [F]: {
      [`${F}.edDate`]: field('date'), [`${F}.edTime`]: field('time'), [`${F}.edSite`]: field('site', true),
      [`${F}.btnGo`]: act(go),
      [`${F}.btnBack`]: act(() => app.stepArchive(-1), () => timeline.mode === 'live'),
      [`${F}.btnFwd`]: act(() => app.stepArchive(1), () => timeline.mode === 'live'),
      [`${F}.btnLive`]: act(() => app.setArchive(null), () => timeline.mode === 'live'),
      [`${F}.mmStatus`]: { kind: 'status', text: () => {
        if (timeline.archive === null) return 'Live data. Enter a UTC date and time, or recall a preset, to replay that time.';
        const na = layersBy((l) => l.status.state === 'unavailable' && l.status.text.includes(NOT_AVAILABLE));
        return `${archiveBadge(timeline.archive)} · ${timeline.loopHours} h loop\n${na.length ? `Not available for this time:\n${lines(na)}` : 'Every enabled layer has data for this time.'}`;
      } },
      [`${F}.lbPresets`]: { kind: 'list', items: () => presets().map((p, i) => ({ label: `${i < BUILTIN_PRESETS.length ? '' : '★ '}${p.name} — ${utcDate(p.t)} ${utcTime(p.t)}Z ${p.site}` })), selected: () => sel,
        select: (i, dbl) => { sel = i; if (dbl) recall(); } },
      [`${F}.btnRecall`]: act(() => recall(), () => !presets()[sel]),
      [`${F}.btnSave`]: act(async () => {
        const t = timeline.archive ?? parseUtc(edit.date, edit.time);
        if (t === null) { app.toast('Enter a valid date and time first'); return; }
        const name = await app.prompt('Save archive preset', 'Name of the event:', `${utcDate(t)} ${settings.str('settings.nexradSiteICAO')}`);
        if (name?.trim()) archivePresets.add({ name: name.trim(), t, site: settings.str('settings.nexradSiteICAO'), view: { ...app.renderer.camera.target } });
      }),
      [`${F}.btnDelete`]: act(() => { archivePresets.remove(sel - BUILTIN_PRESETS.length); sel = -1; }, () => sel < BUILTIN_PRESETS.length || !presets()[sel]),
    },
  };
  function recall() {
    const p = presets()[sel];
    if (!p || !app.setArchive(p.t, p.site)) return;
    // A saved view wins; otherwise the map centres on the radar (the site may already be the selected one).
    const s = app.nexrad.siteInfo();
    if (p.view) app.renderer.camera.flyTo(p.view, settings.num('config.generalCameraFlyDuration'), app.flyOpts());
    else if (s) app.renderer.camera.flyTo({ lon: s.lon, lat: s.lat, z: 18 }, settings.num('config.generalCameraFlyDuration'), app.flyOpts());
  }
}

/** Main-menu entries appended after the catalog items. */
export function archiveMenu(): MenuNode[] {
  return [{ id: 'ext.arSep', name: 'arSep', caption: '-', children: [] }, { id: 'ext.arOpen', name: 'arOpen', caption: 'Archive replay…', children: [] },
    { id: 'ext.arLive', name: 'arLive', caption: 'Return to live data', children: [] }];
}
export function archiveMenuActions(app: App): Record<string, MenuAction> {
  return { arOpen: { run: () => app.dialog(F), checked: () => timeline.mode === 'archive' }, arLive: { run: () => app.setArchive(null), disabled: timeline.mode === 'live' ? 'Live data is shown' : false } };
}
