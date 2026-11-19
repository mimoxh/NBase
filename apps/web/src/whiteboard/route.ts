import { boundsOfPoints, dedupe, distance, elbowCore, expandRect, rectsIntersect, sideVector, type Point, type Rect, type Side } from './geometry';

/**
 * Connector routing. Automatic elbow routes avoid the boxes of other elements with an A* search
 * over a sparse visibility grid built from the obstacles' padded edges, with a cost for every turn.
 * User-placed bend points take precedence: the route then runs through them and only the stretches
 * to the two ends are worked out, so moving a bound element keeps the user's shape.
 */
export interface RouteEnd {
  point: Point;
  side: Side;
  /** Box of the element the end is bound to; the route never crosses it after leaving. */
  own?: Rect | null;
}

export const routeMargin = 20;
const padding = 10;
const bendPenalty = 24;
const eps = 0.5;
export const routeLimits = {
  /** Obstacles considered per route; the nearest ones win when there are more. */
  maxObstacles: 48,
  /** Search states expanded before giving up and keeping the plain route. */
  maxExpansions: 40_000,
  /** How far around the two ends a route may wander, in world units. */
  regionPad: 160,
} as const;

const inside = (p: Point, r: Rect) => p.x > r.x + eps && p.x < r.x + r.w - eps && p.y > r.y + eps && p.y < r.y + r.h - eps;

/** Whether an axis-aligned segment passes through the interior of a rectangle. */
export function segmentCrosses(a: Point, b: Point, r: Rect): boolean {
  if (Math.abs(a.y - b.y) <= Math.abs(a.x - b.x)) {
    const y = (a.y + b.y) / 2;
    if (y <= r.y + eps || y >= r.y + r.h - eps) return false;
    return Math.max(a.x, b.x) > r.x + eps && Math.min(a.x, b.x) < r.x + r.w - eps;
  }
  const x = (a.x + b.x) / 2;
  if (x <= r.x + eps || x >= r.x + r.w - eps) return false;
  return Math.max(a.y, b.y) > r.y + eps && Math.min(a.y, b.y) < r.y + r.h - eps;
}

/** The area an automatic route can occupy: everything it draws stays inside, so it doubles as a culling box. */
export function routeRegion(from: Point, to: Point, own: readonly (Rect | null | undefined)[]): Rect {
  const points: Point[] = [from, to];
  for (const rect of own) if (rect) points.push({ x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y + rect.h });
  return expandRect(boundsOfPoints(points), routeLimits.regionPad + routeMargin);
}

const directionOf: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };
const steps = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;

function uniqueSorted(values: number[]): number[] {
  values.sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of values) if (!out.length || value - out.at(-1)! > eps) out.push(value);
  return out;
}

/** Index range [first, last] of sorted values strictly between lo and hi. */
function strictRange(values: readonly number[], lo: number, hi: number): [number, number] {
  let first = 0;
  while (first < values.length && values[first]! <= lo + eps) first += 1;
  let last = values.length - 1;
  while (last >= 0 && values[last]! >= hi - eps) last -= 1;
  return [first, last];
}

class Heap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() { return this.keys.length; }
  clear() { this.keys.length = 0; this.values.length = 0; }
  push(key: number, value: number) {
    const keys = this.keys, values = this.values;
    let i = keys.length;
    keys.push(key); values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!; values[i] = values[parent]!;
      i = parent;
    }
    keys[i] = key; values[i] = value;
  }
  peekKey() { return this.keys[0]!; }
  pop(): number {
    const keys = this.keys, values = this.values;
    const top = values[0]!;
    const lastKey = keys.pop()!, lastValue = values.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1;
        let smallest = i, smallestKey = lastKey;
        if (left < keys.length && keys[left]! < smallestKey) { smallest = left; smallestKey = keys[left]!; }
        if (right < keys.length && keys[right]! < smallestKey) { smallest = right; }
        if (smallest === i) break;
        keys[i] = keys[smallest]!; values[i] = values[smallest]!;
        i = smallest;
      }
      keys[i] = lastKey; values[i] = lastValue;
    }
    return top;
  }
}

/**
 * Search buffers shared by every route: a board routes hundreds of connectors per state, and
 * allocating the grids each time cost more than searching them. Costs are valid only where
 * `seen` holds the current stamp, so nothing needs clearing between searches.
 */
