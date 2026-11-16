// WPC coded surface bulletin (CODSUS) parser. Positions are "LLlll" groups: two digits of latitude (°N)
// followed by two or three digits of longitude (°W). Centers are "pressure position" pairs.

export type FrontType = 'COLD' | 'WARM' | 'STNRY' | 'OCFNT' | 'TROF' | 'DRYLINE';
export interface Front { type: FrontType; points: [number, number][] } // [lon, lat]
export interface Center { kind: 'H' | 'L'; mb: number; lon: number; lat: number }
export interface SurfaceAnalysis { validMs: number | null; fronts: Front[]; centers: Center[] }

const pos = (g: string): [number, number] => [-Number(g.slice(2)), Number(g.slice(0, 2))];

export function parseCodsus(text: string, refYear = new Date().getUTCFullYear(), refMonth = new Date().getUTCMonth()): SurfaceAnalysis {
  const out: SurfaceAnalysis = { validMs: null, fronts: [], centers: [] };
  // Records may continue on the following line when they do not start with a keyword.
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (/^(HIGHS|LOWS|COLD|WARM|STNRY|OCFNT|TROF|DRYLINE|VALID)\b/.test(l) || !lines.length) lines.push(l);
    else if (/^[\d\s]+$/.test(l)) lines[lines.length - 1] += ' ' + l;
    else lines.push(l);
  }
  for (const l of lines) {
    const tok = l.split(/\s+/);
    const kw = tok[0];
    if (kw === 'VALID' && /^\d{6}Z$/.test(tok[1] ?? '')) {
      const mm = Number(tok[1].slice(0, 2)) - 1, dd = Number(tok[1].slice(2, 4)), hh = Number(tok[1].slice(4, 6));
      const year = mm > refMonth + 6 ? refYear - 1 : refYear;
      out.validMs = Date.UTC(year, mm, dd, hh);
    } else if (kw === 'HIGHS' || kw === 'LOWS') {
      for (let i = 1; i + 1 < tok.length; i += 2) {
        const [lon, lat] = pos(tok[i + 1]);
        out.centers.push({ kind: kw === 'HIGHS' ? 'H' : 'L', mb: Number(tok[i]), lon, lat });
      }
    } else if (['COLD', 'WARM', 'STNRY', 'OCFNT', 'TROF', 'DRYLINE'].includes(kw)) {
      const pts = tok.slice(1).filter((g) => /^\d{4,5}$/.test(g)).map(pos);
      if (pts.length >= 2) out.fronts.push({ type: kw as FrontType, points: pts });
    }
  }
  return out;
}
