// User shapefiles (TFrmShapefiles): zipped shapefiles (or GeoJSON) decoded in a
// worker, drawn with a per-layer map-object style ("Shape:<id>", TFrmStyleEditor), visibility switch, draw order,
// resolution adjust; the archive bytes persist in Cache Storage (the original's GISLayers.dat list).
// The shapefile extractor (TFrmShapefileExtract) selects shapes by field = value and writes them as a new
// zipped shapefile (shp/shx/dbf/prj, ESRI Shapefile Technical Description).
import type { Renderer } from '../render/renderer';
import type { GlyphAtlas } from '../render/prims';
import { VectorLayer, type VShape } from './vector';
import type { VectorLayer as Decoded } from '../workers/shape-tasks';
import { pool } from '../workers/pool';
import { STYLE_DEFAULTS } from '../app/styles';
import { loadPref, savePref, isArray, reportSaveFailure } from '../app/persist';
import { USER_FILES_CACHE } from '../app/persist';

export interface UserShape { id: number; name: string; visible: boolean; resolution: number; layers: Decoded[] }
const LIST_KEY = 'userShapes';
const CACHE = USER_FILES_CACHE;

export class UserShapesLayer extends VectorLayer {
  readonly id = 'userShapes';
  readonly title = 'User shapefiles';
  items: UserShape[] = [];
  selected = -1;
  constructor(r: Renderer, atlas: GlyphAtlas) { super(r, atlas); this.restore(); }
  enabled() { return this.items.some((s) => s.visible); }
  labelsOn() { return false; }

  private async restore() {
    const list = loadPref<{ id: number; name: string; visible: boolean; resolution: number }[]>(LIST_KEY, [], isArray);
    if (!list.length) return;
    try {
      const cache = await caches.open(CACHE);
      for (const e of list) {
        const hit = await cache.match(`/user-shapes/${e.id}`);
        if (!hit) continue;
        const layers = await decode(e.name, new Uint8Array(await hit.arrayBuffer()));
        this.items.push({ ...e, layers });
      }
      this.rebuild();
    } catch (err) {
      console.error('CWRV3: saved shapefiles could not be restored from Cache Storage', err);
    }
  }
  private persist() { return savePref(LIST_KEY, this.items.map(({ id, name, visible, resolution }) => ({ id, name, visible, resolution })), 'shapefile list'); }

  async add(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const layers = await decode(file.name, bytes);
    const id = Date.now();
    try { await (await caches.open(CACHE)).put(`/user-shapes/${id}`, new Response(bytes)); } catch (err) { reportSaveFailure(`shapefile ${file.name} (kept for this session only)`, err); }
    this.items.push({ id, name: file.name, visible: true, resolution: 0, layers });
    this.selected = this.items.length - 1;
    this.persist(); this.rebuild();
    return layers.reduce((n, l) => n + l.features.length, 0);
  }
  async remove(i: number) {
    const s = this.items[i]; if (!s) return;
    this.items.splice(i, 1);
    try { await (await caches.open(CACHE)).delete(`/user-shapes/${s.id}`); } catch (err) { console.warn('CWRV3: removed shapefile could not be deleted from Cache Storage', err); }
    this.selected = Math.min(this.selected, this.items.length - 1);
    this.persist(); this.rebuild();
  }
  move(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= this.items.length) return;
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    this.selected = j; this.persist(); this.rebuild();
  }
  setVisible(i: number, v: boolean) { const s = this.items[i]; if (s) { s.visible = v; this.persist(); this.rebuild(); } }
  setResolution(i: number, r: number) { const s = this.items[i]; if (s) { s.resolution = r; this.persist(); this.rebuild(); } }
  styleName(s: UserShape) { return `Shape:${s.id}`; }

  /** Resolution adjust −100..170 → Douglas–Peucker tolerance (0.001° at 0; coarser negative, finer positive). */
  rebuild() {
    const shapes: VShape[] = [];
    this.items.forEach((s, order) => {
      if (!s.visible) return;
      const name = this.styleName(s);
      STYLE_DEFAULTS[name] ??= { ...STYLE_DEFAULTS.UserShape };
      const tol = 0.001 * Math.pow(2, -s.resolution / 40);
      for (const l of s.layers) for (const f of l.features) {
        const info = [`${s.name}${s.layers.length > 1 ? ` / ${l.name}` : ''}`, ...Object.entries(f.attrs).slice(0, 8).map(([k, v]) => `${k}: ${v}`)];
        const parts = f.kind === 'point' ? f.parts : f.parts.map((p) => thin(p, tol));
        shapes.push({ kind: f.kind as VShape['kind'], parts, tris: f.tris, style: name, z: order, info });
      }
    });
    this.setShapes(shapes);
  }
}

/** Decoded in a worker from an object URL (large shapefiles must not stall the UI). */
export async function decode(name: string, bytes: Uint8Array): Promise<Decoded[]> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  try {
    if (/\.(geo)?json$/i.test(name)) return [{ name, projected: false, features: await pool.for('userShapes').run('geojson', { url, tol: 0.0005 }) }];
    return await pool.for('userShapes').run<Decoded[]>('shapes', { url, kind: /\.(tgz|tar\.gz)$/i.test(name) ? 'tgz' : /\.tar$/i.test(name) ? 'tar' : 'zip', tol: 0.0002, cache: 'none' });
  } finally { URL.revokeObjectURL(url); }
}

