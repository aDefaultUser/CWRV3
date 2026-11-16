import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore, SETTING_DEFS, PALETTE_SETTINGS } from '../src/settings/store';
import { migrateLegacyStorage, onSaveFailure, prefObject, loadPref, savePref, useStorage, PREFIX } from '../src/app/persist';

/** In-memory Web Storage with an optional write failure (quota). */
class Mem {
  m = new Map<string, string>();
  failWrites = false;
  /** Keys whose writes fail (quota) while the others succeed. */
  failKeys = new Set<string>();
  /** Runs once before the next write is applied (another tab acting between this tab's read and write). */
  beforeNextWrite: (() => void) | null = null;
  /** Keys written, in order (the storage events other tabs receive). */
  writes: string[] = [];
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) {
    const hook = this.beforeNextWrite;
    this.beforeNextWrite = null;
    hook?.();
    if (this.failWrites || this.failKeys.has(k)) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    this.m.set(k, v);
    this.writes.push(k);
  }
  removeItem(k: string) { this.m.delete(k); }
}

afterEach(() => useStorage(null));

/** A changed value for every setting type, within the setting's range. */
function changedValue(id: string): unknown {
  const d = SETTING_DEFS.get(id)!;
  switch (d.type) {
    case 'boolean': return !d.default;
    case 'integer': case 'number': {
      if (d.enum) return d.enum.find((x) => x !== d.default) ?? d.default;
      const lo = d.min ?? 0, hi = d.max ?? (d.default as number) + 10;
      const v = (d.default as number) === hi ? lo : Math.min(hi, (d.default as number) + 1);
      return d.type === 'integer' ? Math.round(v) : v;
    }
    case 'string': return PALETTE_SETTINGS.has(id) ? (d.default === 'NWSRefl' ? 'BW' : 'NWSRefl') : `${d.default}x`;
    case 'datetime': return 1_700_000_000_000;
    case 'color': return [12, 34, 56];
    case 'rgba': return [12, 34, 56, 78];
    case 'point': return [3, 4];
    case 'point3': return [1.5, 2.5, 3.5, 4.5];
    case 'string[]': return PALETTE_SETTINGS.has(id) ? (d.default as string[]).map(() => 'BW') : ['a', 'b'];
    default: return undefined;
  }
}

