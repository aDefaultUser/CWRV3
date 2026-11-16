// Post-load consistency rules.
// Applied after every load from storage and after every import, as the original loaders do.
import { RADAR_SITES } from '../generated/radar-sites';
import { PRODUCTS } from '../generated/products-catalog';
import type { PostLoadRule } from './types';

export const L3_DISABLED = new Set<number>(PRODUCTS.level3.filter((p) => p.disabled).map((p) => p.index));

/** Index of an ICAO in the built-in alphabetical site table; undefined when absent (value then left unchanged). */
export function siteIndex(icao: string): number | undefined {
  const i = RADAR_SITES.findIndex((s) => s.id === icao.toUpperCase());
  return i < 0 ? undefined : i;
}

export interface PostLoadContext { get(id: string): unknown; screenHeight?: number }

/** Returns the corrected value, or the input when the rule leaves it unchanged. */
export function applyPostLoad(rule: PostLoadRule, value: unknown, ctx: PostLoadContext): unknown {
  switch (rule) {
    case 'min2':
      return typeof value === 'number' && value < 2 ? 2 : value;
    case 'iemHttps':
      return typeof value === 'string' && value.startsWith('http://mesonet-nexrad.agron.iastate.edu')
        ? 'https://' + value.slice('http://'.length) : value;
    case 'abs':
      return typeof value === 'number' ? Math.abs(value) : value;
    case 'min0.15':
      return typeof value === 'number' && value < 0.15 ? 0.15 : value;
    case 'min5':
      return typeof value === 'number' && value < 5 ? 5 : value;
    case 'parseDateOr0': {
      if (typeof value === 'number') return value;
      const t = Date.parse(String(value));
      return Number.isFinite(t) ? t : 0;
    }
    case 'l3Index':
      return typeof value === 'number' && (value >= 63 || value < 0 || L3_DISABLED.has(value)) ? 0 : value;
    case 'derivedSiteIdx': {
      const idx = siteIndex(String(ctx.get('settings.nexradSiteICAO') ?? ''));
      return idx ?? value;
    }
    case 'videoHeightFromScreen': {
      // The loader derives the height from the screen height (formula not traced): keep the
      // stored X and use the screen's aspect ratio.
      if (!Array.isArray(value) || !ctx.screenHeight) return value;
      const w = Number(value[0]);
      const aspect = typeof screen !== 'undefined' && screen.width ? screen.height / screen.width : 9 / 16;
      return [w, Math.round(w * aspect)];
    }
    case 'loopMax6':
      return typeof value === 'number' && value > 6 ? 6 : value;
    case 'consumerHailReset':
      return value; // applied by the hail product builder
    case 'bits18': {
      // LSR type filter: 18 characters of 0/1; anything else is repaired, missing positions shown.
      const t = String(value ?? '');
      if (/^[01]{18}$/.test(t)) return t;
      return Array.from({ length: 18 }, (_, i) => (t[i] === '0' ? '0' : '1')).join('');
    }
    case 'coFamily': {
      // Convective outlook family normalised by day after load: days 1-2 → 0..3, day 3 → 0/1, days 4-8 → 1.
      const day = Number(ctx.get('layerState.NWSConvectiveOutlooksDayIdx') ?? 0), f = Number(value);
      if (!Number.isFinite(f)) return 0;
      return day < 2 ? Math.min(3, Math.max(0, f)) : day === 2 ? (f >= 1 ? 1 : 0) : 1;
    }
    case 'clamp1to20':
      return typeof value === 'number' ? Math.min(20, Math.max(1, value)) : value;
  }
}

/** Hail thresholds as the product builder sees them: reset to 40 / 50 when inverted. */
export function hailThresholds(lower: number, upper: number): [number, number] {
  return upper <= lower ? [40, 50] : [lower, upper];
}

/**
 * Legacy convective-outlook layer-state keys (catalog, read-only): when the modern family key is absent,
 * the first enabled legacy family wins (Categorical, Tornado/Probabilistic, Hail, Wind) and any legacy CIG flag
 * selects CIG mode 1 (Overlay).
 */
export function migrateLegacyOutlook(legacy: Record<string, unknown>): { family: number; cig: number | null } | null {
  const on = (k: string) => legacy[`layerState.legacy.NWSConvectiveOutlooks${k}`] === true || legacy[`layerState.legacy.NWSConvectiveOutlooks${k}`] === 1 || legacy[`layerState.legacy.NWSConvectiveOutlooks${k}`] === 'true';
  if (!Object.keys(legacy).length) return null;
  // Legacy single TypeIdx 0..6 (used when no legacy boolean is set): 0 Categorical, 1 Tornado, 2 Hail, 3 Wind;
  // 4..6 = Tornado/Hail/Wind with the CIG overlay (catalog note).
  const anyFlag = Object.keys(legacy).some((k) => k.startsWith('layerState.legacy.') && on(k.slice('layerState.legacy.NWSConvectiveOutlooks'.length)));
  const ti = Number(legacy['layerState.NWSConvectiveOutlooksTypeIdx']);
  if (!anyFlag && 'layerState.NWSConvectiveOutlooksTypeIdx' in legacy && Number.isInteger(ti) && ti >= 0 && ti <= 6) return { family: ti <= 3 ? ti : ti - 3, cig: ti >= 4 ? 1 : null };
  const family = on('ShowCategorical') ? 0 : on('ShowTornado') || on('ShowProbabilistic') ? 1 : on('ShowHail') ? 2 : on('ShowWind') ? 3 : 0;
  const cig = on('ShowTornadoCIG') || on('ShowHailCIG') || on('ShowWindCIG') ? 1 : null;
  return { family, cig };
}
