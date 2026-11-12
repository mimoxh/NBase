import type { WhiteboardArrowhead, WhiteboardBoxElement, WhiteboardConnector, WhiteboardConnectorEnd, WhiteboardConnectorMode,
  WhiteboardElement, WhiteboardShape, WhiteboardShapeKind, WhiteboardStrokeStyle, WhiteboardTextAlign } from '@nbase/contracts';
import { whiteboardLimits } from '@nbase/contracts';
import { aabb, boundsOfPoints, centerOf, clamp, distance, distanceToPolyline, dominantSide, elbowRoute, exitPoint, expandRect, outlinePolygon,
  pointInPolygon, pointInRect, rectsIntersect, rotatePoint, round, sampleCubic, sideVector, toLocal, toWorld, unionRects,
  type Box, type Point, type Rect, type Side } from './geometry';
import { lineHeightOf, textBlockSize, type Measure } from './text';

/**
 * Pure board model. Elements are immutable values and every operation returns a new array that
 * shares the untouched elements, so history snapshots and change detection stay cheap.
 */
export type El = WhiteboardElement;
export type BoxEl = WhiteboardBoxElement;
export type Connector = WhiteboardConnector;
export type Elements = readonly El[];
export type Index = ReadonlyMap<string, El>;

export const isBox = (el: El): el is BoxEl => el.type !== 'connector';
export const indexElements = (elements: Elements): Map<string, El> => new Map(elements.map(el => [el.id, el]));

export const palette = {
  ink: '#1f2328', white: '#ffffff', gray: '#8c959f', red: '#e5484d', orange: '#f76b15', yellow: '#f5b800',
  green: '#30a46c', teal: '#12a594', blue: '#3e63dd', purple: '#8e4ec6', pink: '#d6409f',
} as const;
export const strokeColors = [palette.ink, palette.gray, palette.red, palette.orange, palette.yellow, palette.green, palette.teal, palette.blue, palette.purple, palette.pink, palette.white];
export const fillColors = ['transparent', '#ffffff', '#f1f3f5', '#ffe3e3', '#ffe8cc', '#fff3bf', '#d3f9d8', '#c3fae8', '#dbe4ff', '#e5dbff', '#ffdeeb', '#1f2328'];
export const noteColors = ['#fff3b0', '#ffd8a8', '#ffc9c9', '#d3f9d8', '#c5f6fa', '#d0ebff', '#e5dbff', '#f1f3f5'];
export const highlighterColors = ['#ffe066', '#8ce99a', '#74c0fc', '#faa2c1', '#ffa94d'];

export const textPadding = 10;
export const notePadding = 14;
export const minSize = 8;

export interface ShapeDefaults { shape: WhiteboardShapeKind; fill: string; stroke: string; strokeWidth: number; strokeStyle: WhiteboardStrokeStyle }

export function createShape(id: string, box: Rect, style: Partial<ShapeDefaults> = {}): WhiteboardShape {
  return { id, type: 'shape', shape: style.shape ?? 'rect', x: box.x, y: box.y, w: box.w, h: box.h, angle: 0,
    fill: style.fill ?? '#ffffff', stroke: style.stroke ?? palette.ink, strokeWidth: style.strokeWidth ?? 2, strokeStyle: style.strokeStyle ?? 'solid',
    text: '', textColor: palette.ink, fontSize: 16, textAlign: 'center' };
}

export function createConnector(id: string, source: WhiteboardConnectorEnd, target: WhiteboardConnectorEnd,
  style: Partial<Pick<Connector, 'mode' | 'stroke' | 'strokeWidth' | 'strokeStyle' | 'startArrow' | 'endArrow'>> = {}): Connector {
  return { id, type: 'connector', mode: style.mode ?? 'elbow', source, target, stroke: style.stroke ?? palette.ink,
    strokeWidth: style.strokeWidth ?? 2, strokeStyle: style.strokeStyle ?? 'solid', startArrow: style.startArrow ?? 'none',
    endArrow: style.endArrow ?? 'arrow', text: '' };
}

// ── Connector geometry ──────────────────────────────────────────────────────

