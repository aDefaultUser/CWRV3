// Radar analysis tools dialog (CWRV3 addition; geometry in generated/ui-forms-analysis.ts): bindings and the menu
// entries that open it. Range-ring controls bind through their settings catalog `ui` entries.
import type { App } from '../app/app';
import type { BindingMap, MenuNode } from './form';
import type { MenuAction } from './dialogs';
import { settings } from '../settings/store';
import { openSounding } from './sounding-panel';
import { VIEW3D, VIEW3D_MOMENTS } from '../layers/radar-volume3d';
import { VOLUME_MOMENTS } from '../radar/l2products';

const F = 'TFrmRadarAnalysis';

const act = (run: () => void, down?: () => boolean): BindingMap[string] => ({ kind: 'action', run, down });

/** The moment the 3D volume view shows (ext.settings.nexrad3DViewMoment). */
const v3View = () => VIEW3D_MOMENTS[settings.num(VIEW3D('Moment'))] ?? VIEW3D_MOMENTS[0];
/**
 * 3D volume view controls: each threshold has one control per moment, shown for the selected moment; the surface
 * opacities edit the alpha of the colour settings. The other controls bind through their catalog `ui` entries.
 */
function view3dBindings(app: App): BindingMap {
  const velocity = () => v3View().moment === 'VEL';
  const unit = (): BindingMap[string] => ({ kind: 'status', text: () => VOLUME_MOMENTS[v3View().moment].unit });
  const alpha = (id: string): BindingMap[string] => ({
    kind: 'custom', get: () => Math.round((settings.arr<number>(id)[3] / 255) * 100),
    set: (v: number) => settings.set(id, [...settings.arr<number>(id).slice(0, 3), Math.round(Math.min(100, Math.max(0, v)) * 2.55)]),
  });
  const b: BindingMap = {
    [`${F}.v3Mode`]: { kind: 'combo', id: VIEW3D('') }, [`${F}.v3Moment`]: { kind: 'combo', id: VIEW3D('Moment') },
    [`${F}.v3Unit0`]: unit(), [`${F}.v3Unit1`]: unit(), [`${F}.v3Unit2`]: unit(),
    [`${F}.v3Iso1Label`]: { kind: 'status', text: () => (velocity() ? 'Outbound from' : 'Surface 1 from') },
    [`${F}.v3Iso2Label`]: { kind: 'status', text: () => (velocity() ? 'Inbound from' : 'Surface 2 from') },
    [`${F}.v3Iso1Alpha`]: alpha(VIEW3D('Iso1Color')), [`${F}.v3Iso2Alpha`]: alpha(VIEW3D('Iso2Color')),
    [`${F}.v3Status`]: { kind: 'status', text: () => app.nexrad.view3d.status },
  };
  for (const m of Object.keys(VOLUME_MOMENTS)) for (const k of ['Min', 'Iso1', 'Iso2']) {
    const id = VIEW3D(k + m);
    b[`${F}.v3${k}${m}`] = { kind: 'custom', get: () => settings.num(id), set: (v: number) => settings.set(id, v), hidden: () => v3View().moment !== m };
  }
  return b;
}

/** Bindings of the analysis dialog; the range-ring controls bind automatically through their catalog `ui` entries. */
export function analysisBindings(app: App): Record<string, BindingMap> {
  return {
    [F]: {
      ...view3dBindings(app),
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
