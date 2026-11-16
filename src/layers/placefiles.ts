// Placefiles: GRLevelX-format placefiles from URLs or local files, parsed with the
// original's error strings, refreshed per RefreshSeconds / Refresh, view threshold, time range, colours, fonts,
// icons (icon sheets), text, Object blocks with pixel offsets, lines, triangles and polygons. The list persists
// (placefiles.dat). Image commands are reported as unsupported in the parser log rather than drawn wrongly.
import type { DrawContext, Renderer } from '../render/renderer';
import { MapLayer } from './base';
import { LineSet, TextSet, SpriteAtlas, SpriteSet, loadImage, type GlyphAtlas, type Polyline, type Label, type Color } from '../render/prims';
import { PolySet, type PolyFill, type FillStyle } from '../render/polys';
import { fetchText } from '../data/net';
import { settings } from '../settings/store';
import { timeline } from '../app/timeline';
import { lonLatToXYZ } from '../render/camera';
import { loadPref, savePref, isArray } from '../app/persist';

export interface PfLine { width: number; color: Color; pts: number[]; hover: string; offset?: [number, number][] }
export interface PfText { lon: number; lat: number; text: string; color: Color; font: number; hover: string; dx: number; dy: number }
export interface PfIcon { lon: number; lat: number; angle: number; file: number; icon: number; hover: string; dx: number; dy: number }
export interface PfTris { pts: number[]; colors: Color[] }
export interface Placefile {
  title: string; refreshSec: number; threshold: number; timeRange: [number, number] | null;
  lines: PfLine[]; texts: PfText[]; icons: PfIcon[]; tris: PfTris[];
  iconFiles: Map<number, { w: number; h: number; hx: number; hy: number; url: string }>;
  fonts: Map<number, { px: number; flags: number; face: string }>;
  errors: string[];
}

