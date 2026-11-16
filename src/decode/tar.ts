// POSIX ustar / GNU tar reader (regular files only), for WPC (.tar) and NWPS (.tgz) shapefile archives.
export function untar(buf: Uint8Array, filter: (name: string) => boolean = () => true): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const str = (o: number, n: number) => { let s = ''; for (let i = 0; i < n && buf[o + i]; i++) s += String.fromCharCode(buf[o + i]); return s; };
  let p = 0, longName: string | null = null;
  while (p + 512 <= buf.length) {
    if (buf[p] === 0 && buf[p + 1] === 0) break;
    let name = str(p, 100);
    const size = parseInt(str(p + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[p + 156] || 48);
    const prefix = str(p + 345, 155);
    if (prefix && str(p + 257, 5) === 'ustar') name = `${prefix}/${name}`;
    const data = p + 512;
    if (type === 'L') longName = str(data, size);
    else {
      if (longName) { name = longName; longName = null; }
      if ((type === '0' || type === '\0' || type === '7') && filter(name)) out.set(name, buf.slice(data, data + size));
    }
    p = data + Math.ceil(size / 512) * 512;
  }
  return out;
}
