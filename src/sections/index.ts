// Expanded ribbon sections: each contributes map layers, the settings prefixes that reload them,
// and control bindings for its 780×130 frame and dialogs. Frames are rendered from UI catalog.
import type { App } from '../app/app';
import type { Renderer } from '../render/renderer';
import type { MapLayer } from '../layers/base';
import type { BindingMap, Binding } from '../ui/form';
import type { GlyphAtlas } from '../render/prims';
import { settings } from '../settings/store';
import { MrmsLayer, MRMS } from './mrms';
import { ProbSevereLayer } from './probsevere';
import { OutlookLayer, MdLayer, LsrLayer, AdvisoryLayer, familiesForDay, normalizeFamily, LSR_TYPES, advisoryStyles, saveAdvisoryStyles, eventColor } from './nwsspc';
import type { MenuAction } from '../ui/dialogs';
import { pool } from '../workers/pool';
import { MetarLayer, MarineLayer, loadBuoy, type BuoyData } from './surface';
import { MesoLayer, SevereLayer, DiffLayer, MESO } from './meso';
import { forecastLayers, miscLayers } from './forecast-misc';
import { NdfdLayer, WinterLayer, NDFD, WINTER_LEVELS, winterEndHours } from './ndfd-winter';
import { TropicalLayer } from './tropical';
import { ModelLayer, CUSTOM_CAPTION } from './model';
import { prefObject } from '../app/persist';

export interface SectionCtx { r: Renderer; atlas: GlyphAtlas }
export interface Section {
  tab: string; frame: string;
  layers: MapLayer[];
  /** Settings ID prefixes whose change reloads the section's layers. */
  watch: string[];
  bindings(app: App): Record<string, BindingMap>;
  /** Run-time UI that is not in the DFM (e.g. the Winter end-period selector). */
  decorate?(frame: HTMLElement, app: App): void;
}

export const bool = (id: string): Binding => ({ kind: 'bool', id });
export const act = (run: (el: HTMLElement) => void, down?: () => boolean, caption?: () => string, disabled?: () => boolean): Extract<Binding, { kind: 'action' }> => ({ kind: 'action', run, down, caption, disabled });
export const status = (fn: () => string): Binding => ({ kind: 'status', text: fn });
export const toggle = (id: string) => act(() => settings.set(id, !settings.bool(id)), () => settings.bool(id));
export const radio = (id: string, value: unknown): Binding => ({ kind: 'radio', id, value });
export const combo = (id: string, values?: unknown[]): Binding => ({ kind: 'combo', id, values });
export const custom = (get: () => unknown, set: (v: any) => void, items?: () => string[], disabled?: () => boolean): Binding => ({ kind: 'custom', get, set, items, disabled });

function mrmsSection(c: SectionCtx): Section {
  const layer = new MrmsLayer(c.r);
  const ps = new ProbSevereLayer(c.r, c.atlas);
  const cats = () => [...new Set(MRMS.map((p) => p.category))];
  const cur = () => layer.product();
  const inCat = () => MRMS.filter((p) => p.category === cur().category);
  return {
    tab: 'MRMS', frame: 'TMRMSLayersFrame', layers: [layer, ps], watch: ['layerState.MRMS', 'settings.mrms', 'ext.settings.mrms', 'ext.layerState.ProbSevere'],
    bindings: (app) => ({
      TMRMSLayersFrame: {
        'TMRMSLayersFrame.sSlider1': bool('layerState.MRMSOn'),
        'TMRMSLayersFrame.sLabelFX1': toggle('layerState.MRMSOn'),
        'TMRMSLayersFrame.MRMSSelector': { kind: 'list', items: () => cats().map((label) => ({ label })), selected: () => cats().indexOf(cur().category), select: (i) => { const p = MRMS.find((x) => x.category === cats()[i]); if (p) settings.set('layerState.MRMSProdIdx', p.index); } },
        'TMRMSLayersFrame.MRMSProductsUI': { kind: 'list', items: () => inCat().map((p) => ({ label: p.label })), selected: () => inCat().findIndex((p) => p.index === cur().index), select: (i) => { const p = inCat()[i]; if (p) settings.set('layerState.MRMSProdIdx', p.index); } },
        'TMRMSLayersFrame.sSpeedButton2': act(() => (layer.typed() ? app.dialog('TFrmPrecipTypingControl') : app.paletteSelector(cur().palette, cur().label))),
        'TMRMSLayersFrame.sSpeedButton1': act(() => app.alphaSelector('settings.mrmsFillAlpha')),
        'TMRMSLayersFrame.sCheckBox1': bool('settings.mrmsFillSmoothing'),
        'TMRMSLayersFrame.sCheckBox2': bool('settings.mrmsLegend'),
        'TMRMSLayersFrame.mapMode0': toggle('settings.mrmsPrecipTyping'),
        'TMRMSLayersFrame.sBitBtn1': toggle('settings.mrmsTimelineConstrain'),
        'TMRMSLayersFrame.sLabelFX2': status(() => layer.statusText),
        'TMRMSLayersFrame.psLabel': toggle('ext.layerState.ProbSevereOn'),
        'TMRMSLayersFrame.psType': combo('ext.settings.probSevereType'),
        'TMRMSLayersFrame.psOptions': act(() => app.dialog('TFrmProbSevere')),
      },
      TFrmProbSevere: {
        'TFrmProbSevere.cbType': combo('ext.settings.probSevereType'),
        'TFrmProbSevere.mmStatus': status(() => ps.statusText().replace(/; /g, '\n')),
      },
    }),
  };
}