export interface ConnectorPath {
  /** Polyline used for hit tests, bounds and straight/elbow drawing. */
  points: Point[];
  /** Present for curved connectors: start, two controls, end. */
  curve?: [Point, Point, Point, Point];
  /** Unit vectors pointing out of the path at each end, for arrowheads. */
  startDirection: Point;
  endDirection: Point;
}

const isEdgeAnchor = (ax: number, ay: number) => ax === 0 || ax === 1 || ay === 0 || ay === 1;
function anchorSide(ax: number, ay: number): Side {
  const options: [number, Side][] = [[ay, 'top'], [1 - ax, 'right'], [1 - ay, 'bottom'], [ax, 'left']];
  return options.reduce((best, item) => item[0] < best[0] ? item : best)[1];
}
const rotateSide = (side: Side, angle: number): Side => {
  if (!angle) return side;
  const v = rotatePoint(sideVector[side], { x: 0, y: 0 }, angle);
  return dominantSide(v.x, v.y);
};

export const anchorPoint = (target: Box, ax: number, ay: number): Point =>
  toWorld({ x: target.x + ax * target.w, y: target.y + ay * target.h }, target);

export function outlineOf(el: BoxEl): Point[] {
  return outlinePolygon(el.type === 'shape' ? el.shape : 'rect', el);
}

const boundTarget = (end: WhiteboardConnectorEnd, index: Index): BoxEl | null => {
  const target = end.bind ? index.get(end.bind.elementId) : undefined;
  return target && isBox(target) ? target : null;
};

/** Where an end nominally sits before clipping to its target's outline. */
function rawEnd(end: WhiteboardConnectorEnd, index: Index): Point {
  const target = boundTarget(end, index);
  return target ? anchorPoint(target, end.bind!.ax, end.bind!.ay) : { x: end.x, y: end.y };
}

function resolveEnd(end: WhiteboardConnectorEnd, other: Point, mode: WhiteboardConnectorMode, index: Index): { point: Point; side: Side } {
  const target = boundTarget(end, index);
  if (!target) return { point: { x: end.x, y: end.y }, side: dominantSide(other.x - end.x, other.y - end.y) };
  const { ax, ay } = end.bind!;
  const anchor = anchorPoint(target, ax, ay);
  const center = centerOf(target);
  const outline = outlineOf(target);
  const reach = target.w + target.h + 10;
  if (isEdgeAnchor(ax, ay)) {
    // Side anchors of non-rectangular shapes are pulled onto the real outline.
    const far = { x: center.x + (anchor.x - center.x) * 4, y: center.y + (anchor.y - center.y) * 4 };
    const point = distance(anchor, center) < 0.01 ? anchor : exitPoint(center, far, outline);
    return { point, side: rotateSide(anchorSide(ax, ay), target.angle) };
  }
  if (mode === 'straight') {
    return { point: pointInPolygon(other, outline) ? anchor : exitPoint(anchor, other, outline), side: dominantSide(other.x - anchor.x, other.y - anchor.y) };
  }
  // Interior anchors pick the side that faces the other end.
  const local = toLocal(other, target);
  const side = dominantSide((local.x - center.x) / Math.max(target.w, 1), (local.y - center.y) / Math.max(target.h, 1));
  const direction = rotatePoint(sideVector[side], { x: 0, y: 0 }, target.angle);
  const point = exitPoint(center, { x: center.x + direction.x * reach, y: center.y + direction.y * reach }, outline);
  return { point, side: rotateSide(side, target.angle) };
}

