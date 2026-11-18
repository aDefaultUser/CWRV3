// Radar analysis tools dialog (CWRV3 addition; geometry in generated/ui-forms-analysis.ts): bindings and the menu
// entries that open it. Range-ring controls bind through their settings catalog `ui` entries.
import type { App } from '../app/app';
import type { BindingMap, MenuNode } from './form';
import type { MenuAction } from './dialogs';
import { settings } from '../settings/store';
import { openSounding } from './sounding-panel';

const F = 'TFrmRadarAnalysis';

const act = (run: () => void, down?: () => boolean): BindingMap[string] => ({ kind: 'action', run, down });

/** Bindings of the analysis dialog; the range-ring controls bind automatically through their catalog `ui` entries. */
export function analysisBindings(app: App): Record<string, BindingMap> {
  return {
    [F]: {
      [`${F}.rrUnit`]: { kind: 'status', text: () => (settings.bool('config.distanceMeasureImperial') ? 'mi' : 'km') },
      [`${F}.btnShear`]: act(() => app.startMeasure('vrShear'), () => app.tool === 'vrShear'),
      [`${F}.btnShearClear`]: act(() => { app.nexrad.tools.cancelShear(); if (app.tool === 'vrShear') app.startMeasure('vrShear'); }),
      [`${F}.mmShear`]: { kind: 'status', text: () => app.nexrad.tools.shearText() },
      [`${F}.btnSounding`]: act(() => app.startMeasure('sounding'), () => app.tool === 'sounding'),
    },
  };
}

/** Main-menu entries appended after the catalog items. */
export function analysisMenu(): MenuNode[] {
  return [{ id: 'ext.anSep', name: 'anSep', caption: '-', children: [] }, { id: 'ext.anTools', name: 'anTools', caption: 'Radar analysis tools…', children: [] },
    { id: 'ext.anShear', name: 'anShear', caption: 'VR shear (Alt+V)', children: [] }, { id: 'ext.anSounding', name: 'anSounding', caption: 'Sounding at a point (Alt+S)', children: [] }];
}
export function analysisMenuActions(app: App): Record<string, MenuAction> {
  return {
    anTools: { run: () => app.dialog(F) }, anShear: { run: () => app.startMeasure('vrShear'), checked: () => app.tool === 'vrShear' },
    anSounding: { run: () => app.startMeasure('sounding'), checked: () => app.tool === 'sounding' },
  };
}

/** Ctrl+right-click map menu entry: a sounding at the clicked point. */
export function analysisPointMenu(): MenuNode[] { return [{ id: 'ext.anSoundingHere', name: 'anSoundingHere', caption: 'Sounding here…', children: [] }]; }
export function analysisPointActions(ll: [number, number] | null): Record<string, MenuAction> {
  return { anSoundingHere: { run: () => { if (ll) openSounding(ll[0], ll[1]); }, disabled: ll ? false : 'Click on the map' } };
}