function nwsSection(c: SectionCtx): Section {
  const co = new OutlookLayer(c.r, c.atlas), md = new MdLayer(c.r, c.atlas), lsr = new LsrLayer(c.r, c.atlas), adv = new AdvisoryLayer(c.r, c.atlas);
  const day = () => settings.num('layerState.NWSConvectiveOutlooksDayIdx');
  const fam = () => normalizeFamily(day(), settings.num('layerState.NWSConvectiveOutlooksFamilyIdx'));
  const setFam = (f: number) => { settings.set('layerState.NWSConvectiveOutlooksFamilyIdx', f); settings.set('layerState.NWSConvectiveOutlooksOn', true); };
  // Radios that do not apply to the selected day are hidden; Day 3 relabels Tornado → Probabilistic.
  const famRadio = (f: number, dayKind: 'd12' | 'd3' | 'any'): Binding => ({ kind: 'custom', get: () => fam() === f, set: () => setFam(f),
    hidden: () => !familiesForDay(day()).includes(f) || (dayKind === 'd12' && day() >= 2) || (dayKind === 'd3' && day() < 2) });
  const filterBits = () => settings.str('ini.NWSLocalStormReports.TypeFilter');
  const setBit = (i: number, on: boolean) => { const b = filterBits().split(''); b[i] = on ? '1' : '0'; settings.set('ini.NWSLocalStormReports.TypeFilter', b.join('')); };
  let nwsaSel = -1;
  return {
    tab: 'NWS/SPC', frame: 'TNWSLayersFrame', layers: [co, md, lsr, adv],
    watch: ['layerState.NWSConvectiveOutlooks', 'settings.NWSConvectiveOutlooks', 'layerState.NWSMesoscale', 'settings.NWSMesoscale', 'layerState.NWSLocalStorm', 'settings.NWSLSR', 'ini.NWSLocalStorm', 'layerState.NWSAdvisories', 'settings.NWSAdvisories'],
    bindings: (app) => {
      const coMenu: Record<string, MenuAction> = {
        R1: { run: () => app.textProduct(`SPC Day ${day() + 1} outlook text`, co.textUrl()) },
        S2: { run: () => settings.set('settings.NWSConvectiveOutlooksShowLabels', !settings.bool('settings.NWSConvectiveOutlooksShowLabels')), checked: () => settings.bool('settings.NWSConvectiveOutlooksShowLabels') },
      };
      for (const [k, n] of [['T1', 'TSTM'], ['MRGL1', 'MRGL'], ['S1', 'SLGT'], ['E1', 'ENH'], ['M1', 'MDT'], ['H2', 'HIGH']]) coMenu[k] = { run: () => app.editStyle(`COCat${n}`) };
      for (const [k, n] of [['N51', 5], ['N11', 15], ['N31', 30], ['N41', 45], ['N52', 60]] as const) coMenu[k] = { run: () => app.editStyle(`COWH${n}`) };
      for (const [k, n] of [['N21', 2], ['N53', 5], ['N12', 10], ['N13', 15], ['N01', 30], ['N42', 45], ['N02', 60]] as const) coMenu[k] = { run: () => app.editStyle(`COTorn${n}`) };
      for (const k of ['CIG1', 'CIG2', 'CIG3']) coMenu[k] = { run: () => app.editStyle(`CO${k}`) };
      const mdMenu: Record<string, MenuAction> = {
        MenuItem1: { run: () => { const t = md.texts[0]; if (t) app.textViewer(t.title, md.texts.map((x) => x.text).join('\n\n')); else app.toast('No mesoscale discussion is loaded'); } },
        S3: { run: () => settings.set('settings.NWSMesoscaleDiscussionShowLabels', !settings.bool('settings.NWSMesoscaleDiscussionShowLabels')), checked: () => settings.bool('settings.NWSMesoscaleDiscussionShowLabels') },
        MenuItem2: { run: () => app.editStyle('MDSevere') }, W1: { run: () => app.editStyle('MDWinter') }, H1: { run: () => app.editStyle('MDHeavyRain') },
      };
      return {
        TNWSLayersFrame: {
          'TNWSLayersFrame.sSlider2': bool('layerState.NWSConvectiveOutlooksOn'),
          'TNWSLayersFrame.sLabelFX2': toggle('layerState.NWSConvectiveOutlooksOn'),
          'TNWSLayersFrame.sComboBox1': custom(() => day(), (v: number) => { settings.set('layerState.NWSConvectiveOutlooksDayIdx', v); settings.set('layerState.NWSConvectiveOutlooksFamilyIdx', normalizeFamily(v, settings.num('layerState.NWSConvectiveOutlooksFamilyIdx'))); }),
          'TNWSLayersFrame.cbCOCategorical': famRadio(0, 'any'),
          'TNWSLayersFrame.cbCOTornado': famRadio(1, 'd12'),
          'TNWSLayersFrame.cbCOProbabilistic': famRadio(1, 'd3'),
          'TNWSLayersFrame.cbCOHail': famRadio(2, 'any'),
          'TNWSLayersFrame.cbCOWind': famRadio(3, 'any'),
          'TNWSLayersFrame.pnlCOCIGModes': { kind: 'custom', get: () => 0, set: () => {}, hidden: () => fam() === 0 || day() >= 3 },
          'TNWSLayersFrame.rbCOCIGOverlay': radio('layerState.NWSConvectiveOutlooksCIGMode', 1),
          'TNWSLayersFrame.rbCOCIGOnly': radio('layerState.NWSConvectiveOutlooksCIGMode', 2),
          'TNWSLayersFrame.rbCOCIGOff': radio('layerState.NWSConvectiveOutlooksCIGMode', 0),
          'TNWSLayersFrame.cbCOLayered': bool('layerState.NWSConvectiveOutlooksLayered'),
          'TNWSLayersFrame.COTimeLabel': status(() => co.validText),
          'TNWSLayersFrame.sSpeedButton4': act((el) => app.popup('TNWSLayersFrame', 'PopupMenu1', el, coMenu)),
          'TNWSLayersFrame.sSlider3': bool('layerState.NWSMesoscaleDiscussionsOn'),
          'TNWSLayersFrame.sLabelFX3': toggle('layerState.NWSMesoscaleDiscussionsOn'),
          'TNWSLayersFrame.sCheckBox4': bool('settings.NWSMesoscaleDiscussionShowSevere'),
          'TNWSLayersFrame.sCheckBox5': bool('settings.NWSMesoscaleDiscussionShowWinter'),
          'TNWSLayersFrame.sCheckBox6': bool('settings.NWSMesoscaleDiscussionShowHeavyRainfall'),
          'TNWSLayersFrame.sSpeedButton5': act((el) => app.popup('TNWSLayersFrame', 'PopupMenu2', el, mdMenu)),
          'TNWSLayersFrame.sCheckBox8': bool('layerState.NWSLocalStormReportsOn'),
          'TNWSLayersFrame.sLabelFX4': toggle('layerState.NWSLocalStormReportsOn'),
          'TNWSLayersFrame.lsrTypes': { kind: 'list', items: () => LSR_TYPES.map((label, i) => ({ label, checked: filterBits()[i] === '1' })), selected: () => -1, select: (i) => setBit(i, filterBits()[i] !== '1'), check: (i, on) => setBit(i, on) },
          'TNWSLayersFrame.sSpeedButton6': act(() => settings.set('ini.NWSLocalStormReports.TypeFilter', '1'.repeat(18))),
          'TNWSLayersFrame.sSpeedButton7': act(() => settings.set('ini.NWSLocalStormReports.TypeFilter', '0'.repeat(18))),
          'TNWSLayersFrame.sCheckBox7': bool('settings.NWSLSRMagnitudeFilter'),
          'TNWSLayersFrame.sSpinEdit1': { kind: 'num', id: 'settings.NWSLSRMagnitudeFilterValue', step: 1, min: -100, max: 200 },
        },
        TFrmNWSA: {
          'TFrmNWSA.lblStatus': status(() => `NWS all-advisories layer (public api.weather.gov): ${adv.status.text || 'off'}`),
          'TFrmNWSA.chkEnabled': bool('layerState.NWSAdvisoriesOn'),
          'TFrmNWSA.chkNoBorders': bool('settings.NWSAdvisoriesNoBorders'),
          'TFrmNWSA.btnShowAll': act(() => { for (const e of adv.events) advisoryStyles[e] = { ...adv.styleOf(e), visible: true }; saveAdvisoryStyles(); adv.apply(); }),
          'TFrmNWSA.btnHideAll': act(() => { for (const e of adv.events) advisoryStyles[e] = { ...adv.styleOf(e), visible: false }; saveAdvisoryStyles(); adv.apply(); }),
          'TFrmNWSA.btnColor': act(() => { const e = adv.events[nwsaSel]; if (!e) { app.toast('Select an advisory type first'); return; } const i = document.createElement('input'); i.type = 'color'; const c = adv.styleOf(e).color; i.value = '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''); i.oninput = () => { advisoryStyles[e] = { ...adv.styleOf(e), color: [1, 3, 5].map((k) => parseInt(i.value.slice(k, k + 2), 16)) as [number, number, number] }; saveAdvisoryStyles(); adv.apply(); }; i.click(); }),
          'TFrmNWSA.btnLineStyle': act(() => { const e = adv.events[nwsaSel]; if (e) app.editStyle(`Advisory:${e}`, `${e} (line)`); else app.toast('Select an advisory type first'); }),
          'TFrmNWSA.btnFillStyle': act(() => { const e = adv.events[nwsaSel]; if (e) app.editStyle(`Advisory:${e}`, `${e} (fill)`); else app.toast('Select an advisory type first'); }),
          'TFrmNWSA.AdvList': { kind: 'list', items: () => adv.events.map((e) => ({ label: e, checked: adv.styleOf(e).visible })), selected: () => nwsaSel, select: (i) => { nwsaSel = i; }, check: (i, on) => { const e = adv.events[i]; advisoryStyles[e] = { ...adv.styleOf(e), visible: on }; saveAdvisoryStyles(); adv.apply(); } },
          'TFrmNWSA.InstallPanel': { kind: 'na', reason: 'Vendor install/acknowledge step not needed: alerts come from the public api.weather.gov' },
          'TFrmNWSA.InstallMemo': { kind: 'na', reason: 'Vendor install text not shipped' },
          'TFrmNWSA.B': { kind: 'na', reason: 'Vendor install step not needed' },
        },
      };
    },
  };
}
void eventColor;

function surfaceSection(c: SectionCtx): Section {
  const metar = new MetarLayer(c.r, c.atlas), marine = new MarineLayer(c.r, c.atlas);
  const marineGroup = (i: number) => (i <= 1 ? 0 : 1);
  // Buoy explorer state.
  const bx = { id: '', data: null as BuoyData | null, status: 'Loading station data...', pos: [0, 0, 0], units: prefObject('buoyUnits', { 0: 0, 1: 0, 2: 0, 3: 0 }) };
  const SPEED: [string, number][] = [['mph', 2.23694], ['kph', 3.6], ['knots', 1.943844], ['m/s', 1], ['ft/s', 3.28084]];
  const DIST: [string, number][] = [['ft', 3.28084], ['mi', 1 / 1609.344], ['km', 0.001], ['m', 1], ['yd', 1.093613]];
  const PRES: [string, (h: number) => number][] = [['inHg', (h) => h / 33.8639], ['mb', (h) => h], ['psi', (h) => h * 0.0145038], ['hPa', (h) => h]];
  const temp = (cv: number) => [cv * 1.8 + 32, cv, cv + 273.15][bx.units[1]].toFixed(1) + ['°F', '°C', '°K'][bx.units[1]];
  const val = (rows: string[][], head: string[], pos: number, col: string) => { const r = rows[pos]; const i = head.indexOf(col); const v = r && i >= 0 ? r[i] : 'MM'; return v === undefined || v === 'MM' ? null : Number(v); };
  const std = (col: string, f: (v: number) => string) => () => { const d = bx.data; if (!d) return ''; const v = val(d.std, d.head, bx.pos[0], col); return v === null ? '-' : f(v); };
  const spd = (v: number) => `${(v * SPEED[bx.units[0]][1]).toFixed(1)} ${SPEED[bx.units[0]][0]}`;
  const dist = (m: number) => `${(m * DIST[bx.units[3]][1]).toFixed(1)} ${DIST[bx.units[3]][0]}`;
  const lbl = (caption: string, fn: () => string): Binding => status(() => `${caption} ${bx.data ? fn() : ''}`);
  const obsTime = (rows: string[][], pos: number) => { const r = rows[pos]; return r ? `Observations: ${pos === 0 ? 'Latest' : new Date(Date.UTC(+r[0], +r[1] - 1, +r[2], +r[3], +r[4])).toLocaleString()}` : 'Observations: -'; };
  const track = (k: number, rows: () => string[][]): Binding => ({ kind: 'custom', get: () => bx.pos[k], set: (v: number) => { bx.pos[k] = Math.max(0, Math.min(rows().length - 1, Math.round(v))); }, max: () => rows().length - 1 });
  const spec = (col: string, f: (v: number) => string) => () => { const d = bx.data; if (!d) return ''; const v = val(d.spec, d.specHead, bx.pos[1], col); return v === null ? '-' : f(v); };
  const ocean = (col: string, f: (v: number) => string) => () => { const d = bx.data; if (!d) return ''; const v = val(d.ocean, d.oceanHead, bx.pos[2], col); return v === null ? '-' : f(v); };
  return {
    tab: 'Surface', frame: 'TSurfaceLayersFrame', layers: [metar, marine],
    watch: ['layerState.METAR', 'layerState.Marine', 'settings.metar', 'settings.ndbc', 'ext.settings.surface'],
    bindings: (app) => {
      (app as unknown as { openBuoy: (id: string) => void }).openBuoy = (id: string) => {
        bx.id = id; bx.data = null; bx.status = `Loading station data for ${id}...`; bx.pos = [0, 0, 0];
        app.dialog('TFrmBuoyExplorer');
        loadBuoy(id).then((d) => { bx.data = d; bx.status = `Station ${id}: ${d.std.length} standard, ${d.cwind.length} continuous-wind, ${d.spec.length} spectral, ${d.ocean.length} ocean records`; }, (e) => { bx.status = `Station ${id}: ${e.message}`; });
      };
      const fieldRadio = (i: number): Binding => custom(() => settings.num('layerState.MarineObservationIdx') === i, () => {
        // Changing between the continuous-wind group and the standard group restarts the loader.
        const was = marineGroup(settings.num('layerState.MarineObservationIdx'));
        settings.set('layerState.MarineObservationIdx', i);
        if (was !== marineGroup(i)) marine.refresh();
      });
      const metarRadio = (n: number): Binding => radio('layerState.METARFieldIndex', n - 10);
      const map: BindingMap = {
        'TSurfaceLayersFrame.sSlider1': bool('layerState.MarineBuoyObservationsOn'), 'TSurfaceLayersFrame.sLabelFX1': toggle('layerState.MarineBuoyObservationsOn'),
        'TSurfaceLayersFrame.sSlider2': bool('layerState.MarineShipObservationsOn'), 'TSurfaceLayersFrame.sLabelFX2': toggle('layerState.MarineShipObservationsOn'),
        'TSurfaceLayersFrame.sSlider3': bool('layerState.METAROn'), 'TSurfaceLayersFrame.sLabelFX3': toggle('layerState.METAROn'),
        'TSurfaceLayersFrame.sCheckBox2': bool('settings.ndbcLargeFont'), 'TSurfaceLayersFrame.sCheckBox1': bool('settings.ndbcSitesOn'),
        'TSurfaceLayersFrame.sCheckBox7': bool('settings.metarLargeFont'),
        // "More" buttons open the spacing / palette panels of the marine and METAR layers.
        'TSurfaceLayersFrame.sSpeedButton1': act((el) => app.popPanel('ndbcExtraPanel', el)),
        'TSurfaceLayersFrame.sSpeedButton2': act((el) => app.popPanel('metarExtraPanel', el)),
        'TSurfaceLayersFrame.ParamSelector': { kind: 'na', reason: 'MADIS parameter UI is hidden in the original and its data comes from a vendor server' },
        'TSurfaceLayersFrame.sFrameBar1': { kind: 'na', reason: 'Hidden in the original: MADIS frame bar' },
        'TSurfaceLayersFrame.sButton1': { kind: 'na', reason: 'Hidden in the original: MADIS button' },
      };
      for (let i = 0; i <= 9; i++) map[`TSurfaceLayersFrame.marineObType${i}`] = fieldRadio(i);
      for (let n = 10; n <= 18; n++) map[`TSurfaceLayersFrame.sRadioButton${n}`] = metarRadio(n);
      const B = 'TFrmBuoyExplorer.';
      const ex: BindingMap = {
        [B + 'sLabel1']: status(() => bx.status),
        [B + 'ComboBox1']: custom(() => bx.units[0], (v: number) => (bx.units[0] = v)), [B + 'ComboBox2']: custom(() => bx.units[1], (v: number) => (bx.units[1] = v)),
        [B + 'ComboBox3']: custom(() => bx.units[2], (v: number) => (bx.units[2] = v)), [B + 'ComboBox4']: custom(() => bx.units[3], (v: number) => (bx.units[3] = v)),
        [B + 'ListView1']: { kind: 'list', items: () => (bx.data?.cwind ?? []).slice(0, 200).map((r) => ({ label: `${r[0]}-${r[1]}-${r[2]} ${r[3]}:${r[4]}  Wind ${r[6] === '99.0' ? '-' : spd(+r[6])} ${r[5]}°  Gust ${r[8] === '99.0' ? '-' : spd(+r[8])} ${r[7] === '999' ? '-' : r[7] + '°'}  Gust minute ${r[9] === '9999' ? '-' : r[9]}` })), selected: () => -1, select: () => {} },
        [B + 'Label1']: lbl('Visibility:', std('VIS', (v) => dist(v * 1852))), [B + 'Label2']: lbl('Wind Speed:', std('WSPD', spd)), [B + 'Label3']: lbl('Wind Direction:', std('WDIR', (v) => `${v}°`)),
        [B + 'Label4']: lbl('Wind Gust:', std('GST', spd)), [B + 'Label5']: lbl('Wave Height:', std('WVHT', dist)), [B + 'Label6']: lbl('Pressure Trend:', std('PTDY', (v) => `${PRES[bx.units[2]][1](v).toFixed(2)} ${PRES[bx.units[2]][0]}`)),
        [B + 'Label7']: lbl('Dominant Wave Period:', std('DPD', (v) => `${v} s`)), [B + 'Label8']: lbl('Tide:', std('TIDE', (v) => dist(v / 3.28084))), [B + 'Label10']: lbl('Av. Wave Direction:', std('MWD', (v) => `${v}°`)),
        [B + 'Label12']: lbl('Average Wave Period:', std('APD', (v) => `${v} s`)), [B + 'met1']: lbl('Air Temperature:', std('ATMP', temp)), [B + 'met2']: lbl('Dew Point:', std('DEWP', temp)),
        [B + 'Label9']: lbl('Pressure:', std('PRES', (v) => `${PRES[bx.units[2]][1](v).toFixed(2)} ${PRES[bx.units[2]][0]}`)), [B + 'Label11']: lbl('Water Temperature:', std('WTMP', temp)),
        [B + 'Label13']: status(() => obsTime(bx.data?.std ?? [], bx.pos[0])), [B + 'TrackBar1']: track(0, () => bx.data?.std ?? []),
        [B + 'Label28']: lbl('Significant Wave Height:', spec('WVHT', dist)), [B + 'Label29']: lbl('Swell Height:', spec('SwH', dist)), [B + 'Label30']: lbl('Swell Period:', spec('SwP', (v) => `${v} s`)),
        [B + 'Label31']: lbl('Wind Wave Height:', spec('WWH', dist)), [B + 'Label32']: lbl('Wind Wave Period:', spec('WWP', (v) => `${v} s`)), [B + 'Label33']: status(() => `Swell Wave Direction: ${bx.data?.spec[bx.pos[1]]?.[bx.data.specHead.indexOf('SwD')] ?? '-'}`),
        [B + 'Label34']: status(() => `Wind Wave Direction: ${bx.data?.spec[bx.pos[1]]?.[bx.data.specHead.indexOf('WWD')] ?? '-'}`), [B + 'Label35']: status(() => `Wave Steepness: ${bx.data?.spec[bx.pos[1]]?.[bx.data.specHead.indexOf('STEEPNESS')] ?? '-'}`),
        [B + 'Label36']: lbl('Average Wave Period:', spec('APD', (v) => `${v} s`)), [B + 'Label37']: lbl('Dominant Period Direction:', spec('MWD', (v) => `${v}°`)),
        [B + 'sLabel3']: status(() => obsTime(bx.data?.spec ?? [], bx.pos[1])), [B + 'sTrackBar2']: track(1, () => bx.data?.spec ?? []),
        [B + 'Label14']: lbl('Depth:', ocean('DEPTH', (v) => dist(v))), [B + 'Label19']: lbl('Ocean Temperature:', ocean('OTMP', temp)), [B + 'Label20']: lbl('Conductivity (mS/cm):', ocean('COND', String)),
        [B + 'Label21']: lbl('Salinity (psu):', ocean('SAL', String)), [B + 'Label22']: lbl('Oxygen Concentration (%):', ocean('O2%', String)), [B + 'Label23']: lbl('Oxygen Concentration (PPM):', ocean('O2PPM', String)),
        [B + 'Label24']: lbl('Chlorophyll Concentration (μg/l):', ocean('CLCON', String)), [B + 'Label25']: lbl('Turbidity (FTU):', ocean('TURB', String)), [B + 'Label26']: lbl('pH:', ocean('PH', String)),
        [B + 'Label27']: lbl('Redox Potential (millivolts):', ocean('EH', String)), [B + 'sLabel2']: status(() => obsTime(bx.data?.ocean ?? [], bx.pos[2])), [B + 'sTrackBar1']: track(2, () => bx.data?.ocean ?? []),
      };
      return { TSurfaceLayersFrame: map, TFrmBuoyExplorer: ex };
    },
  };
}

function mesoSection(c: SectionCtx): Section {
  const meso = new MesoLayer(c.r, c.atlas), sev = new SevereLayer(c.r);
  const contourProduct = () => MESO[settings.num('layerState.MesoanalysisProductIdx')]?.render === 'contour';
  return {
    tab: 'MESO', frame: 'TMesoanalysisLayersFrame', layers: [meso, sev],
    watch: ['layerState.Mesoanalysis', 'layerState.SevereParameter', 'settings.mesoanalysis', 'settings.stp', 'settings.scp', 'ext.settings.meso', 'settings.generalHeightContourInterval'],
    bindings: (app) => {
      const m: BindingMap = {
        'TMesoanalysisLayersFrame.sSlider1': bool('layerState.MesoanalysisDataOn'),
        'TMesoanalysisLayersFrame.sLabelFX1': toggle('layerState.MesoanalysisDataOn'),
        // STP and SCP are mutually exclusive.
        'TMesoanalysisLayersFrame.sCheckBox3': custom(() => settings.num('layerState.SevereParameterOn') === 1, (v) => settings.set('layerState.SevereParameterOn', v ? 1 : 0)),
        'TMesoanalysisLayersFrame.sCheckBox4': custom(() => settings.num('layerState.SevereParameterOn') === 2, (v) => settings.set('layerState.SevereParameterOn', v ? 2 : 0)),
        'TMesoanalysisLayersFrame.sCheckBox1': bool('settings.mesoanalysisFillSmoothing'),
        'TMesoanalysisLayersFrame.sCheckBox2': bool('settings.mesoanalysisFillLegend'),
        'TMesoanalysisLayersFrame.sSpeedButton2': act(() => { const i = settings.num('layerState.MesoanalysisProductIdx'); app.arrayPaletteSelector('settings.mesoanalysisPalettes', i, MESO[i].label); }, undefined, undefined, contourProduct),
        'TMesoanalysisLayersFrame.sSpeedButton1': act(() => app.alphaSelector('settings.mesoanalysisFillAlpha'), undefined, undefined, contourProduct),
      };
      for (let i = 1; i <= 22; i++) m[`TMesoanalysisLayersFrame.sRadioButton${i}`] = custom(() => settings.num('layerState.MesoanalysisProductIdx') === i - 1, () => { settings.set('layerState.MesoanalysisProductIdx', i - 1); settings.set('layerState.MesoanalysisDataOn', true); });
      return { TMesoanalysisLayersFrame: m };
    },
  };
}

function forecastSection(c: SectionCtx): Section {
  const L = forecastLayers(c.r, c.atlas);
  const cpcIdx = () => settings.num('layerState.CPCIdx');
  return {
    tab: 'Forecast', frame: 'TForecastLayersFrame', layers: [L.qpf, L.ero, L.ww, L.cpc],
    watch: ['layerState.WPC', 'settings.wpc', 'layerState.CPC', 'settings.cpc'],
    bindings: (app) => ({
      TForecastLayersFrame: {
        'TForecastLayersFrame.sCheckBox1': bool('layerState.WPCQPFOn'), 'TForecastLayersFrame.sLabelFX5': toggle('layerState.WPCQPFOn'),
        'TForecastLayersFrame.sCheckBox2': bool('layerState.WPCExcessiveRainfallOutlookOn'), 'TForecastLayersFrame.sLabelFX6': toggle('layerState.WPCExcessiveRainfallOutlookOn'),
        'TForecastLayersFrame.sCheckBox3': bool('layerState.WPCWinterPrecipitationProbabilitiesOn'), 'TForecastLayersFrame.sLabelFX2': toggle('layerState.WPCWinterPrecipitationProbabilitiesOn'),
        'TForecastLayersFrame.QPFTimes': combo('layerState.WPCQPFIdx'), 'TForecastLayersFrame.EROTimes': combo('layerState.WPCEROIdx'),
        'TForecastLayersFrame.WWDayIdx': combo('layerState.WPCWinterProductDayIdx'), 'TForecastLayersFrame.sComboBox4': combo('layerState.WPCWinterProductIdx'),
        'TForecastLayersFrame.sCheckBox4': bool('settings.wpcFilled'),
        'TForecastLayersFrame.sSpeedButton4': act((el) => app.popup('TForecastLayersFrame', 'PopupMenu1', el, { S1: { run: () => app.editStyle('EROMRGL') }, S2: { run: () => app.editStyle('EROSLGT') }, M1: { run: () => app.editStyle('EROMDT') }, H1: { run: () => app.editStyle('EROHIGH') } })),
        'TForecastLayersFrame.sBadgeBtn1': act(() => app.toast('WPC QPF: contours from the WPC shapefile, coloured with the "QPF" palette (edit it in the palette selector).')),
        'TForecastLayersFrame.sBadgeBtn2': act(() => app.toast('WPC products are refreshed every 10 minutes from ftp-wpc.ncep.noaa.gov.')),
        'TForecastLayersFrame.sBadgeBtn3': act(() => app.toast('CPC outlooks use the "CPCPrecipOutlook" / "CPCTempOutlooks" palettes.')),
        'TForecastLayersFrame.sSlider3': bool('layerState.CPCOn'), 'TForecastLayersFrame.sLabelFX1': toggle('layerState.CPCOn'),
        // CPCIdx = period × 2 + variable.
        'TForecastLayersFrame.sComboBox1': custom(() => cpcIdx() % 2, (v: number) => settings.set('layerState.CPCIdx', Math.floor(cpcIdx() / 2) * 2 + v)),
        'TForecastLayersFrame.sComboBox2': custom(() => Math.floor(cpcIdx() / 2), (v: number) => settings.set('layerState.CPCIdx', v * 2 + (cpcIdx() % 2))),
        'TForecastLayersFrame.sCheckBox5': bool('settings.cpcFilled'), 'TForecastLayersFrame.sCheckBox6': bool('settings.cpcLegend'),
        'TForecastLayersFrame.sLabel1': status(() => (L.cpc as unknown as { loadedText: string }).loadedText),
      },
    }),
  };
}

function miscSection(c: SectionCtx): Section {
  const diff = new DiffLayer(c.r);
  const M = miscLayers(c.r, c.atlas);
  return {
    tab: 'Misc', frame: 'TMiscellaneousLayersFrame', layers: [diff, M.drought, M.fireOutlook, M.rivers, M.fires, M.quakes],
    watch: ['layerState.Misc2MT', 'settings.misc2mt', 'layerState.Earthquakes', 'layerState.Fire', 'layerState.NWSFireOutlooks', 'layerState.NWSRiver', 'layerState.DMOn', 'settings.dmFilled'],
    bindings: (app) => ({
      TMiscellaneousLayersFrame: {
        'TMiscellaneousLayersFrame.sSlider1': bool('layerState.Misc2MTDifferenceOn'),
        'TMiscellaneousLayersFrame.sLabelFX1': status(() => ['Temperature Difference', 'Dew Pt Difference', 'MSLP Difference'][settings.num('layerState.Misc2MTDifferenceIdx')]),
        'TMiscellaneousLayersFrame.sRadioButton1': radio('layerState.Misc2MTDifferenceIdx', 0), 'TMiscellaneousLayersFrame.sRadioButton2': radio('layerState.Misc2MTDifferenceIdx', 1), 'TMiscellaneousLayersFrame.sRadioButton3': radio('layerState.Misc2MTDifferenceIdx', 2),
        'TMiscellaneousLayersFrame.sSpinEdit1': { kind: 'num', id: 'layerState.Misc2MTDifferenceHours', min: 1, max: 24, step: 1 },
        'TMiscellaneousLayersFrame.sCheckBox1': bool('settings.misc2mtDiffSmoothing'), 'TMiscellaneousLayersFrame.sCheckBox2': bool('settings.misc2mtDiffLegend'),
        'TMiscellaneousLayersFrame.sSpeedButton2': act(() => app.paletteSelector('settings.misc2mtDiffPalette', 'Difference')),
        'TMiscellaneousLayersFrame.sSpeedButton1': act(() => app.alphaSelector('settings.misc2mtDiffAlpha')),
        'TMiscellaneousLayersFrame.sCheckBox3': bool('layerState.EarthquakesOn'), 'TMiscellaneousLayersFrame.sLabelFX4': toggle('layerState.EarthquakesOn'),
        'TMiscellaneousLayersFrame.sCheckBox4': bool('layerState.FireMODISDetectionsOn'), 'TMiscellaneousLayersFrame.sLabelFX5': toggle('layerState.FireMODISDetectionsOn'),
        'TMiscellaneousLayersFrame.sSpinEdit5': bool('layerState.FireVIIRSDetectionsOn'), 'TMiscellaneousLayersFrame.sLabelFX8': toggle('layerState.FireVIIRSDetectionsOn'),
        'TMiscellaneousLayersFrame.sSlider5': bool('layerState.NWSFireOutlooksOn'), 'TMiscellaneousLayersFrame.sLabelFX7': toggle('layerState.NWSFireOutlooksOn'),
        'TMiscellaneousLayersFrame.sComboBox1': combo('layerState.NWSFireOutlooksDayIdx'),
        'TMiscellaneousLayersFrame.sSpeedButton3': act(() => { const d = settings.num('layerState.NWSFireOutlooksDayIdx') + 1; app.textProduct(`SPC Fire Weather Day ${d}`, d <= 2 ? `https://tgftp.nws.noaa.gov/data/raw/fn/fnus2${d}.kwns.fwd.dy${d}.txt` : 'https://tgftp.nws.noaa.gov/data/raw/fn/fnus28.kwns.fwd.d38.txt'); }),
        'TMiscellaneousLayersFrame.sSpeedButton4': act((el) => app.popup('TMiscellaneousLayersFrame', 'PopupMenu1', el, { E1: { run: () => app.editStyle('FOElevated') }, C1: { run: () => app.editStyle('FOCritical') }, E2: { run: () => app.editStyle('FOExtreme') }, i1: { run: () => app.editStyle('FOIsoDryT') }, IsolatedDryLTNG1: { run: () => app.editStyle('FOScatDryT') } })),
        'TMiscellaneousLayersFrame.sCheckBox5': bool('layerState.NWSRiverObservationsOn'), 'TMiscellaneousLayersFrame.sLabelFX6': toggle('layerState.NWSRiverObservationsOn'),
        'TMiscellaneousLayersFrame.sRadioButton4': radio('layerState.NWSRiverObservationsIdx', 0),
        'TMiscellaneousLayersFrame.sRadioButton5': custom(() => settings.num('layerState.NWSRiverObservationsIdx') > 0, () => settings.set('layerState.NWSRiverObservationsIdx', Math.max(1, settings.num('layerState.NWSRiverObservationsIdx')))),
        'TMiscellaneousLayersFrame.sComboBox2': custom(() => Math.max(0, settings.num('layerState.NWSRiverObservationsIdx') - 1), (v: number) => settings.set('layerState.NWSRiverObservationsIdx', v + 1)),
        'TMiscellaneousLayersFrame.sCheckBox7': bool('layerState.DMOn'), 'TMiscellaneousLayersFrame.sLabelFX9': toggle('layerState.DMOn'),
        'TMiscellaneousLayersFrame.sCheckBox6': bool('settings.dmFilled'),
      },
    }),
  };
}

function ndfdSection(c: SectionCtx): Section {
  const nd = new NdfdLayer(c.r);
  return {
    tab: 'NDFD', frame: 'TNDFDLayersFrame', layers: [nd],
    watch: ['layerState.NDFDOn', 'layerState.NDFDRegionIdx', 'layerState.NDFDProductIdx', 'settings.ndfdPalettes', 'ext.settings.ndfd'],
    bindings: (app) => ({
      TNDFDLayersFrame: {
        'TNDFDLayersFrame.sSlider1': bool('layerState.NDFDOn'), 'TNDFDLayersFrame.sLabelFX1': toggle('layerState.NDFDOn'),
        'TNDFDLayersFrame.sComboBox1': custom(() => settings.num('layerState.NDFDRegionIdx'), (v: number) => nd.setRegion(v)),
        'TNDFDLayersFrame.sComboBox2': custom(() => settings.num('layerState.NDFDProductIdx'), (v: number) => settings.set('layerState.NDFDProductIdx', v), () => (nd.listB ? NDFD.listB : NDFD.listA).map((e) => e.caption)),
        'TNDFDLayersFrame.hourSel': { kind: 'custom', get: () => nd.pos, set: (v: number) => nd.setPos(v), max: () => Math.max(0, (nd.slotCodes().length - 1) * 100) },
        'TNDFDLayersFrame.sLabelFX4': status(() => nd.timeText()),
        'TNDFDLayersFrame.sLabelFX5': status(() => nd.validText()),
        'TNDFDLayersFrame.sCheckBox1': bool('settings.ndfdInterpolate'), 'TNDFDLayersFrame.sCheckBox2': bool('settings.ndfdTimeLabel'),
        'TNDFDLayersFrame.sCheckBox3': bool('settings.ndfdLegend'), 'TNDFDLayersFrame.sCheckBox4': bool('settings.ndfdSmoothing'),
        'TNDFDLayersFrame.sSpeedButton2': act(() => { const e = nd.entry(); app.arrayPaletteSelector('settings.ndfdPalettes', e.paletteIndex, e.caption); }),
        'TNDFDLayersFrame.sSpeedButton1': act(() => app.alphaSelector('settings.ndfdAlpha')),
      },
    }),
  };
}

function winterSection(c: SectionCtx): Section {
  const w = new WinterLayer(c.r);
  return {
    tab: 'Winter', frame: 'TWinterUIFrame', layers: [w],
    watch: ['layerState.Winter', 'settings.wpcWinter'],
    bindings: (app) => ({
      TWinterUIFrame: {
        'TWinterUIFrame.sBitBtn1': toggle('layerState.WinterAccumulationsOn'),
        'TWinterUIFrame.sBitBtn2': act(() => settings.set('layerState.WinterSnowAccumulationsVsIce', true), () => settings.bool('layerState.WinterSnowAccumulationsVsIce')),
        'TWinterUIFrame.sBitBtn3': act(() => settings.set('layerState.WinterSnowAccumulationsVsIce', false), () => !settings.bool('layerState.WinterSnowAccumulationsVsIce')),
        'TWinterUIFrame.sComboBox1': custom(() => WINTER_LEVELS.indexOf(settings.num('layerState.WinterProbabilityLevel')), (v: number) => settings.set('layerState.WinterProbabilityLevel', WINTER_LEVELS[v])),
        'TWinterUIFrame.sComboBox2': custom(() => [24, 48, 72].indexOf(settings.num('layerState.WinterIntervalLengthHours')), (v: number) => { const L = [24, 48, 72][v]; settings.set('layerState.WinterIntervalLengthHours', L); if (settings.num('layerState.WinterIntervalEndHour') < L) settings.set('layerState.WinterIntervalEndHour', L); }),
        'TWinterUIFrame.sSlider1': bool('settings.wpcWinterShowLegend'), 'TWinterUIFrame.sCheckBox1': bool('settings.wpcWinterShowTimestamp'),
        'TWinterUIFrame.sSpeedButton2': act(() => { const snow = settings.bool('layerState.WinterSnowAccumulationsVsIce'); app.arrayPaletteSelector('settings.wpcWinterColorPalette', snow ? 0 : 1, snow ? 'Snow' : 'Ice'); }),
        'TWinterUIFrame.sSpeedButton1': act(() => app.alphaSelector('settings.wpcWinterAlpha')),
      },
    }),
    decorate: (frame) => {
      // End-period selector filled at run time (UpdateForecastEndPeriod).
      const box = document.createElement('div');
      box.className = 'ctl combo'; box.style.cssText = 'left:540px;top:64px;width:150px;height:22px';
      const lab = document.createElement('div'); lab.className = 'ctl labelfx'; lab.style.cssText = 'left:540px;top:44px;width:200px;height:18px'; lab.textContent = 'Interval ending (forecast hour):';
      const sel = document.createElement('select');
      const fill = () => {
        const L = settings.num('layerState.WinterIntervalLengthHours'), cur = settings.num('layerState.WinterIntervalEndHour');
        sel.innerHTML = '';
        for (const h of winterEndHours(L)) { const o = document.createElement('option'); o.value = String(h); o.textContent = `f${String(h).padStart(3, '0')}`; sel.appendChild(o); }
        sel.value = String(Math.max(L, cur));
      };
      fill();
      sel.onchange = () => settings.set('layerState.WinterIntervalEndHour', Number(sel.value));
      settings.on('layerState.WinterInterval', fill);
      box.appendChild(sel);
      frame.append(lab, box);
    },
  };
}

function tropicalSection(c: SectionCtx): Section {
  const tl = new TropicalLayer(c.r, c.atlas);
  const T = 'TTropicalLayersFrame.';
  const sw = (k: string) => `layerState.Tropical${k}On`;
  const sel = () => tl.selectedSystem();
  return {
    tab: 'Tropical', frame: 'TTropicalLayersFrame', layers: [tl],
    watch: ['layerState.Tropical', 'settings.tropical'],
    bindings: (app) => {
      const text = async (title: string, f: () => Promise<string>) => { tl.busyText = true; app.textViewer(title, 'Downloading…'); try { app.viewerText = await f(); } catch (e) { app.viewerText = `Unavailable: ${(e as Error).message}`; } finally { tl.busyText = false; } };
      const m: BindingMap = {
        [T + 'sSlider1']: bool(sw('ActiveSystems')), [T + 'sLabelFX1']: toggle(sw('ActiveSystems')),
        [T + 'sSlider2']: bool(sw('BestTrack')), [T + 'sLabelFX2']: toggle(sw('BestTrack')),
        [T + 'sSlider3']: bool(sw('OfficialForecast')), [T + 'sLabelFX3']: toggle(sw('OfficialForecast')),
        [T + 'sSlider4']: bool(sw('NHCForecastCone')), [T + 'sLabelFX4']: toggle(sw('NHCForecastCone')),
        [T + 'sSlider5']: bool(sw('ForecastModels')), [T + 'sLabelFX10']: toggle(sw('ForecastModels')),
        [T + 'sCheckBox5']: bool(sw('WindRadii')), [T + 'sLabelFX12']: toggle(sw('WindRadii')),
        [T + 'sCheckBox6']: bool(sw('ForecastRadii')), [T + 'sLabelFX13']: toggle(sw('ForecastRadii')),
        [T + 'sCheckBox7']: bool(sw('ReconData')), [T + 'sLabelFX14']: toggle(sw('ReconData')),
        [T + 'sCheckBox2']: bool(sw('WatchesWarnings')), [T + 'sLabelFX7']: toggle(sw('WatchesWarnings')),
        [T + 'sCheckBox1']: bool(sw('FormationProbabilities')), [T + 'sLabelFX6']: toggle(sw('FormationProbabilities')),
        [T + 'sCheckBox3']: bool('settings.tropicalShowInvestSystems'),
        [T + 'sCheckBox4']: custom(() => tl.filterSelected, (v) => { tl.filterSelected = !!v; tl.apply(); }),
        [T + 'ActiveSystems']: { kind: 'list', items: () => (tl.status.state === 'loading' && !tl.systems.length ? [{ label: 'Loading...' }] : tl.visibleSystems().length ? tl.visibleSystems().map((s) => ({ label: `${s.atcf.toUpperCase()} ${s.name} ${Math.round(s.vmaxMs * 2.23694)} mph` })) : [{ label: 'No systems currently active.', disabled: true }]), selected: () => tl.selected, select: (i, dbl) => { tl.selected = i; tl.apply(); const s = sel(); if (dbl && s) app.renderer.camera.flyTo({ lon: s.lon, lat: s.lat, z: 30 }, 1500, app.flyOpts()); } },
        [T + 'sLabelFX5']: status(() => `Central Pressure: ${sel() ? sel()!.pres : '----'}mb`),
        [T + 'sLabelFX8']: status(() => `Maximum Wind: ${sel() ? Math.round(sel()!.vmaxMs * 1.943844 * 1.15078) : '--'}mph`),
        [T + 'sLabelFX9']: status(() => { const s = sel(); return `Storm Motion: ${s ? Math.round(s.speedMs * 2.23694) : '--'}mph/${s ? compassOf(s.dir) : '---'}`; }),
        [T + 'sSpeedButton1']: act(() => text(`${sel()?.name ?? ''} advisory`, () => tl.advisoryText()), undefined, undefined, () => !sel() || tl.busyText),
        [T + 'sSpeedButton2']: act(() => text(`${sel()?.name ?? ''} discussion`, () => tl.discussionText()), undefined, undefined, () => !sel() || tl.busyText),
        [T + 'sSpeedButton8']: { ...act(() => app.editStyle('TropBestTrack', 'Best track')), label: 'Best track style', iconName: 'palette' },
        [T + 'sSpeedButton7']: { ...act(() => app.editStyle('TropForecastTrack', 'Official forecast track')), label: 'Official forecast track style', iconName: 'palette' },
        [T + 'sSpeedButton5']: { ...act(() => app.editStyle('NHCCone', 'NHC forecast cone')), label: 'NHC forecast cone style', iconName: 'palette' },
        [T + 'sSpeedButton3']: { ...act((el) => app.popup('TTropicalLayersFrame', 'fmType', el, { C1: { run: () => settings.set('settings.tropicalForecastModelTypeIdx', 0), checked: () => settings.num('settings.tropicalForecastModelTypeIdx') === 0 }, L1: { run: () => settings.set('settings.tropicalForecastModelTypeIdx', 1), checked: () => settings.num('settings.tropicalForecastModelTypeIdx') === 1 }, G1: { run: () => settings.set('settings.tropicalForecastModelTypeIdx', 2), checked: () => settings.num('settings.tropicalForecastModelTypeIdx') === 2 } })), label: 'Forecast model track type', iconName: 'settings' },
        [T + 'sSpeedButton4']: { ...act((el) => app.popup('TTropicalLayersFrame', 'PopupMenu1', el, { N31: { run: () => app.editStyle('WindRadii34Kt') }, N51: { run: () => app.editStyle('WindRadii50Kt') }, N61: { run: () => app.editStyle('WindRadii64Kt') }, I1: { run: () => settings.set('settings.tropicalInterpolateWindRadii', !settings.bool('settings.tropicalInterpolateWindRadii')), checked: () => settings.bool('settings.tropicalInterpolateWindRadii') } })), label: 'Wind radii styles and options', iconName: 'palette' },
        [T + 'sSpeedButton6']: { ...act((el) => app.popup('TTropicalLayersFrame', 'PopupMenu3', el, { MenuItem2: { run: () => app.editStyle('GTwo0') }, M1: { run: () => app.editStyle('GTwo1') }, H1: { run: () => app.editStyle('GTwo2') } })), label: 'Formation outlook styles', iconName: 'palette' },
        [T + 'sSpeedButton9']: { ...act((el) => app.popup('TTropicalLayersFrame', 'PopupMenu2', el, { MenuItem1: { run: () => app.editStyle('NHCTSWatch') }, MenuItem3: { run: () => app.editStyle('NHCTSWarn') }, MenuItem4: { run: () => app.editStyle('NHCHurWatch') }, H2: { run: () => app.editStyle('NHCHurWarn') } })), label: 'Watch and warning styles', iconName: 'palette' },
      };
      return { TTropicalLayersFrame: m };
    },
  };
}
const compassOf = (d: number) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((d % 360) + 360) % 360) / 22.5) % 16];

