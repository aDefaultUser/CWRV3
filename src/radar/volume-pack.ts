// Volume pack: every tilt of one moment of a Level 2 volume on the shared azimuth frame (l2products.ts), one image
// per tilt, for the cross-section and 3D views. Built in the decode worker (task 'l2.volume'), uploaded by
// render/volume.ts as the layers of one r8unorm 2D-array texture and sampled by volume-sample.ts and its WGSL mirror.
import { AZ_BINS, AZ_BIN0, VOLUME_MOMENTS, tiltRows, SweepCache, type BuilderSweep, type VolumeMoment } from './l2products';
import { BEAM_DEG, groundRangeKm, tiltHeightKm } from './volume-sample';

/** Rows of a pack image: the azimuth bins plus a wrap row at each end (bin 719 before bin 0, bin 0 after bin 719). */
export const PACK_ROWS = AZ_BINS + 2;
/** Tilts a pack can hold (the size of the shader's tilt table). */
export const PACK_MAX_TILTS = 32;
/**
 * Occupancy grid of a pack: OCC_N × OCC_N square cells on the ground around the radar (east and north of it, in the
 * ground range and azimuth of the samplers) by OCC_LAYERS height bins from the radar level to OCC_TOP_KM above it
 * (lower and higher points count in the first and last bin), and a coarse level of OCC_COARSE × OCC_COARSE columns.
 */
export const OCC_N = 256, OCC_LAYERS = 32, OCC_TOP_KM = 20, OCC_COARSE = 8;
/** Images of the grid: the height bins, the maximum of each column, and that maximum over the coarse columns. */
export const OCC_IMAGES = OCC_LAYERS + 2;
/** Gates per radial that are entered into the grid together. */
const OCC_GATES = 4;
/**
 * A gate also counts in the cells this far beyond its ground-range span and its heights (km) and its azimuth bin
 * (deg), so that a float32 sampler reading it near a cell wall still finds it in its own cell.
 */
const OCC_PAD_KM = 0.02, OCC_PAD_DEG = 0.02;

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
  /**
   * Occupancy grid for empty-space skipping, OCC_IMAGES images of OCC_N × OCC_N texels [row · OCC_N + column]
   * (columns eastward, rows northward, the radar at the centre). Image z < OCC_LAYERS holds, per cell, the largest
   * occupancyCode among the gates sampleVolume can read from a point over the cell in height bin z; then the maximum
   * of each column; then that maximum over the coarse columns, in the first OCC_N / OCC_COARSE columns and rows.
   */
  occupancy: Uint8Array;
  /** Side of an occupancy cell (km). */
  occKm: number;
}

const VEL_ZERO = -VOLUME_MOMENTS.VEL.offset / VOLUME_MOMENTS.VEL.scale;
/**
 * What the occupancy grid holds for a pack code: no data and range folded count as empty, and velocity is folded to
 * its speed (the zero code plus |code − zero|), so that one threshold covers inbound and outbound.
 */
export const occupancyCode = (moment: VolumeMoment, code: number) => (code < 2 ? 0 : moment === 'VEL' ? Math.min(255, VEL_ZERO + Math.abs(code - VEL_ZERO)) : code);

/** Height bin of the occupancy grid for a height above the radar (km). */
export const occLayer = (hKm: number) => Math.min(OCC_LAYERS - 1, Math.max(0, Math.floor((hKm * OCC_LAYERS) / OCC_TOP_KM)));
/** Index in an occupancy image of the cell over the point at azimuth `azDeg` and ground range `sKm` (clamped to the grid). */
export function occCell(azDeg: number, sKm: number, occKm: number): number {
  const a = (azDeg * Math.PI) / 180, at = (v: number) => Math.min(OCC_N - 1, Math.max(0, Math.floor(v / occKm + OCC_N / 2)));
  return at(sKm * Math.cos(a)) * OCC_N + at(sKm * Math.sin(a));
}

