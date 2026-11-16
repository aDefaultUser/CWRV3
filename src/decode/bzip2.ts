// Independent bzip2 decompressor (format per Seward's bzip2 1.0 file format: Huffman + MTF + RLE2,
// inverse Burrows-Wheeler transform, RLE1). Written for Archive II LDM records; no CRC verification
// beyond structural checks (callers validate decoded message framing).

class BitReader {
  private pos = 0;
  private buf = 0;
  private n = 0;
  constructor(private data: Uint8Array, start = 0) { this.pos = start; }

  bits(count: number): number {
    while (this.n < count) {
      if (this.pos >= this.data.length) throw new Error('bzip2: unexpected end of data');
      this.buf = ((this.buf << 8) | this.data[this.pos++]) >>> 0;
      this.n += 8;
    }
    this.n -= count;
    return (this.buf >>> this.n) & ((1 << count) - 1);
  }

  bit(): number { return this.bits(1); }
  get bytePos(): number { return this.pos; }
}

const MAX_GROUPS = 6;
const MAX_ALPHA = 258;
const MAX_CODE_LEN = 20;
const GROUP_SIZE = 50;

interface HuffTable { limit: Int32Array; base: Int32Array; perm: Int32Array; minLen: number; }

function buildTable(lengths: Uint8Array, alphaSize: number): HuffTable {
  let minLen = 32, maxLen = 0;
  for (let i = 0; i < alphaSize; i++) { minLen = Math.min(minLen, lengths[i]); maxLen = Math.max(maxLen, lengths[i]); }
  const perm = new Int32Array(MAX_ALPHA);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) for (let s = 0; s < alphaSize; s++) if (lengths[s] === len) perm[pp++] = s;
  const base = new Int32Array(MAX_CODE_LEN + 2);
  const limit = new Int32Array(MAX_CODE_LEN + 2).fill(-1);
  const count = new Int32Array(MAX_CODE_LEN + 2);
  for (let s = 0; s < alphaSize; s++) count[lengths[s]]++;
  // Canonical code assignment: code values increase with length.
  let code = 0, idx = 0;
  for (let len = minLen; len <= maxLen; len++) {
    base[len] = code - idx; // symbol index = code - base[len]
    code += count[len];
    idx += count[len];
    limit[len] = code - 1;
    code <<= 1;
  }
  return { limit, base, perm, minLen };
}

