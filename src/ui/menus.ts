// Popup-menu actions keyed by the original menu item names (TFrmMap.MainMenu, CtrlRightClickMenu;
// TRadarUIFrame.L2Prods, tracksPopup, mlPopup). Items without an action are shown disabled with a reason.
import type { App } from '../app/app';
import type { MenuAction } from './dialogs';
import { settings } from '../settings/store';
import { markers } from '../app/stores';
import { openAllSettings } from './allsettings';
import { settingExclusion, SETTING_NOTES } from '../settings/exclusions';
import { USER_FILES_CACHE, DATA_CACHE } from '../app/persist';

export const HELP = `CWRV3 keyboard and mouse
Left drag: pan · Wheel: zoom · Ctrl+Left drag: tilt/swivel · Ctrl+Right drag: zoom box · Right drag: zoom
Ctrl+Right click: point forecast / markers · R: radar site labels · Alt+D: measure distance · Alt+L: road labels (stored)
Alt+F1–F12: scene presets · Ctrl+T: telestration · Space: clear telestration · Ctrl+F: fullscreen · Ctrl+Z: stored zoom
Map modes: Explore (no object interaction) · Interact (rollover, warnings, site labels) · Probe (values under the cursor)

About: CWRV3 — made by Cloud Nuke Software Collective.
Original idea made by Paul Marv Software.`;
export const L2_MENU_INDEX: Record<string, number> = { H1: 0, miOpenDialog1: 1, miSaveDialog1: 2, miOpenPictureDialog1: 3, miSavePictureDialog1: 4, miFontDialog1: 5, miAlphaColordialog1: 6, miSelectSkindialog1: 7, R1: 8, G1: 9, S1: 10, M1: 11, P1: 12, V1: 13, V2: 14, E2: 15, M2: 16 };
export const ML_MENU_ORDER = ['mlt6', 'mlt5', 'mlt4', 'mlt3', 'mlt2', 'mlt1'];

export function mainMenuActions(app: App): Record<string, MenuAction> {
    const vendor = 'Vendor licensing or account feature: not part of CWRV3';
    return {
      S: { run: () => app.dialog('TFrmSettings') }, F5: { run: () => app.fullscreen() }, C3: { run: () => app.clearAllLayers() },
      C7: { run: () => app.dialog('TFrmCustomRadar') }, M4: { run: () => app.dialog('TFrmMapPresets') }, L1: { run: () => app.dialog('TFrmLayerPresets') },
      S3: { run: () => app.dialog('TFrmSequencer') }, S4: { run: () => app.dialog('TFrmSpatialTools') },
      I1: { run: () => app.dialog('TFrmShapefiles') }, M3: { run: () => app.dialog('TFrmRoadsControl') }, S5: { run: () => app.dialog('TFrmShapefileExtract') }, T3: { run: () => app.dialog('TFrmTerrain') },
      G3: { run: () => app.dialog('TFrmSettings') }, M2: { run: () => app.dialog('TFrmMapModes') }, R3: { disabled: 'Excluded: performance option of the original (bakes vector GIS into the tile cache; optional for the web). Vector GIS is drawn directly on the GPU.' }, ConnectNMEAserialGPSreceiver1: { run: () => app.dialog('TFrmGPSConnection') },
      D4: { run: () => { app.toast(`Settings: localStorage cwrv3.setting/<id> (one record per setting) and other cwrv3.* preferences; user files: Cache Storage "${USER_FILES_CACHE}"; data cache: "${DATA_CACHE}".${settings.saveError ? ` Last save failed: ${settings.saveError}.` : ''}`); openAllSettings((id) => (settingExclusion(id) ? `No effect in the browser: ${settingExclusion(id)![1]}` : SETTING_NOTES[id] ?? '')); }, caption: 'Settings storage / all settings…' },
      D5: { run: () => app.showText('Diagnostic log', app.diagnostics()) }, M6: { run: () => app.dialog('TFrmGOESLoader') }, R6: { run: () => app.reloadModelConfigs(), caption: 'Reload model configuration (and import *.config files)…' },
      V2: { run: () => app.showText('Model configuration parsing errors', app.modelErrors()) },
      G5: { run: () => app.toast('Not needed: CWRV3 derives model grid geolocation from each GRIB2 grid definition.') },
      F2: { run: () => app.setOutputSize() }, R2: { run: () => app.loadPaletteFiles(), caption: 'Load color palette files…' }, T1: { disabled: 'DEGRIB helper is not used (GRIB2 is decoded in workers)' },
      F3: { run: () => settings.set('config.generalShowPerfMetrics', !settings.bool('config.generalShowPerfMetrics')), checked: () => settings.bool('config.generalShowPerfMetrics') },
      PerfPanel: { run: () => app.perf.toggle(), checked: () => app.perf.visible },
      R5: { run: () => { app.renderer.buildPipelines(); for (const l of app.layers.values()) (l as { invalidate?: () => void }).invalidate?.(); app.toast('Shaders recompiled'); } },
      G1: { run: () => settings.set('settings.generalShowExceptions', !settings.bool('settings.generalShowExceptions')), checked: () => settings.bool('settings.generalShowExceptions') },
      R1: { run: () => location.reload(), caption: 'Reset imagery tiles (reload)' },
      A7: { disabled: vendor }, D3: { disabled: vendor }, RefreshActivationStatus1: { disabled: vendor }, C1: { disabled: vendor }, P2: { disabled: vendor },
      A6: { disabled: vendor }, D2: { disabled: vendor }, R4: { disabled: vendor }, CheckCurrentStatus1: { disabled: vendor }, P1: { disabled: vendor },
      S1: { run: () => app.toggleTelestration(), checked: () => app.tool === 'telestrate' }, C5: { run: () => app.clearTelestration() }, S2: { run: () => app.dialog('TFrmSettings') },
      T4: { run: () => app.dialog('TFrmTextAnnotation') }, F1: { run: () => app.dialog('TFrmPlacefiles') }, V40NWSAlayernonoperational1: { run: () => app.dialog('TFrmNWSA'), caption: 'NWS all-advisories layer…' },
      Deactivatelicense1: { disabled: vendor }, L2: { disabled: vendor }, O1: { run: () => app.showText('CWRV3 help', HELP) },
      A1: { run: () => app.showText('About CWRV3', `CWRV3 — local WebGPU weather workstation using public NOAA/NWS data.\nmade by Cloud Nuke Software Collective · Original idea made by Paul Marv Software\nGPU: ${app.renderer.gpu.info.vendor} ${app.renderer.gpu.info.architecture} ${app.renderer.gpu.info.description}`) },
      A2: { disabled: 'Close the browser tab to exit' },
    };
}