const unit = (from: Point, to: Point): Point => {
  const length = distance(from, to);
  return length < 1e-6 ? { x: 1, y: 0 } : { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
};

export function connectorPath(connector: Connector, index: Index): ConnectorPath {
  const rawSource = rawEnd(connector.source, index), rawTarget = rawEnd(connector.target, index);
  const start = resolveEnd(connector.source, rawTarget, connector.mode, index);
  const end = resolveEnd(connector.target, rawSource, connector.mode, index);
  if (connector.mode === 'elbow') {
    const points = elbowRoute(start.point, start.side, end.point, end.side);
    return { points, startDirection: unit(points[1] ?? end.point, points[0]!), endDirection: unit(points.at(-2) ?? start.point, points.at(-1)!) };
  }
  if (connector.mode === 'curve') {
    const reach = clamp(distance(start.point, end.point) * 0.4, 20, 240);
    const c0 = { x: start.point.x + sideVector[start.side].x * reach, y: start.point.y + sideVector[start.side].y * reach };
    const c1 = { x: end.point.x + sideVector[end.side].x * reach, y: end.point.y + sideVector[end.side].y * reach };
    return { points: sampleCubic(start.point, c0, c1, end.point), curve: [start.point, c0, c1, end.point],
      startDirection: unit(c0, start.point), endDirection: unit(c1, end.point) };
  }
  return { points: [start.point, end.point], startDirection: unit(end.point, start.point), endDirection: unit(start.point, end.point) };
}

// ── Bounds and hit testing ──────────────────────────────────────────────────

export function elementBounds(el: El, index: Index): Rect {
  if (isBox(el)) return aabb(el);
  return expandRect(boundsOfPoints(connectorPath(el, index).points), el.strokeWidth / 2 + 6);
}

export function boundsOfIds(ids: Iterable<string>, index: Index): Rect | null {
  const rects: Rect[] = [];
  for (const id of ids) { const el = index.get(id); if (el) rects.push(elementBounds(el, index)); }
  return unionRects(rects);
}

export const boardBounds = (elements: Elements, index: Index) => unionRects(elements.map(el => elementBounds(el, index)));

export function penPoints(el: Extract<El, { type: 'pen' }>): Point[] {
  const points: Point[] = [];
  const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  for (let i = 0; i < el.points.length; i += 2) points.push(rotatePoint({ x: el.x + el.points[i]!, y: el.y + el.points[i + 1]! }, c, el.angle));
  return points;
}

/** Whether a world point touches the element; `tolerance` is in world units (a few screen pixels). */
export function hitTest(el: El, point: Point, tolerance: number, index: Index): boolean {
  if (el.type === 'connector') return distanceToPolyline(point, connectorPath(el, index).points) <= el.strokeWidth / 2 + tolerance;
  if (el.type === 'pen') return pointInRect(point, aabb(el), tolerance + el.strokeWidth) && distanceToPolyline(point, penPoints(el)) <= el.strokeWidth / 2 + tolerance;
  const local = toLocal(point, el);
  if (!pointInRect(local, el, tolerance)) return false;
  if (el.type === 'frame') {
    // The interior belongs to the elements placed on the frame; grab it by its border.
    return !pointInRect(local, expandRect(el, -Math.max(tolerance, 6)));
  }
  if (el.type !== 'shape') return true;
  const outline = outlinePolygon(el.shape, { ...el, angle: 0 });
  const nearEdge = distanceToPolyline(local, outline, true) <= el.strokeWidth / 2 + tolerance;
  if (el.fill !== 'transparent' || el.text) return nearEdge || pointInPolygon(local, outline);
  return nearEdge;
}

/** Topmost element under the point, honouring z-order. */
export function elementAt(elements: Elements, point: Point, tolerance: number, index: Index, accept: (el: El) => boolean = () => true): El | null {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i]!;
    if (accept(el) && hitTest(el, point, tolerance, index)) return el;
  }
  return null;
}

export function elementsInRect(elements: Elements, rect: Rect, index: Index, mode: 'contain' | 'touch' = 'contain'): El[] {
  return elements.filter(el => {
    const b = elementBounds(el, index);
    return mode === 'touch' ? rectsIntersect(rect, b)
      : b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h;
  });
}

// ── Selection helpers ───────────────────────────────────────────────────────

/** Group mates always travel together. */
export function withGroups(elements: Elements, ids: ReadonlySet<string>): Set<string> {
  const groups = new Set<string>();
  for (const el of elements) if (ids.has(el.id) && el.groupId) groups.add(el.groupId);
  const result = new Set(ids);
  if (groups.size) for (const el of elements) if (el.groupId && groups.has(el.groupId)) result.add(el.id);
  return result;
}

