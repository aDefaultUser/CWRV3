// Form catalog of the CWRV3 additions that have no original form (same structure as ui-forms.ts). Maintained by hand.
import type { FormDef } from '../ui/form-types';

const F = 'TFrmRadarAnalysis';
const c = (name: string, cls: string, parent: string, l: number, t: number, w: number, h: number, caption?: string, extra: object = {}) => ({ id: `ui.${F}.${name}`, name, cls, parent, l, t, w, h, caption, ...extra });

/** Radar Analysis Tools: range rings, VR shear and the sounding tool. */
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
  ],
}];