describe('settings persistence across reloads', () => {
  it('restores a changed value of every stored setting type after a reload', () => {
    const mem = new Mem();
    const a = new SettingsStore(mem);
    const byType = new Map<string, string>();
    for (const d of SETTING_DEFS.values()) {
      if (d.type === 'aggregate' || d.legacy || d.postLoad || byType.has(d.type)) continue;
      if (d.id === 'settings.nexradSiteICAO') continue; // drives a derived index
      byType.set(d.type, d.id);
    }
    expect(byType.size).toBeGreaterThanOrEqual(8);
    const expected = new Map<string, unknown>();
    for (const id of byType.values()) expected.set(id, a.set(id, changedValue(id)));
    a.set('config.generalActiveFPS', 144);
    a.set('config.radarSites', { Scale: 1.3 });
    expect(a.flush()).toBe(true);
    const b = new SettingsStore(mem);
    for (const [id, v] of expected) { expect(b.get(id), id).toEqual(v); expect(v, id).not.toEqual(SETTING_DEFS.get(id)!.default); }
    expect(b.get('config.generalActiveFPS')).toBe(144);
    expect(b.get<{ Scale: number }>('config.radarSites').Scale).toBe(1.3);
  });

  it('defaults to an unlimited FPS target with follow-the-target loop limit', () => {
    const s = new SettingsStore();
    expect(s.get('config.generalActiveFPS')).toBe(0);
    expect(s.get('config.generalRestingFPSLoop')).toBe(0);
    s.set('config.generalActiveFPS', -5);
    expect(s.get('config.generalActiveFPS')).toBe(0);
  });

  it('keeps a failed write pending and reports it until a later write succeeds', () => {
    const mem = new Mem();
    const s = new SettingsStore(mem);
    const failures: string[] = [];
    const off = onSaveFailure((what) => failures.push(what));
    mem.failWrites = true;
    s.set('settings.nrAlpha', 77);
    expect(s.flush()).toBe(false);
    expect(s.pending).toBe(true);
    expect(s.saveError).toBe('browser storage is full');
    expect(failures).toEqual(['settings']);
    expect(new SettingsStore(mem).get('settings.nrAlpha')).toBe(255); // not on disk
    mem.failWrites = false;
    expect(s.flush()).toBe(true);
    expect(s.pending).toBe(false);
    expect(s.saveError).toBeNull();
    expect(new SettingsStore(mem).get('settings.nrAlpha')).toBe(77);
    off();
  });

  it('retries a failed write on its own once storage accepts it again', () => {
    vi.useFakeTimers();
    try {
      const mem = new Mem();
      const s = new SettingsStore(mem);
      const off = onSaveFailure(() => {});
      mem.failWrites = true;
      s.set('settings.nrAlpha', 66);
      vi.advanceTimersByTime(300);
      expect(s.pending).toBe(true);
      mem.failWrites = false;
      vi.advanceTimersByTime(5000);
      expect(s.pending).toBe(false);
      expect(new SettingsStore(mem).get('settings.nrAlpha')).toBe(66);
      off();
    } finally { vi.useRealTimers(); }
  });

  it('applies post-load rules before ranges on import, exactly as on load', () => {
    const doc = { values: { 'settings.nexradUpdateSweepEffectDuration': -4, 'settings.nexradL2DataSource': 1, 'settings.nrAlpha': 9999 } };
    const imported = new SettingsStore();
    imported.importDocument(doc, false);
    const mem = new Mem();
    mem.setItem(PREFIX + 'CWRV3Settings', JSON.stringify(doc));
    const loaded = new SettingsStore(mem);
    for (const id of Object.keys(doc.values)) expect(imported.get(id), id).toEqual(loaded.get(id));
    expect(imported.get('settings.nexradUpdateSweepEffectDuration')).toBe(4);
    expect(imported.get('settings.nrAlpha')).toBe(255);
  });

  it('keeps local changes that are not yet written when another tab writes the same settings', () => {
    const mem = new Mem();
    const s = new SettingsStore(mem);
    s.set('settings.nrAlpha', 10); // pending locally
    const other = new SettingsStore(mem);
    other.set('settings.nrAlpha', 200); other.set('settings.nrSmoothing', false);
    expect(other.flush()).toBe(true);
    for (const k of mem.writes) s.applyExternal(k);
    expect(s.get('settings.nrAlpha')).toBe(10);
    expect(s.get('settings.nrSmoothing')).toBe(false);
  });
});

