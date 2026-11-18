// NEXRAD Pro (30): Level 2 volumes (all 17 products, tilts with split-cut/SAILS/MRLE handling, scan transitions,
// live sweep, live composite) and Level 3 products/overlays, with probe value mapping.
import type { DrawContext, PrepassContext, Renderer } from '../render/renderer';
import { MapLayer, NOT_AVAILABLE, type LegendSpec } from './base';
import { bracket, timeline } from '../app/timeline';
import { settings } from '../settings/store';
import { pool } from '../workers/pool';
import { ptypeAt, ptypeLabel, type PtypeState, type PtypeTex } from '../render/ptype';
import { hailEnvironment, isothermStatus, onIsotherms, pointKey, type RadarPoint } from '../radar/environment';
import { destination } from '../gis/geodesy';
import { RadarDraw, Lut, uploadSweep, RasterDraw, latLonProj, type SweepTex } from '../render/raster';
import { getPalette } from '../palettes/library';
import { evalPalette } from '../render/palette';
import { PolySet, type PolyFill, type FillStyle } from '../render/polys';
import { LineSet, PointSet, TextSet, GlyphAtlas, SHAPE, type Polyline, type PointSpec, type Label } from '../render/prims';
import { RADAR_SITES } from '../generated/radar-sites';
import { listL2, listL3, l2Retention, effectiveSource, L2, L3, l3Range, l3PaletteKey, L2_PALETTE_KEYS, l2Moment, type L2File, type L3Entry } from '../radar/sources';
import type { L2Meta, L2SweepMeta } from '../workers/decode.worker';
import { algorithmKey, columnNote, usesIsotherms, type L2BuildParams, type VolumeMoment } from '../radar/l2products';
import { VolumeStore, type GpuPack, type PackRequest } from '../render/volume';
import { hailThresholds } from '../settings/postload';
import { perfMark } from '../perf/meter';
import { ChunkFeed } from '../radar/chunks';
import { loadPref, savePref, prefObject } from '../app/persist';
import { matchVolume, overlayFiles, LISTING_LAG_MAX_MS, VOLUME_MATCH_TOL_MS } from '../radar/overlay-match';
import { panes, type RadarView } from '../app/panes';
import { RadarTools } from './radar-tools';
import { AWS_L3, IEM_ATTR_SINCE, IEM_DS, iemAttrUrl, iemStormProducts, l3ArchiveCode, l3ArchiveCodes, listL3Archive } from '../radar/archive';
import { fetchJson } from '../data/net';
import { archiveCache } from '../data/iem';
import { CrossSection } from './cross-section';
import { RadarTrail } from './radar-trail';
import { Volume3D } from './radar-volume3d';

export interface TiltTab { key: string; label: string; angle: number; sweepIndices: number[] }

type L2Sweep = SweepTex & { elevation: number; startMs: number; endMs: number; complete: boolean; progress: number; id: string; motion: string; rolling?: { liveTilts: number; prevTilts: number } };
/**
 * One pane's product of a Level 2 volume. `sweep.id` is the display identity the sweep was built for
 * (NexradLayer.l2Identity of that pane), `key` the exact request it came from and `req` the newest request in flight.
 */
interface L2Slot { sweep?: L2Sweep; key?: string; req?: string; error?: string }
/**
 * A Level 2 volume: its file and metadata (`metaReq` is the newest metadata read) are shared by the panes. The frame
 * itself is the slot of pane 0; `panes[p - 1]` is the slot of pane p.
 */
interface L2Frame extends L2Slot { t: number; file: L2File; meta?: L2Meta; metaReq?: number; panes?: (L2Slot | undefined)[] }
const slot = (f: L2Frame, pane: number): L2Slot | undefined => (pane === 0 ? f : f.panes?.[pane - 1]);
/** Every pane's slot of a volume. */
const slots = (f: L2Frame): L2Slot[] => [f, ...(f.panes ?? []).filter((s): s is L2Slot => !!s)];
/** A Level 3 file; `id` is the site and product it belongs to (NexradLayer.l3Identity). */
interface L3Frame { t: number; url: string; id: string; tex?: SweepTex; raster?: { tex: GPUTexture; bounds: [number, number, number, number]; nx: number; ny: number }; vcp?: number; volumeTimeMs?: number; volumeScan?: number; loading?: boolean; error?: string; elevation?: number }

/**
 * Volumes of the loop while more than one pane is shown: every pane holds a sweep of each (1–5 MB of texture), so
 * the newest ones only.
 */
export const PANE_VOLUMES = 12;
/** What one pane draws with and drew last. Each pane has its own draw objects: one writes its uniforms once a frame. */
class PaneDraw {
  radar: RadarDraw; shadow: RadarDraw; oldSweep: RadarDraw; l3raster: RasterDraw;
  /** The pane's Level 3 loop and the site and product (l3Identity) it was listed for. */
  l3: L3Frame[] = []; l3Key = '';
  lastDrawn: L2Frame | null = null;
  /** Volume time of the radar frame drawn last; null when the pane draws none. */
  shownT: number | null = null;
  /** P-type state of the scan drawn last (legend note and status line). */
  ptypeShown: PtypeState<PtypeTex> | null = null;
  constructor(r: Renderer) { this.radar = new RadarDraw(r); this.shadow = new RadarDraw(r); this.oldSweep = new RadarDraw(r); this.l3raster = new RasterDraw(r); }
  invalidate() { this.radar.invalidate(); this.shadow.invalidate(); this.oldSweep.invalidate(); this.l3raster.invalidate(); }
}
/** The same volume: equal, or volume times within the tolerance storm attributes are matched with. */
const sameVolume = (a: number | null, b: number | null) => a === b || (a !== null && b !== null && Math.abs(a - b) <= VOLUME_MATCH_TOL_MS);

/** The newest automatic storm motion vector (custom radar input) is current for this long after its volume time. */
export const AUTO_MOTION_MAX_AGE = 20 * 60e3;
const ML_DS = ['166m0', '166ma', '166m1', '166mb', '166m2', '166m3'];
/** Automatic storm motion: 56rm0 average storm speed and direction (halfwords 51/52, tenths), or null when invalid. */
const motionOf = (p: { p?: number[] } | null): { speedKt: number; fromDeg: number } | null => {
  const sp = p?.p ? p.p[7] / 10 : NaN, dir = p?.p ? p.p[8] / 10 : NaN;
  return sp >= 0 && sp < 150 && dir >= 0 && dir <= 360 ? { speedKt: sp, fromDeg: dir } : null;
};
const utcHm = (t: number) => new Date(t).toISOString().slice(11, 16);
const kmToLonLat = (lon0: number, lat0: number, x: number, y: number): [number, number] => [lon0 + x / (111.2 * Math.cos((lat0 * Math.PI) / 180)), lat0 + y / 111.2];

/** Storm motion per cell id (direction from, deg; speed, kt) from the STI product's text pages. */
function stiMotion(pages: string[][]) {
  const motion = new Map<string, { dir: number; speed: number }>();
  for (const page of pages) for (const line of page) {
    const m = /^\s*([A-Z]\d)\s+\d+\/\s*\d+\s+(\d+)\/\s*(\d+)/.exec(line);
    if (m) motion.set(m[1], { dir: +m[2], speed: +m[3] });
  }
  return motion;
}

export class NexradLayer extends MapLayer {
  readonly id = 'nexrad';
  readonly archive = 'resolver';
  readonly title = 'NEXRAD';
  /** Each pane draws its own product (ctx.pane); pane 0 is the view the radar settings describe. */
  readonly perPane = true;
  l2: L2Frame[] = [];
  private readonly views: PaneDraw[] = [new PaneDraw(this.r)];
  private paneDraw(pane: number) { return (this.views[pane] ??= new PaneDraw(this.r)); }
  /** Level 3 loop of pane 0. */
  get l3() { return this.views[0].l3; }
  set l3(frames: L3Frame[]) { this.views[0].l3 = frames; }
  tilts: TiltTab[] = [];
  tiltAngle = loadPref('l2tilt', 0.5, (v) => typeof v === 'number' && Number.isFinite(v));
  /** Live sweep requested; it is never active while an archive time is shown. */
  private liveSweep = false;
  get liveScan() { return this.liveSweep && timeline.mode === 'live'; }
  set liveScan(on: boolean) { this.liveSweep = on; }
  liveComposite = false;
  statusText = 'Awaiting activation (L2)...';
  vcpText = 'VCP: --';
  nrtText = 'NRT: ---';
  liveSweepText = '--°/--°';
  /** Azimuth of the newest radial of an incomplete live sweep (live beam line), or null. */
  private liveAz: number | null = null;
  private beam: LineSet | null = null; private beamKey = '';
  gauge = 0;
  flags = { avset: false, sails: false, mrle: false };
  private luts = new Map<string, Lut>();
  private overlayLines: LineSet; private overlayPts: PointSet; private overlayText: TextSet; private overlayFill: PolySet;
  private site = '';
  private wipeStart = 0; private wipeFromKey = '';
  /** Radar Control "Display old sweep" / "Flash old sweep": the previous sweep under a sweep still arriving. */
  readonly liveOld = prefObject('liveOldSweep', { display: true, flash: true });
  private flashStart = 0; private compositeKey = '';
  /** Live-scan data age text (seconds since the newest received radial), null when no live sweep is shown. */
  dataAge: string | null = null;
  private ageText: TextSet;
  overlays: { cells: any[]; tvs: any[]; hail: any[]; meso: any[]; ml: any[]; ss: string[][]; sti: string[][] } = { cells: [], tvs: [], hail: [], meso: [], ml: [], ss: [], sti: [] };
  /**
   * Newest automatic storm motion: the Level 3 (56rm0) vector of the selected site's newest volume and its volume
   * time (the custom radar's automatic input); null when there is none, it is invalid or older than AUTO_MOTION_MAX_AGE.
   */
  autoMotion: { speedKt: number; fromDeg: number; site: string; timeMs: number } | null = null;
  /** Volume time of the storm-cell (STI) product behind `scit` (0 when none matches the shown volume), for ETAs. */
  overlayTime = 0;
  /** Decoded storm-attribute products by `site|ds`, then volume time (ms). */
  private storm = new Map<string, Map<number, any>>();
  /** Product files already read (`url@listing time` → listing time). */
  private stormRead = new Map<string, number>();
  /** Set once the selected site's products were listed; until then a missing match is not reported. */
  private stormListed = false;
  /** Products matched to the shown volume; the overlays are rebuilt when it changes. */
  private overlayKey = '';
  /** Volume time the overlays and storm motion are matched to: the drawn radar frame, else the products' own loop. */
  shownVolume: number | null = null;
  /** "No storm attributes for HH:MMZ" when an overlay is on and no product matches the shown volume, else ''. */
  overlayNote = '';
  private products(ds: string): Iterable<any> { return this.storm.get(`${this.currentSite()}|${ds}`)?.values() ?? []; }
  /** Automatic (56rm0) storm motion of the volume scanned at `volumeMs`, or null when none matches it. */
  motionFor(volumeMs: number | null): { speedKt: number; fromDeg: number } | null {
    return volumeMs === null ? null : motionOf(matchVolume(this.products('56rm0'), volumeMs));
  }
  /** Storm motion for a volume (default the shown one): the manual vector, or its own L3 vector when automatic. */
  stormMotion(volumeMs = this.shownVolume): { speedKt: number; fromDeg: number } {
    const auto = settings.bool('settings.nexradStormMotionCustom') ? null : this.motionFor(volumeMs);
    return auto ?? { speedKt: settings.num('settings.nexradStormMotionSpeed'), fromDeg: settings.num('settings.nexradStormMotionAzimuth') };
  }
  /** Storm attributes of the newest loaded volume (for live consumers); a list is null when its product is not loaded. */
  latestStormAttributes(): { site: string; volumeTimeMs: number; cells: any[] | null; tvs: any[] | null; hail: any[] | null; meso: any[] | null } | null {
    const ds = ['58sti', '61tvs', 'p59hi', '141md'];
    const newest = Math.max(...ds.flatMap((d) => [...this.products(d)].map((p) => p.volumeTimeMs)));
    if (!Number.isFinite(newest)) return null;
    const [sti, tvs, hi, md] = ds.map((d) => matchVolume(this.products(d), newest));
    const motion = stiMotion(sti?.pages ?? []);
    const cells = sti ? sti.cells.map((c: any) => ({ ...c, dir: motion.get(c.id)?.dir ?? NaN, speed: motion.get(c.id)?.speed ?? NaN })) : null;
    return { site: this.currentSite(), volumeTimeMs: newest, cells, tvs: tvs ? [...tvs.tvs, ...tvs.etvs] : null, hail: hi?.hail ?? null, meso: md?.features ?? null };
  }
  scit: { id: string; dir: number; speed: number; maxDbz: number; tvs: boolean; meso: boolean; poh: number; posh: number; mehs: number; x: number; y: number }[] = [];
  onTilts: () => void = () => {};
  /** Fixed volume list (archive data) used instead of the live index; set by the benchmark and recorded references. */
  fixture: { site: string; files: L2File[] } | null = null;
  /** The Level 2 volume pane 0 drew last. */
  private get lastDrawn() { return this.views[0].lastDrawn; }
  private set lastDrawn(f: L2Frame | null) { this.views[0].lastDrawn = f; }
  /** Range rings and the VR-shear measurement around the selected site. */
  readonly tools: RadarTools;
  /** Volume packs (every tilt of one moment) of this layer's volumes, for the cross-section and 3D views. */
  readonly volumes: VolumeStore;
  /**
   * What the pack of `moment` for the Level 2 volume drawn now is requested for (site, volume, tilt-selection and
   * dealiasing settings, and how much of a live volume has arrived); null when no Level 2 volume is drawn.
   */
  volumeRequest(moment: VolumeMoment): PackRequest | null {
    const f = this.lastDrawn, info = this.siteInfo();
    if (!f || !info || !this.isL2() || !this.l2.includes(f)) return null;
    return this.packRequest(f, moment, info);
  }
  private packRequest(f: L2Frame, moment: VolumeMoment, info: { lon: number; lat: number; elevFt: number }): PackRequest {
    const last = f.meta?.sweeps[f.meta.sweeps.length - 1];
    return {
      site: this.currentSite(), url: f.file.url, live: f.file.live, chunks: f.file.chunks, moment,
      latest: settings.num('settings.nexradLatestUpdateMode') >= 1, qualityDealiasing: settings.bool('settings.nexradQualityDealiasing'),
      version: f.file.live ? `${f.meta?.sweeps.length}/${last?.radials}` : '', lon: info.lon, lat: info.lat, heightKm: (info.elevFt * 0.3048) / 1000,
    };
  }
  /**
   * Pack requests of `moment` for the Level 2 volumes of the shown loop, oldest first, with their volume times, and
   * the index of the one draw() shows at the timeline time (the earlier volume of a blend); -1 when it shows none.
   */
  volumeFrames(moment: VolumeMoment): { frames: { t: number; q: PackRequest }[]; shown: number } {
    const info = this.siteInfo();
    if (!info || !this.enabled() || !this.isL2()) return { frames: [], shown: -1 };
    const shown = this.shownL2();
    const { a } = bracket(shown.map((f) => ({ t: f.t, f })), timeline.t, settings.num('settings.nexradScanTransitionMode') >= 1, 15 * 60e3);
    return { frames: shown.map((f) => ({ t: f.t, q: this.packRequest(f, moment, info) })), shown: a ? shown.indexOf(a.f) : -1 };
  }
  /**
   * The uploaded pack of volumeRequest(moment), requested on first use; null while it loads or when there is none.
   * Call it every frame the pack is wanted: a pack nobody asks for is dropped.
   */
  volumePack(moment: VolumeMoment): GpuPack | null { const q = this.volumeRequest(moment); return q && this.volumes.get(q); }
  prepass(ctx: PrepassContext) { this.volumes.pump(); this.section.prepass(ctx); this.trail.prepass(ctx); this.view3d.prepass(ctx); }
  /** The vertical cross-section / RHI tool and the max-value trail. */
  readonly section: CrossSection;
  readonly trail: RadarTrail;
  /** 3D view of the shown Level 2 volume (volume rendering or isosurfaces). */
  readonly view3d: Volume3D;

