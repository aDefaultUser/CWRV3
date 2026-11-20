// Forecast tab (WPC QPF, Excessive Rainfall, WPC winter probabilities, CPC outlooks) and the vector
// products of the Misc tab (29: earthquakes, fire detections, SPC fire weather outlooks, river gauges, drought).
import type { Renderer } from '../render/renderer';
import { SHAPE, type GlyphAtlas, type Color } from '../render/prims';
import { ShapeLayer } from './shapes';
import { VectorLayer } from '../layers/vector';
import { settings } from '../settings/store';
import { XPRODUCTS } from '../generated/products-expanded';
import { registerStyleResolver, type MapObjectStyle } from '../app/styles';
import { getPalette } from '../palettes/library';
import { evalPalette } from '../render/palette';
import { fetchText } from '../data/net';
import { Lut } from '../render/raster';
import type { LegendSpec } from '../layers/base';

const fillFromPalette = (palette: string, v: number, alpha = 1): MapObjectStyle => {
  const c = evalPalette(getPalette(palette).frames[0], v);
  return { fill: [c[0], c[1], c[2], Math.round(c[3] * alpha)], line: [c[0], c[1], c[2], 255], width: 1, pattern: 0, patternSize: 8, dash: 0, visible: true };
};
registerStyleResolver('QPF:', (v) => fillFromPalette('QPF', Number(v), 0.8));
registerStyleResolver('CPCP:', (v) => fillFromPalette('CPCPrecipOutlook', Number(v), 0.8));
registerStyleResolver('CPCT:', (v) => fillFromPalette('CPCTempOutlooks', Number(v), 0.8));
const WW_LEVEL: Record<string, [string, number]> = { Slight: ['#4080FF', 10], Moderate: ['#8040E0', 40], High: ['#E040C0', 70] };
registerStyleResolver('WW:', (k) => { const h = (WW_LEVEL[k] ?? ['#80C0FF', 5])[0]; const n = parseInt(h.slice(1), 16); const c: Color = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]; return { fill: [c[0], c[1], c[2], 110], line: c, width: 1.2, pattern: 0, patternSize: 8, dash: 0, visible: true }; });
const RIVER: Record<string, Color> = { major: [200, 60, 255, 255], moderate: [255, 0, 0, 255], minor: [255, 150, 0, 255], action: [255, 255, 0, 255], no_flooding: [0, 200, 0, 255], low_threshold: [160, 120, 60, 255], not_defined: [150, 150, 150, 255], obs_not_current: [90, 120, 170, 255], out_of_service: [80, 80, 80, 255] };

