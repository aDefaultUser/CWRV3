// Form catalog of the linked panes dialog (CWRV3 addition; same structure as ui-forms.ts). Maintained by hand.
import type { FormDef } from '../ui/form-types';

const F = 'TFrmPanes';
const c = (name: string, cls: string, parent: string, l: number, t: number, w: number, h: number, caption?: string, extra: object = {}) => ({ id: `ui.${F}.${name}`, name, cls, parent, l, t, w, h, caption, ...extra });

/** One row per pane 2–4: level, product, tilt and time offset. */
const ROWS = [1, 2, 3].flatMap((p) => {
  const y = 44 + p * 28;
  return [
    c(`lblPane${p}`, 'TsLabel', 'gbViews', 10, y + 4, 88, 18, `Pane ${p + 1}`),
    c(`level${p}`, 'TsComboBox', 'gbViews', 100, y, 76, 22, undefined, { items: ['Level 2', 'Level 3'] }),
    c(`product${p}`, 'TsComboBox', 'gbViews', 182, y, 250, 22),
    c(`tilt${p}`, 'TsComboBox', 'gbViews', 438, y, 70, 22),
    c(`offset${p}`, 'TsSpinEdit', 'gbViews', 514, y, 56, 22, undefined, { inc: 5 }),
  ];
});

/** Linked panes: layout, quick presets, what NEXRAD shows in each pane, saved layouts. */
export const PANE_FORMS: readonly FormDef[] = [{
  form: F, scope: 'nexrad-pro', controls: [
    { id: `ui.${F}.FrmPanes`, name: 'FrmPanes', cls: F, parent: null, l: 0, t: 0, caption: 'Linked panes' },
    c('gbLayout', 'TsGroupBox', 'FrmPanes', 6, 4, 584, 82, 'Layout (Alt+P cycles) and quick presets'),
    c('lblLayout', 'TsLabel', 'gbLayout', 10, 25, 48, 18, 'Layout:'),
    c('layout', 'TsComboBox', 'gbLayout', 60, 21, 150, 22),
    c('lblLinked', 'TsLabel', 'gbLayout', 222, 25, 350, 18, 'One map view, timeline and cursor for every pane'),
    c('btnPreset0', 'TsButton', 'gbLayout', 10, 50, 110, 24, 'REF / SRV'),
    c('btnPreset1', 'TsButton', 'gbLayout', 126, 50, 170, 24, 'REF / VEL / ZDR / CC'),
    c('btnPreset2', 'TsButton', 'gbLayout', 302, 50, 150, 24, 'Four lowest tilts'),
    c('gbViews', 'TsGroupBox', 'FrmPanes', 6, 92, 584, 164, 'NEXRAD in each pane (every other layer is the same in all panes)'),
    c('lblHLevel', 'TsLabel', 'gbViews', 100, 22, 76, 18, 'Data'),
    c('lblHProduct', 'TsLabel', 'gbViews', 182, 22, 250, 18, 'Product'),
    c('lblHTilt', 'TsLabel', 'gbViews', 438, 22, 70, 18, 'Tilt'),
    c('lblHOffset', 'TsLabel', 'gbViews', 514, 22, 66, 18, 'Min. earlier'),
    c('lblPane0', 'TsLabel', 'gbViews', 10, 48, 88, 18, 'Pane 1'),
    c('lblMain', 'TsLabel', 'gbViews', 100, 48, 474, 18, ''),
    ...ROWS,
    c('gbSaved', 'TsGroupBox', 'FrmPanes', 6, 262, 584, 150, 'Saved layouts'),
    c('lbSaved', 'TsListBox', 'gbSaved', 10, 20, 564, 90),
    c('btnRecall', 'TsButton', 'gbSaved', 10, 118, 96, 24, 'Recall'),
    c('btnSave', 'TsButton', 'gbSaved', 112, 118, 150, 24, 'Save current as…'),
    c('btnDelete', 'TsButton', 'gbSaved', 268, 118, 96, 24, 'Delete'),
  ],
}];