  constructor(r: Renderer, atlas: GlyphAtlas) {
    super(r);
    this.overlayLines = new LineSet(r); this.overlayPts = new PointSet(r); this.overlayText = new TextSet(r, atlas); this.overlayFill = new PolySet(r);
    this.ageText = new TextSet(r, atlas);
    this.tools = new RadarTools(r, atlas, this);
    this.volumes = new VolumeStore(r, this.id);
    this.section = new CrossSection(r, atlas, this);
    this.trail = new RadarTrail(r, this);
    this.view3d = new Volume3D(r, atlas, this);
    onIsotherms(this.isothermsArrived);
  }

  enabled() { return settings.bool('layerState.NEXRADOn'); }
  overlaysEnabled() { return ['NEXRADStormTracksOn', 'NEXRADTVSIconsOn', 'NEXRADHAILIconsOn', 'NEXRADMESOIconsOn', 'NEXRADMeltingLayerOn'].some((k) => settings.bool('layerState.' + k)); }
  /**
   * What a pane shows. Pane 0 (and any pane the layout does not show) is the radar settings and the tilt
   * preference, at the timeline time; panes 1–3 are the pane store's views.
   */
  view(pane = 0): RadarView {
    if (pane > 0 && pane < panes.count) return panes.views[pane - 1];
    return { level2: settings.bool('layerState.NEXRADLevel2'), product: settings.num('layerState.NEXRADLevel2Product'), l3: settings.num('layerState.NEXRADLevel3Product'), tilt: this.tiltAngle, offsetMin: 0 };
  }
  /** Panes shown, and those of them that show Level 2. */
  private paneList() { return Array.from({ length: panes.count }, (_, p) => p); }
  private l2Panes() { return this.paneList().filter((p) => this.isL2(p)); }
  /** The live composite replaces the product of pane 0 only. */
  private composite(pane: number) { return pane === 0 && this.liveComposite; }
  isL2(pane = 0) { return this.view(pane).level2; }
  product(pane = 0) { return this.composite(pane) ? 0 : this.view(pane).product; }
  l3Entry(pane = 0): L3Entry { return L3[this.view(pane).l3] ?? L3[0]; }
  siteInfo() { return RADAR_SITES.find((s) => s.id === settings.str('settings.nexradSiteICAO').toUpperCase()) ?? null; }
  invalidate() { this.views.forEach((v) => v.invalidate()); this.view3d.invalidate(); }

  /** Bumped by freeAll (site change): every request of an older generation is discarded when it completes. */
  private gen = 0;
  private currentSite() { return settings.str('settings.nexradSiteICAO').toUpperCase(); }
  /**
   * What a Level 2 sweep means: site, product, live composite, tilt (volume products and the composite have none)
   * and the product's algorithm inputs. A sweep is drawn, probed and listed only under the identity it was built for.
   */
  l2Identity(pane = 0): string {
    const p = this.product(pane), composite = this.composite(pane), tilt = composite || p >= 11 ? '' : this.view(pane).tilt;
    // Automatic storm motion is per volume (each sweep records the vector it was built with; see fits).
    const auto = !settings.bool('settings.nexradStormMotionCustom');
    return `${this.currentSite()}|${p}|${composite}|${tilt}|${algorithmKey(p, this.algorithmParams(), auto)}${this.rolling(pane) ? '|rolling' : ''}`;
  }
  /** Rolling mode of the live volume's volume products (11–19): tilts not yet rescanned come from the previous volume. */
  rolling(pane = 0) { return settings.bool('ext.settings.nexradLevel2Rolling') && !this.composite(pane) && this.product(pane) >= 11; }
  l3Identity(pane = 0): string { return `${this.currentSite()}|${this.l3Entry(pane).ds}`; }
  /** Volumes of the loop: all of them, or the newest PANE_VOLUMES while more than one pane is shown. */
  private loopL2(): L2Frame[] { return panes.count > 1 ? this.l2.slice(-PANE_VOLUMES) : this.l2; }
  private shownL2(pane = 0): L2Frame[] { const id = this.l2Identity(pane); return this.loopL2().filter((f) => this.fits(f, id, pane)); }
  /** A sweep fits its identity; storm-relative velocity also only while built with its volume's current storm motion. */
  private fits(f: L2Frame, id: string, pane = 0): boolean {
    const sw = slot(f, pane)?.sweep;
    return sw?.id === id && (this.product(pane) !== 7 || this.composite(pane) || sw.motion === JSON.stringify(this.stormMotion(f.t)));
  }
  private shownL3(pane = 0): L3Frame[] { const id = this.l3Identity(pane); return this.paneDraw(pane).l3.filter((f) => f.id === id && (f.tex || f.raster)); }
  private dropSweep(s: L2Slot) { s.sweep?.tex.destroy(); s.sweep = undefined; }

  /** Frees the Level 2 volumes (nothing is listed for the selection). */
  private freeL2() {
    for (const f of this.l2) for (const s of slots(f)) s.sweep?.tex.destroy();
    this.l2 = [];
  }
  /** Frees a pane's Level 3 loop. */
  private freeL3(v: PaneDraw) {
    for (const f of v.l3) { f.tex?.tex.destroy(); f.raster?.tex.destroy(); }
    v.l3 = []; v.l3Key = '';
  }
  /**
   * Frees what the panes other than pane 0 no longer show: sweeps of a pane that left the layout or shows Level 3,
   * or of a volume outside the loop, and the Level 3 loop of a pane that left the layout or shows Level 2.
   */
  private trimPanes() {
    const loop = this.loopL2();
    for (const f of this.l2) f.panes?.forEach((s, i) => {
      if (s && (i + 1 >= panes.count || !this.isL2(i + 1) || !loop.includes(f))) { s.sweep?.tex.destroy(); f.panes![i] = undefined; }
    });
    this.views.forEach((v, p) => { if (p > 0 && v.l3.length && (p >= panes.count || this.isL2(p))) this.freeL3(v); });
  }

  /** Frees everything for a site change ("Radar site switched. Freeing all volumes."). */
  freeAll() {
    this.gen++;
    this.volumes.clear();
    this.freeL2();
    this.views.forEach((v) => this.freeL3(v));
    this.tilts = []; this.onTilts();
    this.overlays = { cells: [], tvs: [], hail: [], meso: [], ml: [], ss: [], sti: [] };
    this.scit = [];
    this.storm.clear(); this.stormRead.clear(); this.stormListed = false; this.overlayKey = ''; this.overlayTime = 0;
    this.clearAutoMotion(); // the previous site's vector is never the new site's automatic input
  }

  /** The selected site as an isotherm sampling point. */
  private sitePoint(): RadarPoint | null { const i = this.siteInfo(); return i ? { lon: i.lon, lat: i.lat, elevM: i.elevFt * 0.3048 } : null; }
  /** Environmental isotherm table of the selected site, for the status text of the algorithm dialog. */
  envStatus(): string { const p = this.sitePoint(); return p ? isothermStatus(this.currentSite(), p) : 'No environmental isotherm data loaded'; }

