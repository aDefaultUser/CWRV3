// Padded GPU upload image of a polar sweep: rows = radials + 2 (wrap rows for complete sweeps, clamp rows
// otherwise). 8-bit codes stay bytes. 16-bit words become word / 65535 in float32, which is exact for every
// word (no half-float rounding, no subnormal flush), so reserved codes 0/1 and full ZDR/PHI precision survive.
export function padSweep(codes: Uint8Array | Uint16Array, radials: number, gates: number, complete: boolean, wordSize: 8 | 16): Uint8Array | Float32Array {
  const rows = radials + 2, n = gates;
  const out = wordSize === 16 ? new Float32Array(rows * n) : new Uint8Array(rows * n);
  const put = (dst: number, src: number) => {
    if (wordSize === 16) { for (let g = 0; g < n; g++) out[dst + g] = codes[src + g] / 65535; }
    else (out as Uint8Array).set((codes as Uint8Array).subarray(src, src + n), dst);
  };
  for (let r = 0; r < radials; r++) put((r + 1) * n, r * n);
  put(0, (complete ? radials - 1 : 0) * n);
  put((rows - 1) * n, (complete ? 0 : radials - 1) * n);
  return out;
}