describe('settings shared by several tabs (one storage)', () => {
  const key = (id: string) => `cwrv3.setting/${id}`;
  const stored = (mem: Mem, id: string) => JSON.parse(mem.getItem(key(id))!);
  /** Two tabs that both loaded (read storage) before either writes, over documents of an earlier build. */
  const tabs = () => {
    const mem = new Mem();
    mem.setItem('cwrv3.CWRV3Settings', JSON.stringify({ values: { 'settings.nrAlpha': 50, 'settings.nrSmoothing': true } }));
    mem.writes = [];
    return { mem, a: new SettingsStore(mem), b: new SettingsStore(mem) };
  };
  const deliver = (mem: Mem, from: number, to: SettingsStore, reversed = false) => {
    const events = mem.writes.slice(from);
    for (const k of reversed ? events.reverse() : events) to.applyExternal(k);
  };

  for (const order of ['B inside A', 'A inside B'] as const) {
    it(`never loses either tab's different settings when one tab's whole write lands inside the other's (${order})`, () => {
      const { mem, a, b } = tabs();
      a.set('settings.nrAlpha', 10); a.set('config.generalActiveFPS', 120);
      b.set('settings.nrSmoothing', false); b.set('layerState.LightningOn', true);
      const [outer, inner] = order === 'B inside A' ? [a, b] : [b, a];
      // The inner tab writes after the outer one started its flush and before its first write lands.
      mem.beforeNextWrite = () => { expect(inner.flush()).toBe(true); };
      expect(outer.flush()).toBe(true);
      const expected = { 'settings.nrAlpha': 10, 'config.generalActiveFPS': 120, 'settings.nrSmoothing': false, 'layerState.LightningOn': true };
      for (const [id, v] of Object.entries(expected)) expect(stored(mem, id), id).toEqual(v);
      deliver(mem, 0, a, true); deliver(mem, 0, b); // storage events, one tab's in reverse order
      for (const t of [a, b, new SettingsStore(mem)]) for (const [id, v] of Object.entries(expected)) expect(t.get(id), id).toEqual(v);
    });
  }

  it('lets the last durable write win for the same setting and converges both tabs, whatever the event order', () => {
    const { mem, a, b } = tabs();
    a.set('settings.nrAlpha', 10);
    b.set('settings.nrAlpha', 200);
    mem.beforeNextWrite = () => b.flush(); // B's write lands first, A's last
    a.flush();
    expect(stored(mem, 'settings.nrAlpha')).toBe(10);
    deliver(mem, 0, b, true); deliver(mem, 0, a);
    expect(a.get('settings.nrAlpha')).toBe(10);
    expect(b.get('settings.nrAlpha')).toBe(10);
  });

  it('ignores delayed or reordered storage events: the current stored value applies, never an older one', () => {
    const { mem, a, b } = tabs();
    const seen: unknown[] = [];
    b.on('settings.nrAlpha', (_id, v) => seen.push(v));
    a.set('settings.nrAlpha', 10); a.flush();
    a.set('settings.nrAlpha', 20); a.flush();
    deliver(mem, 0, b, true); // the second write's event, then the late first one
    expect(b.get('settings.nrAlpha')).toBe(20);
    expect(seen).toEqual([20]);
    // A tab's own unsaved change survives events and is then written.
    b.set('settings.nrAlpha', 25);
    a.set('settings.nrAlpha', 30); const n = mem.writes.length; a.flush();
    deliver(mem, n, b);
    expect(b.get('settings.nrAlpha')).toBe(25);
    const m = mem.writes.length; b.flush(); deliver(mem, m, a);
    expect(a.get('settings.nrAlpha')).toBe(25);
    // Cleared storage (key null): every setting not pending here follows storage (earlier documents are gone too).
    mem.m.clear(); b.applyExternal(null);
    expect(b.get('settings.nrAlpha')).toBe(255);
  });

  it('retries a write that hit the quota without overwriting what another tab saved meanwhile', () => {
    const { mem, a, b } = tabs();
    const off = onSaveFailure(() => {});
    a.set('settings.nrAlpha', 10);
    mem.failWrites = true;
    expect(a.flush()).toBe(false);
    mem.failWrites = false;
    b.set('settings.nrSmoothing', false); b.flush();
    deliver(mem, 0, a);
    expect(a.flush()).toBe(true);
    expect(stored(mem, 'settings.nrAlpha')).toBe(10);
    expect(stored(mem, 'settings.nrSmoothing')).toBe(false);
    expect(a.get('settings.nrSmoothing')).toBe(false);
    off();
  });

  it('clears only the settings actually written when some writes fail; the error stays until all are written', () => {
    const { mem, a, b } = tabs();
    const off = onSaveFailure(() => {});
    a.set('settings.nrAlpha', 10); a.set('settings.nrSmoothing', false);
    mem.failKeys.add(key('settings.nrSmoothing'));
    expect(a.flush()).toBe(false);
    expect(a.pending).toBe(true);
    expect(a.saveError).toBe('browser storage is full');
    expect(stored(mem, 'settings.nrAlpha')).toBe(10);
    expect(mem.getItem(key('settings.nrSmoothing'))).toBeNull();
    // Another tab's write of the failed setting does not replace the pending local value; the retry then wins.
    b.set('settings.nrSmoothing', false); b.set('settings.nrSmoothing', true); b.flush();
    deliver(mem, 0, a);
    expect(a.get('settings.nrSmoothing')).toBe(false);
    mem.failKeys.clear();
    expect(a.flush()).toBe(true);
    expect(a.pending).toBe(false);
    expect(a.saveError).toBeNull();
    expect(new SettingsStore(mem).get('settings.nrSmoothing')).toBe(false);
    off();
  });

  it('keeps a change made just before a reload when the page-hide flush runs', () => {
    const mem = new Mem();
    const a = new SettingsStore(mem);
    a.set('settings.nrAlpha', 42); // the 250 ms timer never fires
    a.flush(); // pagehide
    expect(new SettingsStore(mem).get('settings.nrAlpha')).toBe(42);
  });

  it('reads the earlier whole documents under the records, never writes them, and never lets them override a record', () => {
    const { mem, a } = tabs();
    mem.setItem('cwrv3.ProductStatus', JSON.stringify({ values: { 'layerState.NWSConvectiveOutlooksTypeIdx': 5 } }));
    mem.writes = [];
    const legacy = new SettingsStore(mem);
    expect(legacy.get('settings.nrAlpha')).toBe(50);
    expect(legacy.get('layerState.NWSConvectiveOutlooksFamilyIdx')).toBe(2); // outlook migration still applies
    a.set('settings.nrAlpha', 10); a.reset('settings.nrSmoothing'); a.set('settings.nrSmoothing', false); a.reset('settings.nrSmoothing');
    a.flush();
    expect(mem.writes.some((k) => !k.startsWith('cwrv3.setting/'))).toBe(false);
    expect(stored(mem, 'settings.nrSmoothing')).toBe(true); // a reset is written as the default, not a removal
    // A tab of an earlier build rewrites its stale snapshot afterwards.
    mem.setItem('cwrv3.CWRV3Settings', JSON.stringify({ values: { 'settings.nrAlpha': 77, 'settings.nrSmoothing': false } }));
    a.applyExternal('cwrv3.CWRV3Settings');
    const reloaded = new SettingsStore(mem);
    for (const t of [a, reloaded]) {
      expect(t.get('settings.nrAlpha')).toBe(10);
      expect(t.get('settings.nrSmoothing')).toBe(true);
    }
  });
});