const unq = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');
/** Splits a command argument list on commas outside quotes. */
function args(s: string): string[] { const out: string[] = []; let cur = '', q = false; for (const ch of s) { if (ch === '"') q = !q; if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; }

/** Parses a placefile (public GRLevelX placefile format). Errors use the original's message forms. */
export function parsePlacefile(text: string): Placefile {
  const pf: Placefile = { title: '', refreshSec: 0, threshold: 999, timeRange: null, lines: [], texts: [], icons: [], tris: [], iconFiles: new Map(), fonts: new Map(), errors: [] };
  let color: Color = [255, 255, 255, 255];
  let block: { kind: 'line' | 'tris' | 'polygon' | 'image' | 'object'; n: number; line?: PfLine; tris?: PfTris } | null = null;
  let obj: { lat: number; lon: number } | null = null;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const n = i + 1;
    const l = raw.replace(/^\s+/, '');
    if (!l || l.startsWith(';')) return;
    const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(l);
    const cmd = m?.[1].toLowerCase() ?? '';
    const rest = m?.[2] ?? '';
    if (block && block.kind !== 'object' && !m && !/^End\b/i.test(l)) {
      // Vertex lines inside Line / Triangles / Polygon / Image blocks: lat,lon[,r,g,b,a] or pixel offsets in Objects.
      const a = args(l).map(Number);
      if (a.length < 2 || a.slice(0, 2).some((x) => !Number.isFinite(x))) { pf.errors.push(`Error: ${block.kind === 'line' ? 'Line' : block.kind === 'tris' ? 'Triangles' : 'Polygon'} - bad data section. (line ${n})`); return; }
      const [la, lo] = obj ? [obj.lat, obj.lon] : [a[0], a[1]];
      const off = obj ? [a[1], -a[0]] as [number, number] : null; // inside Object: x,y pixel offsets
      if (block.kind === 'line' && block.line) { block.line.pts.push(lo, la); if (off) (block.line.offset ??= []).push(off); }
      else if ((block.kind === 'tris' || block.kind === 'polygon') && block.tris) {
        block.tris.pts.push(lo, la);
        block.tris.colors.push(a.length >= 5 ? [a[2], a[3], a[4], a.length >= 6 ? a[5] : 255] as Color : color);
      }
      return;
    }
    if (/^End\b/i.test(l)) {
      if (!block && !obj) { pf.errors.push(`Warning: Apparently extraneous End: statement. (line ${n})`); return; }
      if (block?.kind === 'line' && block.line) { if (block.line.pts.length >= 4) pf.lines.push(block.line); }
      else if (block?.kind === 'tris' && block.tris) { if (block.tris.pts.length % 6) pf.errors.push(`Error tesselating vertices at command ${block.n}`); else pf.tris.push(block.tris); }
      else if (block?.kind === 'polygon' && block.tris) pf.tris.push(polyToTris(block.tris, pf, block.n));
      if (block) block = null; else obj = null;
      return;
    }
    const a = args(rest);
    switch (cmd) {
      case 'title': pf.title = rest.trim(); break;
      case 'refresh': pf.refreshSec = Number(rest) * 60; break;
      case 'refreshseconds': pf.refreshSec = Number(rest); break;
      case 'threshold': pf.threshold = Number(rest) || 999; break;
      case 'timerange': { const t = rest.trim().split(/\s+/).map((x) => Date.parse(x)); pf.timeRange = t.length === 2 && t.every(Number.isFinite) ? [t[0], t[1]] : null; if (!pf.timeRange) pf.errors.push(`Error: TimeRange - bad data section. (line ${n})`); break; }
      case 'color': { const c = rest.trim().split(/[\s,]+/).map(Number); if (c.length < 3 || c.some((x) => !Number.isFinite(x))) pf.errors.push(`Error: Color - bad data section. (line ${n})`); else color = [c[0], c[1], c[2], c.length > 3 ? c[3] : 255]; break; }
      case 'iconfile': { const k = Number(a[0]); if (a.length < 6) { pf.errors.push(`Error: IconFile - bad data section. (line ${n})`); break; } pf.iconFiles.set(k, { w: Number(a[1]), h: Number(a[2]), hx: Number(a[3]), hy: Number(a[4]), url: unq(a[5]) }); break; }
      case 'font': { if (a.length < 4) { pf.errors.push(`Error: Font - bad data section. (line ${n})`); break; } pf.fonts.set(Number(a[0]), { px: Number(a[1]), flags: Number(a[2]), face: unq(a[3]) }); break; }
      case 'icon': {
        if (a.length < 5) { pf.errors.push(`Error: Icon - bad data section. (line ${n})`); break; }
        const [la, lo] = obj ? [obj.lat, obj.lon] : [Number(a[0]), Number(a[1])];
        pf.icons.push({ lat: la, lon: lo, angle: Number(a[2]), file: Number(a[3]), icon: Number(a[4]), hover: unq(a[5] ?? ''), dx: obj ? Number(a[1]) : 0, dy: obj ? -Number(a[0]) : 0 });
        break;
      }
      case 'text': {
        if (a.length < 4) { pf.errors.push(`Error: Text - bad data section. (line ${n})`); break; }
        const [la, lo] = obj ? [obj.lat, obj.lon] : [Number(a[0]), Number(a[1])];
        pf.texts.push({ lat: la, lon: lo, font: Number(a[2]), text: unq(a[3]).replace(/\\n/g, ' '), hover: unq(a[4] ?? ''), color, dx: obj ? Number(a[1]) : 0, dy: obj ? -Number(a[0]) : 0 });
        break;
      }
      case 'place': { if (a.length < 3) { pf.errors.push(`Error: Place - bad data section. (line ${n})`); break; } pf.texts.push({ lat: Number(a[0]), lon: Number(a[1]), font: 1, text: unq(a[2]), hover: '', color, dx: 0, dy: 0 }); break; }
      case 'object': { obj = { lat: Number(a[0]), lon: Number(a[1]) }; if (!Number.isFinite(obj.lat)) { pf.errors.push(`Error: Object - bad data section. (line ${n})`); obj = null; } break; }
      case 'line': block = { kind: 'line', n, line: { width: Number(a[0]) || 1, color, pts: [], hover: unq(a[2] ?? '') } }; break;
      case 'triangles': block = { kind: 'tris', n, tris: { pts: [], colors: [] } }; break;
      case 'polygon': block = { kind: 'polygon', n, tris: { pts: [], colors: [] } }; break;
      case 'image': block = { kind: 'image', n }; pf.errors.push(`Warning: Image command at line ${n} is not drawn by this build (textured image quads are not supported).`); break;
      default: if (m) pf.errors.push(`Warning: unknown command "${m[1]}" at line ${n}`); else pf.errors.push(`Error: unrecognized line ${n}`);
    }
  });
  if (block) pf.errors.push('Error: missing End: statement at end of file.');
  return pf;
}