export function mindDescendants(elements: Elements, rootIds: Iterable<string>): Set<string> {
  const result = new Set(rootIds);
  for (let grew = true; grew;) {
    grew = false;
    for (const el of elements) {
      if (el.type === 'shape' && el.mindParentId && result.has(el.mindParentId) && !result.has(el.id)) { result.add(el.id); grew = true; }
    }
  }
  return result;
}

export function mindRootOf(el: El, index: Index): WhiteboardShape | null {
  if (el.type !== 'shape' || el.mindParentId === undefined) return null;
  let cursor: WhiteboardShape = el;
  for (let steps = 0; cursor.mindParentId && steps < 10_000; steps += 1) {
    const parent = index.get(cursor.mindParentId);
    if (!parent || parent.type !== 'shape') break;
    cursor = parent;
  }
  return cursor;
}

/** What actually moves when the given selection is dragged: groups, whole mind maps and the contents of frames. */
export function movingSet(elements: Elements, ids: ReadonlySet<string>, index: Index): Set<string> {
  const result = withGroups(elements, ids);
  const roots = new Set<string>();
  for (const id of result) { const el = index.get(id); const root = el && mindRootOf(el, index); if (root) roots.add(root.id); }
  for (const id of mindDescendants(elements, roots)) result.add(id);
  for (const id of [...result]) {
    const frame = index.get(id);
    if (frame?.type !== 'frame') continue;
    for (const child of frameChildren(elements, frame, index)) result.add(child);
  }
  return result;
}

export function frameChildren(elements: Elements, frame: Extract<El, { type: 'frame' }>, index: Index): string[] {
  const area = aabb(frame);
  return elements.filter(el => el.id !== frame.id && el.type !== 'frame' && !el.locked
    && pointInRect(centerOf(elementBounds(el, index)), area)).map(el => el.id);
}

// ── Transformations ─────────────────────────────────────────────────────────

const replace = (elements: Elements, change: (el: El) => El): El[] => {
  let changed = false;
  const next = elements.map(el => { const value = change(el); if (value !== el) changed = true; return value; });
  return changed ? next : elements as El[];
};

const moveEnd = (end: WhiteboardConnectorEnd, dx: number, dy: number): WhiteboardConnectorEnd =>
  end.bind ? end : { ...end, x: end.x + dx, y: end.y + dy };

export function translate(elements: Elements, ids: ReadonlySet<string>, dx: number, dy: number): El[] {
  if (!dx && !dy) return elements as El[];
  return replace(elements, el => {
    if (!ids.has(el.id)) return el;
    if (isBox(el)) return { ...el, x: el.x + dx, y: el.y + dy };
    // A connector dragged together with both of its targets keeps its bindings; free ends follow the drag.
    return { ...el, source: moveEnd(el.source, dx, dy), target: moveEnd(el.target, dx, dy) };
  });
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const handleFactor: Record<Handle, [number, number]> = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };

export function handlePoint(box: Box, handle: Handle): Point {
  const [fx, fy] = handleFactor[handle];
  return toWorld({ x: box.x + box.w * (fx + 1) / 2, y: box.y + box.h * (fy + 1) / 2 }, box);
}

/**
 * Drag one of the eight handles of a possibly rotated box to a world point. The opposite corner or
 * edge stays fixed in world space; `keepRatio` preserves the aspect ratio and `fromCenter` resizes symmetrically.
 */
export function resizeBox(box: Box, handle: Handle, to: Point, keepRatio = false, fromCenter = false): Box {
  const [fx, fy] = handleFactor[handle];
  const local = toLocal(to, box);
  const anchorLocal = fromCenter ? centerOf(box) : { x: box.x + box.w * (1 - fx) / 2, y: box.y + box.h * (1 - fy) / 2 };
  const scale = fromCenter ? 2 : 1;
  let w = fx ? Math.max(minSize, (local.x - anchorLocal.x) * fx * scale) : box.w;
  let h = fy ? Math.max(minSize, (local.y - anchorLocal.y) * fy * scale) : box.h;
  if (keepRatio && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    if (fx && fy) { if (w / h > ratio) h = w / ratio; else w = h * ratio; }
    else if (fx) h = w / ratio; else w = h * ratio;
  }
  // The new centre is found in the old local frame, so the anchor keeps its world position.
  const center = toWorld({ x: fromCenter || !fx ? box.x + box.w / 2 : anchorLocal.x + fx * w / 2,
    y: fromCenter || !fy ? box.y + box.h / 2 : anchorLocal.y + fy * h / 2 }, box);
  return { x: center.x - w / 2, y: center.y - h / 2, w, h, angle: box.angle };
}

