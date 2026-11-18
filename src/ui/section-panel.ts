// Cross-section panel (CWRV3 addition): a movable, resizable inset whose plot is a WebGPU canvas the section view
// renders into (render/section-view.ts), under a 2D overlay with the axes, beam-centre lines, isotherms and header,
// a legend drawn from the map's palette lookup, and the probe readout. Its controls write the same settings as the
// Radar analysis tools dialog; the plot size is a setting and persists.
import { drag } from './dialogs';
import { drawLegends } from './legend';
import { settings } from '../settings/store';
import type { LegendSpec } from '../layers/base';

export const SECTION_MOMENTS = ['REF', 'VEL', 'SRV', 'ZDR', 'CC', 'KDP'] as const;
export type SectionMoment = (typeof SECTION_MOMENTS)[number];
export const SECTION_MOMENT_NAMES: Record<SectionMoment, string> = { REF: 'Reflectivity', VEL: 'Velocity (dealiased)', SRV: 'Storm-relative velocity', ZDR: 'ZDR', CC: 'Correlation coefficient', KDP: 'KDP' };
const S = (k: string) => `ext.settings.nexradSection${k}`;

/** Plot margins (CSS px) around the GPU canvas: header on top, height axis left, distance axis below. */
export const MARGIN = { l: 50, t: 22, r: 12, b: 30 };
export const BACKGROUND: [number, number, number] = [0.06, 0.06, 0.08];

/** What the overlay shows; everything is in the units it is drawn in except heights and ranges (km). */
export interface Overlay {
  header: string;
  topKm: number; imperial: boolean;
  /** Distance axis: its value (km) at A and at B, and what it measures from ('A', or 'the radar' for an RHI). */
  axis: { fromKm: number; toKm: number; origin: string };
  /** Beam-centre curves [fx, height km] per tilt, with the tilt's elevation. */
  beams: { elevation: number; pts: [number, number][] }[];
  isotherms: { label: string; km: number }[];
  /** Distance tick step in the display unit (km or mi). */
  tickStep: number;
}

export class SectionPanel {
  readonly el: HTMLDivElement;
  readonly gpuCanvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement; private legend: HTMLCanvasElement;
  private plot: HTMLDivElement; private status: HTMLDivElement; private probe: HTMLDivElement;
  private controls: (() => void)[] = [];
  private off: () => void;
  private resizeObs: ResizeObserver;
  private resizeTimer = 0;
  onClose: () => void = () => {};
  /** Probe text for a point of the plot (fx along the section, fy of its height), or null outside the data. */
  onProbe: (fx: number, fy: number) => string | null = () => null;

