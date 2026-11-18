// Linked panes dialog (CWRV3 addition; geometry in generated/ui-forms-panes.ts): the layout, the quick presets, what
// NEXRAD shows in panes 2–4 and the saved layouts, with the menu entries that open it.
import type { App } from '../app/app';
import type { BindingMap, MenuNode } from './form';
import type { MenuAction } from './dialogs';
import { panes, presets, lowestTilts, LAYOUTS, type RadarView } from '../app/panes';
import { L2, L3 } from '../radar/sources';

const F = 'TFrmPanes';
const L3_LIST = L3.filter((p) => !p.disabled);

export function paneBindings(app: App): Record<string, BindingMap> {
  const nx = app.nexrad;
  const act = (run: () => void, disabled?: () => boolean): BindingMap[string] => ({ kind: 'action', run, disabled });
  const shown = (pane: number) => pane < panes.count;
  /** Tilt angles to choose from: the volume's, and the pane's own angle when the volume has no such cut. */
  const tilts = (v: RadarView) => { const all = nx.tilts.map((t) => t.angle); return lowestTilts(all.some((a) => Math.abs(a - v.tilt) < 0.05) ? all : [...all, v.tilt], 64); };
  const row = (pane: number): BindingMap => {
    const view = () => panes.views[pane - 1], set = (patch: Partial<RadarView>) => panes.setView(pane, patch);
    return {
      [`${F}.lblPane${pane}`]: { kind: 'status', text: () => `Pane ${pane + 1}${shown(pane) ? '' : ' (hidden)'}` },
      [`${F}.level${pane}`]: { kind: 'custom', get: () => (view().level2 ? 0 : 1), set: (i: number) => set({ level2: i === 0 }) },
      [`${F}.product${pane}`]: {
        kind: 'custom', items: () => (view().level2 ? L2.map((p) => p.name) : L3_LIST.map((p) => p.name)),
        get: () => (view().level2 ? view().product : L3_LIST.findIndex((p) => p.index === view().l3)),
        set: (i: number) => set(view().level2 ? { product: i } : { l3: L3_LIST[i]?.index ?? 0 }),
      },
      [`${F}.tilt${pane}`]: {
        kind: 'custom', items: () => tilts(view()).map((a) => `${a.toFixed(1)}°`), disabled: () => !view().level2 || view().product >= 11,
        get: () => tilts(view()).findIndex((a) => Math.abs(a - view().tilt) < 0.05), set: (i: number) => { const a = tilts(view())[i]; if (a !== undefined) set({ tilt: a }); },
      },
      [`${F}.offset${pane}`]: { kind: 'custom', get: () => view().offsetMin, set: (v: number) => set({ offsetMin: v }) },
    };
  };
  let sel = -1;
  const preset = (i: number) => act(() => app.applyPaneLayout(presets(nx.view(), nx.tilts.map((t) => t.angle))[i]));
  return {
    [F]: {
      [`${F}.layout`]: { kind: 'custom', items: () => LAYOUTS.map((l) => l.name), get: () => panes.layout, set: (i: number) => panes.setLayout(i) },
      [`${F}.btnPreset0`]: preset(0), [`${F}.btnPreset1`]: preset(1), [`${F}.btnPreset2`]: preset(2),
      [`${F}.lblMain`]: { kind: 'status', text: () => `${nx.paneLabel(0)} — the Radar Control product, tilt and timeline` },
      ...row(1), ...row(2), ...row(3),
      [`${F}.lbSaved`]: { kind: 'list', items: () => panes.saved.map((l) => ({ label: `${l.name} — ${LAYOUTS[l.layout].name}` })), selected: () => sel, select: (i, dbl) => { sel = i; if (dbl && panes.saved[i]) app.applyPaneLayout(panes.saved[i]); } },
      [`${F}.btnRecall`]: act(() => app.applyPaneLayout(panes.saved[sel]), () => !panes.saved[sel]),
      [`${F}.btnSave`]: act(async () => {
        const name = await app.prompt('Save pane layout', 'Name of the layout:', LAYOUTS[panes.layout].name);
        if (name?.trim()) panes.save(name.trim(), nx.view());
      }),
      [`${F}.btnDelete`]: act(() => { panes.remove(sel); sel = -1; }, () => !panes.saved[sel]),
    },
  };
}

/** Main-menu entries appended after the catalog items. */
export function paneMenu(): MenuNode[] {
  return [{ id: 'ext.pnOpen', name: 'pnOpen', caption: 'Linked panes…', children: [] }, { id: 'ext.pnCycle', name: 'pnCycle', caption: 'Next pane layout (Alt+P)', children: [] }];
}
export function paneMenuActions(app: App): Record<string, MenuAction> {
  return { pnOpen: { run: () => app.dialog(F), checked: () => panes.count > 1 }, pnCycle: { run: () => app.cyclePanes() } };
}