  /** Build parameters of a pane's product at the selected site for a volume scanned at `volumeMs`. */
  buildParams(volumeMs = timeline.t, pane = 0): L2BuildParams {
    const p = this.algorithmParams(volumeMs);
    return { ...p, envIsotherms: hailEnvironment(this.product(pane), p.isothermAuto, this.sitePoint(), volumeMs) };
  }
  /** Rebuilds a hail product of the selected site when its isotherms arrive (other radars' arrivals are ignored). */
  private readonly isothermsArrived = (key: string) => {
    const p = this.sitePoint();
    if (p && key === pointKey(p) && this.l2Panes().some((q) => usesIsotherms(this.product(q))) && !settings.bool('settings.nexradAlgorithmHailIsothermCustom')) this.reloadL2();
  };
  /** A pane's Level 2 product is storm-relative velocity, which needs each volume's storm motion. */
  private srvShown() { return this.paneList().some((p) => this.view(p).product === 7); }
  /** Listeners told when the automatic (Level 3) storm motion appears, changes or is dropped. */
  readonly autoMotionListeners = new Set<() => void>();
  /**
   * Sets the automatic storm motion of the selected site from a product scanned at `timeMs`; Level 2 storm-relative
   * velocity and listeners follow a changed vector.
   */
  setAutoMotion(m: { speedKt: number; fromDeg: number }, timeMs = Date.now()) {
    const site = this.currentSite();
    const changed = this.autoMotion?.speedKt !== m.speedKt || this.autoMotion?.fromDeg !== m.fromDeg || this.autoMotion?.site !== site;
    this.autoMotion = { ...m, site, timeMs };
    if (changed) this.autoMotionChanged();
  }
  /** Drops the automatic storm motion: storm-relative velocity falls back to the manual vector. */
  clearAutoMotion() {
    if (!this.autoMotion) return;
    this.autoMotion = null;
    this.autoMotionChanged();
  }
  /** Drops an automatic vector whose product is older than AUTO_MOTION_MAX_AGE (no longer current). */
  expireAutoMotion(now = timeline.now()) { if (this.autoMotion && now - this.autoMotion.timeMs > AUTO_MOTION_MAX_AGE) this.clearAutoMotion(); }
  private autoMotionChanged() {
    for (const fn of this.autoMotionListeners) fn();
  }
  /** Product algorithm settings for a volume (without the environmental isotherms, which depend on the volume time). */
  algorithmParams(volumeMs = this.shownVolume): Omit<L2BuildParams, 'envIsotherms'> {
    const [zl, zu] = hailThresholds(settings.num('settings.nexradAlgorithmHailZLower'), settings.num('settings.nexradAlgorithmHailZUpper'));
    return {
      qualityDealiasing: settings.bool('settings.nexradQualityDealiasing'),
      stormMotion: this.stormMotion(volumeMs),
      hailZLower: zl, hailZUpper: zu,
      // "Custom isotherm heights" on → the custom heights; off → the environmental table (falls back to custom).
      isothermAuto: !settings.bool('settings.nexradAlgorithmHailIsothermCustom'),
      h0Custom: settings.num('settings.nexradAlgorithmHailIsotherm0CCustom'), hm20Custom: settings.num('settings.nexradAlgorithmHailIsothermM20CCustom'),
      etThreshold: settings.num('settings.nexradAlgorithmETZThreshold'),
      gust1991: settings.bool('settings.nexradAlgorithmGust1991'),
    };
  }

