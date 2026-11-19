import type { WhiteboardArrowhead, WhiteboardBoxElement, WhiteboardCard, WhiteboardConnector, WhiteboardDatabase, WhiteboardConnectorEnd, WhiteboardConnectorMode,
  WhiteboardElement, WhiteboardPoint, WhiteboardShape, WhiteboardShapeKind, WhiteboardStrokeStyle, WhiteboardText, WhiteboardTextAlign } from '@nbase/contracts';
import { whiteboardLimits } from '@nbase/contracts';
import { aabb, boundsOfPoints, centerOf, clamp, dedupe, distance, distanceToPolyline, dominantSide, elbowPath, ellipseDistance, ellipseExit, exitPoint, expandRect,
  outlinePolygon, pointInPolygon, pointInRect, rectsIntersect, rotatePoint, round, sampleCubic, sideVector, simplifyStroke, toLocal, toWorld, unionRects,
  type Box, type Point, type Rect, type Side } from './geometry';
import { arrowheadPoints, roundRadius } from './render/paths';
import { routeClear, routeElbow, routeRegion, routeThrough } from './route';
import { clearRunFields, normalizeRuns } from './runs';
import { layoutText, lineHeightOf, type Measure } from './text';

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
  /**
   * Elbow and straight connectors: the route as its handles address it, ends included. It is not
   * simplified, so bend points the user just added stay addressable even before they bend anything.
   */
  route?: Point[];
  /** Whether the route follows the user's bend points rather than the automatic router. */
  manual?: boolean;
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
  const ellipse = target.type === 'shape' && target.shape === 'ellipse';
  const outline = ellipse ? null : outlineOf(target);
  const exit = (from: Point, to: Point) => ellipse ? ellipseExit(from, to, target) : exitPoint(from, to, outline!);
  const contains = (point: Point) => ellipse ? ellipseDistance(toLocal(point, target), target) < 0 : pointInPolygon(point, outline!);
  const reach = target.w + target.h + 10;
  if (isEdgeAnchor(ax, ay)) {
    // Side anchors of non-rectangular shapes are pulled onto the real outline.
    const far = { x: center.x + (anchor.x - center.x) * 4, y: center.y + (anchor.y - center.y) * 4 };
    const point = distance(anchor, center) < 0.01 ? anchor : exit(center, far);
    return { point, side: rotateSide(anchorSide(ax, ay), target.angle) };
  }
  if (mode === 'straight') {
    return { point: contains(other) ? anchor : exit(anchor, other), side: dominantSide(other.x - anchor.x, other.y - anchor.y) };
  }
  // Interior anchors pick the side that faces the other end.
  const local = toLocal(other, target);
  const side = dominantSide((local.x - center.x) / Math.max(target.w, 1), (local.y - center.y) / Math.max(target.h, 1));
  const direction = rotatePoint(sideVector[side], { x: 0, y: 0 }, target.angle);
  const point = exit(center, { x: center.x + direction.x * reach, y: center.y + direction.y * reach });
  return { point, side: rotateSide(side, target.angle) };
}

const unit = (from: Point, to: Point): Point => {
  const length = distance(from, to);
  return length < 1e-6 ? { x: 1, y: 0 } : { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
};

/** Element kinds an automatic route goes around; frames are containers and freehand strokes are drawn over. */
const obstacleTypes = new Set<El['type']>(['shape', 'note', 'text', 'image', 'card', 'database']);
const gridCell = 512;
/** Packs a cell position into one number; boards stay well inside ±16M units, and a collision would only add candidates. */
const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

interface Obstacle { el: BoxEl; rect: Rect; order: number }
interface ObstacleGrid { cells: Map<number, Obstacle[]> }
const obstacleGrids = new WeakMap<Index, ObstacleGrid>();

/** Boxes that routes avoid, bucketed on a coarse grid; built once per board state. */
function obstacleGrid(index: Index): ObstacleGrid {
  const known = obstacleGrids.get(index);
  if (known) return known;
  const cells = new Map<number, Obstacle[]>();
  const hidden = (el: BoxEl) => {
    if (el.type !== 'shape' || !el.mindParentId) return false;
    let cursor: El | undefined = index.get(el.mindParentId);
    for (let steps = 0; cursor?.type === 'shape' && steps < 10_000; steps += 1) {
      if (cursor.mindCollapsed) return true;
      cursor = cursor.mindParentId ? index.get(cursor.mindParentId) : undefined;
    }
    return false;
  };
  let order = 0;
  for (const el of index.values()) {
    order += 1;
    if (!isBox(el) || !obstacleTypes.has(el.type) || hidden(el)) continue;
    const rect = aabb(el);
    const item = { el, rect, order };
    for (let cx = Math.floor(rect.x / gridCell); cx <= Math.floor((rect.x + rect.w) / gridCell); cx += 1) {
      for (let cy = Math.floor(rect.y / gridCell); cy <= Math.floor((rect.y + rect.h) / gridCell); cy += 1) {
        const key = cellKey(cx, cy);
        const list = cells.get(key);
        if (list) list.push(item); else cells.set(key, [item]);
      }
    }
  }
  const grid = { cells };
  obstacleGrids.set(index, grid);
  return grid;
}

/** Obstacles touching the region in board order, without the two bound ends. */
function obstaclesIn(region: Rect, index: Index, skipA: string | undefined, skipB: string | undefined): Obstacle[] {
  const { cells } = obstacleGrid(index);
  const found: Obstacle[] = [];
  const x0 = Math.floor(region.x / gridCell), x1 = Math.floor((region.x + region.w) / gridCell);
  const y0 = Math.floor(region.y / gridCell), y1 = Math.floor((region.y + region.h) / gridCell);
  const take = (item: Obstacle) => { if (item.el.id !== skipA && item.el.id !== skipB && rectsIntersect(region, item.rect)) found.push(item); };
  // A huge region spans more cells than there are elements; scanning them all is then cheaper.
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > cells.size) for (const list of cells.values()) for (const item of list) take(item);
  else for (let cx = x0; cx <= x1; cx += 1) for (let cy = y0; cy <= y1; cy += 1) for (const item of cells.get(cellKey(cx, cy)) ?? []) take(item);
  // Elements spanning several cells are found once per cell.
  found.sort((a, b) => a.order - b.order);
  let kept = 0;
  for (let i = 0; i < found.length; i += 1) if (!kept || found[kept - 1] !== found[i]) found[kept++] = found[i]!;
  found.length = kept;
  return found;
}

