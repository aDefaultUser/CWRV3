// Volume pack: every tilt of one moment of a Level 2 volume on the shared azimuth frame (l2products.ts), one image
// per tilt, for the cross-section and 3D views. Built in the decode worker (task 'l2.volume'), uploaded by
// render/volume.ts as the layers of one r8unorm 2D-array texture and sampled by volume-sample.ts and its WGSL mirror.
import { AZ_BINS, tiltRows, SweepCache, type BuilderSweep, type VolumeMoment } from './l2products';

/** Rows of a pack image: the azimuth bins plus a wrap row at each end (bin 719 before bin 0, bin 0 after bin 719). */
export const PACK_ROWS = AZ_BINS + 2;
/** Tilts a pack can hold (the size of the shader's tilt table). */
export const PACK_MAX_TILTS = 32;

export interface PackTilt {
  /** Index of the source sweep in the volume (L2Meta.sweeps). */
  sweep: number;
  /** Mean measured elevation (deg), first gate centre and gate size (km), gate and radial counts, scan times. */
  elevation: number; firstKm: number; gateKm: number; gates: number; radials: number; startMs: number; endMs: number;
}

export interface VolumePack {
  moment: VolumeMoment;
  /** Image width: the largest gate count of the tilts (shorter tilts are zero-filled). */
  width: number;
  /** Ascending elevation. */
  tilts: PackTilt[];
  /** One image per tilt, PACK_ROWS × width byte codes (VOLUME_MOMENTS): texel [(bin + 1) · width + gate]. */
  layers: Uint8Array[];
}

const hasMoment = (s: BuilderSweep, m: VolumeMoment) => !!(m === 'REF' ? s.ref : m === 'VEL' ? s.vel : m === 'CC' ? s.rho : m === 'KDP' ? s.phi : s.zdr ?? s.zdr16);

/**
 * The sweep used for each tilt of `moment`, ascending. Sweeps are grouped by nominal elevation. Reflectivity and the
 * dual-pol moments come from the surveillance (or only) cut of a group, velocity from its Doppler cut; among SAILS /
 * MRLE rescans the first is used, or the most recent with `latest` (settings.nexradLatestUpdateMode, as the tilt
 * display does; in a live volume that rescan can still be arriving).
 */
export function volumeTilts(sweeps: BuilderSweep[], moment: VolumeMoment, latest: boolean): { sweep: BuilderSweep; index: number }[] {
  const groups: { angle: number; cands: { sweep: BuilderSweep; index: number }[] }[] = [];
  sweeps.forEach((sweep, index) => {
    if (!sweep.radials || !hasMoment(sweep, moment)) return;
    const angle = sweep.nominal ?? sweep.elevation;
    let g = groups.find((x) => Math.abs(x.angle - angle) < 0.2);
    if (!g) groups.push(g = { angle, cands: [] });
    g.cands.push({ sweep, index });
  });
  return groups.map((g) => {
    const plain = moment === 'VEL' ? g.cands : g.cands.filter((c) => !c.sweep.splitCutDoppler);
    const cands = plain.length ? plain : g.cands;
    return latest ? cands[cands.length - 1] : cands[0];
  }).sort((a, b) => a.sweep.elevation - b.sweep.elevation).slice(0, PACK_MAX_TILTS);
}

/**
 * Packs `moment` of a volume; null when no sweep has it. `scan` holds each sweep's first and last radial time by
 * sweep index. Rows are taken from `cache`, so tilts a live volume left unchanged are not resampled again.
 */
export function buildVolumePack(sweeps: BuilderSweep[], moment: VolumeMoment, o: { latest: boolean; qualityDealiasing: boolean },
  scan: { startMs: number; endMs: number }[] = [], cache = new SweepCache()): VolumePack | null {
  const picked = volumeTilts(sweeps, moment, o.latest);
  if (!picked.length) return null;
  const rows = picked.map((p) => tiltRows(p.sweep, moment, o.qualityDealiasing, cache)!);
  const width = Math.max(...rows.map((r) => r.gates));
  const layers = rows.map((r) => {
    const img = new Uint8Array(PACK_ROWS * width);
    for (let b = 0; b < AZ_BINS; b++) img.set(r.codes.subarray(b * r.gates, (b + 1) * r.gates), (b + 1) * width);
    img.copyWithin(0, AZ_BINS * width, (AZ_BINS + 1) * width);
    img.copyWithin((AZ_BINS + 1) * width, width, 2 * width);
    return img;
  });
  const tilts = picked.map((p, k): PackTilt => ({
    sweep: p.index, elevation: p.sweep.elevation, firstKm: rows[k].firstKm, gateKm: rows[k].gateKm, gates: rows[k].gates,
    radials: p.sweep.radials, startMs: scan[p.index]?.startMs ?? 0, endMs: scan[p.index]?.endMs ?? 0,
  }));
  return { moment, width, tilts, layers };
}
