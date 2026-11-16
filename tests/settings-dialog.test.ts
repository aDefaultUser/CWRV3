// Settings dialog Cancel: only the dialog's own edits are reverted. Changes made meanwhile by another tab (storage
// events) or by other panels of this tab are kept, and so is a later change to a setting the dialog had edited.
// Drives the real dialog: App's dialog/Cancel/Apply methods, the real bindings and form, over a minimal DOM.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  /** Web Storage shared by the two tabs; `writes` lists the keys written (the storage events). */
  class Mem {
    m = new Map<string, string>(); writes: string[] = [];
    getItem(k: string) { return this.m.get(k) ?? null; }
    setItem(k: string, v: string) { this.m.set(k, v); this.writes.push(k); }
  }
  /** Just enough DOM for forms and dialogs. */
  class El {
    children: El[] = []; parent: El | null = null; style: Record<string, string> = {}; dataset: Record<string, string> = {};
    private cls = new Set<string>(); private text = '';
    [k: string]: any;
    classList = { add: (...c: string[]) => c.forEach((x) => this.cls.add(x)), remove: (c: string) => this.cls.delete(c), contains: (c: string) => this.cls.has(c), toggle: (c: string, on = !this.cls.has(c)) => { if (on) this.cls.add(c); else this.cls.delete(c); return on; } };
    isConnected = false; clientWidth = 0; value = ''; checked = false;
    get textContent() { return this.text; }
    set textContent(v: string) { this.text = v; this.children = []; }
    set innerHTML(_v: string) { this.children = []; }
    get options() { return this.children; }
    append(...n: (El | string)[]) { for (const x of n) if (typeof x !== 'string') this.appendChild(x); }
    appendChild(n: El) { this.children.push(n); n.parent = this; return n; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    setAttribute() {} addEventListener() {} querySelector() { return null; }
  }
  return { mem: new Mem(), El };
});
vi.mock('../src/settings/store', async (orig) => {
  const m = await orig<typeof import('../src/settings/store')>();
  return { ...m, settings: new m.SettingsStore(h.mem) }; // this tab, over the shared storage
});
vi.mock('../src/app/persist', async (orig) => ({ ...(await orig<object>()), storeUserFile: vi.fn(async () => true) }));

const app0 = new h.El();
Object.assign(globalThis, { document: { createElement: () => new h.El(), getElementById: () => app0 }, innerWidth: 1200, innerHeight: 800 });

import { SettingsStore, settings } from '../src/settings/store';
import { App } from '../src/app/app';
import { buildBindings } from '../src/ui/bindings';
import { isOpen } from '../src/ui/dialogs';
import { CustomBackgroundLayer } from '../src/layers/custom-background';

/** The App's dialog methods on a stand-in instance (no renderer or layers). */
const app = Object.create(App.prototype) as App & Record<string, any>;
Object.assign(app, { settingsEdits: new Map(), toast: () => {}, prompt: async () => 'YES' });
app.bindings = buildBindings(app);

const find = (el: any, id: string): any => el.dataset?.id === `ui.TFrmSettings.${id}` ? el : el.children.map((c: any) => find(c, id)).find(Boolean);
const control = (id: string) => { const n = find(app0, id); expect(n, id).toBeTruthy(); return n; };
const click = (id: string) => control(id).onclick();
const slide = (id: string, v: number) => { const inp = control(id).children[0]; inp.value = String(v); inp.oninput(); };
/** The other tab: changes, writes, and this tab receives the storage events. */
const otherTab = (values: Record<string, unknown>) => {
  const other = new SettingsStore(h.mem);
  for (const [id, v] of Object.entries(values)) other.set(id, v);
  const from = h.mem.writes.length;
  other.flush();
  for (const k of h.mem.writes.slice(from)) settings.applyExternal(k);
};