/** Douglas–Peucker on interleaved lon/lat. */
export function thin(p: number[], tol: number): number[] {
  if (p.length <= 4 || tol <= 0) return p;
  const n = p.length / 2, keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bd = tol;
    const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / L; if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

// ------------------------------------------------------------------------------------------- shapefile writer
/** Writes features (one geometry kind) as a zipped shapefile: .shp, .shx, .dbf (C fields) and a WGS 84 .prj. */
export function writeShapefileZip(base: string, features: Decoded['features']): Uint8Array {
  const kind = features[0]?.kind ?? 'point';
  const type = kind === 'point' ? 1 : kind === 'line' ? 3 : 5;
  const recs: Uint8Array[] = [];
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) {
    const pts = f.parts.flatMap((p) => p);
    for (let i = 0; i + 1 < pts.length; i += 2) { bbox = [Math.min(bbox[0], pts[i]), Math.min(bbox[1], pts[i + 1]), Math.max(bbox[2], pts[i]), Math.max(bbox[3], pts[i + 1])]; }
    if (type === 1) { const b = new DataView(new ArrayBuffer(20)); b.setInt32(0, 1, true); b.setFloat64(4, f.parts[0][0], true); b.setFloat64(12, f.parts[0][1], true); recs.push(new Uint8Array(b.buffer)); continue; }
    const nParts = f.parts.length, nPts = pts.length / 2;
    const b = new DataView(new ArrayBuffer(44 + nParts * 4 + nPts * 16));
    const xs = f.parts.flatMap((p) => p.filter((_, i) => i % 2 === 0)), ys = f.parts.flatMap((p) => p.filter((_, i) => i % 2 === 1));
    b.setInt32(0, type, true); b.setFloat64(4, Math.min(...xs), true); b.setFloat64(12, Math.min(...ys), true); b.setFloat64(20, Math.max(...xs), true); b.setFloat64(28, Math.max(...ys), true);
    b.setInt32(36, nParts, true); b.setInt32(40, nPts, true);
    let start = 0; f.parts.forEach((p, i) => { b.setInt32(44 + i * 4, start, true); start += p.length / 2; });
    let o = 44 + nParts * 4; for (let i = 0; i < pts.length; i += 2) { b.setFloat64(o, pts[i], true); b.setFloat64(o + 8, pts[i + 1], true); o += 16; }
    recs.push(new Uint8Array(b.buffer));
  }
  const header = (len: number) => { const h = new DataView(new ArrayBuffer(100)); h.setInt32(0, 9994); h.setInt32(24, len / 2); h.setInt32(28, 1000, true); h.setInt32(32, type, true); [bbox[0], bbox[1], bbox[2], bbox[3]].forEach((v, i) => h.setFloat64(36 + i * 8, Number.isFinite(v) ? v : 0, true)); return new Uint8Array(h.buffer); };
  const shpLen = 100 + recs.reduce((n, r) => n + 8 + r.length, 0);
  const shp = new Uint8Array(shpLen), shx = new Uint8Array(100 + recs.length * 8);
  shp.set(header(shpLen)); shx.set(header(shx.length));
  let off = 100;
  recs.forEach((r, i) => {
    const rh = new DataView(shp.buffer, off, 8); rh.setInt32(0, i + 1); rh.setInt32(4, r.length / 2);
    shp.set(r, off + 8);
    const xr = new DataView(shx.buffer, 100 + i * 8, 8); xr.setInt32(0, off / 2); xr.setInt32(4, r.length / 2);
    off += 8 + r.length;
  });
  // dBASE III: character fields of the attributes (max 254 chars).
  const names = [...new Set(features.flatMap((f) => Object.keys(f.attrs)))].slice(0, 120);
  const widths = names.map((k) => Math.min(254, Math.max(1, ...features.map((f) => String(f.attrs[k] ?? '').length))));
  const recLen = 1 + widths.reduce((a, b) => a + b, 0), hdrLen = 32 + names.length * 32 + 1;
  const dbf = new Uint8Array(hdrLen + features.length * recLen + 1);
  const dv = new DataView(dbf.buffer);
  dbf[0] = 3; const d = new Date(); dbf[1] = d.getFullYear() - 1900; dbf[2] = d.getMonth() + 1; dbf[3] = d.getDate();
  dv.setUint32(4, features.length, true); dv.setUint16(8, hdrLen, true); dv.setUint16(10, recLen, true);
  const enc = new TextEncoder();
  names.forEach((k, i) => { const p = 32 + i * 32; dbf.set(enc.encode(k.slice(0, 10)), p); dbf[p + 11] = 67; dbf[p + 16] = widths[i]; });
  dbf[hdrLen - 1] = 0x0d;
  features.forEach((f, r) => {
    let p = hdrLen + r * recLen; dbf[p++] = 0x20;
    names.forEach((k, i) => { const v = enc.encode(String(f.attrs[k] ?? '').padEnd(widths[i]).slice(0, widths[i])); dbf.set(v.subarray(0, widths[i]), p); p += widths[i]; });
  });
  dbf[dbf.length - 1] = 0x1a;
  const prj = enc.encode('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]');
  return zipStore([[`${base}.shp`, shp], [`${base}.shx`, shx], [`${base}.dbf`, dbf], [`${base}.prj`, prj]]);
}

/** Minimal ZIP writer (stored entries, CRC-32). */
export function zipStore(files: [string, Uint8Array][]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const [name, data] of files) {
    const nm = enc.encode(name), c = crc(data);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, c, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, c, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + data.length;
  }
  const cdLen = central.reduce((n, x) => n + x.length, 0);
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdLen, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
  let p = 0; for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}