export function tracksMenuActions(): Record<string, MenuAction> {
    const b = (id: string): MenuAction => ({ run: () => settings.set(id, !settings.bool(id)), checked: () => settings.bool(id) });
    const alpha = (id: string): MenuAction => ({ run: () => (globalThis as unknown as { cwrv3app: App }).cwrv3app.alphaSelector(id) });
    return {
      C1: b('settings.nexradTracksInterpolate'), S5: b('settings.nexradTracksShowIntervalLines'), S6: b('settings.nexradTracksShowTimePoints'), S7: b('settings.nexradTracksTimePoints3D'),
      F1: b('settings.nexradTracksFillOnly'), F2: b('settings.nexradTracksFillFlash'), C2: b('settings.nexradTracksColorByReflectivityPalette'), S2: b('settings.nexradTracksShowCellPts'),
      S3: b('settings.nexradTracksShowCellPtsTrackingMode'), C4: b('settings.nexradTracksCellPtColorByReflectivityPalette'),
      C5: alpha('settings.nexradTracksFillAlpha'), C6: alpha('settings.nexradTracksFillAlphaOuter'), D1: alpha('settings.nexradTracksFillFlashAlpha'),
      S4: b('settings.nexradTrackingModeRolloverETAOnly'), S8: b('settings.nexradTracksShowImpactedCities'), P2: b('settings.nexradTracksPulsateMESO'),
    };
}

export function l2ProductActions(app: App): Record<string, MenuAction> {
  const a: Record<string, MenuAction> = {};
  for (const [k, v] of Object.entries(L2_MENU_INDEX)) a[k] = { run: () => { app.nexrad.liveComposite = false; settings.set('layerState.NEXRADLevel2Product', v); settings.set('layerState.NEXRADOn', true); app.renderTilts(); }, checked: () => settings.num('layerState.NEXRADLevel2Product') === v };
  a.Standarddlgsamples1 = { disabled: 'heading' }; a.Additional1 = { disabled: 'heading' };
  return a;
}

export function mlMenuActions(app: App): Record<string, MenuAction> {
  const a: Record<string, MenuAction> = {};
  ML_MENU_ORDER.forEach((k, i) => (a[k] = { run: () => { settings.set('layerState.NEXRADMeltingLayerElevation', i); settings.set('layerState.NEXRADMeltingLayerOn', true); app.refreshLayer('nexrad'); }, checked: () => settings.num('layerState.NEXRADMeltingLayerElevation') === i }));
  return a;
}

export function ctrlRightActions(app: App, ll: [number, number] | null): Record<string, MenuAction> {
    return {
      W2: { run: () => { if (ll) window.open(`https://forecast.weather.gov/MapClick.php?textField1=${ll[1].toFixed(4)}&textField2=${ll[0].toFixed(4)}`, '_blank', 'noopener'); }, disabled: ll ? false : 'Click on the map' },
      A3: { run: async () => { if (!ll) return; const label = await app.prompt('Add marker', 'Marker label:'); if (label !== null) markers.add({ lon: ll[0], lat: ll[1], label }); } },
      C6: { run: () => markers.clear() },
    };
}
