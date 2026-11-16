import { describe, it, expect } from 'vitest';
import { parseCustomSites, parseVolumeIndex } from '../src/layers/custom-radar';

describe('custom radar parsing', () => {
  it('reads site lines and skips comments/bad rows', () => {
    const s = parseCustomSites('# name,state,place,lon,lat,elev\nkxyz, OK, Test Town, -97.5, 35.2, 1200\nbad,row\nKBAD,OK,X,-200,35,0\n');
    expect(s).toEqual([{ name: 'KXYZ', state: 'OK', place: 'Test Town', lon: -97.5, lat: 35.2, elev: 1200 }]);
  });
  it('reads Apache-style HTML and plain listings, sorted by time', () => {
    const html = '<a href="../">..</a><a href="KXYZ20260515_101500_V06">x</a> <a href="KXYZ20260515_100000_V06.gz">y</a><a href="index.html">i</a>';
    const v = parseVolumeIndex(html, 'https://example.org/radar/KXYZ/');
    expect(v.map((x) => x.name)).toEqual(['KXYZ20260515_100000_V06.gz', 'KXYZ20260515_101500_V06']);
    expect(v[1].url).toBe('https://example.org/radar/KXYZ/KXYZ20260515_101500_V06');
    expect(new Date(v[1].t).toISOString()).toBe('2026-05-15T10:15:00.000Z');
    const plain = parseVolumeIndex('123456 KXYZ20260515_102000_V06\n', 'https://example.org/r/KXYZ/');
    expect(plain).toHaveLength(1);
  });
  it('reads S3 ListObjects keys with full object URLs', () => {
    const xml = '<ListBucketResult><Contents><Key>2024/05/06/KTLX/KTLX20240506_220343_V06</Key></Contents></ListBucketResult>';
    const v = parseVolumeIndex(xml, 'https://bucket.example.com/?list-type=2&prefix=2024/05/06/KTLX/');
    expect(v[0].url).toBe('https://bucket.example.com/2024/05/06/KTLX/KTLX20240506_220343_V06');
  });
});

describe('custom radar products', () => {
  it('has a palette setting and menu entry for every Level 2 product, all of them real settings', async () => {
    const { CUSTOM_RADAR_PALETTE_KEYS, CUSTOM_RADAR_PRODUCT_COUNT } = await import('../src/layers/custom-radar');
    const { CUSTOM_RADAR_PRODUCTS, customRadarProductActions, customRadarExtraProducts } = await import('../src/ui/tool-forms');
    const { SETTINGS } = await import('../src/generated/settings-catalog');
    const { PRODUCTS } = await import('../src/generated/products-catalog');
    expect(CUSTOM_RADAR_PRODUCT_COUNT).toBe(PRODUCTS.level2.length);
    expect(CUSTOM_RADAR_PRODUCTS).toHaveLength(PRODUCTS.level2.length);
    for (const k of CUSTOM_RADAR_PALETTE_KEYS) expect(SETTINGS.some((s) => s.id === k), k).toBe(true);
    for (const k of ['ET', 'G2GShear', 'GUST', 'KDP', 'MEHS', 'POSH', 'Shear', 'VILD', 'VIL']) expect(CUSTOM_RADAR_PALETTE_KEYS).toContain(`settings.customRadarLevel2${k}Palette`);
    const def = SETTINGS.find((s) => s.id === 'layerState.CustomRadarProduct')!;
    expect(def.max).toBe(PRODUCTS.level2.length - 1);
    const acts = customRadarProductActions();
    for (const n of customRadarExtraProducts().filter((x) => x.caption !== '-')) expect(acts[n.name]?.run, n.name).toBeTypeOf('function');
  });
  it('picks a sweep by moment and angle, and the volume for volume products', async () => {
    const { customRadarSweep } = await import('../src/layers/custom-radar');
    const sweeps = [{ elevation: 0.5, moments: ['REF', 'ZDR', 'PHI', 'RHO'] }, { elevation: 0.5, moments: ['VEL', 'SW'] }, { elevation: 1.5, moments: ['REF', 'VEL'] }];
    expect(customRadarSweep(sweeps, 0, 0.5)).toBe(0);
    expect(customRadarSweep(sweeps, 1, 0.5)).toBe(1);
    expect(customRadarSweep(sweeps, 8, 0.5)).toBe(1); // shear from velocity
    expect(customRadarSweep(sweeps, 10, 0.5)).toBe(0); // KDP from PHI
    expect(customRadarSweep(sweeps, 13, 3.0)).toBe(0); // VIL: whole volume
    expect(customRadarSweep(sweeps, 3, 1.5)).toBe(-1);
  });
});
