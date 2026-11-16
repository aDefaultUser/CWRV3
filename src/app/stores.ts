// Browser-persisted user collections: viewpoints, layer and scene presets, layer order, map styles, annotations,
// sequences, label database edits and RGB recipes (localStorage via ./persist).
import { settings } from '../settings/store';
import type { View } from '../render/camera';
import type { Recipe } from '../render/recipes';
import { loadPref, savePref, isArray, isRecord } from './persist';

const load = <T,>(key: string, dflt: T): T => loadPref(key, dflt, Array.isArray(dflt) ? isArray : isRecord);
const save = (key: string, v: unknown): boolean => savePref(key, v);

export interface Viewpoint { name: string; view: View }
export const viewpoints = {
  list: load<Viewpoint[]>('viewpoints', []),
  add(name: string, view: View) { this.list.push({ name, view: { ...view } }); return save('viewpoints', this.list); },
  remove(i: number) { this.list.splice(i, 1); return save('viewpoints', this.list); },
  replace(list: Viewpoint[]) { this.list = list; return save('viewpoints', list); },
};

export interface LayerPreset { name: string; values: Record<string, unknown> }
export const layerPresets = {
  list: load<LayerPreset[]>('layerPresets', []),
  add(name: string) { this.list.push({ name, values: settings.layerState() }); return save('layerPresets', this.list); },
  remove(i: number) { this.list.splice(i, 1); return save('layerPresets', this.list); },
  apply(i: number) { const p = this.list[i]; if (p) settings.applyLayerState(p.values); },
};

export interface ScenePreset { name: string; view?: View; layers?: Record<string, unknown>; timeline?: { t: number; playing: boolean }; overlay?: { active: boolean; path: string; pt: number[] } }
/** Save/Reproduce mask: config.presetsSaveReproduce is listed in as eight booleans (index 2k = save, 2k+1 = reproduce). */
export const sceneMask = { list: load<boolean[]>('sceneMask', [true, true, true, true, false, true, false, true]) };
export function setSceneMask(i: number, v: boolean) { sceneMask.list[i] = v; return save('sceneMask', sceneMask.list); }
export const scenePresets = {
  list: load<ScenePreset[]>('scenePresets', []),
  add(p: ScenePreset) { this.list.push(p); return save('scenePresets', this.list); },
  remove(i: number) { this.list.splice(i, 1); return save('scenePresets', this.list); },
};

export const DEFAULT_ORDER = ['basemap', 'customBackground', 'surfaceFill', 'satellite', 'satelliteExtended', 'goesManual', 'modelFill', 'ndfd', 'winter', 'miscDiff', 'meso', 'mrms', 'nationalRadar', 'nexrad', 'customRadar', 'modelFill2', 'severeParam', 'drought', 'cpc', 'wpc', 'spcOutlook', 'fireOutlook', 'surface', 'modelContours', 'modelVectors', 'gis', 'userShapes', 'roads', 'advisories', 'warnings', 'mesoDiscussions', 'tropical', 'rivers', 'fires', 'quakes', 'lsr', 'metar', 'marine', 'lightning', 'placefiles', 'radarSites', 'cities', 'annotations'];
export const layerOrder = {
  list: (() => { const l = load<string[]>('layerOrder', DEFAULT_ORDER); return [...l.filter((x) => DEFAULT_ORDER.includes(x)), ...DEFAULT_ORDER.filter((x) => !l.includes(x))]; })(),
  set(l: string[]) { this.list = l; return save('layerOrder', l); },
};

export interface Marker { lon: number; lat: number; label: string }
export const markers = {
  get list(): Marker[] { try { return JSON.parse(settings.str('config.pointMarkers') || '[]'); } catch { return []; } },
  add(m: Marker) { settings.set('config.pointMarkers', JSON.stringify([...this.list, m])); },
  clear() { settings.set('config.pointMarkers', ''); },
};

/** Map style = snapshot of background/terrain/lighting/GIS appearance settings (content inferred). */
export interface MapStyle { name: string; values: Record<string, unknown> }
const STYLE_PREFIXES = ['config.bg', 'config.terrain', 'config.latlon', 'config.geo', 'config.citylabel', 'config.mbgColor', 'config.starField', 'config.performanceMode', 'settings.atmosphere'];
export const mapStyles = {
  list: load<MapStyle[]>('mapStyles', []),
  saveCurrent(name: string) {
    const values = settings.exportDocument((d) => STYLE_PREFIXES.some((p) => d.id.startsWith(p))).values;
    this.list.push({ name, values });
    return save('mapStyles', this.list);
  },
  apply(i: number) { const s = this.list[i]; if (s) for (const [k, v] of Object.entries(s.values)) settings.set(k, v); },
};

/** Text annotations placed on the map (Text annotations… dialog), drawn with the "Annotations" text style. */
export interface TextAnnotation { text: string; lon: number; lat: number }
export const textAnnotations = {
  list: load<TextAnnotation[]>('textAnnotations', []),
  add(a: TextAnnotation) { this.list.push(a); return save('textAnnotations', this.list); },
  remove(i: number) { this.list.splice(i, 1); return save('textAnnotations', this.list); },
};

/** Sequencer actions (TFrmSequencer): a camera viewpoint and/or a layer state, played back in order. */
export interface SequenceAction { name: string; view?: View; layers?: Record<string, unknown> }
export const sequence = {
  list: load<SequenceAction[]>('sequence', []),
  add(a: SequenceAction) { this.list.push(a); return save('sequence', this.list); },
  remove(i: number) { this.list.splice(i, 1); return save('sequence', this.list); },
};

/**
 * City label database edits (TFrmLabelDBEdit) over the built-in Natural Earth list: rename, delete, "fixed"
 * (always shown), zoom class 1 (shown from low zoom) or 2 (only at high zoom), and user-added labels.
 */
export interface LabelEdit { n?: string; deleted?: boolean; fixed?: boolean; zoom?: 0 | 1 | 2 }
export interface LabelAdd { n: string; lon: number; lat: number; fixed?: boolean; zoom?: 0 | 1 | 2 }
export interface LabelDb { edits: Record<string, LabelEdit>; added: LabelAdd[] }
export const labelKey = (c: { n: string; lon: number; lat: number }) => `${c.n}@${c.lon.toFixed(3)},${c.lat.toFixed(3)}`;
export const labelDb = {
  value: load<LabelDb>('labelDb', { edits: {}, added: [] }),
  set(v: LabelDb) { this.value = v; return save('labelDb', v); },
};

/** User multispectral RGB recipes (TFrmGOESMultispectralRGB); multi-index 0/1 are the built-ins, 2+ these. */
export const rgbRecipes = {
  list: load<Recipe[]>('rgbRecipes', []),
  save() { return save('rgbRecipes', this.list); },
};
