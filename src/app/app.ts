// Application: shell DOM, layer wiring, input, HUD, menus, data refresh and the render loop
// with the original's FPS caps.
import { settings, SETTING_DEFS, type SettingEdits } from '../settings/store';
import { Renderer, type Drawable } from '../render/renderer';
import { GlyphAtlas } from '../render/prims';
import { TileLayer } from '../render/tiles';
import { timeline } from './timeline';
import { layerOrder, viewpoints, scenePresets, sceneMask, layerPresets, DEFAULT_ORDER } from './stores';
import { GisLayer, RoadsLayer, CityLayer, SiteLabelLayer } from '../layers/gis';
import { NationalRadarLayer } from '../layers/national';
import { SatelliteLayer, basicSatelliteConfig, extendedSatelliteConfig, SAT_BANDS } from '../layers/satellite';
import { GoesL2Layer } from '../layers/goes-l2';
import { LightningLayer } from '../layers/lightning';
import { WarningsLayer, type Alert } from '../layers/warnings';
import { SurfaceLayer, SurfaceFillLayer } from '../layers/surface';
import { NexradLayer } from '../layers/nexrad';
import { AnnotationLayer, gcDistanceKm, bearingDeg } from '../layers/annotations';
import { cityImpacts, frontLine, impactText, type CityPt } from './tracks';
import { formatDateTime, zoneClock } from '../util/datefmt';
import type { MapLayer, LegendSpec } from '../layers/base';
import { renderForm, formMenus, formDef, keyboardClick, type BindingMap, type MenuNode } from '../ui/form';
import { openDialog, closeDialog, isOpen, showMenu, toast as toastFn, promptBox, drag, refreshDialogs, type MenuAction } from '../ui/dialogs';
import { openObjectStyle, openTextStyle, styleFormBindings } from '../ui/style-forms';
import { stringDisplayBindings } from '../ui/bindings';
import { toolFormBindings } from '../ui/tool-forms';
import { GpsLink } from '../data/gps';
import { GoesManualLayer } from '../layers/goes-manual';
import { CustomRadarLayer } from '../layers/custom-radar';
import { CustomBackgroundLayer } from '../layers/custom-background';
import { UserShapesLayer } from '../layers/usershapes';
import { PlacefileLayer } from '../layers/placefiles';
import { watermarkTile, cornerPos, loadLogo, CREDIT_LINE, BRAND_LINE, REPO_URL } from '../ui/branding';
import { videoFormat, drawCursor } from './capture';
import { fetchText } from '../data/net';
import { onStyleChange, hasTextStyle, textStyle, textCss } from './styles';
import { buildBindings, titleCase, timingText } from '../ui/bindings';
import { PerfPanel, type PerfSnapshot } from '../perf/panel';
import { drawLegends } from '../ui/legend';
import { RADAR_SITES } from '../generated/radar-sites';
import { PRODUCTS } from '../generated/products-catalog';
import { getPalette, registerPalette, paletteNames } from '../palettes/library';
import { lonLatToXYZ, wrapLon } from '../render/camera';
import { onProgress } from '../data/net';
import { pool } from '../workers/pool';
import { siteIndex } from '../settings/postload';
import { L3, l3PaletteKey } from '../radar/sources';
import { FrameMeter, setActiveMeter, perfMark } from '../perf/meter';
import { mainMenuActions, tracksMenuActions, l2ProductActions, mlMenuActions, ctrlRightActions } from '../ui/menus';
import { buildSections, type Section } from '../sections';
import { XSECTIONS } from '../generated/products-expanded';
import { FramePacer, fpsLimit } from './pacer';
import { pref, prefObject, loadPref, savePref, isArray, isBool, onSaveFailure, describeStorageError, DATA_CACHE, storeUserFile, userFileUrl } from './persist';
import { anisotropyOf } from '../render/mips';
import { radarStatus, radarStatusDetail } from '../radar/status';

type Tool = null | 'line' | 'path' | 'radial' | 'motion' | 'manualTrack' | 'light' | 'telestrate' | 'annotate' | 'labelPlace';

export class App {
  renderer: Renderer;
  timeline = timeline;
  atlas!: GlyphAtlas;
  tiles!: TileLayer;
  layers = new Map<string, MapLayer | TileLayer>();
  nexrad!: NexradLayer;
  warnings!: WarningsLayer;
  lightning!: LightningLayer;
  annotations!: AnnotationLayer;
  sites!: SiteLabelLayer;
  roads!: RoadsLayer;
  bindings!: Record<string, BindingMap>;
  sections: Section[] = [];
  meter = new FrameMeter();
  tool: Tool = null;
  private cellTrackingOn = false;
  /** Storm Cell Tracking Mode (Radar Control / SCIT): cells become clickable; overlays follow the mode's options. */
  get cellTracking() { return this.cellTrackingOn; }
  set cellTracking(v: boolean) { this.cellTrackingOn = v; if (!v) this.selectedCell = null; this.nexrad?.rebuildOverlays(); }
  /** GPS receiver link (GPS Connection dialog) and "Center map on GPS position". */
  gps = new GpsLink();
  private readonly gpsCenterPref = pref('gpsCenter', false, isBool);
  get gpsCenter() { return this.gpsCenterPref.value; }
  set gpsCenter(v: boolean) { this.gpsCenterPref.value = v; }
  /** Storm Cell Tracking Mode selection (cell ID) and the info box's state. */
  private selectedCell: string | null = null;
  private cellInfoMore = false;
  private trackHudKey = '';
  /** Small dialog options without a catalog setting, persisted with the other preferences. */
  readonly prefs = prefObject('appOptions', { centerForMotion: false, placefileOnTop: true });
  get centerForMotion() { return this.prefs.centerForMotion; }
  set centerForMotion(v: boolean) { this.prefs.centerForMotion = v; }
  siteEdit = settings.str('settings.nexradSiteICAO');
  palTarget: { label: string; get: () => string; set: (v: string) => void } | null = null;
  alphaTarget: { get: () => number; set: (v: number) => void; max: number } | null = null;
  roadState = 36;
  userShapes!: UserShapesLayer;
  placefiles!: PlacefileLayer;
  goesManual!: GoesManualLayer;
  customRadar!: CustomRadarLayer;
  customBg!: CustomBackgroundLayer;
  get placefileOnTop() { return this.prefs.placefileOnTop; }
  set placefileOnTop(v: boolean) { this.prefs.placefileOnTop = v; }
  userShapeSel = -1;
  orderSel = -1;
  viewPlaying = false;
  recording = false;
  private recorder: MediaRecorder | null = null;
  private recordCanvas: HTMLCanvasElement | null = null;
  private outputSize: [number, number] | null = null;
  private lastInteract = 0;
  private lastFrame = 0;
  private mouse: [number, number] | null = null;
  private lastClickLL: [number, number] | null = null;
  private flashT = 0;
  /** Edits made through the open Settings dialog since it opened or since Apply (what Cancel reverts). */
  private settingsEdits: SettingEdits = new Map();
  private hud!: { watchBox: HTMLElement; roadTip: HTMLElement; cityList: HTMLElement; cell: HTMLElement; brand: HTMLCanvasElement; maplabel: HTMLElement; time: HTMLElement; strikes: HTMLElement; probe: HTMLElement; cross: HTMLElement; info: HTMLElement; tip: HTMLElement; legend: HTMLCanvasElement; svg: SVGSVGElement; logo: HTMLElement; overlay: HTMLImageElement };
  private status: HTMLElement[] = [];
  private gauge!: HTMLElement;
  private selectedAlert: Alert | null = null;
  dl = { active: 0, received: 0, total: 0 };
  logoUrl: string | null = null;
  overlayUrl: string | null = null;

  constructor(private canvas: HTMLCanvasElement) { this.renderer = new Renderer(canvas); setActiveMeter(this.meter); }

  // ------------------------------------------------------------------------------------------- init
  async init() {
    await this.renderer.init();
    loadLogo().catch((e) => console.warn(e));
    const r = this.renderer;
    this.atlas = new GlyphAtlas(r);
    this.tiles = new TileLayer(r);
    const gis = new GisLayer(r);
    this.roads = new RoadsLayer(r, this.atlas);
    const cities = new CityLayer(r, this.atlas);
    this.sites = new SiteLabelLayer(r, this.atlas);
    const nr = new NationalRadarLayer(r);
    const sat = new SatelliteLayer(r, basicSatelliteConfig());
    const satx = new SatelliteLayer(r, extendedSatelliteConfig());
    const satL2 = new GoesL2Layer(r);
    this.lightning = new LightningLayer(r);
    this.warnings = new WarningsLayer(r, this.atlas);
    // Push live-notification text (Warnings → Misc): new warnings/watches since the previous poll.
    this.warnings.onNew = (list) => { for (const a of list.slice(0, 3)) toastFn(`NEW: ${a.headline || a.event}`, 6000); if (list.length > 3) toastFn(`…and ${list.length - 3} more new alerts`, 6000); };
    const surface = new SurfaceLayer(r, this.atlas);
    const fill = new SurfaceFillLayer(r, surface);
    this.nexrad = new NexradLayer(r, this.atlas);
    this.annotations = new AnnotationLayer(r, this.atlas);
    this.annotations.cities = () => cities.list() as unknown as CityPt[];
    this.nexrad.trackingMode = () => this.cellTracking;
    this.annotations.gpsFix = () => this.gps.fix;
    this.gps.onUpdate = () => {
      this.annotations.dirty = true;
      const f = this.gps.fix;
      if (this.gpsCenter && f.lat !== null && f.lon !== null) this.renderer.camera.flyTo({ lon: f.lon, lat: f.lat }, 400);
      this.poke();
    };
    this.sections = buildSections({ r, atlas: this.atlas });
    this.userShapes = new UserShapesLayer(r, this.atlas);
    this.placefiles = new PlacefileLayer(r, this.atlas);
    this.goesManual = new GoesManualLayer(r);
    this.customRadar = new CustomRadarLayer(r, this.atlas, this.nexrad);
    this.customBg = new CustomBackgroundLayer(r);
    for (const l of [this.customBg, gis, this.roads, cities, this.sites, nr, sat, satx, satL2, this.goesManual, this.customRadar, this.lightning, this.warnings, surface, fill, this.nexrad, this.annotations, this.userShapes, this.placefiles, ...this.sections.flatMap((s) => s.layers)]) {
      this.layers.set(l.id, l);
      l.onStatus = () => this.updateStatusBar();
    }
    this.layers.set('basemap', this.tiles);
    this.tiles.onChange = () => this.poke();
    this.nexrad.onTilts = () => this.renderTilts();
    this.applyCameraSettings(true);
    this.applyLayerOrder();
    this.applySampleCount();
    r.onProbe = (p) => this.showProbe(p);
    onProgress((active, received, total) => { this.dl = { active, received, total }; });
    this.bindings = buildBindings(this);
    for (const sec of this.sections) for (const [form, map] of Object.entries(sec.bindings(this))) this.bindings[form] = { ...(this.bindings[form] ?? {}), ...map };
    Object.assign(this.bindings, styleFormBindings(this));
    Object.assign(this.bindings, toolFormBindings(this));
    this.bindings.TFrmStringDisplay = stringDisplayBindings(() => this.viewerText, () => closeDialog('TFrmStringDisplay'));
    this.buildShell();
    // "Show exceptions" (Advanced menu): uncaught errors also appear as toasts (always logged to the console).
    const showError = (msg: string) => { if (settings.bool('settings.generalShowExceptions')) this.toast(`Error: ${msg.slice(0, 200)}`); };
    window.addEventListener('error', (e) => showError(e.message));
    window.addEventListener('unhandledrejection', (e) => showError(String((e.reason as Error)?.message ?? e.reason)));
    onSaveFailure((what, err) => this.toast(`Not saved: ${what} (${describeStorageError(err)})`));
    if (settings.saveError) this.toast(`Not saved: settings (${settings.saveError})`);
    this.wireSettings();
    onStyleChange(() => { for (const l of this.layers.values()) (l as { styleChanged?: () => void }).styleChanged?.(); this.poke(); });
    this.wireInput();
    this.wireKeys();
    await Promise.all([gis.load(), this.roads.load(), cities.load(), this.customBg.load()]);
    this.restoreRoadDownloads();
    void this.restoreUserImages();
    this.roads.rebuildLabels();
    timeline.refreshWindow();
    this.refreshAll();
    if (this.customRadar.enabled()) this.customRadar.sync();
    setInterval(() => this.refreshAll(), 60_000);
    // Status labels, gauges and lists are dynamic: refresh the visible forms a few times per second.
    setInterval(() => { perfMark('forms'); this.frameForm?.refresh(); for (const f of this.staticForms) f.refresh(); refreshDialogs(); }, 300);
    // Live sweep polling: 5 s with the chunk feed (chunks arrive every few seconds), 15 s on the full-volume fallback.
    let lastLive = 0;
    setInterval(() => {
      if (!this.nexrad.liveScan || !this.nexrad.enabled()) return;
      if (Date.now() - lastLive < (this.nexrad.liveSource.kind === 'full-volume' ? 15_000 : 5_000) - 100) return;
      lastLive = Date.now();
      void this.nexrad.refresh();
    }, 5_000);
    if (settings.bool('config.playViewpointsAtStart')) this.toggleViewPlay();
    if (settings.bool('config.generalLaunchFullscreen')) document.documentElement.requestFullscreen?.().catch(() => {});
    requestAnimationFrame((t) => this.loop(t));
  }

  formControls(form: string): string[] { return formDef(form).controls.filter((c) => !c.nonvisual).map((c) => c.id.replace(/^ui\./, '')); }
  layerTitle(id: string) { return (this.layers.get(id) as { title?: string } | undefined)?.title ?? (id === 'basemap' ? 'Background / terrain' : id); }

