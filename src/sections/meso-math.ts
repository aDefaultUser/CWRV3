// MESO tab numerics: decoder-unit conversion, 16-bit quantisation, and the
// instruction-recovered STP/SCP arithmetic with the texture coupling defect. Parity mode is the default; the
// corrected mode (ext.settings.mesoCorrectedFormulas) uses SPC-style terms and mph gusts and is flagged non-parity.
import { rne } from '../util/round';

/**
 * Converts a GRIB SI value to the unit the original's decoder delivered (web rule):
 * TMP K → °F, VIS m → statute miles, GUST m/s → knots (parity, labelled mph) or mph (corrected).
 */
export function mesoDecoderUnits(match: string, v: number, corrected = false): number {
  if (/^TMP:|^DPT:/.test(match)) return (v - 273.15) * 1.8 + 32;
  if (/^VIS:/.test(match)) return v / 1609.344;
  if (/^GUST:/.test(match)) return corrected ? v * 2.23693629 : (v * 3600) / 1852;
  return v;
}

/** quantisation with round half to even, clamped to 0..65534. */
export function mesoCode(v: number, lo: number, hi: number): number {
  const q = rne(((v - lo) * 65535) / (hi - lo));
  return q < 0 ? 0 : q > 65534 ? 65534 : q;
}

export interface SevereInputs { cape: number; srh1: number; u6: number; v6: number; tF: number; tdF: number; pPa: number; srh3: number }

/** STP and SCP for one cell (parity) or the SPC-style corrected forms. */
export function severeCell(x: SevereInputs, corrected = false): { stp: number; scp: number; pl: number } {
  const shear = Math.sqrt(x.u6 * x.u6 + x.v6 * x.v6);
  const tK = (x.tF - 32) / 1.8 + 273.15, tdK = (x.tdF - 32) / 1.8 + 273.15;
  // Vendor variant of Bolton: the 56 K term uses the air temperature.
  const tL = 1 / (1 / (tK - 56) + Math.log(tK / tdK) / 800) + 56;
  const pl = Math.pow(tL / tK, 3.5) * x.pPa / 100;
  if (!corrected) {
    return { stp: ((2000 - pl) / 1000) * (x.cape / 1500) * (Math.abs(x.srh1) / 150) * (shear / 20), scp: (x.cape / 1000) * (shear / 20) * (x.srh3 / 50), pl };
  }
  // Corrected (SPC fixed-layer STP, effective-layer SCP approximated with surface CAPE, 0–3 km SRH and 0–6 km shear).
  const lclM = 125 * ((x.tF - x.tdF) / 1.8);
  const lclTerm = lclM < 1000 ? 1 : lclM > 2000 ? 0 : (2000 - lclM) / 1000;
  const shrTerm = shear < 12.5 ? 0 : Math.min(shear, 30) / 20;
  const scpShr = shear < 10 ? 0 : shear > 20 ? 1 : shear / 20;
  return { stp: (x.cape / 1500) * lclTerm * (x.srh1 / 150) * shrTerm, scp: (x.cape / 1000) * (x.srh3 / 50) * scpShr, pl };
}

/**
 * 16-bit texture codes. Parity: STP 0..10, SCP 0..50; a negative SCP forces the STP code to 0 and an SCP
 * ≥ 50 forces it to 65534; those SCP texels are not written by the original (choose 0 / 65534, `scpWritten` false).
 */
export function severeCodes(stp: number, scp: number, corrected = false): { stp: number; scp: number; scpWritten: boolean } {
  const code = (v: number, span: number) => (!(v >= 0) ? 0 : v >= span ? 65534 : rne((v / span) * 65535));
  let s = code(stp, 10);
  if (corrected) return { stp: s, scp: code(scp, 50), scpWritten: true };
  if (scp < 0) return { stp: 0, scp: 0, scpWritten: false };
  if (scp >= 50) return { stp: 65534, scp: 65534, scpWritten: false };
  return { stp: s, scp: code(scp, 50), scpWritten: true };
}

/** Valid time of the newest STP/SCP frame: current hour when minute ≥ 51, else the previous hour. */
export function severeFrameTime(nowMs: number): number {
  const d = new Date(nowMs);
  const h = Math.floor(nowMs / 3600e3) * 3600e3;
  return d.getUTCMinutes() >= 51 ? h : h - 3600e3;
}