function scalePen<T extends Extract<El, { type: 'pen' }>>(el: T, sx: number, sy: number): number[] {
  return el.points.map((value, i) => round(value * (i % 2 ? sy : sx)));
}

/** Apply a new box to an element, scaling freehand points with it. */
export function withBox(el: BoxEl, box: Box): BoxEl {
  const next = { ...el, x: box.x, y: box.y, w: box.w, h: box.h, angle: box.angle };
  if (el.type === 'pen' && (box.w !== el.w || box.h !== el.h)) {
    return { ...next, points: scalePen(el, el.w ? box.w / el.w : 1, el.h ? box.h / el.h : 1) } as BoxEl;
  }
  return next;
}

/** Scale a multi-selection from one bounding rectangle to another. */
export function scaleElements(elements: Elements, ids: ReadonlySet<string>, from: Rect, to: Rect): El[] {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const map = (p: Point): Point => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy });
  return replace(elements, el => {
    if (!ids.has(el.id)) return el;
    if (!isBox(el)) {
      const end = (value: WhiteboardConnectorEnd) => value.bind ? value : { ...value, ...map(value) };
      return { ...el, source: end(el.source), target: end(el.target) };
    }
    const c = map(centerOf(el));
    // Rotated elements cannot shear, so they take the dominant factor on both axes.
    const quarter = Math.abs(Math.sin(el.angle)) > 0.01 && Math.abs(Math.cos(el.angle)) > 0.01;
    const fx = quarter ? Math.max(Math.abs(sx), Math.abs(sy)) : Math.abs(Math.cos(el.angle)) > 0.5 ? Math.abs(sx) : Math.abs(sy);
    const fy = quarter ? fx : Math.abs(Math.cos(el.angle)) > 0.5 ? Math.abs(sy) : Math.abs(sx);
    const w = Math.max(el.w * fx, el.type === 'pen' ? 0 : 1), h = Math.max(el.h * fy, el.type === 'pen' ? 0 : 1);
    return withBox(el, { x: c.x - w / 2, y: c.y - h / 2, w, h, angle: el.angle });
  });
}

export function rotateElements(elements: Elements, ids: ReadonlySet<string>, origin: Point, delta: number): El[] {
  if (!delta) return elements as El[];
  return replace(elements, el => {
    if (!ids.has(el.id)) return el;
    if (!isBox(el)) {
      const end = (value: WhiteboardConnectorEnd) => value.bind ? value : { ...value, ...rotatePoint(value, origin, delta) };
      return { ...el, source: end(el.source), target: end(el.target) };
    }
    const c = rotatePoint(centerOf(el), origin, delta);
    return { ...el, x: c.x - el.w / 2, y: c.y - el.h / 2, angle: normalizeAngle(el.angle + delta) };
  });
}

export function normalizeAngle(angle: number): number {
  const full = Math.PI * 2;
  const value = ((angle % full) + full) % full;
  return Math.abs(value) < 1e-9 || Math.abs(value - full) < 1e-9 ? 0 : value;
}

// ── Structure: delete, duplicate, order, groups, alignment ───────────────────

/** Freeze a bound end at its current position, for when its target goes away. */
function detached(connector: Connector, which: 'source' | 'target', index: Index): WhiteboardConnectorEnd {
  const path = connectorPath(connector, index).points;
  const point = which === 'source' ? path[0]! : path.at(-1)!;
  return { x: round(point.x), y: round(point.y) };
}

export function removeElements(elements: Elements, ids: ReadonlySet<string>, index: Index): El[] {
  const doomed = mindDescendants(elements, [...ids].filter(id => { const el = index.get(id); return el?.type === 'shape' && el.mindParentId !== undefined; }));
  for (const id of ids) doomed.add(id);
  return elements.filter(el => !doomed.has(el.id)).map(el => {
    if (el.type !== 'connector') return el;
    const source = el.source.bind && doomed.has(el.source.bind.elementId) ? detached(el, 'source', index) : el.source;
    const target = el.target.bind && doomed.has(el.target.bind.elementId) ? detached(el, 'target', index) : el.target;
    return source === el.source && target === el.target ? el : { ...el, source, target };
  });
}

