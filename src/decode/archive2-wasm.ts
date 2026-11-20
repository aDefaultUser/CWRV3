// Rust/WebAssembly Archive II decoder (rust/archive2, built by tools/wasm.mjs): the Level 2 decoder of the decode
// worker once loadArchive2Wasm has compiled it. Without the module (no Rust toolchain at build time, or a failed
// load) Level 2 decodes with the TypeScript reference (archive2.ts); archive2Backend() says which one runs.
import { Archive2Decoder, MOMENT_NAMES, assembleVolume, plainCut, type L2Moment, type L2Sweep, type L2Volume, type MomentName, type VcpCut, type VcpInfo } from './archive2';

/** A Level 2 decoder of either backend. After `feed` throws, it holds part of the input: dispose of it. */
export interface L2Decoder { feed(buf: Uint8Array): void; volume(): L2Volume; dispose(): void }

interface Exports {
  memory: WebAssembly.Memory;
  a2_create(): number;
  a2_input(h: number, len: number): number; a2_feed(h: number): number;
  a2_volume(h: number): number; a2_sweep(h: number, elevationNumber: number): number;
}

/** Messages of the DecodeError codes (rust/archive2/src/lib.rs). */
const FEED_ERRORS = ['', 'corrupt bzip2 record', 'truncated bzip2 record', 'record, sweep or volume over the decoder limits', 'out of WebAssembly memory', 'decoder failed earlier'];

let wasmModule: WebAssembly.Module | null = null;
/**
 * Open WebAssembly decoders. Each has an instance of its own: WebAssembly memory only grows, so dropping the instance
 * after dispose is what returns a decoded volume's memory, and a trap ends only the decoder it happened in.
 */
const openDecoders = new Set<WasmArchive2Decoder>();
let loading: Promise<void> = Promise.resolve();
let loadError: string | null = null;
let preferTs = false;

/** The module's interface (rust/archive2/src/ffi.rs): no imports, and these exports. */
const EXPORTS: Record<keyof Exports, WebAssembly.ImportExportKind> = { memory: 'memory', a2_create: 'function', a2_input: 'function', a2_feed: 'function', a2_volume: 'function', a2_sweep: 'function' };
/** Time limit of the module's download: Level 2 decodes wait for the load. */
export const ARCHIVE2_FETCH_TIMEOUT_MS = 20_000;

/**
 * Downloads (a same-origin URL, within ARCHIVE2_FETCH_TIMEOUT_MS) or takes the module's bytes and compiles them; a
 * module without the decoder's interface is refused. Any failure leaves the TypeScript decoder.
 */
export function loadArchive2Wasm(source: BufferSource | string): Promise<void> {
  loading = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`no answer within ${ARCHIVE2_FETCH_TIMEOUT_MS / 1000} s`)), ARCHIVE2_FETCH_TIMEOUT_MS);
    try {
      let bytes = source;
      if (typeof source === 'string') {
        const r = await fetch(source, { signal: abort.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        bytes = await r.arrayBuffer();
      }
      const m = await WebAssembly.compile(bytes as BufferSource);
      const kinds = new Map(WebAssembly.Module.exports(m).map((e) => [e.name, e.kind]));
      const missing = Object.entries(EXPORTS).filter(([name, kind]) => kinds.get(name) !== kind).map(([name]) => name);
      if (missing.length) throw new Error(`not the Archive II decoder (missing ${missing.join(', ')})`);
      if (WebAssembly.Module.imports(m).length) throw new Error('not the Archive II decoder (has imports)');
      wasmModule = m;
      loadError = null;
    } catch (e) {
      wasmModule = null;
      loadError = String((e as Error)?.message ?? e); // a fetch rejects with the abort reason
      console.warn('Archive II WebAssembly decoder unavailable; using the TypeScript decoder:', loadError);
    } finally {
      clearTimeout(timer);
    }
  })();
  return loading;
}

/** Settles when the module load (if any) has finished. */
export const archive2Ready = () => loading;

/** Which decoder new volumes get, why the module is missing, and the open WebAssembly decoders and their memory. */
export function archive2Backend() {
  let wasmMemoryBytes = 0;
  for (const d of openDecoders) wasmMemoryBytes += d.memoryBytes;
  return { backend: wasmModule && !preferTs ? 'rust' as const : 'ts' as const, error: loadError, liveDecoders: openDecoders.size, wasmMemoryBytes };
}

/** Comparisons and tests: new decoders use the TypeScript reference even with the module loaded. */
export function preferTypeScriptArchive2(on: boolean): void { preferTs = on; }

export function createArchive2Decoder(requestedSite = ''): L2Decoder {
  return wasmModule && !preferTs ? new WasmArchive2Decoder(requestedSite) : new Archive2Decoder(requestedSite);
}

class WasmArchive2Decoder implements L2Decoder {
  private x: Exports | null;
  private readonly handle: number;
  private lost = false;
  private vcp: VcpInfo | null = null;
  /** Built sweeps by elevation number: rebuilt only when the decoder's version of the sweep changes. */
  private built = new Map<number, { version: number; sweep: L2Sweep }>();

  constructor(private readonly requestedSite: string) {
    const x = new WebAssembly.Instance(wasmModule!, {}).exports as unknown as Exports;
    this.handle = x.a2_create();
    this.x = x;
    openDecoders.add(this);
  }

