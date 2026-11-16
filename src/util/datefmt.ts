// Delphi FormatDateTime-style formatting for the user-editable time formats (map timestamp, manual-track times):
// yyyy yy, mmmm mmm mm m (month; mm/m right after an hour token mean minutes), dddd ddd dd d, hh h, nn n, ss s,
// am/pm a/p ampm (AMPM), and quoted literal text.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TOKEN = /"[^"]*"|'[^']*'|am\/pm|a\/p|ampm|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|nn|n|ss|s/gi;

export function formatDateTime(ms: number, fmt: string, utc = false): string {
  const d = new Date(ms);
  const g = utc
    ? { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), W: d.getUTCDay(), H: d.getUTCHours(), N: d.getUTCMinutes(), S: d.getUTCSeconds() }
    : { Y: d.getFullYear(), M: d.getMonth(), D: d.getDate(), W: d.getDay(), H: d.getHours(), N: d.getMinutes(), S: d.getSeconds() };
  const twelve = /am\/pm|a\/p|ampm/i.test(fmt);
  const h = twelve ? ((g.H + 11) % 12) + 1 : g.H;
  const pad = (v: number) => String(v).padStart(2, '0');
  let afterHour = false;
  return fmt.replace(TOKEN, (tok) => {
    const t = tok.toLowerCase();
    const wasHour = afterHour;
    afterHour = t === 'h' || t === 'hh';
    if (tok[0] === '"' || tok[0] === "'") return tok.slice(1, -1);
    const upper = tok === tok.toUpperCase();
    switch (t) {
      case 'am/pm': { const v = g.H < 12 ? 'am' : 'pm'; return upper ? v.toUpperCase() : v; }
      case 'a/p': { const v = g.H < 12 ? 'a' : 'p'; return upper ? v.toUpperCase() : v; }
      case 'ampm': return g.H < 12 ? 'AM' : 'PM';
      case 'yyyy': return String(g.Y);
      case 'yy': return pad(g.Y % 100);
      case 'mmmm': return MONTHS[g.M];
      case 'mmm': return MONTHS[g.M].slice(0, 3);
      case 'mm': return wasHour ? pad(g.N) : pad(g.M + 1);
      case 'm': return wasHour ? String(g.N) : String(g.M + 1);
      case 'dddd': return DAYS[g.W];
      case 'ddd': return DAYS[g.W].slice(0, 3);
      case 'dd': return pad(g.D);
      case 'd': return String(g.D);
      case 'hh': return pad(h);
      case 'h': return String(h);
      case 'nn': return pad(g.N);
      case 'n': return String(g.N);
      case 'ss': return pad(g.S);
      default: return String(g.S);
    }
  });
}

/**
 * Clock for local-time displays: the browser zone, or a fixed UTC offset when the time-zone override is on
 * (Time/ZoneOverride + ZoneOverrideZOffset hours). Returns the shifted instant to format as UTC and a zone label.
 */
export function zoneClock(ms: number, override: boolean, offsetHours: number): { ms: number; utc: boolean; zone: string | null } {
  if (!override) return { ms, utc: false, zone: null };
  const sign = offsetHours < 0 ? '−' : '+', a = Math.abs(offsetHours), h = Math.trunc(a), m = Math.round((a - h) * 60);
  return { ms: ms + offsetHours * 3600e3, utc: true, zone: `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}` };
}
