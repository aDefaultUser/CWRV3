// JPEG 2000 code streams (GRIB2 data representation 5.40, e.g. RAP awp130) through the OpenJPEG WebAssembly build
// (@cornerstonejs/codec-openjpeg, MIT; OpenJPEG BSD-2). Loaded lazily inside the decode worker.
// @ts-expect-error CommonJS factory without types
import OpenJPEGWASM from '@cornerstonejs/codec-openjpeg/decodewasmjs';

type Decoder = { getEncodedBuffer(n: number): Uint8Array; decode(): void; getFrameInfo(): { width: number; height: number; bitsPerSample: number; componentCount: number; isSigned: boolean }; getDecodedBuffer(): Uint8Array; delete(): void };
import bundledWasm from '@cornerstonejs/codec-openjpeg/decodewasm?url';
let mod: Promise<{ J2KDecoder: new () => Decoder }> | null = null;
// In browsers/workers the .wasm is served by the bundler; under Node the module reads it from its own directory.
const inBrowser = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' || typeof window !== 'undefined';
let wasmUrl: string | null = inBrowser ? (bundledWasm as string) : null;

/** Optional explicit location of openjpegwasm_decode.wasm (set by the browser worker from a bundler URL). */
export function setJ2KWasmUrl(url: string) { wasmUrl = url; }

function load() {
  if (!mod) mod = (OpenJPEGWASM as (o: object) => Promise<{ J2KDecoder: new () => Decoder }>)(wasmUrl ? { locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl! : p) } : {});
  return mod;
}

/** Decodes a single-component JPEG 2000 code stream into unsigned integer samples (row-major). */
export async function decodeJ2K(bytes: Uint8Array): Promise<{ width: number; height: number; samples: Float64Array }> {
  const m = await load();
  const d = new m.J2KDecoder();
  try {
    d.getEncodedBuffer(bytes.length).set(bytes);
    d.decode();
    const fi = d.getFrameInfo();
    if (fi.componentCount !== 1) throw new Error(`jpeg2000: ${fi.componentCount} components (GRIB2 expects 1)`);
    const raw = d.getDecodedBuffer();
    const n = fi.width * fi.height;
    const out = new Float64Array(n);
    if (fi.bitsPerSample <= 8) for (let i = 0; i < n; i++) out[i] = fi.isSigned ? (raw[i] << 24) >> 24 : raw[i];
    else if (fi.bitsPerSample <= 16) {
      const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < n; i++) out[i] = fi.isSigned ? v.getInt16(i * 2, true) : v.getUint16(i * 2, true);
    } else throw new Error(`jpeg2000: ${fi.bitsPerSample}-bit samples not supported by this codec build`);
    return { width: fi.width, height: fi.height, samples: out };
  } finally { d.delete(); }
}
