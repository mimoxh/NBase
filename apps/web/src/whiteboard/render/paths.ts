import type { WhiteboardArrowhead, WhiteboardShapeKind } from '@nbase/contracts';
import type { Point } from '../geometry';
import type { ConnectorPath } from '../model';

/**
 * SVG path data shared by the canvas renderer (through Path2D) and the SVG exporter, so both
 * outputs draw exactly the same outlines.
 */
const n = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);

export const roundRadius = (w: number, h: number) => Math.min(24, Math.min(w, h) * 0.18);

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!radius) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
  return `M${n(x + radius)} ${n(y)}H${n(x + w - radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + w)} ${n(y + radius)}`
    + `V${n(y + h - radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + w - radius)} ${n(y + h)}`
    + `H${n(x + radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x)} ${n(y + h - radius)}`
    + `V${n(y + radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + radius)} ${n(y)}Z`;
}

/** Outline in the element's local frame, origin at its top-left corner. */
export function shapePath(kind: WhiteboardShapeKind, w: number, h: number): string {
  switch (kind) {
    case 'rect': return roundedRectPath(0, 0, w, h, 0);
    case 'roundRect': return roundedRectPath(0, 0, w, h, roundRadius(w, h));
    case 'ellipse': {
      const rx = w / 2, ry = h / 2;
      return `M0 ${n(ry)}A${n(rx)} ${n(ry)} 0 1 0 ${n(w)} ${n(ry)}A${n(rx)} ${n(ry)} 0 1 0 0 ${n(ry)}Z`;
    }
    case 'diamond': return `M${n(w / 2)} 0L${n(w)} ${n(h / 2)}L${n(w / 2)} ${n(h)}L0 ${n(h / 2)}Z`;
    case 'triangle': return `M${n(w / 2)} 0L${n(w)} ${n(h)}L0 ${n(h)}Z`;
  }
}

/** Smooth freehand stroke through the midpoints of consecutive samples. */
export function strokePath(points: readonly Point[]): string {
  if (!points.length) return '';
  const first = points[0]!;
  if (points.length === 1) return `M${n(first.x)} ${n(first.y)}L${n(first.x + 0.01)} ${n(first.y)}`;
  if (points.length === 2) return `M${n(first.x)} ${n(first.y)}L${n(points[1]!.x)} ${n(points[1]!.y)}`;
  let d = `M${n(first.x)} ${n(first.y)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i]!, next = points[i + 1]!;
    d += `Q${n(p.x)} ${n(p.y)} ${n((p.x + next.x) / 2)} ${n((p.y + next.y) / 2)}`;
  }
  const last = points.at(-1)!;
  return `${d}L${n(last.x)} ${n(last.y)}`;
}

export function connectorLinePath(path: ConnectorPath): string {
  if (path.curve) {
    const [p0, c0, c1, p1] = path.curve;
    return `M${n(p0.x)} ${n(p0.y)}C${n(c0.x)} ${n(c0.y)} ${n(c1.x)} ${n(c1.y)} ${n(p1.x)} ${n(p1.y)}`;
  }
  return path.points.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join('');
}

export const arrowSize = (strokeWidth: number) => 7 + strokeWidth * 2.2;

/**
 * Arrowhead at `tip`, where `direction` is the unit vector of travel into the tip.
 * Returns the path and whether it is filled (open chevrons are stroked instead).
 */
export function arrowheadPath(kind: WhiteboardArrowhead, tip: Point, direction: Point, strokeWidth: number): { d: string; filled: boolean } | null {
  if (kind === 'none') return null;
  const size = arrowSize(strokeWidth);
  const back = { x: tip.x - direction.x * size, y: tip.y - direction.y * size };
  const normal = { x: -direction.y, y: direction.x };
  const wing = size * 0.55;
  const left = { x: back.x + normal.x * wing, y: back.y + normal.y * wing };
  const right = { x: back.x - normal.x * wing, y: back.y - normal.y * wing };
  if (kind === 'arrow') return { d: `M${n(left.x)} ${n(left.y)}L${n(tip.x)} ${n(tip.y)}L${n(right.x)} ${n(right.y)}`, filled: false };
  if (kind === 'triangle') return { d: `M${n(left.x)} ${n(left.y)}L${n(tip.x)} ${n(tip.y)}L${n(right.x)} ${n(right.y)}Z`, filled: true };
  if (kind === 'dot') {
    const r = size * 0.36, c = { x: tip.x - direction.x * r, y: tip.y - direction.y * r };
    return { d: `M${n(c.x - r)} ${n(c.y)}A${n(r)} ${n(r)} 0 1 0 ${n(c.x + r)} ${n(c.y)}A${n(r)} ${n(r)} 0 1 0 ${n(c.x - r)} ${n(c.y)}Z`, filled: true };
  }
  const mid = { x: tip.x - direction.x * size * 0.6, y: tip.y - direction.y * size * 0.6 };
  const far = { x: tip.x - direction.x * size * 1.2, y: tip.y - direction.y * size * 1.2 };
  const w2 = size * 0.4;
  return { d: `M${n(tip.x)} ${n(tip.y)}L${n(mid.x + normal.x * w2)} ${n(mid.y + normal.y * w2)}L${n(far.x)} ${n(far.y)}L${n(mid.x - normal.x * w2)} ${n(mid.y - normal.y * w2)}Z`, filled: true };
}

/** Dash pattern scaled with the stroke so dashes stay legible at any width. */
export function dashArray(style: 'solid' | 'dashed' | 'dotted', strokeWidth: number): number[] {
  if (style === 'dashed') return [strokeWidth * 4 + 4, strokeWidth * 2.5 + 3];
  if (style === 'dotted') return [0.1, strokeWidth * 2 + 2];
  return [];
}

/** Bezier edge between two mind-map nodes, left-to-right. */
export function mindEdgePath(from: Point, to: Point): string {
  const dx = Math.max(24, (to.x - from.x) / 2);
  return `M${n(from.x)} ${n(from.y)}C${n(from.x + dx)} ${n(from.y)} ${n(to.x - dx)} ${n(to.y)} ${n(to.x)} ${n(to.y)}`;
}
