// Level 2 product builder: moment recoding, dealiasing, storm-relative velocity,
// azimuthal and gate-to-gate shear, KDP and the volumetric products 11–16.
// Readings that admit more than one interpretation are marked "interpretation".
import type { L2Sweep, L2Volume, L2Moment } from '../decode/archive2';
import { hailThresholds } from '../settings/postload';

/** x87 default rounding: round half to even. */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export interface Codes8 { gates: number; firstKm: number; gateKm: number; codes: Uint8Array }
export interface Codes16 { gates: number; firstKm: number; gateKm: number; codes: Uint16Array }

/** One sweep recoded the way the builder sees it. */
export interface BuilderSweep {
  elevation: number;
  radials: number;
  azimuths: Float32Array;
  /** S flag: 1 = 0.5° spacing (true), 0 = 1°. */
  half: boolean;
  /** Nyquist in code units (nyquist_raw / 50 = 2 × m/s). */
  vn: number;
  complete: boolean;
  ref?: Codes8; vel?: Codes8; sw?: Codes8; zdr?: Codes8; zdr16?: Codes16; phi?: Codes16; rho?: Codes8;
  splitCutDoppler: boolean;
  supplemental: boolean;
}

// --------------------------------------------------------------------------------------------
export function recodeSweep(s: L2Sweep): BuilderSweep {
  const half = s.azimuthSpacing === 0.5;
  const km = (m: L2Moment) => ({ gates: m.gates, firstKm: m.firstGateM / 1000, gateKm: m.gateSpacingM / 1000 });
  const out: BuilderSweep = {
    elevation: s.elevation, radials: s.radialCount, azimuths: s.azimuths, half,
    vn: s.nyquist !== null ? (s.nyquist * 100) / 50 : 0,
    complete: s.radialCount - 1 >= (half ? 719 : 359),
    // Doppler half of a split cut (CD with ambiguity resolution); contiguous-Doppler-only cuts (3) are full tilts.
    splitCutDoppler: !!s.cut && s.cut.waveform === 2,
    supplemental: !!s.cut && ((s.cut.sails && s.cut.sailsSeq > 0) || (s.cut.mrle && s.cut.mrleSeq > 0)),
  };
  const m = s.moments;
  if (m.REF) {
    const src = m.REF.raw, codes = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const r = src[i];
      codes[i] = r <= 1 ? 0 : clamp(roundEven((r - m.REF.offset) / m.REF.scale + 31), 0, 255);
    }
    out.ref = { ...km(m.REF), codes };
  }
  if (m.VEL && m.VEL.wordSize === 8) out.vel = { ...km(m.VEL), codes: m.VEL.raw as Uint8Array };
  if (m.SW && m.SW.wordSize === 8) out.sw = { ...km(m.SW), codes: m.SW.raw as Uint8Array };
  if (m.RHO && m.RHO.wordSize === 8) out.rho = { ...km(m.RHO), codes: m.RHO.raw as Uint8Array };
  if (m.ZDR) {
    if (m.ZDR.wordSize === 8) {
      const src = m.ZDR.raw as Uint8Array, codes = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i++) codes[i] = 255 - src[i]; // inverted, as in the original
      out.zdr = { ...km(m.ZDR), codes };
    } else {
      const src = m.ZDR.raw as Uint16Array, codes = new Uint16Array(src.length);
      for (let i = 0; i < src.length; i++) {
        const w = src[i];
        codes[i] = w <= 1 ? 0 : clamp(roundEven((((w - m.ZDR.offset) / m.ZDR.scale + 7.875) / 15.8125) * 65535), 0, 65535);
      }
      out.zdr16 = { ...km(m.ZDR), codes };
    }
  }
  if (m.PHI) {
    const src = m.PHI.raw, codes = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) { const w = src[i]; codes[i] = w > 1 ? roundEven(((w - 2) / 1021) * 65533) + 2 : w; }
    out.phi = { ...km(m.PHI), codes };
  }
  return out;
}

// --------------------------------------------------------------------------------------------
const unfoldCode = (code: number, r: number, vn: number) => {
  const v = code - 129;
  if (v - r > vn) return clamp(roundEven(v - 2 * vn + 129), 2, 255);
  if (v - r < -vn) return clamp(roundEven(v + 2 * vn + 129), 2, 255);
  return code;
};