  // ------------------------------------------------------------------------------------------- data
  refreshAll() {
    timeline.refreshWindow();
    for (const l of this.layers.values()) if ('refresh' in l) (l as MapLayer).refresh().catch((e) => console.warn(l.id, e));
  }
  refreshLayer(id: string) { const l = this.layers.get(id) as MapLayer | undefined; l?.refresh().catch((e) => console.warn(id, e)); this.poke(); }
  /** Zone alert list (TFrmAdvisories) for the NWS forecast zone containing a point. */
  zoneAlerts: { status: string; sel: number; items: { row: string; text: string }[] } = { status: '', sel: -1, items: [] };
  async openZoneAlerts(lon: number, lat: number) {
    this.zoneAlerts = { status: 'Finding the NWS zone…', sel: -1, items: [] };
    this.dialog('TFrmAdvisories');
    try {
      const pt = JSON.parse(await fetchText(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { cache: 'none' }));
      const zone = String(pt.properties?.forecastZone ?? '').split('/').pop();
      if (!zone) throw new Error('no NWS forecast zone at this point');
      this.zoneAlerts.status = `Loading active alerts for NWS zone ${zone}...`;
      const gj = JSON.parse(await fetchText(`https://api.weather.gov/alerts/active/zone/${zone}`, { cache: 'none' }));
      const t = (v: string | null | undefined) => (v ? new Date(v).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
      this.zoneAlerts.items = (gj.features ?? []).map((f: { properties: Record<string, any> }) => {
        const p = f.properties;
        return { row: `${p.event} | ${p.parameters?.AWIPSidentifier?.[0] ?? '—'} | ${t(p.effective)} | ${String(p.areaDesc ?? '').slice(0, 40)} | ${t(p.expires)} | ${t(p.ends)}`,
          text: [p.headline, '', p.description, p.instruction ? `\n${p.instruction}` : ''].filter((x) => x !== undefined && x !== null).join('\n') };
      });
      this.zoneAlerts.status = this.zoneAlerts.items.length ? `${this.zoneAlerts.items.length} active alert(s) for zone ${zone}. Select one to read it.` : `No active alerts for NWS zone ${zone}.`;
    } catch (e) { this.zoneAlerts.status = `Zone alerts unavailable: ${(e as Error).message}`; }
  }
  downloadFraction() { return this.dl.total ? this.dl.received / this.dl.total : 0; }
  layerBusy(id: string) { const l = this.layers.get(id) as MapLayer | undefined; return !!l && l.status.state === 'loading'; }

  private wireSettings() {
    const on = (prefix: string, fn: () => void) => settings.on(prefix, () => { fn(); this.poke(); });
    on('layerState.NationalRadar', () => this.refreshLayer('nationalRadar'));
    on('layerState.Satellite', () => this.refreshLayer('satellite'));
    on('layerState.ExtendedSatellite', () => { this.refreshLayer('satelliteExtended'); this.refreshLayer('satelliteL2'); });
    on('ext.layerState.ExtendedSatellite', () => { this.refreshLayer('satelliteExtended'); this.refreshLayer('satelliteL2'); });
    // GOES Extended dialog: frame count and CONUS 15-min / mesoscale 3-min thinning select the files to load.
    for (const k of ['goesExtendedForce60fps', 'goesMesoThird', 'goesCONUSThird']) on('settings.' + k, () => { for (const id of ['satellite', 'satelliteExtended', 'satelliteL2']) this.refreshLayer(id); });
    on('layerState.Lightning', () => this.refreshLayer('lightning'));
    for (const k of ['TORWarningsOn', 'SVRWarningsOn', 'SQWarningsOn', 'SMWarningsOn', 'FFWWarningsOn', 'SWSWarningsOn', 'EWWarningsOn', 'SevereWatchesOn']) on('layerState.' + k, () => this.refreshLayer('warnings'));
    for (const k of ['MSLPOn', '10mWindVectorsOn', 'FrontsOn', 'CentersOn', 'saFillOn', 'saFillIdx']) on('layerState.' + k, () => this.refreshLayer('surface'));
    on('settings.generalMSLPContourInterval', () => { (this.layers.get('surface') as SurfaceLayer).resetContours(); this.refreshLayer('surface'); });
    on('settings.generalContourKernel', () => { (this.layers.get('surface') as SurfaceLayer).resetContours(); this.refreshLayer('surface'); });
    // Custom radar: engine on/off, site and polling restart the loader; product/motion changes rebuild sweeps.
    on('settings.nexradTracks', () => this.nexrad.rebuildOverlays());
    on('ext.settings.nexradTracks', () => this.nexrad.rebuildOverlays());
    on('settings.nexradMeltingLayerColor', () => this.nexrad.rebuildOverlays());
    on('layerState.CustomRadarOn', () => this.customRadar.sync());
    on('layerState.CustomRadarSite', () => this.customRadar.sync());
    on('settings.customRadarPollingInterval', () => this.customRadar.sync());
    on('settings.customRadarMax', () => this.customRadar.sync());
    on('layerState.CustomRadarProduct', () => this.customRadar.reloadProducts());
    on('settings.customRadarStormMotion', () => this.customRadar.reloadProducts());
    on('layerState.NEXRAD', () => { this.nexrad.reloadProducts(); this.nexrad.publishTimeline(); this.refreshLayer('nexrad'); this.renderTilts(); });
    on('settings.nexradTimelineConstrain', () => this.nexrad.publishTimeline());
    // The custom radar engine builds its products with the NEXRAD algorithm settings.
    on('settings.nexradAlgorithm', () => { this.nexrad.reloadProducts(); this.customRadar.reloadProducts(); });
    on('settings.nexradQualityDealiasing', () => { this.nexrad.reloadProducts(); this.customRadar.reloadProducts(); });
    on('settings.nexradStormMotion', () => this.nexrad.reloadProducts());
    on('settings.nexradLevel2ShowSplitCuts', () => this.nexrad.reloadProducts());
    on('settings.nexradL2', () => this.refreshLayer('nexrad'));
    on('settings.nexradSiteICAO', () => this.siteChanged());
    on('settings.nexradLevel2MaxVolumeDownloadCount', () => this.refreshLayer('nexrad'));
    const volCache = () => pool.broadcast('config', { volumes: settings.num('settings.nexradLevel2VolumeCountMemory') }).catch((e) => console.warn('worker config', e));
    volCache();
    on('settings.nexradLevel2VolumeCountMemory', () => { volCache(); this.refreshLayer('nexrad'); });
    on('settings.nexradLevel3MaxFrameCount', () => this.refreshLayer('nexrad'));
    on('ext.layerState.LoopLength', () => this.refreshAll());
    on('config.radarSites', () => this.sites.rebuild());
    on('config.geoRoads', () => this.roads.applyStyles());
    on('config.citylabelCaps', () => (this.layers.get('cities') as CityLayer).rebuild());
    on('config.camera', () => this.applyCameraSettings());
    on('config.performanceMode', () => { this.applySampleCount(); this.refreshAll(); });
    on('config.rightSide', () => this.applySidebar());
    on('config.pointMarkers', () => (this.annotations.dirty = true));
    on('settings.nexradManualTracks', () => (this.annotations.dirty = true));
    on('config.telestrate', () => (this.annotations.dirty = true));
    on('config.distanceMeasureImperial', () => (this.annotations.dirty = true));
    on('ext.layerState.MapBase', () => this.renderTitleBar());
    for (const sec of this.sections) for (const prefix of sec.watch) on(prefix, () => { for (const l of sec.layers) this.refreshLayer(l.id); });
    on('layerState.', () => { /* ProductStatus is written back on every layer change */ });
  }

  private applySampleCount() { this.renderer.setSampleCount(settings.num('config.performanceMode') === 0 ? 1 : 4); }
  private applyCameraSettings(initial = false) {
    const c = this.renderer.camera;
    c.smoothing = {
      pan: settings.bool('config.cameraSmoothPan'), zoom: settings.bool('config.cameraSmoothZoom'), tilt: settings.bool('config.cameraSmoothTilt'),
      swivel: settings.bool('config.cameraSmoothSwivel'), lookX: settings.bool('config.cameraSmoothLookAtX'), lookYZ: settings.bool('config.cameraSmoothLookAtYZ'),
      amount: settings.num('config.cameraSmoothingAmount'),
    };
    if (initial) {
      const p = settings.arr<number>('config.defaultCameraPt');
      c.setView({ lon: p[0], lat: p[1], z: p[2], tilt: p[3], swivel: 0 }, true);
    }
  }
  applyLayerOrder() {
    this.renderer.layers = [this.tiles as Drawable, ...layerOrder.list.filter((id) => id !== 'basemap').map((id) => this.layers.get(id)).filter((l): l is MapLayer => !!l)];
  }
  moveLayer(i: number) {
    const list = [...layerOrder.list].reverse();
    if (i <= 0) return;
    [list[i - 1], list[i]] = [list[i], list[i - 1]];
    layerOrder.set(list.reverse());
    this.orderSel = i - 1;
    this.applyLayerOrder();
  }

  // ------------------------------------------------------------------------------------------- shell
  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    parent?.appendChild(e);
    return e;
  }

  private buildShell() {
    const app = document.getElementById('app')!;
    // Title bar.
    this.el('div', '', app).id = 'titlebar';
    this.renderTitleBar();
    // Head bar: frame panel 780 | map modes 69 | capture 69 | styles 98 | fill | timeline 190.
    const head = this.el('div', '', app); head.id = 'headbar';
    const frame = this.el('div', '', head); frame.id = 'framepanel';
    const mm = this.el('div', 'hb-block', head); mm.style.width = '69px';
    const keep = <T extends ReturnType<typeof renderForm>>(f: T) => { this.staticForms.push(f); return f; };
    mm.appendChild(keep(renderForm('TFrmMap', this.bindings.TFrmMap, { root: 'MapModesPanel', width: 69, height: 130 })).el);
    const cap = this.el('div', 'hb-block', head); cap.style.width = '69px';
    cap.appendChild(keep(renderForm('TFrmMap', this.bindings.TFrmMap, { root: 'CaptureBtnsPanel', width: 69, height: 130 })).el);
    const st = this.el('div', 'hb-block', head); st.style.width = '98px';
    const stForm = renderForm('TFrmMap', this.bindings.TFrmMap, { root: 'MapStylesPanel', width: 98, height: 130 }).el;
    stForm.style.left = '8px'; st.appendChild(stForm);
    this.el('div', '', head).id = 'hb-fill';
    const tl = this.el('div', 'hb-block', head); tl.id = 'timelinepages';
    const tlForm = keep(renderForm('TFrmMap', this.bindings.TFrmMap, { root: 'HeadBar', width: 190, height: 130 }));
    const pages = tlForm.controls.get('sPageControl1')!;
    pages.style.left = '0px'; pages.style.top = '0px';
    tl.appendChild(pages);
    this.renderFrame();
    // Main: bar button, sidebar, draw panel.
    const main = this.el('div', '', app); main.id = 'main';
    const bar = this.el('div', '', main, '<<<<<'); bar.id = 'barbtn'; bar.onclick = () => this.toggleSidebar();
    const side = this.el('div', '', main); side.id = 'sidebar';
    this.buildSidebar(side);
    const dp = this.el('div', '', main); dp.id = 'drawpanel';
    dp.appendChild(this.canvas);
    const ov = this.el('div', '', dp); ov.id = 'overlay';
    this.perf = new PerfPanel(dp, () => this.perfSnapshot());
    const legend = this.el('canvas', '', ov); legend.id = 'legendcv'; legend.style.width = '100%';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none');
    ov.appendChild(svg);
    const logo = this.el('div', '', ov); logo.style.cssText = 'position:absolute;pointer-events:none';
    const overlay = this.el('img', '', ov); overlay.style.cssText = 'position:absolute;pointer-events:none;display:none';
    this.hud = {
      watchBox: this.el('div', 'hud-box hud-watches', ov), roadTip: this.el('div', 'hud-roadlabel', ov), cityList: this.el('div', 'hud-box hud-cities', ov), cell: this.el('div', 'hud-box hud-cell', ov),
      brand: this.el('canvas', 'hud-brand', ov),
      maplabel: this.el('div', 'hud-time hud-sub', ov),
      time: this.el('div', 'hud-time', ov), strikes: this.el('div', 'hud-box hud-strikes', ov), probe: this.el('div', 'probe', ov),
      cross: this.el('div', 'crosshair', ov), info: this.el('div', 'hud-info', ov), tip: this.el('div', 'tooltip', ov), legend, svg, logo, overlay,
    };
    this.hud.info.style.display = 'none'; this.hud.tip.style.display = 'none'; this.hud.roadTip.style.display = 'none';
    const lp = settings.arr<number>('config.guiLightningCountPosition');
    this.hud.strikes.style.left = `${lp[0]}px`; this.hud.strikes.style.top = `${lp[1]}px`;
    drag(this.hud.strikes, this.hud.strikes, (x, y) => settings.set('config.guiLightningCountPosition', [x, y]));
    drag(this.hud.info, this.hud.info, (x, y) => settings.set('config.guiSevereWarningsTextPosition', [x, y]));
    // Storm-track HUD boxes: city ETA list and storm-cell info, draggable to persisted positions.
    for (const [box, key] of [[this.hud.cityList, 'config.guiCityListTextPosition'], [this.hud.cell, 'config.guiStormCellInfoTextPosition']] as const) {
      // Positions are stored relative to the map area below the legend strip (like the timestamp).
      box.style.display = 'none';
      drag(box, box, (x, y) => settings.set(key, [x, y - this.hud.legend.clientHeight]));
    }
    let downAt = '';
    this.hud.cell.addEventListener('mousedown', () => { downAt = `${this.hud.cell.offsetLeft},${this.hud.cell.offsetTop}`; });
    this.hud.cell.addEventListener('click', () => { if (downAt === `${this.hud.cell.offsetLeft},${this.hud.cell.offsetTop}`) { this.cellInfoMore = !this.cellInfoMore; this.trackHudKey = ''; } });
    // Status bar: 7 panels [100,100,100,100,300,200,50] + gauge.
    const sb = this.el('div', '', app); sb.id = 'statusbar';
    for (const w of [100, 100, 100, 100, 300, 200, 50]) { const p = this.el('div', '', sb); p.style.width = `${w}px`; if (w === 300 || w === 50) p.style.textAlign = 'center'; this.status.push(p); }
    const g = this.el('div', 'gauge', sb); this.gauge = this.el('div', '', g);
    g.title = 'Downloads (click for details)'; g.style.cursor = 'pointer'; g.onclick = () => this.dialog('TFrmDownloader');
    this.applySidebar();
    if (!settings.bool('config.sidebarOnLaunch')) main.classList.add('nosidebar');
  }

  /** Debug / performance panel (F8). */
  perf!: PerfPanel;
  private perfSnapshot(): PerfSnapshot {
    const g = this.renderer.gpu;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return {
      frames: this.meter.summary(2000), totalFrames: this.meter.total,
      gpuMs: g.timestamps ? this.renderer.gpuMs : null,
      heap: mem ? { used: mem.usedJSHeapSize, limit: mem.jsHeapSizeLimit } : null,
      textureBytes: g.trackedTextureBytes, textures: [...g.textureBytes].sort((a, b) => b[1] - a[1]),
      uploads: [...g.uploads].sort((a, b) => b[1].bytes - a[1].bytes),
      jobs: [...pool.owners].sort((a, b) => b[1].execMs - a[1].execMs),
      layers: [...this.layers.values()].filter((l): l is MapLayer => 'status' in l && (l as MapLayer).enabled()).map((l) => ({ id: l.id, state: l.status.state, frames: l.status.frames, text: l.status.text })),
      timeline: timingText(timeline), workers: pool.size,
    };
  }

