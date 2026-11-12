/** Pure 2D helpers for the whiteboard engine. World units are CSS pixels at zoom 1; y grows downwards. */
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Box extends Rect { angle: number }

export const round = (value: number, digits = 2) => { const f = 10 ** digits; return Math.round(value * f) / f; };
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const centerOf = (rect: Rect): Point => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

export function rotatePoint(point: Point, origin: Point, angle: number): Point {
  if (!angle) return point;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = point.x - origin.x, dy = point.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/** World point → the box's unrotated frame. */
export const toLocal = (point: Point, box: Box): Point => rotatePoint(point, centerOf(box), -box.angle);
export const toWorld = (point: Point, box: Box): Point => rotatePoint(point, centerOf(box), box.angle);

export function corners(box: Box): Point[] {
  const c = centerOf(box);
  return [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }]
    .map(point => rotatePoint(point, c, box.angle));
}

export function boundsOfPoints(points: readonly Point[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return points.length ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Axis-aligned bounds of a possibly rotated box. */
export const aabb = (box: Box): Rect => box.angle ? boundsOfPoints(corners(box)) : { x: box.x, y: box.y, w: box.w, h: box.h };

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export const rectsIntersect = (a: Rect, b: Rect) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
export const rectContains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const pointInRect = (p: Point, r: Rect, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
export const expandRect = (r: Rect, pad: number): Rect => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
export const normalizeRect = (a: Point, b: Point): Rect =>
  ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolyline(p: Point, points: readonly Point[], closed = false): number {
  if (points.length === 1) return distance(p, points[0]!);
  let best = Infinity;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i += 1) best = Math.min(best, distanceToSegment(p, points[i]!, points[(i + 1) % points.length]!));
  return best;
}

export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denominator;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * rx, y: a.y + t * ry } : null;
}

/** Where the segment from `inside` towards `outside` leaves the polygon; `inside` when it never does. */
export function exitPoint(inside: Point, outside: Point, polygon: readonly Point[]): Point {
  let best: Point | null = null, bestDistance = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const hit = segmentIntersection(inside, outside, polygon[i]!, polygon[(i + 1) % polygon.length]!);
    if (!hit) continue;
    const d = distance(hit, outside);
    if (d < bestDistance) { best = hit; bestDistance = d; }
  }
  return best ?? inside;
}

export type OutlineKind = 'rect' | 'roundRect' | 'ellipse' | 'diamond' | 'triangle';

