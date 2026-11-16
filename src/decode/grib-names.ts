// Abbreviations for common GRIB2 parameters and fixed surfaces (WMO Code Tables 4.2 / 4.5 and NCEP local entries,
// public), used to write wgrib-style inventories of user-supplied GRIB2 files.
const PARAMS: Record<string, string> = {
  '0.0.0': 'TMP', '0.0.6': 'DPT', '0.0.4': 'TMAX', '0.0.5': 'TMIN', '0.1.1': 'RH', '0.1.0': 'SPFH', '0.1.3': 'PWAT', '0.1.8': 'APCP', '0.1.11': 'SNOD', '0.1.13': 'WEASD',
  '0.1.29': 'ASNOW', '0.2.0': 'WDIR', '0.2.1': 'WIND', '0.2.2': 'UGRD', '0.2.3': 'VGRD', '0.2.8': 'VVEL', '0.2.10': 'ABSV', '0.2.22': 'GUST', '0.3.0': 'PRES', '0.3.1': 'PRMSL',
  '0.3.5': 'HGT', '0.3.198': 'MSLMA', '0.6.1': 'TCDC', '0.7.6': 'CAPE', '0.7.7': 'CIN', '0.7.8': 'HLCY', '0.7.10': 'LFTX', '0.16.196': 'REFC', '0.16.195': 'REFD', '0.19.0': 'VIS',
};
export const paramName = (f: { discipline: number; category: number; number: number }) => PARAMS[`${f.discipline}.${f.category}.${f.number}`] ?? `var${f.discipline}_${f.category}_${f.number}`;
const SURF: Record<number, string> = { 1: 'surface', 10: 'entire atmosphere', 101: 'mean sea level', 200: 'entire atmosphere' };
export function levelName(t: number, v: number, t2: number, v2: number): string {
  if (t === 100) return `${v / 100} mb`;
  if (t === 103) return t2 === 103 ? `${v2}-${v} m above ground` : `${v} m above ground`;
  if (t === 108) return `${v / 100}-${v2 / 100} mb above ground`;
  if (t === 106) return `${v} m below ground`;
  return SURF[t] ?? `level ${t} ${v}`;
}