/** Builds the occupancy grid of a pack's tilt images (VolumePack.occupancy). */
export function buildOccupancy(moment: VolumeMoment, width: number, tilts: Pick<PackTilt, 'elevation' | 'firstKm' | 'gateKm' | 'gates'>[], layers: Uint8Array[], beamDeg = BEAM_DEG): { occupancy: Uint8Array; occKm: number } {
  const size = OCC_N * OCC_N, RAD = Math.PI / 180;
  const reach = Math.max(1, ...tilts.map((t) => groundRangeKm(t.firstKm + (t.gates - 0.5) * t.gateKm, t.elevation)));
  const occKm = (2 * (reach + 2 * OCC_PAD_KM)) / OCC_N;
  const cell = (km: number) => Math.min(OCC_N - 1, Math.max(0, Math.floor(km / occKm + OCC_N / 2)));
  // Sines and cosines of the padded edges of the azimuth bins (bin b is half a degree wide about AZ_BIN0 + b / 2).
  const edge = (b: number, side: number) => (AZ_BIN0 + b / 2 + side * (0.25 + OCC_PAD_DEG)) * RAD;
  const sin = [-1, 1].map((side) => Float64Array.from({ length: AZ_BINS }, (_, b) => Math.sin(edge(b, side))));
  const cos = [-1, 1].map((side) => Float64Array.from({ length: AZ_BINS }, (_, b) => Math.cos(edge(b, side))));
  const occupancy = new Uint8Array(OCC_IMAGES * size), all = occupancy.subarray(OCC_LAYERS * size, (OCC_LAYERS + 1) * size), coarse = occupancy.subarray((OCC_LAYERS + 1) * size);
  const plan = new Uint8Array(size), km = Math.ceil(reach * Math.SQRT2) + 3, bottom = new Float64Array(km), ceiling = new Float64Array(km);
  tilts.forEach((t, k) => {
    // The tilt on the ground: every cell under a gate, by groups of gates along each radial. A group spans the
    // ground range of its gates (the sampler reads the nearest gate), padded.
    plan.fill(0);
    const img = layers[k], groups = Math.ceil(t.gates / OCC_GATES), from = new Float64Array(groups), to = new Float64Array(groups);
    for (let c = 0; c < groups; c++) {
      from[c] = Math.max(0, groundRangeKm(t.firstKm + (c * OCC_GATES - 0.5) * t.gateKm, t.elevation) - OCC_PAD_KM);
      to[c] = groundRangeKm(t.firstKm + (Math.min(t.gates, (c + 1) * OCC_GATES) - 0.5) * t.gateKm, t.elevation) + OCC_PAD_KM;
    }
    for (let b = 0; b < AZ_BINS; b++) {
      const row = (b + 1) * width, s0 = sin[0][b], s1 = sin[1][b], c0 = cos[0][b], c1 = cos[1][b];
      for (let c = 0; c < groups; c++) {
        let m = 0;
        for (let g = c * OCC_GATES, end = Math.min(t.gates, g + OCC_GATES); g < end; g++) { const v = occupancyCode(moment, img[row + g]); if (v > m) m = v; }
        if (!m) continue;
        // Every cell under the bounding box of the group's footprint (its four corners; the arcs bulge less than the padding).
        const a = from[c], f = to[c];
        const x0 = cell(Math.min(a * s0, a * s1, f * s0, f * s1)), x1 = cell(Math.max(a * s0, a * s1, f * s0, f * s1));
        const y0 = cell(Math.min(a * c0, a * c1, f * c0, f * c1)), y1 = cell(Math.max(a * c0, a * c1, f * c0, f * c1));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m > plan[y * OCC_N + x]) plan[y * OCC_N + x] = m;
      }
    }
    // The elevations the sampler reads this tilt from: half a beamwidth around it, and up to the half-beam zone of a
    // neighbour it is blended with (at most two beamwidths away). Over a cell they span these heights.
    const reachTo = (other: number | undefined) => (other !== undefined && Math.abs(other - t.elevation) <= 2 * beamDeg ? Math.max(Math.abs(other - t.elevation), beamDeg) - beamDeg / 2 : beamDeg / 2);
    const low = t.elevation - reachTo(tilts[k - 1]?.elevation), high = t.elevation + reachTo(tilts[k + 1]?.elevation);
    // Heights of the lowest and highest of them at every whole km of ground range, padded.
    for (let j = 0; j < km; j++) { bottom[j] = tiltHeightKm(j, low) - OCC_PAD_KM; ceiling[j] = tiltHeightKm(j, high) + OCC_PAD_KM; }
    for (let i = 0; i < size; i++) {
      const m = plan[i];
      if (!m) continue;
      // Ground range of the nearest and the farthest point of the cell, outward to whole km.
      const x0 = ((i % OCC_N) - OCC_N / 2) * occKm, y0 = (Math.floor(i / OCC_N) - OCC_N / 2) * occKm, x1 = x0 + occKm, y1 = y0 + occKm;
      const nx = Math.max(x0, -x1, 0), ny = Math.max(y0, -y1, 0), fx = Math.max(-x0, x1), fy = Math.max(-y0, y1);
      const j0 = Math.floor(Math.sqrt(nx * nx + ny * ny)), j1 = Math.min(km - 1, Math.ceil(Math.sqrt(fx * fx + fy * fy)));
      let h0 = bottom[j0], h1 = ceiling[j1];
      for (let j = j0 + 1; j <= j1; j++) if (bottom[j] < h0) h0 = bottom[j];
      for (let z = occLayer(h0), z1 = occLayer(h1); z <= z1; z++) if (m > occupancy[z * size + i]) occupancy[z * size + i] = m;
      if (m > all[i]) all[i] = m;
    }
  });
  for (let y = 0; y < OCC_N; y++) for (let x = 0; x < OCC_N; x++) {
    const i = Math.floor(y / OCC_COARSE) * OCC_N + Math.floor(x / OCC_COARSE);
    if (all[y * OCC_N + x] > coarse[i]) coarse[i] = all[y * OCC_N + x];
  }
  return { occupancy, occKm };
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
  return { moment, width, tilts, layers, ...buildOccupancy(moment, width, tilts, layers) };
}
