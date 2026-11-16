// Browser persistence for every user preference outside the settings catalog (styles, presets, recipes, tool
// options, lists). Values are small JSON documents in localStorage under the "cwrv3." prefix; large user files live
// in Cache Storage instead. Keys written by earlier builds ("wsv3web.") are migrated once, before any module reads
// its preferences. A failed write is reported (onSaveFailure) and returned as false, never treated as saved.

export const PREFIX = 'cwrv3.';
export const LEGACY_PREFIX = 'wsv3web.';
const MIGRATED = PREFIX + 'migratedFromWsv3web';

export type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { readonly length: number };

export function browserStorage(): KV | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

type FailureListener = (what: string, err: unknown) => void;
const failureListeners = new Set<FailureListener>();
/** Subscribes to failed preference writes (quota exceeded, storage disabled). */
export function onSaveFailure(fn: FailureListener): () => void { failureListeners.add(fn); return () => failureListeners.delete(fn); }
export function reportSaveFailure(what: string, err: unknown): void {
  console.error(`CWRV3: could not save ${what}`, err);
  for (const f of failureListeners) f(what, err);
}
export function describeStorageError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'browser storage is full';
  if (name === 'SecurityError') return 'browser storage is disabled for this site';
  return (err as Error)?.message ?? String(err);
}

let kv: KV | null = browserStorage();
/** Replaces the backing store (tests). */
export function useStorage(s: KV | null): void { kv = s; }

/**
 * Reads a preference. Missing, unparsable or rejected values (accept → false) return the fallback; a stored value
 * that cannot be read is logged, never silently replaced on disk.
 */
export function loadPref<T>(key: string, fallback: T, accept: (v: unknown) => boolean = () => true): T {
  let raw: string | null = null;
  try { raw = kv?.getItem(PREFIX + key) ?? null; } catch (err) { console.warn(`CWRV3: preference ${key} unreadable`, err); }
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    if (accept(v)) return v as T;
    console.warn(`CWRV3: stored preference ${key} has an unexpected shape; using defaults`);
  } catch (err) { console.warn(`CWRV3: stored preference ${key} is not valid JSON; using defaults`, err); }
  return fallback;
}

/** Writes a preference; returns false (and reports the failure) when the browser rejects the write. */
export function savePref(key: string, value: unknown, what = key): boolean {
  if (!kv) { reportSaveFailure(what, new Error('browser storage is unavailable')); return false; }
  try { kv.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch (err) { reportSaveFailure(what, err); return false; }
}

/** A persisted value: reads once, writes on every assignment. */
export function pref<T>(key: string, fallback: T, accept?: (v: unknown) => boolean): { value: T } {
  let v = loadPref(key, fallback, accept);
  return { get value() { return v; }, set value(x: T) { v = x; savePref(key, x); } };
}

/**
 * A persisted flat record: stored fields of the default's type override the defaults, and every property
 * assignment writes the record.
 */
export function prefObject<T extends Record<string, unknown>>(key: string, defaults: T): T {
  const stored = loadPref<Record<string, unknown>>(key, {}, isRecord);
  const v: Record<string, unknown> = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const d = defaults[k], s = stored[k];
    if (s !== undefined && typeof s === typeof d && Array.isArray(s) === Array.isArray(d) && (!Array.isArray(d) || (s as unknown[]).length === d.length)) v[k] = s;
  }
  return new Proxy(v, { set(o, k, val) { o[k as string] = val; savePref(key, o); return true; } }) as T;
}

export const isArray = (v: unknown) => Array.isArray(v);
export const isRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
export const isBool = (v: unknown) => typeof v === 'boolean';

/** Storage key of a settings document; legacy settings documents carried the original INI names. */
const LEGACY_KEYS: Record<string, string> = { WSV3Settings: 'CWRV3Settings', WSV3ConfigurationSettings: 'CWRV3ConfigurationSettings' };

