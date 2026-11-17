// Map tools dialogs: Text annotations (TFrmTextAnnotation), Sequencer (TFrmSequencer) and the city label database
// editor (TFrmLabelDBEdit). State lives in app/stores.ts (local persistence); labels and annotations redraw on change.
import type { App } from '../app/app';
import type { BindingMap, MenuNode } from './form';
import type { CityLayer } from '../layers/gis';
import { settings } from '../settings/store';
import { textAnnotations, sequence, labelDb, labelKey, type LabelDb, type LabelEdit } from '../app/stores';
import { GpsLink, type SerialOptions } from '../data/gps';
import { parseCustomSites, CUSTOM_RADAR_PALETTE_KEYS } from '../layers/custom-radar';
import { PRODUCTS } from '../generated/products-catalog';
import { closeDialog } from './dialogs';
import { pool } from '../workers/pool';
import { abortAll } from '../data/net';
import { loadPref, savePref, isRecord } from '../app/persist';

const act = (run: (el: HTMLElement) => void): BindingMap[string] => ({ kind: 'action', run });

export function toolFormBindings(app: App): Record<string, BindingMap> {
  const redrawNotes = () => { app.annotations.dirty = true; app.poke(); };
  let noteSel = -1;
  const annotations: BindingMap = {
    'TFrmTextAnnotation.sListBox1': { kind: 'list', items: () => textAnnotations.list.map((a) => ({ label: `${a.text}  (${a.lat.toFixed(2)}, ${a.lon.toFixed(2)})` })), selected: () => noteSel,
      select: (i, dbl) => { noteSel = i; const a = textAnnotations.list[i]; if (a && dbl) app.renderer.camera.flyTo({ lon: a.lon, lat: a.lat }, settings.num('config.generalCameraFlyDuration')); } },
    'TFrmTextAnnotation.sSpeedButton3': act(async () => {
      const text = await app.prompt('New annotation', 'Annotation text (then click the map to place it):');
      if (text) app.pickOnMap('annotate', 'Click the map to place the annotation', (ll) => { textAnnotations.add({ text, lon: ll[0], lat: ll[1] }); noteSel = textAnnotations.list.length - 1; redrawNotes(); });
    }),
    'TFrmTextAnnotation.sSpeedButton4': act(() => { if (noteSel >= 0) { textAnnotations.remove(noteSel); noteSel = -1; redrawNotes(); } else app.toast('Select an annotation first'); }),
    'TFrmTextAnnotation.sSpeedButton1': act(() => app.editText('Annotations', 'font')),
    'TFrmTextAnnotation.sSpeedButton2': act(() => app.editText('Annotations', 'appearance')),
  };

  // Sequencer: actions store a viewpoint and/or the layer state; playback flies and applies them in order.
  let seqSel = -1, next = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const capture = (cam: boolean, layers: boolean) => {
    const t = app.renderer.camera.target;
    sequence.add({ name: `${sequence.list.length + 1}. ${cam && layers ? 'Camera + layers' : cam ? 'Camera' : 'Layers'}`, view: cam ? { ...t } : undefined, layers: layers ? settings.layerState() : undefined });
  };
  const apply = (i: number) => {
    const a = sequence.list[i];
    if (!a) return;
    seqSel = i;
    if (a.layers) settings.applyLayerState(a.layers);
    if (a.view) app.renderer.camera.flyTo(a.view, settings.num('config.generalCameraFlyDuration'));
    app.poke();
  };
  const play = (i: number) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (i >= sequence.list.length) return;
    apply(i); next = i + 1;
    // Next action after the fly time plus the viewpoint play interval (frozen config.generalViewPlayInterval).
    timer = setTimeout(() => play(i + 1), settings.num('config.generalCameraFlyDuration') + settings.num('config.generalViewPlayInterval') * 1000);
  };
  const sequencer: BindingMap = {
    'TFrmSequencer.sListBox1': { kind: 'list', items: () => sequence.list.map((a) => ({ label: a.name })), selected: () => seqSel, select: (i, dbl) => { seqSel = i; if (dbl) apply(i); } },
    'TFrmSequencer.sSpeedButton1': act(() => capture(true, true)),
    'TFrmSequencer.sSpeedButton2': act(() => capture(true, false)),
    'TFrmSequencer.sSpeedButton3': act(() => capture(false, true)),
    'TFrmSequencer.sSpeedButton4': act(() => { if (seqSel >= 0) { sequence.remove(seqSel); seqSel = -1; } else app.toast('Select an action first'); }),
    'TFrmSequencer.sSpeedButton5': act(() => play(0)),
    'TFrmSequencer.sSpeedButton6': act(() => { if (timer) { clearTimeout(timer); timer = null; } if (next >= sequence.list.length) next = 0; apply(next); next++; }),
  };

  // City label database editor: a working copy of the edits, saved explicitly ("Save DB changes").
  const cities = () => app.layers.get('cities') as unknown as CityLayer;
  let work: LabelDb = structuredClone(labelDb.value);
  let results: { key: string; n: string; lon: number; lat: number; added: number }[] = [];
  let sel = -1, query = '';
  const effective = () => {
    const out: typeof results = [];
    for (const c of cities().builtIn()) { const k = labelKey(c), e = work.edits[k]; if (!e?.deleted) out.push({ key: k, n: e?.n ?? c.n, lon: c.lon, lat: c.lat, added: -1 }); }
    work.added.forEach((a, i) => out.push({ key: `added:${i}`, n: a.n, lon: a.lon, lat: a.lat, added: i }));
    return out;
  };
  const search = () => { const q = query.toLowerCase(); results = effective().filter((r) => r.n.toLowerCase().includes(q)).slice(0, 500); sel = results.length ? 0 : -1; };
  const flagsOf = (r: (typeof results)[number]): LabelEdit => (r.added >= 0 ? work.added[r.added] : work.edits[r.key] ?? {});
  const edit = (r: (typeof results)[number], patch: LabelEdit) => {
    if (r.added >= 0) Object.assign(work.added[r.added], patch);
    else work.edits[r.key] = { ...(work.edits[r.key] ?? {}), ...patch };
  };
  const current = () => results[sel] ?? null;
  const labelDbForm: BindingMap = {
    'TFrmLabelDBEdit.sSpeedButton1': act(() => { work = structuredClone(labelDb.value); query = ''; search(); app.toast(`${results.length} labels loaded for editing`); }),
    'TFrmLabelDBEdit.sSpeedButton3': act(async () => { const q = await app.prompt('Search', 'City name contains:', query); if (q !== null) { query = q; search(); } }),
    'TFrmLabelDBEdit.sSpeedButton5': act(() => { if (results.length) { sel = (sel + 1) % results.length; const r = current()!; app.renderer.camera.flyTo({ lon: r.lon, lat: r.lat }, settings.num('config.generalCameraFlyDuration')); } }),
    // Check box = "Fixed" (permanent label); double-click edits the text.
    'TFrmLabelDBEdit.sListView1': { kind: 'list', items: () => results.map((r) => { const f = flagsOf(r); return { label: `${r.n}${f.zoom ? `  [Zoom ${f.zoom}]` : ''}${r.added >= 0 ? '  [New]' : ''}`, checked: !!f.fixed }; }), selected: () => sel,
      select: async (i, dbl) => { sel = i; const r = current(); if (r && dbl) { const n = await app.prompt('Edit label', 'Label text:', r.n); if (n) { edit(r, { n }); r.n = n; } } },
      check: (i, on) => { const r = results[i]; if (r) edit(r, { fixed: on }); } },
    'TFrmLabelDBEdit.sSpeedButton4': act(async () => { const r = current(); if (!r) return app.toast('Select a label first'); const n = await app.prompt('Edit label', 'Label text:', r.n); if (n) { edit(r, { n }); r.n = n; } }),
    'TFrmLabelDBEdit.sSpeedButton2': act(() => {
      const r = current();
      if (!r) return app.toast('Select a label first');
      if (r.added >= 0) work.added.splice(r.added, 1); else edit(r, { deleted: true });
      search();
    }),
    'TFrmLabelDBEdit.sSpeedButton6': act(async () => {
      const n = await app.prompt('New label', 'Label text (then click the map to place it):');
      if (n) app.pickOnMap('labelPlace', 'Click the map to place the label', (ll) => { work.added.push({ n, lon: ll[0], lat: ll[1] }); query = n; search(); });
    }),
    'TFrmLabelDBEdit.sSpeedButton7': act(() => { const r = current(); if (r) edit(r, { zoom: flagsOf(r).zoom === 1 ? 0 : 1 }); }),
    'TFrmLabelDBEdit.sSpeedButton8': act(() => { const r = current(); if (r) edit(r, { zoom: flagsOf(r).zoom === 2 ? 0 : 2 }); }),
    'TFrmLabelDBEdit.sButton3': act(() => { const saved = labelDb.set(structuredClone(work)); cities().rebuild(); app.poke(); if (saved) app.toast('Label database saved'); }),
    'TFrmLabelDBEdit.sButton4': act(() => { work = { edits: {}, added: [] }; const saved = labelDb.set(structuredClone(work)); cities().rebuild(); search(); app.poke(); if (saved) app.toast('Default label database restored'); }),
    'TFrmLabelDBEdit.sButton1': act(() => app.showText('Zoom thresholds', 'Fixed labels are always shown (highest declutter priority).\nZoom 1 labels are admitted at every zoom level, like the largest cities.\nZoom 2 labels appear only when zoomed in closely (camera zoom below 1.5).\nOther labels follow the rank and population filters of Settings → City Labels.\nTick a label check box to make it Fixed; changes apply after "Save DB changes".')),
  };
  // GPS Connection: Connect opens the serial setup (Web Serial options); without Web Serial the browser location
  // is used instead. The fix is drawn on the map and can keep the map centred.
  const gps = app.gps;
  const BAUDS = [110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 56000, 57600, 115200, 128000, 256000];
  const serial: SerialOptions = { baudRate: 4800, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', ...loadPref<Partial<SerialOptions>>('serial', {}, isRecord) };
  const saveSerial = () => savePref('serial', serial, 'GPS serial options');
  const val = (v: number | null, f: (x: number) => string) => (v === null || !Number.isFinite(v) ? '—' : f(v));
  const fx = () => gps.fix;
  const st = (fn: () => string): BindingMap[string] => ({ kind: 'status', text: fn });
  const gpsForm: BindingMap = {
    'TFrmGPSConnection.Edit1': { kind: 'text', id: 'config.gpsCOMPort' },
    'TFrmGPSConnection.ComboBox1': { kind: 'custom', get: () => BAUDS.indexOf(serial.baudRate), set: (i: number) => { serial.baudRate = BAUDS[Number(i)] ?? 4800; saveSerial(); } },
    'TFrmGPSConnection.sSpeedButton1': { kind: 'action', run: () => {
      if (gps.connected) { void gps.disconnect(); return; }
      if (GpsLink.serialAvailable()) app.dialog('TComSetupFrm');
      else { try { gps.connectGeolocation(); } catch (e) { app.toast((e as Error).message); } }
    }, down: () => gps.connected, caption: () => (gps.connected ? 'Disconnect' : 'Connect') },
    'TFrmGPSConnection.Label3': st(() => `Position: ${fx().lat === null ? '—' : `${fx().lat!.toFixed(5)}, ${fx().lon!.toFixed(5)}`}`),
    'TFrmGPSConnection.Label4': st(() => `Altitude: ${val(fx().altM, (x) => `${x.toFixed(0)} m`)}`),
    'TFrmGPSConnection.Label5': st(() => `Satellites: ${val(fx().sats, String)}`),
    'TFrmGPSConnection.Label6': st(() => `Speed: ${val(fx().speedKt, (x) => `${(x * 1.15078).toFixed(1)} mph`)}`),
    'TFrmGPSConnection.Label7': st(() => `Heading: ${val(fx().headingDeg, (x) => `${x.toFixed(0)}°`)}`),
    'TFrmGPSConnection.Label8': st(() => `Magnetic Declination: ${val(fx().magVarDeg, (x) => `${Math.abs(x).toFixed(1)}° ${x < 0 ? 'W' : 'E'}`)}`),
    'TFrmGPSConnection.Label9': st(() => `Fix Taken at: ${fx().fixMs === null ? '—' : new Date(fx().fixMs!).toLocaleTimeString()}  (${gps.status})`),
    'TFrmGPSConnection.sMemo1': st(() => (gps.raw.length ? gps.raw.join('\n') : fx().source === 'geolocation' ? 'Browser location in use (no NMEA stream).' : '')),
    'TFrmGPSConnection.sCheckBox1': { kind: 'custom', get: () => app.gpsCenter, set: (v: boolean) => { app.gpsCenter = !!v; } },
  };
  // CPort serial setup, mapped to Web Serial open() options; the port itself is picked in the browser's chooser.
  const pick = <T,>(list: T[], get: () => T, set: (v: T) => void): BindingMap[string] => ({ kind: 'custom', get: () => list.indexOf(get()), set: (i: number) => { set(list[Number(i)]); saveSerial(); }, items: () => list.map(String) });
  const setup: BindingMap = {
    'TComSetupFrm.Combo1': { kind: 'custom', get: () => 0, set: () => {}, items: () => ['Browser port chooser (Web Serial)'] },
    'TComSetupFrm.Combo2': pick(BAUDS, () => serial.baudRate, (v) => (serial.baudRate = v)),
    'TComSetupFrm.Combo3': pick([7, 8] as const as unknown as number[], () => serial.dataBits, (v) => (serial.dataBits = v as 7 | 8)),
    'TComSetupFrm.Combo4': pick([1, 2] as unknown as number[], () => serial.stopBits, (v) => (serial.stopBits = v as 1 | 2)),
    'TComSetupFrm.Combo5': { kind: 'custom', get: () => ['none', 'even', 'odd'].indexOf(serial.parity), set: (i: number) => { serial.parity = (['none', 'even', 'odd'] as const)[Number(i)]; saveSerial(); }, items: () => ['None', 'Even', 'Odd'] },
    'TComSetupFrm.Combo6': { kind: 'custom', get: () => ['none', 'hardware'].indexOf(serial.flowControl), set: (i: number) => { serial.flowControl = (['none', 'hardware'] as const)[Number(i)]; saveSerial(); }, items: () => ['None', 'Hardware'] },
    'TComSetupFrm.Button1': { kind: 'action', run: () => { closeDialog('TComSetupFrm'); gps.connectSerial({ ...serial }).catch((e) => { gps.status = (e as Error).message; app.toast((e as Error).message); }); } },
    'TComSetupFrm.Button2': { kind: 'action', run: () => closeDialog('TComSetupFrm') },
  };
  // The CPort terminal-emulation dialog belongs to the serial library's terminal component, which the workstation does not use.
  const trm: BindingMap = Object.fromEntries(['CheckBox1', 'CheckBox2', 'CheckBox3', 'CheckBox4', 'CheckBox5', 'ComboBox1', 'ComboBox2', 'ComboBox3', 'Edit1', 'Edit2', 'Button1', 'Button2']
    .map((n) => [`TComTrmSetForm.${n}`, { kind: 'na', reason: 'Serial-library terminal settings; the app has no terminal window (GPS uses Web Serial directly).' } as BindingMap[string]]));
  // GOES-R Manual Loader.
  const gm = app.goesManual;
  let goesReport = '', palBand = 0;
  const goesLoader: BindingMap = {
    'TFrmGOESLoader.sButton1': act(async () => {
      const files = await app.pickFiles('.nc,.nc4,.h5');
      const out: string[] = [];
      for (const f of files) {
        try {
          const s = await pool.for('goesManual').run('goes.examine', { bytes: new Uint8Array(await f.arrayBuffer()) });
          const n = (v: number | null, d = 4) => (v === null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
          out.push(`${f.name}\n  Band ID: ${s.band ?? 'n/a'}   Variable: ${s.variable}   ${s.width}×${s.height}   ${s.platform} ${new Date(s.startMs).toISOString()}\n  Projection: ${s.projection}   Scale: ${s.scale}   Offset: ${s.offset}\n  Standard parallel: ${n(s.standardParallel)}   Central meridian: ${n(s.centralMeridian)}   Origin latitude: ${n(s.originLat)}   Perspective height: ${n(s.perspectiveHeight, 1)} m\n  Min ${n(s.min)}   Max ${n(s.max)}   Avg ${n(s.avg)}`);
        } catch (e) { out.push(`${f.name}: ${(e as Error).message}`); }
      }
      goesReport = out.join('\n\n');
    }),
    'TFrmGOESLoader.sMemo1': { kind: 'status', text: () => goesReport || (gm.frames.length ? gm.frames.map((f) => `${f.name}  ${new Date(f.t).toISOString()}`).join('\n') : '') },
    'TFrmGOESLoader.sButton2': act(async () => {
      const files = await app.pickFiles('.nc,.nc4,.h5');
      if (!files.length) return;
      try { await gm.load(files); goesReport = ''; app.toast(`${gm.frames.length} GOES-R frame(s) loaded (band ${gm.band()})`); } catch (e) { goesReport = (e as Error).message; app.toast((e as Error).message); }
      app.poke();
    }),
    'TFrmGOESLoader.sButton3': act(() => { gm.clear(); goesReport = ''; app.poke(); }),
    'TFrmGOESLoader.sComboBox1': { kind: 'custom', get: () => palBand, set: (i: number) => { palBand = Number(i); } },
    'TFrmGOESLoader.sSpeedButton4': act(() => app.arrayPaletteSelector('settings.goesBandPals', palBand, `Band ${palBand + 1} Color Palette`)),
    'TFrmGOESLoader.sSpeedButton3': act(() => app.alphaSelector('settings.goesManualAlpha', 255)),
    'TFrmGOESLoader.sTrackBar1': { kind: 'custom', get: () => gm.frame, set: (v: number) => { gm.frame = Math.max(0, Math.min(gm.frames.length - 1, Number(v))); app.poke(); }, max: () => Math.max(0, gm.frames.length - 1) } as BindingMap[string],
    'TFrmGOESLoader.sCheckBox1': { kind: 'custom', get: () => gm.loop, set: (v: boolean) => { gm.loop = !!v; } },
    'TFrmGOESLoader.sCheckBox2': { kind: 'custom', get: () => gm.embed, set: (v: boolean) => { const err = gm.setEmbed(!!v); if (err) app.toast(err); app.poke(); } },
    'TFrmGOESLoader.sCheckBox3': { kind: 'custom', get: () => gm.showTime, set: (v: boolean) => { gm.showTime = !!v; } },
  };
  // Custom Radar Integration.
  const cr = app.customRadar;
  const PRODS = CUSTOM_RADAR_PRODUCTS;
  let srvSel = -1;
  const b = (id: string): BindingMap[string] => ({ kind: 'bool', id });
  const n = (id: string, extra: Record<string, number> = {}): BindingMap[string] => ({ kind: 'num', id, ...extra });
  const moveSrv = (d: number) => { const l = [...cr.servers], j = srvSel + d; if (srvSel < 0 || j < 0 || j >= l.length) return; [l[srvSel], l[j]] = [l[j], l[srvSel]]; cr.setServers(l); srvSel = j; };
  const custom: BindingMap = {
    'TFrmCustomRadar.sSlider2': b('layerState.CustomRadarOn'),
    'TFrmCustomRadar.sComboBox2': { kind: 'custom', get: () => cr.sites.findIndex((x) => x.name === settings.str('layerState.CustomRadarSite')), set: (i: number) => settings.set('layerState.CustomRadarSite', cr.sites[Number(i)]?.name ?? ''), items: () => (cr.sites.length ? cr.sites.map((x) => `${x.name}  ${x.place}, ${x.state}`) : ['(no sites: load customradars.gis)']) },
    'TFrmCustomRadar.sSpeedButton5': { kind: 'action', run: (el) => app.popup('TFrmCustomRadar', 'CRProds', el, customRadarProductActions(), customRadarExtraProducts()), caption: () => PRODS[cr.product()] },
    // Colour palette of the current product; reflectivity with precipitation typing opens the p-type control instead.
    'TFrmCustomRadar.sSpeedButton2': act(() => (cr.product() === 0 && settings.bool('settings.nexradPrecipitationTyping') ? app.dialog('TFrmPrecipTypingControl') : app.paletteSelector(CUSTOM_RADAR_PALETTE_KEYS[cr.product()], PRODS[cr.product()]))),
    'TFrmCustomRadar.sSpeedButton1': act(() => app.alphaSelector('settings.customRadarDataAlpha', 255)),
    'TFrmCustomRadar.sCheckBox3': b('settings.customRadarSmoothing'),
    'TFrmCustomRadar.sCheckBox1': b('settings.customRadarSitesOn'),
    'TFrmCustomRadar.tiltSelect': { kind: 'custom', get: () => cr.tilt, set: (i: number) => { cr.tilt = Number(i); cr.reloadProducts(); }, items: () => cr.tilts.map((t) => `${t.toFixed(1)}°`) },
    'TFrmCustomRadar.sSpinEdit1': n('settings.customRadarPollingInterval', { min: 10, max: 600 }),
    'TFrmCustomRadar.sRadioButton1': { kind: 'radio', id: 'settings.customRadarUpdateEffect', value: 0 },
    'TFrmCustomRadar.sRadioButton2': { kind: 'radio', id: 'settings.customRadarUpdateEffect', value: 1 },
    'TFrmCustomRadar.sDecimalSpinEdit1': n('settings.customRadarSweepDuration', { min: 0.1, max: 600, step: 0.1 }),
    'TFrmCustomRadar.sSpinEdit2': n('settings.customRadarMaxDownloadVolumes', { min: 3, max: 50 }),
    'TFrmCustomRadar.sSpinEdit3': n('settings.customRadarMaxMemoryVolumes', { min: 10, max: 100 }),
    'TFrmCustomRadar.sListBox1': { kind: 'list', items: () => cr.servers.map((label) => ({ label })), selected: () => srvSel, select: (i) => { srvSel = i; } },
    'TFrmCustomRadar.sButton1': act(async () => {
      const u = await app.prompt('New data server', 'HTTPS base URL: site directories below it (https://example.org/radar), or a listing URL containing {SITE}:', 'https://');
      if (!u) return;
      try { const url = new URL(u); if (url.protocol !== 'https:') throw new Error('https only'); cr.setServers([...cr.servers, u.includes('{SITE}') ? u : url.href.replace(/\/+$/, '')]); } catch { app.toast('Enter a valid https:// URL'); }
    }),
    'TFrmCustomRadar.sButton2': act(() => { if (srvSel >= 0) { cr.setServers(cr.servers.filter((_, i) => i !== srvSel)); srvSel = -1; } }),
    'TFrmCustomRadar.sButton3': act(() => moveSrv(-1)),
    'TFrmCustomRadar.sButton4': act(() => moveSrv(1)),
    'TFrmCustomRadar.sLabel6': { kind: 'status', text: () => `Sites come from a "customradars.gis" text file, one site per line: name, state, place, longitude, latitude, elevation (ft). ${cr.sites.length} site(s) loaded.` },
    'TFrmCustomRadar.sButton5': act(async () => { const f = await app.pickFile('.gis,.txt,.csv'); if (!f) return; const list = parseCustomSites(await f.text()); cr.setSites(list); app.toast(`${list.length} custom radar site(s) loaded`); }),
    // There is no AppData folder in a browser: export the current site list instead, to edit and load back.
    'TFrmCustomRadar.sButton6': act(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([['# name,state,place,lon,lat,elev_ft', ...cr.sites.map((x) => [x.name, x.state, x.place, x.lon, x.lat, x.elev].join(','))].join('\n')], { type: 'text/plain' })); a.download = 'customradars.gis'; a.click(); }),
    'TFrmCustomRadar.sRadioButton3': { kind: 'radio', id: 'settings.customRadarStormMotionCustom', value: false },
    'TFrmCustomRadar.sRadioButton4': { kind: 'radio', id: 'settings.customRadarStormMotionCustom', value: true },
    'TFrmCustomRadar.sDecimalSpinEdit2': n('settings.customRadarStormMotionSpeed', { min: 0, max: 180, step: 0.1 }),
    'TFrmCustomRadar.sDecimalSpinEdit3': n('settings.customRadarStormMotionAzimuth', { min: 0, max: 360, step: 1 }),
    'TFrmCustomRadar.sLabelFX5': { kind: 'status', text: () => { const m = cr.motion(); return settings.bool('settings.customRadarStormMotionCustom') ? 'Status: manual vector in use' : app.nexrad.autoMotion ? `Status: ${m.speedKt.toFixed(0)} kt from ${m.fromDeg.toFixed(0)}° (${app.nexrad.autoMotion.site} Level 3)` : 'Status: no current Level 3 vector; using manual.'; } },
    'TFrmCustomRadar.sMemo1': { kind: 'status', text: () => cr.log.join('\n') },
    'TFrmCustomRadar.sSpeedButton3': act(() => { void navigator.clipboard?.writeText(cr.log.join('\n')).then(() => app.toast('Status log copied'), () => app.toast('Clipboard unavailable')); }),
    'TFrmCustomRadar.sListView1': { kind: 'list', items: () => [{ label: 'Downloaded (%)   Resource', disabled: true }, ...cr.volumes.map((v) => ({ label: `${String(v.pct).padStart(3)} %   ${v.name}${v.error ? `  (${v.error})` : ''}` }))], selected: () => -1, select: () => {} },
  };
  // Downloader: overall progress of the downloads in flight; Cancel aborts them in the page and every worker.
  const downloader: BindingMap = {
    'TFrmDownloader.sLabelFX1': { kind: 'status', text: () => (app.dl.active ? `Currently downloading... ${app.dl.active} request(s), ${(app.dl.received / 1e6).toFixed(1)} MB` : 'No downloads in progress') },
    'TFrmDownloader.dlBar': { kind: 'gauge', value: () => app.downloadFraction(), max: 1 },
    'TFrmDownloader.sButton1': act(async () => {
      const inWorkers = ((await pool?.broadcast('net.abort', {}).catch(() => [])) ?? []) as number[];
      const n = abortAll() + inWorkers.reduce((a, b) => a + (Number(b) || 0), 0);
      app.toast(`${n} download(s) cancelled`); closeDialog('TFrmDownloader');
    }),
  };
  // Zone alerts (TFrmAdvisories): active alerts for the NWS forecast zone at a clicked point; selecting a row shows the text.
  const advisories: BindingMap = {
    'TFrmAdvisories.LV': { kind: 'list', items: () => [{ label: 'Event | AWIPS Code | Effective | Area | Expires | Ends', disabled: true }, ...app.zoneAlerts.items.map((a) => ({ label: a.row }))], selected: () => app.zoneAlerts.sel + 1, select: (i) => { app.zoneAlerts.sel = i - 1; } },
    'TFrmAdvisories.M': { kind: 'status', text: () => app.zoneAlerts.items[app.zoneAlerts.sel]?.text ?? app.zoneAlerts.status },
  };
  return { TFrmDownloader: downloader, TFrmAdvisories: advisories, TFrmCustomRadar: custom, TFrmGOESLoader: goesLoader, TFrmTextAnnotation: annotations, TFrmSequencer: sequencer, TFrmLabelDBEdit: labelDbForm, TFrmGPSConnection: gpsForm, TComSetupFrm: setup, TComTrmSetForm: trm };
}

