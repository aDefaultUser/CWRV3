// Storm alerts for the user's locations (GPS position and named alert points): new or upgraded NWS warnings,
// ProbSevere probabilities over per-type thresholds, NEXRAD TVS detections and projected storm arrival. Only the
// newest live data is checked (never the displayed loop time, fixtures or benchmark runs). Outputs: toast,
// synthesised tones per alert type (WebAudio), speech and OS notifications, each optional.
import { settings } from '../settings/store';
import { loadPref, savePref, isArray } from './persist';
import { toast } from '../ui/dialogs';
import { pointInRing, parseAlert, WARN_TYPES, type Alert } from '../layers/warnings';
import { fetchJson } from '../data/net';
import { psMotion, PS_TYPES, type PsFile } from '../sections/probsevere';
import type { NexradLayer } from '../layers/nexrad';

export interface Place { name: string; lon: number; lat: number }

const validPlace = (p: any): p is Place => !!p && typeof p.name === 'string' && Number.isFinite(p.lon) && Number.isFinite(p.lat);
/** Named alert points (Storm Alerts dialog; added with a map click), one preference. */
export const alertPoints = {
  list: loadPref<Place[]>('alertPoints', [], isArray).filter(validPlace),
  add(p: Place) { this.list.push(p); return savePref('alertPoints', this.list, 'alert points'); },
  rename(i: number, name: string) { if (this.list[i]) this.list[i].name = name; return savePref('alertPoints', this.list, 'alert points'); },
  remove(i: number) { this.list.splice(i, 1); return savePref('alertPoints', this.list, 'alert points'); },
};

export type Tone = 'tornado' | 'severe' | 'flood' | 'winter' | 'probsevere' | 'tvs' | 'arrival';
export interface AlertEvent {
  /** Identity of the event at one place; repeated only when `level` gains bits not alerted before. */
  key: string; level: number; tone: Tone; title: string; text: string;
}
export interface AlertContext { places: Place[]; radiusKm: number; now: number; dist: (km: number) => string }

// ------------------------------------------------------------------------------------------- geometry
const KM_LAT = 110.574, KM_LON = 111.32;
/** Local plane (km) centred on a point. */
const plane = (lon0: number, lat0: number) => { const kx = KM_LON * Math.cos((lat0 * Math.PI) / 180); return (lon: number, lat: number): [number, number] => [(lon - lon0) * kx, (lat - lat0) * KM_LAT]; };

/** Distance (km) from a point to polygons given as lon/lat rings: 0 inside, else to the nearest edge. */
export function distanceToRingsKm(lon: number, lat: number, rings: number[][]): number {
  if (rings.some((r) => pointInRing(lon, lat, r))) return 0;
  const xy = plane(lon, lat);
  let best = Infinity;
  for (const r of rings) for (let i = 0; i + 3 < r.length; i += 2) {
    const [ax, ay] = xy(r[i], r[i + 1]), [bx, by] = xy(r[i + 2], r[i + 3]);
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
  }
  return best;
}

/**
 * Minutes from `now` until a point moving with (east, north) km/min, at (lon, lat) at time t0, comes within
 * `radiusKm` of the place, if that happens within `horizonMin`; 0 when it is already within the radius.
 */
export function arrivalMinutes(m: { lon: number; lat: number; eastKmMin: number; northKmMin: number; t0: number }, place: Place, radiusKm: number, now: number, horizonMin: number): number | null {
  const [px, py] = plane(place.lon, place.lat)(m.lon, m.lat);
  const t0 = Math.max(0, (now - m.t0) / 60e3), t1 = t0 + horizonMin;
  // |p + v·t|² ≤ R²  ⇔  a·t² + b·t + c ≤ 0
  const a = m.eastKmMin ** 2 + m.northKmMin ** 2, b = 2 * (px * m.eastKmMin + py * m.northKmMin), c = px * px + py * py - radiusKm * radiusKm;
  if (a === 0) return c <= 0 ? 0 : null;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const enter = (-b - Math.sqrt(disc)) / (2 * a), leave = (-b + Math.sqrt(disc)) / (2 * a);
  const at = Math.max(enter, t0);
  return at <= Math.min(leave, t1) ? at - t0 : null;
}

