// Model configuration grammar, cycle selection and URL tokens; RRFS against recorded public inventories.
import { describe, it, expect } from 'vitest';
import { parseModelConfig, currentCycle, modelUrl, DEFAULT_CONFIGS } from '../src/sections/model-config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { parseIdx, matchIdx } from '../src/decode/hrrr';
import { decodeGrib2 } from '../src/decode/grib2';
import { gridMap } from '../src/gis/gridproj';

describe('model configuration grammar', () => {
  it('parses every shipped configuration without errors', () => {
    for (const [f, t] of Object.entries(DEFAULT_CONFIGS)) { const r = parseModelConfig(t, f); expect(r.errors, f).toEqual([]); expect(r.config!.products.length, f).toBeGreaterThan(3); }
  });
  it('reports each error path with line numbers', () => {
    const bad = 'Caption\n\nForecastTiming\n0,x,6\nCycleTiming\n0,30\nProjectionFile\nP.dat\nDimensions\n10,10\nDownloadURL\nftp://x/[HH]\nInventoryExt\n.idx\nParameters\n1,0,0,F';
    const r = parseModelConfig(bad, 'bad.config');
    expect(r.config).toBeNull();
    const all = r.errors.join('\n');
    expect(all).toMatch(/Caption not specified in bad\.config/);
    expect(all).toMatch(/Line 4 Error: "x" is not an integer/);
    expect(all).toMatch(/CycleTiming needs/);
    expect(all).toMatch(/DownloadURL must begin with http/);
    expect(all).toMatch(/exactly "Parameters:"/);
  });
  it('requires a forecast-hour token when there are several hours, decodes @ and clears contour flags', () => {
    const t = (url: string, p: string) => `Caption\nX\nForecastTiming\n0,1\nCycleTiming\n0,6,60\nProjectionFile\nP\nDimensions\n1,1\nDownloadURL\n${url}\nInventoryExt\n.idx\nParameters:\n${p}`;
    expect(parseModelConfig(t('https://h/f', '1,0,0,u,c,TMP:2 m'), 'a').errors[0]).toMatch(/\[F\]/);
    const r = parseModelConfig(t('https://h/f[FF]', '1,1,1,mph,Wind,surfacewind,UGRD:10 m@VGRD:10 m\n0,0,1,mb,P,PRMSL:mean sea level\n1,0,1,F,T,TMP:2 m'), 'a').config!;
    expect(r.products[0].match).toEqual(['UGRD:10 m', 'VGRD:10 m']);
    expect(r.products[0].contour).toBe(false);
    expect(r.products[1]).toMatchObject({ palette: '', contour: true });
    expect(r.products[2].contour).toBe(false);
    // An unknown palette name is a configuration error, never replaced by another palette.
    expect(parseModelConfig(t('https://h/f[FF]', '1,0,0,u,c,NoSuchPalette,TMP:2 m'), 'a').errors[0]).toMatch(/unknown palette "NoSuchPalette"/);
  });
});

describe('cycle and URL', () => {
  const c = { startHour: 0, cycleInterval: 6, minsToNewCycle: 240 };
  it('newest cycle whose availability time has passed', () => {
    expect(currentCycle(c, Date.UTC(2026, 10, 15, 9, 59))).toBe(Date.UTC(2026, 10, 15, 0));
    expect(currentCycle(c, Date.UTC(2026, 10, 15, 10, 0))).toBe(Date.UTC(2026, 10, 15, 6));
    expect(currentCycle(c, Date.UTC(2026, 10, 15, 10, 1))).toBe(Date.UTC(2026, 10, 15, 6));
    expect(currentCycle({ startHour: 3, cycleInterval: 6, minsToNewCycle: 80 }, Date.UTC(2026, 10, 15, 2))).toBe(Date.UTC(2026, 10, 14, 21));
  });
  it('fills date and forecast-hour tokens and the NCEP base', () => {
    const cfg = parseModelConfig(DEFAULT_CONFIGS['GFS025.config'], 'g').config!;
    expect(modelUrl(cfg, Date.UTC(2026, 10, 15, 6), 9, 1)).toBe('https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261115/06/atmos/gfs.t06z.pgrb2.0p25.f009');
    const nam = parseModelConfig(DEFAULT_CONFIGS['NAM.config'], 'n').config!;
    expect(modelUrl(nam, Date.UTC(2026, 10, 15, 12), 3, 2)).toBe('https://nomads.ncep.noaa.gov/pub/data/nccf/com/nam/prod/nam.20261115/nam.t12z.awphys03.tm00.grib2');
  });
});

