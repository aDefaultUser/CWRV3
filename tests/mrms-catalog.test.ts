// MRMS catalog against a recorded public bucket listing (tests/fixtures/mrms/conus-listing.xml: noaa-mrms-pds
// CONUS/ prefixes on 2026-11-17, trimmed of the 3-D merged levels above 0.50 km) and the setting catalog.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { listS3 } from '../src/data/net';
import { MRMS, MRMS_BUCKET, mrmsDir, mrmsRange, mrmsValueFactor } from '../src/sections/mrms';
import { XPRODUCTS } from '../src/generated/products-expanded';
import { SETTING_DEFS, PALETTE_SETTINGS } from '../src/settings/store';
import { hasPalette } from '../src/palettes/library';

afterEach(() => vi.unstubAllGlobals());

describe('MRMS catalog', () => {
  it('names product directories that exist in the public bucket', async () => {
    const xml = readFileSync('tests/fixtures/mrms/conus-listing.xml', 'utf8');
    vi.stubGlobal('fetch', async () => new Response(xml, { status: 200 }));
    const { prefixes } = await listS3(MRMS_BUCKET, 'CONUS/', { delimiter: '/' });
    expect(prefixes.length).toBeGreaterThan(100);
    for (const p of MRMS) {
      const dir = mrmsDir(p);
      expect(prefixes, p.label).toContain(`CONUS/${dir}/`);
      expect(p.prefix).toBe(`MRMS_${dir}_`);
      expect(p.s3).toBe(`${MRMS_BUCKET}/CONUS/${dir}/{YYYYMMDD}/MRMS_${dir}_{YYYYMMDD}-{HHMMSS}.grib2.gz`);
    }
  });

  it('keeps indices stable, categories in order and the product setting range in step', () => {
    MRMS.forEach((p, i) => expect(p.index).toBe(i));
    expect(SETTING_DEFS.get('layerState.MRMSProdIdx')!.max).toBe(MRMS.length - 1);
    expect([...new Set(MRMS.map((p) => p.category))]).toEqual([...XPRODUCTS.mrmsCategories]);
    for (const p of MRMS) expect(XPRODUCTS.mrmsCategories[p.categoryIndex], p.label).toBe(p.category);
  });

  it('gives every product an existing palette setting whose default palette exists', () => {
    for (const p of MRMS) {
      expect(PALETTE_SETTINGS.has(p.palette), `${p.label} → ${p.palette}`).toBe(true);
      expect(hasPalette(String(SETTING_DEFS.get(p.palette)!.default))).toBe(true);
    }
  });

  it('converts the added products from native units, with the same range in both display modes', () => {
    const byDir = (d: string) => MRMS.find((p) => mrmsDir(p) === d)!;
    expect(mrmsValueFactor(byDir('Model_0degC_Height_00.50'))).toBeCloseTo(3.28084); // m → ft
    expect(mrmsValueFactor(byDir('EchoTop_50_00.50'))).toBeCloseTo(3.28084); // km → kft
    expect(mrmsValueFactor(byDir('MultiSensor_QPE_72H_Pass2_00.00'))).toBeCloseTo(0.0393701); // mm → in
    expect(mrmsValueFactor(byDir('FLASH_QPE_FFGMAX_00.00'))).toBe(1);
    for (const p of MRMS.slice(32)) {
      const [a, b] = mrmsRange(p, false), [c, d] = mrmsRange(p, true);
      expect(c, p.label).toBeCloseTo(a, 3); expect(d, p.label).toBeCloseTo(b, 3);
    }
  });
});