/** Dealiasing: per-radial continuity scheme. */
export function dealiasRadial(vel: Codes8, radials: number, half: boolean, vn: number): Uint8Array {
  const n = vel.gates, src = vel.codes, out = src.slice();
  const W = half ? 20 : 10, T = half ? vn : vn / 1.2;
  const hist = new Float64Array(W);
  for (let i = 0; i < radials; i++) {
    let hn = 0, head = 0, sum = 0;
    for (let g = 0; g < n; g++) {
      const c = src[i * n + g];
      if (c < 2) continue;
      let cp = c;
      if (hn === 0) out[i * n + g] = c;
      else {
        const m = sum / hn;
        if (Math.abs(c - m) > T) {
          cp = clamp(m < c ? c - 2 * vn : c + 2 * vn, 2, 255);
          out[i * n + g] = roundEven(cp);
        } else out[i * n + g] = c;
      }
      if (hn < W) { hist[(head + hn) % W] = c; hn++; sum += c; } // raw value while filling
      else { sum -= hist[head]; hist[head] = cp; head = (head + 1) % W; sum += cp; } // corrected once full
    }
  }
  return out;
}

/** Dealiasing: two-dimensional multi-pass scheme. Returns null when no reference radial exists (codes stay raw). */
export function dealias2D(vel: Codes8, radials: number, half: boolean, vn: number): Uint8Array | null {
  const n = vel.gates, N = radials;
  const d = vel.codes.slice();
  const st = new Uint8Array(N * n);
  const T1 = 0.8 * vn, T2 = 0.3 * vn;
  const cyc = (i: number) => ((i % N) + N) % N;
  const valid = (i: number, g: number) => d[i * n + g] >= 2;

  // Step A: reference radial.
  const smooth = new Uint8Array(N), mean = new Float64Array(N), count = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    let ok = true;
    for (let g = 0; g + 1 < n && ok; g++) if (valid(i, g) && valid(i, g + 1) && Math.abs(d[i * n + g + 1] - d[i * n + g]) >= T1) ok = false;
    smooth[i] = ok ? 1 : 0;
    if (!ok) continue;
    let s = 0, k = 0;
    for (let g = 0; g < n; g++) if (valid(i, g)) { const v = d[i * n + g] - 129; if (Math.abs(v) < T2) { s += v; k++; } }
    mean[i] = k ? s / k : 0; count[i] = k;
  }
  let ref = -1, refVel = 0;
  for (let i = 4; i < N && ref < 0; i++) {
    const a = mean[i - 3], b = mean[i - 2], c = mean[i - 1], e = mean[i];
    if ((a > 0 && b > 0 && c < 0 && e < 0) || (a < 0 && b < 0 && c > 0 && e > 0)) {
      ref = count[i - 2] < count[i - 1] ? i - 1 : i - 2;
      refVel = mean[ref];
    }
  }
  if (ref < 0) {
    let best = Infinity;
    for (let i = 0; i < N; i++) {
      if (!smooth[i]) continue;
      let s = 0, k = 0;
      for (let g = 0; g < n; g++) if (valid(i, g)) { s += d[i * n + g] - 129; k++; }
      const m = k ? s / k : 0;
      if (m > 0 && m < best) { best = m; ref = i; refVel = m; }
    }
    if (ref < 0) return null;
  }

  const unfold = (i: number, g: number, r: number) => { d[i * n + g] = unfoldCode(d[i * n + g], r, vn); st[i * n + g] = 1; };

  // Step B: seed.
  for (let g = 0; g < n; g++) { if (valid(ref, g)) unfold(ref, g, refVel); else st[ref * n + g] = 3; }
  for (const adj of [cyc(ref - 1), cyc(ref + 1)]) {
    for (let g = 0; g < n; g++) {
      if (!valid(adj, g)) { st[adj * n + g] = 3; continue; }
      if (st[ref * n + g] !== 1) continue;
      st[adj * n + g] = 1;
      const vr = d[ref * n + g] - 129;
      if (vr - refVel > vn) d[adj * n + g] = clamp(roundEven(vr - 2 * vn + 129), 2, 255);
      else if (vr - refVel < -vn) d[adj * n + g] = clamp(roundEven(vr + 2 * vn + 129), 2, 255);
    }
  }

  const supportOk = (s1: number, s2: number, s3: number, g: number) => {
    if (st[s1 * n + g] !== 1 || st[s2 * n + g] !== 1 || st[s3 * n + g] !== 1) return false;
    const d1 = d[s1 * n + g], d2 = d[s2 * n + g], d3 = d[s3 * n + g];
    return Math.abs(d1 - d2) < T1 && Math.abs(d2 - d3) < T1;
  };
  const supportRef = (s1: number, s2: number, s3: number, g: number) => (d[s1 * n + g] + d[s2 * n + g] + d[s3 * n + g]) / 3 - 129;

  // Step C: pass 1.
  for (const dir of [1, -1]) {
    for (let k = 2; k <= N / 2; k++) {
      const t = cyc(ref + dir * k), s1 = cyc(ref + dir * (k - 1)), s2 = cyc(ref + dir * (k - 2)), s3 = cyc(ref + dir * (k - 3));
      for (let g = 0; g < n; g++) {
        if (!valid(t, g)) { st[t * n + g] = 3; continue; }
        if (supportOk(s1, s2, s3, g)) unfold(t, g, supportRef(s1, s2, s3, g));
      }
      // Radial fill (interpretation: counts are runs starting at g + 1 toward longer range; first qualifying gate only).
      let cv = 0, cs = 0;
      for (let g = n - 1; g >= 0; g--) {
        if (g > 40 && cv >= 41 && cs >= 3 && g + 3 < n && st[t * n + g + 1] === 1 && st[t * n + g + 2] === 1 && valid(t, g)) {
          let lowOk = true;
          for (let h = g - 41; h <= g - 1 && lowOk; h++) if (!valid(t, h)) lowOk = false;
          let diffOk = lowOk;
          for (let h = g - 2; h < g + 2 && diffOk; h++) if (Math.abs(d[t * n + h + 1] - d[t * n + h]) >= T1) diffOk = false;
          if (diffOk && supportOk(s1, s2, s3, g)) {
            for (let h = g; h < n; h++) {
              if (st[t * n + h] === 3) break;
              if (h >= 3) unfold(t, h, (d[t * n + h - 1] + d[t * n + h - 2] + d[t * n + h - 3]) / 3 - 129);
            }
            for (let h = g; h >= 0; h--) {
              if (st[t * n + h] === 3) break;
              if (h + 3 < n) unfold(t, h, (d[t * n + h + 1] + d[t * n + h + 2] + d[t * n + h + 3]) / 3 - 129);
            }
            break;
          }
        }
        cv = valid(t, g) ? cv + 1 : 0;
        cs = st[t * n + g] === 1 ? cs + 1 : 0;
      }
    }
  }

  // Step D: passes 2–4.
  const OFF = half ? [3, 6, 10] : [6, 12, 20], SPAN = [20, 80, 200];
  for (let p = 0; p < 3; p++) {
    for (const dir of [1, -1]) {
      for (let k = 2; k <= N / 2; k++) {
        const t = cyc(ref + dir * k);
        for (let g = 0; g < n; g++) {
          if (st[t * n + g] !== 0) continue;
          for (let o = 0; o < OFF[p]; o++) {
            const s1 = cyc(ref + dir * (k - (o + 1))), s2 = cyc(ref + dir * (k - (o + 2))), s3 = cyc(ref + dir * (k - (o + 3)));
            if (supportOk(s1, s2, s3, g)) { unfold(t, g, supportRef(s1, s2, s3, g)); break; }
          }
        }
        const L = SPAN[p];
        for (let j = 0; j <= n - 81; j++) {
          const targets = j >= 1 && 80 - j >= 0 ? [80 + j, 80 - j] : [80 + j];
          for (const tg of targets) {
            if (tg < 0 || tg >= n || st[t * n + tg] !== 0) continue;
            const last = n - 1;
            for (let h = tg + 1; h <= Math.min(tg + L, last) - 2; h++) {
              if (st[t * n + h] === 1 && st[t * n + h + 1] === 1 && st[t * n + h + 2] === 1) {
                unfold(t, tg, (d[t * n + h] + d[t * n + h + 1] + d[t * n + h + 2]) / 3 - 129); break;
              }
              const m0 = 2 * tg - h + 1, m1 = 2 * tg - h, m2 = 2 * tg - h - 1;
              if (m2 >= 0 && m0 < n && st[t * n + m0] === 1 && st[t * n + m1] === 1 && st[t * n + m2] === 1) {
                unfold(t, tg, (d[t * n + m0] + d[t * n + m1] + d[t * n + m2]) / 3 - 129); break;
              }
            }
          }
        }
      }
    }
  }
  return d;
}