export function forecastLayers(r: Renderer, atlas: GlyphAtlas) {
  const qpf = new ShapeLayer(r, atlas, {
    id: 'wpc', title: 'WPC QPF', enabled: () => settings.bool('layerState.WPCQPFOn'),
    sources: () => [{ url: XPRODUCTS.wpcQpf[settings.num('layerState.WPCQPFIdx')]?.url ?? XPRODUCTS.wpcQpf[0].url, kind: 'tar' }],
    shape: (f) => (f.kind === 'polygon' ? { kind: 'polygon', parts: f.parts, tris: f.tris, style: `QPF:${f.attrs.QPF}`, z: Number(f.attrs.QPF), label: `${f.attrs.QPF}"`, info: [`WPC ${f.attrs.PRODUCT}`, `QPF ≥ ${f.attrs.QPF} in`, `Valid: ${f.attrs.VALID_TIME}`] } : null),
    filled: () => settings.bool('settings.wpcFilled'), labels: () => settings.bool('settings.wpcShowLabels'),
  });
  const ero = new ShapeLayer(r, atlas, {
    id: 'wpcEro', title: 'WPC excessive rainfall', enabled: () => settings.bool('layerState.WPCExcessiveRainfallOutlookOn'),
    sources: () => [{ url: XPRODUCTS.wpcEro[settings.num('layerState.WPCEROIdx')]?.url ?? XPRODUCTS.wpcEro[0].url, kind: 'zip' }],
    shape: (f) => {
      if (f.kind !== 'polygon') return null;
      const o = String(f.attrs.OUTLOOK ?? ''); const cat = /^High/i.test(o) ? 'HIGH' : /^Moderate/i.test(o) ? 'MDT' : /^Slight/i.test(o) ? 'SLGT' : 'MRGL';
      return { kind: 'polygon', parts: f.parts, tris: f.tris, style: `ERO${cat}`, z: ['MRGL', 'SLGT', 'MDT', 'HIGH'].indexOf(cat), label: cat, info: [String(f.attrs.PRODUCT ?? 'Excessive Rainfall Outlook'), o, `Valid: ${f.attrs.VALID_TIME}`] };
    },
    filled: () => settings.bool('settings.wpcFilled'), labels: () => settings.bool('settings.wpcShowLabels'),
  });
  const ww = new ShapeLayer(r, atlas, {
    id: 'wpcWinter', title: 'WPC winter probabilities', enabled: () => settings.bool('layerState.WPCWinterPrecipitationProbabilitiesOn'),
    sources: () => {
      const day = settings.num('layerState.WPCWinterProductDayIdx') + 1;
      const prod = ['PSNOW_GT_04', 'PSNOW_GT_08', 'PSNOW_GT_12', 'PICEZ_GT_25'][settings.num('layerState.WPCWinterProductIdx')];
      const e = XPRODUCTS.wpcWinter.find((x) => x.day === day && x.product === prod);
      return e ? [{ url: e.url, kind: 'tar' }] : null;
    },
    shape: (f) => {
      if (f.kind !== 'polygon') return null;
      const o = String(f.attrs.OUTLOOK ?? ''); const lv = /^High/i.test(o) ? 'High' : /^Moderate/i.test(o) ? 'Moderate' : 'Slight';
      return { kind: 'polygon', parts: f.parts, tris: f.tris, style: `WW:${lv}`, z: Object.keys(WW_LEVEL).indexOf(lv), label: o.replace(/^.*\(|\)$/g, ''), info: [String(f.attrs.PRODUCT ?? ''), o, `Valid: ${f.attrs.VALID_TIME}`] };
    },
    filled: () => settings.bool('settings.wpcFilled'), labels: () => settings.bool('settings.wpcShowLabels'),
  });
  let loaded = 'Loaded Outlook: N/A';
  const cpcLuts = new Map<string, Lut>();
  class CpcLayer extends ShapeLayer {
    get loadedText() { return loaded; }
    legends(): LegendSpec[] {
      if (!this.enabled() || !settings.bool('settings.cpcLegend') || !this.shapes.length) return [];
      const temp = settings.num('layerState.CPCIdx') % 2 === 1, name = temp ? 'CPCTempOutlooks' : 'CPCPrecipOutlook';
      let l = cpcLuts.get(name); if (!l) { l = new Lut(r, getPalette(name), { low: -90, high: 90 }); cpcLuts.set(name, l); }
      return [{ id: 'cpc', palette: getPalette(name), low: -90, high: 90, unit: '% (−Below / +Above)', lut: l }];
    }
  }
  const cpc = new CpcLayer(r, atlas, {
    id: 'cpc', title: 'CPC outlook', enabled: () => settings.bool('layerState.CPCOn'),
    sources: () => [{ url: XPRODUCTS.cpc[settings.num('layerState.CPCIdx')]?.url ?? XPRODUCTS.cpc[0].url, kind: 'zip' }],
    shape: (f) => {
      if (f.kind !== 'polygon') return null;
      const cat = String(f.attrs.Cat ?? ''), p = Number(f.attrs.Prob ?? 0);
      const v = /^Above/i.test(cat) ? p : /^Below/i.test(cat) ? -p : 0;
      const temp = settings.num('layerState.CPCIdx') % 2 === 1;
      return { kind: 'polygon', parts: f.parts, tris: f.tris, style: `${temp ? 'CPCT' : 'CPCP'}:${v}`, z: Math.abs(v), label: v ? `${p}%` : '', info: [XPRODUCTS.cpc[settings.num('layerState.CPCIdx')].label, `${cat} ${p}%`, `${f.attrs.Start_Date ?? ''} – ${f.attrs.End_Date ?? ''}`] };
    },
    filled: () => settings.bool('settings.cpcFilled'), labels: () => true,
    after: (sh) => { loaded = `Loaded Outlook: ${XPRODUCTS.cpc[settings.num('layerState.CPCIdx')].label}${sh[0]?.info?.[2] ? ` (${sh[0].info[2]})` : ''}`; },
  });
  return { qpf, ero, ww, cpc };
}