  renderTitleBar() {
    const tb = document.getElementById('titlebar')!;
    // Rebuilt on every tab or base change: keyboard focus returns to the same control.
    const focusable = () => [...tb.querySelectorAll<HTMLElement>('[tabindex]')];
    const focused = focusable().indexOf(document.activeElement as HTMLElement);
    tb.textContent = '';
    const menu = this.el('div', 'menubtn', tb, 'CWRV3 ▾');
    menu.onclick = (e) => this.mainMenu(e.currentTarget as HTMLElement);
    keyboardClick(menu); menu.setAttribute('aria-haspopup', 'menu');
    const tabs = this.el('div', 'tabs', tb);
    for (const t of XSECTIONS.tabs) {
      const built = t.frame === 'TBasicLayersFrame' || t.frame === 'TRadarUIFrame' || this.sections.some((s) => s.frame === t.frame);
      const e = this.el('div', 'tab' + (built ? '' : ' disabled') + (this.activeTab === t.caption ? ' on' : ''), tabs, t.caption);
      if (built) { e.onclick = () => { this.activeTab = t.caption; this.renderTitleBar(); this.renderFrame(); }; keyboardClick(e, 'tab'); e.setAttribute('aria-selected', String(this.activeTab === t.caption)); }
      else e.title = `${t.caption}: not available`;
    }
    this.el('div', 'spacer', tb);
    const group = this.el('div', 'basegroup', tb);
    ['Background', 'GIS', 'Both', 'None'].forEach((t, i) => {
      const e = this.el('div', 'tab' + (settings.num('ext.layerState.MapBase') === i ? ' on' : ''), group, t);
      e.onclick = () => settings.set('ext.layerState.MapBase', i);
      keyboardClick(e, 'radio'); e.setAttribute('aria-checked', String(settings.num('ext.layerState.MapBase') === i));
    });
    const fs = this.el('div', 'tab', group, '⛶'); fs.title = 'Fullscreen (Ctrl+F)'; fs.onclick = () => this.fullscreen(); keyboardClick(fs); fs.setAttribute('aria-label', 'Fullscreen');
    if (focused >= 0) focusable()[focused]?.focus();
  }
  activeTab = 'Basic';
  private staticForms: ReturnType<typeof renderForm>[] = [];
  private frameForm: ReturnType<typeof renderForm> | null = null;
  renderFrame() {
    const frame = document.getElementById('framepanel')!;
    this.frameForm?.destroy();
    frame.textContent = '';
    const name = XSECTIONS.tabs.find((t) => t.caption === this.activeTab)?.frame ?? 'TBasicLayersFrame';
    this.frameForm = renderForm(name, this.bindings[name], { width: 780, height: 130 });
    frame.appendChild(this.frameForm.el);
    this.sections.find((s) => s.frame === name)?.decorate?.(this.frameForm.el, this);
    if (name === 'TRadarUIFrame') this.renderTilts();
  }

  /** Tilt tabs are built at runtime from the volume's elevation cuts. */
  renderTilts() {
    const host = this.frameForm?.controls.get('tiltSelect');
    if (!host) return;
    host.textContent = '';
    host.style.cssText += ';display:flex;flex-wrap:wrap;align-content:flex-start;gap:2px;overflow:auto';
    host.style.display = settings.bool('layerState.NEXRADLevel2') ? 'flex' : 'none';
    const vol = this.nexrad.product() >= 11;
    if (vol) { this.el('div', 'notimpl', host, 'Volumetric product (all tilts)'); return; }
    if (!this.nexrad.tilts.length) { this.el('div', 'notimpl', host, settings.bool('layerState.NEXRADOn') ? 'Loading tilts…' : 'Tilts appear with data'); return; }
    for (const t of this.nexrad.tilts) {
      const b = this.el('div', 'ctl speedbtn' + (Math.abs(t.angle - this.nexrad.tiltAngle) < 0.05 ? ' down' : ''), host, t.label);
      b.style.position = 'static'; b.style.padding = '2px 4px'; b.style.fontSize = '10px';
      b.onclick = () => { this.nexrad.setTilt(t.angle); this.renderTilts(); };
    }
  }

  private buildSidebar(side: HTMLElement) {
    const sections: [string, string][] = [['Contour Lines', 'TContourBarPanel'], ['Vector Field', 'TVectorBarPanel'], ['Viewpoints', 'TPresetViewsPanel'], ['Layer Orders', 'TOrderPanel'], ['Play Viewpoints', 'TViewsPlaythroughPanel'], ['Manual Tracking', 'TStormTrackingPanel'], ['Timestamps', 'TTimestampsPanel']];
    for (const [title, form] of sections) {
      const h = this.el('div', 'fb-head', side, title);
      const body = this.el('div', 'fb-body', side);
      body.style.display = title === 'Viewpoints' || title === 'Play Viewpoints' ? '' : 'none';
      h.classList.toggle('open', body.style.display === '');
      h.onclick = () => { body.style.display = body.style.display ? '' : 'none'; h.classList.toggle('open', !body.style.display); };
      const f = renderForm(form, this.bindings[form]);
      this.staticForms.push(f);
      body.appendChild(f.el);
    }
  }
  applySidebar() { document.getElementById('main')?.classList.toggle('right', settings.bool('config.rightSide')); }
  toggleSidebar() { document.getElementById('main')!.classList.toggle('nosidebar'); }