/** Outline of a shape in world coordinates; curves are approximated closely enough for hit tests and clipping. */
export function outlinePolygon(kind: OutlineKind, box: Box): Point[] {
  const { x, y, w, h } = box;
  let local: Point[];
  if (kind === 'ellipse') {
    local = Array.from({ length: 40 }, (_, i) => {
      const t = (i / 40) * Math.PI * 2;
      return { x: x + w / 2 + (w / 2) * Math.cos(t), y: y + h / 2 + (h / 2) * Math.sin(t) };
    });
  } else if (kind === 'diamond') {
    local = [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
  } else if (kind === 'triangle') {
    local = [{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  } else {
    local = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  if (!box.angle) return local;
  const c = centerOf(box);
  return local.map(point => rotatePoint(point, c, box.angle));
}

/** Ramer–Douglas–Peucker on a flat x,y array; keeps freehand strokes small without visible change. */
export function simplifyStroke(flat: readonly number[], tolerance: number): number[] {
  const count = flat.length / 2;
  if (count <= 2) return [...flat];
  const keep = new Uint8Array(count);
  keep[0] = 1; keep[count - 1] = 1;
  const stack: [number, number][] = [[0, count - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const a = { x: flat[from * 2]!, y: flat[from * 2 + 1]! }, b = { x: flat[to * 2]!, y: flat[to * 2 + 1]! };
    let worst = 0, index = -1;
    for (let i = from + 1; i < to; i += 1) {
      const d = distanceToSegment({ x: flat[i * 2]!, y: flat[i * 2 + 1]! }, a, b);
      if (d > worst) { worst = d; index = i; }
    }
    if (index >= 0 && worst > tolerance) { keep[index] = 1; stack.push([from, index], [index, to]); }
  }
  const result: number[] = [];
  for (let i = 0; i < count; i += 1) if (keep[i]) result.push(flat[i * 2]!, flat[i * 2 + 1]!);
  return result;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const sideVector: Record<Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** The axis direction that best matches a vector. */
export function dominantSide(dx: number, dy: number): Side {
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
}

function dedupe(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const last = result.at(-1);
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const before = result.at(-2);
    // Drop the middle of three collinear points.
    if (last && before && ((Math.abs(before.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01)
      || (Math.abs(before.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))) result.pop();
    result.push(p);
  }
  return result;
}

/**
 * Orthogonal route that leaves `from` along `fromSide` and arrives at `to` against `toSide`.
 * It is a fixed-shape heuristic (no obstacle avoidance), which keeps it stable while elements move.
 */
export function elbowRoute(from: Point, fromSide: Side, to: Point, toSide: Side, margin = 20): Point[] {
  const d0 = sideVector[fromSide], d1 = sideVector[toSide];
  const a = { x: from.x + d0.x * margin, y: from.y + d0.y * margin };
  const b = { x: to.x + d1.x * margin, y: to.y + d1.y * margin };
  const horizontal0 = d0.x !== 0, horizontal1 = d1.x !== 0;
  let middle: Point[];
  if (horizontal0 && horizontal1) {
    const facing = d0.x === -d1.x && (b.x - a.x) * d0.x >= 0;
    middle = facing ? [{ x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }]
      : d0.x === d1.x ? [{ x: d0.x > 0 ? Math.max(a.x, b.x) : Math.min(a.x, b.x), y: a.y }, { x: d0.x > 0 ? Math.max(a.x, b.x) : Math.min(a.x, b.x), y: b.y }]
        : [{ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }];
  } else if (!horizontal0 && !horizontal1) {
    const facing = d0.y === -d1.y && (b.y - a.y) * d0.y >= 0;
    middle = facing ? [{ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }]
      : d0.y === d1.y ? [{ x: a.x, y: d0.y > 0 ? Math.max(a.y, b.y) : Math.min(a.y, b.y) }, { x: b.x, y: d0.y > 0 ? Math.max(a.y, b.y) : Math.min(a.y, b.y) }]
        : [{ x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }];
  } else if (horizontal0) {
    const direct = (b.x - a.x) * d0.x >= 0 && (a.y - b.y) * d1.y >= 0;
    middle = direct ? [{ x: b.x, y: a.y }] : [{ x: a.x, y: b.y }];
  } else {
    const direct = (b.y - a.y) * d0.y >= 0 && (a.x - b.x) * d1.x >= 0;
    middle = direct ? [{ x: a.x, y: b.y }] : [{ x: b.x, y: a.y }];
  }
  return dedupe([from, a, ...middle, b, to]);
}

export function cubicPoint(p0: Point, c0: Point, c1: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
  };
}

export function sampleCubic(p0: Point, c0: Point, c1: Point, p1: Point, steps = 24): Point[] {
  return Array.from({ length: steps + 1 }, (_, i) => cubicPoint(p0, c0, c1, p1, i / steps));
}

/** Point at half the length of a polyline, for connector labels. */
export function polylineMidpoint(points: readonly Point[]): Point {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1]!, points[i]!);
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const segment = distance(points[i - 1]!, points[i]!);
    if (walked + segment >= total / 2 && segment > 0) {
      const t = (total / 2 - walked) / segment;
      return { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t };
    }
    walked += segment;
  }
  return points.at(-1)!;
}

export interface SnapGuide { axis: 'x' | 'y'; position: number; from: number; to: number }

/**
 * Snap a moving rectangle's edges and centre lines to those of the candidates.
 * Returns the offset to apply and the guides to draw for the matches that won.
 */
export function snapRect(moving: Rect, candidates: readonly Rect[], threshold: number,
  axes: { x?: ('start' | 'center' | 'end')[]; y?: ('start' | 'center' | 'end')[] } = {}): { dx: number; dy: number; guides: SnapGuide[] } {
  const pick = (rect: Rect, axis: 'x' | 'y') => axis === 'x'
    ? { start: rect.x, center: rect.x + rect.w / 2, end: rect.x + rect.w } : { start: rect.y, center: rect.y + rect.h / 2, end: rect.y + rect.h };
  const result = { dx: 0, dy: 0, guides: [] as SnapGuide[] };
  for (const axis of ['x', 'y'] as const) {
    const own = pick(moving, axis);
    const keys = axes[axis] ?? ['start', 'center', 'end'];
    let best = threshold + 1e-9, offset = 0;
    for (const candidate of candidates) {
      const other = pick(candidate, axis);
      for (const key of keys) for (const value of [other.start, other.center, other.end]) {
        const delta = value - own[key];
        if (Math.abs(delta) < Math.abs(best)) { best = Math.abs(delta); offset = delta; }
      }
    }
    if (best > threshold) continue;
    if (axis === 'x') result.dx = offset; else result.dy = offset;
    const moved = { ...moving, x: moving.x + (axis === 'x' ? offset : 0), y: moving.y + (axis === 'y' ? offset : 0) };
    const snapped = pick(moved, axis);
    for (const key of keys) {
      const span: number[] = [];
      for (const candidate of candidates) {
        const other = pick(candidate, axis);
        if ([other.start, other.center, other.end].some(value => Math.abs(value - snapped[key]) < 0.01)) {
          span.push(...(axis === 'x' ? [candidate.y, candidate.y + candidate.h] : [candidate.x, candidate.x + candidate.w]));
        }
      }
      if (!span.length) continue;
      span.push(...(axis === 'x' ? [moved.y, moved.y + moved.h] : [moved.x, moved.x + moved.w]));
      result.guides.push({ axis, position: snapped[key], from: Math.min(...span), to: Math.max(...span) });
    }
  }
  return result;
}