describe('RRFS (noaa-rrfs-ops-pds)', () => {
  const cfg = (f: string) => parseModelConfig(DEFAULT_CONFIGS[f], f).config!;
  it('builds the 3 km CONUS file names of the bucket', () => {
    expect(modelUrl(cfg('RRFS.config'), Date.UTC(2026, 10, 17, 12), 12, 0)).toBe('https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.20261117/12/rrfs.t12z.2dfld.3km.f012.conus.grib2');
    expect(modelUrl(cfg('RRFSPressure.config'), Date.UTC(2026, 10, 17, 3), 7, 0)).toBe('https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.20261117/03/rrfs.t03z.prslev.3km.f007.conus.grib2');
    // 3-hourly runs to 18 h, 00/06/12/18 UTC runs to 84 h.
    expect(currentCycle(cfg('RRFS.config'), Date.UTC(2026, 10, 17, 14, 29))).toBe(Date.UTC(2026, 10, 17, 9));
    expect(currentCycle(cfg('RRFS.config'), Date.UTC(2026, 10, 17, 14, 30))).toBe(Date.UTC(2026, 10, 17, 12));
    expect(cfg('RRFS84Hr.config').hours.at(-1)).toBe(84);
    expect(currentCycle(cfg('RRFS84Hr.config'), Date.UTC(2026, 10, 17, 15, 29))).toBe(Date.UTC(2026, 10, 17, 6));
  });
  it('maps every product to a field of the recorded inventories', () => {
    for (const [f, idxFile] of [['RRFS.config', '2dfld'], ['RRFS84Hr.config', '2dfld'], ['RRFSPressure.config', 'prslev']]) {
      const idx = parseIdx(readFileSync(`tests/fixtures/rrfs/rrfs.t12z.${idxFile}.3km.f012.conus.grib2.idx`, 'utf8'));
      for (const p of cfg(f).products) for (const m of p.match) expect(matchIdx(idx, m).length, `${f} ${m}`).toBeGreaterThan(0);
    }
  });
  it('decodes the RRFS grid (Lambert 3.30 on the HRRR CONUS grid) and geolocates its corners', async () => {
    const bytes = new Uint8Array(readFileSync('tests/fixtures/rrfs/rrfs-cicep-f012.grib2'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('113931b78d96bed11899cf8535cb287f203a06137e3fe1d22a8ff00e329b3b70');
    const [f] = await decodeGrib2(bytes, async (b) => new Uint8Array(inflateSync(b)));
    expect(f.grid).toMatchObject({ kind: 'lambert', nx: 1799, ny: 1059, dx: 3000, dy: 3000, lov: 262.5, latin1: 38.5, latin2: 38.5, uvGrid: true });
    expect(f.refTimeMs + f.forecastMinutes * 60e3).toBe(Date.UTC(2026, 10, 18, 0));
    const m = gridMap(f.grid);
    const sw = m.inv(0, 0), ne = m.inv(1798, 1058);
    expect(sw[0]).toBeCloseTo(-122.7195, 3); expect(sw[1]).toBeCloseTo(21.1381, 3);
    expect(ne[0]).toBeCloseTo(-60.9172, 3); expect(ne[1]).toBeCloseTo(47.8422, 3);
    expect(f.values.every((v) => v === 0)).toBe(true);
  });
});
