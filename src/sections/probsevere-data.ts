// ProbSevere v3 file parsing, shared by the layer and the decode worker (no rendering imports).

/** Probability types in file order; `ext.settings.probSevereType` indexes this list. */
export const PS_TYPES = [
  { key: 'ProbSevere', label: 'Severe (any)', short: 'Severe' },
  { key: 'ProbTor', label: 'Tornado', short: 'Tor' },
  { key: 'ProbHail', label: 'Hail', short: 'Hail' },
  { key: 'ProbWind', label: 'Wind', short: 'Wind' },
] as const;

export interface PsObject {
  id: string;
  /** Probabilities (%) in PS_TYPES order. */
  prob: number[];
  meshIn: number;
  /** Maximum low-level azimuthal shear (s⁻¹). */
  maxLlaz: number;
  /** Mean motion (m/s), east and north positive (the file's MOTION_SOUTH is positive northward). */
  motionE: number; motionN: number;
  /** Mean of the outer-ring vertices. */
  lon: number; lat: number;
  rings: number[][];
}
export interface PsFile { t: number; objects: PsObject[] }

/** "YYYYMMDD_HHMMSS" (file names and validTime) → epoch ms. */
export function probSevereTime(s: string): number | null {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;

/** A file of another ProbSevere version (archived files before v3): its fields differ. */
export class ProbSevereVersionError extends Error {}

/** Parses a ProbSevere v3 file; other products and versions are rejected (their fields differ). */
export function parseProbSevere(j: any): PsFile {
  if (j?.type !== 'FeatureCollection' || !Array.isArray(j.features)) throw new Error('not a ProbSevere feature collection');
  if (!/^ProbSevere 3(\.|$)/.test(String(j.product ?? ''))) throw new ProbSevereVersionError(`unsupported product "${j.product}" (ProbSevere v3 only)`);
  const t = probSevereTime(String(j.validTime ?? ''));
  if (t === null) throw new Error('missing validTime');
  const objects: PsObject[] = [];
  for (const f of j.features) {
    const p = f?.properties ?? {}, g = f?.geometry;
    const polys: number[][][][] = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    const rings = polys.map((poly) => (poly[0] ?? []).flat()).filter((r) => r.length >= 6 && r.every(Number.isFinite));
    if (!rings.length || p.ID === undefined) continue;
    let lon = 0, lat = 0;
    for (let i = 0; i < rings[0].length; i += 2) { lon += rings[0][i]; lat += rings[0][i + 1]; }
    const n = rings[0].length / 2, num = (k: string) => (p[k] === undefined || p[k] === '' ? NaN : Number(p[k]));
    objects.push({
      id: String(p.ID), prob: PS_TYPES.map((x) => num(x.key)), meshIn: num('MESH'), maxLlaz: num('MAXLLAZ'),
      motionE: num('MOTION_EAST'), motionN: num('MOTION_SOUTH'), lon: lon / n, lat: lat / n, rings,
    });
  }
  return { t, objects };
}

/** Parses a downloaded file and checks it is valid at the time it was requested for (never relabelled). */
export function checkedProbSevere(json: unknown, t: number, key: string): PsFile {
  const file = parseProbSevere(json);
  if (file.t !== t) throw new Error(`valid time ${hhmm(file.t)} does not match ${key}`);
  return file;
}

/** The decode worker's answer for one downloaded file: the parsed file, or why an earlier ProbSevere version was rejected. */
export function probSevereResult(json: unknown, t: number, key: string): { file?: PsFile; oldVersion?: string } {
  try { return { file: checkedProbSevere(json, t, key) }; } catch (e) {
    if (e instanceof ProbSevereVersionError) return { oldVersion: e.message };
    throw e;
  }
}
