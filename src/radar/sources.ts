// NEXRAD source indexes: Level 2 from TGFTP (2), AWS/NOAA Open Data (3) or a custom server (4);
// Level 3 from the TGFTP DS directories.
import { fetchText, listS3, parseDirIndex } from '../data/net';
import { PRODUCTS } from '../generated/products-catalog';

export const TGFTP_L2 = 'https://tgftp.nws.noaa.gov/data/radar/nexrad_level2/';
export const AWS_L2 = 'https://unidata-nexrad-level2.s3.amazonaws.com';
export const TGFTP_L3 = 'https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/';

export interface L2File { t: number; url: string; live: boolean; name: string; chunks?: string[] }

const tgftpTime = (d: string) => { // "15-Nov-2026 13:11"
  const m = /(\d+)-(\w{3})-(\d{4}) (\d{2}):(\d{2})/.exec(d);
  if (!m) return NaN;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[2]);
  return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5]);
};
const nameTime = (n: string) => {
  const m = /(\d{8})_?(\d{6})/.exec(n);
  return m ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)) : NaN;
};

/** Effective source after the original's rules: values other than 3/4 use TGFTP; 4 with an empty URL stores 2. */
export function effectiveSource(src: number, custom: string): 2 | 3 | 4 {
  if (src === 3) return 3;
  if (src === 4 && custom.trim()) return 4;
  return 2;
}

