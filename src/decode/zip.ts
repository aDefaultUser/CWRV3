// Minimal ZIP reader (PKWARE APPNOTE: central directory, stored and deflate entries).
// Works in browsers and Node via the standard DecompressionStream('deflate-raw').

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number }

export function listZip(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
    out.push({ name, method, compressedSize, size, offset: local + 30 + lNameLen + lExtraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntry(buf: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const raw = buf.subarray(e.offset, e.offset + e.compressedSize);
  if (e.method === 0) return raw.slice();
  if (e.method === 8) return inflateRaw(raw);
  throw new Error(`zip: unsupported method ${e.method} for ${e.name}`);
}

/** Extracts every entry whose name matches `filter` into a name → bytes map. */
export async function unzip(buf: Uint8Array, filter: (name: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const e of listZip(buf)) if (!e.name.endsWith('/') && filter(e.name)) out.set(e.name, await readZipEntry(buf, e));
  return out;
}