  // ------------------------------------------------------------------------------------------- dialogs
  dialog(name: string) {
    if (name === 'TFrmSettings') {
      if (!isOpen(name)) this.settingsEdits = new Map();
      const edits = this.settingsEdits, edit = (write: () => void) => settings.record(edits, write);
      openDialog(name, this.bindings[name] ?? {}, { edit, extra: (body) => this.creditsBlock(body, edit) });
      return;
    }
    openDialog(name, this.bindings[name] ?? {});
  }
  /** About / credits area inside the Settings dialog, with the watermark preferences. */
  private creditsBlock(body: HTMLElement, edit: (write: () => void) => void) {
    const box = document.createElement('div');
    box.className = 'credits';
    const logo = document.createElement('div'); logo.className = 'credits-logo';
    const t = document.createElement('div');
    t.innerHTML = '<b>About</b>';
    const l1 = document.createElement('div'); l1.textContent = CREDIT_LINE;
    const l2 = document.createElement('div'); l2.textContent = `CWRV3 — ${BRAND_LINE}`;
    const repo = document.createElement('a');
    repo.className = 'credits-repo'; repo.href = REPO_URL; repo.target = '_blank'; repo.rel = 'noopener noreferrer';
    repo.title = 'CWRV3 source on GitHub (opens in a new tab)';
    const gh = document.createElement('span'); gh.className = 'credits-gh'; gh.setAttribute('aria-hidden', 'true');
    repo.append(gh, 'aDefaultUser/CWRV3');
    repo.setAttribute('aria-label', 'GitHub: aDefaultUser/CWRV3 (opens in a new tab)');
    const l3 = document.createElement('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = settings.bool('ext.config.brandWatermark');
    cb.onchange = () => edit(() => settings.set('ext.config.brandWatermark', cb.checked)); l3.append(cb, ' Show the Cloud Nuke watermark on the map and in captures');
    const sel = document.createElement('select');
    ['Top left', 'Top right', 'Bottom left', 'Bottom right'].forEach((n, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = n; sel.appendChild(o); });
    sel.value = String(settings.num('ext.config.brandWatermarkCorner')); sel.onchange = () => edit(() => settings.set('ext.config.brandWatermarkCorner', Number(sel.value)));
    const l4 = document.createElement('label'); l4.append('Watermark corner: ', sel);
    t.append(l1, l2, repo, l3, l4);
    box.append(logo, t);
    body.appendChild(box);
    // Corrected (non-parity) modes: fixes for recovered original behaviour, all off by default.
    const fix = document.createElement('div');
    fix.className = 'credits';
    const ft = document.createElement('div');
    ft.innerHTML = '<b>Corrected modes</b> <span class="hint">(off = original behaviour)</span>';
    for (const d of [...SETTING_DEFS.values()].filter((x) => x.section === 'WebCorrectedModes')) {
      const lab = document.createElement('label'), c = document.createElement('input');
      c.type = 'checkbox'; c.checked = settings.bool(d.id); c.onchange = () => edit(() => settings.set(d.id, c.checked));
      lab.append(c, ` ${d.label}`); ft.append(lab);
    }
    fix.append(ft);
    body.appendChild(fix);
  }
  closeDialog(name: string) { closeDialog(name); }
  /**
   * A write of a Settings dialog control that completes after an await (confirmation, file picker): one of the
   * dialog's edits while it is still open. Separate dialogs it opens (palettes, fonts, managers) keep their own edits.
   */
  private settingsDialogWrite(write: () => void) { if (isOpen('TFrmSettings')) settings.record(this.settingsEdits, write); else write(); }
  /** Cancel: reverts the dialog's own edits (other tabs' and other panels' changes are kept), then closes. */
  cancelSettings() { settings.revert(this.settingsEdits); closeDialog('TFrmSettings'); }
  /** Apply: saves now; the current values become what a later Cancel returns to. */
  applySettings() { this.settingsEdits.clear(); this.toast(settings.flush() ? 'Settings saved in this browser' : `Not saved: settings (${settings.saveError})`); }
  popPanel(panel: string, anchor: HTMLElement) {
    const id = `pop-${panel}`;
    const old = document.getElementById(id);
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.className = 'dlg'; box.id = id;
    const f = renderForm('TFrmMap', this.bindings.TFrmMap, { root: panel });
    const body = document.createElement('div'); body.className = 'dlg-body'; body.appendChild(f.el);
    box.appendChild(body);
    const r = anchor.getBoundingClientRect();
    box.style.left = `${r.left}px`; box.style.top = `${r.bottom + 2}px`;
    document.getElementById('app')!.appendChild(box);
    const close = (e: MouseEvent) => { if (!box.contains(e.target as Node) && e.target !== anchor) { box.remove(); f.destroy(); window.removeEventListener('mousedown', close); } };
    setTimeout(() => window.addEventListener('mousedown', close));
  }
  paletteSelector(id: string, label: string) {
    this.palTarget = { label, get: () => settings.str(id), set: (v) => settings.set(id, v) };
    closeDialog('TFrmPaletteSelector');
    openDialog('TFrmPaletteSelector', this.bindings.TFrmPaletteSelector, { extra: (b) => this.paletteList(b) });
  }
  arrayPaletteSelector(id: string, index: number, label: string) {
    this.palTarget = { label, get: () => settings.arr<string>(id)[index], set: (v) => { const a = [...settings.arr<string>(id)]; a[index] = v; settings.set(id, a); } };
    closeDialog('TFrmPaletteSelector');
    openDialog('TFrmPaletteSelector', this.bindings.TFrmPaletteSelector, { extra: (b) => this.paletteList(b) });
  }
  private paletteList(body: HTMLElement) {
    const sel = document.createElement('select');
    sel.style.cssText = 'width:140px;margin-top:4px;background:#0a1020';
    for (const n of paletteNames()) { const o = document.createElement('option'); o.textContent = n; sel.appendChild(o); }
    sel.value = this.palTarget?.get() ?? '';
    sel.onchange = () => this.palTarget?.set(sel.value);
    body.appendChild(sel);
  }
  currentRadarPaletteSelector() {
    if (settings.bool('layerState.NEXRADLevel2')) {
      const keys = ['settings.nexradLevel2ReflectivityPalette', 'settings.nexradLevel2BaseVelocityPalette', 'settings.nexradLevel2SpectrumWidthPalette', 'settings.nexradLevel2ZDRPalette', 'settings.nexradLevel2PHIPalette', 'settings.nexradLevel2CCPalette', 'settings.nexradLevel2BaseVelocityPalette', 'settings.nexradLevel2StormRelativeVelocityPalette', 'settings.nexradLevel2ShearPalette', 'settings.nexradLevel2G2GShearPalette', 'settings.nexradLevel2KDPPalette', 'settings.nexradLevel2MEHSPalette', 'settings.nexradLevel2POSHPalette', 'settings.nexradLevel2VILPalette', 'settings.nexradLevel2VILDPalette', 'settings.nexradLevel2ETPalette', 'settings.nexradLevel2GUSTPalette'];
      this.paletteSelector(keys[settings.num('layerState.NEXRADLevel2Product')], PRODUCTS.level2[settings.num('layerState.NEXRADLevel2Product')].name);
    } else this.paletteSelector(l3PaletteKey(L3[settings.num('layerState.NEXRADLevel3Product')]), L3[settings.num('layerState.NEXRADLevel3Product')].name);
  }
  alphaSelector(id: string, max = 255) {
    this.alphaTarget = { get: () => settings.num(id), set: (v) => settings.set(id, max === 255 ? Math.round(v) : v), max };
    closeDialog('TFrmAlphaSelector');
    openDialog('TFrmAlphaSelector', this.bindings.TFrmAlphaSelector);
  }
  toast(t: string) { toastFn(t); }
  /** Shared large-text viewer (TFrmStringDisplay). */
  viewerText = '';
  textViewer(title: string, text: string) {
    this.viewerText = text;
    closeDialog('TFrmStringDisplay');
    openDialog('TFrmStringDisplay', this.bindings.TFrmStringDisplay ?? {}, { title });
  }
  async textProduct(title: string, url: string) {
    this.textViewer(title, 'Downloading…');
    try { this.viewerText = await fetchText(url); } catch (e) { this.viewerText = `Text product unavailable: ${(e as Error).message}\n${url}`; }
  }
  popup(form: string, popupName: string, anchor: HTMLElement, actions: Record<string, MenuAction>, extra: MenuNode[] = []) {
    const r = anchor.getBoundingClientRect();
    const node = this.menuNode(form, popupName);
    showMenu(extra.length ? { ...node, children: [...node.children, ...extra] } : node, r.left, r.bottom, actions);
  }
  editStyle(name: string, title?: string) { openObjectStyle(this, name, title); }
  editText(name: string, which: 'appearance' | 'font') { openTextStyle(this, name, which); }
  /** Resolution adjust of a user shapefile style (TFrmStyleEditor −100..170): re-simplifies its geometry. */
  styleResolution(obj: string, res: number, clearCache = false) {
    const m = /^Shape:(\d+)$/.exec(obj);
    const i = m ? this.userShapes.items.findIndex((s) => s.id === Number(m[1])) : -1;
    if (i < 0) { if (clearCache) this.toast('This object is rebuilt from decoded data; there is no tile cache to clear.'); return; }
    this.userShapes.setResolution(i, res);
    if (clearCache) this.toast('Shapefile geometry rebuilt.');
  }
  async reloadModelConfigs() {
    const ml = (this as unknown as { model?: { reloadConfigs(): void; addUserConfig(f: string, t: string): void; configs: unknown[]; errors: string[] } }).model;
    if (!ml) return;
    const i = document.createElement('input'); i.type = 'file'; i.accept = '.config,.txt'; i.multiple = true;
    i.onchange = async () => { for (const f of i.files ?? []) ml.addUserConfig(f.name, await f.text()); this.toast(`${ml.configs.length} model configurations, ${ml.errors.length} errors`); };
    ml.reloadConfigs();
    this.toast(`Reloaded: ${ml.configs.length} model configurations, ${ml.errors.length} errors. Choose *.config files to add (optional).`);
    i.click();
  }
  modelErrors() { const ml = (this as unknown as { model?: { errors: string[] } }).model; return ml?.errors.length ? ml.errors.join('\n') : 'No configuration errors.'; }
  prompt(title: string, label: string, value = '') { return promptBox(title, label, value); }
  showText(title: string, text: string) {
    const d = document.createElement('div');
    d.className = 'dlg'; d.style.left = '120px'; d.style.top = '120px';
    const t = this.el('div', 'dlg-title', d, title);
    const x = this.el('span', 'x', t, '✕'); x.onclick = () => d.remove();
    const b = this.el('div', 'dlg-body', d); b.style.whiteSpace = 'pre-wrap'; b.style.maxWidth = '640px'; b.style.userSelect = 'text';
    b.textContent = text;
    document.getElementById('app')!.appendChild(d);
    drag(d, t);
  }

  // ------------------------------------------------------------------------------------------- menus
  private menuNode(form: string, popup: string): MenuNode { return formMenus(form).get(popup)!; }
  mainMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    showMenu(this.menuNode('TFrmMap', 'MainMenu'), r.left, r.bottom, mainMenuActions(this));
  }
  l2ProductMenu(anchor: HTMLElement) {
    if (!settings.bool('layerState.NEXRADLevel2')) return;
    const r = anchor.getBoundingClientRect();
    showMenu(this.menuNode('TRadarUIFrame', 'L2Prods'), r.left, r.bottom, l2ProductActions(this));
  }
  tracksMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    showMenu(this.menuNode('TRadarUIFrame', 'tracksPopup'), r.left, r.bottom, tracksMenuActions());
  }
  mlMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    showMenu(this.menuNode('TRadarUIFrame', 'mlPopup'), r.left, r.bottom, mlMenuActions(this));
  }
  private ctrlRightMenu(x: number, y: number, ll: [number, number] | null) {
    showMenu(this.menuNode('TFrmMap', 'CtrlRightClickMenu'), x, y, ctrlRightActions(this, ll));
  }

  // ------------------------------------------------------------------------------------------- actions
  setSite(id: string) {
    const icao = id.trim().toUpperCase();
    if (siteIndex(icao) === undefined) { this.toast(`${icao} is not a valid NEXRAD radar site. Choose from list or by clicking on-map interact-mode radar site labels.`); return; }
    settings.set('settings.nexradSiteICAO', icao);
    // Site index into the built-in table (derived, not stored by the original).
    settings.set('settings.nexradSiteIdx', siteIndex(icao)!);
  }
  private siteChanged() {
    const s = this.nexrad.siteInfo();
    this.siteEdit = settings.str('settings.nexradSiteICAO');
    this.toast('Radar site switched. Freeing all volumes.');
    this.nexrad.freeAll();
    this.sites.rebuild();
    if (s && settings.bool('config.radarSites.NewSiteSelectionCenter')) {
      this.renderer.camera.flyTo({ lon: s.lon, lat: s.lat, ...(settings.bool('config.radarSites.NewSiteSelectionZoomTo') ? { z: 18 } : {}) }, settings.num('config.generalCameraFlyDuration'), this.flyOpts());
    }
    this.refreshLayer('nexrad');
  }
  flyOpts() { return { jerk: settings.num('config.generalCameraFlyJerk'), end: settings.num('config.generalCameraFlyEndSmoothing'), nonLinear: settings.bool('config.generalCameraFlyNonLinear') }; }
  setLiveScan(on: boolean) {
    this.nexrad.liveScan = on;
    if (on) { settings.set('layerState.NEXRADLevel2', true); settings.set('layerState.NEXRADOn', true); this.nexrad.statusText = 'Live sweep activated'; }
    this.refreshLayer('nexrad');
  }
  setLiveComposite(on: boolean) {
    if (on && this.nexrad.siteInfo()?.type === 'TDWR') { this.toast('Live composite is not available on TDWR sites.'); return; }
    this.nexrad.liveComposite = on;
    if (on) { settings.set('layerState.NEXRADLevel2', true); settings.set('layerState.NEXRADOn', true); }
    this.nexrad.reloadProducts();
    this.renderFrame();
  }
  startMeasure(t: Tool) {
    this.tool = this.tool === t ? null : t;
    if (t === 'radial') { const s = this.nexrad.siteInfo(); this.annotations.radialOrigin = s ? [s.lon, s.lat] : null; }
    // Line/Path measurement: starting clears the previous measurement, toggling the tool off clears it too.
    if (t === 'line' || t === 'path') this.annotations.measure = [];
    if (t === 'manualTrack' && this.tool) { this.annotations.manualTrack = null; this.toast('Manual track: click the storm, or several points along a line; right-click to finish.'); }
    if (t === 'motion' && this.centerForMotion) { const s = this.nexrad.siteInfo(); if (s) this.renderer.camera.flyTo({ lon: s.lon, lat: s.lat }, 800); }
    this.canvas.style.cursor = this.tool ? 'crosshair' : '';
    this.annotations.dirty = true;
    this.poke();
  }
  /** One map click delivers a lon/lat to `done` (annotation and label placement). */
  private placeCallback: ((ll: [number, number]) => void) | null = null;
  pickOnMap(kind: 'annotate' | 'labelPlace', hint: string, done: (ll: [number, number]) => void) {
    this.placeCallback = done; this.tool = kind; this.canvas.style.cursor = 'crosshair'; this.toast(hint);
  }
  clearMeasure() { this.annotations.measure = []; this.annotations.radial = null; this.annotations.dirty = true; this.poke(); }
  clearManualTrack() { this.annotations.manualTrack = null; if (this.tool === 'manualTrack') this.tool = null; this.canvas.style.cursor = ''; this.annotations.dirty = true; this.poke(); }
  toggleTelestration() { this.tool = this.tool === 'telestrate' ? null : 'telestrate'; this.canvas.style.cursor = this.tool ? 'crosshair' : ''; }
  clearTelestration() { this.annotations.telestration = []; this.annotations.dirty = true; this.poke(); }
  flyToKm(x: number, y: number) { const s = this.nexrad.siteInfo(); if (s) this.renderer.camera.flyTo({ lon: s.lon + x / (111.2 * Math.cos((s.lat * Math.PI) / 180)), lat: s.lat + y / 111.2, z: 6 }, settings.num('config.generalCameraFlyDuration'), this.flyOpts()); }
  flyToViewpoint(i: number) {
    if (i === 0) { const p = settings.arr<number>('config.defaultCameraPt'); this.renderer.camera.flyTo({ lon: p[0], lat: p[1], z: p[2], tilt: p[3], swivel: 0 }, settings.num('config.generalCameraFlyDuration'), this.flyOpts()); return; }
    const v = viewpoints.list[i - 1];
    if (v) this.renderer.camera.flyTo(v.view, settings.num('config.generalCameraFlyDuration'), this.flyOpts());
  }
  private viewTimer: ReturnType<typeof setInterval> | null = null;
  toggleViewPlay() {
    this.viewPlaying = !this.viewPlaying;
    if (this.viewTimer) clearInterval(this.viewTimer);
    this.viewTimer = null;
    if (this.viewPlaying) {
      let i = 0;
      const step = () => { const n = viewpoints.list.length + 1; this.flyToViewpoint(i % n); i++; };
      step();
      this.viewTimer = setInterval(step, settings.num('config.generalViewPlayInterval') * 1000);
    }
  }
  setDefaultView() { const c = this.renderer.camera.target; settings.set('config.defaultCameraPt', [c.lon, c.lat, c.z, c.tilt]); this.toast('Current view set as default'); }
  async confirmReset(doc: 'CWRV3Settings' | 'CWRV3ConfigurationSettings') {
    const ok = await this.prompt('Confirm', doc === 'CWRV3Settings' ? 'Are you sure? This will reset to default layer/map settings. Type YES to confirm.' : 'Reset the configuration to defaults? Type YES to confirm.');
    if (ok?.toUpperCase() === 'YES') { this.settingsDialogWrite(() => settings.resetDocument(doc)); this.toast('Defaults restored'); }
  }
  clearAllLayers() {
    for (const d of SETTING_DEFS.values()) if (d.owner === 'LayerState' && d.type === 'boolean' && d.id.endsWith('On')) settings.set(d.id, false);
    settings.set('layerState.NationalRadarOn', false); settings.set('layerState.SatelliteOn', false);
  }
  fullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); }
  glmStatus() {
    const l = this.lightning;
    const newest = l.newestMs ? new Date(l.newestMs) : null;
    return `Strike data last updated: ${newest ? newest.toLocaleTimeString() : '-'}\nTime of newest strike: ${l.flashes.length ? new Date(Math.max(...l.flashes.map((f) => f.t))).toLocaleTimeString() : '-'}\nCurrent real-time data feed delay: ${newest ? `${Math.round((Date.now() - newest.getTime()) / 1000)} s` : '-'}`;
  }
  satBand() { return SAT_BANDS[settings.num('layerState.SatelliteProductIndex')]?.[0] ?? 14; }
  alertList(kind: 'warnings' | 'watches') {
    const t = timeline.t;
    let list = kind === 'warnings' ? this.warnings.activeAt(t) : this.warnings.watchesAt(t);
    list = [...list].sort((a, b) => (settings.bool('settings.severeWarningsMessageOrderNewestFirst') ? b.sent - a.sent : a.sent - b.sent));
    return list.map((a) => ({ alert: a, label: kind === 'warnings' ? `${a.type?.code}  ${a.wfo}  ${a.etn}  ${new Date(a.sent).toLocaleTimeString()}  ${new Date(a.ends).toLocaleTimeString()}` : `${a.event.startsWith('Tornado') ? 'TOR' : 'SVR'}  ${a.etn}  ${new Date(a.sent).toLocaleTimeString()}  ${new Date(a.ends).toLocaleTimeString()}` }));
  }
  zoomToAlert(a?: Alert) {
    if (!a?.rings[0]) return;
    let x = 0, y = 0, n = 0;
    for (let i = 0; i < a.rings[0].length; i += 2) { x += a.rings[0][i]; y += a.rings[0][i + 1]; n++; }
    this.renderer.camera.flyTo({ lon: x / n, lat: y / n, z: 8 }, settings.num('config.generalCameraFlyDuration'), this.flyOpts());
  }
  outputSizeLabel() { const g = this.renderer.gpu; return this.outputSize ? `${this.outputSize[0]}x${this.outputSize[1]}` : `${g.width}x${g.height}`; }
  async setOutputSize() {
    // Suggests the configured default output size (Settings → Video) when no fixed size is set.
    const def = settings.arr<number>('config.videoDefaultSize');
    const v = await promptBox('Set output size', `Backbuffer size WxH (empty = follow the window; default ${def[0]}x${def[1]}):`, (this.outputSize ?? def).join('x'));
    if (v === null) return;
    const m = /^(\d+)\s*x\s*(\d+)$/i.exec(v.trim());
    this.outputSize = m ? [Number(m[1]), Number(m[2])] : null;
    this.renderer.gpu.fixedSize = this.outputSize;
    this.renderer.gpu.resize();
    this.poke();
  }
  /**
   * Composites the rendered map with the on-map overlays (legend, timestamp, product time labels, lightning count,
   * custom logo, PNG overlay and the Cloud Nuke watermark) into a 2D canvas at the backbuffer size, so PNG and
   * video exports carry the same information as the live view. Call right after renderer.frame().
   */
  composeFrame(target?: HTMLCanvasElement): HTMLCanvasElement {
    const g = this.renderer.gpu, W = g.width, H = g.height;
    const out = target ?? document.createElement('canvas');
    if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
    const c = out.getContext('2d')!;
    c.drawImage(this.canvas, 0, 0, W, H);
    const ov = document.getElementById('overlay')!;
    const cssW = ov.clientWidth || this.canvas.clientWidth || W;
    const k = W / cssW; // CSS px → backbuffer px
    const h = this.hud;
    const visible = (e: HTMLElement) => e.style.display !== 'none' && e.offsetParent !== null;
    if (h.legend.width && h.legend.clientHeight) c.drawImage(h.legend, 0, 0, h.legend.clientWidth * k, h.legend.clientHeight * k);
    const text = (e: HTMLElement) => {
      if (!visible(e) || !e.textContent) return;
      const cs = getComputedStyle(e);
      const size = parseFloat(cs.fontSize) * k;
      c.font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`;
      c.textBaseline = 'top'; c.lineJoin = 'round';
      const ls = parseFloat(cs.letterSpacing) || 0;
      (c as unknown as { letterSpacing: string }).letterSpacing = `${ls * k}px`;
      const lines = e.textContent.split('\n');
      lines.forEach((line, i) => {
        const x = (e.offsetLeft + (parseFloat(cs.paddingLeft) || 0)) * k, y = (e.offsetTop + (parseFloat(cs.paddingTop) || 0)) * k + i * size * 1.25;
        c.lineWidth = Math.max(2, size * 0.22); c.strokeStyle = 'rgba(0,0,0,0.9)'; c.strokeText(line, x, y);
        c.fillStyle = cs.color; c.fillText(line, x, y);
      });
      (c as unknown as { letterSpacing: string }).letterSpacing = '0px';
    };
    text(h.time); text(h.maplabel); text(h.strikes); text(h.watchBox);
    const img = (e: HTMLImageElement | null) => { if (e && e.complete && e.naturalWidth && visible(e)) c.drawImage(e, e.offsetLeft * k, e.offsetTop * k, e.offsetWidth * k, e.offsetHeight * k); };
    const li = h.logo.querySelector('img');
    if (li && li.complete && li.naturalWidth && visible(h.logo)) c.drawImage(li, h.logo.offsetLeft * k, h.logo.offsetTop * k, li.offsetWidth * k, li.offsetHeight * k);
    img(h.overlay);
    // Graphics-output recording with "include cursor": draw the pointer where the mouse is over the map.
    if (this.recordCanvas === out && settings.bool('config.videoGDICursor') && this.mouse) drawCursor(c, this.mouse[0] * k, this.mouse[1] * k, k);
    if (settings.bool('ext.config.brandWatermark')) {
      const tile = watermarkTile(k);
      if (tile) { const [x, y] = this.brandPos(tile.width / k, tile.height / k, cssW, ov.clientHeight); c.drawImage(tile, x * k, y * k); }
    }
    return out;
  }
  /** Watermark position (CSS px): its corner, stacked above / below a custom logo that uses the same corner. */
  brandPos(w: number, h: number, W: number, H: number): [number, number] {
    const corner = settings.num('ext.config.brandWatermarkCorner');
    let stack = 0;
    if (settings.bool('config.logoCustom') && this.logoUrl && settings.num('config.logoCorner') === corner) stack = (this.hud.logo.offsetHeight || 0) + settings.arr<number>('config.logoOffset')[1] + 6;
    return cornerPos(corner, W, H, w, h, 10, stack);
  }
  /** Whole-screen capture source (Settings → Video "Capture whole screen"): the browser's screen-sharing picker. */
  private async screenStream(fps: number, currentTab = false): Promise<MediaStream | null> {
    // "Include cursor" maps to the display-capture cursor constraint (Chromium honours it).
    const video = { frameRate: fps, cursor: settings.bool('config.videoGDICursor') ? 'always' : 'never' } as MediaTrackConstraints;
    try { return await navigator.mediaDevices.getDisplayMedia({ video, audio: false, ...(currentTab ? { preferCurrentTab: true, selfBrowserSurface: 'include' } : {}) } as DisplayMediaStreamOptions); }
    catch (e) { this.toast(`Screen capture not started: ${(e as Error).message}`); return null; }
  }
  async captureImage() {
    if (settings.bool('ext.config.videoWholeScreen')) {
      const stream = await this.screenStream(5);
      if (!stream) return;
      const v = document.createElement('video'); v.srcObject = stream; v.muted = true; await v.play();
      await new Promise((r) => requestAnimationFrame(r));
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d')!.drawImage(v, 0, 0);
      for (const t of stream.getTracks()) t.stop();
      c.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `cwrv3-screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`; a.click(); }, 'image/png');
      return;
    }
    this.renderer.frame();
    this.composeFrame().toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `cwrv3-${new Date().toISOString().replace(/[:.]/g, '-')}.png`; a.click(); }, 'image/png');
  }
  async toggleVideo() {
    if (this.recorder) { this.recorder.stop(); return; }
    const fps = settings.bool('config.video60FPSOut') ? 60 : 30;
    // Record the composited frame (map + overlays + watermark), refreshed after every rendered frame, or the screen.
    // Sources: whole screen (picker), this window with its UI (current-tab capture), or the composited graphics output.
    const whole = settings.bool('ext.config.videoWholeScreen'), win = !whole && settings.bool('config.videoWholeWindow');
    const screen = whole || win ? await this.screenStream(fps, win) : null;
    if ((whole || win) && !screen) return;
    if (!screen) this.recordCanvas = this.composeFrame();
    const stream = screen ?? this.recordCanvas!.captureStream(fps);
    const chunks: Blob[] = [];
    const { mimeType, ext } = videoFormat(settings.bool('config.videoMPEGPart10'), (t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.round(40e6 / settings.num('config.videoCompression')) });
    // Window capture with "show box": outline the captured window while recording.
    if (win && settings.bool('config.videoGDIBox')) document.getElementById('app')!.classList.add('recording-box');
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      for (const t of screen?.getTracks() ?? []) t.stop();
      this.recorder = null; this.recording = false; this.recordCanvas = null;
      document.getElementById('app')!.classList.remove('recording-box');
      const url = URL.createObjectURL(new Blob(chunks, { type: mimeType.split(';')[0] }));
      const a = document.createElement('a'); a.href = url; a.download = `cwrv3-${Date.now()}.${ext}`; a.click();
      if (settings.bool('config.videoWatchAfter')) window.open(url, '_blank');
    };
    // Ending the share from the browser's own control stops the recording too.
    screen?.getVideoTracks()[0]?.addEventListener('ended', () => { if (rec.state !== 'inactive') rec.stop(); });
    rec.start(500);
    this.recorder = rec; this.recording = true;
  }
  async pickFiles(accept: string): Promise<File[]> {
    return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = true; i.onchange = () => res([...(i.files ?? [])]); i.click(); });
  }
  async pickFile(accept: string): Promise<File | null> {
    return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files?.[0] ?? null); i.click(); });
  }
  /** Custom background image or world file (Settings → Background). */
  async pickCustomBackground(kind: 'image' | 'world') {
    const f = await this.pickFile(kind === 'image' ? 'image/*' : '.wld,.pgw,.jgw,.tfw,.gfw,.bpw,.txt');
    if (!f) return;
    await this.customBg.store(kind, f, (write) => this.settingsDialogWrite(write));
    if (this.customBg.error) this.toast(`Custom background: ${this.customBg.error}`);
    else if (this.customBg.enabled()) this.toast('Custom background loaded');
    this.poke();
  }
  // Custom logo and PNG overlay images are kept in Cache Storage so they survive a reload with their settings.
  async pickLogo() { const f = await this.pickFile('image/*'); if (f) { this.logoUrl = URL.createObjectURL(f); this.hud.logo.textContent = ''; this.settingsDialogWrite(() => settings.set('config.logoCustom', true)); await storeUserFile('/user-files/logo', f, `logo ${f.name}`); } }
  async pickOverlay() { const f = await this.pickFile('image/png'); if (f) { this.overlayUrl = URL.createObjectURL(f); this.settingsDialogWrite(() => { settings.set('config.overlayPath', f.name); settings.set('config.overlayActive', true); }); await storeUserFile('/user-files/overlay', f, `overlay ${f.name}`); } }
  private async restoreUserImages() {
    [this.logoUrl, this.overlayUrl] = await Promise.all([userFileUrl('/user-files/logo'), userFileUrl('/user-files/overlay')]);
  }
  async loadPaletteFiles() { const f = await this.pickFile('.wspal,.txt'); if (f) { try { const { palette, saved } = registerPalette(await f.text()); if (saved) this.toast(`Palette ${palette.name} loaded and saved in this browser`); } catch (e) { this.toast(String((e as Error).message)); } } }
  async cacheSize() { const e = await navigator.storage?.estimate?.(); this.toast(e ? `Cache/storage use: ${((e.usage ?? 0) / 1e6).toFixed(1)} MB of ${((e.quota ?? 0) / 1e9).toFixed(1)} GB` : 'Storage estimate unavailable'); }
  async clearCache() { await caches.delete(DATA_CACHE); settings.set('config.lastCacheClear', Date.now()); this.toast('Cached data cleared'); }
  exportViewpoints() { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(viewpoints.list, null, 1)], { type: 'application/json' })); a.download = 'viewpoints.json'; a.click(); }
  async importViewpoints(replace: boolean) { const f = await this.pickFile('.json'); if (!f) return; const list = JSON.parse(await f.text()); if (Array.isArray(list)) viewpoints.replace(replace ? list : [...viewpoints.list, ...list]); }
  saveScene() {
    const m = sceneMask.list;
    this.prompt('Scene preset', 'Name of the new scene preset:').then((name) => {
      if (!name) return;
      scenePresets.add({
        name, view: m[0] ? { ...this.renderer.camera.target } : undefined, layers: m[2] ? settings.layerState() : undefined,
        timeline: m[4] ? { t: timeline.t, playing: timeline.playing } : undefined,
        overlay: m[6] ? { active: settings.bool('config.overlayActive'), path: settings.str('config.overlayPath'), pt: settings.arr<number>('config.overlayPt') } : undefined,
      });
    });
  }
  applyScene(i: number) {
    const p = scenePresets.list[i];
    if (!p) return;
    const m = sceneMask.list;
    if (p.view && m[1]) this.renderer.camera.flyTo(p.view, settings.num('config.generalCameraFlyDuration'), this.flyOpts());
    if (p.layers && m[3]) settings.applyLayerState(p.layers);
    if (p.timeline && m[5]) { timeline.t = p.timeline.t; timeline.play(p.timeline.playing); }
    if (p.overlay && m[7]) { settings.set('config.overlayActive', p.overlay.active); settings.set('config.overlayPt', p.overlay.pt); }
  }
  reloadGis() { const g = this.layers.get('gis') as GisLayer; g.load(); }
  private STATES = ['01', '02', '04', '05', '06', '08', '09', '10', '11', '12', '13', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '44', '45', '46', '47', '48', '49', '50', '51', '53', '54', '55', '56'];
  /** TIGER/Line 2021 road downloads (TFrmRoadsControl), restored from the persisted list at start-up. */
  private roadDownloads = loadPref<{ key: string; label: string; url: string }[]>('roadDownloads', [], isArray);
  private saveRoadDownloads() { return savePref('roadDownloads', this.roadDownloads, 'downloaded road list'); }
  private async fetchRoads(d: { key: string; label: string; url: string }) {
    const res = await pool.for('roads').run('zipLines', { url: d.url, tol: d.key.startsWith('county:') ? 0.00008 : 0.0005, classField: 'RTTYP', nameField: 'FULLNAME' });
    this.roads.groups.set(d.key, { label: d.label, lines: res.parts.map((p: number[], i: number) => ({ coords: p, style: res.cls[i] })), names: res.names });
    this.roads.rebuild(); this.poke();
  }
  restoreRoadDownloads() { for (const d of this.roadDownloads) this.fetchRoads(d).catch((e) => this.toast(`${d.label}: ${(e as Error).message}`)); }
  private async downloadRoads(d: { key: string; label: string; url: string }) {
    if (this.roads.groups.has(d.key)) return;
    // "Show downloader": open the progress dialog for the GIS download; "computation notification": status texts.
    if (settings.bool('config.geoShowDownloader')) this.dialog('TFrmDownloader');
    const note = settings.bool('config.geoTextNotification');
    if (note) this.toast(`Downloading TIGER/Line 2021 roads for ${d.label}…`);
    try { await this.fetchRoads(d); this.roadDownloads.push(d); this.saveRoadDownloads(); if (note) this.toast(`${d.label}: road geometry computed and loaded`); }
    catch (e) { this.toast(`Road download failed: ${(e as Error).message}`); }
  }
  get secondaryStates() { return this.roadDownloads.filter((d) => d.key.startsWith('state:')).map((d) => d.label); }
  get countyStreets() { return this.roadDownloads.filter((d) => d.key.startsWith('county:')).map((d) => d.label); }
  stateName(i: number) { return formDef('TFrmRoadsControl').controls.find((c) => c.name === 'sComboBox2')?.items?.[i] ?? this.STATES[i]; }
  downloadSecondaryRoads() {
    const fips = this.STATES[this.roadState];
    if (fips) return this.downloadRoads({ key: `state:${fips}`, label: this.stateName(this.roadState), url: `https://www2.census.gov/geo/tiger/TIGER2021/PRISECROADS/tl_2021_${fips}_prisecroads.zip` });
  }
  /** Removes one downloaded road set (by list label), or all sets of a kind when no label is given. */
  removeRoads(kind: 'state' | 'county', label?: string) {
    this.roadDownloads = this.roadDownloads.filter((d) => !(d.key.startsWith(kind + ':') && (label === undefined || d.label === label)));
    for (const k of [...this.roads.groups.keys()]) if (k.startsWith(kind + ':') && !this.roadDownloads.some((d) => d.key === k)) this.roads.groups.delete(k);
    this.saveRoadDownloads(); this.roads.rebuild(); this.poke();
  }
  clearSecondaryRoads() { this.removeRoads('state'); }
  // County local streets: state picked in sComboBox1, county list from the Census national county file.
  countyState = 36;
  countyIdx = 0;
  private countyCache: { fips: string; name: string }[][] | null = null;
  counties: { fips: string; name: string }[] = [];
  async loadCounties() {
    if (!this.countyCache) {
      const txt = await fetchText('https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt', { cache: 'immutable' });
      this.countyCache = this.STATES.map(() => []);
      for (const line of txt.split('\n').slice(1)) {
        const f = line.split('|');
        const si = this.STATES.indexOf(f[1]);
        if (si >= 0 && f[2]) this.countyCache[si].push({ fips: f[1] + f[2], name: f[4] });
      }
    }
    this.counties = this.countyCache[this.countyState] ?? [];
    this.countyIdx = 0;
  }
  downloadCountyStreets() {
    const c = this.counties[this.countyIdx];
    if (!c) { this.toast('Pick a state, then a county'); return; }
    return this.downloadRoads({ key: `county:${c.fips}`, label: `${c.name}, ${this.stateName(this.countyState)}`, url: `https://www2.census.gov/geo/tiger/TIGER2021/ROADS/tl_2021_${c.fips}_roads.zip` });
  }

  // Road-name labeling (Alt+L, Spatial Tools): mode 0 rollover text, 1 placed labels, 2 both; config.roadLabelWorld
  // draws placed labels as map text instead of screen-space boxes.
  roadNaming = false;
  toggleRoadNaming() {
    this.roadNaming = !this.roadNaming;
    if (this.roadNaming && !this.roads.groups.size) this.toast('Road names come from downloaded state/county road sets (GIS ▸ Manage Roads…)');
    if (!this.roadNaming) this.hud.roadTip.style.display = 'none';
  }
  clearRoadLabels() { this.roads.labels = []; this.roads.saveLabels(); }
  private roadLabelEls: HTMLElement[] = [];
  private updateRoadLabels() {
    const world = settings.bool('config.roadLabelWorld');
    const want = world || !this.roads.enabled() ? 0 : this.roads.labels.length;
    while (this.roadLabelEls.length > want) this.roadLabelEls.pop()!.remove();
    while (this.roadLabelEls.length < want) {
      const el = this.el('div', 'hud-roadlabel', this.hud.cityList.parentElement!);
      const i = this.roadLabelEls.length;
      // Screen-space labels can be dragged away from their road point (offset persisted).
      drag(el, el, (x, y) => { const l = this.roads.labels[i]; const p = this.renderer.camera.project(lonLatToXYZ(l.lon, l.lat)); l.dx = x - p[0]; l.dy = y - p[1]; this.roads.saveLabels(); });
      this.roadLabelEls.push(el);
    }
    const css = textCss('RoadLabels');
    this.roadLabelEls.forEach((el, i) => {
      const l = this.roads.labels[i];
      const [x, y, front] = this.renderer.camera.project(lonLatToXYZ(l.lon, l.lat));
      if (el.textContent !== l.name) { el.textContent = l.name; Object.assign(el.style, css); }
      el.style.display = front ? '' : 'none';
      el.style.left = `${x + l.dx}px`; el.style.top = `${y + l.dy}px`;
    });
  }
  async addShapefile() {
    const f = await this.pickFile('.zip,.tar,.tgz,.geojson,.json');
    if (!f) return;
    try { const n = await this.userShapes.add(f); this.toast(`${f.name}: ${n} shapes`); }
    catch (e) { this.toast(`${f.name}: ${(e as Error).message}`); }
  }
  removeShapefile() { if (this.userShapes.selected >= 0) this.userShapes.remove(this.userShapes.selected); }
  diagnostics() {
    const g = this.renderer.gpu;
    const fps = settings.num('config.generalActiveFPS');
    const lines = [`CWRV3 · ${navigator.userAgent}`, `FPS target: ${fps > 0 ? fps : 'unlimited'} (display refresh ≈ ${(1000 / this.pacer.period).toFixed(1)} Hz)`, `Settings storage: ${settings.saveError ? `last save failed (${settings.saveError})` : settings.pending ? 'changes pending' : 'saved'}`, `GPU adapter: ${g.info.vendor} / ${g.info.architecture} / ${g.info.description} (fallback: ${g.info.isFallback})`, `Backbuffer: ${g.width}x${g.height} @ DPR ${g.dpr.toFixed(2)}, MSAA ${g.sampleCount}`, `Timestamp queries: ${g.timestamps}`];
    for (const l of this.layers.values()) if ('status' in l) lines.push(`${l.id}: ${(l as MapLayer).status.state} ${(l as MapLayer).status.text}`);
    lines.push(this.nexrad.envStatus());
    const tasks = pool.stats.slice(-40).map((s) => `${s.task} ${s.ms.toFixed(0)} ms ${s.ok ? '' : 'FAILED'}`);
    return [...lines, '', 'Recent worker tasks:', ...tasks].join('\n');
  }

  // ------------------------------------------------------------------------------------------- input
  poke() { this.lastInteract = performance.now(); }

  private wireInput() {
    const cv = this.canvas, cam = this.renderer.camera;
    let drag: null | { mode: 'pan' | 'tilt' | 'zoom' | 'box' | 'tele'; x: number; y: number; moved: boolean; button: number; ctrl: boolean } = null;
    let boxEl: HTMLDivElement | null = null;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', (e) => {
      this.poke();
      const ctrl = e.ctrlKey;
      if (this.tool === 'telestrate' && e.button === 0) { drag = { mode: 'tele', x: e.offsetX, y: e.offsetY, moved: false, button: 0, ctrl }; this.annotations.telestration.push([]); return; }
      const mode = e.button === 0 ? (ctrl && !settings.bool('config.generalCameraDisableTiltSwivel') ? 'tilt' : 'pan') : e.button === 2 ? (ctrl ? 'box' : 'zoom') : 'pan';
      drag = { mode, x: e.offsetX, y: e.offsetY, moved: false, button: e.button, ctrl };
    });
    window.addEventListener('mousemove', (e) => {
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (!drag) return;
      const dx = x - drag.x, dy = y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      this.poke();
      const t = cam.target;
      if (drag.mode === 'pan') {
        const mpp = cam.metersPerPixel() * settings.num('config.generalCameraPanSensitivity');
        const h = (t.swivel * Math.PI) / 180;
        const ex = -dx * Math.cos(h) - dy * Math.sin(h), ny = dy * Math.cos(h) - dx * Math.sin(h);
        cam.setView({ lon: t.lon + (ex * mpp) / (111320 * Math.max(0.05, Math.cos((t.lat * Math.PI) / 180))), lat: t.lat + (ny * mpp) / 110540 });
        drag.x = x; drag.y = y;
      } else if (drag.mode === 'tilt') {
        cam.setView({ tilt: t.tilt + dy * 0.25, swivel: t.swivel - dx * 0.3 });
        drag.x = x; drag.y = y;
      } else if (drag.mode === 'zoom') {
        cam.setView({ z: t.z * Math.pow(1.01, dy * settings.num('config.generalCameraZoomSensitivity')) });
        drag.x = x; drag.y = y;
      } else if (drag.mode === 'box') {
        if (!boxEl) { boxEl = document.createElement('div'); boxEl.style.cssText = 'position:absolute;border:1px dashed #fff;background:rgba(80,140,255,.15);pointer-events:none'; document.getElementById('overlay')!.appendChild(boxEl); }
        boxEl.style.left = `${Math.min(x, drag.x)}px`; boxEl.style.top = `${Math.min(y, drag.y)}px`; boxEl.style.width = `${Math.abs(dx)}px`; boxEl.style.height = `${Math.abs(dy)}px`;
      } else if (drag.mode === 'tele') {
        const ll = cam.pick(x, y);
        if (ll) { this.annotations.telestration[this.annotations.telestration.length - 1].push(ll); this.annotations.dirty = true; }
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (!drag) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const d = drag; drag = null;
      if (d.mode === 'box') {
        boxEl?.remove(); boxEl = null;
        const ll = cam.pick((x + d.x) / 2, (y + d.y) / 2);
        const frac = Math.max(Math.abs(x - d.x) / cam.width, Math.abs(y - d.y) / cam.height);
        if (ll && frac > 0.01) cam.flyTo({ lon: ll[0], lat: ll[1], z: cam.target.z * frac }, settings.num('config.generalZoomBoxCameraFlyDuration'), this.flyOpts());
        return;
      }
      if (!d.moved && e.target === cv) this.click(x, y, d.button, d.ctrl, e.clientX, e.clientY);
    });
    cv.addEventListener('dblclick', (e) => {
      if (settings.num('config.clickZoom') !== 1) return;
      const ll = cam.pick(e.offsetX, e.offsetY);
      if (ll) cam.flyTo({ lon: ll[0], lat: ll[1], z: cam.target.z / 2.5 }, settings.num('config.generalZoomBoxCameraFlyDuration'), this.flyOpts());
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.poke();
      // One-time zoom hint (General/ZoomMessageShown): shown on the first wheel zoom, then remembered.
      if (!settings.bool('settings.generalZoomMessage')) { settings.set('settings.generalZoomMessage', true); this.toast('Zoom: wheel or right-drag; Ctrl+right-drag draws a zoom box; Ctrl+left-drag tilts the view.'); }
      const t = cam.target;
      const k = Math.pow(1.0018, e.deltaY * settings.num('config.generalCameraZoomSensitivity'));
      const ll = cam.pick(e.offsetX, e.offsetY);
      const z = t.z * k;
      if (ll && k < 1) {
        let dl = ll[0] - t.lon; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
        cam.setView({ z, lon: t.lon + dl * (1 - k), lat: t.lat + (ll[1] - t.lat) * (1 - k) });
      } else cam.setView({ z });
    }, { passive: false });
    cv.addEventListener('mousemove', (e) => {
      this.mouse = [e.offsetX, e.offsetY];
      this.sites.mouse = this.mouse;
      if (settings.num('config.generalMapMode') === 2) { this.renderer.probeRequest = { x: e.offsetX, y: e.offsetY }; this.cpuProbe = this.objectInfo(e.offsetX, e.offsetY); }
      if (this.tool === 'radial' && this.annotations.radialOrigin) { const ll = cam.pick(e.offsetX, e.offsetY); if (ll) { this.annotations.radial = ll; this.annotations.dirty = true; } }
      if (settings.num('config.generalMapMode') === 1) this.rollover(e.offsetX, e.offsetY);
      if (this.roadNaming && settings.num('config.roadLabelMode') !== 1) {
        const hit = this.roads.nameAt(e.offsetX, e.offsetY), tip = this.hud.roadTip;
        tip.style.display = hit ? '' : 'none';
        if (hit) { if (tip.textContent !== hit.name) { tip.textContent = hit.name; Object.assign(tip.style, textCss('RoadLabels')); } tip.style.left = `${e.offsetX + 12}px`; tip.style.top = `${e.offsetY - 22}px`; }
      }
      this.poke();
    });
    cv.addEventListener('mouseleave', () => { this.mouse = null; this.sites.mouse = null; this.hud.probe.style.display = 'none'; this.hud.cross.style.display = 'none'; this.hud.tip.style.display = 'none'; });
  }

  private click(x: number, y: number, button: number, ctrl: boolean, cx: number, cy: number) {
    const cam = this.renderer.camera;
    const ll = cam.pick(x, y);
    if (ll) this.lastClickLL = ll;
    if (button === 2 && ctrl) { this.ctrlRightMenu(cx, cy, ll); return; }
    if (this.roadNaming && button === 0 && settings.num('config.roadLabelMode') >= 1) {
      const hit = this.roads.nameAt(x, y);
      if (hit) { this.roads.labels.push({ lon: hit.lon, lat: hit.lat, name: hit.name, dx: 8, dy: -10 }); this.roads.saveLabels(); return; }
    }
    if (this.tool && ll) {
      if (this.tool === 'line') { this.annotations.measure.push(ll); if (this.annotations.measure.length > 2) this.annotations.measure = [this.annotations.measure[1], ll]; }
      else if (this.tool === 'path') { if (button === 2) this.tool = null; else this.annotations.measure.push(ll); }
      else if (this.tool === 'radial') this.tool = null;
      else if (this.tool === 'manualTrack') {
        // Left clicks add front points (one point tracks a cell, several a squall line/path); right-click finishes.
        // The track moves with the storm-motion vector in use and is timed from the displayed time.
        const mt = this.annotations.manualTrack;
        if (button === 2) { if (mt?.pts.length) { mt.done = true; this.tool = null; } }
        else if (!mt || mt.done) this.annotations.manualTrack = { pts: [ll], t0: timeline.t, motion: this.nexrad.stormMotion(), done: false };
        else mt.pts.push(ll);
      } else if (this.tool === 'motion') {
        const s = this.nexrad.siteInfo();
        if (s) { settings.set('settings.nexradStormMotionCustom', true); settings.set('settings.nexradStormMotionAzimuth', Math.round((bearingDeg(ll[0], ll[1], s.lon, s.lat) + 360) % 360)); settings.set('settings.nexradStormMotionSpeed', Math.round(Math.min(180, gcDistanceKm(s.lon, s.lat, ll[0], ll[1]) / 3))); }
        this.tool = null;
      } else if (this.tool === 'annotate' || this.tool === 'labelPlace') {
        const done = this.placeCallback; this.placeCallback = null; this.tool = null;
        done?.(ll);
      } else if (this.tool === 'light') { settings.set('config.bgLightCenter', false); settings.set('config.bgLightPointX', x / cam.width); settings.set('config.bgLightPointY', y / cam.height); this.tool = null; }
      this.annotations.dirty = true;
      if (!this.tool) this.canvas.style.cursor = '';
      return;
    }
    if (settings.num('config.clickZoom') === 2 && button === 0 && ll) { cam.flyTo({ lon: ll[0], lat: ll[1], z: cam.target.z / 2.5 }, settings.num('config.generalZoomBoxCameraFlyDuration'), this.flyOpts()); return; }
    if (settings.num('config.generalMapMode') !== 1) return; // Explore: no object interaction
    if (settings.bool('settings.nexradSitesOn')) {
      const id = this.sites.hit(x, y);
      if (id) {
        if (id === settings.str('settings.nexradSiteICAO')) { if (settings.bool('config.radarSites.CurrentClickRecenter')) { const s = RADAR_SITES.find((q) => q.id === id)!; cam.flyTo({ lon: s.lon, lat: s.lat }, 800); } }
        else settings.set('settings.nexradSiteICAO', id);
        return;
      }
    }
    const marine = this.layers.get('marine') as unknown as { enabled(): boolean; probeAt(lon: number, lat: number, x: number, y: number): string[] | null } | undefined;
    if (marine?.enabled() && ll) { const info = marine.probeAt(ll[0], ll[1], x, y); const id = info?.[1]?.replace('Station: ', ''); if (id && info?.[0] === 'Buoy Observation') { (this as unknown as { openBuoy: (id: string) => void }).openBuoy(id); return; } }
    const a = this.warnings.hit(x, y, timeline.t);
    if (a) {
      if (button === 0 && settings.bool('settings.severeWarningsLeftClickInfoBox')) this.selectedAlert = this.selectedAlert === a ? null : a;
      if (button === 2 && settings.bool('settings.severeWarningsRightClickFullText')) this.showText(a.event, `${a.headline}\n\n${a.description}`);
      return;
    }
    // NWS advisories layer on: a click on the map lists the active alerts of that point's forecast zone.
    if (settings.bool('layerState.NWSAdvisoriesOn') && ll && button === 0 && !this.cellTracking) { void this.openZoneAlerts(ll[0], ll[1]); return; }
    if (this.cellTracking && this.nexrad.scit.length) {
      const s = this.nexrad.siteInfo();
      if (s && ll) {
        const kx = (ll[0] - s.lon) * 111.2 * Math.cos((s.lat * Math.PI) / 180), ky = (ll[1] - s.lat) * 111.2;
        const c = this.nexrad.scit.find((q) => Math.hypot(q.x - kx, q.y - ky) < 8 && (settings.bool('settings.nexradTracksShowCellPtsTrackingMode') || q.poh > 0 || q.posh > 0));
        this.selectedCell = c && c.id !== this.selectedCell ? c.id : null;
        this.trackHudKey = '';
        if (c) return;
      }
    }
    this.selectedAlert = null;
  }

  private rollover(x: number, y: number) {
    const tip = this.hud.tip;
    let text = '';
    const a = this.warnings.enabled() ? this.warnings.hit(x, y, timeline.t) : null;
    if (a) text = `${a.event}\nExpires ${new Date(a.ends).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${a.motion ? '\n' + a.motion : ''}`;
    if (!text && settings.bool('settings.nexradSitesOn')) { const id = this.sites.hit(x, y); if (id) { const s = RADAR_SITES.find((q) => q.id === id)!; text = `${s.id} ${titleCase(s.name)}, ${s.st} (${s.type})\n${radarStatusDetail(radarStatus.get(id))}`; } }
    if (!text) { const info = this.objectInfo(x, y); if (info) text = info.slice(0, 4).join('\n'); }
    const ll = this.renderer.camera.pick(x, y);
    if (ll) {
      // Rollover tracking: arrival time of the manual track / tracked cell swath at the cursor.
      const fmt = settings.str('settings.nexradManualTracksTimeFormat') || 'hh:nn am/pm';
      const mt = this.annotations.manualTrack;
      const mEta = mt && settings.bool('settings.nexradManualTracksRolloverTracking') ? this.annotations.trackEtaAt(ll[0], ll[1]) : null;
      if (mt && mEta !== null) text = `${text ? text + '\n' : ''}Manual track ETA ${impactText(mt.t0 + mEta * 60e3, timeline.t, false, fmt)} (${impactText(mt.t0 + mEta * 60e3, timeline.t, true, fmt)})`;
      const cell = this.trackedCell();
      if (cell?.motion) {
        const hit = cityImpacts(frontLine([cell.ll], cell.motion), cell.motion, settings.num('settings.nexradTracksExtrapolateMinutes'), [{ n: '', lon: ll[0], lat: ll[1], pop: 0 }])[0];
        if (hit) {
          const at = cell.t0 + hit.minutes * 60e3;
          const eta = `ETA ${impactText(at, timeline.t, false, fmt)}`;
          text = settings.bool('settings.nexradTrackingModeRolloverETAOnly') ? eta : `Cell ${cell.c.id}: ${eta} (${impactText(at, timeline.t, true, fmt)})${text ? '\n' + text : ''}`;
        }
      }
    }
    if (!text && this.lightning.enabled() && settings.bool('settings.lightningRenderingRollover')) { const f = this.lightning.nearest(x, y); if (f) text = `Lightning flash ${Math.round((timeline.t - f.t) / 60e3)} min ago\nEnergy ${(f.e * 1e15).toFixed(0)} fJ`; }
    tip.style.display = text ? '' : 'none';
    tip.textContent = text;
    tip.style.left = `${x + 14}px`; tip.style.top = `${y + 10}px`;
  }

  /** Text of the topmost vector/station object under the cursor (layers implementing probeAt). */
  private cpuProbe: string[] | null = null;
  objectInfo(x: number, y: number): string[] | null {
    const ll = this.renderer.camera.pick(x, y);
    if (!ll) return null;
    const order = [...this.renderer.layers].reverse();
    for (const l of order) {
      const p = (l as unknown as { probeAt?: (lon: number, lat: number, x: number, y: number) => string[] | null; enabled?: () => boolean }).probeAt;
      if (!p || (l as MapLayer).enabled?.() === false) continue;
      const r = p.call(l, ll[0], ll[1], x, y);
      if (r && r.length) return r;
    }
    return null;
  }

  private showProbe(p: { kind: string; value: number; layer: string } | null) {
    const pr = this.hud.probe;
    if ((!p && !this.cpuProbe) || !this.mouse || settings.num('config.generalMapMode') !== 2) { pr.style.display = 'none'; return; }
    const layer = p ? (this.layers.get(p.layer) as MapLayer | undefined) : undefined;
    const raster = p ? layer?.probeText(p.value) ?? p.value.toFixed(3) : '';
    pr.style.whiteSpace = 'pre';
    pr.textContent = [this.cpuProbe?.join('\n'), raster].filter(Boolean).join('\n');
    pr.style.display = '';
    pr.style.left = `${this.mouse[0] + 14}px`; pr.style.top = `${this.mouse[1] - 26}px`;
  }

  private wireKeys() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'f') { e.preventDefault(); this.fullscreen(); }
      else if (e.ctrlKey && k === 't') { e.preventDefault(); this.toggleTelestration(); }
      else if (e.ctrlKey && k === 'z') {
        e.preventDefault();
        const ll = this.lastClickLL ?? [this.renderer.camera.target.lon, this.renderer.camera.target.lat];
        this.renderer.camera.flyTo({ lon: ll[0], lat: ll[1], z: settings.num('config.generalCtrlZZoomLevel') }, settings.num('config.generalCameraFlyDuration'), this.flyOpts());
      } else if (e.altKey && k === 'd') { e.preventDefault(); this.startMeasure('path'); }
      else if (e.altKey && k === 'l') { e.preventDefault(); this.toggleRoadNaming(); }
      else if (e.altKey && /^f(\d{1,2})$/.test(k)) { e.preventDefault(); this.applyScene(Number(k.slice(1)) - 1); }
      else if (!e.ctrlKey && !e.altKey && k === 'r') settings.set('settings.nexradSitesOn', !settings.bool('settings.nexradSitesOn'));
      else if (k === ' ' && !e.ctrlKey) { e.preventDefault(); this.clearTelestration(); }
      else if (k === 'escape') { this.tool = null; this.canvas.style.cursor = ''; }
      else if (e.key === 'F8') { e.preventDefault(); this.perf.toggle(); }
      this.poke();
    });
  }

  // ------------------------------------------------------------------------------------------- frame loop
  private legendKey = '';
  private mapLabelText = '';
  private brandDpr = 0;
  private textStyleKey = '';
  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t));
    this.meter.raf(now);
    const cam = this.renderer.camera;
    const dt = this.lastFrame ? now - this.lastFrame : 16;
    // One FPS target (0 = unlimited) bounds every state; the idle and loop limits can only lower it. Loop playback
    // and camera motion are read from their state, not from poke(), so a loop's end-of-loop hold does not switch
    // limits mid-playback.
    const limit = this.fpsOverride ?? fpsLimit(
      { target: settings.num('config.generalActiveFPS'), loop: settings.num('config.generalRestingFPSLoop'), idle: settings.num('config.generalRestingFPS') },
      {
        interacting: now - this.lastInteract < 400 || this.renderer.probeRequest !== null || this.cameraMoving,
        loopPlaying: timeline.playing,
        animating: this.nexrad.liveScan || this.viewPlaying || !!this.recorder,
      });
    if (!this.pacer.tick(now, limit)) return;
    this.lastFrame = now;
    const t0 = performance.now();
    this.cameraMoving = cam.update(now, Math.min(dt, 100));
    // Real elapsed time: a loop FPS limit down to 1 fps renders up to 1 s apart, and tick() never advances more than
    // one loop frame per call, so a stall cannot skip frames.
    timeline.tick(now, dt, settings.bool('layerState.RasterDataTemporalInterpolation'));
    // Palette flash: alternate rows every flash interval unless disabled.
    if (!settings.bool('settings.generalDisableAnimatedPalettes')) { if (now - this.flashT > 700) { this.flashT = now; this.renderer.flashRow ^= 1; } } else this.renderer.flashRow = 0;
    this.applyTileSettings();
    this.applyLighting();
    for (const l of this.layers.values()) if ('tick' in l && (l as MapLayer).enabled?.()) (l as MapLayer).tick(timeline.t, now);
    const visible = this.renderer.layers;
    const enabledLayers = [this.tiles as Drawable, ...visible.slice(1).filter((l) => (l as MapLayer).enabled?.() !== false)];
    const saved = this.renderer.layers;
    this.renderer.layers = enabledLayers;
    this.renderer.frame();
    this.renderer.layers = saved;
    const cpu = performance.now() - t0;
    this.updateHud(now);
    if (this.recordCanvas) this.composeFrame(this.recordCanvas);
    this.meter.frame(now, cpu, this.renderer.gpuMs);
  }
  private readonly pacer = new FramePacer();
  private cameraMoving = false;
  /** Benchmark override of the FPS limit (0 = unlimited); null = settings. */
  fpsOverride: number | null = null;
  private watchText: string | null = null;

  private applyTileSettings() {
    const z = this.renderer.camera.zoomScale;
    const band = z >= 4 ? 'bgNationalMode' : z >= 1 ? 'bgRegionalMode' : 'bgLocalMode';
    const mode = settings.num(`config.${band}`);
    const base = settings.num('ext.layerState.MapBase');
    const bgOn = base === 0 || base === 2;
    const perf = settings.num('config.performanceMode');
    const imgSet = z >= 4 ? '' : z >= 1 ? 'WELD' : 'NAIP';
    const bg = (k: string) => settings.num(`config.bg${imgSet}${k}`);
    this.tiles.s = {
      enabled: true, imagery: bgOn && mode !== 0, terrain: bgOn && mode !== 1 && (settings.bool('config.terrainHypsometricTinting') || settings.num('config.terrainShading') > 0),
      tint: settings.bool('config.terrainHypsometricTinting'), shading: settings.num('config.terrainShading'), ocean: bgOn && settings.bool('config.terrainOcean'),
      oceanMode: perf === 0 ? 0 : settings.num('config.terrainOceanMode'), oceanColor: settings.arr<number>('config.terrainOceanColor'),
      grid: settings.bool('config.latlonLinesOn'), gridColor: settings.arr<number>('config.latlonLinesColor'), gridAlpha: settings.num('config.latlonLinesAlpha'),
      gridWidth: settings.num('config.latlonLinesWidth'), gridDensity: settings.num('config.latlonLinesDensity'), gridOceanOnly: settings.bool('config.latlonLinesOceanOnly'),
      gridSecondary: settings.bool('config.latlonLinesSecondary'), gridAdd: settings.bool('config.latlonLinesColorAdd'),
      brightness: bg('Brightness'), contrast: bg('Contrast'), saturation: bg('Saturation'), height3D: settings.num('config.terrainHeight'), surface3D: settings.bool('config.terrain3DSurface'),
      lightAz: settings.num('config.terrainFixedLightAzimuth'), lightZen: settings.bool('config.terrainFixedZenith') || perf === 0 ? settings.num('config.terrainFixedLightZenith') : 45,
      coastMode: settings.num('config.terrainCoastlineShadowMode'), coastColor: settings.arr<number>('config.terrainCoastlineShadowColor'), coastExp: settings.num('config.terrainCoastlineShadowExponent'),
      gloss: settings.num('config.terrainGlossiness'), highlight: settings.num('config.terrainOceanLightingHighlight'), waterCoef: settings.num('config.terrainOceanCoefficient'), shadeDepth: settings.num('ext.config.terrainShadeDepth'), shadeBright: settings.num('ext.config.terrainHighlightBrightness'),
      density: settings.num('config.bgTileDensity') * (perf === 0 ? 1.5 : perf === 2 ? 0.8 : 1), mapBg: [settings.num('config.mbgColor') & 255, (settings.num('config.mbgColor') >> 8) & 255, (settings.num('config.mbgColor') >> 16) & 255],
      tintPalette: settings.str('config.terrainHypsometricTintPalette'),
      fixedLight: settings.bool('config.terrainFixedLight'), alpha: settings.num('config.terrainAlpha'),
      tintBeforeLighting: settings.bool('config.terrainHypsometricTintingBeforeLighting'),
      dynamicRange: settings.bool('config.terrainHypsometricDynamicRange'), rescaleSpeed: settings.num('config.terrainHypsometricDynamicRangeRescaleSpeed'),
      oceanOnlyHeight: settings.num('config.terrainOceanOnlyHeight'),
      waterToLight: settings.bool('config.terrainOceanConstrainWaterToLight') ? (settings.bool('config.terrainOceanConstrainWaterToLightInverse') ? 2 : 1) : 0,
      performanceWater: settings.bool('config.terrainOceanPerformanceWater'), lightWave: settings.bool('config.terrainOceanWaterLightWave'),
      motionReduce: settings.bool('config.terrainMotionReduceDensity') ? settings.num('config.terrainMotionReduceDensityAmount') : 0,
      // Globe specular: the radius widens the highlight (lower exponent); auto-scale fades it in from regional to whole-globe zoom.
      specExp: Math.max(1, settings.num('config.bgSpecularExp') * 16 / Math.max(0.1, settings.num('config.bgSpecularRadius'))),
      specIntensity: settings.num('config.bgSpecularIntensity') * 0.15 * (settings.bool('config.bgAutoScaleSpecular') ? Math.min(1, Math.max(0, (z - 8) / 12)) : 1),
      hdr: settings.bool('config.bgHDRGlobeLighting'), hdrWhite: settings.num('config.bgHDRDivisor') / 4,
      anisotropy: anisotropyOf(settings.num('settings.generalAnisotropicFiltering')),
    };
    if (!bgOn) this.tiles.s.enabled = base !== 3 ? true : false;
    const sky = this.renderer.skyParams;
    const c = settings.num('config.mbgColor');
    sky.bg = [(c & 255) / 255, ((c >> 8) & 255) / 255, ((c >> 16) & 255) / 255];
    sky.atmosphere = settings.bool('settings.atmosphereOn'); sky.height = settings.num('settings.atmosphereHeight'); sky.intensity = settings.num('settings.atmosphereSunIntensity') / 540; sky.stars = settings.bool('config.starField');
    sky.innerLimit = Math.min(1, Math.max(0, settings.num('settings.atmosphereInnerLimiting') / 100));
    this.renderer.rasterMesh = rasterMesh(settings.num('config.generalSphereMeshSpacing'));
  }

  private applyLighting() {
    const cam = this.renderer.camera;
    const forced = settings.bool('config.bgLightCenterZoomForce') && cam.cur.z >= settings.num('config.bgLightCenterZoomForceLevel');
    const center = settings.bool('config.bgLightCenter') || forced;
    const px = center ? 0.5 : settings.num('config.bgLightPointX'), py = center ? 0.5 : settings.num('config.bgLightPointY');
    const ll = cam.pick(px * cam.width, py * cam.height) ?? [cam.cur.lon, cam.cur.lat];
    const p = lonLatToXYZ(ll[0], ll[1]);
    const e = cam.eye, el = Math.hypot(...e);
    // Light from slightly toward the camera so the lit hemisphere faces the viewer (globe lighting substitute).
    this.renderer.light = [p[0] * 0.6 + (e[0] / el) * 0.4, p[1] * 0.6 + (e[1] / el) * 0.4, p[2] * 0.6 + (e[2] / el) * 0.4, settings.num('config.bgDiffuseExp')];
    this.renderer.globeLighting = settings.bool('config.generalFramebufferEffects');
    this.renderer.diffuseIntensity = settings.num('config.bgDiffuseIntensity');
  }

  /** Selected tracking-mode cell with its position, or null when it left the current volume or the mode is off. */
  private trackedCell() {
    if (!this.cellTracking || !this.selectedCell) return null;
    const c = this.nexrad.scit.find((q) => q.id === this.selectedCell), s = this.nexrad.siteInfo();
    if (!c || !s) return null;
    const ll: [number, number] = [s.lon + c.x / (111.2 * Math.cos((s.lat * Math.PI) / 180)), s.lat + c.y / 111.2];
    const motion = c.dir === c.dir && c.speed === c.speed ? { speedKt: c.speed, fromDeg: c.dir } : null;
    return { c, ll, motion, t0: this.nexrad.overlayTime || timeline.t };
  }

  /** City ETA list (manual track, tracking mode) and the storm-cell info box with SCIT severity colours. */
  private updateTrackHud() {
    const h = this.hud;
    const mt = this.annotations.manualTrack?.done ? this.annotations.manualTrack : null;
    const cell = this.trackedCell();
    const now = timeline.t;
    let rows: { name: string; at: number }[] = [], title = '';
    const countdown = settings.bool('settings.nexradManualTracksImpactedCityListCountdown');
    const fmt = settings.str('settings.nexradManualTracksTimeFormat') || 'hh:nn am/pm';
    if (cell?.motion && settings.bool('settings.nexradTracksShowImpactedCities')) {
      title = `Cell ${cell.c.id} city ETA`;
      rows = cityImpacts(frontLine([cell.ll], cell.motion), cell.motion, settings.num('settings.nexradTracksExtrapolateMinutes'), this.annotations.cities()).map((i) => ({ name: i.name, at: cell.t0 + i.minutes * 60e3 }));
    } else if (mt && settings.bool('settings.nexradManualTracksShowImpactedCities')) {
      title = 'Manual track cities';
      rows = this.annotations.impacts.map((i) => ({ name: i.name, at: mt.t0 + i.minutes * 60e3 }));
    }
    if (countdown && !settings.bool('settings.nexradManualTracksImpactedCityListCountdownShowPast')) rows = rows.filter((r) => r.at >= now - 30e3);
    rows = rows.slice(0, Math.max(0, settings.num('settings.nexradManualTracksImpactedCitiesMaxCount')));
    const listText = rows.length ? [title, ...rows.map((r) => `${r.name.padEnd(18)} ${impactText(r.at, now, countdown, fmt)}`)].join('\n') : '';
    const key = `${listText}|${cell?.c.id}|${this.cellInfoMore}|${cell ? JSON.stringify(cell.c) : ''}`;
    const lh = h.legend.clientHeight;
    for (const [box, k] of [[h.cityList, 'config.guiCityListTextPosition'], [h.cell, 'config.guiStormCellInfoTextPosition']] as const) {
      const p = settings.arr<number>(k), left = `${p[0]}px`, top = `${p[1] + lh}px`;
      if (box.style.left !== left || box.style.top !== top) { box.style.left = left; box.style.top = top; }
    }
    if (key === this.trackHudKey) return;
    this.trackHudKey = key;
    h.cityList.style.display = listText ? '' : 'none';
    h.cityList.textContent = listText;
    h.cell.style.display = cell ? '' : 'none';
    if (cell) {
      const c = cell.c;
      const level = (kind: string, v: number) => {
        const t = (k: string) => settings.num(`config.scitList${kind}${k}Threshold`);
        return v >= t('Highest') ? 'Highest' : v >= t('High') ? 'High' : v >= t('Moderate') ? 'Moderate' : 'Normal';
      };
      const cellSpan = (text: string, lv: string) => {
        const e = document.createElement('span');
        const bg = settings.arr<number>(`config.scitList${lv}ThresholdBgColor`), fg = settings.arr<number>(`config.scitList${lv}ThresholdFontColor`);
        e.textContent = text; e.style.cssText = `background:rgb(${bg.join(',')});color:rgb(${fg.join(',')});padding:0 3px`;
        return e;
      };
      h.cell.textContent = '';
      const head = document.createElement('div'); head.className = 'hud-cell-title'; head.textContent = 'Storm Cell (click for more/less)';
      const row = (...parts: (string | HTMLElement)[]) => { const d = document.createElement('div'); d.append(...parts); h.cell.append(d); };
      h.cell.append(head);
      row(`${c.id}  ${c.dir === c.dir ? `${Math.round(c.dir)}°/${Math.round(c.speed)} kt` : 'motion n/a'}  `, cellSpan(`${c.maxDbz === c.maxDbz ? c.maxDbz : '—'} dBZ`, c.maxDbz === c.maxDbz ? level('MaxDBz', c.maxDbz) : 'Normal'));
      if (this.cellInfoMore) {
        // MESO has no strength rank in the decoded cell record, so a detected MESO is shown at the "high" level.
        row(cellSpan(`TVS ${c.tvs ? 'Y' : '-'}`, c.tvs ? 'Highest' : 'Normal'), ' ', cellSpan(`MESO ${c.meso ? 'Y' : '-'}`, c.meso ? 'High' : 'Normal'));
        row(cellSpan(`POH ${c.poh}%`, level('POH', c.poh)), ' ', cellSpan(`POSH ${c.posh}%`, level('POSH', c.posh)));
        row(cellSpan(`MEHS ${c.mehs.toFixed(2)} in`, level('MEHS', c.mehs)));
      }
    }
  }

  private updateHud(now: number) {
    const h = this.hud;
    this.updateTrackHud();
    if (this.roads.labels.length || this.roadLabelEls.length) this.updateRoadLabels();
    // Timestamp label.
    // Settings → map timestamp and the sidebar Timestamps → Main timeline toggle both gate the label.
    const show = settings.bool('config.generalShowMapTimestamp') && settings.bool('ext.layerState.TimestampMain');
    h.time.style.display = show ? '' : 'none';
    if (show) {
      const local = settings.bool('config.labelTimeZone');
      // Local time follows the browser zone unless the time-zone override fixes a UTC offset (Settings → Time).
      const zc = local ? zoneClock(timeline.t, settings.bool('config.timeOverride'), settings.num('config.timeOverrideZ')) : { ms: timeline.t, utc: true, zone: null };
      const d = new Date(zc.ms), asUtc = !local || zc.utc;
      // Built-in format, or the user's date-time format (Settings → Logo/Timestamps); the zone abbreviation is optional.
      const fmt = settings.str('ext.config.dateTimeFormat').trim(), zone = settings.bool('ext.config.timestampShowZone');
      const zoneName = zone ? (zc.zone ?? new Intl.DateTimeFormat('en-US', { timeZone: asUtc ? 'UTC' : undefined, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '') : '';
      // Display mode (TimestampLabel/DisplayMode): 0 date and time, 1 time only, 2 date and time with the data age.
      const mode = settings.num('config.labelIncTimestamp');
      const tz = asUtc ? 'UTC' : undefined;
      let text = fmt
        ? formatDateTime(d.getTime(), fmt, asUtc)
        : mode === 1
          ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(d)
          : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(d).replace(',', '');
      if (mode === 2) { const age = Math.round((Date.now() - timeline.t) / 60e3); text += age > 0 ? ` (${age} min ago)` : ' (now)'; }
      h.time.textContent = zoneName ? `${text} ${zoneName}` : text;
      const off = settings.arr<number>('config.labelOffset');
      const legendH = h.legend.clientHeight;
      h.time.style.left = `${10 + off[0]}px`; h.time.style.top = `${(settings.bool('config.labelFasten') ? 8 : legendH + 8) + off[1]}px`;
      h.time.style.zIndex = settings.bool('config.labelOnTop') ? '5' : '1';
    }
    // Product time labels (NDFD forecast time, Winter range, model run): stacked under the timestamp.
    const ml = [...this.layers.values()].map((l) => (l as { mapLabel?: () => string | null }).mapLabel?.() ?? null).filter((x): x is string => !!x).join('\n');
    if (ml !== this.mapLabelText) { this.mapLabelText = ml; h.maplabel.textContent = ml; h.maplabel.style.display = ml ? '' : 'none'; }
    if (ml) { h.maplabel.style.left = h.time.style.left; h.maplabel.style.top = `${(parseFloat(h.time.style.top) || 8) + 30}px`; }
    // Severe watch text box at General/SevereWatchBoxPosition: watches in effect at map time.
    const wl = this.warnings.watchesAt(timeline.t);
    const wt = wl.length ? wl.slice(0, 6).map((a) => `${a.event}${a.etn ? ` #${Number(a.etn)}` : ''} until ${new Date(a.ends).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`).join('\n') + (wl.length > 6 ? `\n+${wl.length - 6} more` : '') : '';
    if (wt !== this.watchText) {
      this.watchText = wt; h.watchBox.textContent = wt; h.watchBox.style.display = wt ? '' : 'none';
      const wp = settings.arr<number>('config.guiSevereWatchTextPosition');
      h.watchBox.style.left = `${wp[0]}px`; h.watchBox.style.top = `${wp[1]}px`;
    }
    // Legends.
    const legends: LegendSpec[] = settings.bool('config.noLegend') ? [] : [...this.layers.values()].flatMap((l) => ('legends' in l && (l as MapLayer).enabled() ? (l as MapLayer).legends() : []));
    const key = legends.map((l) => `${l.id}${l.palette.name}${l.low}${l.high}${l.extra?.length}${l.note ?? ''}`).join('|') + this.renderer.flashRow + h.legend.clientWidth;
    if (key !== this.legendKey) { perfMark('legend'); this.legendKey = key; drawLegends(h.legend, legends, this.renderer.flashRow, devicePixelRatio || 1); }
    // Lightning count box.
    const showStrikes = this.lightning.enabled() && settings.bool('settings.lightningRenderingFlashCountBox');
    h.strikes.style.display = showStrikes ? '' : 'none';
    if (showStrikes && now % 500 < 20) h.strikes.textContent = `${this.lightning.countInView()} Strikes`;
    // Probe crosshair.
    const probe = settings.num('config.generalMapMode') === 2 && this.mouse;
    h.cross.style.display = probe && settings.bool('settings.generalProbeModeCrosshair') ? '' : 'none';
    if (probe && this.mouse) { h.cross.style.left = `${this.mouse[0]}px`; h.cross.style.top = `${this.mouse[1]}px`; }
    if (!probe) h.probe.style.display = 'none';
    // Warning info box with leader line.
    const a = this.selectedAlert;
    h.svg.textContent = '';
    if (a && this.warnings.activeAt(timeline.t).includes(a)) {
      h.info.style.display = '';
      h.info.style.borderColor = `rgb(${a.type!.color.join(',')})`;
      h.info.textContent = this.warnings.infoLines(a).join('\n');
      if (!h.info.style.left) { const p = settings.arr<number>('config.guiSevereWarningsTextPosition'); h.info.style.left = `${p[0]}px`; h.info.style.top = `${p[1]}px`; }
      const anchor = this.warnings.screenAnchor(a);
      if (anchor && settings.bool('settings.severeWarningsInfoBoxLine')) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(h.info.offsetLeft + h.info.offsetWidth / 2)); line.setAttribute('y1', String(h.info.offsetTop + h.info.offsetHeight));
        line.setAttribute('x2', String(anchor[0])); line.setAttribute('y2', String(anchor[1]));
        line.setAttribute('stroke', `rgb(${a.type!.color.join(',')})`); line.setAttribute('stroke-width', '1.5');
        h.svg.appendChild(line);
      }
    } else { h.info.style.display = 'none'; this.selectedAlert = null; }
    // Named text styles for DOM text (TFrmTextAppearance / TFrmFontControl): applied once edited.
    const tk = ['MapTimestamp', 'ProbeFont', 'RolloverFont'].map((n) => (hasTextStyle(n) ? JSON.stringify(textStyle(n)) : '')).join('|');
    if (tk !== this.textStyleKey) {
      this.textStyleKey = tk;
      for (const [el, n] of [[h.time, 'MapTimestamp'], [h.probe, 'ProbeFont'], [h.tip, 'RolloverFont']] as [HTMLElement, string][]) {
        if (hasTextStyle(n)) Object.assign(el.style, textCss(n)); else for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'letterSpacing', 'textShadow', 'background', 'padding', 'animation'] as const) el.style[k] = '';
      }
    }
    // Cloud Nuke watermark (user branding): same tile as in exports, rebuilt when the DPR changes.
    const showBrand = settings.bool('ext.config.brandWatermark');
    h.brand.style.display = showBrand ? '' : 'none';
    if (showBrand) {
      const dpr = devicePixelRatio || 1;
      if (this.brandDpr !== dpr) { const t = watermarkTile(dpr); if (t) { this.brandDpr = dpr; h.brand.width = t.width; h.brand.height = t.height; h.brand.getContext('2d')!.drawImage(t, 0, 0); h.brand.style.width = `${t.width / dpr}px`; h.brand.style.height = `${t.height / dpr}px`; } }
      const ov = h.brand.parentElement!;
      const [x, y] = this.brandPos(h.brand.width / dpr, h.brand.height / dpr, ov.clientWidth, ov.clientHeight);
      h.brand.style.left = `${x}px`; h.brand.style.top = `${y}px`;
    }
    // Logo (custom only; no vendor logo is shipped) and PNG overlay.
    if (settings.bool('config.logoCustom') && this.logoUrl) {
      const off = settings.arr<number>('config.logoOffset'), corner = settings.num('config.logoCorner');
      h.logo.style.cssText = `position:absolute;pointer-events:none;${corner % 2 ? 'right' : 'left'}:${off[0]}px;${corner >= 2 ? 'bottom' : 'top'}:${off[1]}px`;
      if (!h.logo.firstChild) { const img = document.createElement('img'); img.src = this.logoUrl; h.logo.appendChild(img); }
    } else h.logo.textContent = '';
    if (settings.bool('config.overlayActive') && this.overlayUrl) {
      const pt = settings.arr<number>('config.overlayPt');
      h.overlay.src = this.overlayUrl; h.overlay.style.display = ''; h.overlay.style.left = `${pt[0]}px`; h.overlay.style.top = `${pt[1]}px`;
    } else h.overlay.style.display = 'none';
    // Status bar (contents chosen by the implementation).
    if (now % 250 < 20) { perfMark('statusbar'); this.updateStatusBar(); }
  }

  private updateStatusBar() {
    const s = this.status;
    if (!s.length) return;
    const cam = this.renderer.camera;
    const ll = this.mouse ? cam.pick(this.mouse[0], this.mouse[1]) : null;
    s[0].textContent = settings.bool('config.generalShowLatLonText') && ll ? `${ll[1].toFixed(3)}, ${wrapLon(ll[0]).toFixed(3)}` : '';
    s[1].textContent = `Zoom ${cam.cur.z.toFixed(1)}`;
    const m = this.meter.summary(2000);
    s[2].textContent = settings.bool('config.generalShowPerfMetrics') ? `${m.fps.toFixed(0)} fps` : '';
    s[3].textContent = settings.bool('config.generalShowPerfMetrics') ? `cpu ${m.cpuMean.toFixed(1)} gpu ${this.renderer.gpuMs.toFixed(1)} ms` : '';
    const busy = [...this.layers.values()].filter((l) => 'status' in l && (l as MapLayer).status.state === 'loading').map((l) => (l as MapLayer).title);
    const errs = [...this.layers.values()].filter((l) => 'status' in l && (l as MapLayer).status.state === 'error').map((l) => `${(l as MapLayer).title}: ${(l as MapLayer).status.text}`);
    s[4].textContent = busy.length ? `Loading: ${busy.join(', ')}` : errs[0] ?? `${new Date(timeline.t).toUTCString().slice(17, 25)} UTC`;
    s[5].textContent = this.dl.active ? `Downloads: ${this.dl.active} (${(this.dl.received / 1e6).toFixed(1)} MB)` : 'Data current';
    s[6].textContent = this.warnings.status.state === 'ready' ? '●' : '○';
    s[6].title = 'Public NWS alert polling (60 s); no push feed';
    this.gauge.style.width = this.dl.total ? `${Math.min(100, (this.dl.received / this.dl.total) * 100)}%` : '0%';
  }
}



/** Raster sphere mesh from RasterObjectSphereMeshSpacing: density relative to the default 3.0 (96 × 64 cells). */
export function rasterMesh(spacing: number): [number, number] {
  const k = 3 / Math.min(12, Math.max(0.75, spacing || 3));
  return [Math.round(96 * k), Math.round(64 * k)];
}

void DEFAULT_ORDER; void layerPresets; void getPalette;