const buffers = { nodes: 0, nodeBlocked: new Uint8Array(0), rowBlocked: new Uint8Array(0), columnBlocked: new Uint8Array(0),
  cost: new Float64Array(0), previous: new Int32Array(0), seen: new Uint32Array(0), heap: new Heap(), stamp: 0 };
function scratch(nodes: number) {
  if (buffers.nodes < nodes) {
    const size = Math.max(nodes, buffers.nodes * 2);
    buffers.nodes = size;
    buffers.nodeBlocked = new Uint8Array(size); buffers.rowBlocked = new Uint8Array(size); buffers.columnBlocked = new Uint8Array(size);
    buffers.cost = new Float64Array(size * 4); buffers.previous = new Int32Array(size * 4); buffers.seen = new Uint32Array(size * 4);
    buffers.stamp = 0;
  }
  buffers.nodeBlocked.fill(0, 0, nodes); buffers.rowBlocked.fill(0, 0, nodes); buffers.columnBlocked.fill(0, 0, nodes);
  buffers.heap.clear();
  buffers.stamp += 1;
  if (buffers.stamp >= 0xffffffff) { buffers.seen.fill(0); buffers.stamp = 1; }
  return buffers;
}

export interface ElbowRoute {
  points: Point[];
  /** Whether the plain route was blocked and a detour was found. */
  avoided: boolean;
}

/**
 * Orthogonal route from one end to the other around the given obstacles. The plain fixed-shape
 * route is kept whenever nothing is in its way, which keeps simple diagrams stable; the search runs
 * only when it is blocked, and its result is the plain route again when no detour is found in time.
 */
