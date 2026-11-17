// Browser persistence for every user preference outside the settings catalog (styles, presets, recipes, tool
// options, lists). Values are small JSON documents in localStorage under the "cwrv3." prefix; large user files live
// in Cache Storage instead. A failed write is reported (onSaveFailure) and returned as false, never treated as saved.

export const PREFIX = 'cwrv3.';

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

/** Cache Storage names: user files (shapefiles, custom backgrounds) and downloaded public data. */
export const USER_FILES_CACHE = 'cwrv3-user-files';
export const DATA_CACHE = 'cwrv3-data-v1';

/** Stores a user file in Cache Storage under `key`; false (and a reported failure) when the browser rejects it. */
export async function storeUserFile(key: string, file: Blob, what: string): Promise<boolean> {
  try {
    await (await caches.open(USER_FILES_CACHE)).put(key, new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }));
    return true;
  } catch (err) { reportSaveFailure(`${what} (kept for this session only)`, err); return false; }
}
/** Object URL of a stored user file, or null when none is stored. */
export async function userFileUrl(key: string): Promise<string | null> {
  try {
    const hit = await (await caches.open(USER_FILES_CACHE)).match(key);
    return hit ? URL.createObjectURL(await hit.blob()) : null;
  } catch (err) { console.warn(`CWRV3: stored file ${key} could not be read`, err); return null; }
}