/**
 * A box that contains everything the connector can draw, worked out without routing it, so
 * drawing can skip connectors outside the view before paying for their routes.
 */
export function connectorRegion(connector: Connector, index: Index): Rect {
  const source = boundTarget(connector.source, index), target = boundTarget(connector.target, index);
  const region = routeRegion(rawEnd(connector.source, index), rawEnd(connector.target, index), [source && aabb(source), target && aabb(target)]);
  // Curves reach out up to 240 units past their ends.
  const grown = connector.mode === 'curve' ? expandRect(region, 240) : connector.bend ? expandRect(region, Math.abs(connector.bend)) : region;
  return connector.waypoints?.length ? unionRects([grown, expandRect(boundsOfPoints(connector.waypoints), 40)])! : grown;
}

interface RouteEntry { connector: Connector; source: BoxEl | null; target: BoxEl | null; obstacles: readonly Rect[] | null; path: ConnectorPath }
/**
 * Last route per connector id. A route depends only on the connector's ends and bend points, the
 * geometry of the elements it is bound to and the boxes around it, so it is compared by those
 * values: saving, undoing and copying rebuild elements as new objects without moving them.
 */
const routeCache = new Map<string, RouteEntry>();
const routeCacheLimit = 50_000;
/** Routes already worked out for one board state. */
const routeMemo = new WeakMap<Index, Map<string, { connector: Connector; path: ConnectorPath }>>();

const sameBoxGeometry = (a: BoxEl | null, b: BoxEl | null) => a === b || (!!a && !!b && a.type === b.type && a.x === b.x && a.y === b.y
  && a.w === b.w && a.h === b.h && a.angle === b.angle && (a.type !== 'shape' || a.shape === (b as WhiteboardShape).shape));
const sameRects = (a: readonly Rect[] | null, b: readonly Rect[] | null) => a === b || (!!a && !!b && a.length === b.length
  && a.every((r, i) => { const s = b[i]!; return r.x === s.x && r.y === s.y && r.w === s.w && r.h === s.h; }));