export function routeElbow(from: RouteEnd, to: RouteEnd, obstacles: readonly Rect[]): ElbowRoute {
  const core = elbowCore(from.point, from.side, to.point, to.side, 0, routeMargin).points;
  const plain = { points: dedupe(core), avoided: false };
  const s0 = core[1]!, s1 = core.at(-2)!;
  const blockers: Rect[] = [];
  for (const rect of obstacles) {
    const padded = expandRect(rect, padding);
    if (!inside(s0, padded) && !inside(s1, padded)) blockers.push(padded);
  }
  for (const own of [from.own, to.own]) if (own && !inside(s0, own) && !inside(s1, own)) blockers.push(own);
  const blocked = (points: readonly Point[], first: number, last: number) => {
    for (let i = first; i < last; i += 1) {
      const a = points[i]!, b = points[i + 1]!;
      if (distance(a, b) < eps) continue;
      for (const rect of blockers) if (segmentCrosses(a, b, rect)) return true;
    }
    return false;
  };
  // The stubs leave and enter the bound elements by definition; only the stretch between them can be rerouted.
  if (!blockers.length || !blocked(core, 1, core.length - 2)) return plain;
  const region = routeRegion(from.point, to.point, [from.own, to.own]);
  let relevant = blockers.filter(rect => rectsIntersect(rect, region));
  if (relevant.length > routeLimits.maxObstacles) {
    const mid = { x: (s0.x + s1.x) / 2, y: (s0.y + s1.y) / 2 };
    const reach = (rect: Rect) => Math.hypot(rect.x + rect.w / 2 - mid.x, rect.y + rect.h / 2 - mid.y);
    relevant = [...relevant].sort((a, b) => reach(a) - reach(b)).slice(0, routeLimits.maxObstacles);
  }
  const clipX = (value: number) => Math.min(region.x + region.w, Math.max(region.x, value));
  const clipY = (value: number) => Math.min(region.y + region.h, Math.max(region.y, value));
  const xs = uniqueSorted([region.x, region.x + region.w, s0.x, s1.x, (s0.x + s1.x) / 2, ...relevant.flatMap(r => [clipX(r.x), clipX(r.x + r.w)])]);
  const ys = uniqueSorted([region.y, region.y + region.h, s0.y, s1.y, (s0.y + s1.y) / 2, ...relevant.flatMap(r => [clipY(r.y), clipY(r.y + r.h)])]);
  const nx = xs.length, ny = ys.length;
  const find = (values: readonly number[], value: number) => {
    let best = 0;
    for (let i = 1; i < values.length; i += 1) if (Math.abs(values[i]! - value) < Math.abs(values[best]! - value)) best = i;
    return best;
  };
  const start = find(ys, s0.y) * nx + find(xs, s0.x), goal = find(ys, s1.y) * nx + find(xs, s1.x);
  const { nodeBlocked, rowBlocked, columnBlocked, cost, previous, seen, heap, stamp } = scratch(nx * ny);
  const midX = xs.slice(1).map((x, i) => (x + xs[i]!) / 2), midY = ys.slice(1).map((y, i) => (y + ys[i]!) / 2);
  for (const r of relevant) {
    const [x0, x1] = strictRange(xs, r.x, r.x + r.w), [y0, y1] = strictRange(ys, r.y, r.y + r.h);
    const [mx0, mx1] = strictRange(midX, r.x, r.x + r.w), [my0, my1] = strictRange(midY, r.y, r.y + r.h);
    for (let j = y0; j <= y1; j += 1) {
      for (let i = x0; i <= x1; i += 1) nodeBlocked[j * nx + i] = 1;
      for (let i = mx0; i <= mx1; i += 1) rowBlocked[j * nx + i] = 1;
    }
    for (let j = my0; j <= my1; j += 1) for (let i = x0; i <= x1; i += 1) columnBlocked[j * nx + i] = 1;
  }
  nodeBlocked[start] = 0; nodeBlocked[goal] = 0;
  const gx = xs[goal % nx]!, gy = ys[Math.floor(goal / nx)]!;
  // The last move into the target's stub runs against the target's side.
  const arrive = (directionOf[to.side] + 2) % 4;
  const turnsBetween = (a: number, b: number) => a === b ? 0 : a === (b + 2) % 4 ? 2 : 1;
  /**
   * Distance plus the turns that cannot be avoided: one unless the goal lies straight ahead, two
   * when it lies behind. It never overestimates, so the search stays exact while it expands far
   * fewer states than distance alone would let it.
   */
  const estimate = (node: number, direction: number) => {
    const dx = gx - xs[node % nx]!, dy = gy - ys[Math.floor(node / nx)]!;
    const flat = Math.abs(dx) + Math.abs(dy);
    if (flat < eps) return turnsBetween(direction, arrive) * bendPenalty;
    const along = direction === 0 ? dx : direction === 1 ? dy : direction === 2 ? -dx : -dy;
    const across = direction === 0 || direction === 2 ? dy : dx;
    const turns = along < -eps ? 2 : Math.abs(across) < eps ? (direction === arrive ? 0 : 1) : 1;
    return flat + turns * bendPenalty;
  };
  const first = start * 4 + directionOf[from.side];
  cost[first] = 0; previous[first] = -1; seen[first] = stamp;
  heap.push(estimate(start, directionOf[from.side]), first);
  let best = Infinity, bestState = -1, expanded = 0;
  while (heap.size && heap.peekKey() < best) {
    const state = heap.pop();
    const node = state >> 2, direction = state & 3;
    const g = cost[state]!;
    if (node === goal) {
      const turns = turnsBetween(direction, arrive);
      if (g + turns * bendPenalty < best) { best = g + turns * bendPenalty; bestState = state; }
      continue;
    }
    if ((expanded += 1) > routeLimits.maxExpansions) return plain;
    const i = node % nx, j = (node - i) / nx;
    for (let next = 0; next < 4; next += 1) {
      if (next === (direction + 2) % 4) continue;
      const [dx, dy] = steps[next]!;
      const ni = i + dx, nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const target = nj * nx + ni;
      if (nodeBlocked[target]) continue;
      if (dy === 0 ? rowBlocked[j * nx + Math.min(i, ni)] : columnBlocked[Math.min(j, nj) * nx + i]) continue;
      const step = dy === 0 ? Math.abs(xs[ni]! - xs[i]!) : Math.abs(ys[nj]! - ys[j]!);
      const total = g + step + (next === direction ? 0 : bendPenalty);
      const key = target * 4 + next;
      if (seen[key] === stamp && total >= cost[key]!) continue;
      seen[key] = stamp;
      cost[key] = total;
      previous[key] = state;
      heap.push(total + estimate(target, next), key);
    }
  }
  if (bestState < 0) return plain;
  const nodes: Point[] = [];
  for (let state = bestState; state >= 0; state = previous[state]!) {
    const node = state >> 2;
    const point = { x: xs[node % nx]!, y: ys[Math.floor(node / nx)]! };
    if (!nodes.length || distance(nodes.at(-1)!, point) > eps) nodes.push(point);
  }
  nodes.reverse();
  // Grid lines are snapped to the stubs, so the exact stub positions replace the nearest lines.
  nodes[0] = s0; nodes[nodes.length - 1] = s1;
  return { points: dedupe([from.point, ...nodes, to.point]), avoided: true };
}

