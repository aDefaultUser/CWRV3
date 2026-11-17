// Cloud Nuke branding (user request): the supplied logo is black artwork on a transparent background, so it is
// used as an alpha mask — tinted light with a dark contrasting outline — never shown as-is on the dark map.
// One watermark tile is drawn for the live view (DOM overlay) and the same tile is composited into PNG captures
// and video recordings, together with the legend, timestamp and product time labels.
export const BRAND_LINE = 'made by Cloud Nuke Software Collective';
export const CREDIT_LINE = 'Original idea made by Paul Marv Software';
/** Public source repository (opened in a new tab; never navigates the app). */
export const REPO_URL = 'https://github.com/aDefaultUser/CWRV3';
export const LOGO_URL = '/assets/branding/cloud-nuke.png';

let logo: HTMLImageElement | null = null;
let logoReady: Promise<HTMLImageElement> | null = null;
export function loadLogo(): Promise<HTMLImageElement> {
  if (!logoReady) logoReady = new Promise((res, rej) => { const i = new Image(); i.onload = () => { logo = i; res(i); }; i.onerror = () => rej(new Error('logo failed to load')); i.src = LOGO_URL; });
  return logoReady;
}

/** Logo silhouette in a colour (alpha of the PNG kept), drawn into a new canvas of size s×s device px. */
function tinted(img: HTMLImageElement, s: number, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, s, s);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color; g.fillRect(0, 0, s, s);
  return c;
}

/**
 * Watermark tile in device pixels: light logo with a dark outline, then the creator line in a readable condensed
 * face with a halo. Size scales with DPR so the overlay stays small and crisp at 4K.
 */
export function watermarkTile(dpr: number): HTMLCanvasElement | null {
  if (!logo) return null;
  const k = Math.max(1, dpr);
  const L = Math.round(26 * k), pad = Math.round(4 * k), gap = Math.round(7 * k);
  const font = `600 ${Math.round(12 * k)}px "Noto Sans Condensed", "Segoe UI", "DejaVu Sans", sans-serif`;
  const meas = document.createElement('canvas').getContext('2d')!; meas.font = font;
  const tw = Math.ceil(meas.measureText(BRAND_LINE).width);
  const c = document.createElement('canvas');
  c.width = pad * 2 + L + gap + tw + pad; c.height = pad * 2 + L;
  const g = c.getContext('2d')!;
  // Soft translucent plate keeps the mark readable over bright imagery without hiding the map.
  g.fillStyle = 'rgba(8, 12, 22, 0.42)';
  const r = Math.round(5 * k);
  g.beginPath(); g.roundRect(0, 0, c.width, c.height, r); g.fill();
  const outline = tinted(logo, L, 'rgba(0,0,0,0.9)'), light = tinted(logo, L, '#eef3ff');
  const o = Math.max(1, Math.round(1.2 * k));
  for (const [dx, dy] of [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, o], [-o, o], [o, -o]]) g.drawImage(outline, pad + dx, pad + dy);
  g.drawImage(light, pad, pad);
  g.font = font; g.textBaseline = 'middle';
  g.lineWidth = Math.max(2, 3 * k); g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineJoin = 'round';
  const tx = pad + L + gap, ty = c.height / 2 + Math.round(0.5 * k);
  g.strokeText(BRAND_LINE, tx, ty);
  g.fillStyle = '#e8eefc'; g.fillText(BRAND_LINE, tx, ty);
  return c;
}

/** Top-left position (CSS px) of a box of size w×h at a corner (0 TL, 1 TR, 2 BL, 3 BR) with a margin and a vertical stack offset. */
export function cornerPos(corner: number, W: number, H: number, w: number, h: number, margin: number, stack = 0): [number, number] {
  const x = corner % 2 ? W - w - margin : margin;
  const y = corner >= 2 ? H - h - margin - stack : margin + stack;
  return [x, y];
}