/**
 * One-time migration of "wsv3web." keys. A key already present under the new prefix wins. Legacy keys are removed
 * only after every copy succeeded, so an interrupted or failed migration is retried on the next start. Earlier
 * builds wrote the whole configuration document on first run, so the old FPS defaults (60 active, 50 loop) are
 * indistinguishable from untouched values and move to the new default (unlimited, follow the target).
 */
export function migrateLegacyStorage(s: KV): string[] {
  try { if (s.getItem(MIGRATED)) return []; } catch (err) { console.error('CWRV3: browser storage is not readable; earlier preferences were not migrated', err); return []; }
  const legacy: string[] = [];
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(LEGACY_PREFIX)) legacy.push(k); }
  const moved: string[] = [];
  try {
    for (const k of legacy) {
      const name = k.slice(LEGACY_PREFIX.length);
      const target = PREFIX + (LEGACY_KEYS[name] ?? name);
      let value = s.getItem(k);
      if (value === null || s.getItem(target) !== null) continue;
      if (name === 'WSV3ConfigurationSettings') value = migrateFpsDefaults(value);
      s.setItem(target, value);
      moved.push(target);
    }
    s.setItem(MIGRATED, new Date().toISOString());
  } catch (err) {
    reportSaveFailure('preferences from the earlier version', err);
    return moved;
  }
  for (const k of legacy) s.removeItem(k);
  return moved;
}

function migrateFpsDefaults(raw: string): string {
  try {
    const doc = JSON.parse(raw) as { values?: Record<string, unknown> };
    const v = doc.values ?? {};
    if (v['config.generalActiveFPS'] === 60) v['config.generalActiveFPS'] = 0;
    if (v['config.generalRestingFPSLoop'] === 50) v['config.generalRestingFPSLoop'] = 0;
    return JSON.stringify(doc);
  } catch { return raw; } // unparsable documents are copied as-is; the settings loader reports them
}

if (kv) migrateLegacyStorage(kv);

/** Cache Storage names: user files (shapefiles, custom backgrounds) and downloaded public data. */
export const USER_FILES_CACHE = 'cwrv3-user-files';
export const DATA_CACHE = 'cwrv3-data-v1';

/** Stores a user file in Cache Storage under `key`; false (and a reported failure) when the browser rejects it. */
export async function storeUserFile(key: string, file: Blob, what: string): Promise<boolean> {
  try {
    await cachesReady;
    await (await caches.open(USER_FILES_CACHE)).put(key, new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }));
    return true;
  } catch (err) { reportSaveFailure(`${what} (kept for this session only)`, err); return false; }
}
/** Object URL of a stored user file, or null when none is stored. */
export async function userFileUrl(key: string): Promise<string | null> {
  try {
    await cachesReady;
    const hit = await (await caches.open(USER_FILES_CACHE)).match(key);
    return hit ? URL.createObjectURL(await hit.blob()) : null;
  } catch (err) { console.warn(`CWRV3: stored file ${key} could not be read`, err); return null; }
}

/**
 * Moves user files from the earlier cache name once (copy, then delete the old cache only when every copy
 * succeeded). The old downloaded-data cache is dropped: its contents are re-downloadable public data.
 * Every Cache Storage user awaits this before opening a cache.
 */
export const cachesReady: Promise<void> = (async () => {
  // Window context only: workers share Cache Storage and must not race the migration.
  if (typeof caches === 'undefined' || typeof window === 'undefined') return;
  try {
    if (await caches.has('wsv3-user-files')) {
      const from = await caches.open('wsv3-user-files'), to = await caches.open(USER_FILES_CACHE);
      for (const req of await from.keys()) {
        if (await to.match(req)) continue;
        const res = await from.match(req);
        if (res) await to.put(req, res);
      }
      await caches.delete('wsv3-user-files');
    }
    await caches.delete('wsv3-data-v1');
  } catch (err) {
    reportSaveFailure('user files from the earlier version (they stay in the old cache and are retried next start)', err);
  }
})();
