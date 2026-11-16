import { describe, expect, it } from 'vitest';
import { paletteNames, getPalette, hasPalette } from '../src/palettes/library';
import { paletteRange } from '../src/render/palette';
import { SettingsStore, PALETTE_SETTINGS, SETTING_DEFS } from '../src/settings/store';
import { DEFAULT_CONFIGS, parseModelConfig } from '../src/sections/model-config';

describe('palette library', () => {
  it('parses every selectable palette with ascending stops and a non-empty range', () => {
    const names = paletteNames();
    expect(names.length).toBeGreaterThanOrEqual(159);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      const p = getPalette(n);
      for (const f of p.frames) for (let i = 1; i < f.length; i++) expect(f[i].v, `${n} stop ${i}`).toBeGreaterThanOrEqual(f[i - 1].v);
      const [lo, hi] = paletteRange(p);
      expect(hi, n).toBeGreaterThan(lo);
    }
  });

  it('has every palette that a setting default or a shipped model configuration names', () => {
    expect(PALETTE_SETTINGS.size).toBeGreaterThan(80);
    for (const id of PALETTE_SETTINGS) for (const n of [SETTING_DEFS.get(id)!.default].flat()) expect(hasPalette(String(n)), `${id} → ${n}`).toBe(true);
    for (const [file, text] of Object.entries(DEFAULT_CONFIGS)) {
      for (const p of parseModelConfig(text, file).config?.products ?? []) if (p.palette) expect(hasPalette(p.palette), `${file} → ${p.palette}`).toBe(true);
    }
  });

  it('never substitutes an unknown palette name', () => {
    expect(() => getPalette('NoSuchPalette')).toThrow(/unknown palette/);
    const s = new SettingsStore();
    s.set('settings.lightningRenderingPalette', 'NoSuchPalette');
    expect(s.get('settings.lightningRenderingPalette')).toBe('GLMStrikes25min');
    s.set('settings.lightningRenderingPalette', 'GLMStrikes10min');
    expect(s.get('settings.lightningRenderingPalette')).toBe('GLMStrikes10min');
    const r = s.importDocument({ values: { 'settings.metarTempColorPalette': 'Missing', 'settings.goesBandPals': ['GOESRBand1', 'Missing'], 'settings.nrAlpha': 9 } }, false);
    expect(r.ignored.sort()).toEqual(['settings.goesBandPals', 'settings.metarTempColorPalette']);
    expect(s.get('settings.metarTempColorPalette')).toBe('850mbtemps');
  });
});
