// Iowa Environmental Mesonet archive services used in archive mode (time-parameterised GeoJSON).
import { fetchJson, type FetchOpts } from './net';

export const IEM = 'https://mesonet.agron.iastate.edu';
export const isoZ = (t: number) => `${new Date(t).toISOString().slice(0, 19)}Z`;

export interface IemFeature { geometry: { type: string; coordinates: any } | null; properties: Record<string, any> }

/**
 * A query whose whole period ended more than a day ago is cached like an immutable object; a newer one can still gain
 * late products and is fetched each time.
 */
export const archiveCache = (untilMs: number, now = Date.now()): FetchOpts['cache'] => (untilMs < now - 86400e3 ? 'immutable' : 'none');

export async function iemFeatures(path: string, untilMs: number): Promise<IemFeature[]> {
  const gj = await fetchJson<{ features?: IemFeature[] }>(`${IEM}${path}`, { cache: archiveCache(untilMs), timeoutMs: 60_000 });
  return gj.features ?? [];
}

/** Outer and inner rings of a (Multi)Polygon as flat lon/lat arrays. */
export function polygonRings(g: IemFeature['geometry']): number[][] {
  if (g?.type === 'Polygon') return g.coordinates.map((r: number[][]) => r.flat());
  if (g?.type === 'MultiPolygon') return g.coordinates.flatMap((poly: number[][][]) => poly.map((r) => r.flat()));
  return [];
}