function modelSection(c: SectionCtx): Section {
  const ml = new ModelLayer(c.r, c.atlas);
  const M = 'TModelLayersProFrame.';
  const prodList = (kind: 'fill' | 'vector' | 'contour', id: string): Binding => ({
    kind: 'list', items: () => [{ label: 'None (layer disabled)' }, ...ml.list(kind).map((p) => ({ label: `${p.caption} (${p.unit})` }))],
    selected: () => settings.num(id) + 1, select: (i) => settings.set(id, i - 1),
  });
  let loopEndIdx = -1;
  return {
    tab: 'Model', frame: 'TModelLayersProFrame', layers: [ml],
    watch: [],
    bindings: (app) => {
      (app as unknown as { model: ModelLayer }).model = ml;
      const hourIdx = () => settings.num('layerState.ModelHourIdx');
      const m: BindingMap = {
        [M + 'sListBox1']: { kind: 'list', items: () => ml.captions().map((label) => ({ label })), selected: () => Math.min(settings.num('layerState.ModelIdx'), ml.captions().length - 1), select: (i) => { settings.set('layerState.ModelIdx', i); settings.set('layerState.ModelHourIdx', 0); for (const k of ['ModelDataColorFillIdx', 'ModelDataVectorsIdx', 'ModelDataContoursIdx', 'ModelDataColorFill2Idx']) settings.set('layerState.' + k, -1); ml.clear(); } },
        [M + 'sLabel1']: status(() => ml.runText()),
        [M + 'sComboBox1']: custom(() => hourIdx(), (v: number) => { settings.set('layerState.ModelHourIdx', v); ml.load(v); }, () => ml.hourItems()),
        [M + 'sUpDown1']: custom(() => hourIdx(), (v: number) => { const n = Math.max(0, Math.min(ml.hourItems().length - 1, Math.round(v))); settings.set('layerState.ModelHourIdx', n); ml.load(n); }),
        [M + 'sComboBox2']: custom(() => hourIdx(), (v: number) => settings.set('layerState.ModelHourIdx', v), () => ml.hourItems()),
        [M + 'sComboBox3']: custom(() => (loopEndIdx < 0 ? ml.hourItems().length - 1 : loopEndIdx), (v: number) => (loopEndIdx = v), () => ml.hourItems()),
        [M + 'sButton1']: act(() => { ml.load(hourIdx(), loopEndIdx < 0 ? ml.hourItems().length - 1 : loopEndIdx); settings.set('ext.layerState.TimelineSelect', 1); ml.publishTimeline(); }, undefined, undefined, () => ml.busy),
        [M + 'fillProd']: prodList('fill', 'layerState.ModelDataColorFillIdx'),
        [M + 'vectorProd']: prodList('vector', 'layerState.ModelDataVectorsIdx'),
        [M + 'contourProd']: prodList('contour', 'layerState.ModelDataContoursIdx'),
        [M + 'fill2Prod']: prodList('fill', 'layerState.ModelDataColorFill2Idx'),
        [M + 'sCheckBox4']: bool('settings.modelFillSmoothing'),
        [M + 'sCheckBox5']: bool('settings.modelContinuousInterpolation'),
        [M + 'sSpeedButton6']: act(() => ml.setAbort(), undefined, undefined, () => !ml.busy),
        [M + 'sSpeedButton7']: act(() => ml.clear()),
        [M + 'sMemo1']: status(() => ml.log.join('\n')),
        [M + 'sPanel1']: { kind: 'custom', get: () => 0, set: () => {}, hidden: () => !ml.isCustom() },
        [M + 'sFilenameEdit1']: custom(() => ml.custom.name, () => {}),
        [M + 'sButton2']: act(async () => {
          const f = await app.pickFile('.grib2,.grb2,.grb,.bin');
          if (!f) return;
          ml.custom.grib = URL.createObjectURL(f); ml.custom.name = f.name;
          // The browser fetches the .idx next to the GRIB: generate it from the file ("Generate/View WGRIB Inventory").
          ml.custom.inventory = await pool.for('modelFill').run('grib.inventory', { url: ml.custom.grib });
          app.toast(`${f.name}: ${ml.custom.inventory.split('\n').length - 1} messages`);
        }),
        [M + 'sButton3']: act(async () => { const v = await app.prompt('Integration index (Parameters)', 'fill,vector,contour,unit,caption[,palette],gribMatch — one per line; use "\\n" between lines:', ml.custom.params.replace(/\n/g, '\\n')); if (v !== null) ml.custom.params = v.replace(/\\n/g, '\n'); }),
        [M + 'sButton4']: act(() => app.textViewer(`${ml.custom.name || 'GRIB'} inventory`, ml.custom.inventory || 'Load a GRIB2 file first.')),
      };
      return { TModelLayersProFrame: m };
    },
  };
}
void CUSTOM_CAPTION;

export function buildSections(c: SectionCtx): Section[] {
  return [surfaceSection(c), mrmsSection(c), modelSection(c), mesoSection(c), forecastSection(c), ndfdSection(c), nwsSection(c), tropicalSection(c), winterSection(c), miscSection(c)];
}