const samePointList = (a: readonly WhiteboardPoint[] | undefined, b: readonly WhiteboardPoint[] | undefined) => a === b
  || ((a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((p, i) => p.x === b![i]!.x && p.y === b![i]!.y));
/** Whether two ends resolve alike; a bound end ignores its stored position while its element exists. */
const sameEnd = (a: WhiteboardConnectorEnd, b: WhiteboardConnectorEnd, bound: boolean) => bound
  ? a.bind!.elementId === b.bind?.elementId && a.bind!.ax === b.bind.ax && a.bind!.ay === b.bind.ay
  : !a.bind === !b.bind && a.x === b.x && a.y === b.y && (!a.bind || a.bind.elementId === b.bind?.elementId);
/** Whether everything but the surrounding boxes is as when the entry was routed. */
function sameRouteEnds(entry: RouteEntry, connector: Connector, source: BoxEl | null, target: BoxEl | null): boolean {
  const old = entry.connector;
  if (old !== connector && (old.mode !== connector.mode || old.bend !== connector.bend || !samePointList(old.waypoints, connector.waypoints)
    || !sameEnd(old.source, connector.source, !!source && !!entry.source) || !sameEnd(old.target, connector.target, !!target && !!entry.target))) return false;
  return sameBoxGeometry(entry.source, source) && sameBoxGeometry(entry.target, target);
}

/** Board states that are steps of a running gesture rather than settled states. */
const provisionalStates = new WeakSet<Index>();
/**
 * Mark a board state as an in-between step of a gesture. Connectors in it whose own ends did not
 * move keep their last route while the moving elements stay clear of it, instead of searching
 * again on every pointer move; the settled state after the gesture is routed exactly as usual.
 */
export function markProvisional(index: Index) { provisionalStates.add(index); }

export function connectorPath(connector: Connector, index: Index): ConnectorPath {
  let memo = routeMemo.get(index);
  if (!memo) { memo = new Map(); routeMemo.set(index, memo); }
  const known = memo.get(connector.id);
  if (known?.connector === connector) return known.path;
  const source = boundTarget(connector.source, index), target = boundTarget(connector.target, index);
  const automatic = connector.mode === 'elbow' && !connector.waypoints?.length && !connector.bend;
  const obstacles = automatic ? obstaclesIn(connectorRegion(connector, index), index, source?.id, target?.id).map(item => item.rect) : null;
  const cached = routeCache.get(connector.id);
  let path: ConnectorPath;
  const sameEnds = cached ? sameRouteEnds(cached, connector, source, target) : false;
  if (cached && sameEnds && sameRects(cached.obstacles, obstacles)) {
    path = cached.path;
    cached.connector = connector; cached.source = source; cached.target = target;
  } else if (cached && sameEnds && obstacles && provisionalStates.has(index) && routeClear(cached.path.points, obstacles)) {
    // The entry keeps the boxes it was routed around, so the settled state compares against those and routes afresh.
    path = cached.path;
  } else {
    path = computePath(connector, index, source, target, obstacles);
    if (routeCache.size >= routeCacheLimit) routeCache.clear();
    routeCache.set(connector.id, { connector, source, target, obstacles, path });
  }
  memo.set(connector.id, { connector, path });
  return path;
}

const pointsOf = (list: readonly WhiteboardPoint[] | undefined): Point[] => list?.map(point => ({ x: point.x, y: point.y })) ?? [];

function computePath(connector: Connector, index: Index, source: BoxEl | null, target: BoxEl | null, obstacles: readonly Rect[] | null): ConnectorPath {
  const rawSource = rawEnd(connector.source, index), rawTarget = rawEnd(connector.target, index);
  const waypoints = connector.mode === 'curve' ? [] : pointsOf(connector.waypoints);
  // With bend points, each end faces its nearest bend point instead of the far end.
  const start = resolveEnd(connector.source, waypoints[0] ?? rawTarget, connector.mode, index);
  const end = resolveEnd(connector.target, waypoints.at(-1) ?? rawSource, connector.mode, index);
  const ends = (points: Point[]) => ({ startDirection: unit(points[1] ?? end.point, points[0]!), endDirection: unit(points.at(-2) ?? start.point, points.at(-1)!) });
  if (connector.mode === 'elbow') {
    const from = { point: start.point, side: start.side, own: source && aabb(source) }, to = { point: end.point, side: end.side, own: target && aabb(target) };
    if (waypoints.length) {
      const route = routeThrough(from, waypoints, to);
      const points = dedupe(route);
      return { points, route, manual: true, ...ends(points) };
    }
    if (connector.bend) {
      // Boards from before bend points keep their shifted middle segment until the route is edited.
      const points = elbowPath(start.point, start.side, end.point, end.side, connector.bend).points;
      return { points, route: points, manual: true, ...ends(points) };
    }
    const points = routeElbow(from, to, obstacles ?? []).points;
    return { points, route: points, ...ends(points) };
  }
  if (connector.mode === 'curve') {
    const reach = clamp(distance(start.point, end.point) * 0.4, 20, 240);
    const c0 = { x: start.point.x + sideVector[start.side].x * reach, y: start.point.y + sideVector[start.side].y * reach };
    const c1 = { x: end.point.x + sideVector[end.side].x * reach, y: end.point.y + sideVector[end.side].y * reach };
    return { points: sampleCubic(start.point, c0, c1, end.point), curve: [start.point, c0, c1, end.point],
      startDirection: unit(c0, start.point), endDirection: unit(c1, end.point) };
  }
  const points = [start.point, ...waypoints, end.point];
  return { points, route: points, manual: waypoints.length > 0, ...ends(points) };
}

/** Where a connector's label sits: halfway along its drawn length. */
export function connectorLabelPoint(path: ConnectorPath): Point {
  if (path.curve) return path.points[Math.floor(path.points.length / 2)]!;
  let total = 0;
  for (let i = 1; i < path.points.length; i += 1) total += distance(path.points[i]!, path.points[i - 1]!);
  let walked = 0;
  for (let i = 1; i < path.points.length; i += 1) {
    const a = path.points[i - 1]!, b = path.points[i]!;
    const segment = distance(a, b);
    if (walked + segment >= total / 2 && segment > 0) { const t = (total / 2 - walked) / segment; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
    walked += segment;
  }
  return path.points[0]!;
}

const samePoints = (a: readonly Point[], b: readonly Point[]) => a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i]!.x) < 0.01 && Math.abs(p.y - b[i]!.y) < 0.01);

/**
 * A connector following the given bend points, rounded for storage. Elbow routes drop leading and
 * trailing points that only repeat what the ends would do anyway, so a later move of a bound
 * element re-plans the stretch next to it instead of dragging a stale stub along; when nothing is
 * left the route is automatic again.
 */
export function withWaypoints(connector: Connector, points: readonly Point[], index: Index): Connector {
  const { waypoints: _old, bend: _bend, ...rest } = connector;
  void _old; void _bend;
  const make = (list: readonly Point[]): Connector => list.length ? { ...rest, waypoints: list.map(p => ({ x: round(p.x), y: round(p.y) })) } : rest;
  let list = points.slice(0, whiteboardLimits.maxWaypoints);
  if (connector.mode === 'elbow' && list.length) {
    const wanted = dedupe(connectorPath(make(list), index).points);
    const same = (candidate: readonly Point[]) => samePoints(dedupe(connectorPath(make(candidate), index).points), wanted);
    while (list.length && same(list.slice(1))) list = list.slice(1);
    while (list.length && same(list.slice(0, -1))) list = list.slice(0, -1);
  }
  const next = make(list);
  const key = (el: Connector) => JSON.stringify([el.waypoints ?? null, el.bend ?? null]);
  return key(next) === key(connector) ? connector : next;
}