// ------------------------------------------------------------------------------------------- Misc vectors
/** USGS all-day CSV: time, latitude, longitude, depth, mag, …, place. */
export function parseQuakes(csv: string): { t: number; lat: number; lon: number; depth: number; mag: number; place: string }[] {
  const lines = csv.split('\n');
  const head = lines[0].split(',');
  const ix = (n: string) => head.indexOf(n);
  const out: ReturnType<typeof parseQuakes> = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const f = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((x) => x.replace(/,$/, '').replace(/^"|"$/g, ''));
    out.push({ t: Date.parse(f[ix('time')]), lat: Number(f[ix('latitude')]), lon: Number(f[ix('longitude')]), depth: Number(f[ix('depth')]), mag: Number(f[ix('mag')]), place: f[ix('place')] ?? '' });
  }
  return out.filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon));
}

export class QuakeLayer extends VectorLayer {
  readonly id = 'quakes';
  readonly title = 'USGS earthquakes';
  private at = 0;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r, atlas); }
  enabled() { return settings.bool('layerState.EarthquakesOn'); }
  labelsOn() { return false; }
  async refresh() {
    if (!this.enabled()) { this.setStatus('off', ''); return; }
    if (Date.now() - this.at < 5 * 60e3) return;
    try {
      const q = parseQuakes(await fetchText('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.csv'));
      this.at = Date.now();
      this.setShapes(q.map((e) => {
        const age = (Date.now() - e.t) / 3600e3;
        const color: Color = age < 1 ? [255, 40, 40, 255] : age < 6 ? [255, 150, 30, 255] : [255, 230, 80, 230];
        return { kind: 'point', parts: [[e.lon, e.lat]], style: 'Earthquake', point: { size: 6 + Math.max(0, e.mag) * 3.5, shape: SHAPE.circle, color, outline: 0.18 }, info: [`Earthquake: ${e.place}`, `Time: ${new Date(e.t).toLocaleString()}`, `Magnitude: ${e.mag}`, `Depth: ${e.depth} km`] };
      }));
      this.setStatus('ready', `${q.length} earthquakes (24 h)`);
    } catch (err) { this.setStatus('error', `USGS: ${(err as Error).message}`); }
  }
}