  get memoryBytes(): number { return this.x?.memory.buffer.byteLength ?? 0; }

  /** Runs `fn` on this decoder's instance; a trap ends the decoder (its instance's state is unknown). */
  private call<T>(fn: (x: Exports) => T): T {
    const x = this.x;
    if (!x) throw new Error(`Archive II decoder: ${this.lost ? 'lost to a WebAssembly fault' : 'used after dispose'}`);
    try {
      return fn(x);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) { this.lost = true; this.dispose(); }
      throw e;
    }
  }

  feed(buf: Uint8Array): void {
    const code = this.call((x) => {
      const at = x.a2_input(this.handle, buf.length);
      if (!at) return 4;
      new Uint8Array(x.memory.buffer, at, buf.length).set(buf);
      return x.a2_feed(this.handle);
    });
    if (code) throw new Error(`Archive II decode failed: ${FEED_ERRORS[code] ?? `error ${code}`}`);
  }

  volume(): L2Volume {
    // Copied: building a sweep reuses the descriptor memory (and may grow the WebAssembly memory).
    const d = this.call((x) => descriptor(x, x.a2_volume(this.handle)).slice());
    let i = 1;
    const next = () => d[i++];
    const opt = () => { const has = next(), v = next(); return has ? v : null; };
    const volumeTimeMs = opt(), lat = opt(), lon = opt(), heightM = opt(), vcpNumber = opt();
    next(); // message 1 volume: its cuts come with each sweep
    const siteLength = next();
    const site = String.fromCharCode(...d.subarray(i, (i += siteLength)));
    if (next()) {
      const v = d.subarray(i, (i += 8));
      const cuts = Array.from({ length: next() }, (): VcpCut => {
        const c = d.subarray(i, (i += 9));
        return { elevation: c[0], waveform: c[1], superRes: c[2], sails: !!c[3], sailsSeq: c[4], mrle: !!c[5], mrleSeq: c[6], mpda: !!c[7], baseTilt: !!c[8] };
      });
      // The first valid VCP is kept for good: one object, as the reference returns.
      this.vcp ??= { pattern: v[0], sails: !!v[1], sailsCuts: v[2], mrle: !!v[3], mrleCuts: v[4], mpda: !!v[5], baseTilt: !!v[6], baseTilts: v[7], avset: null, cuts };
    }
    const sweeps: L2Sweep[] = [];
    for (let k = next(); k > 0; k--) {
      const n = next(), version = next();
      let b = this.built.get(n);
      if (b?.version !== version) this.built.set(n, (b = { version, sweep: this.sweep(n) }));
      sweeps.push(b.sweep);
    }
    return assembleVolume({ site, volumeTimeMs, lat, lon, heightM, vcpNumber, vcp: this.vcp }, this.requestedSite, sweeps);
  }

  private sweep(n: number): L2Sweep {
    return this.call((x) => {
      const at = x.a2_sweep(this.handle, n);
      if (!at) throw new Error(`Archive II decode failed: ${FEED_ERRORS[3]}`);
      const d = descriptor(x, at), buf = x.memory.buffer;
      let i = 1;
      const next = () => d[i++];
      const elevationNumber = next(), elevation = next(), legacyCut = next(), cutElevation = next(), cutWaveform = next();
      const azimuthSpacing = next(), hasNyquist = next(), nyquist = next(), hasRange = next(), range = next();
      const radials = next(), complete = !!next(), azimuthsAt = next(), elevationsAt = next(), timesAt = next();
      const moments: Partial<Record<MomentName, L2Moment>> = {};
      for (let k = next(); k > 0; k--) {
        const name = MOMENT_NAMES[next()], gates = next(), firstGateM = next(), gateSpacingM = next(), scale = next(), offset = next();
        const wordSize = next() as 8 | 16, codesAt = next(), n = radials * gates;
        const raw = wordSize === 16 ? new Uint16Array(buf, codesAt, n).slice() : new Uint8Array(buf, codesAt, n).slice();
        moments[name] = { name, gates, firstGateM, gateSpacingM, scale, offset, wordSize, raw };
      }
      const cut = this.vcp ? this.vcp.cuts[n - 1] ?? null : legacyCut ? plainCut(cutElevation, cutWaveform) : null;
      return {
        elevationNumber, elevation, nominalElevation: cut?.elevation ?? null, cut, azimuthSpacing, nyquist: hasNyquist ? nyquist : null,
        unambiguousRangeKm: hasRange ? range : null, radialCount: radials, azimuths: new Float32Array(buf, azimuthsAt, radials).slice(),
        elevations: new Float32Array(buf, elevationsAt, radials).slice(), timesMs: new Float64Array(buf, timesAt, radials).slice(), moments, complete,
      };
    });
  }

  dispose(): void {
    this.x = null;
    this.built.clear();
    openDecoders.delete(this);
  }
}

/** The f64 descriptor at `at` (its first value is its length). */
function descriptor(x: Exports, at: number): Float64Array {
  if (!at) throw new Error('Archive II decoder: no volume (failed or unknown decoder)');
  return new Float64Array(x.memory.buffer, at, new Float64Array(x.memory.buffer, at, 1)[0]);
}