/** The two resolved ends only; cheaper than a full route when nothing in between matters. */
export function connectorEnds(connector: Connector, index: Index): [Point, Point] {
  const known = routeMemo.get(index)?.get(connector.id);
  if (known?.connector === connector) return [known.path.points[0]!, known.path.points.at(-1)!];
  const waypoints = connector.mode === 'curve' ? [] : pointsOf(connector.waypoints);
  const rawSource = rawEnd(connector.source, index), rawTarget = rawEnd(connector.target, index);
  return [resolveEnd(connector.source, waypoints[0] ?? rawTarget, connector.mode, index).point,
    resolveEnd(connector.target, waypoints.at(-1) ?? rawSource, connector.mode, index).point];
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
  if (el.shape === 'ellipse') {
    const d = ellipseDistance(local, el);
    return Math.abs(d) <= el.strokeWidth / 2 + tolerance || (d < 0 && (el.fill !== 'transparent' || Boolean(el.text)));
  }
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

/** The groups an element sits in, from the innermost to the outermost. */
export const groupChain = (el: El): string[] => el.groupId ? [el.groupId, ...(el.groupParents ?? [])] : [];

/**
 * The group that stands for an element when it is picked: its outermost group, or, once a group
 * has been entered (`focus`), the level right below that group. Null when the element stands alone.
 */
function unitGroup(el: El, focus: string | null): string | null {
  if (!el.groupId) return null;
  const chain = groupChain(el);
  const at = focus ? chain.indexOf(focus) : -1;
  if (at < 0) return chain.at(-1)!;
  return at === 0 ? null : chain[at - 1]!;
}

/** Group mates always travel together; inside an entered group only the mates one level down do. */
export function withGroups(elements: Elements, ids: ReadonlySet<string>, focus: string | null = null): Set<string> {
  const groups = new Set<string>();
  for (const el of elements) {
    if (!ids.has(el.id)) continue;
    const group = unitGroup(el, focus);
    if (group) groups.add(group);
  }
  const result = new Set(ids);
  if (groups.size) for (const el of elements) if (el.groupId && groupChain(el).some(group => groups.has(group))) result.add(el.id);
  return result;
}

/** The group to enter when an element is double-clicked: one level down from the current focus, or null at the innermost level. */
export function groupToEnter(el: El, focus: string | null): string | null {
  return unitGroup(el, focus);
}

export interface MindVisibility {
  /** Descendants of collapsed mind nodes, and the connectors attached to them. */
  hidden: ReadonlySet<string>;
  /** How many nodes each collapsed node hides. */
  counts: ReadonlyMap<string, number>;
}
const nothingHidden: MindVisibility = { hidden: new Set(), counts: new Map() };
const visibilityCache = new WeakMap<Elements, MindVisibility>();

/** What collapsed mind nodes hide. Element arrays are immutable, so the answer is remembered per array. */
export function mindVisibility(elements: Elements): MindVisibility {
  const known = visibilityCache.get(elements);
  if (known) return known;
  let result = nothingHidden;
  const collapsed = elements.filter(el => el.type === 'shape' && el.mindCollapsed && el.mindParentId !== undefined);
  if (collapsed.length) {
    const hidden = new Set<string>(), counts = new Map<string, number>();
    for (const node of collapsed) {
      const below = mindDescendants(elements, [node.id]);
      below.delete(node.id);
      counts.set(node.id, below.size);
      for (const id of below) hidden.add(id);
    }
    if (hidden.size) {
      for (const el of elements) {
        if (el.type === 'connector' && [el.source, el.target].some(end => end.bind && hidden.has(end.bind.elementId))) hidden.add(el.id);
      }
    }
    result = { hidden, counts };
  }
  visibilityCache.set(elements, result);
  return result;
}

export function visibleElements(elements: Elements): Elements {
  const { hidden } = mindVisibility(elements);
  return hidden.size ? elements.filter(el => !hidden.has(el.id)) : elements;
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

function withFrameContents(elements: Elements, result: Set<string>, index: Index): Set<string> {
  for (const id of [...result]) {
    const frame = index.get(id);
    if (frame?.type !== 'frame') continue;
    for (const child of frameChildren(elements, frame, index)) result.add(child);
  }
  return result;
}

/** What actually moves when the given selection is dragged: groups, whole mind maps and the contents of frames. */
export function movingSet(elements: Elements, ids: ReadonlySet<string>, index: Index, focus: string | null = null): Set<string> {
  const result = withGroups(elements, ids, focus);
  const roots = new Set<string>();
  for (const id of result) { const el = index.get(id); const root = el && mindRootOf(el, index); if (root) roots.add(root.id); }
  for (const id of mindDescendants(elements, roots)) result.add(id);
  return withFrameContents(elements, result, index);
}

/** What a copy, a duplicate or an export of the selection carries: group mates, the branches under selected mind nodes and frame contents. */
export function dependentSet(elements: Elements, ids: ReadonlySet<string>, index: Index, focus: string | null = null): Set<string> {
  const result = withGroups(elements, ids, focus);
  const nodes = [...result].filter(id => { const el = index.get(id); return el?.type === 'shape' && el.mindParentId !== undefined; });
  for (const id of mindDescendants(elements, nodes)) result.add(id);
  return withFrameContents(elements, result, index);
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

/** Bend points mapped through a transform; absent stays absent. */
function mapWaypoints(el: Connector, map: (point: Point) => Point): Connector {
  return el.waypoints?.length ? { ...el, waypoints: el.waypoints.map(point => { const p = map(point); return { x: p.x, y: p.y }; }) } : el;
}

export function translate(elements: Elements, ids: ReadonlySet<string>, dx: number, dy: number): El[] {
  if (!dx && !dy) return elements as El[];
  const shift = (point: Point) => ({ x: point.x + dx, y: point.y + dy });
  return replace(elements, el => {
    if (!ids.has(el.id)) {
      // Bend points travel with a connector whose two bound ends both move, so the drawn shape moves as one piece.
      if (el.type === 'connector' && el.waypoints?.length && el.source.bind && el.target.bind
        && ids.has(el.source.bind.elementId) && ids.has(el.target.bind.elementId)) return mapWaypoints(el, shift);
      return el;
    }
    if (isBox(el)) return { ...el, x: el.x + dx, y: el.y + dy };
    // A connector dragged together with both of its targets keeps its bindings; free ends follow the drag.
    return mapWaypoints({ ...el, source: moveEnd(el.source, dx, dy), target: moveEnd(el.target, dx, dy) }, shift);
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
      return mapWaypoints({ ...el, source: end(el.source), target: end(el.target) }, map);
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
      // Orthogonal routes stay orthogonal only through quarter turns; otherwise the bend points go back to automatic.
      const quarter = Math.abs(Math.sin(delta * 2)) < 1e-6;
      const turned = { ...el, source: end(el.source), target: end(el.target) };
      if (el.mode === 'elbow' && !quarter) { const { waypoints: _drop, ...rest } = turned; void _drop; return rest; }
      return mapWaypoints(turned, point => rotatePoint(point, origin, delta));
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
  const ends = connectorEnds(connector, index);
  const point = which === 'source' ? ends[0] : ends[1];
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
export function cloneElements(source: Elements, index: Index, offset: Point, newId: () => string, keepGroups: ReadonlySet<string> = new Set()): El[] {
  const ids = new Map(source.map(el => [el.id, newId()]));
  const groups = new Map<string, string>();
  const group = (value: string) => {
    // Groups the copy is made inside of are kept, so the copy joins them.
    if (keepGroups.has(value)) return value;
    if (!groups.has(value)) groups.set(value, newId());
    return groups.get(value)!;
  };
  return source.map(el => {
    const { groupId, groupParents, ...rest } = el;
    const base = { ...rest, id: ids.get(el.id)!, ...(groupId ? { groupId: group(groupId) } : {}),
      ...(groupId && groupParents?.length ? { groupParents: groupParents.map(group) } : {}) };
    if (base.type === 'connector') {
      const original = el as Connector;
      const end = (value: WhiteboardConnectorEnd, which: 'source' | 'target'): WhiteboardConnectorEnd => {
        if (value.bind && ids.has(value.bind.elementId)) return { ...value, bind: { ...value.bind, elementId: ids.get(value.bind.elementId)! } };
        const free = value.bind ? detached(original, which, index) : value;
        return { x: free.x + offset.x, y: free.y + offset.y };
      };
      return mapWaypoints({ ...base, source: end(base.source, 'source'), target: end(base.target, 'target') } as Connector,
        point => ({ x: point.x + offset.x, y: point.y + offset.y }));
    }
    const moved = { ...base, x: base.x + offset.x, y: base.y + offset.y };
    if (moved.type === 'shape' && moved.mindParentId !== undefined) {
      if (moved.mindParentId && ids.has(moved.mindParentId)) return { ...moved, mindParentId: ids.get(moved.mindParentId)! };
      // The copied top of a branch becomes a root, and a root has no side; it keeps the direction of the map it came from.
      const { mindSide: _side, ...root } = moved;
      void _side;
      return { ...root, mindParentId: null };
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

/**
 * Wrap the elements in a new group, or with null take one group level away. The level is the
 * outermost one; inside an entered group (`focus`) it is the level right below that group.
 */
export function setGroup(elements: Elements, ids: ReadonlySet<string>, groupId: string | null, focus: string | null = null): El[] {
  return replace(elements, el => {
    if (!ids.has(el.id)) return el;
    const chain = groupChain(el);
    const at = focus ? chain.indexOf(focus) : -1;
    const end = at < 0 ? chain.length : at;
    if (groupId ? chain.includes(groupId) : !end) return el;
    const next = groupId ? [...chain.slice(0, end), groupId, ...chain.slice(end)] : [...chain.slice(0, end - 1), ...chain.slice(end)];
    const { groupId: _old, groupParents: _parents, ...rest } = el;
    void _old; void _parents;
    return { ...rest, ...(next.length ? { groupId: next[0]! } : {}), ...(next.length > 1 ? { groupParents: next.slice(1) } : {}) } as El;
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

/** Units that align as one: a group that is selected as a whole moves as a block, everything else on its own. */
function alignUnits(elements: Elements, ids: ReadonlySet<string>, index: Index): { ids: Set<string>; bounds: Rect }[] {
  const groupMembers = new Map<string, string[]>();
  for (const el of elements) {
    for (const group of groupChain(el)) {
      const list = groupMembers.get(group);
      if (list) list.push(el.id); else groupMembers.set(group, [el.id]);
    }
  }
  const seen = new Set<string>();
  const units: { ids: Set<string>; bounds: Rect }[] = [];
  for (const el of elements) {
    if (!ids.has(el.id) || seen.has(el.id)) continue;
    const whole = groupChain(el).reverse().find(group => groupMembers.get(group)!.every(id => ids.has(id)));
    const members = new Set(whole ? groupMembers.get(whole)! : [el.id]);
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
    if (el.type === 'shape') changes = pick(patch, ['fill', 'stroke', 'strokeWidth', 'strokeStyle', 'textColor', 'fontSize', 'textAlign', 'bold', 'shape']);
    else if (el.type === 'text') changes = { ...pick(patch, ['fontSize', 'textAlign', 'bold']), ...(patch.textColor ? { color: patch.textColor } : {}) };
    else if (el.type === 'note') changes = { ...pick(patch, ['fontSize', 'textAlign', 'bold']), ...(patch.noteColor ? { color: patch.noteColor } : {}) };
    else if (el.type === 'pen') changes = { ...(patch.stroke && patch.stroke !== 'transparent' ? { color: patch.stroke } : {}), ...(patch.strokeWidth ? { strokeWidth: Math.max(0.5, patch.strokeWidth) } : {}) };
    else if (el.type === 'connector') changes = { ...pick(patch, ['strokeStyle', 'mode', 'startArrow', 'endArrow']),
      ...(patch.stroke && patch.stroke !== 'transparent' ? { stroke: patch.stroke } : {}), ...(patch.strokeWidth ? { strokeWidth: Math.max(0.5, patch.strokeWidth) } : {}) };
    // An element-wide bold, size or colour covers the whole text, so the runs give up that field.
    const runFields = (el.type === 'shape' || el.type === 'text' || el.type === 'note') && el.runs?.length
      ? ([...(patch.bold !== undefined ? ['bold'] : []), ...(patch.fontSize !== undefined ? ['fontSize'] : []),
        ...(patch.textColor !== undefined && el.type !== 'note' ? ['color'] : [])] as ('bold' | 'fontSize' | 'color')[]) : [];
    // An absent flag and `false` are the same style.
    const same = (a: unknown, b: unknown) => a === b || (typeof b === 'boolean' && Boolean(a) === b);
    const runsChange = runFields.some(key => (el as { runs?: { [k: string]: unknown }[] }).runs!.some(run => run[key] !== undefined));
    if (!runsChange && !Object.keys(changes).some(key => !same((el as unknown as Record<string, unknown>)[key], (changes as Record<string, unknown>)[key]))) return el;
    const next = { ...el, ...changes } as El & { bold?: boolean; runs?: WhiteboardText['runs']; fontSize?: number };
    if (next.bold === false) delete next.bold;
    if (runsChange && 'runs' in next) {
      const runs = clearRunFields(next.runs, runFields, { bold: next.bold, fontSize: next.fontSize! });
      if (runs) next.runs = runs; else delete next.runs;
    }
    return next;
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
  if (el.type === 'text') return Math.max(lineHeightOf(el.fontSize), layoutText(el, el.w, measure).height);
  if (el.type === 'note') return layoutText(el, el.w - notePadding * 2, measure).height + notePadding * 2;
  if (el.type === 'shape' && el.text) {
    const area = shapeTextBox(el);
    const needed = layoutText(el, area.w, measure).height + textPadding * 2;
    // Curved and pointed shapes need extra height so the label clears their slanted edges.
    const factor = el.shape === 'rect' || el.shape === 'roundRect' ? 1 : el.shape === 'triangle' ? 1 / 0.65 * 1.2 : 1.35;
    return needed * factor;
  }
  return el.h;
}

/** Grow (never shrink, except free text) an element so its text fits; `autoWidth` lets free text follow its longest line. */
export function fitText(el: BoxEl, measure: Measure, autoWidth = false): BoxEl {
  if (el.type === 'text') {
    const w = autoWidth ? Math.max(24, Math.ceil(layoutText(el, Infinity, measure).width) + 2) : el.w;
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
  const normalized = elements.map(el => {
    if (el.type === 'connector') {
      const [first, last] = connectorEnds(el, index);
      const end = (value: WhiteboardConnectorEnd, point: Point): WhiteboardConnectorEnd => {
        const target = boundTarget(value, index);
        return target ? { x: num(point.x), y: num(point.y), bind: { elementId: target.id, ax: round(clamp(value.bind!.ax, 0, 1), 4), ay: round(clamp(value.bind!.ay, 0, 1), 4) } }
          : { x: num(value.x), y: num(value.y) };
      };
      const { bend, waypoints, ...rest } = el;
      const points = waypoints?.slice(0, whiteboardLimits.maxWaypoints).map(point => ({ x: num(point.x), y: num(point.y) })) ?? [];
      // A shift only means something on an elbow route without bend points; zero is the default and is not stored.
      const shift = el.mode === 'elbow' && bend && !points.length ? num(bend) : 0;
      return { ...rest, source: end(el.source, first), target: end(el.target, last), ...(shift ? { bend: shift } : {}), ...(points.length ? { waypoints: points } : {}) };
    }
    const box = { x: num(el.x), y: num(el.y), w: num(Math.max(0, el.w), whiteboardLimits.maxSize), h: num(Math.max(0, el.h), whiteboardLimits.maxSize), angle: round(normalizeAngle(el.angle), 5) };
    let next: El = { ...el, ...box };
    if (next.type === 'shape' || next.type === 'text' || next.type === 'note') {
      const { runs: _runs, ...rest } = next;
      void _runs;
      const runs = next.text ? normalizeRuns(next.runs, next) : undefined;
      next = runs ? { ...rest, runs } as El : rest as El;
    }
    if (next.type === 'shape' && next.mindParentId && index.get(next.mindParentId)?.type !== 'shape') {
      const { mindSide: _side, ...root } = next;
      void _side;
      return { ...root, mindParentId: null };
    }
    if (next.type === 'shape' && next.mindLayout && next.mindParentId !== null) {
      const { mindLayout: _layout, ...rest } = next;
      void _layout;
      return rest;
    }
    return next;
  });
  // Concurrent reparenting can make a cycle even though each individual move was valid. Detach one
  // deterministic node from each cycle so every replica normalizes to the same forest.
  const byId = indexElements(normalized);
  const detach = new Set<string>();
  for (const element of normalized) {
    if (element.type !== 'shape' || !element.mindParentId) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor: WhiteboardShape = element;
    while (cursor.mindParentId) {
      const repeated = positions.get(cursor.id);
      if (repeated !== undefined) {
        const cycle = path.slice(repeated);
        detach.add(cycle.sort()[0]!);
        break;
      }
      if (detach.has(cursor.id)) break;
      positions.set(cursor.id, path.length);
      path.push(cursor.id);
      const parent: El | undefined = byId.get(cursor.mindParentId);
      if (parent?.type !== 'shape') break;
      cursor = parent;
    }
  }
  return normalized.map(element => {
    if (element.type !== 'shape' || !detach.has(element.id)) return element;
    const { mindSide: _side, ...rest } = element;
    void _side;
    return { ...rest, mindParentId: null };
  });
}

// ── Erasing part of a stroke ─────────────────────────────────────────────────

type Pen = Extract<El, { type: 'pen' }>;

/**
 * Remove the parts of a freehand stroke that lie within `radius` of the eraser's path. Returns
 * null when the stroke is untouched, otherwise the pieces that remain (none when it is gone). The
 * first piece keeps the stroke's id, so a connector bound to it stays bound.
 */
export function erasePen(el: Pen, eraser: readonly Point[], radius: number, newId: () => string): Pen[] | null {
  const reach = radius + el.strokeWidth / 2;
  const points = penPoints(el);
  if (!points.length || !eraser.length) return null;
  // Strokes are stored simplified, so a long straight run may be two points; sample it finely enough to lose its middle.
  const step = Math.max(reach / 2, 0.5);
  const dense: Point[] = [points[0]!];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!, b = points[i]!;
    const parts = Math.min(4000, Math.max(1, Math.ceil(distance(a, b) / step)));
    for (let k = 1; k <= parts; k += 1) dense.push({ x: a.x + (b.x - a.x) * k / parts, y: a.y + (b.y - a.y) * k / parts });
  }
  const gone = dense.map(point => distanceToPolyline(point, eraser) <= reach);
  if (!gone.includes(true)) return null;
  const pieces: Pen[] = [];
  let run: Point[] = [];
  const flush = () => {
    const kept = run;
    run = [];
    if (kept.length < 2) return;
    let length = 0;
    for (let i = 1; i < kept.length; i += 1) length += distance(kept[i - 1]!, kept[i]!);
    // Crumbs shorter than the stroke is wide read as dirt, not as ink.
    if (length < Math.max(1, el.strokeWidth / 2)) return;
    const flat = simplifyStroke(kept.flatMap(p => [p.x, p.y]), 0.2);
    const sharp = sharpenCorners(pairsOf(flat));
    const bounds = boundsOfPoints(sharp);
    pieces.push({ ...el, id: pieces.length ? newId() : el.id, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, angle: 0,
      points: sharp.flatMap(p => [round(p.x - bounds.x), round(p.y - bounds.y)]) });
  };
  dense.forEach((point, i) => { if (gone[i]) flush(); else run.push(point); });
  flush();
  return pieces;
}

const pairsOf = (flat: readonly number[]): Point[] => {
  const points: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i]!, y: flat[i + 1]! });
  return points;
};

/**
 * Freehand strokes are drawn smoothed through the midpoints of their samples, which rounds off any
 * corner made of one point. Two close neighbours around each sharp turn keep it a corner.
 */
export function sharpenCorners(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]!, c = points[i]!, b = points[i + 1]!;
    const la = distance(a, c), lb = distance(c, b);
    if (la < 1e-6 || lb < 1e-6) { out.push(c); continue; }
    const ua = { x: (c.x - a.x) / la, y: (c.y - a.y) / la }, ub = { x: (b.x - c.x) / lb, y: (b.y - c.y) / lb };
    const turn = Math.acos(clamp(ua.x * ub.x + ua.y * ub.y, -1, 1));
    if (turn < Math.PI * 50 / 180) { out.push(c); continue; }
    const da = Math.min(0.75, la / 3), db = Math.min(0.75, lb / 3);
    out.push({ x: c.x - ua.x * da, y: c.y - ua.y * da }, c, { x: c.x + ub.x * db, y: c.y + ub.y * db });
  }
  out.push(points.at(-1)!);
  return out;
}

function penFrom(id: string, points: readonly Point[], color: string, strokeWidth: number): Pen {
  const sharp = sharpenCorners(points);
  const bounds = boundsOfPoints(sharp);
  return { id, type: 'pen', x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, angle: 0,
    points: sharp.flatMap(p => [round(p.x - bounds.x), round(p.y - bounds.y)]), color, strokeWidth };
}

/** A shape's outline as one closed polyline in world coordinates, starting halfway along its top. */
export function shapeOutlinePoints(el: WhiteboardShape): Point[] {
  const { w, h } = el;
  let local: Point[];
  if (el.shape === 'ellipse') {
    local = Array.from({ length: 73 }, (_, i) => { const t = -Math.PI / 2 + i / 72 * Math.PI * 2; return { x: w / 2 + w / 2 * Math.cos(t), y: h / 2 + h / 2 * Math.sin(t) }; });
  } else if (el.shape === 'roundRect') {
    const r = Math.max(0, Math.min(roundRadius(w, h), w / 2, h / 2));
    const arc = (cx: number, cy: number, from: number) => Array.from({ length: 9 }, (_, i) => {
      const t = from + i / 8 * Math.PI / 2;
      return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
    });
    local = [{ x: w / 2, y: 0 }, ...arc(w - r, r, -Math.PI / 2), ...arc(w - r, h - r, 0), ...arc(r, h - r, Math.PI / 2), ...arc(r, r, Math.PI), { x: w / 2, y: 0 }];
  } else {
    const corners = outlinePolygon(el.shape, { x: 0, y: 0, w, h, angle: 0 });
    const start = { x: (corners[0]!.x + corners[1]!.x) / 2, y: (corners[0]!.y + corners[1]!.y) / 2 };
    local = [start, ...corners.slice(1), corners[0]!, start];
  }
  return local.map(p => toWorld({ x: el.x + p.x, y: el.y + p.y }, el));
}

/** Free text placed where a box draws its text, so the words stay put when the box is gone. */
function textFrom(id: string, source: { text: string; runs?: WhiteboardText['runs']; fontSize: number; bold?: boolean; textAlign: WhiteboardTextAlign },
  color: string, owner: Box, area: Rect, measure: Measure): WhiteboardText {
  const layout = layoutText(source, area.w, measure);
  const h = Math.max(lineHeightOf(source.fontSize), layout.height);
  const top = area.y + Math.max(0, (area.h - h) / 2);
  const center = toWorld({ x: owner.x + area.x + area.w / 2, y: owner.y + top + h / 2 }, owner);
  return { id, type: 'text', x: center.x - area.w / 2, y: center.y - h / 2, w: area.w, h, angle: owner.angle, text: source.text,
    ...(source.runs?.length ? { runs: source.runs } : {}), color, fontSize: source.fontSize, textAlign: source.textAlign, ...(source.bold ? { bold: true } : {}) };
}

/**
 * A shape or connector redrawn as freehand strokes, so the eraser can take parts of it away. The
 * outline (or line) keeps the element's id, colour and width, which keeps connectors bound to a
 * shape attached; arrowheads become strokes of their own and any text becomes a free text element.
 * Fills and dash patterns have no stroke form and are not carried over.
 */
export function elementToStrokes(el: El, index: Index, newId: () => string, measure: Measure): El[] | null {
  if (el.type === 'shape') {
    const color = el.strokeWidth > 0 ? el.stroke : el.fill === 'transparent' ? palette.ink : el.fill;
    const result: El[] = [penFrom(el.id, shapeOutlinePoints(el), color, Math.max(0.5, el.strokeWidth || 2))];
    if (el.text.trim()) result.push(textFrom(newId(), el, el.textColor, el, shapeTextBox(el), measure));
    return result;
  }
  if (el.type === 'connector') {
    const path = connectorPath(el, index);
    const result: El[] = [penFrom(el.id, path.points, el.stroke, el.strokeWidth)];
    for (const [kind, tip, direction] of [[el.startArrow, path.points[0]!, path.startDirection], [el.endArrow, path.points.at(-1)!, path.endDirection]] as const) {
      const head = arrowheadPoints(kind, tip, direction, el.strokeWidth);
      if (head) result.push(penFrom(newId(), head, el.stroke, el.strokeWidth));
    }
    if (el.text.trim()) {
      const at = connectorLabelPoint(path);
      const width = Math.ceil(layoutText({ text: el.text, fontSize: 14 }, Infinity, measure).width) + 2;
      const label = { text: el.text, fontSize: 14, textAlign: 'center' as const };
      result.push(textFrom(newId(), label, palette.ink, { x: at.x - width / 2, y: at.y - 20, w: width, h: 40, angle: 0 }, { x: 0, y: 0, w: width, h: 40 }, measure));
    }
    return result;
  }
  return null;
}

export interface BoardLocate {
  /** Text to look for in an element, as typed into search. */
  text?: string;
  /** A page card or database view, counted among them in z-order like the server's reference index. */
  reference?: { pageId: string; occurrence?: number };
}

/** The element a search hit or a backlink points at. `exact` is false when a reference had to fall back to the first card for the page. */
export function locateElement(elements: Elements, request: BoardLocate): { id: string; exact: boolean } | null {
  if (request.reference) {
    const target = request.reference.pageId.toLowerCase();
    const points = (el: El) => (el.type === 'card' ? el.pageId : el.type === 'database' ? el.databaseId : '').toLowerCase() === target;
    const references = elements.filter(el => el.type === 'card' || el.type === 'database');
    const nth = request.reference.occurrence === undefined ? undefined : references[request.reference.occurrence];
    if (nth && points(nth)) return { id: nth.id, exact: true };
    const first = references.find(points);
    return first ? { id: first.id, exact: request.reference.occurrence === undefined } : null;
  }
  const squash = (value: string) => value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  const needle = squash(request.text ?? '');
  if (!needle) return null;
  // The same text the search index holds for each element.
  const found = elements.find(el => squash(el.type === 'image' ? el.fileName : elementText(el)).includes(needle));
  return found ? { id: found.id, exact: true } : null;
}

export const elementText = (el: El): string => el.type === 'frame' ? el.name : el.type === 'card' ? el.label
  : el.type === 'image' || el.type === 'pen' || el.type === 'database' ? '' : el.text;

/** Elements shown as live DOM over the canvas: page cards in preview mode and database views. */
export const isEmbedElement = (el: El | null | undefined): el is (WhiteboardCard & { view: 'preview' }) | WhiteboardDatabase =>
  Boolean(el) && (el!.type === 'database' || (el!.type === 'card' && el!.view === 'preview'));
export const embedDefaultSize = { card: { w: 440, h: 420 }, database: { w: 680, h: 380 }, chip: { w: 260, h: 64 } } as const;
