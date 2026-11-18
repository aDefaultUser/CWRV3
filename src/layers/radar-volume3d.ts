// 3D view of the Level 2 volume the NEXRAD layer draws (CWRV3 menu → Radar analysis tools…): settings, the pack of
// the shown volume, the march prepass, the composite and the height scale at the radar. The target is marched for
// one volume and composited only over the frame of that same volume.
import type { DrawContext, PrepassContext, Renderer } from '../render/renderer';
import { VolumeView, type ViewParams } from '../render/volume-view';
import { Lut } from '../render/raster';
import { LineSet, TextSet, GlyphAtlas, type Label } from '../render/prims';
import { EARTH_KM } from '../render/camera';
import { siteFrame, VIEW_TOP_KM } from '../render/volume-ray';
import { getPalette } from '../palettes/library';
import { settings } from '../settings/store';
import { timeline } from '../app/timeline';
import { L2_PALETTE_KEYS } from '../radar/sources';
import { VOLUME_MOMENTS, type VolumeMoment } from '../radar/l2products';
import type { NexradLayer } from './nexrad';

export const VIEW3D = (k: string) => `ext.settings.nexrad3DView${k}`;
/**
 * The views of ext.settings.nexrad3DViewMoment: pack moment, the Level 2 product whose palette colours the volume,
 * and the value of full density in volume rendering. Thresholds are kept per moment (speeds in kts for velocity).
 */
export const VIEW3D_MOMENTS: readonly { label: string; moment: VolumeMoment; product: number; full: number; srv?: boolean }[] = [
  { label: 'Reflectivity', moment: 'REF', product: 0, full: 65 },
  { label: 'Velocity', moment: 'VEL', product: 1, full: 90 },
  { label: 'Storm-relative velocity', moment: 'VEL', product: 7, full: 90, srv: true },
  { label: 'ZDR', moment: 'ZDR', product: 3, full: 5 },
  { label: 'CC', moment: 'CC', product: 5, full: 1 },
  { label: 'KDP', moment: 'KDP', product: 10, full: 5 },
];
/** Volume-rendering opacity per km of full-density echo at opacity scale 1. */
const OPACITY_PER_KM = 1.2;
/** Vertical scale of the tilt-exaggeration setting, as the 3D tilt applies it, kept above a flat volume. */
export const verticalScale = (exaggeration: number) => Math.max(0.2, 1 + exaggeration / 25);

export interface View3DConfig {
  view: (typeof VIEW3D_MOMENTS)[number];
  params: Omit<ViewParams, 'lut' | 'emptyCode'>;
  /** Lowest code (speed for velocity) that is drawn. */
  minCode: number;
}

/** The 3D view the settings ask for, or null when it is off. Thresholds become codes of the moment's pack. */
export function view3dConfig(): View3DConfig | null {
  const mode = settings.num(VIEW3D(''));
  if (mode !== 1 && mode !== 2) return null;
  const view = VIEW3D_MOMENTS[settings.num(VIEW3D('Moment'))] ?? VIEW3D_MOMENTS[0];
  const m = VOLUME_MOMENTS[view.moment], velocity = view.moment === 'VEL';
  // Velocity thresholds are speeds: the code of +v, which is also the mirrored code of −v.
  const code = (v: number) => Math.min(255, Math.max(2, (v - m.offset) / m.scale));
  const value = (k: string) => settings.num(VIEW3D(k + view.moment));
  const rgba = (k: string) => settings.arr<number>(VIEW3D(k)).map((x) => x / 255);
  const iso: [number, number] = [code(value('Iso1')), settings.bool(VIEW3D('Iso2On')) ? code(value('Iso2')) : 0];
  const thresholdCode = code(value('Min'));
  return {
    view, minCode: mode === 1 ? thresholdCode : Math.min(...iso.filter((c) => c > 0)),
    params: {
      mode, steps: settings.num(VIEW3D('Quality')), vscale: verticalScale(settings.num('settings.nexrad3DTiltExaggeration')), velocity,
      thresholdCode, fullCode: Math.max(thresholdCode + 1, code(view.full)), opacity: settings.num(VIEW3D('Opacity')) * OPACITY_PER_KM,
      iso, colors: [rgba('Iso1Color'), rgba('Iso2Color')],
    },
  };
}

export class Volume3D {
  /** The march target and its pipelines; null while the view is off. */
  view: VolumeView | null = null;
  private luts = new Map<string, Lut>();
  private lines: LineSet; private text: TextSet; private scaleKey = '';
  /** URL of the volume the target was marched for in this frame's prepass; null when nothing was marched. */
  private marched: string | null = null;
  /** What the view shows or waits for (analysis dialog). */
  status = 'Off';

  constructor(private r: Renderer, atlas: GlyphAtlas, private nexrad: NexradLayer) {
    this.lines = new LineSet(r); this.text = new TextSet(r, atlas);
  }

