// Form catalog of the CWRV3 additions that have no original form (same structure as ui-forms.ts). Maintained by hand.
import type { FormDef } from '../ui/form-types';

const F = 'TFrmRadarAnalysis';
const c = (name: string, cls: string, parent: string, l: number, t: number, w: number, h: number, caption?: string, extra: object = {}) => ({ id: `ui.${F}.${name}`, name, cls, parent, l, t, w, h, caption, ...extra });

/** Spin increments of the per-moment threshold controls of the 3D volume view (v3Min/v3Iso1/v3Iso2 + moment). */
const V3_INC: Record<string, number> = { REF: 1, VEL: 5, ZDR: 0.25, CC: 0.01, KDP: 0.25 };
/** 3D volume view group, in a second column beside the other tools. One threshold control per moment shares each place. */
const VIEW3D = [
  c('gb3D', 'TsGroupBox', 'FrmRadarAnalysis', 482, 4, 352, 312, '3D volume view (Level 2 volume; Ctrl+drag tilts the map)'),
  c('lblV3Mode', 'TsLabel', 'gb3D', 10, 24, 36, 18, 'View:'),
  c('v3Mode', 'TsComboBox', 'gb3D', 48, 20, 104, 22, undefined, { items: ['Off', 'Volume', 'Isosurfaces'] }),
  c('lblV3Moment', 'TsLabel', 'gb3D', 162, 24, 48, 18, 'Moment:'),
  c('v3Moment', 'TsComboBox', 'gb3D', 212, 20, 130, 22, undefined, { items: ['Reflectivity', 'Velocity', 'Storm-relative vel.', 'ZDR', 'CC', 'KDP'] }),
  c('v3Scale', 'TsCheckBox', 'gb3D', 10, 51, 130, 20, 'Height scale at radar'),
  c('lblV3Quality', 'TsLabel', 'gb3D', 162, 54, 96, 18, 'Samples per ray:'),
  c('v3Quality', 'TsSpinEdit', 'gb3D', 262, 51, 80, 22, undefined, { inc: 16 }),
  c('lblV3Min', 'TsLabel', 'gb3D', 10, 85, 100, 18, 'Volume: from'),
  c('v3Unit0', 'TsLabel', 'gb3D', 178, 85, 36, 18, 'dBZ'),
  c('lblV3Opacity', 'TsLabel', 'gb3D', 220, 85, 50, 18, 'Opacity:'),
  c('v3Opacity', 'TsDecimalSpinEdit', 'gb3D', 272, 82, 70, 22, undefined, { inc: 0.1 }),
  c('v3Iso1Label', 'TsLabel', 'gb3D', 10, 117, 100, 18, 'Surface 1 from'),
  c('v3Unit1', 'TsLabel', 'gb3D', 178, 117, 36, 18, 'dBZ'),
  c('v3Iso1Color', 'TsColorSelect', 'gb3D', 220, 113, 46, 24),
  c('v3Iso1Alpha', 'TsSpinEdit', 'gb3D', 272, 114, 56, 22, undefined, { min: 0, max: 100, inc: 5 }),
  c('lblV3Pct1', 'TsLabel', 'gb3D', 331, 117, 14, 18, '%'),
  c('v3Iso2On', 'TsCheckBox', 'gb3D', 10, 147, 18, 20, ''),
  c('v3Iso2Label', 'TsLabel', 'gb3D', 30, 149, 80, 18, 'Surface 2 from'),
  c('v3Unit2', 'TsLabel', 'gb3D', 178, 149, 36, 18, 'dBZ'),
  c('v3Iso2Color', 'TsColorSelect', 'gb3D', 220, 145, 46, 24),
  c('v3Iso2Alpha', 'TsSpinEdit', 'gb3D', 272, 146, 56, 22, undefined, { min: 0, max: 100, inc: 5 }),
  c('lblV3Pct2', 'TsLabel', 'gb3D', 331, 149, 14, 18, '%'),
  ...Object.entries(V3_INC).flatMap(([m, inc]) => ['Min', 'Iso1', 'Iso2'].map((k, row) => c(`v3${k}${m}`, 'TsDecimalSpinEdit', 'gb3D', 112, 82 + row * 32, 62, 22, undefined, { inc }))),
  c('v3Status', 'TsMemo', 'gb3D', 10, 180, 332, 56),
  c('lblV3Hint1', 'TsLabel', 'gb3D', 10, 244, 332, 18, 'Vertical scale: Radar Control → Tilt exaggeration.'),
  c('lblV3Hint2', 'TsLabel', 'gb3D', 10, 264, 332, 18, 'Velocity surfaces: 1 outbound, 2 inbound (speeds).'),
];

