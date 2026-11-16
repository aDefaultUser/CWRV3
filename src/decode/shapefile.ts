// ESRI Shapefile (.shp) and dBASE (.dbf) reader, per the ESRI Shapefile Technical Description (1998).
// Supports point, polyline and polygon shapes (types 1, 3, 5 and their M/Z variants).

export interface Shape { type: number; parts: Float64Array[]; } // each part: [lon0, lat0, lon1, lat1, ...]
export type DbfRecord = Record<string, string | number | null>;

export function readShp(buf: Uint8Array): Shape[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0) !== 9994) throw new Error('shp: bad file code');
  const fileLen = dv.getInt32(24) * 2;
  const shapes: Shape[] = [];
  let p = 100;
  while (p + 8 <= Math.min(fileLen, buf.length)) {
    const len = dv.getInt32(p + 4) * 2;
    const r = p + 8;
    const type = dv.getInt32(r, true);
    const base = type % 10; // 1 point, 3 polyline, 5 polygon, 8 multipoint (Z/M add 10/20)
    if (type === 0) shapes.push({ type, parts: [] });
    else if (base === 1) shapes.push({ type, parts: [Float64Array.of(dv.getFloat64(r + 4, true), dv.getFloat64(r + 12, true))] });
    else if (base === 3 || base === 5) {
      const nParts = dv.getInt32(r + 36, true), nPts = dv.getInt32(r + 40, true);
      const starts: number[] = [];
      for (let i = 0; i < nParts; i++) starts.push(dv.getInt32(r + 44 + i * 4, true));
      const pts = r + 44 + nParts * 4;
      const parts: Float64Array[] = [];
      for (let i = 0; i < nParts; i++) {
        const a = starts[i], b = i + 1 < nParts ? starts[i + 1] : nPts;
        const arr = new Float64Array((b - a) * 2);
        for (let k = a; k < b; k++) { arr[(k - a) * 2] = dv.getFloat64(pts + k * 16, true); arr[(k - a) * 2 + 1] = dv.getFloat64(pts + k * 16 + 8, true); }
        parts.push(arr);
      }
      shapes.push({ type, parts });
    } else if (base === 8) {
      const n = dv.getInt32(r + 36, true);
      const arr = new Float64Array(n * 2);
      for (let k = 0; k < n; k++) { arr[k * 2] = dv.getFloat64(r + 40 + k * 16, true); arr[k * 2 + 1] = dv.getFloat64(r + 48 + k * 16, true); }
      shapes.push({ type, parts: [arr] });
    } else shapes.push({ type, parts: [] });
    p = r + len;
  }
  return shapes;
}

export function readDbf(buf: Uint8Array, encoding = 'utf-8'): DbfRecord[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(4, true), headerLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
  const dec = new TextDecoder(encoding);
  const fields: { name: string; type: string; len: number; off: number }[] = [];
  let off = 1;
  for (let p = 32; p < headerLen - 1 && buf[p] !== 0x0d; p += 32) {
    let name = '';
    for (let i = 0; i < 11 && buf[p + i]; i++) name += String.fromCharCode(buf[p + i]);
    const len = buf[p + 16];
    fields.push({ name, type: String.fromCharCode(buf[p + 11]), len, off });
    off += len;
  }
  const out: DbfRecord[] = [];
  for (let i = 0; i < n; i++) {
    const r = headerLen + i * recLen;
    const rec: DbfRecord = {};
    for (const f of fields) {
      const s = dec.decode(buf.subarray(r + f.off, r + f.off + f.len)).replace(/\0+/g, "").trim();
      rec[f.name] = f.type === 'N' || f.type === 'F' ? (s === '' ? null : Number(s)) : s;
    }
    out.push(rec);
  }
  return out;
}

/** Douglas–Peucker simplification of an interleaved lon/lat polyline (tolerance in degrees). */
export function simplify(pts: Float64Array, tol: number): Float64Array {
  const n = pts.length / 2;
  if (n <= 2 || tol <= 0) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let best = -1, bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      let d: number;
      if (L === 0) d = px * px + py * py;
      else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L)); const ex = px - t * dx, ey = py - t * dy; d = ex * ex + ey * ey; }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  let m = 0;
  for (let i = 0; i < n; i++) if (keep[i]) m++;
  const out = new Float64Array(m * 2);
  for (let i = 0, j = 0; i < n; i++) if (keep[i]) { out[j++] = pts[i * 2]; out[j++] = pts[i * 2 + 1]; }
  return out;
}