/** CRProds popup (custom radar product menu): item name → product index 0–7; the two headers are disabled. */
/** Custom radar products: the catalog popup's 8 base/dealiased entries plus the 9 derived Level 2 products. */
export const CUSTOM_RADAR_PRODUCTS = ['Reflectivity', 'Base Velocity', 'Spectrum Width', 'ZDR', 'PHI', 'CC', 'Base Velocity (Dealiased)', 'Storm-Relative Velocity (Dealiased)',
  ...PRODUCTS.level2.slice(8).map((p) => p.name)];
const CR_MENU_ITEMS = ['H1', 'miOpenDialog1', 'miSaveDialog1', 'miOpenPictureDialog1', 'miSavePictureDialog1', 'miFontDialog1', 'miAlphaColordialog1', 'miSelectSkindialog1'];

export function customRadarProductActions(): Record<string, { run?: () => void; checked?: () => boolean; disabled?: string }> {
  const out: Record<string, { run?: () => void; checked?: () => boolean; disabled?: string }> = { Standarddlgsamples1: { disabled: 'section header' }, Additional1: { disabled: 'section header' } };
  const item = (i: number) => ({ run: () => settings.set('layerState.CustomRadarProduct', i), checked: () => settings.num('layerState.CustomRadarProduct') === i });
  CR_MENU_ITEMS.forEach((n, i) => { out[n] = item(i); });
  for (let i = 8; i < CUSTOM_RADAR_PRODUCTS.length; i++) out[`crDerived${i}`] = item(i);
  return out;
}

/** Menu nodes appended to the catalog CRProds popup for the derived products (actions crDerived8…). */
export function customRadarExtraProducts(): MenuNode[] {
  const items = CUSTOM_RADAR_PRODUCTS.slice(8).map((caption, k) => ({ id: `ext.crDerived${k + 8}`, name: `crDerived${k + 8}`, caption, children: [] }));
  return [{ id: 'ext.crSep', name: 'crSep', caption: '-', children: [] }, ...items];
}