/** Radar Analysis Tools: range rings, VR shear, the sounding tool and the 3D volume view. */
export const ANALYSIS_FORMS: readonly FormDef[] = [{
  form: F, scope: 'nexrad-pro', controls: [
    { id: `ui.${F}.FrmRadarAnalysis`, name: 'FrmRadarAnalysis', cls: F, parent: null, l: 0, t: 0, caption: 'Radar Analysis Tools' },
    c('gbRings', 'TsGroupBox', 'FrmRadarAnalysis', 6, 4, 470, 106, 'Range rings (selected NEXRAD site)'),
    c('rrOn', 'TsCheckBox', 'gbRings', 10, 20, 100, 20, 'Show rings'),
    c('rrLabels', 'TsCheckBox', 'gbRings', 118, 20, 120, 20, 'Distance labels'),
    c('rrSpokes', 'TsCheckBox', 'gbRings', 246, 20, 140, 20, 'Azimuth spokes every'),
    c('rrSpokeInterval', 'TsSpinEdit', 'gbRings', 390, 18, 50, 22, undefined, { inc: 5 }),
    c('lblDeg', 'TsLabel', 'gbRings', 444, 21, 16, 18, '°'),
    c('lblInterval', 'TsLabel', 'gbRings', 10, 50, 52, 18, 'Interval:'),
    c('rrInterval', 'TsDecimalSpinEdit', 'gbRings', 64, 47, 62, 22, undefined, { inc: 5 }),
    c('rrUnit', 'TsLabel', 'gbRings', 130, 50, 26, 18, 'mi'),
    c('lblCount', 'TsLabel', 'gbRings', 166, 50, 42, 18, 'Count:'),
    c('rrCount', 'TsSpinEdit', 'gbRings', 210, 47, 50, 22),
    c('lblWidth', 'TsLabel', 'gbRings', 272, 50, 42, 18, 'Width:'),
    c('rrWidth', 'TsDecimalSpinEdit', 'gbRings', 316, 47, 56, 22, undefined, { inc: 0.2 }),
    c('lblColor', 'TsLabel', 'gbRings', 10, 80, 52, 18, 'Colour:'),
    c('rrColor', 'TsColorSelect', 'gbRings', 64, 76, 96, 24),
    c('gbShear', 'TsGroupBox', 'FrmRadarAnalysis', 6, 116, 470, 136, 'VR shear (velocity products, Alt+V)'),
    c('btnShear', 'TsBitBtn', 'gbShear', 10, 20, 110, 26, 'Measure'),
    c('btnShearClear', 'TsBitBtn', 'gbShear', 126, 20, 70, 26, 'Clear'),
    c('lblShearHint', 'TsLabel', 'gbShear', 204, 24, 260, 18, 'Max inbound, then max outbound · Esc cancels'),
    c('mmShear', 'TsMemo', 'gbShear', 10, 52, 452, 76),
    c('gbSounding', 'TsGroupBox', 'FrmRadarAnalysis', 6, 258, 470, 58, 'Soundings and hodographs (Alt+S)'),
    c('btnSounding', 'TsBitBtn', 'gbSounding', 10, 22, 110, 26, 'Pick point'),
    c('lblSounding', 'TsLabel', 'gbSounding', 128, 26, 336, 18, 'Nearest RAOB or a model profile at the timeline time'),
    ...VIEW3D,
  ],
}];
