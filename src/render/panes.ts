// Pane grid of the map: equal panes in row-major order that share one camera, so a map point has the same
// pane-relative position in every pane. The functions work in any unit (device or CSS pixels).

export interface PaneGrid { cols: number; rows: number }
export const SINGLE_PANE: PaneGrid = { cols: 1, rows: 1 };
export const MAX_PANES = 4;

export const paneCount = (g: PaneGrid) => g.cols * g.rows;

/** Size of one pane of a width × height area; in whole units when `whole` (the remainder at the right and bottom stays empty). */
export function paneSize(g: PaneGrid, width: number, height: number, whole = true): [number, number] {
  const w = width / g.cols, h = height / g.rows;
  return whole ? [Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h))] : [w, h];
}

/** Top-left corner of pane `i` for panes of `w` × `h`. */
export function paneOrigin(g: PaneGrid, i: number, w: number, h: number): [number, number] {
  return [(i % g.cols) * w, Math.floor(i / g.cols) * h];
}

/** The pane under a point of the area and the point relative to that pane; points outside the grid belong to the nearest pane. */
export function paneAt(g: PaneGrid, w: number, h: number, x: number, y: number): { pane: number; x: number; y: number } {
  const col = Math.min(g.cols - 1, Math.max(0, Math.floor(x / w))), row = Math.min(g.rows - 1, Math.max(0, Math.floor(y / h)));
  return { pane: row * g.cols + col, x: x - col * w, y: y - row * h };
}
