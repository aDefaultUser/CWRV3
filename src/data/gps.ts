// GPS receiver link (GPS Connection dialog): NMEA 0183 over the Web Serial API (Chromium), or the
// browser Geolocation API as a substitute. Only GGA (fix, altitude, satellites) and RMC (speed, course, magnetic
// variation, time) sentences are used; sentences with a bad checksum are ignored.

export interface GpsFix {
  lat: number | null; lon: number | null; altM: number | null; sats: number | null;
  speedKt: number | null; headingDeg: number | null; magVarDeg: number | null; fixMs: number | null; source: 'serial' | 'geolocation' | null;
}
export const emptyFix = (): GpsFix => ({ lat: null, lon: null, altM: null, sats: null, speedKt: null, headingDeg: null, magVarDeg: null, fixMs: null, source: null });

/** NMEA checksum: XOR of the characters between '$' and '*'. Sentences without a checksum are accepted. */
export function nmeaValid(line: string): boolean {
  const m = /^\$([^*]*)(?:\*([0-9A-Fa-f]{2}))?\s*$/.exec(line);
  if (!m) return false;
  if (!m[2]) return true;
  let x = 0;
  for (let i = 0; i < m[1].length; i++) x ^= m[1].charCodeAt(i);
  return x === parseInt(m[2], 16);
}

/** ddmm.mmmm + hemisphere → signed degrees. */
function coord(v: string, hemi: string, degDigits: number): number | null {
  if (!v) return null;
  const d = Number(v.slice(0, degDigits)), m = Number(v.slice(degDigits));
  if (!Number.isFinite(d) || !Number.isFinite(m)) return null;
  const x = d + m / 60;
  return hemi === 'S' || hemi === 'W' ? -x : x;
}
/** hhmmss(.ss) [+ ddmmyy] → epoch ms (UTC); the date defaults to the current UTC day. */
function time(hms: string, dmy?: string): number | null {
  if (hms.length < 6) return null;
  const now = new Date();
  // Two-digit years pivot at 80 (80–99 → 19xx), as receivers report.
  const yy = dmy ? Number(dmy.slice(4, 6)) : 0;
  const [Y, M, D] = dmy && dmy.length === 6 ? [yy >= 80 ? 1900 + yy : 2000 + yy, Number(dmy.slice(2, 4)) - 1, Number(dmy.slice(0, 2))] : [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
  return Date.UTC(Y, M, D, Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), 0) + Number(hms.slice(4)) * 1000;
}

/** Applies one NMEA sentence to the fix; returns true when it changed. */
export function applyNmea(fix: GpsFix, line: string): boolean {
  const s = line.trim();
  if (!nmeaValid(s)) return false;
  const f = s.slice(1).split('*')[0].split(',');
  const type = f[0].slice(2);
  if (type === 'GGA') {
    if (f[6] === '0' || !f[2]) return false; // no fix
    fix.lat = coord(f[2], f[3], 2); fix.lon = coord(f[4], f[5], 3);
    fix.sats = f[7] ? Number(f[7]) : fix.sats;
    fix.altM = f[9] ? Number(f[9]) : fix.altM;
    fix.fixMs = time(f[1]) ?? fix.fixMs;
    fix.source = 'serial';
    return true;
  }
  if (type === 'RMC') {
    if (f[2] !== 'A') return false; // void
    fix.lat = coord(f[3], f[4], 2); fix.lon = coord(f[5], f[6], 3);
    fix.speedKt = f[7] ? Number(f[7]) : fix.speedKt;
    fix.headingDeg = f[8] ? Number(f[8]) : fix.headingDeg;
    fix.magVarDeg = f[10] ? Number(f[10]) * (f[11] === 'W' ? -1 : 1) : fix.magVarDeg;
    fix.fixMs = time(f[1], f[9]) ?? fix.fixMs;
    fix.source = 'serial';
    return true;
  }
  return false;
}

export interface SerialOptions { baudRate: number; dataBits: 7 | 8; stopBits: 1 | 2; parity: 'none' | 'even' | 'odd'; flowControl: 'none' | 'hardware' }

interface SerialPortLike { open(o: Record<string, unknown>): Promise<void>; close(): Promise<void>; readable: ReadableStream<Uint8Array> | null }
type NavigatorSerial = Navigator & { serial?: { requestPort(): Promise<SerialPortLike> } };

/** A live GPS link; `onUpdate` fires after each accepted sentence or position. */
export class GpsLink {
  fix = emptyFix();
  raw: string[] = [];
  status = 'Not connected';
  connected = false;
  onUpdate: () => void = () => {};
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private watch: number | null = null;

  static serialAvailable() { return !!(navigator as NavigatorSerial).serial; }

  async connectSerial(o: SerialOptions) {
    await this.disconnect();
    const serial = (navigator as NavigatorSerial).serial;
    if (!serial) throw new Error('Web Serial is not available in this browser (use a Chromium-based browser, or the browser location)');
    this.port = await serial.requestPort();
    await this.port.open({ baudRate: o.baudRate, dataBits: o.dataBits, stopBits: o.stopBits, parity: o.parity, flowControl: o.flowControl });
    this.connected = true; this.status = `Connected at ${o.baudRate} baud`; this.onUpdate();
    const text = this.port.readable!.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>);
    this.reader = text.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (!line) continue;
          this.raw.push(line); if (this.raw.length > 60) this.raw.shift();
          applyNmea(this.fix, line);
          this.onUpdate();
        }
        if (buf.length > 4096) buf = '';
      }
    } catch (e) { this.status = `Serial read error: ${(e as Error).message}`; }
    finally { this.connected = false; this.onUpdate(); }
  }

  connectGeolocation() {
    void this.disconnect();
    if (!('geolocation' in navigator)) throw new Error('Geolocation is not available');
    this.status = 'Waiting for browser location…'; this.connected = true;
    this.watch = navigator.geolocation.watchPosition((p) => {
      const c = p.coords;
      Object.assign(this.fix, { lat: c.latitude, lon: c.longitude, altM: c.altitude, sats: null, speedKt: c.speed !== null ? c.speed * 1.943844 : null, headingDeg: c.heading, magVarDeg: null, fixMs: p.timestamp, source: 'geolocation' });
      this.status = `Browser location (±${Math.round(c.accuracy)} m)`;
      this.onUpdate();
    }, (e) => { this.status = `Location error: ${e.message}`; this.connected = false; this.onUpdate(); }, { enableHighAccuracy: true });
    this.onUpdate();
  }

  async disconnect() {
    if (this.watch !== null) { navigator.geolocation.clearWatch(this.watch); this.watch = null; }
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { await this.port?.close(); } catch { /* already closed */ }
    this.reader = null; this.port = null;
    if (this.connected) { this.connected = false; this.status = 'Disconnected'; this.onUpdate(); }
  }
}