// ------------------------------------------------------------------------------------------- triggers
export const ALERT_WARNINGS: Record<string, Tone> = { TOR: 'tornado', EWW: 'tornado', SVR: 'severe', FFW: 'flood', SQW: 'winter' };
/** Warning tags as level bits; a message that adds a tag is an upgrade (bit 0 = the warning itself). */
export const WARNING_TAGS = ['', 'TORNADO POSSIBLE', 'TORNADO OBSERVED', 'CONSIDERABLE DAMAGE', 'DESTRUCTIVE DAMAGE', 'PDS', 'EMERGENCY'] as const;
export function warningLevel(a: Alert): number {
  const text = `${a.headline}\n${a.description}`.toUpperCase(), d = a.damage.toUpperCase(), tor = a.tornado.toUpperCase();
  const tags = [true, tor === 'POSSIBLE', tor === 'OBSERVED', d === 'CONSIDERABLE', d === 'DESTRUCTIVE', a.pds,
    d === 'CATASTROPHIC' || /TORNADO EMERGENCY|FLASH FLOOD EMERGENCY/.test(text)];
  return tags.reduce((m, on, i) => (on ? m | (1 << i) : m), 0);
}
export const levelTags = (level: number) => WARNING_TAGS.filter((t, i) => t && level & (1 << i));

/** NWS warnings (TOR SVR FFW SQW EWW) in effect whose polygon contains a place or lies within the radius. */
export function warningEvents(alerts: Alert[], c: AlertContext): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const a of alerts) {
    const code = a.type?.code ?? '';
    if (!(code in ALERT_WARNINGS) || !a.rings.length || !(a.sent <= c.now && c.now < a.ends)) continue;
    const level = warningLevel(a), tags = levelTags(level);
    // Updates of one warning share the office and event tracking number.
    const id = a.etn ? `${code}.${a.wfo}.${a.etn}` : a.id;
    for (const p of c.places) {
      const d = distanceToRingsKm(p.lon, p.lat, a.rings);
      if (d > c.radiusKm) continue;
      const where = d === 0 ? `for ${p.name}` : `${c.dist(d)} from ${p.name}`;
      out.push({ key: `w:${id}@${p.name}`, level, tone: ALERT_WARNINGS[code], title: `${a.event}${tags.length ? ` (${tags.join(', ')})` : ''}`,
        text: `${a.event} ${where}${tags.length ? `, ${tags.join(', ').toLowerCase()}` : ''}, until ${new Date(a.ends).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` });
    }
  }
  return out;
}

/** ProbTor / ProbHail / ProbWind at or above the thresholds (percent, PS_TYPES 1..3) for an object within the radius. */
export function probSevereEvents(file: PsFile, thresholds: [number, number, number], c: AlertContext): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const o of file.objects) for (let k = 1; k <= 3; k++) {
    const p = o.prob[k];
    if (!(p >= thresholds[k - 1])) continue;
    // 10 % bands: a higher band is an upgrade.
    const level = (2 << Math.floor(p / 10)) - 1;
    for (const pl of c.places) {
      const d = distanceToRingsKm(pl.lon, pl.lat, o.rings);
      if (d > c.radiusKm) continue;
      const name = PS_TYPES[k].label.toLowerCase();
      out.push({ key: `ps:${o.id}:${k}@${pl.name}`, level, tone: 'probsevere', title: `ProbSevere ${name} ${p}%`,
        text: `ProbSevere ${name} probability ${p} percent for a storm ${d === 0 ? `over ${pl.name}` : `${c.dist(d)} from ${pl.name}`}.` });
    }
  }
  return out;
}

