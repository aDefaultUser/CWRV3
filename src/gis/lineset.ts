// Compact binary polyline set used for prebuilt GIS layers.
// Layout (little endian): 'WLN1', u32 nFeatures, u32 nCoords, u32 offsets[n+1] (pair index),
// u8 cls[n] (padded to 4), i32 value[n], f32 lonlat[nCoords*2].

export interface LineFeature { cls: number; value: number; coords: Float64Array | Float32Array }
export interface LineSet { offsets: Uint32Array; cls: Uint8Array; value: Int32Array; coords: Float32Array }

export function encodeLineSet(feats: LineFeature[]): Uint8Array {
  const n = feats.length;
  const nCoords = feats.reduce((s, f) => s + f.coords.length / 2, 0);
  const clsBytes = (n + 3) & ~3;
  const size = 12 + (n + 1) * 4 + clsBytes + n * 4 + nCoords * 8;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x314e4c57, true); // 'WLN1'
  dv.setUint32(4, n, true);
  dv.setUint32(8, nCoords, true);
  const offsets = new Uint32Array(buf, 12, n + 1);
  const cls = new Uint8Array(buf, 12 + (n + 1) * 4, n);
  const value = new Int32Array(buf, 12 + (n + 1) * 4 + clsBytes, n);
  const coords = new Float32Array(buf, 12 + (n + 1) * 4 + clsBytes + n * 4, nCoords * 2);
  let c = 0;
  feats.forEach((f, i) => {
    offsets[i] = c;
    cls[i] = f.cls;
    value[i] = f.value;
    coords.set(f.coords, c * 2);
    c += f.coords.length / 2;
  });
  offsets[n] = c;
  return new Uint8Array(buf);
}

export function decodeLineSet(bytes: ArrayBuffer): LineSet {
  const dv = new DataView(bytes);
  if (dv.getUint32(0, true) !== 0x314e4c57) throw new Error('lineset: bad magic');
  const n = dv.getUint32(4, true), nCoords = dv.getUint32(8, true);
  const clsBytes = (n + 3) & ~3;
  return {
    offsets: new Uint32Array(bytes, 12, n + 1),
    cls: new Uint8Array(bytes, 12 + (n + 1) * 4, n),
    value: new Int32Array(bytes, 12 + (n + 1) * 4 + clsBytes, n),
    coords: new Float32Array(bytes, 12 + (n + 1) * 4 + clsBytes + n * 4, nCoords * 2),
  };
}
