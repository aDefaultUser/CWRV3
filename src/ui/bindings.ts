// Control bindings for every in-scope form: control ID (without the "ui." prefix) → setting, action or an explicit
// not-implemented reason. Controls absent here fall back to the catalog's single-setting ui_controls binding
// (src/ui/form.ts autoBinding).
import { formDef, type Binding, type BindingMap } from './form';
import { settings } from '../settings/store';
import { settingExclusion } from '../settings/exclusions';
import type { App } from '../app/app';
import type { Timeline } from '../app/timeline';
import { L3 } from '../radar/sources';
import { PRODUCTS } from '../generated/products-catalog';
import { RADAR_SITES } from '../generated/radar-sites';
import { viewpoints, layerPresets, scenePresets, sceneMask, setSceneMask, mapStyles, layerOrder } from '../app/stores';
import { paletteNames } from '../palettes/library';
import { SAT_NAMES } from '../layers/sat-bands';
import { GOES_L2, type GoesL2Layer } from '../layers/goes-l2';
import { decode as decodeUser, writeShapefileZip } from '../layers/usershapes';
import { rgbRecipes } from '../app/stores';
import { parseRecipeText } from '../render/recipes';
import { warningCustomStyles, saveWarningCustomStyles, setObjectStyle, textStyle, setTextStyle } from '../app/styles';
import { ROAD_STYLES } from '../layers/gis';

const bool = (id: string, invert = false): Binding => ({ kind: 'bool', id, invert });
const radio = (id: string, value: unknown): Binding => ({ kind: 'radio', id, value });
const num = (id: string, scale = 1, extra: Partial<Extract<Binding, { kind: 'num' }>> = {}): Binding => ({ kind: 'num', id, scale, ...extra });
const combo = (id: string, values?: unknown[]): Binding => ({ kind: 'combo', id, values });
const text = (id: string): Binding => ({ kind: 'text', id });
const color = (id: string): Binding => ({ kind: 'color', id });
const act = (run: (el: HTMLElement) => void, down?: () => boolean, caption?: () => string): Extract<Binding, { kind: 'action' }> => ({ kind: 'action', run, down, caption });
const custom = (get: () => unknown, set: (v: any) => void, items?: () => string[], disabled?: () => boolean): Binding => ({ kind: 'custom', get, set, items, disabled });
const status = (fn: () => string): Binding => ({ kind: 'status', text: fn });
const na = (reason: string): Binding => ({ kind: 'na', reason });
const pointItem = (id: string, i: number): Binding => custom(() => settings.arr<number>(id)[i], (v) => { const p = [...settings.arr<number>(id)]; p[i] = Number(v); settings.set(id, p); });
const OWNER_NAMES: Record<Timeline['controller'], string> = { general: 'General timeline', 'nexrad-l2': 'NEXRAD Level 2 loop', 'nexrad-l3': 'NEXRAD Level 3 loop', mrms: 'MRMS loop', model: 'Model timeline' };
/** Owner, frame count and frame time of the playing loop; names a loop-time override when it changes the time. */
export function timingText(tl: Timeline): string {
  const f = tl.frameTiming(), ms = (v: number) => `${Math.round(v)} ms`;
  const over = f.override ? ` (set ${ms(f.requested)}; ${f.override === 'min' ? 'minimum' : 'maximum'} loop time override)` : '';
  return `${OWNER_NAMES[tl.controller]}: ${tl.frames.length} frames, ${ms(f.applied)}/frame${over}, end delay ${ms(tl.endDelayMs())}`;
}
const VENDOR = na('Vendor service, subscription or activation flow: not part of CWRV3');

const WARN_CODES = ['TOR', 'SVR', 'SQW', 'SMW', 'FFW', 'SWS', 'EWW'];
const warnSel = { type: 0, custom: -1 };

/** Placefile manager. */
function placefiles(app: App): BindingMap {
  const pl = () => app.placefiles;
  const sel = () => pl()?.entries[pl()!.selected];
  let path = '';
  return {
    'TFrmPlacefiles.plPath': custom(() => path, (v: string) => { path = String(v); }),
    'TFrmPlacefiles.sLabelFX1': act(async () => { const u = await app.prompt('Add new Placefile', 'Placefile URL (GRLevelX format) or use the … button to pick a local file:', path); if (u) pl()?.add(u.trim()); }),
    'TFrmPlacefiles.sBitBtn1': act(() => { if (path.trim()) pl()?.add(path.trim(), path.startsWith('blob:') ? 'local placefile' : path.trim()); else app.toast('Enter a placefile URL or choose a local file'); }),
    'TFrmPlacefiles.sListBox1': { kind: 'list', items: () => (pl()?.entries ?? []).map((e) => ({ label: `${e.hidden ? '(hidden) ' : ''}${e.name}${e.error ? ' — error' : ''}` })), selected: () => pl()?.selected ?? -1, select: (i) => { if (pl()) pl()!.selected = i; } },
    'TFrmPlacefiles.sLabelFX3': status(() => { const e = sel(); return e?.at ? new Date(e.at).toLocaleString() : '-'; }),
    'TFrmPlacefiles.sButton1': act(() => { const p = pl(); if (p && p.selected >= 0) p.remove(p.selected); }),
    'TFrmPlacefiles.sButton2': act(() => { const e = sel(); if (e) pl()!.load(e); }),
    'TFrmPlacefiles.sButton3': { kind: 'action', run: () => { const p = pl(); if (p && p.selected >= 0) p.toggleHidden(p.selected); }, caption: () => (sel()?.hidden ? 'Show' : 'Hide') },
    'TFrmPlacefiles.sButton4': act(() => { const e = sel(); app.textViewer(`Parser errors — ${e?.name ?? ''}`, e ? [e.error, ...(e.pf?.errors ?? [])].filter(Boolean).join('\n') || 'No parser errors.' : 'Select a placefile.'); }),
    'TFrmPlacefiles.sCheckBox1': custom(() => pl()?.ignoreThresholds ?? false, (v) => { if (pl()) pl()!.ignoreThresholds = !!v; }),
    'TFrmPlacefiles.sCheckBox2': custom(() => app.placefileOnTop, (v) => { app.placefileOnTop = !!v; document.querySelectorAll('.dlg').forEach((d) => { if ((d.querySelector('.dlg-title')?.textContent ?? '').startsWith('Placefile Manager')) (d as HTMLElement).style.zIndex = v ? '900' : ''; }); }),
  };
}