/** NEXRAD storm attributes the alerts use (see nexradStorms). */
export interface StormAttributes {
  site: string; timeMs: number;
  cells: { id: string; lon: number; lat: number; fromDeg: number; speedKt: number }[];
  tvs: { id: string; lon: number; lat: number }[];
}
export function tvsEvents(s: StormAttributes, c: AlertContext): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const v of s.tvs) for (const p of c.places) {
    const d = Math.hypot(...plane(p.lon, p.lat)(v.lon, v.lat));
    if (d <= c.radiusKm) out.push({ key: `tvs:${s.site}:${v.id}@${p.name}`, level: 1, tone: 'tvs', title: `${s.site} TVS near ${p.name}`, text: `Radar ${s.site} tornado vortex signature ${c.dist(d)} from ${p.name}.` });
  }
  return out;
}

export interface Mover { key: string; label: string; lon: number; lat: number; eastKmMin: number; northKmMin: number; t0: number }
/** Storms whose projected track comes within the radius of a place within `horizonMin` minutes. */
export function arrivalEvents(movers: Mover[], horizonMin: number, c: AlertContext): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const m of movers) for (const p of c.places) {
    const eta = arrivalMinutes(m, p, c.radiusKm, c.now, horizonMin);
    if (eta === null) continue;
    out.push({ key: `eta:${m.key}@${p.name}`, level: 1, tone: 'arrival', title: `Storm arriving: ${p.name}`,
      text: eta < 1 ? `${m.label} is within ${c.dist(c.radiusKm)} of ${p.name} now.` : `${m.label} expected within ${c.dist(c.radiusKm)} of ${p.name} in about ${Math.round(eta)} minutes.` });
  }
  return out;
}
export function cellMovers(s: StormAttributes): Mover[] {
  return s.cells.filter((x) => x.speedKt > 0).map((x) => {
    const b = (((x.fromDeg + 180) % 360) * Math.PI) / 180, v = (x.speedKt * 1.852) / 60;
    return { key: `cell:${s.site}:${x.id}`, label: `${s.site} storm cell ${x.id}`, lon: x.lon, lat: x.lat, eastKmMin: Math.sin(b) * v, northKmMin: Math.cos(b) * v, t0: s.timeMs };
  });
}
export function probSevereMovers(f: PsFile, minProb: number): Mover[] {
  return f.objects.filter((o) => o.prob[0] >= minProb && (psMotion(o)?.speedKt ?? 0) >= 2).map((o) => ({
    key: `ps:${o.id}`, label: `ProbSevere storm ${o.id} (${o.prob[0]}%)`, lon: o.lon, lat: o.lat, eastKmMin: (o.motionE * 60) / 1000, northKmMin: (o.motionN * 60) / 1000, t0: f.t,
  }));
}

/** Remembers alerted events: an event fires once, again only when its level gains bits; forgotten after 3 h unseen. */
export class AlertMemory {
  private seen = new Map<string, { bits: number; at: number }>();
  admit(events: AlertEvent[], now: number): AlertEvent[] {
    const out: AlertEvent[] = [];
    for (const e of events) {
      const s = this.seen.get(e.key);
      if (!s || e.level & ~s.bits) out.push(e);
      this.seen.set(e.key, { bits: (s?.bits ?? 0) | e.level, at: now });
    }
    for (const [k, s] of this.seen) if (now - s.at > 3 * 3600e3) this.seen.delete(k);
    return out;
  }
}

// ------------------------------------------------------------------------------------------- NEXRAD adapter
const KM_DEG = 111.2;
/**
 * The one place alerts read NEXRAD storm attributes: the selected site's newest volume (not the frame on screen), from
 * the Level 3 overlays that are switched on (storm tracks for arrival, TVS icons for TVS). Null for fixtures and for
 * products older than 15 minutes.
 */
