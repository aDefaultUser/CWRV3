// HRRR precipitation-type texel packing (runs in the decode worker): RGBA8 with r = frozen-precipitation
// probability, g = category / 4 (0 none, 1 rain, 2 snow, 3 sleet, 4 freezing rain), b = 2 m temperature mapped from
// −40…+40 °C, a = 255 where the texel is valid.

export type PtypeFields = Partial<Record<'cpofp' | 'crain' | 'csnow' | 'cicep' | 'cfrzr' | 't2m', Float32Array>>;

/**
 * Packs the fields of an n-point grid; null when a categorical field is absent. A point is valid only when all four
 * categorical fields are present there and the frozen probability is known: CPOFP ≥ 0, or (CPOFP is the −50
 * "no precipitation" code or missing) a finite 2 m temperature or a diagnosed category. Missing (NaN) points
 * are left invalid (alpha 0) so the display falls back to the plain reflectivity palette there.
 */
export function packPtype(n: number, f: PtypeFields): Uint8Array | null {
  const { cpofp, crain, csnow, cicep, cfrzr, t2m } = f;
  if (!cpofp || !crain || !csnow || !cicep || !cfrzr) return null;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const fr = cfrzr[i], ip = cicep[i], sn = csnow[i], ra = crain[i];
    if (!(Number.isFinite(fr) && Number.isFinite(ip) && Number.isFinite(sn) && Number.isFinite(ra))) continue;
    const cat = fr >= 0.5 ? 4 : ip >= 0.5 ? 3 : sn >= 0.5 ? 2 : ra >= 0.5 ? 1 : 0;
    const t = t2m ? t2m[i] - 273.15 : NaN;
    const p = cpofp[i];
    let prob: number;
    if (Number.isFinite(p) && p >= 0) prob = p / 100;
    else if (Number.isFinite(t)) prob = t <= 0 ? 1 : 0; // CPOFP is −50 where no precipitation is diagnosed
    else if (cat > 0) prob = cat === 1 ? 0 : 1;
    else continue;
    if (cat === 2) prob = Math.max(prob, 0.5); else if (cat === 1) prob = Math.min(prob, 0.5);
    out[i * 4] = Math.round(Math.min(1, Math.max(0, prob)) * 255);
    out[i * 4 + 1] = Math.round((cat / 4) * 255);
    out[i * 4 + 2] = Number.isFinite(t) ? Math.round(Math.min(1, Math.max(0, (t + 40) / 80)) * 255) : 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}