function polyToTris(t: PfTris, pf: Placefile, n: number): PfTris {
  // Fan triangulation (placefile polygons are simple rings); concave rings are reported.
  const out: PfTris = { pts: [], colors: [] };
  const k = t.pts.length / 2;
  if (k < 3) { pf.errors.push(`Error tesselating vertices at command ${n}`); return out; }
  for (let i = 1; i + 1 < k; i++) for (const j of [0, i, i + 1]) { out.pts.push(t.pts[j * 2], t.pts[j * 2 + 1]); out.colors.push(t.colors[j] ?? t.colors[0]); }
  return out;
}

export interface PlacefileEntry { url: string; name: string; hidden: boolean; pf: Placefile | null; at: number; error: string }
const LIST_KEY = 'placefiles';

export class PlacefileLayer extends MapLayer {
  readonly id = 'placefiles';
  readonly title = 'Placefiles';
  entries: PlacefileEntry[] = [];
  selected = -1;
  /** "Ignore view thresholds" = not obeying the files' Threshold zoom limits (config.placefileUseThreshold). */
  get ignoreThresholds() { return !settings.bool('config.placefileUseThreshold'); }
  set ignoreThresholds(v: boolean) { settings.set('config.placefileUseThreshold', !v); this.key = ''; }
  private lines: LineSet; private polys: PolySet; private text: TextSet; private sprites: SpriteSet; private atlas: SpriteAtlas;
  private key = '';
  constructor(r: Renderer, glyphs: GlyphAtlas) {
    super(r);
    this.lines = new LineSet(r); this.polys = new PolySet(r); this.text = new TextSet(r, glyphs); this.atlas = new SpriteAtlas(r); this.sprites = new SpriteSet(r, this.atlas);
    this.entries = loadPref<{ url: string; name: string; hidden: boolean }[]>(LIST_KEY, [], isArray).map((e) => ({ ...e, pf: null, at: 0, error: '' }));
  }
  enabled() { return this.entries.some((e) => !e.hidden && e.pf); }
  private persist() { return savePref(LIST_KEY, this.entries.filter((e) => !e.url.startsWith('blob:')).map(({ url, name, hidden }) => ({ url, name, hidden })), 'placefile list'); }
  add(url: string, name = url) { if (!this.entries.some((e) => e.url === url)) { this.entries.push({ url, name, hidden: false, pf: null, at: 0, error: '' }); this.selected = this.entries.length - 1; this.persist(); } return this.load(this.entries.find((e) => e.url === url)!); }
  remove(i: number) { this.entries.splice(i, 1); this.selected = -1; this.persist(); this.key = ''; }
  toggleHidden(i: number) { const e = this.entries[i]; if (e) { e.hidden = !e.hidden; this.persist(); this.key = ''; } }
  async load(e: PlacefileEntry) {
    try { e.pf = parsePlacefile(await (e.url.startsWith('blob:') ? (await fetch(e.url)).text() : fetchText(e.url))); e.at = Date.now(); e.error = ''; if (e.pf.title) e.name = e.pf.title; this.persist(); }
    catch (err) { e.error = (err as Error).message; }
    this.key = '';
  }
  async refresh() {
    // Load at start; then per the file's refresh interval (RefreshSeconds / Refresh minutes).
    // Without "Load placefiles at start", saved entries wait for an explicit Load in the manager (e.at stays 0).
    for (const e of this.entries) {
      if (e.hidden) continue;
      const due = e.pf ? e.pf.refreshSec > 0 && Date.now() - e.at > e.pf.refreshSec * 1000 : e.at > 0 || settings.bool('config.placefileLoadAtStart');
      if (due) await this.load(e);
    }
    this.setStatus(this.entries.length ? 'ready' : 'off', `${this.entries.filter((e) => e.pf).length} placefiles`);
  }
  tick(t: number) {
    const camNm = this.r.camera.altitudeKm / 1.852;
    const vis = this.entries.filter((e) => e.pf && !e.hidden && (this.ignoreThresholds || camNm <= e.pf.threshold) && (!e.pf.timeRange || (t >= e.pf.timeRange[0] && t <= e.pf.timeRange[1])));
    const key = vis.map((e) => `${e.url}@${e.at}`).join('|') + `|${Math.floor(camNm / 50)}`;
    if (key === this.key) return;
    this.key = key;
    const styles: { color: Color; width: number }[] = [], idx = new Map<string, number>();
    const sty = (c: Color, w: number) => { const k = `${c}|${w}`; let i = idx.get(k); if (i === undefined) { i = styles.length; styles.push({ color: c, width: w }); idx.set(k, i); } return i; };
    const lines: Polyline[] = [], polys: PolyFill[] = [], labels: Label[] = [];
    const fills: FillStyle[] = [], fIdx = new Map<string, number>();
    const fsty = (c: Color) => { const k = String(c); let i = fIdx.get(k); if (i === undefined) { i = fills.length; fills.push({ color: c }); fIdx.set(k, i); } return i; };
    const sprites: { lon: number; lat: number; key: string; w: number; h: number; dx: number; dy: number }[] = [];
    const degPerPx = this.r.camera.metersPerPixel() / 111320;
    for (const e of vis) {
      const pf = e.pf!;
      for (const l of pf.lines) {
        // Object-relative lines carry pixel offsets: converted to degrees at the current view scale.
        const coords = l.offset ? l.pts.map((v, i) => v + (i % 2 === 0 ? l.offset![i >> 1][0] * degPerPx / Math.cos((l.pts[i + 1] * Math.PI) / 180) : -l.offset![i >> 1][1] * degPerPx)) : l.pts;
        lines.push({ coords, style: sty(l.color, l.width) });
      }
      for (const t of pf.tris) for (let i = 0; i + 5 < t.pts.length; i += 6) polys.push({ tris: t.pts.slice(i, i + 6), style: fsty(t.colors[i / 2] ?? [255, 255, 255, 128]) });
      for (const t of pf.texts) { const f = pf.fonts.get(t.font); labels.push({ lon: t.lon, lat: t.lat, text: t.text, size: f?.px ?? 12, color: t.color, halo: [0, 0, 0, 200], dx: t.dx, dy: t.dy }); }
      for (const ic of pf.icons) {
        const file = pf.iconFiles.get(ic.file);
        if (!file) continue;
        const key = `${file.url}#${ic.icon}${iconCache.has(file.url) ? '' : '#pending'}`;
        this.atlas.draw(key, file.w, file.h, (g, k) => { const img = iconCache.get(file.url); if (!img) return; const cols = Math.max(1, Math.floor(img.width / file.w)); const n = ic.icon - 1; g.scale(k, k); g.drawImage(img, (n % cols) * file.w, Math.floor(n / cols) * file.h, file.w, file.h, 0, 0, file.w, file.h); });
        sprites.push({ lon: ic.lon, lat: ic.lat, key, w: file.w, h: file.h, dx: ic.dx - (file.hx - file.w / 2), dy: ic.dy - (file.hy - file.h / 2) });
        if (!iconCache.has(file.url) && !iconLoading.has(file.url)) { iconLoading.add(file.url); loadImage(file.url).then((img) => { iconCache.set(file.url, img); this.key = ''; }, () => { e.error = `icon file ${file.url} could not be loaded (CORS or network)`; }); }
      }
    }
    this.lines.setStyles(styles); this.lines.setLines(lines);
    this.polys.setStyles(fills); this.polys.setPolys(polys);
    this.text.setLabels(labels);
    this.atlas.flush();
    this.sprites.setSprites(sprites);
    void lonLatToXYZ; void timeline; void settings;
  }
  draw(ctx: DrawContext) { if (ctx.probe) return; this.polys.draw(ctx); this.lines.draw(ctx); this.sprites.draw(ctx); this.text.draw(ctx); }
  /** Hover text of the nearest icon / text / line vertex (rollover and probe). */
  probeAt(_lon: number, _lat: number, x: number, y: number): string[] | null {
    let best: string | null = null, bd = 14;
    for (const e of this.entries) if (e.pf && !e.hidden) for (const it of [...e.pf.icons, ...e.pf.texts]) {
      if (!it.hover) continue;
      const [px, py, f] = this.r.camera.project(lonLatToXYZ(it.lon, it.lat));
      if (f && Math.hypot(px - x, py - y) < bd) { bd = Math.hypot(px - x, py - y); best = it.hover; }
    }
    return best ? best.split('\\n') : null;
  }
}
const iconCache = new Map<string, HTMLImageElement | ImageBitmap>();
const iconLoading = new Set<string>();