export function nexradStorms(n: NexradLayer, now = Date.now()): StormAttributes | null {
  const s = n.siteInfo(), a = n.latestStormAttributes();
  if (!s || !a || a.site !== s.id || n.fixture || now - a.volumeTimeMs > 15 * 60e3) return null;
  const ll = (x: number, y: number) => ({ lon: s.lon + x / (KM_DEG * Math.cos((s.lat * Math.PI) / 180)), lat: s.lat + y / KM_DEG });
  const cells = a.cells ?? [];
  return {
    site: s.id, timeMs: a.volumeTimeMs,
    cells: cells.filter((c) => c.dir === c.dir && c.speed === c.speed).map((c) => ({ id: c.id, ...ll(c.x, c.y), fromDeg: c.dir, speedKt: c.speed })),
    tvs: (a.tvs ?? []).map((t: { x: number; y: number }) => {
      const cell = cells.find((c) => Math.hypot(t.x - c.x, t.y - c.y) < 6), p = ll(t.x, t.y);
      return { id: cell?.id ?? `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`, ...p };
    }),
  };
}

// ------------------------------------------------------------------------------------------- outputs
/** Tone patterns: [frequency Hz, duration ms] per note, a rest of 60 ms between notes (synthesised, no sound files). */
const TONES: Record<Tone, [number, number][]> = {
  tornado: [[960, 180], [770, 180], [960, 180], [770, 180], [960, 180], [770, 180]],
  severe: [[880, 150], [880, 150], [880, 150]],
  flood: [[440, 400], [440, 400]],
  winter: [[660, 160], [880, 160], [990, 240]],
  probsevere: [[523, 140], [659, 140], [784, 220]],
  tvs: [[1200, 80], [1200, 80], [1200, 80], [1200, 80], [1200, 80]],
  arrival: [[784, 220], [523, 320]],
};
/** Most severe first: one poll that fires several alerts plays only the first tone of this order. */
export const TONE_ORDER: Tone[] = ['tornado', 'tvs', 'severe', 'flood', 'winter', 'probsevere', 'arrival'];
let audio: AudioContext | null = null;
/** Creates or resumes the audio context; browsers allow that only during a user gesture. */
export function unlockAudio() {
  if (typeof AudioContext === 'undefined') return;
  audio ??= new AudioContext();
  if (audio.state === 'suspended') audio.resume().catch(() => {});
}
export function playTone(tone: Tone) {
  if (!audio) return;
  let t = audio.currentTime + 0.02;
  for (const [f, ms] of TONES[tone]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.01); g.gain.setValueAtTime(0.12, t + ms / 1000 - 0.02); g.gain.linearRampToValueAtTime(0, t + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + ms / 1000);
    t += ms / 1000 + 0.06;
  }
}
/** Asks for OS notification permission (call from the click that enables it); resolves true when granted. */
export async function requestNotify(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  return (Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()) === 'granted';
}

/** Active TOR/SVR/FFW/SQW/EWW messages from the NWS API (live by definition). */
export async function fetchActiveWarnings(): Promise<Alert[]> {
  const events = WARN_TYPES.filter((w) => w.code in ALERT_WARNINGS).map((w) => w.event).join(',');
  const j = await fetchJson<{ features: unknown[] }>(`https://api.weather.gov/alerts/active?event=${encodeURIComponent(events)}`, { cache: 'none' });
  return j.features.map(parseAlert);
}

export interface AlertSources {
  /** Active NWS warnings (live API). */
  warnings(): Promise<Alert[]>;
  probSevere(): PsFile | null;
  storms(): StormAttributes | null;
  gps(): Place | null;
  /** False for fixture/benchmark runs. */
  live(): boolean;
}

const on = (k: string) => settings.bool(`ext.config.alerts${k}`);

/** Polls the live sources every 30 s and sends new or upgraded events to the enabled outputs. */
export class AlertCenter {
  readonly memory = new AlertMemory();
  status = 'Off';
  last: string[] = [];
  private warnings: { at: number; list: Alert[] } = { at: 0, list: [] };
  private busy = false;
  constructor(private src: AlertSources) {}

