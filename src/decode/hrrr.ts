// HRRR access by GRIB2 message using the public .idx inventory and HTTP Range requests.

export interface IdxEntry { n: number; start: number; end: number | null; date: string; variable: string; level: string; forecast: string }

export function parseIdx(text: string): IdxEntry[] {
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => l.split(':'));
  const out = rows.map((r) => ({ n: Number(r[0]), start: Number(r[1]), end: null as number | null, date: r[2], variable: r[3], level: r[4], forecast: r[5] }));
  // A message ends where the next line with a larger offset starts. Sub-messages (n.1, n.2: e.g. RAP U/V pairs)
  // share one offset, so a matched sub-message line spans the whole multi-field message.
  for (let i = 0; i < out.length; i++) {
    let j = i + 1;
    while (j < out.length && out[j].start <= out[i].start) j++;
    out[i].end = j < out.length ? out[j].start - 1 : null;
  }
  return out;
}

export function findIdx(entries: IdxEntry[], variable: string, level: string): IdxEntry | undefined {
  return entries.find((e) => e.variable === variable && e.level === level);
}

/** Fields used by the Basic surface layers and precipitation typing (products.catalog basic_layers). */
export const HRRR_FIELDS = {
  mslp: ['MSLMA', 'mean sea level'],
  u10: ['UGRD', '10 m above ground'],
  v10: ['VGRD', '10 m above ground'],
  t2m: ['TMP', '2 m above ground'],
  td2m: ['DPT', '2 m above ground'],
  sbcape: ['CAPE', 'surface'],
  mucape: ['CAPE', '255-0 mb above ground'],
  mlcape: ['CAPE', '90-0 mb above ground'],
  cpofp: ['CPOFP', 'surface'],
  crain: ['CRAIN', 'surface'],
  csnow: ['CSNOW', 'surface'],
  cicep: ['CICEP', 'surface'],
  cfrzr: ['CFRZR', 'surface'],
} as const;
export type HrrrField = keyof typeof HRRR_FIELDS;

export const hrrrUrl = (cycle: Date, fh = 0) => {
  const ymd = cycle.toISOString().slice(0, 10).replace(/-/g, '');
  const hh = String(cycle.getUTCHours()).padStart(2, '0');
  return `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${ymd}/conus/hrrr.t${hh}z.wrfsfcf${String(fh).padStart(2, '0')}.grib2`;
};

/** Inventory entries whose "variable:level[:forecast]" text contains the match (GRIB match strings). */
export function matchIdx(entries: IdxEntry[], match: string): IdxEntry[] {
  // Anchored at field boundaries so that "GRD:850 mb" cannot select UGRD/VGRD by accident.
  return entries.filter((e) => `:${e.variable}:${e.level}:${e.forecast}:`.includes(':' + match));
}