  /** Transfer-function palette of a moment: codes 2..255 over the moment's value range. */
  private lut(product: number, moment: VolumeMoment): Lut {
    const name = settings.str(L2_PALETTE_KEYS[product]), key = `${name}|${moment}`, m = VOLUME_MOMENTS[moment];
    let l = this.luts.get(key);
    if (!l) { l = new Lut(this.r, getPalette(name), { low: 2 * m.scale + m.offset, high: 255 * m.scale + m.offset, reserve: true }); this.luts.set(key, l); }
    return l;
  }

  prepass(ctx: PrepassContext) {
    this.marched = null;
    const cfg = view3dConfig(), n = this.nexrad;
    if (!cfg) { this.view?.destroy(); this.view = null; this.status = 'Off'; return; }
    const { frames, shown } = n.volumeFrames(cfg.view.moment);
    if (shown < 0) { this.status = n.isL2() ? 'No Level 2 volume at the timeline time' : 'The 3D view needs Level 2 data'; return; }
    const f = frames[shown], pack = n.volumes.get(f.q);
    // While the loop plays, the packs of the frames that follow stay requested (a pack nobody asks for is dropped
    // before it is uploaded), as many as the store's memory budget holds.
    if (timeline.playing) {
      const room = Math.floor(n.volumes.budgetBytes / (pack?.bytes ?? 24 * 1048576)) - 1;
      for (let k = 1; k < frames.length && k <= room; k++) n.volumes.get(frames[(shown + k) % frames.length].q);
    }
    const what = `${cfg.view.label} ${new Date(f.t).toISOString().slice(11, 16)}Z`;
    if (!pack) { this.status = `${what}: ${n.volumes.state(f.q)}`; return; }
    const motion = cfg.view.srv ? n.stormMotion(f.t) : null;
    if (cfg.view.moment === 'VEL') n.volumes.setMotion(pack, motion);
    this.view ??= new VolumeView(this.r, n.id);
    // A storm-relative speed exceeds the ground-relative one by at most the storm speed.
    const emptyCode = Math.max(2, cfg.minCode - (motion?.speedKt ?? 0));
    this.view.encode(ctx, pack, f.q, { ...cfg.params, emptyCode, lut: this.lut(cfg.view.product, cfg.view.moment) });
    this.marched = f.q.url;
    this.status = `${what}, ${pack.tilts.length} tilts${motion ? `, storm motion ${motion.fromDeg.toFixed(0)}° ${motion.speedKt.toFixed(0)} kt` : ''}\nTarget ${this.view.width}×${this.view.height} (1/${this.view.divisor} of the map)`;
  }

  /** Composites the view over the frame of the volume at `url` (the one draw() shows) and draws the height scale. */
  draw(ctx: DrawContext, url: string, site: { lon: number; lat: number; heightKm: number }) {
    if (ctx.probe || this.marched !== url || !this.view) return;
    this.view.draw(ctx);
    if (!settings.bool(VIEW3D('HeightScale'))) return;
    const imperial = settings.bool('config.distanceMeasureImperial'), vscale = verticalScale(settings.num('settings.nexrad3DTiltExaggeration'));
    const key = JSON.stringify([site, imperial, vscale]);
    if (key !== this.scaleKey) { this.scaleKey = key; this.buildScale(site, imperial, vscale); }
    this.lines.draw(ctx); this.text.draw(ctx);
  }

  /** A vertical line at the radar from its level to the top of the view, with a tick cross and a label every 5 km or 10 kft. */
  private buildScale(site: { lon: number; lat: number; heightKm: number }, imperial: boolean, vscale: number) {
    const f = siteFrame(site.lon, site.lat), unitKm = imperial ? 0.3048 : 1, every = imperial ? 10 : 5;
    const at = (hKm: number, eastKm = 0, northKm = 0) => { const r = 1 + (site.heightKm + hKm * vscale) / EARTH_KM; return [0, 1, 2].map((i) => f.up[i] * r + (f.east[i] * eastKm + f.north[i] * northKm) / EARTH_KM); };
    const segs: number[] = [...at(0), ...at(VIEW_TOP_KM), 0], labels: Label[] = [];
    for (let v = every; v * unitKm <= VIEW_TOP_KM; v += every) {
      const h = v * unitKm;
      segs.push(...at(h, -1), ...at(h, 1), 0, ...at(h, 0, -1), ...at(h, 0, 1), 0);
      labels.push({ lon: site.lon, lat: site.lat, height: (site.heightKm + h * vscale) / EARTH_KM, text: `${v} ${imperial ? 'kft' : 'km'}`, size: 11, color: [255, 255, 255, 235], halo: [0, 0, 0, 220], dx: 8, align: 'left', priority: 4 });
    }
    this.lines.setStyles([{ color: [255, 255, 255, 220], width: 1.4 }]);
    this.lines.setSegments(segs);
    this.text.setLabels(labels);
  }

  invalidate() { this.view?.invalidate(); }
}
