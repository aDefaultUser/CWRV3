import { SETTINGS } from '../generated/settings-catalog';
import { applyPostLoad, migrateLegacyOutlook } from './postload';
import type { SettingDef } from './types';
import { PREFIX, browserStorage, describeStorageError, reportSaveFailure } from '../app/persist';
import { hasPalette } from '../palettes/library';

export const SETTINGS_SCHEMA = 'cwrv3/settings@3';

/** Settings documents: export/reset groups (earlier builds stored each as one localStorage key). */
export type DocName = 'CWRV3Settings' | 'CWRV3ConfigurationSettings' | 'ProductStatus';
const DOCS: DocName[] = ['CWRV3Settings', 'CWRV3ConfigurationSettings', 'ProductStatus'];

export const SETTING_DEFS: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((d) => [d.id, d]));

export function docOf(def: SettingDef): DocName | null {
  if (def.postLoad === 'derivedSiteIdx') return null; // derived at load, never stored
  if (def.legacy) return null; // read-only migration input, never written
  if (def.owner === 'LayerState') return 'ProductStatus';
  if (def.owner === 'TWSV3Settings' || def.owner === null) return 'CWRV3Settings';
  return 'CWRV3ConfigurationSettings';
}

/** Palette-name settings: string (or string list) settings whose defaults are palette names. */
export const PALETTE_SETTINGS: ReadonlySet<string> = new Set(SETTINGS.filter((d) =>
  (d.type === 'string' && typeof d.default === 'string' && d.default !== '' && hasPalette(d.default)) ||
  (d.type === 'string[]' && Array.isArray(d.default) && d.default.length > 0 && d.default.every((x) => hasPalette(String(x))))).map((d) => d.id));

/** False for a palette setting naming a palette that does not exist (the value is rejected, never substituted). */
function knownPalettes(def: SettingDef, v: unknown): boolean {
  if (!PALETTE_SETTINGS.has(def.id)) return true;
  return Array.isArray(v) ? v.every((x) => hasPalette(String(x))) : hasPalette(String(v));
}

function aggregateChildren(id: string): SettingDef[] {
  return SETTINGS.filter((d) => d.id.startsWith(id + '.'));
}

const byte = (v: unknown) => Math.min(255, Math.max(0, Math.round(Number(v) || 0)));
function clamp(def: SettingDef, v: number): number {
  if (def.min !== null && v < def.min) v = def.min;
  if (def.max !== null && v > def.max) v = def.max;
  return v;
}

/**
 * Coerces an arbitrary value into the def's type and enforces its range.
 * Returns undefined when the value cannot represent the type at all (the write is rejected).
 */
export function coerce(def: SettingDef, value: unknown): unknown {
  switch (def.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 0 || value === 1) return value === 1;
      if (value === 'true' || value === 'false') return value === 'true';
      return undefined;
    case 'integer': {
      if (value === null || value === '' || typeof value === 'boolean' || Array.isArray(value)) return undefined;
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return clamp(def, Math.round(n));
    }
    case 'number': {
      if (value === null || value === '' || typeof value === 'boolean' || Array.isArray(value)) return undefined;
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return clamp(def, n);
    }
    case 'string':
      return value === null || value === undefined || typeof value === 'object' ? undefined : String(value);
    case 'datetime':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') return value;
      return undefined;
    case 'color':
    case 'rgba': {
      const n = def.type === 'color' ? 3 : 4;
      const arr = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(arr) || arr.length < n || arr.slice(0, n).some((x) => !Number.isFinite(Number(x)))) return undefined;
      return arr.slice(0, n).map(byte);
    }
    case 'point':
    case 'point3': {
      const n = def.type === 'point' ? 2 : 4;
      if (!Array.isArray(value) || value.length < n || value.slice(0, n).some((x) => !Number.isFinite(Number(x)))) return undefined;
      return value.slice(0, n).map((x) => (def.type === 'point' ? Math.round(Number(x)) : Number(x)));
    }
    case 'string[]':
      return Array.isArray(value) ? value.map(String) : undefined;
    case 'aggregate':
      return undefined;
  }
}

type Listener = (id: string, value: unknown) => void;
/** A dialog's own edits: per setting it changed, the value before its first change and the value it last wrote. */
export type SettingEdits = Map<string, { before: unknown; after: unknown }>;

