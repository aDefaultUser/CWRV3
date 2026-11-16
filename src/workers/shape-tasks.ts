// Vector products for the decode worker: shapefiles inside zip / tar / tgz archives and GeoJSON, decoded to
// lon/lat parts with attributes; polygons are triangulated (earcut) and subdivided so that no triangle edge is
// longer than ~1° (flat triangles would cut under the globe surface).
import earcut from 'earcut';
import { readShp, readDbf, simplify } from '../decode/shapefile';
import { unzip, gunzip } from '../decode/zip';
import { untar } from '../decode/tar';
import { fetchBytes } from '../data/net';

export interface VectorFeature {
  /** 'point' | 'line' | 'polygon' */ kind: string;
  attrs: Record<string, unknown>;
  /** lon/lat parts (rings or lines; points: one pair) */ parts: number[][];
  /** triangle vertices lon/lat (polygons only) */ tris?: number[];
}
export interface VectorLayer { name: string; features: VectorFeature[]; projected: boolean }

const MAX_EDGE = 1.0;

function densify(ring: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < ring.length; i += 2) {
    const x0 = ring[i], y0 = ring[i + 1];
    out.push(x0, y0);
    if (i + 3 < ring.length) {
      const x1 = ring[i + 2], y1 = ring[i + 3];
      const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / MAX_EDGE);
      for (let k = 1; k < n; k++) out.push(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
    }
  }
  return out;
}

function subdivide(a: number[], b: number[], c: number[], out: number[], depth = 0) {
  const d = (p: number[], q: number[]) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
  if (depth >= 6 || (d(a, b) <= MAX_EDGE && d(b, c) <= MAX_EDGE && d(c, a) <= MAX_EDGE)) { out.push(a[0], a[1], b[0], b[1], c[0], c[1]); return; }
  const m = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const ab = m(a, b), bc = m(b, c), ca = m(c, a);
  subdivide(a, ab, ca, out, depth + 1); subdivide(ab, b, bc, out, depth + 1); subdivide(ca, bc, c, out, depth + 1); subdivide(ab, bc, ca, out, depth + 1);
}

/** Signed area (shoelace); shapefile outer rings are clockwise (negative), holes counter-clockwise. */
export function ringArea(r: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i + 3 < r.length; i += 2) s += r[i] * r[i + 3] - r[i + 2] * r[i + 1];
  return s / 2;
}

function pointInRing(x: number, y: number, r: ArrayLike<number>): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Triangulates rings (outer rings with their holes) into lon/lat triangle vertices. */
export function triangulate(rings: number[][], clockwiseOuter = true): number[] {
  const outers: number[][] = [], holes: number[][] = [];
  for (const r of rings) { if (r.length < 6) continue; (ringArea(r) < 0 === clockwiseOuter ? outers : holes).push(r); }
  if (!outers.length && holes.length) outers.push(...holes.splice(0)); // inconsistent winding: treat all as outers
  const tris: number[] = [];
  for (const o of outers) {
    const mine = holes.filter((h) => pointInRing(h[0], h[1], o));
    const flat: number[] = densify(o);
    const holeIdx: number[] = [];
    for (const h of mine) { holeIdx.push(flat.length / 2); flat.push(...densify(h)); }
    const idx = earcut(flat, holeIdx, 2);
    for (let i = 0; i < idx.length; i += 3) {
      const p = (k: number) => [flat[idx[k] * 2], flat[idx[k] * 2 + 1]];
      subdivide(p(i), p(i + 1), p(i + 2), tris);
    }
  }
  return tris;
}

function shpToLayer(name: string, shp: Uint8Array, dbf: Uint8Array | undefined, prj: string | undefined, o: { tol?: number; fields?: string[] }): VectorLayer {
  const projected = !!prj && /^\s*PROJCS/i.test(prj);
  if (projected) throw new Error(`${name}: projected coordinate system not supported (${prj!.slice(0, 60)}…)`);
  const shapes = readShp(shp);
  const recs = dbf ? readDbf(dbf, 'latin1') : [];
  const features: VectorFeature[] = [];
  shapes.forEach((s, i) => {
    if (!s.parts.length) return;
    const base = s.type % 10;
    const all = recs[i] ?? {};
    const attrs = o.fields ? Object.fromEntries(o.fields.map((f) => [f, all[f] ?? null])) : all;
    const parts = s.parts.map((p) => (o.tol ? Array.from(simplify(p, o.tol)) : Array.from(p)));
    if (base === 1 || base === 8) for (const p of parts) for (let k = 0; k + 1 < p.length; k += 2) features.push({ kind: 'point', attrs, parts: [[p[k], p[k + 1]]] });
    else if (base === 3) features.push({ kind: 'line', attrs, parts });
    else if (base === 5) features.push({ kind: 'polygon', attrs, parts, tris: triangulate(parts) });
  });
  return { name, features, projected };
}