  private running: Promise<void> | null = null; private again = false;
  /** Timeline epoch (mode and archive time) everything held was requested under. */
  private epoch = timeline.epoch;
  /** Overlapping refresh requests (live polling, setting changes) coalesce into one pass plus at most one rerun. */
  refresh(): Promise<void> {
    // A mode or archive-time change frees everything at once; results still in flight are discarded (freeAll).
    if (timeline.epoch !== this.epoch) { this.epoch = timeline.epoch; this.freeAll(); this.index = null; if (this.enabled()) this.setStatus('loading', 'Retrieving index...'); }
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => { do { this.again = false; await this.refreshOnce(); } while (this.again); })().finally(() => { this.running = null; });
    return this.running;
  }
  private async refreshOnce() {
    const site = settings.str('settings.nexradSiteICAO').toUpperCase();
    if (site !== this.site) { this.freeAll(); this.site = site; }
    this.expireAutoMotion(); // also while storm-relative velocity (and so the vector's refresh) is off
    if (!this.enabled()) this.publishTimeline();
    if (!this.enabled() && !this.overlaysEnabled()) { this.statusText = `Awaiting activation (${this.isL2() ? 'L2' : 'L3'})...`; this.setStatus('off', ''); return; }
    try {
      this.trimPanes();
      if (this.enabled() && this.l2Panes().length) await this.refreshL2(site);
      if (this.enabled()) await Promise.all(this.paneList().filter((p) => !this.isL2(p)).map((p) => this.refreshL3(site, p)));
      // Overlay products change once per volume: live-sweep polls (every few seconds) re-read them at most each minute.
      if ((this.overlaysEnabled() || this.srvShown()) && (!this.liveScan || Date.now() - this.overlaysAt > 60e3)) { this.overlaysAt = Date.now(); await this.refreshOverlays(site); }
    } catch (e) {
      this.statusText = `Error: ${(e as Error).message}`;
      this.setStatus('error', this.statusText);
    }
  }

  // ------------------------------------------------------------------------------------------- Level 2
  /** Live source in use: 'chunks' (real-time chunk feed) or 'full-volume' (growing TGFTP file fallback), with the reason. */
  liveSource: { kind: 'chunks' | 'full-volume' | null; note: string } = { kind: null, note: '' };
  private chunkFeed = new ChunkFeed();
  private overlaysAt = 0;
  private index: { key: string; at: number; files: L2File[] } | null = null;
  /** Live polls are frequent (chunks arrive every few seconds); the volume index is re-read at most every 60 s. */
  private async l2Index(site: string, src: 2 | 3 | 4): Promise<L2File[]> {
    const archive = timeline.mode === 'archive';
    const key = `${site}|${src}|${settings.str('settings.nexradL2CustomDataSource')}|${timeline.key}|${archive ? timeline.loopStart : ''}`;
    // An archive listing does not change; the live one is re-read.
    if (this.index && this.index.key === key && (archive || Date.now() - this.index.at < (this.liveScan ? 60e3 : 10e3))) return this.index.files;
    const files = await listL2(site, src, settings.str('settings.nexradL2CustomDataSource'), timeline.loopStart, archive ? timeline.loopEnd : undefined);
    this.index = { key, at: Date.now(), files };
    return files;
  }
  /** Current chunk volume as a live frame, or null (the growing full-volume file is used instead). */
  private async liveChunks(site: string): Promise<L2File | null> {
    try {
      const v = await this.chunkFeed.poll(site);
      if (!v) { this.liveSource = { kind: 'full-volume', note: 'no current chunk volume for this site' }; return null; }
      if (Date.now() - v.timeMs > 20 * 60e3) { this.liveSource = { kind: 'full-volume', note: `newest chunk volume is ${Math.round((Date.now() - v.timeMs) / 60e3)} min old` }; return null; }
      this.liveSource = { kind: 'chunks', note: `chunk volume ${v.vol}, ${v.chunks.length} chunks${v.complete ? ' (complete)' : ''}` };
      return { t: v.timeMs, url: `chunks:${site}/${v.vol}/${v.timeMs}`, live: !v.complete, name: `${site} chunks ${v.vol}`, chunks: v.chunks };
    } catch (e) {
      this.liveSource = { kind: 'full-volume', note: `chunk feed unavailable: ${(e as Error).message}` };
      return null;
    }
  }

  private async refreshL2(site: string) {
    const gen = this.gen;
    // Only the AWS archive keeps past volumes.
    const archive = timeline.mode === 'archive';
    const src = archive ? 3 : effectiveSource(settings.num('settings.nexradL2DataSource'), settings.str('settings.nexradL2CustomDataSource'));
    // The status line and the timeline are pane 0's: they follow Level 2 only while pane 0 shows it.
    const main = () => this.isL2();
    if (main()) { this.statusText = 'Retrieving Level 2 index...'; this.onStatus(this); }
    let files = this.fixture && this.fixture.site === site ? this.fixture.files : await this.l2Index(site, src);
    if (gen !== this.gen) return; // site changed while listing
    // Live sweep: the real-time chunk volume replaces the growing full-volume file when the chunk feed is current.
    if (this.liveScan && !this.fixture) {
      const live = await this.liveChunks(site);
      if (gen !== this.gen) return;
      if (live) files = [...files.filter((f) => !f.live && Math.abs(f.t - live.t) > 60e3), live].sort((a, b) => a.t - b.t);
    } else this.liveSource = { kind: null, note: '' };
    if (!files.length && archive) { this.freeL2(); if (main()) { this.statusText = `Level 2 at ${site}: ${NOT_AVAILABLE}`; this.setStatus('unavailable', NOT_AVAILABLE); this.publishTimeline(); } return; }
    if (!files.length) { if (main()) { this.statusText = 'Server returned empty file index for active site. No action taken.'; this.setStatus('error', this.statusText); } return; }
    const newest = files[files.length - 1];
    if (main() && !this.fixture && !archive && Date.now() - newest.t > 30 * 60e3) this.statusText = `Site down. Last volume ${new Date(newest.t).toUTCString().slice(17, 22)}Z`;
    const download = settings.num('settings.nexradLevel2MaxVolumeDownloadCount');
    const memory = settings.num('settings.nexradLevel2VolumeCountMemory');
    const held = new Set(this.l2.filter((f) => !f.file.live).map((f) => f.file.url));
    const wanted = l2Retention(files, held, download, memory, this.liveScan && newest.live ? newest : null);
    const keep = new Map(this.l2.map((f) => [f.file.url, f]));
    const next: L2Frame[] = wanted.map((f) => keep.get(f.url) ?? { t: f.t, file: f });
    for (const f of this.l2) if (!next.includes(f)) for (const s of slots(f)) s.sweep?.tex.destroy();
    this.l2 = next;
    this.trimPanes();
    if (this.liveScan) { const lf = this.l2.find((f) => f.file.live); if (lf) { for (const s of slots(lf)) s.key = undefined; lf.file = { ...newest, live: true }; } }
    await Promise.all([...this.l2].reverse().map((f) => this.loadL2(f)));
    if (gen === this.gen) this.updateL2Status();
  }

  sweepFor(meta: L2Meta, product: number, angle = this.tiltAngle): number | null {
    // Column ZDR/KDP need dual-pol moments; the other volume products need reflectivity only.
    if (product >= 11) return (product === 17 || product === 18) && !meta.sweeps.some((s) => s.moments.includes('RHO')) ? null : 0;
    const need = l2Moment(product);
    const showSplit = settings.bool('settings.nexradLevel2ShowSplitCuts');
    const cands = meta.sweeps.filter((s) => need && s.moments.includes(need));
    if (!cands.length) return null;
    let best: L2SweepMeta[] = [];
    let bd = Infinity;
    for (const s of cands) {
      const a = s.nominal ?? s.elevation;
      const d = Math.abs(a - angle);
      if (d < bd - 0.05) { bd = d; best = [s]; } else if (Math.abs(d - bd) <= 0.05) best.push(s);
    }
    if (!showSplit && need === 'REF') best = best.filter((s) => s.split !== 'CD').length ? best.filter((s) => s.split !== 'CD') : best;
    // Latest update mode (1): with SAILS/MRLE rescans at the angle, show the most recent cut.
    const pick = settings.num('settings.nexradLatestUpdateMode') >= 1 ? best[best.length - 1] : best[0];
    return pick.index;
  }

  /**
   * Reads a volume's metadata once for all panes (again for a live volume), then builds each Level 2 pane's product.
   * A newer read of the volume supersedes this one.
   */
  private async loadL2(f: L2Frame) {
    const gen = this.gen;
    const current = () => gen === this.gen && this.l2.includes(f);
    try {
      if (!f.meta || f.file.live) {
        const token = f.metaReq = (f.metaReq ?? 0) + 1;
        const meta = await pool.for(this.id).run<L2Meta>('l2.meta', { url: f.file.url, live: f.file.live, chunks: f.file.chunks }, f.file.url);
        if (token !== f.metaReq || !current()) return; // a newer read of this volume, or another site
        f.meta = meta;
      }
      if (f.meta.volumeTimeMs) f.t = f.meta.volumeTimeMs;
      if (!this.tilts.length || f === this.l2[this.l2.length - 1]) this.buildTilts(f.meta);
    } catch (e) {
      if (!current()) return;
      for (const p of this.l2Panes()) this.buildFailed(this.slotFor(f, p), p, e);
      return;
    }
    // Panes other than pane 0 hold sweeps of the loop's volumes only (trimPanes).
    const loop = this.loopL2().includes(f);
    await Promise.all(this.l2Panes().filter((p) => p === 0 || loop).map((p) => this.buildL2(f, p, gen)));
  }

  /**
   * Builds a pane's product for one volume. The newest request for a pane's slot wins: a result is applied only while
   * its request is still the slot's newest, the site is unchanged and the pane's display identity (product, tilt, live
   * composite, algorithm inputs) is the one it was requested for; it never reaches another pane's slot. When the
   * product cannot be built, no sweep of another meaning stays behind it.
   */
  private async buildL2(f: L2Frame, pane: number, gen: number) {
    const product = this.product(pane), composite = this.composite(pane), id = this.l2Identity(pane), meta = f.meta!;
    const s = this.slotFor(f, pane);
    // The slot is replaced when the pane leaves the layout or its volume the loop.
    const current = () => gen === this.gen && this.l2.includes(f) && slot(f, pane) === s;
    let key = '';
    try {
      const sweepIdx = composite ? -1 : this.sweepFor(meta, product, this.view(pane).tilt);
      const params = this.buildParams(f.t, pane);
      // Rolling: a live volume's product also reads the previous complete volume (its own identity, see l2Identity).
      const prev = this.rolling(pane) && f.file.live ? this.l2.filter((x) => !x.file.live && x.t < f.t).pop() : undefined;
      const rolling = prev && { url: prev.file.url, chunks: prev.file.chunks };
      key = `${id}|${sweepIdx}|${JSON.stringify(params)}|${meta.sweeps.length}|${meta.sweeps[meta.sweeps.length - 1]?.radials}|${rolling?.url ?? ''}`;
      if (s.key === key) { s.req = undefined; return; } // already built (or known unavailable); an older request in flight is superseded
      if (s.req === key) return;
      if (sweepIdx === null) { s.error = 'not available for this volume'; this.dropSweep(s); s.key = key; s.req = undefined; this.updateL2Status(); return; }
      s.req = key;
      const res = composite
        ? await pool.for(this.id).run('l2.composite', { url: f.file.url, live: f.file.live, chunks: f.file.chunks, base: settings.num('settings.nexradLevel2LiveCompositeCAPPIBase'), top: settings.num('settings.nexradLevel2LiveCompositeCAPPITop'), selectiveMax: settings.bool('settings.nexradLevel2LiveCompositeSelectiveMaximum') }, f.file.url)
        : await pool.for(this.id).run('l2.product', { url: f.file.url, live: f.file.live, chunks: f.file.chunks, sweep: sweepIdx, product, params, rolling }, f.file.url);
      if (s.req !== key) return; // a newer request for this slot replaced this one
      s.req = undefined;
      if (!current() || this.l2Identity(pane) !== id) return;
      if (!res.sweep) { s.error = 'product unavailable'; this.dropSweep(s); s.key = key; this.updateL2Status(); return; }
      const sw = res.sweep;
      const old = s.sweep;
      const tex = uploadSweep(this.r, sw, this.id);
      const expected = sw.half ? 720 : 360;
      s.sweep = { ...tex, elevation: sw.elevation, startMs: sw.startMs, endMs: sw.endMs, complete: sw.complete, progress: Math.min(1, sw.radials / expected), id, motion: JSON.stringify(params.stormMotion), rolling: sw.rolling };
      if (old?.id === id && f.file.live) { this.wipeStart = performance.now(); this.wipeFromKey = s.key ?? ''; }
      // Live-composite update effect: flash when the newest composite changes (not on the first load).
      if (composite && f === this.l2[this.l2.length - 1]) {
        const ck = `${f.file.url}|${sw.radials}|${sw.endMs}`;
        if (this.compositeKey && ck !== this.compositeKey) this.flashStart = performance.now();
        this.compositeKey = ck;
      }
      old?.tex.destroy();
      s.key = key;
      s.error = undefined;
      // The live-sweep gauge, readout and beam follow pane 0's tilt.
      if (f.file.live && pane === 0) {
        const sm = meta.sweeps[sweepIdx ?? 0];
        this.gauge = Math.round(s.sweep.progress * 360);
        this.liveSweepText = `${(sw.azimuths[sw.radials - 1] ?? 0).toFixed(0)}°/${(sm?.elevation ?? 0).toFixed(1)}°`;
        this.liveAz = sw.complete ? null : sw.azimuths[sw.radials - 1] ?? null;
      }
      this.updateL2Status();
    } catch (e) {
      if (key && s.req && s.req !== key) return;
      s.req = undefined;
      if (!current()) return;
      this.buildFailed(s, pane, e);
    }
  }
  private slotFor(f: L2Frame, pane: number): L2Slot { return pane === 0 ? f : ((f.panes ??= [])[pane - 1] ??= {}); }
  /** A failed rebuild of the same meaning keeps the previous sweep; anything else is removed. */
  private buildFailed(s: L2Slot, pane: number, e: unknown) {
    s.req = undefined;
    s.error = (e as Error).message;
    if (s.sweep && s.sweep.id !== this.l2Identity(pane)) this.dropSweep(s);
    s.key = undefined;
    this.updateL2Status();
  }

  private buildTilts(meta: L2Meta) {
    const showSplit = settings.bool('settings.nexradLevel2ShowSplitCuts');
    const tabs: TiltTab[] = [];
    for (const s of meta.sweeps) {
      const angle = Math.round((s.nominal ?? s.elevation) * 10) / 10;
      if (!showSplit && s.split === 'CD' && tabs.some((t) => Math.abs(t.angle - angle) < 0.05 && !t.label.includes('SAILS') && !t.label.includes('MRLE'))) {
        tabs.find((t) => Math.abs(t.angle - angle) < 0.05)!.sweepIndices.push(s.index);
        continue;
      }
      const label = showSplit && s.split ? `${s.label} (${s.split})` : s.label;
      tabs.push({ key: `${s.index}`, label, angle, sweepIndices: [s.index] });
    }
    this.tilts = tabs;
    this.vcpText = `VCP: ${meta.vcp ?? '--'}`;
    this.flags = { avset: !!meta.avset, sails: meta.sails > 0, mrle: meta.mrle > 0 };
    this.onTilts();
  }

  setTilt(angle: number) {
    this.tiltAngle = angle;
    savePref('l2tilt', angle, 'Level 2 tilt');
    this.reloadL2();
  }

  /** Requests every pane's product for every volume; sweeps of another meaning are freed now, not relabelled. */
  private reloadL2() {
    this.trimPanes();
    const ids = this.paneList().map((p) => this.l2Identity(p));
    let dropped = false;
    for (const f of this.l2) {
      ids.forEach((id, p) => { const s = slot(f, p); if (s?.sweep && !this.fits(f, id, p)) { this.dropSweep(s); s.key = undefined; dropped ||= p === 0; } });
      void this.loadL2(f);
    }
    if (dropped && this.enabled() && this.isL2()) this.updateL2Status();
  }

  /** Re-requests products after a product, algorithm, tilt or live-composite change. */
  reloadProducts() { this.reloadL2(); this.views.forEach((v) => { for (const f of v.l3) { f.tex?.tex.destroy(); f.tex = undefined; } }); if (this.paneList().some((p) => !this.isL2(p))) this.refresh(); }

  /**
   * The layout or a pane's view changed: the panes' products are requested and what a pane no longer shows is freed.
   * A pane whose view did not change keeps its sweeps (their requests are already answered under the same key).
   */
  panesChanged() {
    this.reloadL2();
    if (this.enabled()) { if (this.isL2()) this.updateL2Status(); void this.refresh(); }
  }

  private updateL2Status() {
    if (!this.isL2()) return; // the status line and the timeline are pane 0's
    const ready = this.shownL2();
    const newest = this.loopL2()[this.loopL2().length - 1];
    this.nrtText = newest ? `NRT: ${Math.max(0, Math.round((timeline.now() - (newest.sweep?.endMs || newest.t)) / 60e3))} min` : 'NRT: ---';
    if (this.liveScan) {
      const how = this.liveSource.kind === 'chunks' ? `chunk feed: ${this.liveSource.note}` : `full-volume fallback${this.liveSource.note ? ` (${this.liveSource.note})` : ''}`;
      this.statusText = `${newest?.file.live ? 'Live sweep active' : 'Awaiting next scan'} · ${how}`;
    }
    else this.statusText = ready.length ? `${ready.length}/${this.loopL2().length} volumes (keeps ≤${panes.count > 1 ? Math.min(PANE_VOLUMES, settings.num('settings.nexradLevel2VolumeCountMemory')) : settings.num('settings.nexradLevel2VolumeCountMemory')})` : this.l2.some((f) => f.error) ? (this.l2.find((f) => f.error)!.error ?? 'error') : 'Awaiting new volume...';
    this.setStatus(ready.length ? 'ready' : 'loading', this.withPtype(this.statusText), { frames: ready.length, newestMs: newest?.t });
    this.publishTimeline();
  }

  /**
   * Offers the shown loop to the main timeline while NEXRAD is on and "Wrap timeline to NEXRAD radar loop" is set;
   * otherwise withdraws it (the general timeline then steps and times playback).
   */
  publishTimeline() {
    const wrap = this.enabled() && settings.bool('settings.nexradTimelineConstrain');
    timeline.offer('nexrad-l2', wrap && this.isL2() ? this.shownL2().map((f) => f.t) : null);
    timeline.offer('nexrad-l3', wrap && !this.isL2() ? this.shownL3().map((f) => f.t) : null);
  }

  // ------------------------------------------------------------------------------------------- Level 3
  /** Lists and loads a pane's Level 3 loop; the status line and the timeline follow pane 0's. */
  private async refreshL3(site: string, pane = 0) {
    const p = this.l3Entry(pane), gen = this.gen, v = this.paneDraw(pane), main = pane === 0;
    const key = `${site}|${p.ds}`;
    const current = () => gen === this.gen && pane < panes.count && !this.isL2(pane) && this.l3Identity(pane) === key;
    if (main) this.statusText = `Retrieving ${p.awips} index...`;
    const archive = timeline.mode === 'archive';
    let files = archive ? [] : await listL3(site, p.ds), name: string = p.awips;
    if (archive) for (const code of l3ArchiveCodes(p.ds, p.awips)) {
      files = await listL3Archive(site, code, timeline.loopStart - 10 * 60e3, timeline.loopEnd);
      if (!current()) return;
      if (files.length) { if (code !== p.awips) name = `${code} (archived successor of ${p.awips})`; break; }
    }
    if (!current()) return; // site or product changed while listing
    if (!files.length && archive) { this.freeL3(v); if (main) { this.statusText = `${p.awips} at ${site}: ${NOT_AVAILABLE}`; this.setStatus('unavailable', NOT_AVAILABLE); this.publishTimeline(); } return; }
    const max = settings.num('settings.nexradLevel3MaxFrameCount');
    const wanted = files.filter((f) => f.t >= timeline.loopStart - 10 * 60e3).slice(-max);
    if (v.l3Key !== key) { this.freeL3(v); v.l3Key = key; }
    const keep = new Map(v.l3.map((f) => [`${f.url}@${f.t}`, f]));
    const next: L3Frame[] = wanted.map((w) => keep.get(`${w.url}@${w.t}`) ?? { t: w.t, url: w.url, id: key });
    for (const f of v.l3) if (!next.includes(f)) { f.tex?.tex.destroy(); f.raster?.tex.destroy(); }
    v.l3 = next;
    await Promise.all([...v.l3].reverse().map((f) => this.loadL3(f, p, v)));
    if (!current() || !main) return;
    const ready = this.shownL3();
    this.statusText = ready.length ? `${name}: ${ready.length}/${this.l3.length} frames` : wanted.length ? 'Awaiting new volume...' : `No ${p.awips} files at ${site}`;
    const nv = ready[ready.length - 1];
    this.vcpText = `VCP: ${nv?.vcp ?? '--'}`;
    this.nrtText = nv ? `NRT: ${Math.round((timeline.now() - (nv.volumeTimeMs ?? nv.t)) / 60e3)} min` : 'NRT: ---';
    this.setStatus(ready.length ? 'ready' : 'loading', this.withPtype(this.statusText), { frames: ready.length });
    this.publishTimeline();
  }

  private async loadL3(f: L3Frame, p: L3Entry, v: PaneDraw) {
    if (f.tex || f.raster || f.loading) return;
    f.loading = true;
    try {
      const res = await pool.for(this.id).run('l3', { url: f.url, live: !f.url.startsWith(AWS_L3) });
      if (!v.l3.includes(f) || f.tex || f.raster) return; // replaced (site or product change) or already rebuilt
      f.vcp = res.vcp; f.volumeTimeMs = res.volumeTimeMs; f.volumeScan = res.volumeScan;
      if (res.volumeTimeMs) f.t = res.volumeTimeMs;
      const rng = l3Range(p);
      const lut: Float32Array = res.lut;
      const flags = new Map<number, string>(res.flags);
      const encode = (code: number) => {
        const fl = flags.get(code);
        if (fl === 'RF') return 1;
        const v = lut[code];
        if (v !== v) return 0;
        return Math.max(2, Math.min(255, 2 + Math.round((253 * (v * rng.scale - rng.low)) / (rng.high - rng.low))));
      };
      if (res.radial) {
        const rad = res.radial;
        const codes = new Uint8Array(rad.codes.length);
        for (let i = 0; i < codes.length; i++) codes[i] = encode(rad.codes[i]);
        const az = Float32Array.from(rad.startAz, (a: number, i: number) => a + rad.widthAz[i] / 2);
        f.tex = uploadSweep(this.r, { radials: rad.radials, gates: rad.bins, firstKm: rad.firstBin * rad.gateKm + rad.gateKm / 2, gateKm: rad.gateKm, azimuths: az, half: rad.radials > 400, complete: rad.radials >= 359, codes, wordSize: 8 }, this.id);
        f.elevation = (res.p?.[2] ?? 5) / 10;
      } else if (res.raster) {
        const ras = res.raster, codes = new Uint8Array(ras.codes.length);
        for (let i = 0; i < codes.length; i++) codes[i] = encode(ras.codes[i]);
        const halfKm = (ras.cols * ras.cellKm) / 2, halfKmY = (ras.rows * ras.cellKm) / 2;
        const [w, s] = kmToLonLat(res.lon, res.lat, -halfKm, -halfKmY), [e, n] = kmToLonLat(res.lon, res.lat, halfKm, halfKmY);
        f.raster = { tex: this.r.gpu.texture2D(ras.cols, ras.rows, 'r8unorm', codes, 1, this.id), bounds: [s, w, n, e], nx: ras.cols, ny: ras.rows };
      } else f.error = 'no radial/raster data';
    } catch (e) { f.error = (e as Error).message; } finally { f.loading = false; }
  }

  // ------------------------------------------------------------------------------------------- overlays
  /** Level 3 products the enabled overlays draw (hail also feeds the storm-cell table). */
  private overlayDs(): string[] {
    const on = (k: string) => settings.bool('layerState.' + k), ds: string[] = [];
    if (on('NEXRADStormTracksOn')) ds.push('58sti', 'p62ss');
    if (on('NEXRADTVSIconsOn')) ds.push('61tvs');
    if (on('NEXRADHAILIconsOn') || on('NEXRADStormTracksOn')) ds.push('p59hi');
    if (on('NEXRADMESOIconsOn')) ds.push('141md');
    if (on('NEXRADMeltingLayerOn')) ds.push(ML_DS[settings.num('layerState.NEXRADMeltingLayerElevation')] ?? '166ma');
    return ds;
  }

  /**
   * Reads the overlay (and automatic storm motion) products of the loop's volumes from the rotating TGFTP files, newest
   * first, each file once. Products are kept by their own volume time and drawn only for the volume they match.
   */
  private async refreshOverlays(site: string) {
    const gen = this.gen, current = () => gen === this.gen && this.currentSite() === site;
    const wantMotion = this.srvShown() && !settings.bool('settings.nexradStormMotionCustom');
    const dsList = [...this.overlayDs(), ...(wantMotion ? ['56rm0'] : [])];
    const archive = timeline.mode === 'archive';
    const from = timeline.loopStart - 10 * 60e3, to = timeline.loopEnd + (archive ? 0 : LISTING_LAG_MAX_MS);
    // Archive files are named by their volume time, TGFTP files are listed by their arrival time.
    const list = (ds: string) => { const code = l3ArchiveCode(ds); return !archive ? listL3(site, ds) : code ? listL3Archive(site, code, from, to) : Promise.resolve([]); };
    const listed = await Promise.all(dsList.map((ds) => list(ds).catch(() => [])));
    if (!current()) return; // another site was selected meanwhile
    const frames = this.enabled() ? (this.isL2() ? this.l2 : this.l3).map((f) => f.t) : [];
    const cap = frames.length ? Infinity : settings.num('settings.nexradLevel3MaxFrameCount');
    const jobs = dsList.flatMap((ds, i) => overlayFiles(listed[i], frames, from, to, cap).filter((f) => !this.stormRead.has(`${f.url}@${f.t}`)).map((f) => ({ ds, f })));
    jobs.sort((a, b) => b.f.t - a.f.t);
    let next = 0, motionArrived = false;
    const reader = async () => {
      while (next < jobs.length && current()) {
        const { ds, f } = jobs[next++];
        let res: any;
        try { res = await pool.for(this.id).run('l3', { url: f.url, live: !archive }); } catch { continue; } // read again next refresh
        if (!current()) return;
        this.stormRead.set(`${f.url}@${f.t}`, f.t);
        if (!(res?.volumeTimeMs > 0)) continue; // never labelled with another time
        const key = `${site}|${ds}`;
        if (!this.storm.has(key)) this.storm.set(key, new Map());
        this.storm.get(key)!.set(res.volumeTimeMs, res);
        if (ds === '56rm0') motionArrived = true;
      }
    };
    await Promise.all(Array.from({ length: 4 }, reader));
    if (!current()) return;
    // Products the Level 3 archive does not hold for this period come from the IEM storm attributes.
    const missing = archive ? dsList.filter((ds, i) => IEM_DS.includes(ds) && !listed[i].length) : [];
    if (missing.length) await this.readIemAttributes(site, missing, frames.length ? frames : [timeline.loopEnd], current);
    if (!current()) return;
    const oldest = timeline.loopStart - 30 * 60e3;
    for (const m of this.storm.values()) for (const t of m.keys()) if (t < oldest) m.delete(t);
    for (const [k, t] of this.stormRead) if (t < oldest) this.stormRead.delete(k);
    this.stormListed = true;
    if (wantMotion) {
      const newest = [...this.products('56rm0')].reduce((a, p) => (!a || p.volumeTimeMs > a.volumeTimeMs ? p : a), null);
      const m = motionOf(newest);
      if (m && timeline.now() - newest.volumeTimeMs <= AUTO_MOTION_MAX_AGE) this.setAutoMotion(m, newest.volumeTimeMs);
      else this.clearAutoMotion();
      if (motionArrived && this.srvShown()) this.reloadL2();
    }
  }

  /**
   * Archive mode: IEM storm attributes for the radar frames, each request once. IEM answers with the volume nearest
   * the asked time, so the products are stored under the volume time they report and matched like Level 3 files.
   */
  private async readIemAttributes(site: string, dsList: string[], frames: number[], current: () => boolean) {
    const todo = frames.filter((t) => t >= IEM_ATTR_SINCE && !this.stormRead.has(`iem@${t}`));
    const reader = async () => {
      for (let t = todo.pop(); t !== undefined && current(); t = todo.pop()) {
        let gj: Parameters<typeof iemStormProducts>[0];
        try { gj = await fetchJson(iemAttrUrl(t), { cache: archiveCache(t), timeoutMs: 60_000 }); } catch { continue; } // asked again next refresh
        if (!current()) return;
        this.stormRead.set(`iem@${t}`, t);
        for (const set of iemStormProducts(gj, site)) for (const ds of dsList) {
          const key = `${site}|${ds}`, p = set.get(ds)!;
          if (!this.storm.has(key)) this.storm.set(key, new Map());
          if (!this.storm.get(key)!.has(p.volumeTimeMs)) this.storm.get(key)!.set(p.volumeTimeMs, p);
        }
      }
    };
    await Promise.all(Array.from({ length: 3 }, reader));
  }

  /** Volume time of the overlay products' own newest volume at the timeline time (no radar frame drawn), or null. */
  private ownOverlayFrame(ds: string[]): number | null {
    let best: number | null = null;
    for (const d of ds) for (const p of this.products(d)) {
      const t = p.volumeTimeMs;
      if (t <= timeline.t && timeline.t - t <= 15 * 60e3 && (best === null || t > best)) best = t;
    }
    return best;
  }

  /**
   * Matches the overlay products to the shown volume (the drawn radar frame `radarT`, with its volume scan number for
   * Level 3, else the products' own loop); overlays, the storm-cell table and the geometry are rebuilt when it changes.
   */
  private syncOverlays(radarT: number | null, radarScan?: number) {
    const ds = this.overlayDs();
    const frameT = radarT ?? this.ownOverlayFrame(ds);
    this.shownVolume = frameT;
    const scan = radarT === null ? undefined : radarScan;
    const m = new Map(ds.map((d) => [d, frameT === null ? null : matchVolume(this.products(d), frameT, undefined, scan)]));
    const none = frameT !== null && ds.length > 0 && [...m.values()].every((p) => !p);
    this.overlayNote = none && this.stormListed ? `No storm attributes for ${utcHm(frameT)}Z` : '';
    const key = `${this.currentSite()}|${ds.map((d) => `${d}@${m.get(d)?.volumeTimeMs ?? '-'}`).join(',')}|${this.overlayNote}`;
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    const sti = m.get('58sti'), tvs = m.get('61tvs'), hi = m.get('p59hi'), md = m.get('141md'), ss = m.get('p62ss');
    const ml = m.get(ds.find((d) => d.startsWith('166m')) ?? '');
    this.overlayTime = sti?.volumeTimeMs ?? 0;
    this.overlays = { cells: sti?.cells ?? [], tvs: [...(tvs?.tvs ?? []), ...(tvs?.etvs ?? [])], hail: hi?.hail ?? [], meso: md?.features ?? md?.circles ?? [], ml: ml?.contours ?? [], ss: ss?.pages ?? [], sti: sti?.pages ?? [] };
    this.buildScit();
    this.rebuildOverlays();
  }

  private buildScit() {
    const cells = this.overlays.cells;
    const hail = this.overlays.hail;
    const motion = stiMotion(this.overlays.sti);
    const maxDbz = new Map<string, number>();
    for (const page of this.overlays.ss) for (const line of page) {
      const m = /^\s*([A-Z]\d)\s+\d+\/\s*\d+\s+[\d.]+\s+[\d.]+\s+\d+\s+(\d+)/.exec(line);
      if (m) maxDbz.set(m[1], +m[2]);
    }
    this.scit = cells.map((c: any) => {
      const h = hail.reduce((best: any, x: any) => (Math.hypot(x.x - c.x, x.y - c.y) < (best ? Math.hypot(best.x - c.x, best.y - c.y) : 5) ? x : best), null);
      const mo = motion.get(c.id);
      return { id: c.id, dir: mo?.dir ?? NaN, speed: mo?.speed ?? NaN, maxDbz: maxDbz.get(c.id) ?? NaN, tvs: this.overlays.tvs.some((t: any) => Math.hypot(t.x - c.x, t.y - c.y) < 6), meso: this.overlays.meso.some((m: any) => Math.hypot(m.x - c.x, m.y - c.y) < 6), poh: h?.poh ?? 0, posh: h?.posh ?? 0, mehs: h ? h.maxSizeIn / 4 : 0, x: c.x, y: c.y };
    });
  }

  /** SCIT filter. */
  cellPasses(c: NexradLayer['scit'][number]) {
    if (!settings.bool('settings.nexradTracksGlobalFilterOn')) return true;
    // "Manual" enables the user thresholds (Min Refl / Min MEHS); TVS/MESO requirements apply on their own.
    const manual = settings.bool('settings.nexradTracksManualFilterOn');
    if (manual && settings.bool('settings.nexradTracksReflectivityFilterOn') && c.maxDbz === c.maxDbz && c.maxDbz < settings.num('settings.nexradTracksReflectivityFilter')) return false;
    if (manual && settings.bool('settings.nexradTracksMEHSFilterOn') && c.mehs < settings.num('settings.nexradTracksMEHSFilter')) return false;
    if (settings.bool('settings.nexradTracksTVSFilterOn') && !c.tvs) return false;
    if (settings.bool('settings.nexradTracksMESOFilterOn') && !c.meso) return false;
    return true;
  }

  /** Re-applies track/icon appearance settings to the current overlay data. */
  rebuildOverlays() { const i = this.siteInfo(); if (i) this.buildOverlayGeometry(i.lon, i.lat); }
  private buildOverlayGeometry(lon0: number, lat0: number) {
    const L = (x: number, y: number) => kmToLonLat(lon0, lat0, x, y);
    const lines: Polyline[] = [], pts: PointSpec[] = [], labels: Label[] = [];
    const tc = settings.arr<number>('settings.nexradTracksColor');
    const mlc = [1, 2, 3, 4].map((i) => settings.arr<number>(`settings.nexradMeltingLayerColor${i}`));
    this.overlayLines.setStyles([
      { color: [tc[0], tc[1], tc[2], 230], width: 1.6 }, { color: [tc[0], tc[1], tc[2], 200], width: 1.4, dash: 8 },
      ...mlc.map((c) => ({ color: [c[0], c[1], c[2], 230] as [number, number, number, number], width: 2 })),
      { color: [0, 0, 0, 200], width: 3.6 }, // 6: track line border (TFrmManualTracksControl "line border")
    ]);
    const border = settings.bool('ext.settings.nexradTracksLineBorder');
    const fills: PolyFill[] = [], fillStyles: FillStyle[] = [];
    if (settings.bool('layerState.NEXRADStormTracksOn')) this.buildTracks(L, lines, pts, labels, fills, fillStyles, tc);
    if (settings.bool('layerState.NEXRADTVSIconsOn')) for (const t of this.overlays.tvs) pts.push({ ...pos(L(t.x, t.y)), size: 16, shape: SHAPE.triDown, color: [255, 0, 0, 255], outline: 0.15 });
    if (settings.bool('layerState.NEXRADHAILIconsOn')) for (const h of this.overlays.hail) {
      if (h.poh <= 0 && h.posh <= 0) continue;
      const col: [number, number, number, number] = h.posh >= 50 ? [255, 0, 255, 255] : h.posh >= 10 ? [255, 60, 60, 255] : [0, 230, 120, 255];
      pts.push({ ...pos(L(h.x, h.y)), size: 10 + Math.min(10, h.posh / 8), shape: SHAPE.triUp, color: col, outline: 0.12 });
    }
    this.mesoPts = [];
    if (settings.bool('layerState.NEXRADMESOIconsOn')) for (const m of this.overlays.meso) { this.mesoPts.push(pts.length); pts.push({ ...pos(L(m.x, m.y)), size: 20, shape: SHAPE.ring, color: [255, 255, 0, 255] }); }
    if (settings.bool('layerState.NEXRADMeltingLayerOn')) {
      const smooth = settings.bool('settings.nexradMeltingLayerInterpolate');
      this.overlays.ml.forEach((c: any, i: number) => {
        const km: number[] = c.points.flatMap((p: { x: number; y: number }) => [p.x, p.y]);
        const pts = smooth ? chaikin(km, 2) : km, ll: number[] = [];
        for (let k = 0; k + 1 < pts.length; k += 2) ll.push(...L(pts[k], pts[k + 1]));
        lines.push({ coords: ll, style: 2 + (c.level === null ? i % 4 : Math.abs(c.level) % 4) });
      });
    }
    if (this.overlayNote) labels.push({ lon: lon0, lat: lat0, text: this.overlayNote, size: 11, color: [255, 220, 120, 255], halo: [0, 0, 0, 220], dy: -14, priority: 5 });
    // Borders draw first (underneath) for the cell track lines (styles 0/1).
    this.overlayLines.setLines(border ? [...lines.filter((l) => l.style <= 1).map((l) => ({ ...l, style: 6 })), ...lines] : lines);
    this.overlayPts.setPoints(pts);
    this.overlayText.setLabels(labels);
    this.overlayFill.setStyles(fillStyles); this.overlayFill.setPolys(fills);
    function pos([lon, lat]: [number, number]) { return { lon, lat }; }
  }

  /** Indices of MESO icons in the overlay point set (pulsed in tick when "Pulsate MESO icons" is on). */
  private mesoPts: number[] = [];

  /**
   * SCIT storm tracks (tracksPopup): past track; projected path for the extrapolation time (STI motion, or
   * the STI forecast positions when the motion is missing) with a filled swath (inner fill alpha, wider outer band
   * at the outer alpha, optional flash to the flash-low alpha), interval lines and time points (optionally raised
   * "3D"), track and cell-point colours from the reflectivity palette at the cell's max dBZ when enabled.
   */
  private buildTracks(L: (x: number, y: number) => [number, number], lines: Polyline[], pts: PointSpec[], labels: Label[], fills: PolyFill[], fillStyles: FillStyle[], tc: number[]) {
    const pal = getPalette(settings.str(l3PaletteKey(L3[0])));
    const byPal = (dbz: number) => evalPalette(pal.frames[0], dbz);
    const fillOnly = settings.bool('settings.nexradTracksFillOnly');
    const minutes = Math.max(0, settings.num('settings.nexradTracksExtrapolateMinutes')), step = Math.max(1, settings.num('settings.nexradTracksExtrapolateInterval'));
    const aIn = settings.num('settings.nexradTracksFillAlpha'), aOut = settings.num('settings.nexradTracksFillAlphaOuter'), aFlash = settings.num('settings.nexradTracksFillFlashAlpha');
    const flash = settings.bool('settings.nexradTracksFillFlash') ? (settings.num('settings.nexradTracksFillFlashTime') * 2) / 1000 : 0;
    const raised = settings.bool('settings.nexradTracksTimePoints3D') ? (settings.num('settings.nexradTracksTimePoints3DHeight') * 50) / 6371000 : 0;
    const t0 = this.overlayTime || timeline.t;
    for (const c of this.overlays.cells) {
      const sc = this.scit.find((s) => s.id === c.id);
      if (sc && !this.cellPasses(sc)) continue;
      const dbz = sc?.maxDbz;
      const col = settings.bool('settings.nexradTracksColorByReflectivityPalette') && dbz === dbz && dbz !== undefined ? byPal(dbz) : [tc[0], tc[1], tc[2], 255];
      if (c.past?.length && !fillOnly) lines.push({ coords: [c, ...c.past].flatMap((p: { x: number; y: number }) => L(p.x, p.y)), style: 0 });
      // Projected path in km relative to the radar, one point per interval.
      const path: [number, number, number][] = [[c.x, c.y, 0]];
      if (sc && sc.dir === sc.dir && sc.speed === sc.speed && sc.speed > 0) {
        const toward = ((sc.dir + 180) * Math.PI) / 180, kmMin = (sc.speed * 1.852) / 60;
        const n = settings.bool('settings.nexradTracksInterpolate') ? Math.ceil(minutes / step) : Math.floor(minutes / step);
        for (let k = 1; k <= n; k++) { const m = Math.min(minutes, k * step); path.push([c.x + Math.sin(toward) * kmMin * m, c.y + Math.cos(toward) * kmMin * m, m]); }
      } else if (c.forecast?.length) c.forecast.forEach((p: { x: number; y: number }, i: number) => path.push([p.x, p.y, (i + 1) * 15]));
      if (path.length > 1) {
        if (!fillOnly) lines.push({ coords: path.flatMap((p) => L(p[0], p[1])), style: 1 });
        // Swath half-width grows from 2 km at the cell to 8 km at the end of the path (position uncertainty).
        const half = (m: number) => 2 + (6 * m) / Math.max(1, path[path.length - 1][2]);
        const band = (scale: number, alpha: number) => {
          const st = fillStyles.length;
          fillStyles.push({ color: [col[0], col[1], col[2], alpha], color2: flash ? [col[0], col[1], col[2], Math.min(alpha, aFlash)] : undefined, interval: flash });
          const tris: number[] = [];
          for (let i = 0; i + 1 < path.length; i++) {
            const [ax, ay, am] = path[i], [bx, by, bm] = path[i + 1];
            const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
            const ha = half(am) * scale, hb = half(bm) * scale;
            const p1 = L(ax + nx * ha, ay + ny * ha), p2 = L(ax - nx * ha, ay - ny * ha), p3 = L(bx - nx * hb, by - ny * hb), p4 = L(bx + nx * hb, by + ny * hb);
            tris.push(...p1, ...p2, ...p3, ...p1, ...p3, ...p4);
          }
          fills.push({ tris, style: st, height: 0.000003 });
        };
        if (aOut > 0) band(1.6, aOut);
        if (aIn > 0) band(1, aIn);
        for (const [x, y, m] of path.slice(1)) {
          if (settings.bool('settings.nexradTracksShowIntervalLines')) {
            const prev = path[path.indexOf(path.find((p) => p[2] === m)!) - 1];
            const dx = x - prev[0], dy = y - prev[1], len = Math.hypot(dx, dy) || 1, h = half(m);
            lines.push({ coords: [...L(x - (dy / len) * h, y + (dx / len) * h), ...L(x + (dy / len) * h, y - (dx / len) * h)], style: 0 });
          }
          if (settings.bool('settings.nexradTracksShowTimePoints')) {
            pts.push({ ...posOf(L(x, y)), size: 5, shape: SHAPE.plus, color: [col[0], col[1], col[2], 230] });
            labels.push({ ...posOf(L(x, y)), text: new Date(t0 + m * 60e3).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), size: 10, color: [255, 255, 255, 230], halo: [0, 0, 0, 220], dy: raised ? 0 : -9, height: raised || undefined, priority: 1 });
          }
        }
      }
      if (settings.bool('settings.nexradTracksShowCellPts') && (!this.trackingMode() || settings.bool('settings.nexradTracksShowCellPtsTrackingMode'))) {
        const cp = settings.bool('settings.nexradTracksCellPtColorByReflectivityPalette') && dbz === dbz && dbz !== undefined ? byPal(dbz) : settings.arr<number>('settings.nexradTracksCellPtColor');
        pts.push({ ...posOf(L(c.x, c.y)), size: 8, shape: SHAPE.circle, color: [cp[0], cp[1], cp[2], cp[3] ?? 220], outline: 0.2 });
        labels.push({ ...posOf(L(c.x, c.y)), text: c.id, size: 10, color: [255, 255, 255, 230], halo: [0, 0, 0, 220], dx: 8, align: 'left', priority: 2 });
      }
    }
    function posOf([lon, lat]: [number, number]) { return { lon, lat }; }
  }
  /** Storm Cell Tracking Mode flag, set by the app (cell points can be hidden in that mode). */
  trackingMode: () => boolean = () => false;

  // ------------------------------------------------------------------------------------------- display
  private lut(name: string, low: number, high: number, reserve: boolean, top = 255): Lut {
    const key = `${name}|${low}|${high}|${reserve}|${top}`;
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low, high, reserve, showRF: reserve, topCode: top }); this.luts.set(key, l); }
    return l;
  }

  displayRange(pane = 0): { low: number; high: number; unit: string; reserve: boolean; palette: string; top: number } {
    if (this.isL2(pane)) {
      const i = this.product(pane), p = L2[i];
      const sixteen = (i === 4) || (i === 3 && this.shownL2(pane).some((f) => slot(f, pane)!.sweep!.tex.format !== 'r8unorm'));
      return { low: p.low, high: p.high, unit: p.unit, reserve: p.reserve, palette: settings.str(L2_PALETTE_KEYS[i]), top: sixteen ? 65535 : 255 };
    }
    const e = this.l3Entry(pane), r = l3Range(e);
    return { low: r.low, high: r.high, unit: e.unit, reserve: true, palette: e.category === 'Hydrometeor Classification' ? 'HCAClasses' : settings.str(l3PaletteKey(e)), top: 255 };
  }

  /** The legends of what `pane` draws; the max-value trail is drawn in pane 0 only. */
  legends(pane = 0): LegendSpec[] {
    const trail = pane === 0 ? this.trail.legend() : null, own = this.productLegends(pane);
    return trail && own.length ? [...own, trail] : own;
  }
  private productLegends(pane: number): LegendSpec[] {
    if (!this.enabled() || !settings.bool('settings.nexradMapLegend')) return [];
    const d = this.displayRange(pane), v = this.paneDraw(pane), l2 = this.isL2(pane);
    const drawn = l2 && v.lastDrawn ? slot(v.lastDrawn, pane)?.sweep : undefined;
    const rolled = drawn?.rolling?.prevTilts ? drawn : null;
    const r = rolled?.rolling;
    const rolling = rolled && r && `Rolling volume: ${r.prevTilts} of ${r.liveTilts + r.prevTilts} tilts from the previous volume · data ${utcHm(rolled.startMs)}–${utcHm(rolled.endMs)}Z`;
    const column = l2 ? columnNote(this.product(pane), () => this.buildParams(v.lastDrawn?.t, pane)) : undefined;
    const note = this.typed(pane) && v.ptypeShown ? ptypeLabel(v.ptypeShown) : [rolling, column].filter(Boolean).join(' · ') || undefined;
    if (this.typed(pane) && v.ptypeShown?.status === 'ready') {
      const L = (k: string) => ({ palette: getPalette(settings.str(k)), lut: this.lut(settings.str(k), d.low, d.high, d.reserve, d.top) });
      const extra: NonNullable<LegendSpec['extra']> = [];
      const k = this.ptypeKeys(l2);
      if (!settings.bool('settings.generalPrecipTypingHideSnowLegend')) extra.push({ label: 'Snow', ...L(k.snow) });
      if (!settings.bool('settings.generalPrecipTypingHideFRLegend')) extra.push({ label: 'FrzRain', ...L(k.fr) });
      if (!settings.bool('settings.generalPrecipTypingHideSleetLegend') && settings.bool('settings.generalPrecipTypingSleetEnabled')) extra.push({ label: 'Sleet', ...L(k.ip) });
      return [{ id: 'nexrad', ...L(k.rain), low: d.low, high: d.high, unit: d.unit, reserve: d.reserve, extra, note }];
    }
    return [{ id: 'nexrad', palette: getPalette(d.palette), low: d.low, high: d.high, unit: d.unit, reserve: d.reserve, lut: this.lut(d.palette, d.low, d.high, d.reserve, d.top), note }];
  }

  probeKind() { return this.enabled() && this.paneList().some((p) => (this.isL2(p) ? this.shownL2(p) : this.shownL3(p)).length) ? 'nexrad' : null; }

  /** Probe text per: value = low + (high − low)·f; velocity mph conversion and direction text. */
  probeText(f: number, pane = 0): string {
    const d = this.displayRange(pane), l2 = this.isL2(pane);
    const isVel = l2 ? [1, 6, 7].includes(this.product(pane)) : this.l3Entry(pane).category === 'Velocity';
    if (isVel && Math.abs(f * 65535 - 256) <= 2) return 'RF';
    let v = d.low + (d.high - d.low) * f;
    let unit = d.unit;
    if (isVel) {
      if (settings.bool('config.generalRadarVelocityMPHForce')) {
        if (unit === 'kts') v *= 1.15078; else if (unit === 'm/s') v *= 2.23694;
        unit = 'mph';
      }
      const fmt = fmtProbe(Math.abs(v));
      if (settings.bool('config.generalRadarVelocityDirectionText')) return `${fmt} ${unit} ${v >= 0 ? 'Outgoing' : 'Incoming'}`;
      return `${fmtProbe(v)} ${unit}`;
    }
    if (!l2 && this.l3Entry(pane).category === 'Hydrometeor Classification') return hcaName(Math.round(v / 10) * 10);
    const bound = v <= d.low + 1e-6 ? '≤' : v >= d.high - 1e-6 ? '≥' : '';
    return `${bound}${fmtProbe(v)} ${unit}`;
  }

  /**
   * The frames a pane draws at its time (the timeline time less the pane's offset): bracket() over its loop. A pane
   * with a time offset draws nothing before its first frame; at the timeline time the first frame is held, as bracket does.
   */
  private bracketOf<T extends { t: number }>(frames: T[], pane: number, blend: boolean) {
    const offset = this.view(pane).offsetMin * 60e3, t = timeline.t - offset, r = bracket(frames, t, blend, 15 * 60e3);
    return offset && r.a && r.a.t > t ? { a: null, b: null, w: 0 } : r;
  }
  private l2Sweeps(pane: number) { return this.shownL2(pane).map((f) => ({ t: f.t, f, sw: slot(f, pane)!.sweep! })); }
  private blendL2() { return settings.num('settings.nexradScanTransitionMode') >= 1; }
  private blendL3() { return settings.bool('layerState.RasterDataTemporalInterpolation') && settings.num('settings.nexradScanTransitionMode') >= 1; }

  /**
   * The scan a pane draws at its time: its key (display identity, scan times, blend weight) and the elevation of its
   * single tilt, null for volume and multi-tilt products (live composite, Level 2 volumetric products, Level 3
   * products without a tilt).
   */
  shownScan(pane = 0): { key: string; t: number; elevation: number | null } | null {
    if (!this.enabled()) return null;
    const blendKey = (b: { t: number } | null, w: number) => (b ? `${b.t}|${w.toFixed(2)}` : '');
    if (this.isL2(pane)) {
      const { a, b, w } = this.bracketOf(this.l2Sweeps(pane), pane, this.blendL2());
      if (!a) return null;
      return { key: `${this.l2Identity(pane)}|${a.t}|${blendKey(b, w)}`, t: a.t, elevation: this.composite(pane) || this.product(pane) >= 11 ? null : a.sw.elevation };
    }
    const { a, b, w } = this.bracketOf(this.shownL3(pane).map((f) => ({ t: f.t, f })), pane, this.blendL3());
    if (!a) return null;
    return { key: `${this.l3Identity(pane)}|${a.t}|${blendKey(b, w)}`, t: a.t, elevation: a.f.tex && this.l3Entry(pane).tilt !== null ? a.f.elevation ?? null : null };
  }

  /** Caption of a pane: site, product and tilt, the time offset, and the volume time drawn or why nothing is drawn. */
  paneLabel(pane: number): string {
    const view = this.view(pane), v = this.paneDraw(pane), l2 = this.isL2(pane), p = this.product(pane);
    const name = !l2 ? this.l3Entry(pane).name : this.composite(pane) ? 'Live Composite' : `${L2[p].name}${p < 11 ? ` ${view.tilt.toFixed(1)}°` : ''}`;
    const head = `${this.currentSite()} · ${name}${view.offsetMin ? ` · −${view.offsetMin} min` : ''}`;
    if (!this.enabled()) return head;
    if (v.shownT !== null) return `${head} · ${utcHm(v.shownT)}Z`;
    const errors = l2 ? this.loopL2().map((f) => slot(f, pane)?.error) : v.l3.map((f) => f.error);
    const held = l2 ? this.shownL2(pane).length : this.shownL3(pane).length;
    return `${head} · ${held ? 'no volume at this time' : errors.find(Boolean) ?? 'loading…'}`;
  }

  tick(_t: number, now: number) {
    if (this.mesoPts.length && settings.bool('settings.nexradTracksPulsateMESO')) {
      const a = 0.55 + 0.45 * Math.sin(now / 160);
      for (const i of this.mesoPts) this.overlayPts.setAlpha(i, a);
      this.overlayPts.flushAlpha();
    }
    if (this.liveScan && this.enabled()) {
      const lf = this.l2.find((f) => f.file.live);
      if (lf?.sweep) this.gauge = Math.round(lf.sweep.progress * 360);
    }
    void now;
  }

  /** Reflectivity precipitation typing: HRRR p-type selects the rain/snow/freezing-rain/sleet palette. */
  typed(pane = 0): boolean {
    if (!settings.bool('settings.nexradPrecipitationTyping')) return false;
    return this.isL2(pane) ? this.product(pane) === 0 : this.l3Entry(pane).category === 'Reflectivity';
  }
  /** P-type palettes: Level 2 has its own set (nexradL2PrecipTyping*), Level 3 uses the general p-typing set. */
  ptypeKeys(level2 = this.isL2()) {
    return level2
      ? { rain: 'settings.nexradL2PrecipTypingRainPalette', snow: 'settings.nexradL2PrecipTypingSnowPalette', fr: 'settings.nexradL2PrecipTypingFRPalette', ip: 'settings.nexradL2PrecipTypingSleetPalette' }
      : { rain: 'settings.generalPrecipTypingRainPalette', snow: 'settings.generalPrecipTypingSnowPalette', fr: 'settings.generalPrecipTypingFRPalette', ip: 'settings.generalPrecipTypingSleetPalette' };
  }
  private readonly onPtype = () => { this.views.forEach((v) => { v.radar.invalidate(); v.oldSweep.invalidate(); }); this.publishPtype(); };
  /** Appends the p-type state to the layer status (shown even when the legend is hidden). */
  private withPtype(text: string) { const note = this.typed() && this.ptypeShown ? ptypeLabel(this.ptypeShown) : ''; const base = text.replace(/ · P-type.*$/, ''); return note ? `${base} · ${note}` : base; }
  private publishPtype() { this.setStatus(this.status.state, this.withPtype(this.status.text), { frames: this.status.frames, newestMs: this.status.newestMs }); }
  /** P-type state of the scan pane 0 drew last (status line). */
  get ptypeShown() { return this.views[0].ptypeShown; }
  set ptypeShown(st: PtypeState<PtypeTex> | null) { this.views[0].ptypeShown = st; }
  /** P-type for a pane's reflectivity scanned at `t` (ms): HRRR valid at that time, or null (ordinary reflectivity). */
  private ptypeParams(d: { low: number; high: number; reserve: boolean; top: number }, t: number, shown = true, pane = 0) {
    const v = this.paneDraw(pane);
    if (!this.typed(pane)) { if (shown) v.ptypeShown = null; return null; }
    const st = ptypeAt(this.r, t, this.onPtype);
    if (shown && (st.status !== v.ptypeShown?.status || st.validMs !== v.ptypeShown?.validMs)) { v.ptypeShown = st; if (pane === 0) this.publishPtype(); }
    if (st.status !== 'ready') return null;
    const lut = (k: string) => this.lut(settings.str(k), d.low, d.high, d.reserve, d.top);
    const k = this.ptypeKeys(this.isL2(pane));
    return { tex: st.value.tex, proj: st.value.proj, snow: lut(k.snow), fr: lut(k.fr), ip: lut(k.ip),
      gradient: settings.num('settings.generalPrecipTypingRainSnowLineGradientWidth'), prob: settings.bool('settings.generalPrecipTypingProbabilityRendering'), sleet: settings.bool('settings.generalPrecipTypingSleetEnabled') };
  }

  draw(ctx: DrawContext) {
    const pane = ctx.pane || 0, v = this.paneDraw(pane), main = pane === 0;
    const info = this.siteInfo();
    let radarT: number | null = null, radarScan: number | undefined; // the drawn frame (the later one past a blend's midpoint)
    if (this.enabled() && info) {
      const site = { lon: info.lon, lat: info.lat, heightKm: (info.elevFt * 0.3048) / 1000 };
      const d = this.displayRange(pane);
      const plain = this.lut(d.palette, d.low, d.high, d.reserve, d.top);
      // Typed scans use the rain palette; a scan without matching HRRR data keeps the ordinary palette.
      const lutFor = (pt: unknown) => (pt ? this.lut(settings.str(this.ptypeKeys(this.isL2(pane)).rain), d.low, d.high, d.reserve, d.top) : plain);
      const alpha = settings.num('settings.nexradDataAlpha') / 255;
      const smoothing = settings.bool('settings.nexradSmoothing');
      const tilt3D = settings.bool('settings.nexrad3DTilt');
      const exag = settings.num('settings.nexrad3DTiltExaggeration');
      if (this.isL2(pane)) {
        const shown = this.l2Sweeps(pane);
        const { a, b, w } = this.bracketOf(shown, pane, this.blendL2());
        if (a) {
          const sw = a.sw;
          radarT = (b && w >= 0.5 ? b : a).f.t;
          const scanMs = (x: { f: L2Frame; sw: L2Sweep }) => x.sw.startMs || x.f.t;
          const pt = this.ptypeParams(d, b && w >= 0.5 ? scanMs(b) : scanMs(a), true, pane);
          const lut = lutFor(pt);
          if (a.f !== v.lastDrawn) { v.lastDrawn = a.f; if (main) perfMark('l2 frame'); }
          const live = a.f.file.live && !sw.complete;
          let wipe = -1;
          const dur = settings.num('settings.nexradUpdateSweepEffectDuration') * 1000;
          if (settings.bool('settings.nexradUpdateBeam') && this.wipeStart && performance.now() - this.wipeStart < dur) wipe = (performance.now() - this.wipeStart) / dur;
          void this.wipeFromKey;
          // Shadowed 3D tilts: a ground shadow of reflectivity, offset in azimuth.
          if (!ctx.probe && tilt3D && settings.bool('settings.nexrad3DTiltShadow') && this.product(pane) === 0 && sw.elevation > 0.1) {
            v.shadow.draw(ctx, { site, elevation: sw.elevation, a: sw, b: null, w: 0, wipe: -1, progress: 1, alpha: 1, smoothing, tilt3D: false, exaggeration: 0, shadow: true, azOffset: settings.num('settings.nexradShadowAzmOffsetDegrees'), lut: this.lut('RadarShadow', -31, 225, false) });
          }
          if (live && !ctx.probe && this.liveOld.display) {
            // Old sweep below the partially received new one, at the flash alpha range.
            const prev = shown.filter((x) => !x.f.file.live).pop();
            if (prev) {
              const ppt = this.ptypeParams(d, scanMs(prev), false, pane);
              const lo = settings.num('settings.nexradFadeOlderSweepLowerAlpha'), hi = settings.num('settings.nexradFadeOlderSweepUpperAlpha');
              const k = this.liveOld.flash ? 0.5 + 0.5 * Math.sin(performance.now() / 300) : 1;
              v.oldSweep.draw(ctx, { site, elevation: prev.sw.elevation, a: prev.sw, b: null, w: 0, wipe: -1, progress: 1, alpha: alpha * (lo + (hi - lo) * k), smoothing, tilt3D, exaggeration: exag, shadow: false, azOffset: 0, lut: lutFor(ppt), ptype: ppt });
            }
          }
          const flash = this.composite(pane) && settings.bool('settings.nexradLevel2LiveCompositeUpdateEffect') && a.f === this.l2[this.l2.length - 1] && !ctx.probe
            ? updateFlash(performance.now() - this.flashStart, settings.num('settings.nexradLevel2LiveCompositeUpdateEffectFlashRepetitions'), settings.num('settings.nexradLevel2LiveCompositeUpdateEffectSpeedMultiplier'),
              settings.num('settings.nexradLevel2LiveCompositeUpdateEffectHighAlpha'), settings.num('settings.nexradLevel2LiveCompositeUpdateEffectLowAlpha')) : 0;
          const trailDeg = settings.bool('settings.nexradUpdateBeamFadeTrail') && (wipe >= 0 || live) && !ctx.probe ? settings.num('settings.nexradUpdateBeamFadeTrailWidthDegrees') : 0;
          v.radar.draw(ctx, { site, elevation: sw.elevation, a: sw, b: b?.sw ?? null, w: b ? w : 0, wipe, progress: live ? sw.progress : 1, alpha, smoothing, tilt3D, exaggeration: exag, shadow: false, azOffset: 0, lut, ptype: pt, flash, trailDeg });
          // The data age and the 3D view belong to pane 0's volume.
          if (main) { this.updateDataAge(live ? sw : null, info); this.view3d.draw(ctx, a.f.file.url, site); }
        }
      } else {
        const frames = this.shownL3(pane).map((f) => ({ t: f.t, f }));
        const { a, b, w } = this.bracketOf(frames, pane, this.blendL3());
        const pt = a?.f.tex ? this.ptypeParams(d, b && w >= 0.5 ? b.f.t : a.f.t, true, pane) : null;
        const lut = lutFor(pt);
        if (a?.f.tex) {
          const bt = b?.f.tex && b.f.tex.gates === a.f.tex.gates ? b.f.tex : null;
          const shown = (bt && w >= 0.5 ? b! : a).f;
          radarT = shown.t; radarScan = shown.volumeScan;
          v.radar.draw(ctx, { site, elevation: a.f.elevation ?? 0.5, a: a.f.tex, b: bt, w: bt ? w : 0, wipe: -1, progress: 1, alpha, smoothing, tilt3D, exaggeration: exag, shadow: false, azOffset: 0, lut, ptype: pt });
        } else if (a?.f.raster) {
          const ra = a.f.raster;
          radarT = a.f.t; radarScan = a.f.volumeScan;
          v.l3raster.draw(ctx, { mode: 0, w: 0, alpha, smoothing, bounds: ra.bounds, proj: latLonProj(ra.bounds[2], ra.bounds[1], ra.bounds[0], ra.bounds[3], ra.nx, ra.ny), luts: [plain], data: [[ra.tex, ra.tex]] }, 4);
        }
      }
    }
    if (!ctx.probe) v.shownT = radarT;
    // The max-value trail is of pane 0's product and tilt, so it is drawn there only.
    if (main && info && this.enabled()) this.trail.draw(ctx, info);
    // Live beam (settings.nexradLiveBeam): a line from the radar along the newest radial of an incomplete live sweep.
    if (main && !ctx.probe && info && this.enabled() && this.isL2() && this.liveAz !== null && settings.bool('settings.nexradLiveBeam')) {
      this.beam ??= new LineSet(this.r);
      const key = `${info.id}|${this.liveAz.toFixed(1)}`;
      if (key !== this.beamKey) {
        this.beamKey = key;
        this.beam.setStyles([{ color: [255, 255, 255, 210], width: 1.6 }]);
        const range = 460, pts: number[] = [];
        for (let k = 0; k <= 8; k++) pts.push(...destination(info.lon, info.lat, this.liveAz, (range * k) / 8));
        this.beam.setLines([{ coords: pts, style: 0, height: 0.00003 }]);
      }
      this.beam.draw(ctx);
    }
    if (!ctx.probe && main) this.syncOverlays(radarT, radarScan);
    // Storm attributes are matched to pane 0's volume: another pane shows them only while it draws that volume.
    if (!ctx.probe && (main || sameVolume(radarT, this.views[0].shownT))) { this.overlayFill.draw(ctx); this.overlayLines.draw(ctx); this.overlayPts.draw(ctx); this.overlayText.draw(ctx); }
    if (!ctx.probe && info) this.tools.draw(ctx, info);
    this.section.draw(ctx);
    if (main && !ctx.probe && this.dataAge && settings.bool('settings.nexradLiveScanDataAgeIndicator') && !settings.bool('settings.nexradLiveScanDataAgeIndicatorLegacy')) this.ageText.draw(ctx);
  }

  /**
   * Live-scan data age: seconds since the newest received radial of the live sweep. The indicator is a map
   * label beside the radar; the legacy indicator is the same value in the NEXRAD status line.
   */
  private ageKey = '';
  private updateDataAge(sw: (SweepTex & { endMs: number }) | null, info: { id: string; lon: number; lat: number }) {
    if (!sw || !settings.bool('settings.nexradLiveScanDataAgeIndicator')) { this.dataAge = null; return; }
    const sec = Math.max(0, Math.round((Date.now() - sw.endMs) / 1000));
    this.dataAge = `Data age ${sec} s`;
    const key = `${info.id}|${sec}`;
    if (key === this.ageKey) return;
    this.ageKey = key;
    const col: [number, number, number, number] = sec < 60 ? [120, 255, 140, 255] : sec < 180 ? [255, 220, 90, 255] : [255, 110, 90, 255];
    this.ageText.setLabels([{ lon: info.lon, lat: info.lat, text: `LIVE ${this.dataAge}`, size: 11, color: col, halo: [0, 0, 0, 220], dy: 14, priority: 5 }]);
    if (settings.bool('settings.nexradLiveScanDataAgeIndicatorLegacy')) { this.liveSweepText = `${this.liveSweepText.split(' · ')[0]} · ${sec}s`; }
  }
}