export interface SettingsDocument { schema: string; savedAt: string; doc?: DocName | 'all'; values: Record<string, unknown> }
export type KV = Pick<Storage, 'getItem' | 'setItem'>;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Export schemas this build reads: its own and the earlier "wsv3-web" builds (same IDs, older document names). */
const KNOWN_SCHEMA = /^(cwrv3|wsv3-web)\/settings@[1-3]$/;
const LEGACY_DOC_NAMES: Record<string, DocName> = { WSV3Settings: 'CWRV3Settings', WSV3ConfigurationSettings: 'CWRV3ConfigurationSettings' };
const UNAVAILABLE = 'browser storage is unavailable';

/**
 * Checks an imported settings document before anything changes: a plain `values` object, a known schema and
 * document name when given. Returns the target document (or 'all') and whether it is a complete export.
 */
export function validateSettingsDocument(doc: unknown): { values: Record<string, unknown>; target: DocName | 'all'; complete: boolean } {
  if (!isPlainObject(doc) || !isPlainObject(doc.values)) throw new Error('not a CWRV3 settings export (no "values" object)');
  const schema = doc.schema;
  if (schema !== undefined && (typeof schema !== 'string' || !KNOWN_SCHEMA.test(schema))) throw new Error(`unsupported settings schema ${JSON.stringify(schema)}`);
  const name = doc.doc ?? 'all';
  const target = typeof name === 'string' ? (name === 'all' || DOCS.includes(name as DocName) ? name as DocName | 'all' : LEGACY_DOC_NAMES[name]) : undefined;
  if (!target) throw new Error(`unknown settings document ${JSON.stringify(name)}`);
  return { values: doc.values, target, complete: schema !== undefined };
}

/** localStorage key of one setting's record (its JSON value). */
export const recordKey = (id: string) => `${PREFIX}setting/${id}`;
const legacyDocKey = (doc: DocName) => PREFIX + doc;

/**
 * Persistence: one localStorage record per setting (`cwrv3.setting/<id>` = JSON value). Each write is a single
 * setItem of one setting, so tabs changing different settings never overwrite each other, whatever the order of
 * their reads and writes; for the same setting the last durable write wins. The three whole-document keys of earlier
 * builds (`cwrv3.CWRV3Settings`, …) are a read-only fallback under the records: they are never written, so an old
 * snapshot cannot replace a newer record, and a reset writes the default as a record instead of deleting it.
 */
export class SettingsStore {
  private storage: KV | null;
  /** The browser denied storage: every change stays pending and saveError says why. */
  private readonly unavailable: boolean;
  private values = new Map<string, unknown>();
  private listeners = new Set<{ prefix: string; fn: Listener }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The pending timer is the slow retry after a failed write (a new change replaces it with the short delay). */
  private retryPending = false;
  /** IDs changed here and not yet durably written (another tab's write must not undo them). */
  private unsaved = new Set<string>();
  /** True when nothing of the configuration was stored at load (no record and no earlier document). */
  readonly firstRun: boolean;
  /** Last failed write, kept until every pending setting has been written. */
  saveError: string | null = null;
  /** Edits being recorded (see record). */
  private recording: SettingEdits | null = null;

  /**
   * `storage` is the browser's localStorage, null when the browser denies it (nothing can be saved; reported as
   * an error), or 'memory' for a deliberately unsaved store (tests, snapshots).
   */
  constructor(storage: KV | null | 'memory' = 'memory', private screenHeight?: number) {
    this.storage = storage === 'memory' ? null : storage;
    this.unavailable = storage === null;
    if (this.unavailable) this.fail(new Error(UNAVAILABLE)); // reported once; the app shows saveError at start-up
    for (const d of SETTINGS) if (d.type !== 'aggregate') this.values.set(d.id, structuredClone(d.default));
    let hadConfig = false;
    if (this.storage) {
      const legacy = this.readLegacyDocs();
      hadConfig = legacy.has('CWRV3ConfigurationSettings');
      for (const d of SETTINGS) {
        const doc = d.type === 'aggregate' ? null : docOf(d);
        if (!doc) continue;
        const v = this.readStored(d, legacy);
        if (v.found && doc === 'CWRV3ConfigurationSettings') hadConfig = true;
        if (v.value !== undefined) this.values.set(d.id, v.value);
      }
    }
    this.firstRun = !hadConfig;
    this.postLoad();
  }