export function miscLayers(r: Renderer, atlas: GlyphAtlas) {
  const firmsUrl = (sat: 'modis' | 'viirs') => sat === 'modis'
    ? 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/shapes/zips/MODIS_C6_1_USA_contiguous_and_Hawaii_24h.zip'
    : 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/shapes/zips/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.zip';
  const fires = new ShapeLayer(r, atlas, {
    id: 'fires', title: 'Fire detections', enabled: () => settings.bool('layerState.FireMODISDetectionsOn') || settings.bool('layerState.FireVIIRSDetectionsOn'),
    sources: () => [...(settings.bool('layerState.FireMODISDetectionsOn') ? [{ url: firmsUrl('modis'), kind: 'zip' as const }] : []), ...(settings.bool('layerState.FireVIIRSDetectionsOn') ? [{ url: firmsUrl('viirs'), kind: 'zip' as const }] : [])],
    shape: (f) => {
      if (f.kind !== 'point') return null;
      const a = f.attrs as Record<string, string | number>;
      const viirs = a.BRIGHT_TI4 !== undefined;
      const src = viirs ? 'VIIRS I-Band' : String(a.SATELLITE) === 'A' || String(a.SATELLITE) === 'Aqua' ? 'MODIS (AQUA)' : 'MODIS (TERRA)';
      return { kind: 'point', parts: f.parts, style: 'Fire', point: { size: viirs ? 5 : 7, shape: SHAPE.square, color: [255, 80, 20, 235], outline: 0.1 },
        info: ['Fire Detection', `Time: ${a.ACQ_DATE} ${String(a.ACQ_TIME).padStart(4, '0')} UTC`, `Source: ${src}`, `Brightness: ${a.BRIGHTNESS ?? a.BRIGHT_TI4}`, `Bright_T31: ${a.BRIGHT_T31 ?? a.BRIGHT_TI5}`, `Confidence: ${a.CONFIDENCE}`] };
    },
    labels: () => false, refreshMin: 15,
  });
  const fireOutlook = new ShapeLayer(r, atlas, {
    id: 'fireOutlook', title: 'SPC fire weather outlook', enabled: () => settings.bool('layerState.NWSFireOutlooksOn'),
    sources: () => { const d = settings.num('layerState.NWSFireOutlooksDayIdx') + 1; return [{ url: d <= 2 ? `https://www.spc.noaa.gov/products/fire_wx/day${d}firewx-shp.zip` : `https://www.spc.noaa.gov/products/exper/fire_wx/day${d}firewx-shp.zip`, kind: 'zip' }]; },
    shape: (f, layer) => {
      if (f.kind !== 'polygon') return null;
      const txt = Object.values(f.attrs).map(String).join(' ').toUpperCase();
      const dry = /DRYLTG/i.test(layer);
      const style = dry ? (/SCT/.test(txt) ? 'FOScatDryT' : 'FOIsoDryT') : /EXTM|EXTREME/.test(txt) ? 'FOExtreme' : /CRIT/.test(txt) ? 'FOCritical' : 'FOElevated';
      return { kind: 'polygon', parts: f.parts, tris: f.tris, style, z: ['FOElevated', 'FOCritical', 'FOExtreme', 'FOIsoDryT', 'FOScatDryT'].indexOf(style), label: style.replace(/^FO/, ''), info: ['SPC Fire Weather Outlook', style.replace(/^FO/, ''), ...Object.entries(f.attrs).slice(0, 3).map(([k, v]) => `${k}: ${v}`)] };
    },
  });
  const rivers = new ShapeLayer(r, atlas, {
    id: 'rivers', title: 'River gauges', enabled: () => settings.bool('layerState.NWSRiverObservationsOn'),
    sources: () => { const i = settings.num('layerState.NWSRiverObservationsIdx'); return [{ url: i === 0 ? 'https://water.noaa.gov/resources/downloads/shapefiles/national_shapefile_obs.tgz' : `https://water.noaa.gov/resources/downloads/shapefiles/national_shapefile_fcst_f${String(i * 24).padStart(3, '0')}.tgz`, kind: 'tgz' }]; },
    shape: (f) => {
      if (f.kind !== 'point') return null;
      const a = f.attrs as Record<string, string | number>;
      const status = String(a.Status ?? 'not_defined');
      if (status === 'out_of_service') return null;
      const fc = settings.num('layerState.NWSRiverObservationsIdx') > 0;
      const val = fc ? a.Forecast ?? a.Observed : a.Observed;
      return { kind: 'point', parts: f.parts, style: 'River', point: { size: /major|moderate|minor/.test(status) ? 10 : 6, shape: SHAPE.circle, color: RIVER[status] ?? RIVER.not_defined, outline: 0.18 },
        info: [`${fc ? 'River Forecast for' : 'River Observation for'} ${a.GaugeLID} ${a.Location ?? ''} (${a.Waterbody ?? ''})`, `Valid time: ${a.ObsTime ?? a.FcstTime ?? ''}`, `${fc ? 'Forecast' : 'Observed'} Height: ${val} ${a.Units ?? ''}`, `Action stage: ${a.Action || '-'}`, `Flood stage: ${a.Flood || '-'}`, `Status: ${status.replace(/_/g, ' ')}`, `Flow rate: ${a.SecValue || '-'} ${a.SecUnit ?? ''}`] };
    },
    labels: () => false, refreshMin: 15,
  });
  const drought = new ShapeLayer(r, atlas, {
    id: 'drought', title: 'Drought monitor', enabled: () => settings.bool('layerState.DMOn'),
    sources: () => [{ url: 'https://droughtmonitor.unl.edu/data/shapefiles_m/USDM_current_M.zip', kind: 'zip', tol: 0.01 }],
    shape: (f) => (f.kind === 'polygon' ? { kind: 'polygon', parts: f.parts, tris: f.tris, style: `DroughtD${f.attrs.DM}`, z: Number(f.attrs.DM), label: `D${f.attrs.DM}`, info: ['U.S. Drought Monitor', `D${f.attrs.DM} ${['Abnormally Dry', 'Moderate Drought', 'Severe Drought', 'Extreme Drought', 'Exceptional Drought'][Number(f.attrs.DM)] ?? ''}`] } : null),
    filled: () => settings.bool('settings.dmFilled'), labels: () => false, refreshMin: 60,
  });
  return { fires, fireOutlook, rivers, drought, quakes: new QuakeLayer(r, atlas) };
}