/** Live-composite update flash (0..1): `reps` raised-cosine pulses between the low and high alpha; 0 when done. */
export function updateFlash(elapsedMs: number, reps: number, speed: number, high: number, low: number): number {
  const period = 700 / Math.max(0.05, speed);
  if (elapsedMs < 0 || elapsedMs >= Math.max(0, reps) * period) return 0;
  const k = 0.5 - 0.5 * Math.cos((2 * Math.PI * (elapsedMs % period)) / period);
  return Math.max(0, low + (high - low) * k);
}

/** Chaikin corner cutting (melting-layer interpolation): smooth curves through [x, y, …]; closed rings stay closed. */
export function chaikin(coords: number[], iterations: number): number[] {
  let p = coords;
  for (let it = 0; it < iterations && p.length >= 6; it++) {
    const closed = p[0] === p[p.length - 2] && p[1] === p[p.length - 1];
    const out: number[] = closed ? [] : [p[0], p[1]];
    for (let i = 0; i + 3 < p.length; i += 2) {
      const [x0, y0, x1, y1] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
      out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
    }
    if (closed) out.push(out[0], out[1]); else out.push(p[p.length - 2], p[p.length - 1]);
    p = out;
  }
  return p;
}

export function fmtProbe(v: number): string {
  const fmt = settings.str('config.generalProbeRoundingFormat');
  const dec = (fmt.split('.')[1] ?? '').length;
  return v.toFixed(dec);
}

export function hcaName(code: number): string {
  return ({ 10: 'Biological', 20: 'Ground clutter / AP', 30: 'Ice crystals', 40: 'Dry snow', 50: 'Wet snow', 60: 'Light/moderate rain', 70: 'Heavy rain', 80: 'Big drops', 90: 'Graupel', 100: 'Hail/rain', 110: 'Large hail', 120: 'Giant hail', 140: 'Unknown', 150: 'Range folded' } as Record<number, string>)[code] ?? '—';
}