export async function listL2(site: string, source: 2 | 3 | 4, custom: string, sinceMs: number): Promise<L2File[]> {
  const S = site.toUpperCase();
  if (source === 2) {
    const items = parseDirIndex(await fetchText(`${TGFTP_L2}${S}/`));
    const files = items.filter((i) => /\.bz2$/.test(i.name)).map((i) => ({ t: nameTime(i.name), url: `${TGFTP_L2}${S}/${i.name}`, live: false, name: i.name, mod: tgftpTime(i.modified) }));
    files.sort((a, b) => a.t - b.t);
    // The newest TGFTP file is still being written: it is the live (partial) volume.
    if (files.length && Date.now() - files[files.length - 1].mod < 6 * 60e3) files[files.length - 1].live = true;
    return files.filter((f) => f.t >= sinceMs - 10 * 60e3);
  }
  if (source === 3) {
    const days = new Set<string>();
    for (let t = sinceMs - 86400e3 / 4; t <= Date.now(); t += 6 * 3600e3) days.add(new Date(t).toISOString().slice(0, 10).replace(/-/g, '/'));
    days.add(new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
    const out: L2File[] = [];
    for (const d of days) {
      const { objects } = await listS3(AWS_L2, `${d}/${S}/`, { maxPages: 2 });
      for (const o of objects) if (!/_MDM$/.test(o.key) && /_V\d\d$/.test(o.key)) out.push({ t: nameTime(o.key), url: `${AWS_L2}/${o.key}`, live: false, name: o.key.split('/').pop()! });
    }
    return out.filter((f) => f.t >= sinceMs - 10 * 60e3).sort((a, b) => a.t - b.t);
  }
  const base = custom.endsWith('/') ? custom : custom + '/';
  const txt = await fetchText(`${base}${S}/dir.list`);
  return txt.split('\n').map((l) => l.trim().split(/\s+/).pop() ?? '').filter((n) => /\d{8}_\d{6}/.test(n))
    .map((n) => ({ t: nameTime(n), url: `${base}${S}/${n}`, live: false, name: n })).filter((f) => f.t >= sinceMs - 10 * 60e3).sort((a, b) => a.t - b.t);
}

/**
 * Level 2 volumes to hold: the download budget fetches the newest `download` index volumes; volumes already held
 * stay while they are still listed, so the loop grows as new scans arrive; the newest `memory` of both are kept
 * (the live partial volume, when given, is the newest and counts towards both).
 */
export function l2Retention(index: L2File[], heldUrls: ReadonlySet<string>, download: number, memory: number, live: L2File | null = null): L2File[] {
  const complete = index.filter((f) => !f.live);
  const budget = Math.max(0, download - (live ? 1 : 0));
  const fetch = budget ? complete.slice(-budget) : [];
  const want = new Map<string, L2File>();
  for (const f of complete) if (heldUrls.has(f.url)) want.set(f.url, f);
  for (const f of fetch) want.set(f.url, f);
  const list = [...want.values()].sort((a, b) => a.t - b.t);
  if (live) list.push(live);
  return list.slice(-Math.max(1, memory));
}

export interface L3File { t: number; url: string; name: string }

export async function listL3(site: string, ds: string): Promise<L3File[]> {
  const base = `${TGFTP_L3}DS.${ds}/SI.${site.toLowerCase()}/`;
  const items = parseDirIndex(await fetchText(base));
  return items.filter((i) => /^sn\.\d{4}$/.test(i.name)).map((i) => ({ t: tgftpTime(i.modified), url: base + i.name, name: i.name })).filter((f) => f.t === f.t).sort((a, b) => a.t - b.t);
}

export const l3Last = (site: string, ds: string) => `${TGFTP_L3}DS.${ds}/SI.${site.toLowerCase()}/sn.last`;

export type L3Entry = (typeof PRODUCTS.level3)[number];
export const L3 = PRODUCTS.level3;
export const L2 = PRODUCTS.level2;

/** Display range of a Level 3 product (not traced in the original,; implementation choice). */
export function l3Range(p: L3Entry): { low: number; high: number; unit: string; scale: number } {
  switch (p.category) {
    case 'Velocity': return p.code === 56 ? { low: -100, high: 100, unit: 'kts', scale: 1 } : { low: -64, high: 64, unit: 'm/s', scale: 1 };
    case 'Spectrum Width': return { low: 0, high: 30, unit: 'kts', scale: 1 };
    case 'Precipitation': return [134, 57].includes(p.code) ? { low: 0, high: 80, unit: 'kg/m^2', scale: 1 } : { low: 0, high: 15, unit: 'in', scale: 1 };
    case 'Hydrometeor Classification': return { low: 0, high: 160, unit: '', scale: 1 };
    case 'Differential Reflectivity': return { low: -8, high: 8, unit: 'dBz', scale: 1 };
    case 'Correlation Coefficient': return { low: 20, high: 105, unit: '%', scale: 100 };
    case 'Specific Differential Phase': return { low: -2, high: 9, unit: '°/km', scale: 1 };
    default: return [135, 41].includes(p.code) ? { low: 0, high: 70, unit: 'kft', scale: 1 } : { low: -32, high: 95, unit: 'dBz', scale: 1 };
  }
}

/** Palette setting per Level 3 product. */
export function l3PaletteKey(p: L3Entry): string {
  if (p.category === 'Velocity') return p.code === 56 ? 'settings.nexradLevel3StormRelativeVelocityPalette' : 'settings.nexradLevel3BaseVelocityPalette';
  if (p.category === 'Spectrum Width') return 'settings.nexradLevel3SpectrumWidthPalette';
  if (p.category === 'Differential Reflectivity') return 'settings.nexradLevel3ZDRPalette';
  if (p.category === 'Correlation Coefficient') return 'settings.nexradLevel3CCPalette';
  if (p.category === 'Specific Differential Phase') return 'settings.nexradLevel3KDPPalette';
  if ([135, 41].includes(p.code)) return 'settings.nexradLevel3EchoTopsPalette';
  if ([134, 57].includes(p.code)) return 'settings.nexradLevel3VILPalette';
  if ([169, 170, 78].includes(p.code)) return 'settings.nexradLevel3PrecipPalette';
  if ([138, 172, 80, 79, 173, 174, 175].includes(p.code)) return 'settings.nexradLevel3StormTotalPrecipPalette';
  return 'settings.nexradLevel3ReflectivityPalette';
}

/** Level 2 palette setting by product index (catalog palette_setting). */
export const L2_PALETTE_KEYS = [
  'settings.nexradLevel2ReflectivityPalette', 'settings.nexradLevel2BaseVelocityPalette', 'settings.nexradLevel2SpectrumWidthPalette',
  'settings.nexradLevel2ZDRPalette', 'settings.nexradLevel2PHIPalette', 'settings.nexradLevel2CCPalette', 'settings.nexradLevel2BaseVelocityPalette',
  'settings.nexradLevel2StormRelativeVelocityPalette', 'settings.nexradLevel2ShearPalette', 'settings.nexradLevel2G2GShearPalette',
  'settings.nexradLevel2KDPPalette', 'settings.nexradLevel2MEHSPalette', 'settings.nexradLevel2POSHPalette', 'settings.nexradLevel2VILPalette',
  'settings.nexradLevel2VILDPalette', 'settings.nexradLevel2ETPalette', 'settings.nexradLevel2GUSTPalette',
  'ext.settings.nexradLevel2ColumnZDRPalette', 'ext.settings.nexradLevel2ColumnKDPPalette', 'ext.settings.nexradLevel2HailCorePalette',
];

/** Moment needed to pick the sweep for a Level 2 product (null for the volume products 11–19, which use every tilt). */
export function l2Moment(product: number): 'REF' | 'VEL' | 'SW' | 'ZDR' | 'PHI' | 'RHO' | null {
  return ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', 'VEL', 'VEL', 'VEL', 'VEL', 'PHI'][product] as never ?? null;
}