describe('unavailable browser storage', () => {
  it('reports a null storage backend once, keeps changes pending and never claims a save', () => {
    const failures: string[] = [];
    const off = onSaveFailure((what, err) => failures.push(`${what}: ${(err as Error).message}`));
    const s = new SettingsStore(null);
    expect(s.saveError).toBe('browser storage is unavailable');
    for (let i = 0; i < 20; i++) s.set('settings.nrAlpha', 100 + i); // e.g. a slider dragged every frame
    expect(s.flush()).toBe(false);
    expect(s.flush()).toBe(false);
    expect(s.pending).toBe(true);
    expect(s.saveError).toBe('browser storage is unavailable');
    expect(failures).toEqual(['settings: browser storage is unavailable']);
    off();
  });

  it('reports storage blocked by the browser once, retrying without repeating the report', () => {
    vi.useFakeTimers();
    try {
      const failures: string[] = [];
      const off = onSaveFailure((what) => failures.push(what));
      const denied = () => { throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' }); };
      const s = new SettingsStore({ getItem: denied, setItem: denied });
      s.set('settings.nrAlpha', 12);
      vi.advanceTimersByTime(300 + 5000 * 3);
      s.set('settings.nrAlpha', 13);
      expect(s.flush()).toBe(false);
      expect(s.pending).toBe(true);
      expect(s.saveError).toBe('browser storage is disabled for this site');
      expect(failures).toEqual(['settings']);
      off();
    } finally { vi.useRealTimers(); }
  });
});

describe('settings import validation', () => {
  const changed = () => {
    const s = new SettingsStore();
    s.set('settings.nrAlpha', 10); s.set('config.generalActiveFPS', 120); s.set('layerState.LightningOn', true);
    return s;
  };
  const untouched = (s: SettingsStore) => {
    expect(s.get('settings.nrAlpha')).toBe(10);
    expect(s.get('config.generalActiveFPS')).toBe(120);
    expect(s.get('layerState.LightningOn')).toBe(true);
  };

  it('rejects files that are not settings exports before changing anything', () => {
    const bad: [unknown, RegExp][] = [
      [{ COCatSLGT: { mode: 1 }, NHCCone: { mode: 2 } }, /no "values" object/], // a styles export
      [[{ name: 'OKC', view: {} }], /no "values" object/], // a viewpoints export
      [{ values: [] }, /no "values" object/], [{ values: null }, /no "values" object/], [null, /no "values" object/],
      [{ schema: 'other-app/settings@1', values: { 'settings.nrAlpha': 1 } }, /unsupported settings schema/],
      [{ schema: 'cwrv3/settings@3', doc: 'Nope', values: { 'settings.nrAlpha': 1 } }, /unknown settings document/],
      [{ schema: 'cwrv3/settings@3', values: { 'bogus.id': 1 } }, /no CWRV3 settings/],
      // A legacy layer-state key in a configuration export: nothing of the target, so no configuration reset.
      [{ schema: 'cwrv3/settings@3', doc: 'CWRV3ConfigurationSettings', values: { 'layerState.legacy.NWSConvectiveOutlooksShowHail': true } }, /no CWRV3 settings/],
      // Recognised IDs whose values are all invalid for their type or palette.
      [{ schema: 'cwrv3/settings@3', values: { 'settings.nrSmoothing': 'banana', 'config.generalActiveFPS': [1], 'settings.metarTempColorPalette': 'Missing' } }, /no CWRV3 settings/],
    ];
    for (const [doc, msg] of bad) {
      const s = changed();
      const events: string[] = [];
      s.on('', (id) => events.push(id));
      expect(() => s.importDocument(doc), JSON.stringify(doc)).toThrow(msg);
      untouched(s);
      expect(events).toEqual([]);
    }
  });

  it('imports one document without resetting the other two, ignoring records of other documents', () => {
    const src = new SettingsStore();
    src.set('settings.nrSmoothing', false);
    const doc = src.exportDocument(undefined, 'CWRV3Settings');
    doc.values['config.generalActiveFPS'] = 30; // a configuration record inside the main document
    const s = changed();
    const r = s.importDocument(doc);
    expect(r.ignored).toEqual(['config.generalActiveFPS']);
    expect(s.get('settings.nrSmoothing')).toBe(false);
    expect(s.get('settings.nrAlpha')).toBe(255); // within the imported document, missing → default
    expect(s.get('config.generalActiveFPS')).toBe(120);
    expect(s.get('layerState.LightningOn')).toBe(true);
  });

  it('reads earlier exports and partial documents without resetting what they leave out', () => {
    const s = changed();
    const legacy = { schema: 'wsv3-web/settings@2', doc: 'WSV3Settings', values: { 'settings.nrSmoothing': false, 'layerState.NWSConvectiveOutlooksTypeIdx': 5 } };
    const copy = structuredClone(legacy);
    expect(s.importDocument(legacy).applied).toBe(1);
    expect(legacy).toEqual(copy); // the caller's object is not changed by migration
    expect(s.get('settings.nrSmoothing')).toBe(false);
    expect(s.get('config.generalActiveFPS')).toBe(120);
    const all = changed();
    expect(all.importDocument({ values: { 'settings.nrSmoothing': false } }).applied).toBe(1); // no schema: partial
    untouched(all);
    const migrated = new SettingsStore();
    const outlook = { schema: 'wsv3-web/settings@2', values: { 'layerState.NWSConvectiveOutlooksTypeIdx': 5 } };
    migrated.importDocument(outlook);
    expect(migrated.get('layerState.NWSConvectiveOutlooksFamilyIdx')).toBe(2);
    expect(outlook.values).toEqual({ 'layerState.NWSConvectiveOutlooksTypeIdx': 5 });
  });
});

describe('legacy wsv3web.* migration', () => {
  const legacy = () => {
    const mem = new Mem();
    mem.setItem('wsv3web.WSV3Settings', JSON.stringify({ values: { 'settings.nrAlpha': 99 } }));
    mem.setItem('wsv3web.WSV3ConfigurationSettings', JSON.stringify({ values: { 'config.generalActiveFPS': 60, 'config.generalRestingFPSLoop': 50, 'config.generalRestingFPS': 20 } }));
    mem.setItem('wsv3web.ProductStatus', JSON.stringify({ values: { 'layerState.LightningOn': true } }));
    mem.setItem('wsv3web.viewpoints', JSON.stringify([{ name: 'OKC', view: { lon: -97.5, lat: 35.4, z: 10, tilt: 0, swivel: 0 } }]));
    mem.setItem('wsv3web.objectStyles', JSON.stringify({ COCatSLGT: { mode: 1 } }));
    mem.setItem('wsv3web.rgbRecipes', JSON.stringify([{ name: 'mine' }]));
    mem.setItem('unrelated', 'x');
    return mem;
  };

  it('moves every preference once, renaming the settings documents, then removes the old keys', () => {
    const mem = legacy();
    const moved = migrateLegacyStorage(mem);
    expect(moved.sort()).toEqual(['cwrv3.CWRV3ConfigurationSettings', 'cwrv3.CWRV3Settings', 'cwrv3.ProductStatus', 'cwrv3.objectStyles', 'cwrv3.rgbRecipes', 'cwrv3.viewpoints']);
    expect([...mem.m.keys()].filter((k) => k.startsWith('wsv3web.'))).toEqual([]);
    expect(mem.getItem('unrelated')).toBe('x');
    const s = new SettingsStore(mem);
    expect(s.get('settings.nrAlpha')).toBe(99);
    expect(s.get('layerState.LightningOn')).toBe(true);
    expect(s.get('config.generalRestingFPS')).toBe(20);
    // The old FPS defaults were written on first run and move to the new defaults.
    expect(s.get('config.generalActiveFPS')).toBe(0);
    expect(s.get('config.generalRestingFPSLoop')).toBe(0);
    useStorage(mem);
    expect(loadPref('viewpoints', [], Array.isArray)).toHaveLength(1);
    // A second start does nothing, even if an old key reappears.
    mem.setItem('wsv3web.viewpoints', '[]');
    expect(migrateLegacyStorage(mem)).toEqual([]);
    expect(loadPref('viewpoints', [], Array.isArray)).toHaveLength(1);
  });

  it('keeps a newer cwrv3 value and the legacy keys when a copy fails (retried next start)', () => {
    const mem = legacy();
    mem.setItem('cwrv3.viewpoints', '[]');
    mem.failWrites = true;
    expect(migrateLegacyStorage(mem)).toEqual([]);
    expect(mem.getItem('wsv3web.viewpoints')).not.toBeNull();
    mem.failWrites = false;
    migrateLegacyStorage(mem);
    expect(mem.getItem('cwrv3.viewpoints')).toBe('[]');
    expect(mem.getItem('wsv3web.viewpoints')).toBeNull();
  });
});

describe('preference helpers', () => {
  it('persist records through reload and reject mistyped stored fields', () => {
    const mem = new Mem();
    useStorage(mem);
    const a = prefObject('opts', { flash: true, count: 2 });
    a.flash = false;
    expect(JSON.parse(mem.getItem('cwrv3.opts')!)).toEqual({ flash: false, count: 2 });
    mem.setItem('cwrv3.opts', JSON.stringify({ flash: false, count: 'many' }));
    const b = prefObject('opts', { flash: true, count: 2 });
    expect(b).toEqual({ flash: false, count: 2 });
  });

  it('report a failed write instead of claiming success', () => {
    const mem = new Mem();
    useStorage(mem);
    mem.failWrites = true;
    const seen: string[] = [];
    const off = onSaveFailure((what) => seen.push(what));
    expect(savePref('viewpoints', [1], 'viewpoints')).toBe(false);
    expect(seen).toEqual(['viewpoints']);
    expect(loadPref('viewpoints', 'fallback')).toBe('fallback');
    off();
  });
});