export function buildBindings(app: App): Record<string, BindingMap> {
  const nx = () => app.nexrad;
  const l3Index = () => settings.num('layerState.NEXRADLevel3Product');
  const l3Cat = () => L3[l3Index()]?.category ?? 'Reflectivity';
  const l3InCat = () => L3.filter((p) => p.category === l3Cat());
  const nrRadio = (idx: number): Binding => custom(() => settings.bool('layerState.NationalRadarOn') && settings.num('layerState.NationalRadarIdx') === idx, () => { settings.set('layerState.NationalRadarIdx', idx); settings.set('layerState.NationalRadarOn', true); });
  const satRadio = (idx: number): Binding => custom(() => settings.bool('layerState.SatelliteOn') && settings.num('layerState.SatelliteProductIndex') === idx, () => { settings.set('layerState.SatelliteProductIndex', idx); settings.set('layerState.SatelliteOn', true); });
  const pal = (id: string, label: string) => act(() => app.paletteSelector(id, label));
  const alpha = (id: string, max = 255) => act(() => app.alphaSelector(id, max));

  const basic: BindingMap = {
    'TBasicLayersFrame.sRadioButton2': nrRadio(0),
    'TBasicLayersFrame.sRadioButton3': nrRadio(1),
    'TBasicLayersFrame.sRadioButton4': nrRadio(2),
    'TBasicLayersFrame.sRadioButton1': custom(() => !settings.bool('layerState.NationalRadarOn'), () => settings.set('layerState.NationalRadarOn', false)),
    'TBasicLayersFrame.mapMode0': bool('layerState.NationalRadarPrecipTyped'),
    'TBasicLayersFrame.sSpeedButton4': act((el) => app.popPanel('nrExtraPanel', el)),
    'TBasicLayersFrame.sRadioButton10': satRadio(0), 'TBasicLayersFrame.sRadioButton13': satRadio(1), 'TBasicLayersFrame.sRadioButton8': satRadio(2),
    'TBasicLayersFrame.sRadioButton7': satRadio(3), 'TBasicLayersFrame.sRadioButton6': satRadio(4), 'TBasicLayersFrame.sRadioButton9': satRadio(5),
    'TBasicLayersFrame.sRadioButton12': satRadio(6), 'TBasicLayersFrame.sRadioButton11': satRadio(7),
    'TBasicLayersFrame.sRadioButton5': custom(() => !settings.bool('layerState.SatelliteOn'), () => settings.set('layerState.SatelliteOn', false)),
    'TBasicLayersFrame.sSpeedButton10': act(() => { settings.set('layerState.SatelliteProductIndex', 6); settings.set('layerState.SatelliteOn', true); }, () => settings.bool('layerState.SatelliteOn') && settings.num('layerState.SatelliteProductIndex') === 6, () => 'RGB'),
    'TBasicLayersFrame.sSpeedButton11': act(() => { settings.set('layerState.SatelliteProductIndex', 7); settings.set('layerState.SatelliteOn', true); }, () => settings.bool('layerState.SatelliteOn') && settings.num('layerState.SatelliteProductIndex') === 7, () => 'Sandwich'),
    'TBasicLayersFrame.sSpeedButton5': act((el) => app.popPanel('goesExtraPanel', el)),
    'TBasicLayersFrame.sSpeedButton9': act(() => app.dialog('TFrmGOESExtended'), () => settings.bool('layerState.ExtendedSatelliteOn')),
    'TBasicLayersFrame.sSpeedButton2': bool('layerState.LightningOn'),
    'TBasicLayersFrame.sSpeedButton8': act(() => app.dialog('TFrmGLMControl')),
    'TBasicLayersFrame.sSpeedButton6': act(() => app.dialog('TFrmWarningControl')),
    'TBasicLayersFrame.sSpeedButton1': act((el) => app.popPanel('severeExtraPanel', el)),
    'TBasicLayersFrame.sSpeedButton3': act((el) => app.popPanel('saExtraPanel', el)),
    'TBasicLayersFrame.sComboBox1': combo('layerState.saFillIdx'),
    'TBasicLayersFrame.sArcPreloader1': { kind: 'busy', on: () => app.layerBusy('satellite') },
    'TBasicLayersFrame.sArcPreloader2': { kind: 'busy', on: () => app.layerBusy('nationalRadar') },
    'TBasicLayersFrame.sArcPreloader3': { kind: 'busy', on: () => app.layerBusy('surface') },
  };

  const radarFrame: BindingMap = {
    'TRadarUIFrame.sRadioButton3': custom(() => settings.bool('layerState.NEXRADOn') && settings.bool('layerState.NEXRADLevel2'), () => { settings.set('layerState.NEXRADLevel2', true); settings.set('layerState.NEXRADOn', true); }),
    'TRadarUIFrame.sRadioButton2': custom(() => settings.bool('layerState.NEXRADOn') && !settings.bool('layerState.NEXRADLevel2'), () => { settings.set('layerState.NEXRADLevel2', false); settings.set('layerState.NEXRADOn', true); }),
    'TRadarUIFrame.sRadioButton1': custom(() => !settings.bool('layerState.NEXRADOn'), () => settings.set('layerState.NEXRADOn', false)),
    'TRadarUIFrame.rSiteHeader': status(() => { const s = nx().siteInfo(); return s ? `${s.id} ${s.type}` : settings.str('settings.nexradSiteICAO'); }),
    'TRadarUIFrame.rSiteCaption': status(() => { const s = nx().siteInfo(); return s ? `${titleCase(s.name)}, ${s.st} / Elev ${Math.round(s.elevFt)}'` : 'Unknown site'; }),
    'TRadarUIFrame.sBadgeBtn1': act(() => { const s = nx().siteInfo(); app.toast(s ? `${s.id} ${s.type} ${s.lat.toFixed(3)}, ${s.lon.toFixed(3)} (site table index ${RADAR_SITES.indexOf(s)}; derived nexradSiteIdx ${settings.num('settings.nexradSiteIdx')})` : 'Unknown site'); }),
    'TRadarUIFrame.sSpeedButton5': act((el) => app.l2ProductMenu(el), undefined, () => (settings.bool('layerState.NEXRADLevel2') ? (nx().liveComposite ? 'Live Composite' : PRODUCTS.level2[settings.num('layerState.NEXRADLevel2Product')].name) : L3[l3Index()].name)),
    'TRadarUIFrame.L3ProductSelector': custom(() => 0, () => {}, undefined, () => settings.bool('layerState.NEXRADLevel2')),
    'TRadarUIFrame.L3CategorySelector': custom(() => PRODUCTS.level3Categories.indexOf(l3Cat()), (i: number) => {
      const p = L3.find((x) => x.category === PRODUCTS.level3Categories[i] && !x.disabled);
      if (p) settings.set('layerState.NEXRADLevel3Product', p.index);
    }, () => [...PRODUCTS.level3Categories]),
    'TRadarUIFrame.L3ProductList': { kind: 'list', items: () => l3InCat().map((p) => ({ label: p.name, disabled: p.disabled })), selected: () => l3InCat().findIndex((p) => p.index === l3Index()), select: (i) => { const p = l3InCat()[i]; if (p && !p.disabled) settings.set('layerState.NEXRADLevel3Product', p.index); } },
    'TRadarUIFrame.tiltSelect': custom(() => 0, () => {}, undefined, () => !settings.bool('layerState.NEXRADLevel2')),
    'TRadarUIFrame.liveCompositeIndicator': custom(() => 0, () => {}, undefined, () => !nx().liveComposite),
    'TRadarUIFrame.sBitBtn3': { ...act(() => app.setLiveComposite(false)), label: 'Leave the low-level composite', iconName: 'x' },
    'TRadarUIFrame.sSpeedButton2': act(() => app.dialog('TFrmRadarControl')),
    'TRadarUIFrame.sSpeedButton1': act(() => app.dialog('TFrmRadarSiteLabels'), () => settings.bool('settings.nexradSitesOn')),
    'TRadarUIFrame.sSpeedButton3': act((el) => app.tracksMenu(el), () => settings.bool('layerState.NEXRADStormTracksOn')),
    'TRadarUIFrame.sSpeedButton4': act((el) => app.mlMenu(el), () => settings.bool('layerState.NEXRADMeltingLayerOn')),
    'TRadarUIFrame.mapMode0': act(() => app.setLiveScan(!nx().liveScan), () => nx().liveScan, () => (nx().liveScan ? 'Live Sweep\nActive' : 'Activate\nLive Sweep')),
    'TRadarUIFrame.sCheckBox4': bool('settings.nexradLiveBeam'),
    'TRadarUIFrame.sLabelFX10': status(() => nx().liveSweepText),
    'TRadarUIFrame.sLabelFX12': status(() => `Status: ${nx().statusText}`),
    'TRadarUIFrame.sLabelFX6': status(() => nx().vcpText),
    'TRadarUIFrame.sLabelFX13': status(() => nx().nrtText),
    'TRadarUIFrame.sLabel1': status(() => (nx().flags.avset ? 'AVSET ●' : 'AVSET')),
    'TRadarUIFrame.sLabel2': status(() => (nx().flags.sails ? 'SAILS ●' : 'SAILS')),
    'TRadarUIFrame.sLabelMRLE': status(() => (nx().flags.mrle ? 'MRLE ●' : 'MRLE')),
    'TRadarUIFrame.sGauge1': { kind: 'gauge', value: () => nx().gauge, max: 360 },
    'TRadarUIFrame.sLabelFX9': act(() => app.toast('Live sweep: azimuth / elevation of the newest radial')),
  };

  const radarControl: BindingMap = {
    'TFrmRadarControl.sSpeedButton1': alpha('settings.nexradDataAlpha'),
    'TFrmRadarControl.sSpeedButton2': act(() => app.currentRadarPaletteSelector()),
    'TFrmRadarControl.sRadioButton1': custom(() => !settings.bool('settings.nexrad3DTilt'), () => settings.set('settings.nexrad3DTilt', false)),
    'TFrmRadarControl.sRadioButton2': custom(() => settings.bool('settings.nexrad3DTilt') && !settings.bool('settings.nexrad3DTiltShadow'), () => { settings.set('settings.nexrad3DTilt', true); settings.set('settings.nexrad3DTiltShadow', false); }),
    'TFrmRadarControl.sRadioButton3': custom(() => settings.bool('settings.nexrad3DTilt') && settings.bool('settings.nexrad3DTiltShadow'), () => { settings.set('settings.nexrad3DTilt', true); settings.set('settings.nexrad3DTiltShadow', true); }),
    'TFrmRadarControl.sBitBtn1': act(() => settings.set('settings.nexradPrecipitationTyping', !settings.bool('settings.nexradPrecipitationTyping')), () => settings.bool('settings.nexradPrecipitationTyping')),
    'TFrmRadarControl.sBitBtn2': act(() => app.dialog('TFrmStormMotionVectorControl')),
    'TFrmRadarControl.sBitBtn3': act(() => app.startMeasure('radial'), () => app.tool === 'radial'),
    'TFrmRadarControl.sBitBtn4': act(() => { app.cellTracking = !app.cellTracking; }, () => app.cellTracking),
    'TFrmRadarControl.sCheckBox2': custom(() => nx().liveOld.display, (v) => (nx().liveOld.display = !!v)),
    'TFrmRadarControl.sCheckBox3': custom(() => nx().liveOld.flash, (v) => (nx().liveOld.flash = !!v)),
    'TFrmRadarControl.sBitBtn5': { ...act(() => app.setLiveComposite(!nx().liveComposite), () => nx().liveComposite), label: 'Low-level composite on/off', iconName: 'stack' },
    'TFrmRadarControl.sBitBtn6': act(() => app.dialog('TFrmLevel2AlgorithmSettings')),
    'TFrmRadarControl.sBitBtn7': act(() => app.dialog('TFrmSCITControl')),
    'TFrmRadarControl.sCheckBox8': custom(() => settings.num('settings.nexradScanTransitionMode') >= 1, (v) => settings.set('settings.nexradScanTransitionMode', v ? 1 : 0)),
  };

  const l2algo: BindingMap = {
    'TFrmLevel2AlgorithmSettings.sRadioButton1': radio('settings.nexradQualityDealiasing', true),
    'TFrmLevel2AlgorithmSettings.sRadioButton2': radio('settings.nexradQualityDealiasing', false),
    'TFrmLevel2AlgorithmSettings.sCheckBox1': bool('settings.nexradUseWindDataDealiasing'),
    'TFrmLevel2AlgorithmSettings.sRadioButton3': radio('settings.nexradAlgorithmGust1991', false),
    'TFrmLevel2AlgorithmSettings.sRadioButton4': radio('settings.nexradAlgorithmGust1991', true),
    'TFrmLevel2AlgorithmSettings.sCheckBox2': bool('settings.nexradAlgorithmHailIsothermCustom'),
  };

  const motion: BindingMap = {
    'TFrmStormMotionVectorControl.sRadioButton1': radio('settings.nexradStormMotionCustom', false),
    'TFrmStormMotionVectorControl.sRadioButton2': radio('settings.nexradStormMotionCustom', true),
    'TFrmStormMotionVectorControl.sLabelFX4': status(() => { const a = nx().autoMotion; return settings.bool('settings.nexradStormMotionCustom') ? 'Status: manual vector in use' : a ? `Storm Motion retrieved (${a.speedKt.toFixed(0)} kt from ${a.fromDeg.toFixed(0)}°)` : 'No current Level 3 vector available; using manual.'; }),
    'TFrmStormMotionVectorControl.sSpeedButton4': act(() => app.startMeasure('motion'), () => app.tool === 'motion'),
    'TFrmStormMotionVectorControl.sCheckBox1': custom(() => app.centerForMotion, (v) => (app.centerForMotion = !!v)),
  };

  const ptype: BindingMap = {
    'TFrmPrecipTypingControl.sGroupBox1': bool('settings.generalPrecipTypingProbabilityRendering'),
    'TFrmPrecipTypingControl.sSpeedButton2': pal('settings.generalPrecipTypingRainPalette', 'Rain'),
    'TFrmPrecipTypingControl.sSpeedButton3': pal('settings.generalPrecipTypingSnowPalette', 'Snow'),
    'TFrmPrecipTypingControl.sSpeedButton4': pal('settings.generalPrecipTypingFRPalette', 'Freezing rain'),
    'TFrmPrecipTypingControl.sSpeedButton1': pal('settings.generalPrecipTypingSleetPalette', 'Sleet'),
    'TFrmPrecipTypingControl.sSpeedButton5': pal('settings.nexradL2PrecipTypingRainPalette', 'L2 Rain'),
    'TFrmPrecipTypingControl.sSpeedButton6': pal('settings.nexradL2PrecipTypingSnowPalette', 'L2 Snow'),
    'TFrmPrecipTypingControl.sSpeedButton7': pal('settings.nexradL2PrecipTypingFRPalette', 'L2 Freezing rain'),
    'TFrmPrecipTypingControl.sSpeedButton8': pal('settings.nexradL2PrecipTypingSleetPalette', 'L2 Sleet'),
  };

  const sites: BindingMap = {
    'TFrmRadarSiteLabels.sColorSelect2': color('config.radarSites.CurrentSiteColor'),
    'TFrmRadarSiteLabels.sColorSelect3': color('config.radarSites.SitesColor'),
    'TFrmRadarSiteLabels.sCheckBox1': bool('config.radarSites.MouseProximityScale'),
    'TFrmRadarSiteLabels.sCheckBox2': bool('config.radarSites.MouseProximityAlpha'),
    'TFrmRadarSiteLabels.sCheckBox3': bool('config.radarSites.CurrentShowAlways'),
    'TFrmRadarSiteLabels.sTrackBar1': num('config.radarSites.Scale', 100),
    'TFrmRadarSiteLabels.sCheckBox4': bool('config.radarSites.UnselectedSitesPointOnly'),
    'TFrmRadarSiteLabels.sCheckBox6': bool('config.radarSites.NewSiteSelectionCenter'),
    'TFrmRadarSiteLabels.sCheckBox5': bool('config.radarSites.NewSiteSelectionZoomTo'),
    'TFrmRadarSiteLabels.sCheckBox7': bool('config.radarSites.CurrentClickRecenter'),
    'TFrmRadarSiteLabels.sDecimalSpinEdit1': num('config.radarSites.Alpha', 1, { min: 0.05, max: 1, step: 0.05 }),
    'TFrmRadarSiteLabels.sDecimalSpinEdit2': num('config.radarSites.FadeOutAlpha', 1, { min: 0.05, max: 1, step: 0.05 }),
    'TFrmRadarSiteLabels.sCheckBox8': bool('config.radarSites.HideTDWRs'),
  };

  const scit: BindingMap = {
    'TFrmSCITControl.sListView1': { kind: 'list', items: () => [{ label: 'ID  Dir  Spd  dBZ  TVS MESO POH POSH MEHS' }, ...nx().scit.filter((c) => nx().cellPasses(c)).map((c) => ({ label: `${c.id}  ${fmt(c.dir)}  ${fmt(c.speed)}  ${fmt(c.maxDbz)}  ${c.tvs ? 'Y' : '-'}   ${c.meso ? 'Y' : '-'}   ${c.poh}  ${c.posh}  ${c.mehs.toFixed(2)}` }))], selected: () => -1, select: (i, dbl) => { const c = nx().scit.filter((x) => nx().cellPasses(x))[i - 1]; if (c && dbl) app.flyToKm(c.x, c.y); } },
    'TFrmSCITControl.sBitBtn3': act(() => { app.cellTracking = !app.cellTracking; }, () => app.cellTracking),
    'TFrmSCITControl.sGroupBox1': bool('settings.nexradTracksGlobalFilterOn'),
    'TFrmSCITControl.sCheckBox1': bool('settings.nexradTracksManualFilterOn'),
    'TFrmSCITControl.sCheckBox2': bool('settings.nexradTracksTVSFilterOn'),
    'TFrmSCITControl.sCheckBox3': bool('settings.nexradTracksMESOFilterOn'),
    'TFrmSCITControl.sCheckBox4': bool('settings.nexradTracksReflectivityFilterOn'),
    'TFrmSCITControl.sCheckBox5': bool('settings.nexradTracksMEHSFilterOn'),
    'TFrmSCITControl.sSpinEdit1': num('settings.nexradTracksMEHSFilter', 1, { min: 0.5, max: 5, step: 0.25 }),
    'TFrmSCITControl.sSpinEdit2': num('settings.nexradTracksReflectivityFilter', 1, { min: 1, max: 90 }),
    'TFrmSCITControl.BarSpeedButton': act((el) => el.parentElement?.querySelector<HTMLElement>('[data-id="ui.TFrmSCITControl.sPanel1"]')?.classList.toggle('na')),
  };

  const manual: BindingMap = {
    'TFrmManualTracksControl.sBitBtn1': act(() => app.startMeasure('manualTrack'), () => app.tool === 'manualTrack'),
    'TFrmManualTracksControl.sBitBtn2': act(() => app.clearManualTrack()),
    'TFrmManualTracksControl.BarSpeedButton': act(() => app.toast('Panel collapse is cosmetic in CWRV3')),
    'TFrmManualTracksControl.sSpinEdit3': num('settings.nexradManualTracksExtrapolationTime', 1, { min: 1, max: 120 }),
    'TFrmManualTracksControl.sCheckBox1': bool('settings.nexradManualTracksHideAllCaptions'),
    'TFrmManualTracksControl.sCheckBox4': bool('settings.nexradManualTracksShowImpactedCities'),
    'TFrmManualTracksControl.sCheckBox3': bool('settings.nexradManualTracksRolloverTracking'),
    'TFrmManualTracksControl.sSpinEdit1': num('settings.nexradManualTracksImpactedCitiesMaxCount', 1, { min: 1, max: 30 }),
    'TFrmManualTracksControl.sSpinEdit2': num('settings.nexradManualTracksIntervalMinutes', 1, { min: 5, max: 60 }),
    'TFrmManualTracksControl.sColorSelect4': color('settings.nexradManualTracksColor'),
    'TFrmManualTracksControl.sCheckBox2': bool('settings.nexradManualTracksShowTimePoints'),
    'TFrmManualTracksControl.sCheckBox7': bool('settings.nexradManualTracksShowIntervalLines'),
    'TFrmManualTracksControl.sCheckBox9': bool('settings.nexradManualTracksTimePoints3D'),
    'TFrmManualTracksControl.sColorSelect1': color('settings.nexradTracksColor'),
    'TFrmManualTracksControl.sCheckBox8': bool('ext.settings.nexradTracksLineBorder'),
    'TFrmManualTracksControl.sColorSelect2': color('settings.nexradManualTracksExtrusionColor'),
    'TFrmManualTracksControl.sColorSelect3': color('settings.nexradManualTracksExtrusionFadeColor'),
    'TFrmManualTracksControl.sSpinEdit5': custom(() => settings.arr<number>('settings.nexradManualTracksExtrusionColor')[3], (v) => { const c = [...settings.arr<number>('settings.nexradManualTracksExtrusionColor')]; c[3] = Number(v); settings.set('settings.nexradManualTracksExtrusionColor', c); }),
    'TFrmManualTracksControl.sSpinEdit6': custom(() => settings.arr<number>('settings.nexradManualTracksExtrusionFadeColor')[3], (v) => { const c = [...settings.arr<number>('settings.nexradManualTracksExtrusionFadeColor')]; c[3] = Number(v); settings.set('settings.nexradManualTracksExtrusionFadeColor', c); }),
    'TFrmManualTracksControl.sSpinEdit4': num('settings.nexradManualTracksExtrusionIntervals', 1, { min: 2, max: 30 }),
    'TFrmManualTracksControl.sCheckBox5': bool('settings.nexradManualTracksExtrusionInnerGradient'),
    'TFrmManualTracksControl.sCheckBox6': bool('settings.nexradManualTracksExtrusionFlashUpper'),
    'TFrmManualTracksControl.sSpinEdit7': num('settings.nexradManualTracksExtrusionFlashUpperPercent', 1, { min: 5, max: 100 }),
    'TFrmManualTracksControl.sCheckBox10': bool('settings.nexradManualTracksImpactedCityListCountdown'),
    'TFrmManualTracksControl.sCheckBox11': bool('settings.nexradManualTracksImpactedCityListCountdownShowPast'),
  };

  const glm: BindingMap = {
    'TFrmGLMControl.sSpinEdit1': num('settings.lightningRenderingIconIdx', 1, { min: 1, max: 9 }),
    'TFrmGLMControl.sSpinEdit2': num('settings.lightningRenderingMinutes', 1, { min: 2, max: 300 }),
    'TFrmGLMControl.sTrackBar1': num('settings.lightningRenderingBoltSize', 1000),
    'TFrmGLMControl.sCheckBox2': bool('settings.lightningRenderingTwinkle'),
    'TFrmGLMControl.sCheckBox3': bool('settings.lightningRenderingFlashEffect'),
    'TFrmGLMControl.sCheckBox5': bool('settings.lightningRenderingRollover'),
    'TFrmGLMControl.sCheckBox6': bool('settings.lightningRenderingMinEnergyFilter'),
    'TFrmGLMControl.sSpinEdit4': num('settings.lightningRenderingEnergyFilterValue', 1, { min: 1, max: 3000 }),
    'TFrmGLMControl.sRadioButton1': radio('settings.lightningRenderingGlow', true),
    'TFrmGLMControl.sRadioButton2': radio('settings.lightningRenderingGlow', false),
    'TFrmGLMControl.sCheckBox1': bool('settings.lightningRenderingFlashCountBox'),
    'TFrmGLMControl.sCheckBox4': bool('settings.lightningRenderingScaleByAlpha'),
    'TFrmGLMControl.sCheckBox7': bool('settings.lightningIconAdditive'),
    'TFrmGLMControl.sCheckBox8': { kind: 'bool', id: 'settings.lightningRendering3D', label: '3D strike lines' },
    'TFrmGLMControl.sCheckBox9': bool('settings.lightningRenderingScaleByEnergy'),
    'TFrmGLMControl.sSpeedButton1': pal('settings.lightningRenderingPalette', 'Flash age'),
    'TFrmGLMControl.sSpeedButton2': act(() => app.alphaSelector('settings.lightningRenderingAlpha', 1)),
    'TFrmGLMControl.sSpeedButton3': act(() => app.dialog('TFrmGLMTiltStrikes')),
    // GLM 3D strike line settings: trackbar position = value × 10 for all four sliders.
    'TFrmGLMTiltStrikes.sTrackBar1': num('settings.lightningRendering3DWidth', 10, { min: 10, max: 500 }),
    'TFrmGLMTiltStrikes.sTrackBar2': num('settings.lightningRendering3DSpeed', 10, { min: 1, max: 70 }),
    'TFrmGLMTiltStrikes.sTrackBar3': num('settings.lightningRendering3DRepeat', 10, { min: 2, max: 70 }),
    'TFrmGLMTiltStrikes.sTrackBar4': num('settings.lightningRendering3DHeight', 10, { min: 1, max: 2000 }),
    'TFrmGLMTiltStrikes.sCheckBox7': bool('settings.lightningRendering3DScaleAlpha'),
    'TFrmGLMTiltStrikes.sCheckBox1': bool('settings.lightningRendering3DAdditive'),
    'TFrmGLMTiltStrikes.sCheckBox2': bool('settings.lightningRendering3DAnimate'),
    'TFrmGLMTiltStrikes.sCheckBox3': bool('settings.lightningRendering3DUnderneath'),
    // Restore defaults: the original button writes 5.0 / 70.0 / 4.0 / 1.5 (not the loader defaults 3.4 / 100 / 4.0 / 2.4);
    // the corrected mode (ext.settings.glmRestoreLoaderDefaults) restores the loader defaults instead.
    'TFrmGLMTiltStrikes.sButton1': act(() => {
      const loader = settings.bool('ext.settings.glmRestoreLoaderDefaults');
      settings.set('settings.lightningRendering3DWidth', loader ? 3.4 : 5.0); settings.set('settings.lightningRendering3DHeight', loader ? 100 : 70.0);
      settings.set('settings.lightningRendering3DSpeed', 4.0); settings.set('settings.lightningRendering3DRepeat', loader ? 2.4 : 1.5);
      for (const k of ['ScaleAlpha', 'Additive', 'Animate', 'Underneath']) settings.set(`settings.lightningRendering3D${k}`, true);
    }),
    'TFrmGLMControl.sLabel6': status(() => app.glmStatus()),
    'TFrmGLMControl.sPanel1': VENDOR, 'TFrmGLMControl.sSpeedButton4': VENDOR, 'TFrmGLMControl.sLabel7': VENDOR,
  };

  const useL2 = () => settings.bool('ext.layerState.ExtendedSatelliteUseL2');
  const l2Layer = () => app.layers.get('satelliteL2') as GoesL2Layer;
  const goesExt: BindingMap = {
    'TFrmGOESExtended.sf1': { kind: 'list', items: () => ['GOES-19 (East)', 'GOES-18 (West)', 'Off'].map((label) => ({ label })), selected: () => (settings.bool('layerState.ExtendedSatelliteOn') ? settings.num('ext.layerState.ExtendedSatellitePlatform') : 2), select: (i) => { settings.set('ext.layerState.ExtendedSatellitePlatform', i); settings.set('layerState.ExtendedSatelliteOn', i !== 2); } },
    'TFrmGOESExtended.sf2': { kind: 'list', items: () => ['CONUS', 'Full Disk', 'Mesoscale 1', 'Mesoscale 2'].map((label) => ({ label })), selected: () => settings.num('ext.layerState.ExtendedSatelliteDomain'), select: (i) => settings.set('ext.layerState.ExtendedSatelliteDomain', i) },
    'TFrmGOESExtended.sf3': { kind: 'list', items: () => ['Single Band', 'Derived RGB', 'Level 2 Product'].map((label) => ({ label })),
      selected: () => (useL2() ? 2 : settings.bool('layerState.ExtendedSatelliteUseMulti') ? 1 : 0),
      select: (i) => { settings.set('ext.layerState.ExtendedSatelliteUseL2', i === 2); if (i < 2) settings.set('layerState.ExtendedSatelliteUseMulti', i === 1); } },
    'TFrmGOESExtended.sRadioGroup1': custom(() => settings.num('layerState.ExtendedSatelliteProductIndex'), (i) => { settings.set('layerState.ExtendedSatelliteProductIndex', i); settings.set('layerState.ExtendedSatelliteUseMulti', false); settings.set('ext.layerState.ExtendedSatelliteUseL2', false); }),
    'TFrmGOESExtended.sComboBox1': custom(() => settings.num('layerState.ExtendedSatelliteMultiIndex'), (i) => { settings.set('layerState.ExtendedSatelliteMultiIndex', i); settings.set('layerState.ExtendedSatelliteUseMulti', true); settings.set('ext.layerState.ExtendedSatelliteUseL2', false); }, () => ['True Color (bands 1/2/3)', 'IR/VIS Sandwich (bands 2/14)']),
    'TFrmGOESExtended.l2Product': custom(() => settings.num('ext.layerState.ExtendedSatelliteL2Product'), (i) => { settings.set('ext.layerState.ExtendedSatelliteL2Product', i); settings.set('ext.layerState.ExtendedSatelliteUseL2', true); },
      () => GOES_L2.map((p) => `${p.name}${p.sectors.length < 4 ? ' (no CONUS)' : ''}`)),
    'TFrmGOESExtended.l2Status': status(() => { const l = l2Layer(); return !useL2() ? 'Select "Level 2 Product" above to show it.' : l.unavailable() ?? (l.status.text || 'Waiting for data…'); }),
    'TFrmGOESExtended.sSpeedButton3': act(() => app.dialog('TFrmGOESMultispectralRGB')),
    'TFrmGOESExtended.sSpeedButton7': act(() => settings.set('ext.layerState.LoopLength', Math.min(2, settings.num('ext.layerState.LoopLength')))),
    'TFrmGOESExtended.sSpeedButton31': act(() => {
      if (useL2()) { const i = settings.num('ext.layerState.ExtendedSatelliteL2Product'); app.arrayPaletteSelector('ext.settings.goesL2Palettes', i, GOES_L2[i].name); return; }
      const b = settings.num('layerState.ExtendedSatelliteProductIndex'); app.arrayPaletteSelector('settings.goesExtendedBandPals', b, `Band ${b + 1}`);
    }, undefined, () => (useL2() ? 'Product Palette' : 'Band Palette')),
    'TFrmGOESExtended.sSpeedButton32': alpha('settings.goesExtendedAlpha'),
    'TFrmGOESExtended.sCheckBox1': bool('settings.goesExtendedForce60fps'),
    'TFrmGOESExtended.sCheckBox2': bool('settings.goesMesoThird'),
    'TFrmGOESExtended.sCheckBox3': bool('settings.goesCONUSThird'),
    'TFrmGOESExtended.sBadgeBtn1': act(() => app.toast('Rapid-scan loops may hold up to 60 frames.')),
    'TFrmGOESExtended.sArcPreloader2': { kind: 'busy', on: () => app.layerBusy('satelliteExtended') },
    'TFrmGOESExtended.sPanel2': VENDOR, 'TFrmGOESExtended.sSpeedButton1': VENDOR, 'TFrmGOESExtended.sLabel7': VENDOR,
  };

  // Multispectral recipe editor state: selected channel, unapplied recipe text, recipe being edited.
  let rgbCh = 0, recipeDraft: string | null = null;
  const recipe = () => rgbRecipes.list[settings.num('layerState.ExtendedSatelliteMultiIndex') - 2] ?? null;
  const edited = () => { rgbRecipes.save(); app.refreshLayer('satelliteExtended'); };
  const BUILTIN_TEXT = ['// True Color (built in): bands 1, 2, 3\nr = ch2\ng = 0.2*ch3 + 0.4*ch1 + 0.4*ch2\nb = ch1\n// then gamma 1/2.2 and contrast 1.7', '// IR/VIS sandwich (built in): band 2 visible × band 14 IR palette\n// rgb = 2·ch1 × palette(ch2), alpha = ch1 / 0.25'];
  const rgb: BindingMap = {
    // Recipes: index 0/1 built in (fixed WGSL); 2+ user recipes compiled from the recipe text.
    'TFrmGOESMultispectralRGB.sComboBox1': custom(() => settings.num('layerState.ExtendedSatelliteMultiIndex'), (i) => { settings.set('layerState.ExtendedSatelliteMultiIndex', Number(i)); rgbCh = 0; }, () => ['True Color', 'IR/VIS Multiplicative Sandwich', ...rgbRecipes.list.map((r) => r.name)]),
    'TFrmGOESMultispectralRGB.sSpeedButton1': act(async () => {
      const name = await app.prompt('New multispectral product', 'Product name:');
      if (!name) return;
      rgbRecipes.list.push({ name, bands: [2, 3, 1, 14], enabled: [true, true, true, false], text: 'r = ch1\ng = ch2\nb = ch3\na = 1.0', paletteChannel: -1, contrast: { on: false, value: 25 }, gamma: { on: false, value: 25 }, additive: false });
      rgbRecipes.save(); settings.set('layerState.ExtendedSatelliteMultiIndex', rgbRecipes.list.length + 1); rgbCh = 0;
    }),
    'TFrmGOESMultispectralRGB.sSpeedButton2': act(() => { const i = settings.num('layerState.ExtendedSatelliteMultiIndex') - 2; if (i < 0) return app.toast('Built-in products cannot be deleted'); rgbRecipes.list.splice(i, 1); rgbRecipes.save(); settings.set('layerState.ExtendedSatelliteMultiIndex', 0); }),
    'TFrmGOESMultispectralRGB.sSpeedButton3': act(() => { rgbRecipes.list = []; rgbRecipes.save(); settings.set('layerState.ExtendedSatelliteMultiIndex', 0); }),
    'TFrmGOESMultispectralRGB.sMemo1': custom(() => recipe()?.text ?? BUILTIN_TEXT[settings.num('layerState.ExtendedSatelliteMultiIndex')] ?? '', (v: string) => { const r = recipe(); if (r) { recipeDraft = String(v); } }),
    'TFrmGOESMultispectralRGB.sSpeedButton4': act(() => {
      const r = recipe();
      if (!r) return app.toast('Built-in recipes are fixed; use Add New... to create your own');
      const text = recipeDraft ?? r.text;
      try { parseRecipeText(text); } catch (e) { return app.toast(`Recipe error: ${(e as Error).message}`); }
      r.text = text; recipeDraft = null; edited();
      app.toast('Recipe applied');
    }),
    'TFrmGOESMultispectralRGB.sCheckListBox1': { kind: 'list', items: () => { const r = recipe(); return [0, 1, 2, 3].map((i) => ({ label: `Ch. ${i + 1} (Band ${r ? r.bands[i] : ([[1, 2, 3, 0], [2, 14, 0, 0]][settings.num('layerState.ExtendedSatelliteMultiIndex')]?.[i] || '—')})`, checked: r ? r.enabled[i] : i < (settings.num('layerState.ExtendedSatelliteMultiIndex') === 1 ? 2 : 3) })); },
      selected: () => rgbCh, select: (i) => { rgbCh = i; }, check: (i, on) => { const r = recipe(); if (r) { r.enabled[i] = on; edited(); } } },
    'TFrmGOESMultispectralRGB.sComboBox2': custom(() => (recipe()?.bands[rgbCh] ?? 1) - 1, (i) => { const r = recipe(); if (r) { r.bands[rgbCh] = Number(i) + 1; edited(); } }),
    'TFrmGOESMultispectralRGB.sCheckBox1': custom(() => recipe()?.paletteChannel === rgbCh, (v) => { const r = recipe(); if (r) { r.paletteChannel = v ? rgbCh : -1; edited(); } }),
    'TFrmGOESMultispectralRGB.sCheckBox2': custom(() => !!recipe()?.contrast.on, (v) => { const r = recipe(); if (r) { r.contrast.on = !!v; edited(); } }),
    'TFrmGOESMultispectralRGB.sCheckBox3': custom(() => !!recipe()?.gamma.on, (v) => { const r = recipe(); if (r) { r.gamma.on = !!v; edited(); } }),
    'TFrmGOESMultispectralRGB.sTrackBar1': custom(() => recipe()?.contrast.value ?? 0, (v) => { const r = recipe(); if (r) { r.contrast.value = Number(v); edited(); } }),
    'TFrmGOESMultispectralRGB.sTrackBar2': custom(() => recipe()?.gamma.value ?? 0, (v) => { const r = recipe(); if (r) { r.gamma.value = Number(v); edited(); } }),
    'TFrmGOESMultispectralRGB.sCheckBox4': custom(() => !!recipe()?.additive, (v) => { const r = recipe(); if (r) { r.additive = !!v; edited(); } }),
    'TFrmGOESMultispectralRGB.sBadgeBtn1': act(() => app.toast('Bands 7–16 arrive in °C, bands 1–6 as 0–1 reflectance.')),
    'TFrmGOESMultispectralRGB.sBadgeBtn2': act(() => app.toast('Recipe lines: r = …, g = …, b = …, a = … using ch1–ch4, pr/pg/pb (palette colour) and min max clamp mix pow abs sqrt smoothstep step exp log.')),
    'TFrmGOESMultispectralRGB.sBadgeBtn3': act(() => app.toast('The sandwich recipe colors band 14 through the IR palette.')),
  };

  const warn: BindingMap = {
    'TFrmWarningControl.sSpeedButton1': act(() => app.dialog('TFrmWarningsList')),
    // Caption font + / −: one size step of the WarningCaptions text style.
    'TFrmWarningControl.sSpeedButton2': act(() => scaleTextStyle('WarningCaptions', 1)),
    'TFrmWarningControl.sSpeedButton7': act(() => scaleTextStyle('WarningCaptions', -1)),
    // Styles page: default style per warning type, custom styles triggered by text phrases.
    'TFrmWarningControl.sComboBox1': custom(() => warnSel.type, (v: number) => (warnSel.type = v), () => WARN_CODES.map((c) => c)),
    'TFrmWarningControl.sBitBtn1': { kind: 'action', run: () => app.editStyle(`${WARN_CODES[warnSel.type]}Warn`, `${WARN_CODES[warnSel.type]} warning`), caption: () => `Default ${WARN_CODES[warnSel.type]} style...` },
    'TFrmWarningControl.sListBox1': { kind: 'list', items: () => warningCustomStyles.map((w) => ({ label: w.name })), selected: () => warnSel.custom, select: (i) => (warnSel.custom = i) },
    'TFrmWarningControl.sBitBtn2': act(() => { const w = warningCustomStyles[warnSel.custom]; if (w) app.editStyle(`WarnCustom:${w.name}`, w.name); else app.toast('Select a custom style'); }),
    'TFrmWarningControl.sMemo1': custom(() => warningCustomStyles[warnSel.custom]?.phrases.join('\n') ?? '', (v: string) => { const w = warningCustomStyles[warnSel.custom]; if (w) { w.phrases = String(v).split('\n').map((x) => x.trim()).filter(Boolean); saveWarningCustomStyles(); } }),
    'TFrmWarningControl.sSpeedButton5': act(async () => { const n = await app.prompt('Custom warning style', 'Name of the custom style:'); if (n) { warningCustomStyles.push({ name: n, phrases: [n.toUpperCase()] }); warnSel.custom = warningCustomStyles.length - 1; saveWarningCustomStyles(); } }),
    'TFrmWarningControl.sSpeedButton6': act(() => { const w = warningCustomStyles[warnSel.custom]; if (w) { warningCustomStyles.splice(warnSel.custom, 1); setObjectStyle(`WarnCustom:${w.name}`, null); warnSel.custom = -1; saveWarningCustomStyles(); } }),
    'TFrmWarningControl.sBadgeBtn1': act(() => app.toast('Custom styles colour a warning whose text contains any of the listed phrases (case-insensitive).')),
    'TFrmWarningControl.sGroupBox1': bool('settings.severeWarningsShowCaptions'),
    'TFrmWarningControl.sSpeedButton3': act(() => app.editText('WarningCaptions', 'font')), 'TFrmWarningControl.sSpeedButton4': act(() => app.editText('WarningCaptions', 'appearance')),
    'TFrmWarningControl.sCheckBox3': bool('settings.severeWarningsShowExpirationCaption'),
    'TFrmWarningControl.sCheckBox2': bool('settings.severeWarningsShowTitleCaption'),
    'TFrmWarningControl.sCheckBox4': bool('settings.severeWarningsShowWindImpactCaption'),
    'TFrmWarningControl.sCheckBox14': bool('settings.severeWarningsShowHailImpactCaption'),
    'TFrmWarningControl.sCheckBox15': bool('settings.severeWarningsShowDamageImpactCaption'),
    'TFrmWarningControl.sCheckBox16': bool('settings.severeWarningsExpirationCaptionCountdown'),
    'TFrmWarningControl.sCheckBox17': bool('settings.severeWarningsTitleCaptionAbbreviated'),
    'TFrmWarningControl.sCheckBox7': bool('settings.severeWarningsInfoBoxLine'),
    'TFrmWarningControl.sCheckBox8': bool('settings.severeWarningsInfoBoxTextWarningType'),
    'TFrmWarningControl.sCheckBox9': bool('settings.severeWarningsInfoBoxTextIssued'),
    'TFrmWarningControl.sCheckBox10': bool('settings.severeWarningsInfoBoxTextExpiration'),
    'TFrmWarningControl.sCheckBox11': bool('settings.severeWarningsInfoBoxTextStormMotion'),
    'TFrmWarningControl.sCheckBox12': bool('settings.severeWarningsInfoBoxTextImpactFields'),
    'TFrmWarningControl.sCheckBox13': bool('settings.severeWarningsInfoBoxTextLocations'),
    'TFrmWarningControl.sSpinEdit1': num('settings.severeWarningsInfoBoxTextWrappingMaxCharWidth', 1, { min: 10, max: 400 }),
    'TFrmWarningControl.sRadioButton3': na('Vendor warning servers are not used; the public NWS API is always used'),
    'TFrmWarningControl.sRadioButton4': { kind: 'na', reason: settingExclusion('settings.severeWarningsDataSourceMode')![1] },
    'TFrmWarningControl.sRadioButton5': { kind: 'na', reason: settingExclusion('settings.severeWarningsDataSourceMode')![1] },
    'TFrmWarningControl.sEdit1': text('settings.severeWarningsServerOverride'),
    'TFrmWarningControl.sBadgeBtn2': act(() => app.toast('Warnings come from api.weather.gov; a custom server URL is stored but not polled (partial).')),
    'TFrmWarningControl.sRadioButton1': radio('settings.severeWarningsMessageOrderNewestFirst', false),
    'TFrmWarningControl.sRadioButton2': radio('settings.severeWarningsMessageOrderNewestFirst', true),
    'TFrmWarningControl.sCheckBox1': bool('settings.severeWarningsShowTracking'),
    'TFrmWarningControl.sCheckBox5': bool('settings.severeWarningsShowPushNotification'),
  };
  const warnList = (kind: 'warnings' | 'watches'): BindingMap => {
    const p = kind === 'warnings' ? 'TFrmWarningsList' : 'TFrmWatchesList';
    let sel = -1;
    const items = () => app.alertList(kind);
    return {
      [`${p}.wListView`]: { kind: 'list', items: () => items().map((a) => ({ label: a.label })), selected: () => sel, select: (i, dbl) => { sel = i; if (dbl) app.zoomToAlert(items()[i]?.alert); } },
      [`${p}.sSpeedButton1`]: act(() => { const a = items()[sel]?.alert; if (a) app.showText(a.event, `${a.headline}\n\n${a.description}`); }),
      [`${p}.sSpeedButton2`]: act(() => app.zoomToAlert(items()[sel]?.alert)),
    };
  };

  const timelineBlock: BindingMap = {
    // The timeline resolves its owner from this setting (src/app/timeline.ts); no controller is forced here.
    'TFrmMap.TimelineSelect': custom(() => settings.num('ext.layerState.TimelineSelect'), (v: number) => settings.set('ext.layerState.TimelineSelect', v), () => ['Main Timeline', 'Model Timeline']),
    'TFrmMap.ToolButton2': act(() => app.timeline.first(), undefined, () => ''),
    'TFrmMap.ToolButton3': act(() => app.timeline.step(-1), undefined, () => ''),
    'TFrmMap.ToolButton5': { kind: 'action', run: () => app.timeline.play(), down: () => app.timeline.playing, caption: () => '', icon: () => (app.timeline.playing ? 'pause' : 'play'), title: () => `${app.timeline.playing ? 'Pause' : 'Play'} · ${timingText(app.timeline)}` } as Binding,
    'TFrmMap.ToolButton9': act(() => app.timeline.step(1), undefined, () => ''),
    'TFrmMap.ToolButton10': act(() => app.timeline.last(), undefined, () => ''),
    'TFrmMap.sToolBar2': na('alternate (hidden) transport toolbar of the original; not shown'),
    'TFrmMap.ToolButton1': na('alternate transport toolbar (hidden in the original)'), 'TFrmMap.ToolButton4': na('alternate transport toolbar (hidden)'),
    'TFrmMap.ToolButton6': na('alternate transport toolbar (hidden)'), 'TFrmMap.ToolButton7': na('alternate transport toolbar (hidden)'), 'TFrmMap.ToolButton8': na('alternate transport toolbar (hidden)'),
    'TFrmMap.sTrackBar1': custom(() => Math.round(((app.timeline.t - app.timeline.start) / Math.max(1, app.timeline.end - app.timeline.start)) * 100), (v) => app.timeline.scrub(Number(v) / 100)),
    'TFrmMap.sDecimalSpinEdit4': num('ext.layerState.LoopLength', 1, { min: 0.5, max: 6, step: 0.5 }),
    'TFrmMap.NEXRADSiteList': custom(() => RADAR_SITES.findIndex((s) => s.id === settings.str('settings.nexradSiteICAO')), (i) => app.setSite(RADAR_SITES[i].id), () => RADAR_SITES.map((s) => `${s.id} ${titleCase(s.name)}, ${s.st}`)),
    'TFrmMap.sEdit1': custom(() => app.siteEdit, (v) => (app.siteEdit = String(v).toUpperCase())),
    'TFrmMap.SetNEXRADSiteName': act(() => app.setSite(app.siteEdit)),
    'TFrmMap.mapMode0': act(() => settings.set('config.generalMapMode', 0), () => settings.num('config.generalMapMode') === 0, () => 'Explore'),
    'TFrmMap.mapMode1': act(() => settings.set('config.generalMapMode', 1), () => settings.num('config.generalMapMode') === 1, () => 'Interact'),
    'TFrmMap.mapMode2': act(() => settings.set('config.generalMapMode', 2), () => settings.num('config.generalMapMode') === 2, () => 'Probe'),
    'TFrmMap.sSpeedButton1': act(() => app.captureImage()),
    'TFrmMap.sSpeedButton2': act(() => app.toggleVideo(), () => app.recording),
    'TFrmMap.sLabelFX6': act(() => app.setOutputSize(), undefined, () => app.outputSizeLabel()),
    'TFrmMap.sBitBtn1': act(() => app.dialog('TFrmMapModes')),
    'TFrmMap.sBitBtn2': act(() => settings.set('config.performanceMode', 0), () => settings.num('config.performanceMode') === 0),
    'TFrmMap.sBitBtn3': act(() => settings.set('config.performanceMode', 1), () => settings.num('config.performanceMode') === 1),
    'TFrmMap.sBitBtn4': act(() => settings.set('config.performanceMode', 2), () => settings.num('config.performanceMode') === 2),
    // Extra panels
    'TFrmMap.sSpeedButton16': act(() => app.dialog('TFrmPrecipTypingControl')),
    'TFrmMap.sSpeedButton40': alpha('settings.nrAlpha'),
    'TFrmMap.sCheckBox6': bool('settings.nrLegend'),
    'TFrmMap.sCheckBox3': bool('settings.nrBlendFrames'),
    'TFrmMap.sSpeedButton37': act(() => { const b = app.satBand(); app.arrayPaletteSelector('settings.goesBandPals', b - 1, `Band ${b}`); }, undefined, () => `${SAT_NAMES[settings.num('layerState.SatelliteProductIndex')] ?? 'Band'} palette...`),
    'TFrmMap.sSpeedButton41': alpha('settings.goesAlpha'),
    'TFrmMap.sCheckBox26': bool('settings.goesLegend'),
    'TFrmMap.sCheckBox1': bool('settings.goesBlendFrames'),
    'TFrmMap.sSpeedButton30': pal('settings.saWindPalette', '10m Wind'),
    'TFrmMap.sSpeedButton33': alpha('settings.saWindAlpha'),
    'TFrmMap.sSpeedButton31': act(() => app.arrayPaletteSelector('settings.saFillPalettes', settings.num('layerState.saFillIdx'), 'High-Res Fill')),
    'TFrmMap.sSpeedButton32': alpha('settings.saFillAlpha'),
    'TFrmMap.sCheckBox24': bool('settings.saLegend'),
    'TFrmMap.sSpeedButton15': act(() => app.dialog('TFrmWatchesList')),
    'TFrmMap.sCheckBox22': bool('settings.severeTORAviationWatch'),
    'TFrmMap.sCheckBox23': bool('settings.severeSVRAviationWatch'),
    'TFrmMap.sSpeedButton42': act(() => app.editStyle('TORWatch', 'Tornado watch')), 'TFrmMap.sSpeedButton43': act(() => app.editStyle('TORAVWatch', 'Tornado watch (aviation box)')),
    'TFrmMap.sSpeedButton44': act(() => app.editStyle('SVRAVWatch', 'Severe thunderstorm watch (aviation box)')), 'TFrmMap.sSpeedButton45': act(() => app.editStyle('SVRWatch', 'Severe thunderstorm watch')),
    'TFrmMap.sSpeedButton6': act(() => app.editStyle('TORPDSWatch', 'PDS tornado watch')), 'TFrmMap.sSpeedButton13': act(() => app.editStyle('SVRPDSWatch', 'PDS severe thunderstorm watch')),
    'TFrmMap.Button2': na('Dual-monitor output: a web page draws a single canvas'),
    'TFrmMap.sButton1': na('developer-only control of the original'),
    'TFrmMap.BarSpeedButton': act(() => app.toggleSidebar()),
    'TFrmMap.sGauge1': { kind: 'gauge', value: () => app.downloadFraction(), max: 1 },
  };
  // Surface tab "More" panels: station spacing (dense ← → sparse), per-field palettes, inactive buoys.
  Object.assign(timelineBlock, {
    'TFrmMap.sTrackBar4': num('settings.metarSpacing', 1, { min: 0, max: 300 }),
    'TFrmMap.sSpeedButton22': pal('settings.metarTempColorPalette', 'METAR temperature'), 'TFrmMap.sSpeedButton23': pal('settings.metarDewPTColorPalette', 'METAR dew point'),
    'TFrmMap.sSpeedButton24': pal('settings.metarWindColorPalette', 'METAR wind'), 'TFrmMap.sSpeedButton25': pal('settings.metarGustColorPalette', 'METAR gust'),
    'TFrmMap.sSpeedButton26': pal('settings.metarRHColorPalette', 'METAR relative humidity'), 'TFrmMap.sSpeedButton27': pal('settings.metarWindChillColorPalette', 'METAR wind chill'),
    'TFrmMap.sSpeedButton28': pal('settings.metarHeatIndexColorPalette', 'METAR heat index'),
    'TFrmMap.sTrackBar2': num('settings.ndbcSpacing', 1, { min: 0, max: 300 }),
    'TFrmMap.sSpeedButton5': pal('settings.ndbcTempColorPalette', 'Marine air temperature'), 'TFrmMap.sSpeedButton7': pal('settings.ndbcDewPTColorPalette', 'Marine dew point'),
    'TFrmMap.sSpeedButton8': pal('settings.ndbcWindColorPalette', 'Marine wind'), 'TFrmMap.sSpeedButton9': pal('settings.ndbcGustColorPalette', 'Marine gust'),
    'TFrmMap.sSpeedButton10': pal('settings.ndbcWaveHtColorPalette', 'Wave height'), 'TFrmMap.sSpeedButton11': pal('settings.ndbcWavePdColorPalette', 'Wave period'),
    'TFrmMap.sSpeedButton12': pal('settings.ndbcWaterTempColorPalette', 'Water temperature'),
    'TFrmMap.sCheckBox2': bool('settings.ndbcHideDeadBuoys'),
  });
  for (const id of ['sTrackBar3', 'sTrackBar5', 'sTrackBar6', 'sTrackBar8']) timelineBlock[`TFrmMap.${id}`] = na('Hidden status-bar trackbar of the original with no known purpose');

  const settingsDlg: BindingMap = {
    'TFrmSettings.sColorSelect1': custom(() => { const c = settings.num('config.mbgColor'); return [c & 255, (c >> 8) & 255, (c >> 16) & 255]; }, (v: number[]) => settings.set('config.mbgColor', v[0] | (v[1] << 8) | (v[2] << 16))),
    'TFrmSettings.sEdit5': text('ext.config.vectorFieldRoundingFormat'),
    'TFrmSettings.sEdit4': text('config.generalProbeRoundingFormat'),
    'TFrmSettings.sSlider2': bool('config.rightSide'),
    'TFrmSettings.sCheckBox14': bool('config.starField'),
    'TFrmSettings.sButton6': act(() => app.setDefaultView()),
    'TFrmSettings.sCheckBox18': bool('config.noLegend'),
    'TFrmSettings.sCheckBox19': bool('config.labelOnTop'),
    'TFrmSettings.sButtonw': act(() => app.confirmReset('CWRV3ConfigurationSettings')),
    'TFrmSettings.sCheckBox20': bool('config.generalLaunchMaximized'),
    'TFrmSettings.sCheckBox4': bool('settings.atmosphereOn'),
    'TFrmSettings.sTrackBar3': num('settings.atmosphereSunIntensity'),
    'TFrmSettings.sTrackBar18': num('settings.atmosphereHeight'),
    'TFrmSettings.sTrackBar19': num('settings.atmosphereInnerLimiting'),
    'TFrmSettings.sButton4': act(() => app.confirmReset('CWRV3Settings')),
    'TFrmSettings.sCheckBox10': bool('config.classicUIStyle'),
    'TFrmSettings.sCheckBox11': bool('config.sidebarOnLaunch'),
    'TFrmSettings.sCheckBox54': bool('config.generalShowLatLonText'),
    'TFrmSettings.sCheckBox25': bool('config.generalFramebufferEffects'),
    'TFrmSettings.sCheckBox12': bool('config.generalLaunchFullscreen'),
    'TFrmSettings.sRadioButton4': radio('config.logoCustom', false),
    'TFrmSettings.sRadioButton5': radio('config.logoCustom', true),
    'TFrmSettings.sFilenameEdit1': act(() => app.pickLogo()),
    'TFrmSettings.sRadioButton8': radio('config.logoCorner', 0), 'TFrmSettings.sRadioButton9': radio('config.logoCorner', 1),
    'TFrmSettings.sRadioButton10': radio('config.logoCorner', 2), 'TFrmSettings.sRadioButton11': radio('config.logoCorner', 3),
    'TFrmSettings.sSpinEdit5': pointItem('config.logoOffset', 0), 'TFrmSettings.sSpinEdit6': pointItem('config.logoOffset', 1),
    'TFrmSettings.sSpeedButton27': act(() => app.editText('MapTimestamp', 'font')), 'TFrmSettings.sSpeedButton28': act(() => app.editText('MapTimestamp', 'appearance')),
    'TFrmSettings.sEdit1': pointItem('config.labelOffset', 0), 'TFrmSettings.sEdit2': pointItem('config.labelOffset', 1),
    'TFrmSettings.sCheckBox3': bool('config.labelFasten'),
    'TFrmSettings.sRadioButton1': radio('config.labelTimeZone', true), 'TFrmSettings.sRadioButton2': radio('config.labelTimeZone', false),
    'TFrmSettings.sEdit3': text('ext.config.dateTimeFormat'),
    'TFrmSettings.sCheckBox35': bool('ext.config.timestampShowZone'),
    'TFrmSettings.sButton10': act(() => app.dialog('TFrmShapefiles')),
    'TFrmSettings.sCheckBox13': bool('config.geoTextNotification'),
    'TFrmSettings.sButton7': act(() => app.dialog('TFrmRoadsControl')),
    'TFrmSettings.sButton11': act(() => app.dialog('TFrmGISDownload')),
    'TFrmSettings.sCheckBox22': bool('settings.NWSAdvisoriesNoLines'),
    'TFrmSettings.sSpinEdit4': num('settings.NWSAdvisoriesResolution', 1, { min: -100, max: 170 }),
    'TFrmSettings.sTrackBar1': num('config.videoCompression'),
    'TFrmSettings.sCheckBox44': bool('config.videoGDICursor'),
    'TFrmSettings.sCheckBox46': bool('config.videoWatchAfter'),
    'TFrmSettings.sCheckBox41': bool('config.video60FPSOut'),
    // Capture source: whole screen (browser screen-sharing prompt), graphics output, window with/without UI.
    'TFrmSettings.sRadioButton3': custom(() => settings.bool('ext.config.videoWholeScreen'), () => settings.set('ext.config.videoWholeScreen', true)),
    'TFrmSettings.sRadioButton15': custom(() => !settings.bool('ext.config.videoWholeScreen') && !settings.bool('config.videoWholeWindow'), () => { settings.set('ext.config.videoWholeScreen', false); settings.set('config.videoWholeWindow', false); }),
    'TFrmSettings.sRadioButton16': custom(() => !settings.bool('ext.config.videoWholeScreen') && settings.bool('config.videoWholeWindow') && settings.bool('config.videoGDIBox'), () => { settings.set('ext.config.videoWholeScreen', false); settings.set('config.videoWholeWindow', true); settings.set('config.videoGDIBox', true); }),
    'TFrmSettings.sRadioButton21': custom(() => !settings.bool('ext.config.videoWholeScreen') && settings.bool('config.videoWholeWindow') && !settings.bool('config.videoGDIBox'), () => { settings.set('ext.config.videoWholeScreen', false); settings.set('config.videoWholeWindow', true); settings.set('config.videoGDIBox', false); }),
    'TFrmSettings.sCheckBox2': bool('config.videoMPEGPart10'),
    'TFrmSettings.sSpinEdit27': num('settings.mrmsFrames', 1, { min: 1, max: 20 }),
    'TFrmSettings.sRadioButton24': custom(() => effective2(), () => settings.set('settings.nexradL2DataSource', 2)),
    'TFrmSettings.sRadioButton23': radio('settings.nexradL2DataSource', 3),
    'TFrmSettings.sRadioButton17': custom(() => settings.num('settings.nexradL2DataSource') === 4 && !!settings.str('settings.nexradL2CustomDataSource').trim(), () => settings.set('settings.nexradL2DataSource', settings.str('settings.nexradL2CustomDataSource').trim() ? 4 : 2)),
    'TFrmSettings.sButton12': act(() => app.cacheSize()),
    'TFrmSettings.sButton13': act(() => app.clearCache()),
    // A browser cache has no folder: report its size and location instead.
    'TFrmSettings.sButton14': act(() => app.cacheSize()),
    // Hidden in the original design; shown here because the model source setting has no other control.
    'TFrmSettings.sGroupBox25': status(() => 'NCEP Model Data Source'),
    'TFrmSettings.sRadioButton26': radio('settings.modelDataSource', 0), 'TFrmSettings.sRadioButton27': radio('settings.modelDataSource', 1), 'TFrmSettings.sRadioButton29': radio('settings.modelDataSource', 2),
    'TFrmSettings.sEdit6': na('excluded: Level 3 custom server group is hidden in the original (no catalog setting)'),
    'TFrmSettings.sCheckBox5': na('excluded: Level 3 custom server group is hidden in the original (no catalog setting)'),
    'TFrmSettings.sSpinEdit11': num('settings.generalLoopSpeedMinLoopTime', 1, { min: 20, max: 1000000 }),
    'TFrmSettings.sSpinEdit21': num('settings.generalLoopSpeedEndDelay', 1, { min: 1, max: 25000 }),
    'TFrmSettings.sSpinEdit26': num('settings.mrmsFrameTime'),
    'TFrmSettings.sSpeedButton1': act(() => app.dialog('TFrmLabelDBEdit')),
    'TFrmSettings.sSpeedButton25': act(() => app.editText('CityLabels', 'font')), 'TFrmSettings.sSpeedButton26': act(() => app.editText('CityLabels', 'appearance')),
    'TFrmSettings.sCheckBox37': bool('config.citylabelCaps'),
    'TFrmSettings.sGroupBox2': bool('config.citylabelFadeIn'),
    'TFrmSettings.sSpinEdit7': num('config.citylabelFadeTime', 1, { min: 1, max: 2000 }),
    'TFrmSettings.sCheckBox36': bool('config.citylabelPopIn'),
    'TFrmSettings.sCheckBox21': bool('config.citylabels'),
    'TFrmSettings.sTrackBar2': num('config.citylabelSpacing'),
    'TFrmSettings.sCheckBox49': bool('config.citylabelRFilterOn'),
    'TFrmSettings.sTrackBar7': num('config.citylabelRFilter'),
    'TFrmSettings.sSpeedButton5': act(() => app.dialog('TFrmRadarSiteLabels')),
    'TFrmSettings.sCheckBox1': bool('config.placefileLoadAtStart'),
    'TFrmSettings.sSpeedButton29': act(() => app.editText('ProbeFont', 'font')), 'TFrmSettings.sSpeedButton30': act(() => app.editText('ProbeFont', 'appearance')),
    'TFrmSettings.sSpeedButton31': act(() => app.editText('RolloverFont', 'font')), 'TFrmSettings.sSpeedButton32': act(() => app.editText('RolloverFont', 'appearance')),
    'TFrmSettings.sCheckBox50': bool('settings.generalProbeModeCrosshair'),
    'TFrmSettings.sColorSelect7': color('config.telestrateColor'),
    'TFrmSettings.sSpinEdit23': num('config.telestrateWidth', 1, { min: 1, max: 200 }),
    'TFrmSettings.sCheckBox53': bool('settings.generalDisableAnimatedPalettes'),
    'TFrmSettings.sCheckBox42': bool('config.generalRadarVelocityDirectionText'),
    'TFrmSettings.sCheckBox51': bool('config.generalRadarVelocityMPHForce'),
    'TFrmSettings.sCheckBox8': bool('config.playViewpointsAtStart'),
    'TFrmSettings.sDecimalSpinEdit9': num('config.generalSphereMeshSpacing', 1, { min: 1, max: 15 }),
    'TFrmSettings.sRadioButton14': radio('config.clickZoom', 0), 'TFrmSettings.sRadioButton12': radio('config.clickZoom', 1), 'TFrmSettings.sRadioButton13': radio('config.clickZoom', 2),
    'TFrmSettings.sCheckBox9': bool('config.cameraSmoothPan'), 'TFrmSettings.sCheckBox15': bool('config.cameraSmoothZoom'),
    'TFrmSettings.sCheckBox16': bool('config.cameraSmoothSwivel'), 'TFrmSettings.sCheckBox17': bool('config.cameraSmoothTilt'),
    'TFrmSettings.sCheckBox38': bool('config.cameraSmoothLookAtYZ'), 'TFrmSettings.sCheckBox39': bool('config.cameraSmoothLookAtX'),
    'TFrmSettings.sTrackBar4': num('config.cameraSmoothingAmount'),
    'TFrmSettings.sSpinEdit19': num('config.generalCameraPanSensitivity', 100, { min: 5, max: 250 }),
    'TFrmSettings.sSpinEdit20': num('config.generalCameraZoomSensitivity', 100, { min: 5, max: 250 }),
    'TFrmSettings.sSpeedButton7': act(() => settings.set('config.generalCtrlZZoomLevel', app.renderer.camera.cur.z)),
    'TFrmSettings.sCheckBox29': bool('config.generalCameraDisableTiltSwivel'),
    'TFrmSettings.sSpinEdit10': num('config.generalCameraFlyDuration', 1, { min: 10, max: 90000 }),
    'TFrmSettings.sSpinEdit31': num('config.generalZoomBoxCameraFlyDuration', 1, { min: 10, max: 90000 }),
    'TFrmSettings.sSpeedButton2': act(() => app.exportViewpoints()),
    'TFrmSettings.sSpeedButton14': act(() => app.importViewpoints(false)),
    'TFrmSettings.sSpeedButton15': act(() => app.importViewpoints(true)),
    'TFrmSettings.sCheckBox40': bool('config.generalCameraFlyNonLinear'),
    'TFrmSettings.sTrackBar5': num('config.generalCameraFlyJerk', 100),
    'TFrmSettings.sTrackBar6': num('config.generalCameraFlyEndSmoothing'),
    'TFrmSettings.sGroupBox23': bool('config.overlayActive'),
    'TFrmSettings.sFilenameEdit4': act(() => app.pickOverlay()),
    'TFrmSettings.sSpinEdit32': pointItem('config.overlayPt', 0), 'TFrmSettings.sSpinEdit33': pointItem('config.overlayPt', 1),
    'TFrmSettings.sCheckBox33': bool('config.bgHDRGlobeLighting'),
    'TFrmSettings.sDecimalSpinEdit4': num('config.bgDiffuseExp', 1, { min: 1, max: 40 }),
    'TFrmSettings.sDecimalSpinEdit5': num('config.bgDiffuseIntensity', 1, { min: 0, max: 20 }),
    'TFrmSettings.sDecimalSpinEdit6': num('config.bgSpecularIntensity', 1, { min: 0, max: 20 }),
    'TFrmSettings.sDecimalSpinEdit7': num('config.bgSpecularExp', 1, { min: 1, max: 40 }),
    'TFrmSettings.sDecimalSpinEdit8': num('config.bgHDRDivisor', 1, { min: 0.1, max: 70 }),
    'TFrmSettings.sRadioButton19': radio('config.bgLightCenter', true), 'TFrmSettings.sRadioButton20': radio('config.bgLightCenter', false),
    'TFrmSettings.sDecimalSpinEdit10': num('config.bgLightPointX', 1, { min: 0, max: 1, step: 0.01 }),
    'TFrmSettings.sDecimalSpinEdit11': num('config.bgLightPointY', 1, { min: 0, max: 1, step: 0.01 }),
    'TFrmSettings.sSpeedButton13': act(() => app.startMeasure('light'), () => app.tool === 'light'),
    'TFrmSettings.sCheckBox52': bool('config.bgLightCenterZoomForce'),
    'TFrmSettings.sDecimalSpinEdit12': num('config.bgLightCenterZoomForceLevel', 1, { min: 0, max: 1000 }),
    'TFrmSettings.sTrackBar10': num('config.bgBrightness', 100), 'TFrmSettings.sTrackBar8': num('config.bgSaturation', 100), 'TFrmSettings.sTrackBar9': num('config.bgContrast', 100),
    'TFrmSettings.sTrackBar11': num('config.bgWELDBrightness', 100), 'TFrmSettings.sTrackBar12': num('config.bgWELDSaturation', 100), 'TFrmSettings.sTrackBar13': num('config.bgWELDContrast', 100),
    'TFrmSettings.sTrackBar16': num('config.bgNAIPBrightness', 100), 'TFrmSettings.sTrackBar15': num('config.bgNAIPSaturation', 100), 'TFrmSettings.sTrackBar14': num('config.bgNAIPContrast', 100),
    'TFrmSettings.sSpeedButton16': act(() => settings.set('config.bgLightCenterZoomForceLevel', app.renderer.camera.cur.z)),
    'TFrmSettings.sSpeedButton18': act(() => { for (const k of ['bgBrightness', 'bgContrast', 'bgSaturation', 'bgWELDBrightness', 'bgWELDContrast', 'bgWELDSaturation', 'bgNAIPBrightness', 'bgNAIPContrast', 'bgNAIPSaturation', 'bgDiffuseExp', 'bgDiffuseIntensity', 'bgSpecularRadius', 'bgSpecularExp', 'bgSpecularIntensity', 'bgHDRDivisor']) settings.reset('config.' + k); }),
    'TFrmSettings.sSpeedButton20': act(() => copyRow('', ['WELD', 'NAIP'])),
    'TFrmSettings.sSpeedButton21': act(() => copyRow('WELD', ['', 'NAIP'])),
    'TFrmSettings.sSpeedButton22': act(() => copyRow('NAIP', ['', 'WELD'])),
    'TFrmSettings.sSpeedButton19': act(() => app.dialog('TFrmTerrain')),
    'TFrmSettings.sCheckBox32': bool('config.terrainMotionReduceDensity'),
    'TFrmSettings.sSpinEdit25': num('config.terrainMotionReduceDensityAmount', 1, { min: 10, max: 150 }),
    'TFrmSettings.sTrackBar17': num('config.bgTileDensity'),
    'TFrmSettings.sRadioButton7': bool('config.bgCustom'),
    'TFrmSettings.sRadioButton6': radio('config.bgCustom', false),
    // Custom background: an image plus its world file (geographic degrees), stored locally; drawn when selected.
    'TFrmSettings.sFilenameEdit2': custom(() => settings.str('ext.config.bgCustomImage'), () => void app.pickCustomBackground('image')),
    'TFrmSettings.sFilenameEdit3': custom(() => settings.str('ext.config.bgCustomWorldFile'), () => void app.pickCustomBackground('world')),
    'TFrmSettings.sComboBox6': combo('config.bgNationalMode'), 'TFrmSettings.sComboBox7': combo('config.bgRegionalMode'), 'TFrmSettings.sComboBox8': combo('config.bgLocalMode'),
    'TFrmSettings.sEdit9': na('window size is controlled by the browser'), 'TFrmSettings.sEdit10': na('window size is controlled by the browser'),
    // One FPS target (0 = unlimited, the default); the idle and loop limits can only lower it (0 = follow the target).
    'TFrmSettings.sGroupBox13': status(() => 'FPS limits (0 = unlimited)'),
    'TFrmSettings.sLabelFX13': status(() => 'Target'),
    'TFrmSettings.sLabelFX7': status(() => 'Idle'),
    'TFrmSettings.sLabelFX12': status(() => 'Loop'),
    'TFrmSettings.sSpinEdit24': num('config.generalActiveFPS', 1, { min: 0, max: 255 }),
    'TFrmSettings.sSpinEdit3': num('config.generalRestingFPS', 1, { min: 0, max: 255 }),
    'TFrmSettings.sSpinEdit22': num('config.generalRestingFPSLoop', 1, { min: 0, max: 255 }),
    'TFrmSettings.sCheckBox6': bool('config.videoDisableRAMPunishments'),
    'TFrmSettings.sBadgeBtn1': act(() => app.toast('Memory limits follow the L2/L3 frame counts.')),
    'TFrmSettings.sCheckBox26': bool('config.generalShowPerfMetrics'),
    'TFrmSettings.sCheckBox48': bool('config.dualmActivated'),
    'TFrmSettings.sSpinEdit9': num('config.dualmIdx', 1, { min: 1, max: 50 }),
    'TFrmSettings.sComboBox1': combo('config.graphicsSwapchain.SwapMode'),
    'TFrmSettings.sBadgeBtn2': act(() => app.toast('WebGPU presents through the browser compositor; swap mode is stored only.')),
    'TFrmSettings.sCheckBox24': bool('config.graphicsSwapchain.WaitForVBLANK'),
    'TFrmSettings.sCheckBox27': bool('config.graphicsSwapchain.WaitableSwapchain'),
    'TFrmSettings.sComboBox2': combo('config.graphicsSwapchain.Backbuffers', [1, 2, 3]),
    'TFrmSettings.sComboBox3': combo('config.graphicsSwapchain.SyncInterval', [0, 1]),
    'TFrmSettings.sCheckBox28': bool('config.graphicsSwapchain.ThreadedRender'),
    'TFrmSettings.sBadgeBtn3': act(() => app.toast('Decoding runs in workers; rendering is single-queue WebGPU.')),
    'TFrmSettings.sComboBox4': combo('config.graphicsSwapchain.MaxFrameLatency', [1, 2, 3]),
    'TFrmSettings.sButton5': act(() => app.closeDialog('TFrmSettings')),
    'TFrmSettings.sButton8': act(() => app.cancelSettings()),
    'TFrmSettings.sButton9': act(() => app.applySettings()),
    'TFrmSettings.sSpeedButton3': alpha('settings.modelFillAlpha'),
    // The browser has no configuration directory: the button reloads the configurations and imports *.config files.
    'TFrmSettings.sSpeedButton4': act(() => app.reloadModelConfigs()),
    'TFrmSettings.sSpinEdit28': num('settings.modelLoopBase'), 'TFrmSettings.sSpinEdit29': num('settings.modelLoopPerFrame'), 'TFrmSettings.sSpinEdit30': num('settings.modelLoopEndDelay'),
    'TFrmSettings.sCheckBox23': bool('settings.modelFillLegend'),
  };

  const terrain: BindingMap = {
    'TFrmTerrain.sSpeedButton1': act(() => app.toast('Texture compression is a GPU-memory option of the original; stored only.')),
    'TFrmTerrain.sCheckBox2': bool('config.terrainDXTOptimize'),
    'TFrmTerrain.sCheckBox11': custom(() => settings.num('config.terrainOceanOnlyHeight') >= 0, (v) => settings.set('config.terrainOceanOnlyHeight', v ? 4 : -1)),
    'TFrmTerrain.sSpinEdit1': custom(() => Math.max(1, settings.num('config.terrainOceanOnlyHeight')), (v) => settings.set('config.terrainOceanOnlyHeight', Number(v))),
    'TFrmTerrain.sGroupBox3': bool('config.latlonLinesOn'),
    'TFrmTerrain.sDecimalSpinEdit2': num('config.latlonLinesWidth', 1, { min: 0.1, max: 5, step: 0.05 }),
    'TFrmTerrain.sColorSelect3': color('config.latlonLinesColor'),
    'TFrmTerrain.sCheckBox10': bool('config.latlonLinesSecondary'),
    'TFrmTerrain.sSpinEdit2': num('config.latlonLinesDensity', 1, { min: 5, max: 300 }),
    'TFrmTerrain.sCheckBox12': bool('config.latlonLinesOceanOnly'),
    'TFrmTerrain.sDecimalSpinEdit1': num('config.latlonLinesAlpha', 1, { min: 0.01, max: 1, step: 0.01 }),
    'TFrmTerrain.sRadioButton3': radio('config.latlonLinesColorAdd', true), 'TFrmTerrain.sRadioButton4': radio('config.latlonLinesColorAdd', false),
    'TFrmTerrain.sComboBox1': combo('config.terrainShading'),
    'TFrmTerrain.sTrackBar1': num('ext.config.terrainShadeDepth', 1, { min: 0, max: 900 }),
    'TFrmTerrain.sTrackBar2': num('config.terrainFixedLightAzimuth'),
    'TFrmTerrain.sTrackBar5': num('ext.config.terrainHighlightBrightness', 1, { min: 0, max: 450 }),
    'TFrmTerrain.sRadioButton1': radio('config.terrainFixedZenith', false), 'TFrmTerrain.sRadioButton2': radio('config.terrainFixedZenith', true),
    'TFrmTerrain.sTrackBar3': num('config.terrainFixedLightZenith', 10),
    'TFrmTerrain.sSpeedButton2': pal('config.terrainHypsometricTintPalette', 'Terrain'),
    'TFrmTerrain.sCheckBox1': bool('config.terrainHypsometricTintingBeforeLighting'),
    'TFrmTerrain.sCheckBox4': bool('config.terrainHypsometricTinting'),
    'TFrmTerrain.sCheckBox5': bool('config.terrainHypsometricDynamicRange'),
    'TFrmTerrain.sTrackBar4': num('config.terrainHypsometricDynamicRangeRescaleSpeed'),
    'TFrmTerrain.sColorSelect2': color('config.terrainOceanColor'),
    'TFrmTerrain.sCheckBox3': bool('config.terrainOcean'),
    'TFrmTerrain.sComboBox3': combo('config.terrainCoastlineShadowMode'),
    'TFrmTerrain.sDecimalSpinEdit3': num('config.terrainCoastlineShadowExponent', 1, { min: 0.01, max: 2, step: 0.05 }),
    'TFrmTerrain.sColorSelect1': color('config.terrainCoastlineShadowColor'),
    'TFrmTerrain.sDecimalSpinEdit4': num('config.terrainOceanLightingHighlight', 1, { min: 0.1, max: 1, step: 0.05 }),
    'TFrmTerrain.sDecimalSpinEdit5': num('config.terrainOceanCoefficient', 1, { min: 0.1, max: 1, step: 0.05 }),
    'TFrmTerrain.sCheckBox8': bool('config.terrainOceanWaterLightWave'),
    'TFrmTerrain.sCheckBox7': bool('config.terrainOceanPerformanceWater'),
    'TFrmTerrain.sCheckBox9': bool('config.terrainOceanConstrainWaterToLightInverse'),
    'TFrmTerrain.sCheckBox6': bool('config.terrainOceanConstrainWaterToLight'),
    'TFrmTerrain.sComboBox2': combo('config.terrainOceanMode'),
  };

  let roadSel = -1;
  const roads: BindingMap = {
    'TFrmRoadsControl.sCheckBox1': bool('config.geoRoadsInterstates'),
    // US primary roads are prebuilt (npm run gis): Remove hides them, Download restores them.
    'TFrmRoadsControl.sButton1': act(() => { app.roads.setPrimaryRemoved(false); app.toast('US primary roads restored (prebuilt TIGER/Line 2021 set)'); }),
    'TFrmRoadsControl.sSpeedButton1': act(() => app.roads.setPrimaryRemoved(true)),
    'TFrmRoadsControl.sCheckBox2': bool('config.geoRoadsSecondary'),
    'TFrmRoadsControl.sListBox1': { kind: 'list', items: () => app.secondaryStates.map((label) => ({ label })), selected: () => roadSel, select: (i) => { roadSel = i; } },
    'TFrmRoadsControl.sComboBox2': custom(() => app.roadState, (i) => (app.roadState = Number(i))),
    'TFrmRoadsControl.sBitBtn1': act(() => app.downloadSecondaryRoads()),
    // Remove: the selected state's secondary roads (all when none is selected).
    'TFrmRoadsControl.sSpeedButton3': act(() => { const l = app.secondaryStates[roadSel]; app.removeRoads('state', l); roadSel = -1; }),
    'TFrmRoadsControl.sCheckBox3': bool('config.geoRoadsLocal'),
    // County local streets (TIGER/Line 2021 ROADS per county, with street names for road-name labeling);
    // double-click a downloaded county to remove it.
    'TFrmRoadsControl.sListBox2': { kind: 'list', items: () => app.countyStreets.map((label) => ({ label })), selected: () => -1, select: (i, dbl) => { if (dbl) app.removeRoads('county', app.countyStreets[i]); } },
    'TFrmRoadsControl.sComboBox1': custom(() => app.countyState, (i) => { app.countyState = Number(i); app.loadCounties().catch((e) => app.toast(`County list: ${(e as Error).message}`)); }),
    'TFrmRoadsControl.sComboBox3': custom(() => app.countyIdx, (i) => { app.countyIdx = Number(i); }, () => (app.counties.length ? app.counties.map((c) => c.name) : ['(pick a state first)'])),
    'TFrmRoadsControl.sBitBtn2': act(() => { if (!app.counties.length) app.loadCounties().then(() => app.toast('County list loaded; pick a county'), (e) => app.toast(`County list: ${(e as Error).message}`)); else app.downloadCountyStreets(); }),
    'TFrmRoadsControl.sSpeedButton9': act(() => app.dialog('TFrmRoadSigns')),
    'TFrmRoadsControl.sSpeedButton2': act(() => app.editStyle(ROAD_STYLES[0], 'Interstates')), 'TFrmRoadsControl.sSpeedButton4': act(() => app.editStyle(ROAD_STYLES[1], 'U.S. Highways')),
    'TFrmRoadsControl.sSpeedButton5': act(() => app.editStyle(ROAD_STYLES[2], 'State Highways')), 'TFrmRoadsControl.sSpeedButton7': act(() => app.editStyle(ROAD_STYLES[3], 'Streets')), 'TFrmRoadsControl.sSpeedButton8': act(() => app.editStyle(ROAD_STYLES[4], 'Ramps')),
  };
  const signs: BindingMap = {
    'TFrmRoadSigns.sCheckBox1': bool('config.geoInterstateLabels'), 'TFrmRoadSigns.sCheckBox2': bool('config.geoUSRouteLabels'), 'TFrmRoadSigns.sCheckBox3': bool('config.geoStateRouteLabels'),
    'TFrmRoadSigns.sTrackEdit3': num('config.geoInterstateLabelsAlpha', 255, { min: 0, max: 255 }), 'TFrmRoadSigns.sTrackEdit1': num('config.geoUSRouteLabelsAlpha', 255, { min: 0, max: 255 }), 'TFrmRoadSigns.sTrackEdit2': num('config.geoStateRouteLabelsAlpha', 255, { min: 0, max: 255 }),
    'TFrmRoadSigns.sComboBox1': combo('config.geoInterstateLabelsDensity'), 'TFrmRoadSigns.sComboBox2': combo('config.geoUSRouteLabelsDensity'), 'TFrmRoadSigns.sComboBox3': combo('config.geoStateRouteLabelsDensity'),
    'TFrmRoadSigns.sCheckBox4': bool('config.geoInterstateLabelsEffect'),
  };

  const mapModes: BindingMap = {
    'TFrmMapModes.mapStyles': { kind: 'list', items: () => mapStyles.list.map((s) => ({ label: s.name })), selected: () => -1, select: (i, dbl) => { if (dbl) mapStyles.apply(i); } },
    'TFrmMapModes.sBitBtn5': act(async () => { const n = await app.prompt('Map Style', 'Name of the new map style:'); if (n) mapStyles.saveCurrent(n); }),
  };
  let presetSel = -1, layerPresetSel = -1;
  const scene: BindingMap = {
    'TFrmMapPresets.sListBox1': { kind: 'list', items: () => scenePresets.list.map((p, i) => ({ label: `${i < 12 ? `Alt+F${i + 1}  ` : ''}${p.name}` })), selected: () => presetSel, select: (i, dbl) => { presetSel = i; if (dbl) app.applyScene(i); } },
    'TFrmMapPresets.sSpeedButton1': act(() => app.applyScene(presetSel)),
    'TFrmMapPresets.sSpeedButton3': act(() => app.saveScene()),
    'TFrmMapPresets.sSpeedButton4': act(() => { if (presetSel >= 0) scenePresets.remove(presetSel); presetSel = -1; }),
  };
  [1, 2, 3, 4, 5, 6, 7, 8].forEach((k) => (scene[`TFrmMapPresets.sCheckBox${k}`] = custom(() => sceneMask.list[k - 1], (v) => setSceneMask(k - 1, !!v))));
  const layerP: BindingMap = {
    'TFrmLayerPresets.sListBox1': { kind: 'list', items: () => layerPresets.list.map((p) => ({ label: p.name })), selected: () => layerPresetSel, select: (i, dbl) => { layerPresetSel = i; if (dbl) layerPresets.apply(i); } },
    'TFrmLayerPresets.sSpeedButton1': act(() => layerPresets.apply(layerPresetSel)),
    'TFrmLayerPresets.sSpeedButton3': act(async () => { const n = await app.prompt('Layer Preset', 'Name of the new layer preset:'); if (n) layerPresets.add(n); }),
    'TFrmLayerPresets.sSpeedButton4': act(() => { if (layerPresetSel >= 0) layerPresets.remove(layerPresetSel); layerPresetSel = -1; }),
  };
  const palSel: BindingMap = {
    'TFrmPaletteSelector.sPalBtn': status(() => app.palTarget ? (app.palTarget.get() || 'Layer empty') : 'Layer empty'),
    'TFrmPaletteSelector.sLabelFX1': status(() => `Current: ${app.palTarget?.label ?? ''}`),
    'TFrmPaletteSelector.sSpeedButton1': act(() => app.closeDialog('TFrmPaletteSelector')),
    'TFrmPaletteSelector.sUpDown1': custom(() => paletteNames().indexOf(app.palTarget?.get() ?? ''), (v) => { const names = paletteNames(); const i = ((Number(v) % names.length) + names.length) % names.length; app.palTarget?.set(names[i]); }),
  };
  const alphaSel: BindingMap = {
    'TFrmAlphaSelector.sLabelFX1': status(() => `Alpha: ${Math.round(((app.alphaTarget?.get() ?? 255) / (app.alphaTarget?.max ?? 255)) * 100)}%`),
    'TFrmAlphaSelector.alphaSlider': custom(() => Math.round(((app.alphaTarget?.get() ?? 255) / (app.alphaTarget?.max ?? 255)) * 255), (v) => app.alphaTarget?.set((Number(v) / 255) * (app.alphaTarget.max))),
    'TFrmAlphaSelector.sSpeedButton1': act(() => app.closeDialog('TFrmAlphaSelector')),
  };
  const spatial: BindingMap = {
    'TFrmSpatialTools.sBitBtn1': act(() => app.startMeasure('line'), () => app.tool === 'line'),
    'TFrmSpatialTools.sBitBtn3': act(() => app.startMeasure('path'), () => app.tool === 'path'),
    'TFrmSpatialTools.sCheckBox2': bool('config.distanceMeasureImperial'),
    // Road Name Labeling (Alt+L): names of downloaded TIGER roads; mode 0 rollover, 1 placed labels, 2 both.
    'TFrmSpatialTools.sCheckBox1': custom(() => settings.bool('config.roadLabelWorld'), (v) => { settings.set('config.roadLabelWorld', !!v); app.roads.rebuildLabels(); }),
    'TFrmSpatialTools.sRadioButton1': radio('config.roadLabelMode', 0), 'TFrmSpatialTools.sRadioButton2': radio('config.roadLabelMode', 1), 'TFrmSpatialTools.sRadioButton3': radio('config.roadLabelMode', 2),
    'TFrmSpatialTools.sSpeedButton4': act(() => app.toggleRoadNaming(), () => app.roadNaming),
    'TFrmSpatialTools.sSpeedButton5': act(() => app.clearRoadLabels()),
    'TFrmSpatialTools.sSpeedButton6': act(() => app.editText('RoadLabels', 'font')), 'TFrmSpatialTools.sSpeedButton7': act(() => app.editText('RoadLabels', 'appearance')),
  };
  const gisdl: BindingMap = {
    'TFrmGISDownload.sBitBtn4': act(() => app.toast('GIS layers are prebuilt from public sources: run "npm run gis".')),
    'TFrmGISDownload.sSpeedButton1': act(() => app.reloadGis()),
    'TFrmGISDownload.sCheckBox1': bool('config.geoShowDownloader'),
  };
  const shp: BindingMap = {
    'TFrmShapefiles.sBitBtn4': act(() => app.addShapefile()),
    'TFrmShapefiles.sFilenameEdit4': act(() => app.addShapefile()),
    'TFrmShapefiles.sListBox2': { kind: 'list', items: () => app.userShapes.items.map((s) => ({ label: `${s.visible ? '' : '(hidden) '}${s.name}` })), selected: () => app.userShapes.selected, select: (i) => (app.userShapes.selected = i) },
    'TFrmShapefiles.sBitBtn6': act(() => app.removeShapefile()),
    'TFrmShapefiles.sBitBtn5': act(() => { const s = app.userShapes.items[app.userShapes.selected]; if (s) app.editStyle(app.userShapes.styleName(s), s.name); else app.toast('Select a shapefile layer first'); }),
    // Up/down arrows move the selected layer in the draw order.
    'TFrmShapefiles.sUpDown1': custom(() => app.userShapes.selected, (v: number) => { const i = app.userShapes.selected; if (i >= 0) app.userShapes.move(i, v > i ? 1 : -1); }),
    'TFrmShapefiles.sSlider1': custom(() => app.userShapes.items[app.userShapes.selected]?.visible ?? false, (v) => app.userShapes.setVisible(app.userShapes.selected, !!v)),
  };
  // Shapefile extractor: field = value selection and export as a zipped shapefile.
  const ex = { name: '', layers: [] as { name: string; features: { kind: string; attrs: Record<string, unknown>; parts: number[][]; tris?: number[] }[] }[], fields: [] as string[], field: -1, values: [] as string[], value: -1, picked: [] as { kind: string; attrs: Record<string, unknown>; parts: number[][] }[] };
  const shpExtract: BindingMap = {
    'TFrmShapefileExtract.SHPPath': custom(() => ex.name, async (url: string) => { const r = await fetch(url); const b = new Uint8Array(await r.arrayBuffer()); ex.name = 'shapefile.zip'; ex.layers = await decodeUser(ex.name, b); ex.fields = []; ex.values = []; ex.picked = []; app.toast(`${ex.layers.reduce((n, l) => n + l.features.length, 0)} shapes loaded`); }),
    'TFrmShapefileExtract.sBitBtn1': act(() => { ex.fields = [...new Set(ex.layers.flatMap((l) => l.features.flatMap((f) => Object.keys(f.attrs))))]; ex.field = -1; if (!ex.fields.length) app.toast('Select a shapefile first (step 1)'); }),
    'TFrmShapefileExtract.sListBox2': { kind: 'list', items: () => (ex.fields.length ? ex.fields.map((label) => ({ label })) : [{ label: '[No fields loaded yet]', disabled: true }]), selected: () => ex.field, select: (i) => { ex.field = i; const k = ex.fields[i]; ex.values = [...new Set(ex.layers.flatMap((l) => l.features.map((f) => String(f.attrs[k] ?? ''))))].sort().slice(0, 5000); ex.value = -1; } },
    'TFrmShapefileExtract.sListBox3': { kind: 'list', items: () => (ex.values.length ? ex.values.map((label) => ({ label })) : [{ label: '[Waiting for field selection]', disabled: true }]), selected: () => ex.value, select: (i) => { ex.value = i; } },
    'TFrmShapefileExtract.sBitBtn2': act(() => { const k = ex.fields[ex.field], v = ex.values[ex.value]; if (k === undefined || v === undefined) { app.toast('Choose a field and a value'); return; } ex.picked = ex.layers.flatMap((l) => l.features.filter((f) => String(f.attrs[k] ?? '') === v)); app.toast(`${ex.picked.length} shapes match ${k} = ${v}`); }),
    'TFrmShapefileExtract.sBitBtn3': act(() => { if (!ex.picked.length) { app.toast('Extract shapes first (step 3)'); return; } const base = `extract_${ex.fields[ex.field]}_${ex.values[ex.value]}`.replace(/[^\w.-]+/g, '_'); const z = writeShapefileZip(base, ex.picked as never); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([z as BlobPart], { type: 'application/zip' })); a.download = `${base}.zip`; a.click(); }),
  };

  // Sidebar panels
  const contour: BindingMap = {
    'TContourBarPanel.sSpinEdit1': num('settings.generalMSLPContourInterval', 1, { min: 1, max: 10 }),
    'TContourBarPanel.sSpinEdit2': num('settings.generalHeightContourInterval', 1, { min: 1, max: 200 }),
    'TContourBarPanel.sColorSelect1': color('settings.generalContourColor'),
    'TContourBarPanel.sColorSelect2': color('settings.generalContourBorderColor'),
    'TContourBarPanel.sCheckBox1': bool('settings.generalContourBorders'),
    'TContourBarPanel.sTrackBar1': num('settings.generalContourAlpha', 100),
    'TContourBarPanel.sTrackBar2': num('settings.generalContourWidth', 100),
    'TContourBarPanel.sTrackBar3': num('settings.generalContourKernel', 100),
  };
  const vectorBar: BindingMap = {};
  // Vector Field panel: applies to model vector layers (Model tab); 0 Text, 1 Barbs, 2 Text vectors, 3 Vectors 1, 4 Vectors 2.
  vectorBar['TVectorBarPanel.sRadioButton1'] = radio('ext.config.vectorFieldType', 0);
  vectorBar['TVectorBarPanel.sRadioButton5'] = radio('ext.config.vectorFieldType', 1);
  vectorBar['TVectorBarPanel.sRadioButton4'] = radio('ext.config.vectorFieldType', 2);
  vectorBar['TVectorBarPanel.sRadioButton3'] = radio('ext.config.vectorFieldType', 3);
  vectorBar['TVectorBarPanel.sRadioButton8'] = radio('ext.config.vectorFieldType', 4);
  vectorBar['TVectorBarPanel.sCheckBox1'] = bool('ext.config.vectorFieldColored');
  vectorBar['TVectorBarPanel.sCheckBox2'] = bool('ext.config.vectorFieldScaled');
  vectorBar['TVectorBarPanel.sTrackBar1'] = num('ext.config.vectorFieldSpacing');
  vectorBar['TVectorBarPanel.sTrackBar2'] = num('ext.config.vectorFieldSize');
  let vpSel = -1;
  const views: BindingMap = {
    'TPresetViewsPanel.sViews': { kind: 'list', items: () => [{ label: 'Default View' }, ...viewpoints.list.map((v) => ({ label: v.name }))], selected: () => vpSel, select: (i) => { vpSel = i; app.flyToViewpoint(i); } },
    'TPresetViewsPanel.sSpeedButton1': act(async () => { const n = await app.prompt('Viewpoint', 'Name of the new viewpoint:'); if (n) viewpoints.add(n, app.renderer.camera.target); }),
    'TPresetViewsPanel.sBitBtn1': act(() => { if (vpSel > 0) viewpoints.remove(vpSel - 1); vpSel = -1; }),
  };
  const order: BindingMap = {
    'TOrderPanel.slb': { kind: 'list', items: () => [...layerOrder.list].reverse().map((id) => ({ label: app.layerTitle(id) })), selected: () => app.orderSel, select: (i, dbl) => { app.orderSel = i; if (dbl) app.moveLayer(i); } },
  };
  const play: BindingMap = {
    'TViewsPlaythroughPanel.sSpeedButton1': act(() => app.toggleViewPlay(), () => app.viewPlaying, () => (app.viewPlaying ? '⏸' : '▶')),
    'TViewsPlaythroughPanel.sLabel2': status(() => (app.viewPlaying ? 'Playing...' : 'Paused.')),
    'TViewsPlaythroughPanel.sDecimalSpinEdit1': num('config.generalViewPlayInterval', 1, { min: 0.5, step: 0.5 }),
  };
  const stamps: BindingMap = {
    'TTimestampsPanel.sCheckBox1': bool('ext.layerState.TimestampMain'),
    'TTimestampsPanel.sCheckBox2': bool('settings.modelTimestamp'),
  };
  const tracking: BindingMap = { 'TStormTrackingPanel.sSpeedButton1': act(() => app.dialog('TFrmManualTracksControl')) };

  // Style editors and other dialogs that are not part of the catalog-backed settings.
  const naForm = (form: string, reason: Binding): BindingMap => {
    const m: BindingMap = {};
    for (const c of formDef(form).controls) if (!c.nonvisual) m[c.id.replace(/^ui\./, '')] = reason;
    return m;
  };

  function effective2() { const v = settings.num('settings.nexradL2DataSource'); return v !== 3 && !(v === 4 && settings.str('settings.nexradL2CustomDataSource').trim()); }
  function copyRow(from: string, to: string[]) { for (const t of to) for (const k of ['Brightness', 'Contrast', 'Saturation']) settings.set(`config.bg${t}${k}`, settings.num(`config.bg${from}${k}`)); }

  return {
    TBasicLayersFrame: basic, TRadarUIFrame: radarFrame, TFrmRadarControl: radarControl, TFrmLevel2AlgorithmSettings: l2algo,
    TFrmStormMotionVectorControl: motion, TFrmPrecipTypingControl: ptype, TFrmRadarSiteLabels: sites, TFrmSCITControl: scit,
    TFrmManualTracksControl: manual, TFrmGLMControl: glm, TFrmGLMTiltStrikes: glm, TFrmGOESExtended: goesExt, TFrmGOESMultispectralRGB: rgb,
    TFrmWarningControl: warn, TFrmWarningsList: warnList('warnings'), TFrmWatchesList: warnList('watches'), TFrmMap: timelineBlock,
    TFrmSettings: settingsDlg, TFrmTerrain: terrain, TFrmRoadsControl: roads, TFrmRoadSigns: signs, TFrmMapModes: mapModes,
    TFrmMapPresets: scene, TFrmLayerPresets: layerP, TFrmPaletteSelector: palSel, TFrmAlphaSelector: alphaSel, TFrmSpatialTools: spatial,
    TFrmGISDownload: gisdl, TFrmShapefiles: shp, TContourBarPanel: contour, TVectorBarPanel: vectorBar, TPresetViewsPanel: views,
    TOrderPanel: order, TViewsPlaythroughPanel: play, TTimestampsPanel: stamps, TStormTrackingPanel: tracking,
    TFrmShapefileExtract: shpExtract,
    TFrmPlacefiles: placefiles(app),
    TFrmNEXRADFilterSelect: naForm('TFrmNEXRADFilterSelect', na('Unused form of the original; Smoothing is the only filter control')),
    TFrmNEXRADL2: naForm('TFrmNEXRADL2', na('developer/diagnostic form of the original')),
  };
}

const fmt = (v: number) => (v === v ? v.toFixed(0) : '-');
export const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Large-text viewer (TFrmStringDisplay): memo, character/line counts and Close. */
export function stringDisplayBindings(text: () => string, close: () => void): BindingMap {
  return {
    'TFrmStringDisplay.Memo1': status(text),
    'TFrmStringDisplay.Label1': status(() => `Character Count: ${text().length}`),
    'TFrmStringDisplay.Label2': status(() => `Line Count: ${text().split('\n').length}`),
    'TFrmStringDisplay.Button1': act(close),
  };
}

/** Grows or shrinks a named text style by one point (bounded 6–72). */
function scaleTextStyle(name: string, step: number) {
  const t = textStyle(name);
  t.size = Math.max(6, Math.min(72, t.size + step));
  setTextStyle(name, t);
}