export function dealias(s: BuilderSweep, quality: boolean): Uint8Array | null {
  if (!s.vel) return null;
  if (quality && s.complete) { const r = dealias2D(s.vel, s.radials, s.half, s.vn); return r ?? s.vel.codes.slice(); }
  return dealiasRadial(s.vel, s.radials, s.half, s.vn);
}

// --------------------------------------------------------------------------------------------
export function stormRelative(codes: Uint8Array, s: BuilderSweep, speedKt: number, fromDeg: number): Uint8Array {
  const n = s.vel!.gates, out = codes.slice();
  for (let i = 0; i < s.radials; i++) {
    const add = speedKt * Math.cos(((s.azimuths[i] - fromDeg) * Math.PI) / 180);
    for (let g = 0; g < n; g++) {
      const c = codes[i * n + g];
      if (c >= 2) out[i * n + g] = roundEven(clamp(c + add, 2, 255));
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------
export function median3x3(codes: Uint8Array, N: number, n: number): Uint8Array {
  const M = new Uint8Array(N * n), buf = new Uint8Array(9);
  for (let i = 0; i < N; i++) {
    for (let g = 3; g <= n - 2; g++) {
      let k = 0, nValid = 0;
      for (let di = -1; di <= 1; di++) {
        const r = (i + di + N) % N;
        for (let dg = -1; dg <= 1; dg++) {
          const gg = g + dg;
          const c = gg >= 0 && gg < n ? codes[r * n + gg] : 0;
          const v = c >= 2 ? c : 0;
          if (v) nValid++;
          buf[k++] = v;
        }
      }
      if (!nValid) continue;
      buf.sort();
      M[i * n + g] = buf[4];
    }
  }
  return M;
}

function shearMask(s: BuilderSweep, i: number, g: number, n: number): boolean {
  const ref = s.ref;
  return !!ref && ref.gates >= n && ref.codes[i * ref.gates + g] < 45;
}

export function gateToGate(dealiased: Uint8Array, s: BuilderSweep): Uint8Array {
  const N = s.radials, n = s.vel!.gates;
  const M = median3x3(dealiased, N, n), out = new Uint8Array(N * n);
  for (let i = 0; i < N; i++) {
    const i1 = (i + 1) % N;
    for (let g = 0; g < n; g++) {
      let G = 0;
      if (g >= 7 && g <= n - 9 && M[i * n + g] > 1 && M[i1 * n + g] > 1) G = (M[i1 * n + g] - M[i * n + g]) / 2;
      let value = 2 * G;
      if (shearMask(s, i, g, n)) value = 0;
      let code = roundEven(clamp(value, -127, 128) + 127);
      if (code === 255) code = 254;
      out[i * n + g] = code;
    }
  }
  return out;
}

export function azimuthalShear(dealiased: Uint8Array, s: BuilderSweep): Uint8Array {
  const N = s.radials, n = s.vel!.gates, c = s.half ? 2 : 1;
  const M = median3x3(dealiased, N, n), out = new Uint8Array(N * n);
  const cyc = (i: number) => ((i % N) + N) % N;
  for (let i = 0; i < N; i++) {
    for (let g = 0; g < n; g++) {
      let A = 0;
      if (g >= 7 && g <= n - 9) {
        let k = 0, pos = 0, neg = 0;
        for (const [ri, side] of [[i - 3 * c, -1], [i - 2 * c, -1], [i + 2 * c, 1], [i + 3 * c, 1]] as const) {
          for (const gg of [g - 3 * c, g + 3 * c, g - 2 * c, g + 2 * c]) {
            if (gg < 0 || gg >= n) continue;
            const v = M[cyc(ri) * n + gg];
            if (v < 2) continue;
            k++;
            if (side > 0) pos += v; else neg += v;
          }
        }
        if (k >= 15) A = (pos - neg) / k / ((17 * g) / (n - 3));
      }
      let value = 2 * A;
      if (shearMask(s, i, g, n)) value = 0;
      let code = roundEven(((clamp(value, -40, 40) + 40) * 255) / 80);
      if (code === 255) code = 254;
      out[i * n + g] = code;
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------
export function kdp(s: BuilderSweep): Uint8Array | null {
  if (!s.phi) return null;
  const N = s.radials, n = s.phi.gates, out = new Uint8Array(N * n);
  const P = new Int32Array(n), D = new Int32Array(n), w = new Int32Array(7);
  const ref = s.ref;
  for (let i = 0; i < N; i++) {
    const row = s.phi.codes.subarray(i * n, (i + 1) * n);
    P.fill(0);
    for (let g = 3; g <= n - 4; g++) { for (let k = 0; k < 7; k++) w[k] = row[g - 3 + k]; w.sort(); P[g] = w[3]; }
    for (let g = 0; g < n; g++) D[g] = row[g]; // the original overwrites the word buffer in place: edges keep raw words
    for (let g = 4; g <= n - 5; g++) {
      D[g] = P[g] === 0 || P[g + 1] === 0 || P[g] > 54497 || P[g + 1] > 54497 ? 0 : roundEven(clamp(P[g + 1] - P[g], -32767, 32768) + 32767);
    }
    for (let g = 0; g < n; g++) {
      let K = 0;
      const hasRef = !!ref && g < ref.gates;
      if (g >= 5 && g <= n - 6 && hasRef && ref!.codes[i * ref!.gates + g] > 50 && D[g] !== 0 && D[g + 1] !== 0) {
        let sum = 0, all = true;
        for (let h = g - 5; h <= g + 5; h++) { if (D[h] === 0) { all = false; break; } sum += D[h]; }
        if (all) K = sum / 11 - 32767;
        if (s.half) K *= 2;
      }
      const val = (K * 360) / 65535;
      let code = roundEven(((clamp(val, -2, 9) + 2) / 11) * 255);
      if (code === 255) code = 254;
      out[i * n + g] = code;
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------
export interface VolumetricParams {
  hailZLower: number; hailZUpper: number;
  isothermAuto: boolean; h0Custom: number; hm20Custom: number;
  /** Environmental isotherm heights (m), already interpolated to the volume time; null when unavailable or stale. */
  envIsotherms: { h0: number; hm20: number } | null;
  etThreshold: number;
  gust1991: boolean;
}

export interface VolumetricGrid { radials: 720; gates: number; gateKm: number; firstKm: number; az0: number; codes: Uint8Array }

/** Beam height above the radar (km), */
export const beamHeightKm = (rKm: number, elDeg: number) => rKm * Math.sin((elDeg * Math.PI) / 180) + (rKm * rKm) / 15417.82;

/** Sweeps used by the volumetric routine: reflectivity sweeps in file order with strictly increasing elevation. */
export function volumetricSweeps(sweeps: BuilderSweep[]): BuilderSweep[] {
  const kept: BuilderSweep[] = [];
  for (const s of sweeps) {
    if (!s.ref || s.supplemental || s.splitCutDoppler) continue; // interpretation of the two exclusion flags
    if (kept.length && s.elevation <= kept[kept.length - 1].elevation) continue;
    kept.push(s);
  }
  return kept;
}

/** Resamples each kept sweep's reflectivity (dBZ = code − 31) onto 720 half-degree bins (shared frame). */
export function stackSweeps(kept: BuilderSweep[]): { az0: number; gates: number; firstKm: number; z: Float32Array[] } {
  const az0 = kept[0].azimuths[0];
  const gates = Math.min(1832, Math.max(...kept.map((s) => s.ref!.gates)));
  const firstKm = kept[0].ref!.firstKm;
  const z = kept.map((s) => {
    const sum = new Float32Array(720 * gates), wsum = new Float32Array(720 * gates);
    const ng = s.ref!.gates, start = s.azimuths[0];
    const base = (((start - az0) * 2 + 720) % 720 + 720) % 720;
    const reps = s.half ? 1 : 2;
    for (let r = 0; r < s.radials; r++) {
      for (let rep = 0; rep < reps; rep++) {
        const p = base + (s.half ? r : 2 * r + rep);
        const b0 = Math.floor(p) % 720, b1 = (b0 + 1) % 720, f = p - Math.floor(p);
        for (let g = 0; g < Math.min(ng, gates); g++) {
          const c = s.ref!.codes[r * ng + g];
          if (c === 0) continue;
          const v = c - 31;
          sum[b0 * gates + g] += (1 - f) * v; wsum[b0 * gates + g] += 1 - f;
          if (f > 0) { sum[b1 * gates + g] += f * v; wsum[b1 * gates + g] += f; }
        }
      }
    }
    const out = new Float32Array(720 * gates).fill(NaN);
    for (let k = 0; k < out.length; k++) if (wsum[k] > 0) out[k] = sum[k] / wsum[k];
    return out;
  });
  return { az0, gates, firstKm, z };
}

/** Writes the output texture: half the gate count at twice the gate size, each output gate = max of its two sources. */
function packOutput(values: Float32Array, srcGates: number, outGates: number, upper: number, encode: (v: number) => number): Uint8Array {
  const out = new Uint8Array(720 * outGates);
  for (let b = 0; b < 720; b++) {
    for (let og = 0; og < outGates; og++) {
      const g0 = og * 2, g1 = g0 + 1;
      let v = -Infinity;
      if (g0 < srcGates) { const a = values[b * srcGates + g0]; if (a === a) v = Math.max(v, a); }
      if (g1 < srcGates) { const a = values[b * srcGates + g1]; if (a === a) v = Math.max(v, a); }
      if (v === -Infinity) continue;
      out[b * outGates + og] = v >= upper ? 255 : encode(v);
    }
  }
  return out;
}

export function volumetric(product: 11 | 12 | 13 | 14 | 15 | 16, sweeps: BuilderSweep[], p: VolumetricParams): VolumetricGrid | null {
  const kept = volumetricSweeps(sweeps);
  if (kept.length < 3) return null;
  const { az0, gates, firstKm, z } = stackSweeps(kept);
  const outGates = product <= 13 ? 916 : 690;
  const srcGates = Math.min(gates, outGates * 2);
  const vals = new Float32Array(720 * srcGates).fill(NaN);
  const L = kept.length;
  const el = kept.map((s) => s.elevation);

  if (product === 11 || product === 12) {
    const [zl, zu] = hailThresholds(p.hailZLower, p.hailZUpper);
    let h0 = p.h0Custom, hm20 = p.hm20Custom;
    if (p.isothermAuto && p.envIsotherms) { h0 = p.envIsotherms.h0; hm20 = p.envIsotherms.hm20; }
    if (!(h0 < hm20)) return grid(new Uint8Array(720 * outGates));
    const WT = 57.5 * (h0 / 1000) - 121;
    for (let g = 0; g < srcGates; g++) {
      const r = firstKm + g / 4;
      const hM = el.map((e) => beamHeightKm(r, e) * 1000);
      const dh = hM.map((h, k) => {
        if (k === 0) return hM[0] <= h0 ? hM[1] - hM[0] : (hM[0] + hM[1]) / 2 - h0;
        if (k === L - 1) return hM[k] - hM[k - 1];
        return (hM[k + 1] - hM[k - 1]) / 2;
      });
      for (let b = 0; b < 720; b++) {
        let shi = 0, any = false;
        for (let k = 0; k < L; k++) {
          const Z = z[k][b * gates + g];
          if (!(Z > zl)) { if (Z === Z) any = true; continue; }
          any = true;
          const W = Z >= zu ? 1 : (Z - zl) / (zu - zl);
          const E = 5e-6 * 10 ** (0.084 * Z) * W;
          const h = hM[k];
          const WTh = h <= h0 ? 0 : h >= hm20 ? 1 : (h - h0) / (hm20 - h0);
          shi += WTh * E * dh[k];
        }
        if (!any) continue;
        shi *= 0.1;
        if (product === 11) vals[b * srcGates + g] = Math.min(7, 2.54 * Math.sqrt(shi) * 0.0393701);
        else vals[b * srcGates + g] = shi > 0 && WT > 0 ? clamp(29 * Math.log(shi / WT) + 50, 0, 100) : 0;
      }
    }
    return product === 11
      ? grid(packOutput(vals, srcGates, outGates, 7, (v) => roundEven((v / 7) * 255)))
      : grid(packOutput(vals, srcGates, outGates, 100, (v) => roundEven((v / 100) * 255)));
  }

  // 13–16: VIL, VILD, ET, gust (sweeps processed from the highest elevation down).
  const thm = ((el[0] + el[1]) / 2) * Math.PI / 180;
  const rad = (x: number) => (x * Math.PI) / 180;
  const delta = kept[L - 1].half ? 0.5 : 1;
  for (let g = 0; g < srcGates; g++) {
    const rG = g / 4; // as in the original: g/4 km without the first-gate offset
    const r = firstKm + g / 4;
    const dhKm = el.map((_, k) => {
      if (k === 0) return rG * Math.tan(thm) + (rG * rG) / (16989.33 * Math.cos(thm) ** 2);
      if (k === L - 1) return 0.5 * rG * (Math.tan(rad(el[k] + delta / 2)) - Math.tan(rad(el[k - 1])));
      return 0.5 * rG * (Math.tan(rad(el[k + 1])) - Math.tan(rad(el[k - 1])));
    });
    const hM = el.map((e) => beamHeightKm(r, e) * 1000);
    for (let b = 0; b < 720; b++) {
      let vil = 0, et = -1, any = false;
      for (let k = L - 1; k >= 0; k--) {
        const Z = z[k][b * gates + g];
        if (Z !== Z) continue;
        any = true;
        if (Z > 18) vil += 0.00344 * 10 ** ((4 * Math.min(Z, 56)) / 70) * dhKm[k];
        if (et < 0 && Z >= p.etThreshold) et = hM[k]; // interpolation term toward the beam above not applied
      }
      if (!any) continue;
      const etM = et >= 0 ? Math.round(et / 304.8) * 304.8 : 0;
      let v: number;
      if (product === 13) v = Math.min(vil, 80);
      else if (product === 14) v = etM > 0 ? Math.min(vil / (etM / 1000), 8) : 0;
      else if (product === 15) v = etM;
      else {
        const arg = p.gust1991 ? 20.628571 * vil - 3.125e-6 * etM * etM : 15.780608 * vil - 2.3810964e-6 * etM * etM;
        v = Math.min(arg > 0 ? 2.2369 * Math.sqrt(arg) : 0, 100);
      }
      vals[b * srcGates + g] = v;
    }
  }
  const enc: Record<number, [number, (v: number) => number]> = {
    13: [80, (v) => roundEven((v / 80) * 255)],
    14: [8, (v) => roundEven((v / 8) * 255)],
    15: [Infinity, (v) => roundEven(Math.max(v / 21000, 0) * 255) & 0xff], // the original's upper test never fires; >21 km overflows the byte
    16: [100, (v) => roundEven((v / 100) * 255)],
  };
  const [upper, encode] = enc[product];
  return grid(packOutput(vals, srcGates, outGates, upper, encode));

  function grid(codes: Uint8Array): VolumetricGrid {
    return { radials: 720, gates: outGates, gateKm: 0.5, firstKm, az0, codes };
  }
}

// -------------------------------------------------------------------------------------------- dispatcher
export interface L2BuildParams extends VolumetricParams {
  qualityDealiasing: boolean;
  stormMotion: { speedKt: number; fromDeg: number };
}

/**
 * The algorithm inputs a product depends on, as a key (two sweeps of a product with equal keys mean the same
 * thing). Environmental isotherms and an automatic storm motion only refine a product as new data arrives, so they
 * are left out (`autoMotion`); manual settings are included.
 */
export function algorithmKey(product: number, p: Omit<L2BuildParams, 'envIsotherms'>, autoMotion = false): string {
  const k: unknown[] = [];
  if (product >= 6 && product <= 9) k.push(p.qualityDealiasing);
  if (product === 7) k.push(autoMotion ? 'auto' : `${p.stormMotion.speedKt}/${p.stormMotion.fromDeg}`);
  if (product === 11 || product === 12) k.push(p.hailZLower, p.hailZUpper, p.isothermAuto, p.h0Custom, p.hm20Custom);
  if (product >= 14 && product <= 16) k.push(p.etThreshold); // echo top also enters VILD and gust
  if (product === 16) k.push(p.gust1991);
  return k.join(',');
}

export interface L2ProductSweep {
  product: number;
  radials: number; gates: number; firstKm: number; gateKm: number;
  /** Azimuth of each radial (deg, file order). Volumetric products use 720 uniform half-degree bins. */
  azimuths: Float32Array;
  half: boolean; complete: boolean; elevation: number;
  codes: Uint8Array | Uint16Array;
  wordSize: 8 | 16;
}

export function buildProduct(product: number, s: BuilderSweep, all: BuilderSweep[], p: L2BuildParams): L2ProductSweep | null {
  const wrap = (m: Codes8 | Codes16, codes: Uint8Array | Uint16Array, word: 8 | 16 = 8): L2ProductSweep => ({
    product, radials: s.radials, gates: m.gates, firstKm: m.firstKm, gateKm: m.gateKm, azimuths: s.azimuths,
    half: s.half, complete: s.complete, elevation: s.elevation, codes, wordSize: word,
  });
  switch (product) {
    case 0: return s.ref ? wrap(s.ref, s.ref.codes) : null;
    case 1: return s.vel ? wrap(s.vel, s.vel.codes) : null;
    case 2: return s.sw ? wrap(s.sw, s.sw.codes) : null;
    case 3: return s.zdr ? wrap(s.zdr, s.zdr.codes) : s.zdr16 ? wrap(s.zdr16, s.zdr16.codes, 16) : null;
    case 4: return s.phi ? wrap(s.phi, s.phi.codes, 16) : null;
    case 5: return s.rho ? wrap(s.rho, s.rho.codes) : null;
    case 6: case 7: case 8: case 9: {
      const dv = dealias(s, p.qualityDealiasing);
      if (!dv) return null;
      if (product === 6) return wrap(s.vel!, dv);
      if (product === 7) return wrap(s.vel!, stormRelative(dv, s, p.stormMotion.speedKt, p.stormMotion.fromDeg));
      return wrap(s.vel!, product === 8 ? azimuthalShear(dv, s) : gateToGate(dv, s));
    }
    case 10: { const k = kdp(s); return k ? wrap(s.phi!, k) : null; }
    default: {
      const g = volumetric(product as 11, all, p);
      if (!g) return null;
      const az = new Float32Array(720);
      for (let i = 0; i < 720; i++) az[i] = (g.az0 + i * 0.5) % 360;
      return { product, radials: 720, gates: g.gates, firstKm: g.firstKm, gateKm: g.gateKm, azimuths: az, half: true, complete: true, elevation: all[0]?.elevation ?? 0, codes: g.codes, wordSize: 8 };
    }
  }
}

export function recodeVolume(v: L2Volume): BuilderSweep[] { return v.sweeps.map(recodeSweep); }

// -------------------------------------------------------------------------------------------- live composite
/**
 * Low-level composite across tilts. The CAPPI weight per elevation follows the original (1 at or below the base,
 * 0 at or above the top, linear between; heights in metres above the radar). How the original consumes the weight
 * was not traced (open): this implementation takes the selective maximum of reflectivity over sweeps with a
 * non-zero weight, or the weight-normalized mean when selective maximum is off.
 */
export function liveComposite(sweeps: BuilderSweep[], baseM: number, topM: number, selectiveMax: boolean): VolumetricGrid | null {
  const kept = volumetricSweeps(sweeps);
  if (!kept.length) return null;
  const { az0, gates, firstKm, z } = stackSweeps(kept);
  const outGates = Math.ceil(gates / 2);
  const vals = new Float32Array(720 * gates).fill(NaN);
  for (let g = 0; g < gates; g++) {
    const r = firstKm + g / 4;
    const w = kept.map((s) => { const h = beamHeightKm(r, s.elevation) * 1000; return h <= baseM ? 1 : h >= topM ? 0 : 1 - (h - baseM) / (topM - baseM); });
    for (let b = 0; b < 720; b++) {
      let best = -Infinity, sum = 0, ws = 0;
      for (let k = 0; k < kept.length; k++) {
        const Z = z[k][b * gates + g];
        if (Z !== Z || w[k] <= 0) continue;
        if (Z > best) best = Z;
        sum += Z * w[k]; ws += w[k];
      }
      if (ws > 0) vals[b * gates + g] = selectiveMax ? best : sum / ws;
    }
  }
  const codes = new Uint8Array(720 * outGates);
  for (let b = 0; b < 720; b++) for (let og = 0; og < outGates; og++) {
    const a = vals[b * gates + og * 2], c = og * 2 + 1 < gates ? vals[b * gates + og * 2 + 1] : NaN;
    const v = a !== a ? c : c !== c ? a : Math.max(a, c);
    if (v === v) codes[b * outGates + og] = clamp(roundEven(v + 31), 1, 255);
  }
  return { radials: 720, gates: outGates, gateKm: 0.5, firstKm, az0, codes };
}
