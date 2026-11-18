// NEXRAD sources for an archive time: Level 3 products from the Unidata archive bucket (NOAA Open Data on AWS,
// since 2020-03-30) and storm attributes from the Iowa Environmental Mesonet where that bucket has no product.
import { listS3 } from '../data/net';
import type { L3File } from './sources';

export const AWS_L3 = 'https://unidata-nexrad-level3.s3.amazonaws.com';

/** Archive product codes of the overlay and storm-motion products; other products use their catalog AWIPS name. */
const OVERLAY_CODE: Record<string, string> = {
  '58sti': 'NST', p62ss: 'NSS', '61tvs': 'NTV', p59hi: 'NHI', '141md': 'NMD', '56rm0': 'N0S', '48vwp': 'NVW',
  '166m0': 'N0M', '166ma': 'NAM', '166m1': 'N1M', '166mb': 'NBM', '166m2': 'N2M', '166m3': 'N3M',
};
export const l3ArchiveCode = (ds: string, awips?: string): string | null => OVERLAY_CODE[ds] ?? awips ?? null;
/**
 * Archive codes to try for a product, in order. The digital base reflectivity (N?Q, product 94) and velocity (N?U, 99)
 * stop in the archive in 2022–23; their super-resolution successors (N?B, 153; N?G, 154) carry the same tilt and
 * quantity and are used, by name, where the original has no files.
 */
export function l3ArchiveCodes(ds: string, awips?: string): string[] {
  const code = l3ArchiveCode(ds, awips), m = /^N([0-3AB])([QU])$/.exec(code ?? '');
  return !code ? [] : m ? [code, `N${m[1]}${m[2] === 'Q' ? 'B' : 'G'}`] : [code];
}

/** "TLX_N0B_2024_05_06_22_03_20" → site, product code and time (the product's volume or cut time, UTC). */
export function parseL3Key(key: string): { site: string; code: string; t: number } | null {
  const m = /^([A-Z0-9]{3})_([A-Z0-9]{3})_(\d{4})_(\d\d)_(\d\d)_(\d\d)_(\d\d)_(\d\d)$/.exec(key);
  return m ? { site: m[1], code: m[2], t: Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7], +m[8]) } : null;
}

/** Day prefixes ("TLX_N0B_2024_05_06") covering [fromMs, toMs]. */
export function l3ArchivePrefixes(site: string, code: string, fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let day = Math.floor(fromMs / 86400e3) * 86400e3; day <= toMs; day += 86400e3) out.push(`${site.toUpperCase().slice(-3)}_${code}_${new Date(day).toISOString().slice(0, 10).replace(/-/g, '_')}`);
  return out;
}

/** Archived files of one product with a time in [fromMs, toMs], oldest first (empty when the archive has none). */
export async function listL3Archive(site: string, code: string, fromMs: number, toMs: number): Promise<L3File[]> {
  const out: L3File[] = [];
  for (const prefix of l3ArchivePrefixes(site, code, fromMs, toMs)) {
    const { objects } = await listS3(AWS_L3, prefix, { maxPages: 3 });
    for (const o of objects) { const k = parseL3Key(o.key); if (k && k.t >= fromMs && k.t <= toMs) out.push({ t: k.t, url: `${AWS_L3}/${o.key}`, name: o.key }); }
  }
  return out.sort((a, b) => a.t - b.t);
}

export const IEM_ATTR = 'https://mesonet.agron.iastate.edu/geojson/nexrad_attr.php';
export const iemAttrUrl = (t: number) => `${IEM_ATTR}?valid=${new Date(t).toISOString().slice(0, 19)}Z`;
/** The service refuses earlier times. */
export const IEM_ATTR_SINCE = Date.UTC(2000, 0, 1);

interface IemAttr { nexrad: string; storm_id: string; azimuth: number; range: number; tvs: string; meso: string; posh: number; poh: number; max_size: number; vil: number; max_dbz: number; top: number; drct: number; sknt: number; valid: string }
const pad = (v: number, n: number) => String(Math.round(v)).padStart(n);

/**
 * IEM storm attributes of one radar as the Level 3 products the overlays read (58sti cells, 61tvs, p59hi, 141md and
 * the p62ss table), one set per volume time found. The service returns each radar's volume nearest the requested
 * time, so every set carries its own `valid` time and is matched to a radar frame like a Level 3 product. The text
 * rows use the STI and storm-structure column layout (ID, AZ/RAN, then movement or base/top/VIL/max dBZ).
 */
export function iemStormProducts(gj: { features?: { properties: IemAttr }[] }, site: string): Map<string, { volumeTimeMs: number; [k: string]: unknown }>[] {
  const id = site.toUpperCase().slice(-3), byTime = new Map<number, IemAttr[]>();
  for (const f of gj.features ?? []) {
    const p = f.properties, t = Date.parse(p?.valid ?? '');
    if (p?.nexrad !== id || !Number.isFinite(t) || !Number.isFinite(p.azimuth) || !Number.isFinite(p.range)) continue;
    if (!byTime.has(t)) byTime.set(t, []);
    byTime.get(t)!.push(p);
  }
  return [...byTime].map(([volumeTimeMs, rows]) => {
    const at = (p: IemAttr) => { const km = p.range * 1.852, az = (p.azimuth * Math.PI) / 180; return { x: km * Math.sin(az), y: km * Math.cos(az) }; };
    const moving = (p: IemAttr) => Number.isFinite(p.drct) && Number.isFinite(p.sknt);
    return new Map<string, { volumeTimeMs: number; [k: string]: unknown }>([
      ['58sti', { volumeTimeMs, cells: rows.map((p) => ({ id: p.storm_id, ...at(p), past: [], forecast: [] })),
        pages: [rows.map((p) => `  ${p.storm_id}  ${pad(p.azimuth, 3)}/${pad(p.range, 3)}   ${moving(p) ? `${pad(p.drct, 3)}/${pad(p.sknt, 3)}` : '  NEW  '}`)] }],
      ['p62ss', { volumeTimeMs, pages: [rows.map((p) => `  ${p.storm_id}  ${pad(p.azimuth, 3)}/${pad(p.range, 3)}   0.0  ${(p.top || 0).toFixed(1)}  ${pad(p.vil || 0, 3)}  ${pad(p.max_dbz || 0, 3)}`)] }],
      ['61tvs', { volumeTimeMs, tvs: rows.filter((p) => p.tvs && p.tvs !== 'NONE').map(at), etvs: [] }],
      // The hail product's size is in quarter inches (the storm-cell table divides by four).
      ['p59hi', { volumeTimeMs, hail: rows.map((p) => ({ ...at(p), poh: p.poh || 0, posh: p.posh || 0, maxSizeIn: (p.max_size || 0) * 4 })) }],
      ['141md', { volumeTimeMs, features: rows.filter((p) => p.meso && p.meso !== 'NONE').map(at) }],
    ]);
  });
}
/** Overlay products the IEM attributes can stand in for. */
export const IEM_DS = ['58sti', 'p62ss', '61tvs', 'p59hi', '141md'];