/**
 * Copy elements with fresh identities. References inside the copied set are remapped; references
 * that point outside it are dropped so a copy never silently depends on its original's neighbours.
 */
export function cloneElements(source: Elements, index: Index, offset: Point, newId: () => string): El[] {
  const ids = new Map(source.map(el => [el.id, newId()]));
  const groups = new Map<string, string>();
  const group = (value: string | undefined) => {
    if (!value) return {};
    if (!groups.has(value)) groups.set(value, newId());
    return { groupId: groups.get(value)! };
  };
  return source.map(el => {
    const { groupId, ...rest } = el;
    const base = { ...rest, id: ids.get(el.id)!, ...group(groupId) };
    if (base.type === 'connector') {
      const original = el as Connector;
      const end = (value: WhiteboardConnectorEnd, which: 'source' | 'target'): WhiteboardConnectorEnd => {
        if (value.bind && ids.has(value.bind.elementId)) return { ...value, bind: { ...value.bind, elementId: ids.get(value.bind.elementId)! } };
        const free = value.bind ? detached(original, which, index) : value;
        return { x: free.x + offset.x, y: free.y + offset.y };
      };
      return { ...base, source: end(base.source, 'source'), target: end(base.target, 'target') };
    }
    const moved = { ...base, x: base.x + offset.x, y: base.y + offset.y };
    if (moved.type === 'shape' && moved.mindParentId !== undefined) {
      return { ...moved, mindParentId: moved.mindParentId && ids.has(moved.mindParentId) ? ids.get(moved.mindParentId)! : null };
    }
    return moved;
  });
}

export type OrderMove = 'front' | 'back' | 'forward' | 'backward';

export function reorder(elements: Elements, ids: ReadonlySet<string>, move: OrderMove): El[] {
  const picked = elements.filter(el => ids.has(el.id));
  if (!picked.length || picked.length === elements.length) return elements as El[];
  const rest = elements.filter(el => !ids.has(el.id));
  if (move === 'front') return [...rest, ...picked];
  if (move === 'back') return [...picked, ...rest];
  const positions = elements.map((el, i) => ids.has(el.id) ? i : -1).filter(i => i >= 0);
  // Step past the nearest element that is not part of the selection.
  const at = move === 'forward' ? Math.min(rest.length, positions.at(-1)! - picked.length + 2) : Math.max(0, positions[0]! - 1);
  return [...rest.slice(0, at), ...picked, ...rest.slice(at)];
}

export function setGroup(elements: Elements, ids: ReadonlySet<string>, groupId: string | null): El[] {
  return replace(elements, el => {
    if (!ids.has(el.id) || (el.groupId ?? null) === groupId) return el;
    const { groupId: _old, ...rest } = el;
    void _old;
    return (groupId ? { ...rest, groupId } : rest) as El;
  });
}

export function setLocked(elements: Elements, ids: ReadonlySet<string>, locked: boolean): El[] {
  return replace(elements, el => {
    if (!ids.has(el.id) || Boolean(el.locked) === locked) return el;
    const { locked: _old, ...rest } = el;
    void _old;
    return (locked ? { ...rest, locked: true } : rest) as El;
  });
}

export type Alignment = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Units that align as one: a group moves as a block, everything else on its own. */
function alignUnits(elements: Elements, ids: ReadonlySet<string>, index: Index): { ids: Set<string>; bounds: Rect }[] {
  const seen = new Set<string>();
  const units: { ids: Set<string>; bounds: Rect }[] = [];
  for (const el of elements) {
    if (!ids.has(el.id) || seen.has(el.id)) continue;
    const members = el.groupId ? new Set(elements.filter(other => other.groupId === el.groupId && ids.has(other.id)).map(other => other.id)) : new Set([el.id]);
    for (const id of members) seen.add(id);
    const bounds = boundsOfIds(members, index);
    if (bounds) units.push({ ids: members, bounds });
  }
  return units;
}