describe('Settings dialog Cancel and Apply', () => {
  it('reverts overlay and custom-background preferences written after file pickers resolve', async () => {
    vi.stubGlobal('caches', { open: async () => ({ put: async () => {} }) });
    const originalPickFile = app.pickFile;
    const background = Object.create(CustomBackgroundLayer.prototype) as CustomBackgroundLayer;
    background.load = async () => {};
    app.customBg = background;
    app.poke = () => {};
    settings.set('config.overlayPath', 'old-overlay.png');
    settings.set('config.overlayActive', false);
    settings.set('ext.config.bgCustomImage', 'old-map.png');
    settings.set('ext.config.bgCustomWorldFile', 'old-map.wld');
    try {
      app.dialog('TFrmSettings');
      app.pickFile = async () => new File(['image'], 'new-overlay.png', { type: 'image/png' });
      await app.pickOverlay();
      app.pickFile = async () => new File(['image'], 'new-map.png', { type: 'image/png' });
      await app.pickCustomBackground('image');
      app.pickFile = async () => new File(['world'], 'new-map.wld', { type: 'text/plain' });
      await app.pickCustomBackground('world');
      expect(settings.str('config.overlayPath')).toBe('new-overlay.png');
      expect(settings.bool('config.overlayActive')).toBe(true);
      expect(settings.str('ext.config.bgCustomImage')).toBe('new-map.png');
      expect(settings.str('ext.config.bgCustomWorldFile')).toBe('new-map.wld');
      click('sButton8');
      expect(settings.str('config.overlayPath')).toBe('old-overlay.png');
      expect(settings.bool('config.overlayActive')).toBe(false);
      expect(settings.str('ext.config.bgCustomImage')).toBe('old-map.png');
      expect(settings.str('ext.config.bgCustomWorldFile')).toBe('old-map.wld');
    } finally {
      app.pickFile = originalPickFile;
      vi.unstubAllGlobals();
    }
  });

  it("reverts only the dialog's own edits, keeping other tabs', other panels' and later changes", () => {
    const star = settings.bool('config.starField'), lightning = settings.bool('layerState.LightningOn');
    settings.set('settings.atmosphereSunIntensity', 270);
    settings.flush();
    app.dialog('TFrmSettings');
    click('sCheckBox14'); // dialog edits
    slide('sTrackBar3', 400);
    expect(settings.bool('config.starField')).toBe(!star);
    settings.set('layerState.LightningOn', !lightning); // another panel of this tab, while the dialog is open
    settings.flush(); // the dialog's edits are durable before the other tab's changes land
    otherTab({ 'settings.nexradSiteICAO': 'KFWS', 'layerState.CustomRadarOn': true, 'settings.atmosphereSunIntensity': 500 });
    expect(settings.num('settings.atmosphereSunIntensity')).toBe(500);
    app.dialog('TFrmSettings'); // opening it again keeps the open session
    click('sButton8'); // Cancel
    expect(isOpen('TFrmSettings')).toBe(false);
    expect(settings.bool('config.starField')).toBe(star);
    expect(settings.num('settings.atmosphereSunIntensity')).toBe(500); // changed by the other tab after the dialog's edit
    expect(settings.str('settings.nexradSiteICAO')).toBe('KFWS');
    expect(settings.bool('layerState.CustomRadarOn')).toBe(true);
    expect(settings.bool('layerState.LightningOn')).toBe(!lightning);
  });

  it('makes Apply the new baseline, keeps edits on OK, and reverts a confirmed reset on Cancel', async () => {
    const star = settings.bool('config.starField');
    app.dialog('TFrmSettings');
    slide('sTrackBar3', 100);
    click('sCheckBox14');
    click('sButton9'); // Apply
    slide('sTrackBar3', 200);
    click('sButton8'); // Cancel: back to what was applied
    expect(settings.num('settings.atmosphereSunIntensity')).toBe(100);
    expect(settings.bool('config.starField')).toBe(!star);

    app.dialog('TFrmSettings');
    slide('sTrackBar3', 300);
    click('sButton5'); // OK
    expect(isOpen('TFrmSettings')).toBe(false);
    app.dialog('TFrmSettings');
    click('sButton8'); // a new session: nothing of the earlier one is reverted
    expect(settings.num('settings.atmosphereSunIntensity')).toBe(300);

    settings.set('settings.nrAlpha', 10);
    app.dialog('TFrmSettings');
    click('sButton4'); // "Restore default layer/map settings", confirmed
    await vi.waitFor(() => expect(settings.num('settings.nrAlpha')).toBe(255));
    click('sButton8');
    expect(settings.num('settings.nrAlpha')).toBe(10);
    expect(settings.num('settings.atmosphereSunIntensity')).toBe(300);
  });
});