  /** Stored → typed value: post-load rules act on the stored value before any range applies (|−4| = 4, not 0). */
  private normalize(def: SettingDef, v: unknown): unknown {
    const raw = def.postLoad && def.postLoad !== 'derivedSiteIdx' ? applyPostLoad(def.postLoad, v, { get: (id) => this.values.get(id), screenHeight: this.screenHeight }) : v;
    const c = coerce(def, raw);
    if (c !== undefined && !knownPalettes(def, c)) { console.warn(`settings: ${def.id} names an unknown palette (${JSON.stringify(c)}); value not applied`); return undefined; }
    return c;
  }

  /** Legacy convective-outlook keys migrate only when the modern family key is absent (expanded catalog). */
  private static migrateOutlook(values: Record<string, unknown>): Record<string, unknown> {
    const legacy = Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith('layerState.legacy.') || k === 'layerState.NWSConvectiveOutlooksTypeIdx'));
    if (!Object.keys(legacy).length || 'layerState.NWSConvectiveOutlooksFamilyIdx' in values) return values;
    const m = migrateLegacyOutlook(legacy);
    if (!m) return values;
    return { ...values, 'layerState.NWSConvectiveOutlooksFamilyIdx': m.family, ...(m.cig !== null ? { 'layerState.NWSConvectiveOutlooksCIGMode': m.cig } : {}) };
  }

  /** Values of the earlier whole-document keys (read-only fallback), per document present in storage. */
  private readLegacyDocs(only?: DocName): Map<DocName, Record<string, unknown>> {
    const docs = new Map<DocName, Record<string, unknown>>();
    for (const doc of only ? [only] : DOCS) {
      let raw: string | null = null;
      try { raw = this.storage?.getItem(legacyDocKey(doc)) ?? null; } catch (err) { console.error(`settings: ${doc} could not be read from browser storage`, err); }
      if (!raw) continue;
      try {
        const v = JSON.parse(raw)?.values;
        docs.set(doc, isPlainObject(v) ? SettingsStore.migrateOutlook(v) : {});
      } catch (err) {
        console.error(`settings: stored ${doc} could not be read; its values are not used`, err);
        docs.set(doc, {});
      }
    }
    return docs;
  }

  /**
   * The current durable value of one setting: its record, else the earlier document's value, else undefined (the
   * default applies). `found` is true when either exists, even if its value is rejected.
   */
  private readStored(def: SettingDef, legacy: Map<DocName, Record<string, unknown>>): { value: unknown; found: boolean } {
    let raw: string | null = null;
    try { raw = this.storage?.getItem(recordKey(def.id)) ?? null; } catch (err) { console.error(`settings: ${def.id} could not be read from browser storage`, err); }
    if (raw !== null) {
      try {
        const v = this.normalize(def, JSON.parse(raw));
        if (v !== undefined) return { value: v, found: true };
      } catch { /* unreadable record: fall back below */ }
      console.error(`settings: stored ${def.id} could not be read; the earlier document or the default is used`);
    }
    const values = legacy.get(docOf(def)!);
    if (values && def.id in values) return { value: this.normalize(def, values[def.id]), found: true };
    return { value: undefined, found: raw !== null };
  }

  /**
   * Another tab changed storage (storage event). `key` is the changed key, or null when storage was cleared. The
   * event's own value may be stale (events can arrive late or reordered), so the current stored value is read;
   * settings changed here and not yet written keep their local value.
   */
  applyExternal(key: string | null): void {
    const prefix = recordKey('');
    let ids: string[];
    if (key === null) ids = [...SETTING_DEFS.keys()];
    else if (key.startsWith(prefix)) ids = [key.slice(prefix.length)];
    else { const doc = DOCS.find((d) => key === legacyDocKey(d)); if (!doc) return; ids = SETTINGS.filter((d) => docOf(d) === doc).map((d) => d.id); }
    let legacy: Map<DocName, Record<string, unknown>> | null = null;
    let changed = false;
    for (const id of ids) {
      const def = SETTING_DEFS.get(id);
      if (!def || def.type === 'aggregate' || docOf(def) === null || this.unsaved.has(id)) continue;
      try {
        legacy ??= this.readLegacyDocs();
        const v = this.readStored(def, legacy).value ?? structuredClone(def.default);
        if (JSON.stringify(v) === JSON.stringify(this.values.get(id))) continue;
        this.values.set(id, v);
        this.emit(id, v);
        changed = true;
      } catch (err) { console.warn(`settings: ${id} from another tab could not be read`, err); }
    }
    if (changed) this.postLoad();
  }

  /** Applies every post-load rule. */
  postLoad(): void {
    const ctx = { get: (id: string) => this.values.get(id), screenHeight: this.screenHeight };
    for (const d of SETTINGS) {
      if (!d.postLoad || d.type === 'aggregate') continue;
      const before = this.values.get(d.id);
      const after = applyPostLoad(d.postLoad, before, ctx);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        const c = coerce(d, after);
        if (c !== undefined) { this.values.set(d.id, c); this.emit(d.id, c); }
      }
    }
  }

  has(id: string): boolean { return SETTING_DEFS.has(id); }

  get<T = unknown>(id: string): T {
    const def = SETTING_DEFS.get(id);
    if (!def) throw new Error(`unknown setting ${id}`);
    if (def.type === 'aggregate') {
      const o: Record<string, unknown> = {};
      for (const c of aggregateChildren(id)) o[c.id.slice(id.length + 1)] = this.values.get(c.id);
      return o as T;
    }
    return this.values.get(id) as T;
  }

  bool(id: string): boolean { return this.get<boolean>(id) === true; }
  num(id: string): number { return Number(this.get(id)); }
  str(id: string): string { return String(this.get(id) ?? ''); }
  arr<T = number>(id: string): T[] { return (this.get(id) as T[]) ?? []; }

  /** Sets a value with coercion and clamping. Returns the stored value. */
  set(id: string, value: unknown): unknown {
    const def = SETTING_DEFS.get(id);
    if (!def) throw new Error(`unknown setting ${id}`);
    if (def.type === 'aggregate') {
      if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (SETTING_DEFS.has(`${id}.${k}`)) this.set(`${id}.${k}`, v);
      return this.get(id);
    }
    const v = coerce(def, value);
    if (v === undefined) return this.values.get(id);
    if (!knownPalettes(def, v)) { console.warn(`settings: ${id} rejects unknown palette ${JSON.stringify(v)}`); return this.values.get(id); }
    const prev = this.values.get(id);
    if (JSON.stringify(prev) === JSON.stringify(v)) return prev;
    if (this.recording) this.recording.set(id, { before: this.recording.has(id) ? this.recording.get(id)!.before : prev, after: v });
    this.values.set(id, v);
    if (id === 'settings.nexradSiteICAO') this.postLoad(); // keeps the derived site index current
    this.emit(id, v);
    if (docOf(def)) { this.unsaved.add(id); this.scheduleSave(); }
    return v;
  }

  /**
   * Runs `fn`, one edit made through a dialog, recording into `edits` every setting it changes (including changes
   * its listeners make synchronously). Changes made outside such calls (other tabs, other panels) are not recorded.
   */
  record(edits: SettingEdits, fn: () => void): void {
    const outer = this.recording;
    this.recording = edits;
    try { fn(); } finally { this.recording = outer; }
  }

  /**
   * Cancel of a dialog: each recorded setting returns to its value before the dialog changed it, unless something
   * else (another tab, another panel) has changed it since; that later value is kept. The edits are then cleared.
   */
  revert(edits: SettingEdits): void {
    const outer = this.recording;
    this.recording = null; // the Cancel button itself runs as a dialog edit: its reverts are not new edits
    try {
      for (const [id, e] of [...edits]) if (JSON.stringify(this.values.get(id)) === JSON.stringify(e.after)) this.set(id, e.before);
      this.postLoad();
    } finally { this.recording = outer; edits.clear(); }
  }

  reset(id: string): void {
    const def = SETTING_DEFS.get(id);
    if (def && def.type !== 'aggregate') this.set(id, structuredClone(def.default));
  }

  /** Resets every value of one document (the reset handler clears the main settings document only). */
  resetDocument(doc: DocName): void {
    for (const d of SETTINGS) if (d.type !== 'aggregate' && docOf(d) === doc) this.reset(d.id);
    this.postLoad();
  }

  resetAll(): void {
    for (const d of SETTINGS) if (d.type !== 'aggregate') this.reset(d.id);
    this.postLoad();
  }

  /** Subscribes to changes of an exact ID or of every ID starting with `prefix`. */
  on(prefix: string, fn: Listener): () => void {
    const entry = { prefix, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  private emit(id: string, v: unknown) {
    for (const l of this.listeners) if (id === l.prefix || id.startsWith(l.prefix)) l.fn(id, v);
  }

  exportDocument(filter?: (def: SettingDef) => boolean, doc: DocName | 'all' = 'all'): SettingsDocument {
    const values: Record<string, unknown> = {};
    for (const d of SETTINGS) {
      if (d.type === 'aggregate' || docOf(d) === null) continue;
      if (doc !== 'all' && docOf(d) !== doc) continue;
      if (filter && !filter(d)) continue;
      values[d.id] = this.values.get(d.id);
    }
    return { schema: SETTINGS_SCHEMA, savedAt: new Date().toISOString(), doc, values };
  }

  /**
   * Imports a settings document with the same rules as loading from storage (legacy migration, post-load rules,
   * type coercion and ranges). Unknown or unrepresentable IDs are reported in `ignored`; IDs missing from the
   * document take defaults when resetMissing.
   */
  importDocument(doc: unknown, resetMissing = true): { applied: number; ignored: string[] } {
    const { values: raw, target, complete } = validateSettingsDocument(doc);
    const inTarget = (def: SettingDef) => docOf(def) !== null && (target === 'all' || docOf(def) === target);
    const values = SettingsStore.migrateOutlook(structuredClone(raw));
    // Everything is checked before the first change: an invalid document changes nothing.
    const accepted: [string, unknown][] = [], ignored: string[] = [];
    for (const [id, v] of Object.entries(values)) {
      const def = SETTING_DEFS.get(id);
      // Legacy outlook keys were consumed by the migration above (its result is checked like any value), but only
      // when their layer-state document is imported.
      if (def?.legacy && (target === 'all' || target === 'ProductStatus')) continue;
      const c = def && def.type !== 'aggregate' && inTarget(def) ? this.normalize(def, v) : undefined;
      if (c === undefined) ignored.push(id); else accepted.push([id, c]);
    }
    if (!accepted.length) throw new Error('the document contains no CWRV3 settings of this document with a valid value');
    // Only a complete export (with its schema) resets the settings it leaves out, and only within its own document.
    if (resetMissing && complete) for (const d of SETTINGS) if (d.type !== 'aggregate' && inTarget(d) && !(d.id in values)) this.reset(d.id);
    for (const [id, c] of accepted) this.set(id, c);
    this.postLoad();
    return { applied: accepted.length, ignored };
  }

  /** Layer state snapshot (layer presets and ProductStatus). */
  layerState(): Record<string, unknown> { return this.exportDocument(undefined, 'ProductStatus').values; }
  applyLayerState(values: Record<string, unknown>): void {
    for (const [id, v] of Object.entries(values)) { const d = SETTING_DEFS.get(id); if (d && docOf(d) === 'ProductStatus') this.set(id, v); }
    this.postLoad();
  }

  private scheduleSave() {
    if (!this.storage) { if (this.unavailable) this.fail(new Error(UNAVAILABLE)); return; }
    if (this.saveTimer && !this.retryPending) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.retryPending = false;
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }

  /** True while changes are waiting for (or failed) their write. */
  get pending(): boolean { return this.unsaved.size > 0; }

  /** Records a failed or impossible write; reported once per distinct reason, not on every retry or change. */
  private fail(err: unknown) {
    const msg = describeStorageError(err);
    if (this.saveError !== msg) reportSaveFailure('settings', err);
    this.saveError = msg;
  }

  /**
   * Writes every setting changed here now, synchronously (safe at pagehide): one setItem per setting, nothing read
   * or merged, so a concurrent write of another setting by another tab is never overwritten. A setting whose write
   * fails stays pending (retried after 5 s, on the next change or flush) and the failure is reported; returns false
   * when anything could not be written.
   */
  flush(): boolean {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.retryPending = false;
    if (!this.storage) {
      if (this.unavailable) this.fail(new Error(UNAVAILABLE));
      return this.unsaved.size === 0;
    }
    let ok = true;
    for (const id of [...this.unsaved]) {
      try {
        this.storage.setItem(recordKey(id), JSON.stringify(this.values.get(id)));
        this.unsaved.delete(id);
      } catch (err) {
        ok = false;
        this.fail(err);
      }
    }
    if (ok) this.saveError = null;
    else { this.saveTimer = setTimeout(() => this.flush(), 5000); this.retryPending = true; }
    return ok;
  }
}

// Outside a window (workers, tests) nothing is persisted; in a window, null storage means the browser denies it.
export const settings = new SettingsStore(typeof window === 'undefined' ? 'memory' : browserStorage(), typeof screen !== 'undefined' ? screen.height : undefined);

// Pending writes are flushed when the page is hidden or unloaded (reload, tab close, navigation), so a change made
// just before leaving is not lost to the write delay. Other tabs' writes arrive as storage events.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', () => settings.flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') settings.flush(); });
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key.startsWith(PREFIX)) settings.applyExternal(e.key);
  });
}
