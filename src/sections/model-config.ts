// Model configuration files. The vendor's twelve configurations are installer-delivered and
// unknown; CWRV3 ships its own, written in the same grammar from the public NCEP/NOAA Open Data
// inventories. URL tokens (CWRV3 choice): [YYYY] [MM] [DD] [HH] cycle date/hour,
// [F] [FF] [FFF] forecast hour zero-padded to 1/2/3 digits. URLs starting with "com/" are relative to the NCEP
// base chosen by settings.modelDataSource (0 ftp.ncep, 1 ftpprd.ncep, 2 nomads).
import { hasPalette } from '../palettes/library';

export interface ModelProduct { fill: boolean; vector: boolean; contour: boolean; unit: string; caption: string; palette: string; match: string[] }
export interface ModelConfig {
  caption: string; file: string; hours: number[]; startHour: number; cycleInterval: number; minsToNewCycle: number;
  projFile: string; dims: [number, number]; url: string; invExt: string; products: ModelProduct[]; note?: string;
}

const SECTIONS = ['Caption', 'ForecastTiming', 'CycleTiming', 'ProjectionFile', 'Dimensions', 'DownloadURL', 'InventoryExt', 'Parameters:'] as const;

/** Parses one configuration; errors use the original's "Line n Error: … in <file>" form. */
export function parseModelConfig(text: string, file: string): { config: ModelConfig | null; errors: string[] } {
  const errors: string[] = [];
  const err = (line: number, msg: string) => errors.push(`Line ${line} Error: ${msg} in ${file}`);
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l, i) => ({ n: i + 1, t: l.trim() })).filter((l) => l.t && !l.t.startsWith(';'));
  const values = new Map<string, { n: number; t: string }[]>();
  let cur: string | null = null, order = 0;
  for (const l of lines) {
    const sec = SECTIONS.find((s) => s === l.t);
    if (sec) {
      const idx = SECTIONS.indexOf(sec);
      if (idx < order) err(l.n, `section ${sec} out of order`);
      order = idx; cur = sec; values.set(sec, []);
      continue;
    }
    if (l.t.startsWith('Parameters')) { err(l.n, 'the line must be exactly "Parameters:"'); cur = null; continue; }
    if (!cur) { err(l.n, `unexpected text "${l.t.slice(0, 40)}"`); continue; }
    values.get(cur)!.push(l);
  }
  const first = (s: string) => values.get(s)?.[0];
  const ints = (s: string, line: number) => s.split(',').map((x) => x.trim()).map((x) => { const n = Number(x); if (x === '' || !Number.isInteger(n)) err(line, `"${x}" is not an integer`); return n; });
  const cap = first('Caption');
  if (!cap?.t) err(cap?.n ?? 1, 'Caption not specified');
  const ft = first('ForecastTiming');
  const hours = ft ? ints(ft.t, ft.n) : [];
  if (!ft || !hours.length) err(ft?.n ?? 1, 'ForecastTiming not specified');
  const ct = first('CycleTiming');
  const cyc = ct ? ints(ct.t, ct.n) : [];
  if (!ct || cyc.length < 3) err(ct?.n ?? 1, 'CycleTiming needs start hour, cycle interval and minutes to new cycle');
  else {
    if (cyc[0] < 0 || cyc[0] > 24) err(ct.n, 'cycle start hour must be 0..24');
    if (cyc[1] < 1 || cyc[1] > 24) err(ct.n, 'cycle interval must be 1..24 hours');
  }
  const pf = first('ProjectionFile');
  if (!pf?.t) err(pf?.n ?? 1, 'ProjectionFile not specified');
  const dm = first('Dimensions');
  const dims = dm ? ints(dm.t, dm.n) : [];
  if (!dm || dims.length < 2) err(dm?.n ?? 1, 'Dimensions must be nx,ny');
  const du = first('DownloadURL');
  if (!du || !(/^https?:\/\//.test(du.t) || du.t.startsWith('com/'))) err(du?.n ?? 1, 'DownloadURL must begin with http:// or https://');
  else if (hours.length > 1 && !/\[F{1,3}\]/.test(du.t)) err(du.n, 'DownloadURL must contain [F], [FF] or [FFF] when ForecastTiming has more than one hour');
  const ie = first('InventoryExt');
  if (!ie?.t) err(ie?.n ?? 1, 'InventoryExt not specified');
  const products: ModelProduct[] = [];
  for (const l of values.get('Parameters:') ?? []) {
    const f = l.t.split(',');
    if (f.length < 6) { err(l.n, 'parameter needs fill,vector,contour,unit,caption[,palette],gribMatch'); continue; }
    const palette = f.length >= 7 ? f[5].trim() : '';
    if (palette && !hasPalette(palette)) err(l.n, `unknown palette "${palette}" (load it with "Load color palette files" first)`);
    const match = f.slice(f.length >= 7 ? 6 : 5).join(',').replace(/@/g, ',').split(',').map((x) => x.trim()).filter(Boolean);
    const m0 = match.join(',');
    // Contours only for sea-level pressure and isobaric heights.
    const contourOk = /MSL/.test(m0) || (/HGT:/.test(m0) && /mb/.test(m0));
    products.push({ fill: f[0].trim() !== '0', vector: f[1].trim() !== '0', contour: f[2].trim() !== '0' && contourOk, unit: f[3].trim(), caption: f[4].trim(), palette, match });
  }
  if (!values.has('Parameters:')) err(lines.length ? lines[lines.length - 1].n : 1, 'Parameters: section missing');
  if (errors.length) return { config: null, errors };
  return { config: { caption: cap!.t, file, hours, startHour: cyc[0], cycleInterval: cyc[1], minsToNewCycle: cyc[2], projFile: pf!.t, dims: [dims[0], dims[1]], url: du!.t, invExt: ie!.t, products }, errors };
}

/** Newest available cycle: StartHour + k × CycleInterval whose time + MinsToNewCycle ≤ now (UTC). */
export function currentCycle(c: Pick<ModelConfig, 'startHour' | 'cycleInterval' | 'minsToNewCycle'>, nowMs: number): number {
  const day = Math.floor(nowMs / 86400e3) * 86400e3;
  let best = -Infinity;
  for (let d = day - 86400e3; d <= day; d += 86400e3) for (let h = c.startHour; h < 24 + c.startHour; h += c.cycleInterval) {
    const t = d + (h % 24) * 3600e3 + (h >= 24 ? 86400e3 : 0);
    if (t + c.minsToNewCycle * 60e3 <= nowMs && t > best) best = t;
  }
  return best;
}

export const NCEP_BASES = ['https://ftp.ncep.noaa.gov/data/nccf/', 'https://ftpprd.ncep.noaa.gov/data/nccf/', 'https://nomads.ncep.noaa.gov/pub/data/nccf/'];
export function modelUrl(c: ModelConfig, cycleMs: number, hour: number, base: number): string {
  const d = new Date(cycleMs);
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  const url = c.url.startsWith('com/') ? NCEP_BASES[base] + c.url : c.url;
  return url.replace(/\[YYYY\]/g, String(d.getUTCFullYear())).replace(/\[MM\]/g, p(d.getUTCMonth() + 1, 2)).replace(/\[DD\]/g, p(d.getUTCDate(), 2)).replace(/\[HH\]/g, p(d.getUTCHours(), 2))
    .replace(/\[FFF\]/g, p(hour, 3)).replace(/\[FF\]/g, p(hour, 2)).replace(/\[F\]/g, String(hour));
}

const range = (a: number, b: number, s: number) => { const o: number[] = []; for (let h = a; h <= b; h += s) o.push(h); return o.join(','); };
const SURFACE = (msl: string, apcp: boolean) => `Parameters:
1,0,0,°F,2 m Temperature,M_2MTGLOBAL,TMP:2 m above ground
1,0,0,°F,2 m Dew Point,M_2MD,DPT:2 m above ground
1,1,0,mph,10 m Wind,surfacewind,UGRD:10 m above ground@VGRD:10 m above ground
1,0,0,mph,Wind Gust,surfacewind,GUST:surface
1,0,1,mb,Mean Sea Level Pressure,,${msl}:mean sea level
1,0,0,dBZ,Composite Reflectivity,DefaultBR3,REFC:entire atmosphere
1,0,0,J/kg,Surface CAPE,M_CAPE,CAPE:surface
1,0,0,J/kg,Surface CIN,M_CI,CIN:surface
1,0,0,m²/s²,0-3 km Storm-Relative Helicity,M_SRH,HLCY:3000-0 m above ground
1,0,0,in,Precipitable Water,DefaultPrecip,PWAT:entire atmosphere (considered as a single layer)
${apcp ? '1,0,0,in,Total Precipitation,DefaultPrecip,APCP:surface:0-\n' : ''}1,0,0,in,Snow Depth,SnowDepth,SNOD:surface
0,0,1,dam,500 mb Height,,HGT:500 mb
1,1,0,mph,250 mb Wind,UpperLevelWinds,UGRD:250 mb@VGRD:250 mb`;

/** Public replacement configurations. */
export const DEFAULT_CONFIGS: Record<string, string> = {
  'HRRR.config': `; HRRR 3 km CONUS, NOAA Open Data (noaa-hrrr-bdp-pds), surface file.
Caption
HRRR
ForecastTiming
${range(0, 18, 1)}
CycleTiming
0,1,55
ProjectionFile
HRRRProjection2.dat
Dimensions
1799,1059
DownloadURL
https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.[YYYY][MM][DD]/conus/hrrr.t[HH]z.wrfsfcf[FF].grib2
InventoryExt
.idx
${SURFACE('MSLMA', true)}
1,0,0,mi,Visibility,M_VIS,VIS:surface
1,0,0,%,Total Cloud Cover,M_PCT,TCDC:entire atmosphere`,
  'HRRR48Hr.config': `; HRRR extended runs (00/06/12/18 UTC) to 48 h.
Caption
HRRR 48 hour
ForecastTiming
${range(0, 48, 1)}
CycleTiming
0,6,80
ProjectionFile
HRRRProjection2.dat
Dimensions
1799,1059
DownloadURL
https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.[YYYY][MM][DD]/conus/hrrr.t[HH]z.wrfsfcf[FF].grib2
InventoryExt
.idx
${SURFACE('MSLMA', true)}`,
  'RAP.config': `; RAP 13 km (awp130), NOAA Open Data (noaa-rap-pds).
Caption
RAP
ForecastTiming
${range(0, 21, 1)}
CycleTiming
0,1,50
ProjectionFile
RAP13KMProjection.dat
Dimensions
451,337
DownloadURL
https://noaa-rap-pds.s3.amazonaws.com/rap.[YYYY][MM][DD]/rap.t[HH]z.awp130pgrbf[FF].grib2
InventoryExt
.idx
${SURFACE('MSLMA', true)}
1,0,0,%,700 mb Relative Humidity,RelativeHumidity,RH:700 mb
1,0,0,°F,850 mb Temperature,M_2MTGLOBAL,TMP:850 mb`,
  'RAP51Hr.config': `; RAP extended runs (03/09/15/21 UTC) to 51 h.
Caption
RAP 51 hour
ForecastTiming
${range(0, 51, 1)}
CycleTiming
3,6,80
ProjectionFile
RAP13KMProjection.dat
Dimensions
451,337
DownloadURL
https://noaa-rap-pds.s3.amazonaws.com/rap.[YYYY][MM][DD]/rap.t[HH]z.awp130pgrbf[FF].grib2
InventoryExt
.idx
${SURFACE('MSLMA', true)}`,
  'GFS.config': `; GFS 1.0 degree global, NOAA Open Data (noaa-gfs-bdp-pds).
Caption
GFS
ForecastTiming
${range(0, 120, 3)},${range(132, 384, 12)}
CycleTiming
0,6,240
ProjectionFile
GFSProjection.dat
Dimensions
360,181
DownloadURL
https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.[YYYY][MM][DD]/[HH]/atmos/gfs.t[HH]z.pgrb2.1p00.f[FFF]
InventoryExt
.idx
${SURFACE('PRMSL', false)}`,
  'GFS025.config': `; GFS 0.25 degree global, NOAA Open Data (noaa-gfs-bdp-pds).
Caption
GFS 0.25
ForecastTiming
${range(0, 120, 3)},${range(126, 240, 6)}
CycleTiming
0,6,240
ProjectionFile
GFS025Projection.dat
Dimensions
1440,721
DownloadURL
https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.[YYYY][MM][DD]/[HH]/atmos/gfs.t[HH]z.pgrb2.0p25.f[FFF]
InventoryExt
.idx
${SURFACE('PRMSL', false)}`,
  'NBM.config': `; National Blend of Models CONUS core, NOAA Open Data (noaa-nbm-grib2-pds).
Caption
NBM
ForecastTiming
${range(1, 36, 1)},${range(39, 72, 3)}
CycleTiming
0,1,70
ProjectionFile
NBMCONUSProjection.dat
Dimensions
2345,1597
DownloadURL
https://noaa-nbm-grib2-pds.s3.amazonaws.com/blend.[YYYY][MM][DD]/[HH]/core/blend.t[HH]z.core.f[FFF].co.grib2
InventoryExt
.idx
Parameters:
1,0,0,°F,2 m Temperature,M_2MTGLOBAL,TMP:2 m above ground
1,0,0,°F,2 m Dew Point,M_2MD,DPT:2 m above ground
1,0,0,mph,10 m Wind Speed,surfacewind,WIND:10 m above ground
1,0,0,mph,10 m Wind Gust,surfacewind,GUST:10 m above ground
1,0,0,%,Sky Cover,M_PCT,TCDC:surface
1,0,0,in,1-hour Precipitation,Default1HrPrecip,APCP:surface
1,0,0,in,Snow Depth,SnowDepth,SNOD:surface
1,0,0,mi,Visibility,M_VIS,VIS:surface`,
  // Currently unavailable from public servers when these configurations were written (2026-11-15): kept with
  // their NCEP paths so that they work if the products return; the loader reports the HTTP error instead of
  // substituting another model.
  'NAM.config': `; NAM 12 km (awphys). Public status 2026-11-15: NOMADS com/nam/prod answers 404 and the noaa-nam-pds
; bucket ends on 2026-11-03 — the loader reports unavailable rather than substituting another model.
Caption
NAM
ForecastTiming
${range(0, 84, 3)}
CycleTiming
0,6,110
ProjectionFile
NAMCONUSProjection.dat
Dimensions
614,428
DownloadURL
com/nam/prod/nam.[YYYY][MM][DD]/nam.t[HH]z.awphys[FF].tm00.grib2
InventoryExt
.idx
${SURFACE('MSLET', true)}`,
  'NAM3K.config': `; NAM 3 km CONUS nest. Public status 2026-11-15: currently unavailable (NOMADS NAM files answer 404).
Caption
NAM 3km
ForecastTiming
${range(0, 60, 1)}
CycleTiming
0,6,110
ProjectionFile
NAMCONUSProjection.dat
Dimensions
1799,1059
DownloadURL
com/nam/prod/nam.[YYYY][MM][DD]/nam.t[HH]z.conusnest.hiresf[FF].tm00.grib2
InventoryExt
.idx
${SURFACE('MSLET', true)}`,
  'HiresWRF-ARW.config': `; HiresW ARW 5 km CONUS. Public status 2026-11-15: NOMADS hiresw files answer 404.
Caption
HiresW ARW
ForecastTiming
${range(0, 48, 1)}
CycleTiming
0,12,180
ProjectionFile
HiresWRFProjection.dat
Dimensions
1155,723
DownloadURL
com/hiresw/prod/hiresw.[YYYY][MM][DD]/hiresw.t[HH]z.arw_5km.f[FF].conus.grib2
InventoryExt
.idx
${SURFACE('PRMSL', true)}`,
  'HiresFV3.config': `; HiresW FV3 5 km CONUS. Public status 2026-11-15: NOMADS hiresw files answer 404.
Caption
HiresW FV3
ForecastTiming
${range(0, 60, 1)}
CycleTiming
0,12,180
ProjectionFile
HiresWRFProjection.dat
Dimensions
1155,723
DownloadURL
com/hiresw/prod/hiresw.[YYYY][MM][DD]/hiresw.t[HH]z.fv3_5km.f[FF].conus.grib2
InventoryExt
.idx
${SURFACE('PRMSL', true)}`,
  'HiresWRF-NMMB.config': `; HiresW NMMB. Public status 2026-11-15: currently unavailable (no NMMB files on NOMADS); listed so the model family is visible and
; reported as unavailable, never substituted.
Caption
HiresW NMMB
ForecastTiming
${range(0, 48, 1)}
CycleTiming
0,12,180
ProjectionFile
HiresWRFProjection.dat
Dimensions
1155,723
DownloadURL
com/hiresw/prod/hiresw.[YYYY][MM][DD]/hiresw.t[HH]z.nmmb_5km.f[FF].conus.grib2
InventoryExt
.idx
${SURFACE('PRMSL', true)}`,
};