/** Reads every (or every matching) shapefile from an archive. */
export async function readShapeArchive(bytes: Uint8Array, kind: 'zip' | 'tar' | 'tgz', o: { match?: string; tol?: number; fields?: string[] } = {}): Promise<VectorLayer[]> {
  let files: Map<string, Uint8Array>;
  const want = (n: string) => /\.(shp|dbf|prj)$/i.test(n);
  if (kind === 'zip') files = await unzip(bytes, want);
  else files = untar(kind === 'tgz' ? await gunzip(bytes) : bytes, want);
  // Shapefile zips may nest further zips (e.g. NHC, SPC fire): expand one level.
  if (kind === 'zip' && ![...files.keys()].some((k) => /\.shp$/i.test(k))) {
    const inner = await unzip(bytes, (n) => /\.zip$/i.test(n));
    for (const b of inner.values()) for (const [k, v] of await unzip(b, want)) files.set(k, v);
  }
  const re = o.match ? new RegExp(o.match, 'i') : null;
  const out: VectorLayer[] = [];
  for (const [k, shp] of files) {
    if (!/\.shp$/i.test(k) || (re && !re.test(k))) continue;
    const stem = k.slice(0, -4);
    const find = (ext: string) => [...files.entries()].find(([n]) => n.toLowerCase() === (stem + ext).toLowerCase())?.[1];
    const prj = find('.prj');
    out.push(shpToLayer(k.split('/').pop()!, shp, find('.dbf'), prj ? new TextDecoder().decode(prj) : undefined, o));
  }
  return out;
}

export async function fetchShapes(a: { url: string; kind: 'zip' | 'tar' | 'tgz'; match?: string; tol?: number; fields?: string[]; cache?: 'none' | 'immutable' }) {
  const bytes = await fetchBytes(a.url, { cache: a.cache ?? 'none', maxBytes: 200 * 1024 * 1024 });
  return readShapeArchive(bytes, a.kind, a);
}

/** GeoJSON → features (Polygon / MultiPolygon triangulated; GeoJSON rings are counter-clockwise outers). */
export function geojsonFeatures(gj: { features?: { geometry: { type: string; coordinates: any } | null; properties: Record<string, unknown> }[] }, tol = 0): VectorFeature[] {
  const out: VectorFeature[] = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry; if (!g) continue;
    const attrs = f.properties ?? {};
    const ring = (r: number[][]) => { const flat = r.flatMap((p) => [p[0], p[1]]); return tol > 0 && flat.length > 16 ? Array.from(simplify(Float64Array.from(flat), tol)) : flat; };
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      const parts: number[][] = [], tris: number[] = [];
      for (const poly of polys) {
        const rings = poly.map(ring);
        parts.push(...rings);
        // GeoJSON: first ring outer, the rest holes, regardless of winding.
        const flat = densify(rings[0]); const holes: number[] = [];
        for (const h of rings.slice(1)) { holes.push(flat.length / 2); flat.push(...densify(h)); }
        const idx = earcut(flat, holes, 2);
        for (let i = 0; i < idx.length; i += 3) subdivide([flat[idx[i] * 2], flat[idx[i] * 2 + 1]], [flat[idx[i + 1] * 2], flat[idx[i + 1] * 2 + 1]], [flat[idx[i + 2] * 2], flat[idx[i + 2] * 2 + 1]], tris);
      }
      out.push({ kind: 'polygon', attrs, parts, tris });
    } else if (g.type === 'LineString') out.push({ kind: 'line', attrs, parts: [ring(g.coordinates)] });
    else if (g.type === 'MultiLineString') out.push({ kind: 'line', attrs, parts: g.coordinates.map(ring) });
    else if (g.type === 'Point') out.push({ kind: 'point', attrs, parts: [[g.coordinates[0], g.coordinates[1]]] });
  }
  return out;
}