export function align(elements: Elements, ids: ReadonlySet<string>, how: Alignment, index: Index): El[] {
  const units = alignUnits(elements, ids, index);
  const all = unionRects(units.map(unit => unit.bounds));
  if (!all || units.length < 2) return elements as El[];
  let next = elements as El[];
  for (const unit of units) {
    const b = unit.bounds;
    const dx = how === 'left' ? all.x - b.x : how === 'right' ? all.x + all.w - b.x - b.w : how === 'hcenter' ? all.x + all.w / 2 - b.x - b.w / 2 : 0;
    const dy = how === 'top' ? all.y - b.y : how === 'bottom' ? all.y + all.h - b.y - b.h : how === 'vcenter' ? all.y + all.h / 2 - b.y - b.h / 2 : 0;
    next = translate(next, unit.ids, dx, dy);
  }
  return next;
}

export function distribute(elements: Elements, ids: ReadonlySet<string>, axis: 'x' | 'y', index: Index): El[] {
  const units = alignUnits(elements, ids, index);
  if (units.length < 3) return elements as El[];
  const start = (r: Rect) => axis === 'x' ? r.x : r.y, size = (r: Rect) => axis === 'x' ? r.w : r.h;
  units.sort((a, b) => start(a.bounds) + size(a.bounds) / 2 - start(b.bounds) - size(b.bounds) / 2);
  const first = units[0]!.bounds, last = units.at(-1)!.bounds;
  const gap = (start(last) + size(last) - start(first) - units.reduce((sum, unit) => sum + size(unit.bounds), 0)) / (units.length - 1);
  let cursor = start(first);
  let next = elements as El[];
  for (const unit of units) {
    const delta = cursor - start(unit.bounds);
    next = translate(next, unit.ids, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
    cursor += size(unit.bounds) + gap;
  }
  return next;
}

// ── Styling ─────────────────────────────────────────────────────────────────

export interface StylePatch {
  fill?: string; stroke?: string; strokeWidth?: number; strokeStyle?: WhiteboardStrokeStyle; textColor?: string;
  fontSize?: number; textAlign?: WhiteboardTextAlign; bold?: boolean; shape?: WhiteboardShapeKind; noteColor?: string;
  mode?: WhiteboardConnectorMode; startArrow?: WhiteboardArrowhead; endArrow?: WhiteboardArrowhead;
}

/** Apply the parts of a style patch that mean something for each element type. */
export function applyStyle(elements: Elements, ids: ReadonlySet<string>, patch: StylePatch): El[] {
  const pick = <T extends object>(source: T, keys: (keyof T)[]) => {
    const out: Partial<T> = {};
    for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
    return out;
  };
  return replace(elements, el => {
    if (!ids.has(el.id)) return el;
    let changes: object = {};
    if (el.type === 'shape') changes = pick(patch, ['fill', 'stroke', 'strokeWidth', 'strokeStyle', 'textColor', 'fontSize', 'textAlign', 'shape']);
    else if (el.type === 'text') changes = { ...pick(patch, ['fontSize', 'textAlign', 'bold']), ...(patch.textColor ? { color: patch.textColor } : {}) };
    else if (el.type === 'note') changes = { ...pick(patch, ['fontSize', 'textAlign']), ...(patch.noteColor ? { color: patch.noteColor } : {}) };
    else if (el.type === 'pen') changes = { ...(patch.stroke && patch.stroke !== 'transparent' ? { color: patch.stroke } : {}), ...(patch.strokeWidth ? { strokeWidth: Math.max(0.5, patch.strokeWidth) } : {}) };
    else if (el.type === 'connector') changes = { ...pick(patch, ['strokeStyle', 'mode', 'startArrow', 'endArrow']),
      ...(patch.stroke && patch.stroke !== 'transparent' ? { stroke: patch.stroke } : {}), ...(patch.strokeWidth ? { strokeWidth: Math.max(0.5, patch.strokeWidth) } : {}) };
    return Object.keys(changes).some(key => (el as unknown as Record<string, unknown>)[key] !== (changes as Record<string, unknown>)[key])
      ? { ...el, ...changes } as El : el;
  });
}

// ── Text fitting ────────────────────────────────────────────────────────────

/** Room for a label inside a shape, in its local frame: rhombi, ellipses and triangles have less usable width. */
export function shapeTextBox(el: WhiteboardShape): Rect {
  const inset = el.shape === 'ellipse' ? 0.72 : el.shape === 'diamond' || el.shape === 'triangle' ? 0.6 : 1;
  const w = Math.max(10, (el.w - textPadding * 2) * inset);
  const top = el.shape === 'triangle' ? el.h * 0.35 : 0;
  return { x: (el.w - w) / 2, y: top, w, h: el.h - top };
}

/** Height an element needs to show all of its text at its current width. */
export function fittedHeight(el: BoxEl, measure: Measure): number {
  if (el.type === 'text') return Math.max(lineHeightOf(el.fontSize), textBlockSize(el.text, el.w, el.fontSize, Boolean(el.bold), measure).height);
  if (el.type === 'note') return textBlockSize(el.text, el.w - notePadding * 2, el.fontSize, false, measure).height + notePadding * 2;
  if (el.type === 'shape' && el.text) {
    const area = shapeTextBox(el);
    const needed = textBlockSize(el.text, area.w, el.fontSize, false, measure).height + textPadding * 2;
    // Curved and pointed shapes need extra height so the label clears their slanted edges.
    const factor = el.shape === 'rect' || el.shape === 'roundRect' ? 1 : el.shape === 'triangle' ? 1 / 0.65 * 1.2 : 1.35;
    return needed * factor;
  }
  return el.h;
}

/** Grow (never shrink, except free text) an element so its text fits; `autoWidth` lets free text follow its longest line. */
export function fitText(el: BoxEl, measure: Measure, autoWidth = false): BoxEl {
  if (el.type === 'text') {
    const w = autoWidth ? Math.max(24, Math.ceil(textBlockSize(el.text, Infinity, el.fontSize, Boolean(el.bold), measure).width) + 2) : el.w;
    const next = { ...el, w };
    const h = fittedHeight(next, measure);
    return w === el.w && h === el.h ? el : { ...next, h };
  }
  if (el.type !== 'note' && el.type !== 'shape') return el;
  const h = Math.ceil(fittedHeight(el, measure));
  return h > el.h ? { ...el, h } : el;
}

// ── Persistence normalisation ───────────────────────────────────────────────

const num = (value: number, limit: number = whiteboardLimits.maxCoordinate) => round(clamp(Number.isFinite(value) ? value : 0, -limit, limit));

/**
 * The form that is saved: rounded numbers, bound ends carrying their last resolved position, and
 * no references to elements that no longer exist. Applied when a change is committed, never on load.
 */
export function normalizeForSave(elements: Elements): El[] {
  const index = indexElements(elements);
  return elements.map(el => {
    if (el.type === 'connector') {
      const path = connectorPath(el, index).points;
      const end = (value: WhiteboardConnectorEnd, point: Point): WhiteboardConnectorEnd => {
        const target = boundTarget(value, index);
        return target ? { x: num(point.x), y: num(point.y), bind: { elementId: target.id, ax: round(clamp(value.bind!.ax, 0, 1), 4), ay: round(clamp(value.bind!.ay, 0, 1), 4) } }
          : { x: num(value.x), y: num(value.y) };
      };
      return { ...el, source: end(el.source, path[0]!), target: end(el.target, path.at(-1)!) };
    }
    const box = { x: num(el.x), y: num(el.y), w: num(Math.max(0, el.w), whiteboardLimits.maxSize), h: num(Math.max(0, el.h), whiteboardLimits.maxSize), angle: round(normalizeAngle(el.angle), 5) };
    if (el.type === 'shape' && el.mindParentId && index.get(el.mindParentId)?.type !== 'shape') return { ...el, ...box, mindParentId: null };
    return { ...el, ...box };
  });
}

export const elementText = (el: El): string => el.type === 'frame' ? el.name : el.type === 'card' ? el.label
  : el.type === 'image' || el.type === 'pen' ? '' : el.text;
