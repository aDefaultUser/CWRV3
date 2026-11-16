// Map legends: horizontal bars stacked 27 px per legend across the top of the map, sampled from the
// baked 1024-texel lookup (including the flash row), with palette-stop ticks and the collision rules.
import type { LegendSpec } from '../layers/base';
import { legendTicks, legendRange } from '../render/palette';
import { LUT_WIDTH } from '../render/palette';

const NOTE_H = 13;
const NORMAL = '600 11px "Segoe UI", "Noto Sans", sans-serif', SMALL = '600 9px "Segoe UI", "Noto Sans", sans-serif';

export function drawLegends(cv: HTMLCanvasElement, legends: LegendSpec[], flashRow: number, dpr: number) {
  const W = cv.clientWidth;
  let rows = 0, notes = 0;
  for (const l of legends) { rows += 1 + (l.extra?.length ?? 0); if (l.note) notes++; }
  const H = rows * 27 + notes * NOTE_H;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.max(1, Math.round(H * dpr)); cv.style.height = `${H}px`; }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  let y = 0;
  const stacked = rows > 1;
  const geo: LegendGeometry[] = [];
  for (const l of legends) {
    geo.push(drawOne(g, l.unit, l, flashRow, W, y, stacked));
    y += 27;
    for (const e of l.extra ?? []) { geo.push(drawOne(g, e.label, { ...l, palette: e.palette, lut: e.lut }, flashRow, W, y, stacked)); y += 27; }
    if (l.note) {
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, y, W, NOTE_H);
      g.font = SMALL; g.fillStyle = '#e8ecf6'; g.fillText(l.note, 4, y + 10);
      y += NOTE_H;
    }
  }
  // Bar geometry (CSS px) for tests and screenshot metrics: value v sits at x0 + (v − lo)/(hi − lo)·barW.
  cv.dataset.legend = JSON.stringify(geo);
}
export interface LegendGeometry { label: string; x0: number; barW: number; barY: number; barH: number; lo: number; hi: number }

function drawOne(g: CanvasRenderingContext2D, unit: string, l: LegendSpec, flashRow: number, W: number, y: number, stacked: boolean): LegendGeometry {
  g.font = NORMAL;
  const unitW = g.measureText(unit).width;
  const x0 = unitW + 16, barW = Math.max(10, W - x0);
  const [lo, hi] = legendRange(l.palette, l.low, l.high);
  const rows = l.lut.rows, row = rows > 1 ? Math.min(flashRow, rows - 1) : 0;
  // Bar: sample the lookup over the legend range.
  const img = g.createImageData(Math.ceil(barW), 1);
  for (let x = 0; x < img.width; x++) {
    const v = lo + ((hi - lo) * x) / Math.max(1, img.width - 1);
    let f = (v - l.low) / (l.high - l.low);
    if (l.reserve) f = (2 + ((v - l.low) / (l.high - l.low)) * 253) / 255;
    const i = Math.max(0, Math.min(LUT_WIDTH - 1, Math.round(f * (LUT_WIDTH - 1))));
    const o = (row * LUT_WIDTH + i) * 4;
    img.data.set([l.lut.data[o], l.lut.data[o + 1], l.lut.data[o + 2], Math.max(l.lut.data[o + 3], 0)], x * 4);
  }
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, y, W, 27);
  const tmp = new OffscreenCanvas(img.width, 1);
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, x0, y + 2, barW, 7);
  g.fillStyle = '#e8ecf6';
  g.font = NORMAL;
  g.fillText(unit, 4, y + 12);
  const measure = (s: string, small: boolean) => { g.font = small ? SMALL : NORMAL; return g.measureText(s).width; };
  const ticks = legendTicks(l.palette, l.low, l.high, barW, measure);
  const twoRow = ticks.some((t) => t.raised);
  for (const t of ticks) {
    if (t.hidden) continue;
    g.font = t.small ? SMALL : NORMAL;
    let ty = t.raised ? (stacked ? -4 : 0) + 9 : t.small ? 21 : 18;
    ty += twoRow ? -4 : -11;
    g.fillStyle = '#ffffff';
    g.strokeStyle = 'rgba(0,0,0,0.9)'; g.lineWidth = 2.5;
    const tx = x0 + t.x;
    g.strokeText(t.label, tx, y + ty + 11);
    g.fillText(t.label, tx, y + ty + 11);
    g.fillRect(x0 + (t.alignRight ? t.x + 2 + measure(t.label, t.small) : t.x), y + 2, 1, 9);
  }
  return { label: unit, x0, barW, barY: y + 2, barH: 7, lo, hi };
}
