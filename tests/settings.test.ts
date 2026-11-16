import { describe, expect, it } from 'vitest';
import { SettingsStore, SETTING_DEFS, SETTINGS_SCHEMA, coerce } from '../src/settings/store';
import { applyPostLoad, siteIndex, hailThresholds } from '../src/settings/postload';

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

describe('settings defaults and ranges', () => {
  it('pins defaults that differ from naive choices', () => {
    const s = new SettingsStore();
    expect(s.get('settings.nexradL2DataSource')).toBe(2);
    expect(s.get('config.radarSites.SitesColor')).toEqual([100, 255, 255]);
    expect(s.get('config.terrainOceanColor')).toEqual([0, 10, 38]);
    expect(s.get('config.terrainGlossiness')).toBe(1.75);
    expect(s.get('config.terrainHypsometricTintPalette')).toBe('Terrain1');
    expect(s.get('settings.goesBandPals')).toEqual(Array.from({ length: 16 }, (_, i) => `GOESRBand${i + 1}`));
    expect(s.get('layerState.SatelliteProductIndex')).toBe(7);
    expect(s.get('layerState.NationalRadarIdx')).toBe(0);
    expect(s.get('settings.nexradUpdateSweepEffectDuration')).toBe(2.8);
    expect(s.get('config.defaultCameraPt')).toEqual([-95, 39, 163.75, 0]);
  });

  it('enforces declared ranges by clamping and the Level 2 source enumeration lower bound', () => {
    const store = new SettingsStore();
    let n = 0;
    for (const d of SETTING_DEFS.values()) {
      if ((d.type !== 'integer' && d.type !== 'number') || d.min == null || d.max == null || d.postLoad || d.legacy || d.enum) continue;
      store.set(d.id, d.max + 1000); expect(store.get(d.id), d.id).toBe(d.max);
      store.set(d.id, d.min - 1000); expect(store.get(d.id), d.id).toBe(d.min);
      n++;
    }
    expect(n).toBeGreaterThan(150);
    store.set('settings.nexradL2DataSource', 0);
    expect(store.get('settings.nexradL2DataSource')).toBe(2);
    store.set('layerState.SatelliteProductIndex', 99);
    expect(store.get('layerState.SatelliteProductIndex')).toBe(7);
  });

  it('rejects values of the wrong type and normalizes colors', () => {
    const store = new SettingsStore();
    store.set('settings.nrSmoothing', 'banana'); expect(store.get('settings.nrSmoothing')).toBe(true);
    store.set('settings.nrAlpha', 'x'); expect(store.get('settings.nrAlpha')).toBe(255);
    store.set('settings.generalContourColor', [300, -5, 12.6]); expect(store.get('settings.generalContourColor')).toEqual([255, 0, 13]);
    expect(coerce(SETTING_DEFS.get('settings.nexradTracksCellPtColor')!, '1,2,3,4')).toEqual([1, 2, 3, 4]);
  });
});

