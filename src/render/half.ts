// IEEE 754 binary16 packing for r16float textures (shared by the main thread and workers).
/** Packs Float32 values into IEEE half floats (round to nearest even, with subnormals; for r16float textures). */
export function toHalf(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i];
    const x = u[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let m = x & 0x7fffff;
    if (exp === 0xff) { out[i] = sign | 0x7c00 | (m ? 0x200 : 0); continue; }
    const e = exp - 127 + 15;
    if (e >= 31) { out[i] = sign | 0x7c00; continue; }
    if (e <= 0) {
      if (e < -10) { out[i] = sign; continue; }
      m |= 0x800000;
      const shift = 14 - e;
      let h = m >>> shift;
      const rem = m & ((1 << shift) - 1), half = 1 << (shift - 1);
      if (rem > half || (rem === half && (h & 1))) h++;
      out[i] = sign | h;
      continue;
    }
    let h = (e << 10) | (m >>> 13);
    const rem = m & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
    out[i] = sign | h;
  }
  return out;
}
