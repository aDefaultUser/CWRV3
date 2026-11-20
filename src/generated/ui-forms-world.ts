// Form catalog of the Worldwide Weather tab and the RainViewer terms dialog (CWRV3 additions; same structure as
// ui-forms.ts). Maintained by hand.
import type { FormDef } from '../ui/form-types';

const W = 'TWorldLayersFrame', T = 'TFrmWorldRadarTerms';
const c = (form: string, name: string, cls: string, parent: string, l: number, t: number, w: number, h: number, caption?: string, extra: object = {}) => ({ id: `ui.${form}.${name}`, name, cls, parent, l, t, w, h, caption, ...extra });
const w = (name: string, cls: string, parent: string, l: number, t: number, wd: number, h: number, caption?: string, extra: object = {}) => c(W, name, cls, parent, l, t, wd, h, caption, extra);

export const WORLD_FORMS: readonly FormDef[] = [{
  form: W, scope: 'world', controls: [
    { id: `ui.${W}.WorldLayersFrame`, name: 'WorldLayersFrame', cls: W, parent: null, l: 0, t: 0, w: 780, h: 130 },
    w('gbRadar', 'TsGroupBox', 'WorldLayersFrame', 4, 2, 384, 124, 'Radar — RainViewer global mosaic (opt-in)'),
    w('rdOn', 'TsSlider', 'gbRadar', 8, 20, 74, 22, 'Radar'),
    w('rdAlphaLbl', 'TsLabel', 'gbRadar', 90, 23, 50, 18, 'Opacity'),
    w('rdAlpha', 'TsTrackBar', 'gbRadar', 140, 20, 110, 22, undefined, { min: 0, max: 255 }),
    w('rdSmooth', 'TsCheckBox', 'gbRadar', 258, 20, 120, 22, 'Smoothed tiles'),
    w('rdCoverage', 'TsCheckBox', 'gbRadar', 8, 45, 196, 22, 'Shade areas without radar'),
    w('rdLegend', 'TsCheckBox', 'gbRadar', 206, 45, 70, 22, 'Legend'),
    w('rdTerms', 'TsSpeedButton', 'gbRadar', 280, 44, 98, 22, 'Terms / source…'),
    w('rdStatus', 'TsLabel', 'gbRadar', 8, 72, 370, 46, ''),
    w('gbSat', 'TsGroupBox', 'WorldLayersFrame', 392, 2, 384, 124, 'Satellite — NOAA GMGSI geostationary mosaic'),
    w('stOn', 'TsSlider', 'gbSat', 8, 20, 86, 22, 'Satellite'),
    w('stProduct', 'TsComboBox', 'gbSat', 100, 20, 180, 22, undefined, { items: ['Longwave infrared (~11 µm)', 'Visible (daylight only)', 'Water vapour (~6.7 µm)', 'Shortwave infrared (~3.9 µm)'] }),
    w('stInfo', 'TsSpeedButton', 'gbSat', 286, 20, 92, 22, 'About / limits…'),
    w('stAlphaLbl', 'TsLabel', 'gbSat', 8, 48, 50, 18, 'Opacity'),
    w('stAlpha', 'TsTrackBar', 'gbSat', 60, 45, 140, 22, undefined, { min: 0, max: 255 }),
    w('stStatus', 'TsLabel', 'gbSat', 8, 72, 370, 46, ''),
  ],
}, {
  form: T, scope: 'world', controls: [
    { id: `ui.${T}.FrmWorldRadarTerms`, name: 'FrmWorldRadarTerms', cls: T, parent: null, l: 0, t: 0, caption: 'Worldwide radar — RainViewer terms' },
    c(T, 'mmTerms', 'TsMemo', 'FrmWorldRadarTerms', 6, 6, 520, 236),
    c(T, 'btnAccept', 'TsButton', 'FrmWorldRadarTerms', 6, 250, 200, 26, 'Accept and show radar'),
    c(T, 'btnDecline', 'TsButton', 'FrmWorldRadarTerms', 212, 250, 120, 26, 'Not now'),
    c(T, 'btnRevoke', 'TsButton', 'FrmWorldRadarTerms', 338, 250, 188, 26, 'Withdraw acceptance'),
  ],
}];