/** Decompresses one bzip2 stream beginning at `offset`. */
export function bunzip2(data: Uint8Array, offset = 0): Uint8Array {
  if (data[offset] !== 0x42 || data[offset + 1] !== 0x5a || data[offset + 2] !== 0x68) throw new Error('bzip2: bad magic');
  const level = data[offset + 3] - 0x30;
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
  const blockMax = level * 100000;
  const br = new BitReader(data, offset + 4);
  const tt = new Uint32Array(blockMax);
  let out = new Uint8Array(Math.max(blockMax, 1 << 16));
  let outLen = 0;
  const ensure = (extra: number) => {
    if (outLen + extra <= out.length) return;
    const grown = new Uint8Array(Math.max(out.length * 2, outLen + extra));
    grown.set(out.subarray(0, outLen));
    out = grown;
  };

  for (;;) {
    const m1 = br.bits(24), m2 = br.bits(24);
    if (m1 === 0x177245 && m2 === 0x385090) break; // end-of-stream marker
    if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
    br.bits(16); br.bits(16); // block CRC (unchecked)
    if (br.bit()) throw new Error('bzip2: randomized blocks unsupported');
    const origPtr = br.bits(24);

    // Symbol map
    const used: number[] = [];
    const ranges = br.bits(16);
    for (let i = 0; i < 16; i++) if (ranges & (0x8000 >> i)) {
      const bitsI = br.bits(16);
      for (let j = 0; j < 16; j++) if (bitsI & (0x8000 >> j)) used.push(i * 16 + j);
    }
    if (used.length === 0) throw new Error('bzip2: empty symbol map');
    const alphaSize = used.length + 2;

    const nGroups = br.bits(3);
    if (nGroups < 2 || nGroups > MAX_GROUPS) throw new Error('bzip2: bad group count');
    const nSelectors = br.bits(15);
    if (nSelectors < 1) throw new Error('bzip2: bad selector count');
    const mtfGroups = [0, 1, 2, 3, 4, 5].slice(0, nGroups);
    const selectors = new Uint8Array(nSelectors);
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (br.bit()) if (++j >= nGroups) throw new Error('bzip2: bad selector');
      const v = mtfGroups[j];
      for (; j > 0; j--) mtfGroups[j] = mtfGroups[j - 1];
      mtfGroups[0] = v;
      selectors[i] = v;
    }

    const tables: HuffTable[] = [];
    for (let g = 0; g < nGroups; g++) {
      const lengths = new Uint8Array(MAX_ALPHA);
      let len = br.bits(5);
      for (let s = 0; s < alphaSize; s++) {
        for (;;) {
          if (len < 1 || len > MAX_CODE_LEN) throw new Error('bzip2: bad code length');
          if (!br.bit()) break;
          len += br.bit() ? -1 : 1;
        }
        lengths[s] = len;
      }
      tables.push(buildTable(lengths, alphaSize));
    }

    // Huffman → MTF/RLE2 → byte counts
    const mtf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) mtf[i] = i;
    const counts = new Int32Array(256);
    const eob = alphaSize - 1;
    let selIdx = 0, groupLeft = 0, table = tables[0];
    let n = 0, runLen = 0, runBit = 1;
    for (;;) {
      if (groupLeft === 0) {
        if (selIdx >= nSelectors) throw new Error('bzip2: selector overflow');
        table = tables[selectors[selIdx++]];
        groupLeft = GROUP_SIZE;
      }
      groupLeft--;
      let zn = table.minLen;
      let zvec = br.bits(zn);
      while (zn <= MAX_CODE_LEN && zvec > table.limit[zn]) { zn++; zvec = (zvec << 1) | br.bit(); }
      if (zn > MAX_CODE_LEN) throw new Error('bzip2: bad Huffman code');
      const sym = table.perm[zvec - table.base[zn]];

      if (sym <= 1) { // RUNA / RUNB
        runLen += (sym + 1) * runBit;
        runBit <<= 1;
        continue;
      }
      if (runLen > 0) {
        const b = used[mtf[0]];
        if (n + runLen > blockMax) throw new Error('bzip2: run overflow');
        counts[b] += runLen;
        tt.fill(b, n, n + runLen);
        n += runLen;
        runLen = 0; runBit = 1;
      }
      if (sym === eob) break;
      const k = sym - 1;
      const v = mtf[k];
      mtf.copyWithin(1, 0, k);
      mtf[0] = v;
      const b = used[v];
      if (n >= blockMax) throw new Error('bzip2: block overflow');
      counts[b]++;
      tt[n++] = b;
    }
    if (origPtr >= n) throw new Error('bzip2: bad origPtr');

    // Inverse BWT: tt[i] low byte = symbol, upper bits = link to next position.
    const cftab = new Int32Array(256);
    for (let i = 0, sum = 0; i < 256; i++) { cftab[i] = sum; sum += counts[i]; }
    for (let i = 0; i < n; i++) {
      const b = tt[i] & 0xff;
      tt[cftab[b]++] |= i << 8;
    }

    // Walk the chain and undo RLE1 (runs of 4 equal bytes followed by a count byte).
    ensure(n * 2);
    let pos = tt[origPtr] >>> 8;
    let last = -1, run = 0;
    for (let i = 0; i < n; i++) {
      const entry = tt[pos];
      const b = entry & 0xff;
      pos = entry >>> 8;
      if (run === 4) {
        ensure(b);
        out.fill(last, outLen, outLen + b);
        outLen += b;
        run = 0; last = -1;
        continue;
      }
      if (b === last) run++; else { run = 1; last = b; }
      ensure(1);
      out[outLen++] = b;
    }
  }
  return out.subarray(0, outLen);
}