describe('post-load rules', () => {
  const ctx = { get: (id: string) => (id === 'settings.nexradSiteICAO' ? 'KTLX' : undefined), screenHeight: 1440 };
  it('implements every post-load clamp and migration', () => {
    expect(applyPostLoad('min2', 0, ctx)).toBe(2);
    expect(applyPostLoad('min2', 3, ctx)).toBe(3);
    expect(applyPostLoad('iemHttps', 'http://mesonet-nexrad.agron.iastate.edu/level2/raw/', ctx)).toBe('https://mesonet-nexrad.agron.iastate.edu/level2/raw/');
    expect(applyPostLoad('abs', -2.5, ctx)).toBe(2.5);
    expect(applyPostLoad('min0.15', 0.01, ctx)).toBe(0.15);
    expect(applyPostLoad('min5', 1, ctx)).toBe(5);
    expect(applyPostLoad('parseDateOr0', 'garbage', ctx)).toBe(0);
    expect(applyPostLoad('loopMax6', 9, ctx)).toBe(6);
    for (const i of [22, 24, 29, 30, 31, 32, 63, 100]) expect(applyPostLoad('l3Index', i, ctx), String(i)).toBe(0);
    expect(applyPostLoad('l3Index', 23, ctx)).toBe(23);
    expect(applyPostLoad('derivedSiteIdx', 14, ctx)).toBe(siteIndex('KTLX'));
    expect(siteIndex('KBOX')).toBe(14);
    expect(hailThresholds(50, 40)).toEqual([40, 50]);
    expect(hailThresholds(30, 55)).toEqual([30, 55]);
  });
  it('applies the rules when loading stored documents and imports', () => {
    const mem = new Mem();
    mem.setItem('cwrv3.CWRV3Settings', JSON.stringify({ values: { 'settings.nexradL2DataSource': 1, 'settings.nexradUpdateSweepEffectDuration': -4, 'settings.nexradL2CustomDataSource': 'http://mesonet-nexrad.agron.iastate.edu/x/' } }));
    mem.setItem('cwrv3.CWRV3ConfigurationSettings', JSON.stringify({ values: { 'config.generalCameraFlyJerk': 0.01 } }));
    mem.setItem('cwrv3.ProductStatus', JSON.stringify({ values: { 'layerState.NEXRADLevel3Product': 31, 'ext.layerState.LoopLength': 12 } }));
    const s = new SettingsStore(mem);
    expect(s.get('settings.nexradL2DataSource')).toBe(2);
    expect(s.get('settings.nexradUpdateSweepEffectDuration')).toBe(4);
    expect(s.get('settings.nexradL2CustomDataSource')).toBe('https://mesonet-nexrad.agron.iastate.edu/x/');
    expect(s.get('config.generalCameraFlyJerk')).toBe(0.15);
    expect(s.get('layerState.NEXRADLevel3Product')).toBe(0);
    expect(s.get('ext.layerState.LoopLength')).toBe(6);
    expect(s.firstRun).toBe(false);
  });
  it('detects the first run (no stored configuration) without writing defaults', () => {
    const mem = new Mem();
    const s = new SettingsStore(mem);
    expect(s.firstRun).toBe(true);
    expect(mem.m.size).toBe(0); // unwritten defaults load as the same defaults; nothing to race other tabs with
    s.set('config.generalActiveFPS', 90); s.flush();
    expect(new SettingsStore(mem).firstRun).toBe(false);
  });
});

describe('persistence documents', () => {
  it('round-trips through storage per document; layer state restores the last session', () => {
    const mem = new Mem();
    const a = new SettingsStore(mem);
    a.set('settings.nexradSiteICAO', 'KTLX');
    a.set('layerState.SatelliteProductIndex', 4);
    a.set('config.radarSites', { Scale: 1.2 });
    a.flush();
    expect(JSON.parse(mem.getItem('cwrv3.setting/layerState.SatelliteProductIndex')!)).toBe(4);
    const b = new SettingsStore(mem);
    expect(b.get('settings.nexradSiteICAO')).toBe('KTLX');
    expect(b.get('settings.nexradSiteIdx')).toBe(siteIndex('KTLX'));
    expect(b.get('layerState.SatelliteProductIndex')).toBe(4);
    expect(b.get<{ Scale: number }>('config.radarSites').Scale).toBe(1.2);
  });
  it('export/import keeps all stored IDs, ignores unknown IDs and defaults missing ones', () => {
    const b = new SettingsStore();
    const doc = b.exportDocument();
    const stored = [...SETTING_DEFS.values()].filter((d) => d.type !== 'aggregate' && d.postLoad !== 'derivedSiteIdx' && !d.legacy).length;
    expect(Object.keys(doc.values).length).toBe(stored);
    const c = new SettingsStore();
    c.set('layerState.SatelliteProductIndex', 2);
    const r = c.importDocument({ schema: SETTINGS_SCHEMA, values: { 'settings.nexradSiteICAO': 'KFWS', 'bogus.id': 1, 'settings.nexradSiteIdx': 3 } });
    expect(r.ignored).toEqual(['bogus.id', 'settings.nexradSiteIdx']);
    expect(c.get('settings.nexradSiteICAO')).toBe('KFWS');
    expect(c.get('layerState.SatelliteProductIndex')).toBe(7);
  });
  it('resets one document only (the reset handler clears the main settings, not the configuration)', () => {
    const s = new SettingsStore();
    s.set('settings.nrAlpha', 10); s.set('config.generalActiveFPS', 120); s.set('layerState.LightningOn', true);
    s.resetDocument('CWRV3Settings');
    expect(s.get('settings.nrAlpha')).toBe(255);
    expect(s.get('config.generalActiveFPS')).toBe(120);
    expect(s.get('layerState.LightningOn')).toBe(true);
  });
});

