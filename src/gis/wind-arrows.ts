// 10 m wind arrows of the surface layer as polylines: pure, so that the decode worker builds them once per HRRR hour.
import type { LineInput } from './tessellate';

/** Upper speed (mph) of each arrow colour bin; the bin index is the arrow's line style. */
export const WIND_BINS = [5, 10, 15, 20, 30, 40, 55, 75];

/** Shaft and head of an arrow per sample (lon, lat, u, v in m/s, interleaved); calm samples (≤ 1 mph) are skipped. */
export function windArrows(wv: ArrayLike<number>): LineInput[] {
  const out: LineInput[] = [];
  for (let i = 0; i < wv.length; i += 4) {
    const lon = wv[i], lat = wv[i + 1], u = wv[i + 2], v = wv[i + 3];
    const mph = Math.hypot(u, v) * 2.23694;
    if (!(mph > 1)) continue;
    const L = 0.06 + mph * 0.006, k = Math.cos((lat * Math.PI) / 180);
    const dx = (u / Math.hypot(u, v)) * L / k, dy = (v / Math.hypot(u, v)) * L;
    const style = Math.max(0, WIND_BINS.findIndex((b) => mph <= b));
    const tipX = lon + dx, tipY = lat + dy;
    out.push({ coords: [lon, lat, tipX, tipY], style });
    out.push({ coords: [tipX - dx * 0.35 - dy * 0.2 / k, tipY - dy * 0.35 + dx * 0.2 * k, tipX, tipY, tipX - dx * 0.35 + dy * 0.2 / k, tipY - dy * 0.35 - dx * 0.2 * k], style });
  }
  return out;
}