  constructor() {
    const d = this.el = document.createElement('div');
    d.className = 'dlg'; d.style.cssText = 'left:90px;top:90px;z-index:44';
    const title = document.createElement('div'); title.className = 'dlg-title'; title.textContent = 'Cross-section / RHI';
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.onclick = () => this.onClose();
    title.appendChild(x);
    const body = document.createElement('div'); body.className = 'dlg-body'; body.style.cssText = 'max-height:none;overflow:visible';
    body.append(this.toolbar());
    const plot = this.plot = document.createElement('div');
    plot.style.cssText = 'position:relative;box-sizing:border-box;resize:both;overflow:hidden;min-width:320px;min-height:180px;background:#101014;border:1px solid var(--edge)';
    this.gpuCanvas = document.createElement('canvas');
    this.gpuCanvas.style.cssText = `position:absolute;left:${MARGIN.l}px;top:${MARGIN.t}px`;
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText = 'position:absolute;left:0;top:0;cursor:crosshair';
    plot.append(this.gpuCanvas, this.overlay);
    this.legend = document.createElement('canvas'); this.legend.style.cssText = 'display:block;width:100%;margin-top:4px';
    this.status = document.createElement('div'); this.status.style.cssText = 'color:var(--textDim);min-height:15px';
    this.probe = document.createElement('div'); this.probe.style.cssText = 'font:11px/1.4 monospace;white-space:pre;min-height:30px';
    body.append(plot, this.legend, this.status, this.probe);
    d.append(title, body);
    drag(d, title);
    this.overlay.addEventListener('mousemove', (e) => {
      const w = this.plotW(), h = this.plotH(), fx = (e.offsetX - MARGIN.l) / w, fy = 1 - (e.offsetY - MARGIN.t) / h;
      this.probe.textContent = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? this.onProbe(fx, fy) ?? '' : '';
    });
    this.overlay.addEventListener('mouseleave', () => { this.probe.textContent = ''; });
    this.applySize();
    // The user's resize of the plot is written back to the size settings (which persist); a setting change resizes it.
    this.resizeObs = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        const w = this.plot.offsetWidth, h = this.plot.offsetHeight;
        if (!w || !h) return; // not laid out (closed)
        if (w !== settings.num(S('Width'))) settings.set(S('Width'), w);
        if (h !== settings.num(S('Height'))) settings.set(S('Height'), h);
      }, 200);
    });
    this.resizeObs.observe(plot);
    this.off = settings.on(S(''), () => { this.applySize(); for (const f of this.controls) f(); });
  }

  open() { if (!this.el.isConnected) document.getElementById('app')!.appendChild(this.el); }
  destroy() { this.off(); this.resizeObs.disconnect(); clearTimeout(this.resizeTimer); this.el.remove(); }

  private toolbar(): HTMLElement {
    const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px';
    const sel = document.createElement('select');
    SECTION_MOMENTS.forEach((m, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = SECTION_MOMENT_NAMES[m]; sel.appendChild(o); });
    sel.onchange = () => settings.set(S('Moment'), Number(sel.value));
    const top = document.createElement('input'); top.type = 'number'; top.min = '2'; top.max = '25'; top.step = '1'; top.style.width = '48px';
    top.onchange = () => settings.set(S('Top'), Number(top.value));
    this.controls.push(() => { sel.value = String(settings.num(S('Moment'))); if (document.activeElement !== top) top.value = String(settings.num(S('Top'))); });
    bar.append('Moment', sel, 'Top', top, 'km');
    for (const [k, label] of [['Beams', 'Beams'], ['Isotherms', 'Isotherms'], ['Follow', 'Follow storm motion'], ['Rhi', 'RHI']] as const) {
      const lab = document.createElement('label'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.onchange = () => settings.set(S(k), cb.checked);
      this.controls.push(() => { cb.checked = settings.bool(S(k)); });
      lab.append(cb, label); bar.append(lab);
    }
    for (const f of this.controls) f();
    return bar;
  }

  private plotW() { return Math.max(1, this.plot.clientWidth - MARGIN.l - MARGIN.r); }
  private plotH() { return Math.max(1, this.plot.clientHeight - MARGIN.t - MARGIN.b); }

  private applySize() {
    const w = settings.num(S('Width')), h = settings.num(S('Height'));
    // The size is the plot's border box (offsetWidth/Height), so reading it back gives the value written.
    if (this.plot.offsetWidth !== w || this.plot.offsetHeight !== h) { this.plot.style.width = `${w}px`; this.plot.style.height = `${h}px`; }
  }

  /** Sizes the canvases' backing stores to the plot (CSS size × DPR); true when the GPU canvas changed size. */
  layout(): boolean {
    const dpr = window.devicePixelRatio || 1, W = this.plot.clientWidth, H = this.plot.clientHeight, w = this.plotW(), h = this.plotH();
    const gw = Math.max(1, Math.round(w * dpr)), gh = Math.max(1, Math.round(h * dpr));
    if (this.gpuCanvas.width === gw && this.gpuCanvas.height === gh) return false;
    this.gpuCanvas.style.width = `${w}px`; this.gpuCanvas.style.height = `${h}px`;
    this.overlay.style.width = `${W}px`; this.overlay.style.height = `${H}px`;
    this.gpuCanvas.width = gw; this.gpuCanvas.height = gh;
    this.overlay.width = Math.max(1, Math.round(W * dpr)); this.overlay.height = Math.max(1, Math.round(H * dpr));
    return true;
  }

  setStatus(text: string) { if (this.status.textContent !== text) this.status.textContent = text; }
  setLegend(spec: LegendSpec | null) {
    if (!spec) { this.legend.style.display = 'none'; return; }
    this.legend.style.display = '';
    drawLegends(this.legend, [spec], 0, window.devicePixelRatio || 1);
  }

  /** Draws the overlay over the plot (null: nothing shown). */
  drawOverlay(o: Overlay | null) {
    const dpr = window.devicePixelRatio || 1, g = this.overlay.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!o) return;
    const w = this.plotW(), h = this.plotH(), X = (fx: number) => MARGIN.l + fx * w, Y = (km: number) => MARGIN.t + h - (km / o.topKm) * h;
    g.font = '11px "Segoe UI", "Noto Sans", sans-serif'; g.textBaseline = 'middle';
    // Height axis in km or kft above the radar.
    const unitKm = o.imperial ? 0.3048 : 1, top = o.topKm / unitKm, step = top > 40 ? 10 : top > 16 ? 5 : top > 6 ? 2 : 1;
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.fillStyle = '#c8cedc'; g.textAlign = 'right'; g.lineWidth = 1;
    for (let v = 0; v <= top + 1e-6; v += step) {
      const y = Math.round(Y(v * unitKm)) + 0.5;
      g.beginPath(); g.moveTo(MARGIN.l, y); g.lineTo(MARGIN.l + w, y); g.stroke();
      g.fillText(String(v), MARGIN.l - 4, y);
    }
    g.save(); g.translate(11, MARGIN.t + h / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText(o.imperial ? 'kft ARL' : 'km ARL', 0, 0); g.restore();
    // Distance axis from A in mi or km.
    const kmPer = o.imperial ? 1.609344 : 1, u0 = o.axis.fromKm / kmPer, u1 = o.axis.toKm / kmPer;
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let v = Math.ceil((Math.min(u0, u1) - 1e-6) / o.tickStep) * o.tickStep; v <= Math.max(u0, u1) + 1e-6; v += o.tickStep) {
      const x = Math.round(X(u1 !== u0 ? (v - u0) / (u1 - u0) : 0)) + 0.5;
      g.beginPath(); g.moveTo(x, MARGIN.t + h); g.lineTo(x, MARGIN.t + h + 4); g.strokeStyle = '#c8cedc'; g.stroke();
      g.fillText(String(v), x, MARGIN.t + h + 6);
    }
    g.textAlign = 'center'; g.fillText(`${o.imperial ? 'mi' : 'km'} from ${o.axis.origin}`, MARGIN.l + w / 2, MARGIN.t + h + 18);
    g.fillStyle = '#ffd84a'; g.font = '600 12px "Segoe UI", "Noto Sans", sans-serif';
    g.textAlign = 'left'; g.fillText('A', MARGIN.l + 2, MARGIN.t + h + 16);
    g.textAlign = 'right'; g.fillText('B', MARGIN.l + w - 2, MARGIN.t + h + 16);
    g.font = '11px "Segoe UI", "Noto Sans", sans-serif';
    // Beam centres of the volume's tilts; the elevation is written where the curve leaves the plot.
    g.save(); g.beginPath(); g.rect(MARGIN.l, MARGIN.t, w, h); g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.4)'; g.setLineDash([4, 3]); g.textBaseline = 'bottom';
    for (const b of o.beams) {
      g.beginPath();
      let pen = false, last: [number, number] | null = null;
      for (const [fx, km] of b.pts) {
        if (!(km === km) || km > o.topKm * 1.05) { pen = false; continue; }
        if (pen) g.lineTo(X(fx), Y(km)); else g.moveTo(X(fx), Y(km));
        pen = true; last = [X(fx), Y(km)];
      }
      g.stroke();
      if (last) { g.fillStyle = 'rgba(255,255,255,0.75)'; g.textAlign = last[0] > MARGIN.l + w - 30 ? 'right' : 'left'; g.fillText(`${b.elevation.toFixed(1)}°`, Math.min(last[0], MARGIN.l + w - 2), Math.max(MARGIN.t + 10, last[1] - 1)); }
    }
    g.setLineDash([]);
    g.textAlign = 'left'; g.textBaseline = 'bottom';
    o.isotherms.forEach((iso, i) => {
      if (iso.km > o.topKm) return;
      const y = Math.round(Y(iso.km)) + 0.5;
      g.strokeStyle = '#4ac8ff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(MARGIN.l, y); g.lineTo(MARGIN.l + w, y); g.stroke();
      // Labels side by side: the three heights are often only a few pixels apart.
      const x = MARGIN.l + 4 + i * Math.min(130, w / 3);
      g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 3; g.strokeText(iso.label, x, y - 2);
      g.fillStyle = '#4ac8ff'; g.fillText(iso.label, x, y - 2);
    });
    g.restore();
    g.fillStyle = '#e8ecf6'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '600 12px "Segoe UI", "Noto Sans", sans-serif';
    g.fillText(o.header, 6, MARGIN.t / 2);
  }
}