describe('expanded settings', () => {
  it('first-run layer state equals the expanded layer registry (all off except LSR, SNOW selector)', () => {
    const store = new SettingsStore();
    expect(store.get('layerState.NWSLocalStormReportsOn')).toBe(true);
    expect(store.get('layerState.WinterSnowAccumulationsVsIce')).toBe(true);
  });
  it('enforces expanded enumerations and clamps', () => {
    const store = new SettingsStore();
    store.set('settings.mrmsFrames', 0); expect(store.get('settings.mrmsFrames')).toBe(1);
    store.set('settings.mrmsFrames', 99); expect(store.get('settings.mrmsFrames')).toBe(20);
    store.set('layerState.NWSConvectiveOutlooksCIGMode', 7); expect(store.get('layerState.NWSConvectiveOutlooksCIGMode')).toBe(2);
    store.set('layerState.CPCIdx', 9); expect(store.get('layerState.CPCIdx')).toBe(5);
    expect(SETTING_DEFS.get('layerState.WinterProbabilityLevel')!.enum).toEqual([5, 10, 25, 50, 75, 90, 95]);
    expect(SETTING_DEFS.get('layerState.WinterIntervalLengthHours')!.enum).toEqual([24, 48, 72]);
  });
  it('round-trips every expanded layer-state key through the ProductStatus document', () => {
    const mem = new Mem();
    const a = new SettingsStore(mem);
    a.set('layerState.MRMSOn', true); a.set('layerState.MRMSProdIdx', 9); a.set('layerState.NDFDRegionIdx', 18); a.set('layerState.WinterProbabilityLevel', 90);
    a.flush();
    const b = new SettingsStore(mem);
    for (const d of SETTING_DEFS.values()) if (d.owner === 'LayerState' && d.type !== 'aggregate' && !d.legacy) expect(b.get(d.id), d.id).toEqual(a.get(d.id));
    expect(b.get('layerState.MRMSProdIdx')).toBe(9);
    expect(b.get('layerState.WinterProbabilityLevel')).toBe(90);
  });
  it('migrates legacy convective-outlook keys only when the family key is absent, and never writes them', () => {
    const s = new SettingsStore();
    s.importDocument({ values: { 'layerState.legacy.NWSConvectiveOutlooksShowHail': true, 'layerState.legacy.NWSConvectiveOutlooksShowHailCIG': true } }, false);
    expect(s.get('layerState.NWSConvectiveOutlooksFamilyIdx')).toBe(2);
    expect(s.get('layerState.NWSConvectiveOutlooksCIGMode')).toBe(1);
    s.importDocument({ values: { 'layerState.NWSConvectiveOutlooksFamilyIdx': 3, 'layerState.legacy.NWSConvectiveOutlooksShowCategorical': true } }, false);
    expect(s.get('layerState.NWSConvectiveOutlooksFamilyIdx')).toBe(3);
    expect(Object.keys(s.exportDocument().values).some((k) => k.includes('legacy'))).toBe(false);
  });
  it('migrates the legacy single outlook TypeIdx (4..6 add the CIG overlay) when no legacy flag is set', () => {
    const s = new SettingsStore();
    s.importDocument({ values: { 'layerState.NWSConvectiveOutlooksTypeIdx': 5 } }, false);
    expect(s.get('layerState.NWSConvectiveOutlooksFamilyIdx')).toBe(2);
    expect(s.get('layerState.NWSConvectiveOutlooksCIGMode')).toBe(1);
    const t = new SettingsStore();
    t.importDocument({ values: { 'layerState.NWSConvectiveOutlooksTypeIdx': 2, 'layerState.legacy.NWSConvectiveOutlooksShowWind': true } }, false);
    expect(t.get('layerState.NWSConvectiveOutlooksFamilyIdx')).toBe(3);
  });
  it('normalises the outlook family by day and repairs the LSR type filter', () => {
    const s = new SettingsStore();
    s.importDocument({ values: { 'layerState.NWSConvectiveOutlooksDayIdx': 5, 'layerState.NWSConvectiveOutlooksFamilyIdx': 0, 'ini.NWSLocalStormReports.TypeFilter': '0101' } }, false);
    expect(s.get('layerState.NWSConvectiveOutlooksFamilyIdx')).toBe(1);
    expect(s.get('ini.NWSLocalStormReports.TypeFilter')).toBe('010111111111111111');
  });
});
