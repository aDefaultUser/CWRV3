// Behaviour of formerly stored-only display settings (pure helpers used by the layers).
import { describe, it, expect } from 'vitest';
import { updateFlash, chaikin } from '../src/layers/nexrad';
import { zoneClock, formatDateTime } from '../src/util/datefmt';
import { rescaleRange } from '../src/render/tiles';
import { shieldFlash, SiteLabelLayer } from '../src/layers/gis';
import { vectorFade } from '../src/sections/model';
import { interpolateMetar, parseMetar } from '../src/sections/surface-math';
import { videoFormat } from '../src/app/capture';
import { advisoryTolerance } from '../src/sections/nwsspc';
import { newAlerts, type Alert } from '../src/layers/warnings';

describe('live-composite update flash', () => {
  it('pulses between low and high alpha for the configured repetitions at the speed multiplier', () => {
    expect(updateFlash(0, 1, 1, 0.3, 0)).toBeCloseTo(0, 6);
    expect(updateFlash(350, 1, 1, 0.3, 0)).toBeCloseTo(0.3, 6);
    expect(updateFlash(700, 1, 1, 0.3, 0)).toBe(0); // one repetition done
    expect(updateFlash(1050, 2, 1, 0.3, 0)).toBeCloseTo(0.3, 6);
    expect(updateFlash(175, 1, 2, 0.3, 0)).toBeCloseTo(0.3, 6); // twice as fast
    expect(updateFlash(100, 0, 1, 0.3, 0)).toBe(0);
  });
});

describe('melting-layer interpolation', () => {
  it('smooths open lines keeping end points and keeps rings closed', () => {
    const open = chaikin([0, 0, 10, 0, 10, 10], 1);
    expect(open.slice(0, 2)).toEqual([0, 0]);
    expect(open.slice(-2)).toEqual([10, 10]);
    expect(open).toContain(7.5);
    const ring = chaikin([0, 0, 10, 0, 10, 10, 0, 0], 2);
    expect(ring.slice(0, 2)).toEqual(ring.slice(-2));
    expect(ring.length).toBeGreaterThan(8);
  });
});

describe('time-zone override', () => {
  it('formats at a fixed UTC offset instead of the browser zone', () => {
    const t = Date.UTC(2024, 4, 6, 22, 3, 0);
    const z = zoneClock(t, true, -5);
    expect(z.zone).toBe('UTC−5');
    expect(formatDateTime(z.ms, 'hh:nn', z.utc)).toBe('17:03');
    expect(zoneClock(t, true, 5.5).zone).toBe('UTC+5:30');
    expect(zoneClock(t, false, -5)).toEqual({ ms: t, utc: false, zone: null });
  });
});

describe('terrain dynamic range', () => {
  it('approaches the visible elevation range at the rescale speed', () => {
    expect(rescaleRange(null, [100, 900], 0.016, 19)).toEqual([100, 900]);
    const r = rescaleRange([0, 1000], [500, 1500], 1, 19);
    expect(r[0]).toBeGreaterThan(400); expect(r[0]).toBeLessThan(500);
    const slow = rescaleRange([0, 1000], [500, 1500], 1, 2);
    expect(slow[0]).toBeLessThan(r[0]);
  });
});

describe('labels', () => {
  it('interstate flash-on overshoots then settles', () => {
    expect(shieldFlash(0)).toBe(0);
    expect(shieldFlash(260)).toBeGreaterThan(1.5);
    expect(shieldFlash(1000)).toBe(1);
  });
  it('site labels scale up near the cursor', () => {
    expect(SiteLabelLayer.proximityScale(0)).toBe(1.5);
    expect(SiteLabelLayer.proximityScale(125)).toBe(1.25);
    expect(SiteLabelLayer.proximityScale(400)).toBe(1);
  });
});

describe('vector fade', () => {
  it('mode 0 never fades; mode 1 fades by zoom; mode 2 also fades weak vectors', () => {
    expect(vectorFade(0, 20)(5)).toBe(1);
    expect(vectorFade(1, 2)(5)).toBe(1);
    expect(vectorFade(1, 12)(50)).toBeCloseTo(0.55, 6);
    expect(vectorFade(2, 2)(5)).toBeCloseTo(0.55, 6);
    expect(vectorFade(2, 2)(50)).toBe(1);
  });
});

describe('METAR temporal interpolation', () => {
  it('blends numeric fields linearly between reports and keeps categorical weather', () => {
    const now = Date.UTC(2024, 4, 6, 23, 0, 0);
    const a = parseMetar('KOKC 062152Z 18015KT 10SM FEW040 30/18 A2990', now, false)!;
    const b = parseMetar('KOKC 062252Z 18025KT 10SM FEW040 20/18 A2995', now, false)!;
    const mid = a.timeMs + (b.timeMs - a.timeMs) / 2;
    expect(interpolateMetar(a, b, mid, 0)).toBeCloseTo((30 * 1.8 + 32 + 20 * 1.8 + 32) / 2, 4);
    expect(interpolateMetar(a, b, a.timeMs, 0)).toBeCloseTo(86, 4);
    expect(interpolateMetar(a, null, mid, 0)).toBeCloseTo(86, 4);
    expect(interpolateMetar(a, b, mid, 3)).toBe(interpolateMetar(a, null, mid, 3));
  });
});

describe('capture and products', () => {
  it('chooses H.264 MP4 when requested and supported, else WebM', () => {
    expect(videoFormat(true, (m) => m.startsWith('video/mp4'))).toEqual({ mimeType: 'video/mp4;codecs=avc1.640028', ext: 'mp4' });
    expect(videoFormat(true, (m) => m === 'video/webm;codecs=vp9')).toEqual({ mimeType: 'video/webm;codecs=vp9', ext: 'webm' });
    expect(videoFormat(false, () => true).mimeType).toBe('video/webm;codecs=vp9');
  });
  it('coarsens advisory polygons with the resolution setting', () => {
    expect(advisoryTolerance(0.004, 0)).toBe(0.004);
    expect(advisoryTolerance(0.004, 2)).toBeCloseTo(0.012, 9);
  });
  it('reports only alerts new since the previous poll and still in effect', () => {
    const al = (id: string, ends: number) => ({ id, ends } as Alert);
    expect(newAlerts(null, [al('a', 2)], 1)).toEqual([]);
    expect(newAlerts(new Set(['a']), [al('a', 2), al('b', 2), al('c', 0)], 1).map((x) => x.id)).toEqual(['b']);
  });
});