  start() {
    setInterval(() => void this.poll(), 30_000);
    // Tones need a running audio context; the first click after a reload resumes it.
    if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => { if (on('On') && on('Sound')) unlockAudio(); });
  }

  places(): Place[] {
    const g = on('UseGps') ? this.src.gps() : null;
    return [...(g ? [g] : []), ...alertPoints.list];
  }
  radiusKm() { return settings.num('ext.config.alertsRadiusKm'); }
  dist(km: number) { return settings.bool('config.distanceMeasureImperial') ? `${(km / 1.609344).toFixed(km < 16 ? 1 : 0)} mi` : `${km.toFixed(km < 10 ? 1 : 0)} km`; }

  async poll(now = Date.now()): Promise<AlertEvent[]> {
    if (!on('On')) { this.status = 'Off'; return []; }
    if (!this.src.live()) { this.status = 'Paused: fixture or benchmark data is not live'; return []; }
    if (this.busy) return [];
    this.busy = true;
    try {
      const c: AlertContext = { places: this.places(), radiusKm: this.radiusKm(), now, dist: (km) => this.dist(km) };
      const notes: string[] = [], events: AlertEvent[] = [];
      if (on('Warnings')) {
        if (now - this.warnings.at > 55e3) {
          try { this.warnings = { at: now, list: await this.src.warnings() }; } catch (e) { notes.push(`NWS warnings unavailable (${(e as Error).message})`); }
        }
        events.push(...warningEvents(this.warnings.list, c));
      }
      const ps = on('ProbSevere') || on('Arrival') ? this.src.probSevere() : null;
      if (on('ProbSevere')) {
        if (ps) events.push(...probSevereEvents(ps, [settings.num('ext.config.alertsProbTor'), settings.num('ext.config.alertsProbHail'), settings.num('ext.config.alertsProbWind')], c));
        else notes.push('no live ProbSevere file');
      }
      const storms = on('Tvs') || on('Arrival') ? this.src.storms() : null;
      if (on('Tvs')) { if (storms) events.push(...tvsEvents(storms, c)); else notes.push('no live NEXRAD storm products (turn on storm tracks / TVS icons)'); }
      if (on('Arrival')) {
        const movers = [...(storms ? cellMovers(storms) : []), ...(ps ? probSevereMovers(ps, settings.num('ext.config.alertsArrivalMinProb')) : [])];
        events.push(...arrivalEvents(movers, settings.num('ext.config.alertsArrivalMinutes'), c));
      }
      const fired = this.memory.admit(events, now);
      for (const e of fired) this.emit(e);
      if (fired.length && on('Sound')) playTone(TONE_ORDER.find((t) => fired.some((e) => e.tone === t))!);
      this.status = `Checked ${new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}: ${c.places.length} location(s), ${events.length} active match(es)${notes.length ? `; ${notes.join('; ')}` : ''}`;
      if (!c.places.length) this.status += ' — add an alert point or use GPS';
      return fired;
    } finally { this.busy = false; }
  }

  emit(e: AlertEvent) {
    this.last = [`${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${e.text}`, ...this.last].slice(0, 8);
    if (on('Toast')) toast(`ALERT: ${e.text}`, 10_000);
    if (on('Speech') && typeof speechSynthesis !== 'undefined') speechSynthesis.speak(new SpeechSynthesisUtterance(e.text));
    if (on('Notify') && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(e.title, { body: e.text, tag: e.key });
  }

  /** Test button: one sample alert through every enabled output (also unlocks audio during the click). */
  test() {
    unlockAudio();
    if (!['Toast', 'Sound', 'Speech', 'Notify'].some(on)) { toast('All alert outputs are off'); return; }
    this.emit({ key: 'test', level: 1, tone: 'tornado', title: 'CWRV3 test alert', text: 'Test alert. Storm alerts are working.' });
    if (on('Sound')) playTone('tornado');
  }
}
