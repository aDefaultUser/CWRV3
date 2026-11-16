// Model configuration grammar, cycle selection and URL tokens.
import { describe, it, expect } from 'vitest';
import { parseModelConfig, currentCycle, modelUrl, DEFAULT_CONFIGS } from '../src/sections/model-config';

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