/**
 * Whether a finished route still keeps clear of the given boxes, judged as `routeElbow` judges its
 * plain route: the stretches next to the two ends are exempt, and so is any box they start inside.
 */
export function routeClear(points: readonly Point[], obstacles: readonly Rect[]): boolean {
  if (points.length < 2) return true;
  const ends = [points[0]!, points[1]!, points.at(-2)!, points.at(-1)!];
  for (const rect of obstacles) {
    const padded = expandRect(rect, padding);
    if (ends.some(point => inside(point, padded))) continue;
    for (let i = 1; i < points.length - 2; i += 1) if (segmentCrosses(points[i]!, points[i + 1]!, padded)) return false;
    // A route of one or two segments has no middle; its whole length must then keep clear.
    if (points.length <= 3) for (let i = 0; i < points.length - 1; i += 1) if (segmentCrosses(points[i]!, points[i + 1]!, padded)) return false;
  }
  return true;
}

// ── Routes through user-placed bend points ──────────────────────────────────

const aligned = (a: Point, b: Point) => Math.abs(a.x - b.x) < eps || Math.abs(a.y - b.y) < eps;
const horizontalSide = (side: Side) => side === 'left' || side === 'right';

/** Points between an end and the first bend point, leaving along the end's side. */
function leave(p: Point, side: Side, w: Point): Point[] {
  const d = sideVector[side];
  const ahead = (w.x - p.x) * d.x + (w.y - p.y) * d.y;
  const onAxis = horizontalSide(side) ? Math.abs(w.y - p.y) < eps : Math.abs(w.x - p.x) < eps;
  if (onAxis && ahead > 0) return [];
  if (ahead >= routeMargin) return [horizontalSide(side) ? { x: w.x, y: p.y } : { x: p.x, y: w.y }];
  const s = { x: p.x + d.x * routeMargin, y: p.y + d.y * routeMargin };
  return [s, horizontalSide(side) ? { x: s.x, y: w.y } : { x: w.x, y: s.y }];
}

/** Direction of the last segment with a length, or null when there is none. */
function lastAxis(points: readonly Point[]): 'h' | 'v' | null {
  for (let i = points.length - 1; i > 0; i -= 1) {
    const a = points[i - 1]!, b = points[i]!;
    if (distance(a, b) >= eps) return Math.abs(a.y - b.y) < eps ? 'h' : 'v';
  }
  return null;
}

/**
 * Orthogonal route through the bend points, as handles address it: ends included and nothing
 * simplified away, so a pair of coincident bend points the user just added stays two points.
 */
export function routeThrough(from: RouteEnd, waypoints: readonly Point[], to: RouteEnd): Point[] {
  if (!waypoints.length) return elbowCore(from.point, from.side, to.point, to.side, 0, routeMargin).points;
  const out: Point[] = [from.point, ...leave(from.point, from.side, waypoints[0]!), waypoints[0]!];
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1]!, cur = waypoints[i]!;
    if (!aligned(prev, cur)) out.push(lastAxis(out) === 'h' ? { x: prev.x, y: cur.y } : { x: cur.x, y: prev.y });
    out.push(cur);
  }
  out.push(...leave(to.point, to.side, waypoints.at(-1)!).reverse(), to.point);
  return out;
}

// ── Editing an orthogonal route ─────────────────────────────────────────────

const segmentAxis = (a: Point, b: Point): 'h' | 'v' => Math.abs(a.y - b.y) <= Math.abs(a.x - b.x) ? 'h' : 'v';

/** Drop repeats and collinear middles, and with them any bend point that no longer bends. */
const tidy = (points: readonly Point[]) => dedupe(points);

