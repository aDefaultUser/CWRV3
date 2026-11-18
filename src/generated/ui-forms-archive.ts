// Form catalog of the archive replay dialog (CWRV3 addition; same structure as ui-forms.ts). Maintained by hand.
import type { FormDef } from '../ui/form-types';

const F = 'TFrmArchive';
const c = (name: string, cls: string, parent: string, l: number, t: number, w: number, h: number, caption?: string) => ({ id: `ui.${F}.${name}`, name, cls, parent, l, t, w, h, caption });

/** Archive replay: UTC date/time and radar site, loop stepping, return to live, event presets. */
export const ARCHIVE_FORMS: readonly FormDef[] = [{
  form: F, scope: 'timeline', controls: [
    { id: `ui.${F}.FrmArchive`, name: 'FrmArchive', cls: F, parent: null, l: 0, t: 0, caption: 'Archive replay' },
    c('gbTime', 'TsGroupBox', 'FrmArchive', 6, 4, 448, 112, 'Replay time (UTC)'),
    c('lblDate', 'TsLabel', 'gbTime', 10, 25, 36, 18, 'Date:'),
    c('edDate', 'TsEdit', 'gbTime', 48, 22, 92, 22),
    c('lblTime', 'TsLabel', 'gbTime', 150, 25, 36, 18, 'Time:'),
    c('edTime', 'TsEdit', 'gbTime', 188, 22, 56, 22),
    c('lblSite', 'TsLabel', 'gbTime', 256, 25, 70, 18, 'Radar site:'),
    c('edSite', 'TsEdit', 'gbTime', 328, 22, 60, 22),
    c('btnGo', 'TsButton', 'gbTime', 10, 52, 96, 24, 'Go to time'),
    c('btnBack', 'TsButton', 'gbTime', 112, 52, 92, 24, '◀ One loop'),
    c('btnFwd', 'TsButton', 'gbTime', 210, 52, 92, 24, 'One loop ▶'),
    c('btnLive', 'TsButton', 'gbTime', 344, 52, 92, 24, 'Live'),
    c('lblHint', 'TsLabel', 'gbTime', 10, 86, 430, 18, 'YYYY-MM-DD and HH:MM in UTC; the loop ends at this time.'),
    c('mmStatus', 'TsMemo', 'FrmArchive', 6, 122, 448, 74),
    c('gbPresets', 'TsGroupBox', 'FrmArchive', 6, 202, 448, 170, 'Event presets'),
    c('lbPresets', 'TsListBox', 'gbPresets', 10, 20, 428, 108),
    c('btnRecall', 'TsButton', 'gbPresets', 10, 136, 96, 24, 'Recall'),
    c('btnSave', 'TsButton', 'gbPresets', 112, 136, 150, 24, 'Save current as…'),
    c('btnDelete', 'TsButton', 'gbPresets', 268, 136, 96, 24, 'Delete'),
  ],
}];