/**
 * Bend points after sliding segment `index` of a route sideways by `delta`. Ends never move: a
 * segment touching one keeps a short stub at that end and steps over to its new position.
 */
export function slideSegment(route: readonly Point[], index: number, delta: number): Point[] {
  const last = route.length - 1;
  const a = route[index]!, b = route[index + 1]!;
  const axis = segmentAxis(a, b);
  const shift = (p: Point): Point => axis === 'h' ? { x: p.x, y: p.y + delta } : { x: p.x + delta, y: p.y };
  const length = distance(a, b);
  const touchesStart = index === 0, touchesEnd = index + 1 === last;
  const stub = Math.min(routeMargin, length / (touchesStart && touchesEnd ? 3 : 2));
  const unit = length > 1e-9 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : { x: 0, y: 0 };
  const result: Point[] = [];
  if (touchesStart) { const s = { x: a.x + unit.x * stub, y: a.y + unit.y * stub }; result.push(a, s, shift(s)); }
  else result.push(...route.slice(0, index), shift(a));
  if (touchesEnd) { const e = { x: b.x - unit.x * stub, y: b.y - unit.y * stub }; result.push(shift(e), e, b); }
  else result.push(shift(b), ...route.slice(index + 2));
  return tidy(result).slice(1, -1);
}

/** Bend points with a new pair at `at` on segment `index`: the two halves of the segment can then be slid apart. */
export function splitSegment(route: readonly Point[], index: number, at: Point): Point[] {
  const a = route[index]!, b = route[index + 1]!;
  const q = segmentAxis(a, b) === 'h' ? { x: Math.min(Math.max(at.x, Math.min(a.x, b.x)), Math.max(a.x, b.x)), y: a.y }
    : { x: a.x, y: Math.min(Math.max(at.y, Math.min(a.y, b.y)), Math.max(a.y, b.y)) };
  return [...route.slice(1, index + 1), q, q, ...route.slice(index + 1, -1)];
}

/**
 * Bend points without the corner at `index`: one of its two segments shrinks to nothing by sliding
 * its neighbour over. A route with a single corner between its ends goes back to automatic (empty).
 */
export function removeCorner(route: readonly Point[], index: number): Point[] {
  const last = route.length - 1;
  if (index <= 0 || index >= last) return route.slice(1, -1);
  const corner = route[index]!;
  const offset = (from: Point, to: Point, axis: 'h' | 'v') => axis === 'h' ? to.y - from.y : to.x - from.x;
  if (index + 1 < last) return slideSegment(route, index, offset(corner, route[index - 1]!, segmentAxis(corner, route[index + 1]!)));
  if (index - 1 > 0) return slideSegment(route, index - 1, offset(corner, route[index + 1]!, segmentAxis(route[index - 1]!, corner)));
  return [];
}

/**
 * Bend points after dragging the corner at `index` to `to`: its two segments slide so that they
 * meet there, which keeps the route orthogonal.
 */
export function moveCorner(route: readonly Point[], index: number, to: Point): Point[] {
  const last = route.length - 1;
  if (index <= 0 || index >= last) return route.slice(1, -1);
  const corner = route[index]!;
  const incoming = segmentAxis(route[index - 1]!, corner);
  const first = slideSegment(route, index - 1, incoming === 'h' ? to.y - corner.y : to.x - corner.x);
  const step = [route[0]!, ...first, route[last]!];
  const moved = incoming === 'h' ? { x: corner.x, y: to.y } : { x: to.x, y: corner.y };
  const at = step.findIndex(point => distance(point, moved) < eps);
  if (at < 0 || at >= step.length - 1) return first;
  const a = step[at]!, b = step[at + 1]!;
  return slideSegment(step, at, segmentAxis(a, b) === 'h' ? to.y - a.y : to.x - a.x);
}

/** Interior corners of a route, by index, where the direction actually changes. */
export function routeCorners(route: readonly Point[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < route.length - 1; i += 1) {
    const a = route[i - 1]!, b = route[i]!, c = route[i + 1]!;
    if (distance(a, b) < eps || distance(b, c) < eps) continue;
    if (segmentAxis(a, b) !== segmentAxis(b, c)) result.push(i);
  }
  return result;
}
