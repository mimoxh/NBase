import { expect, it } from 'vitest';
import { bounds, createSimulation, isSettled, nodeAt, reheat, seedPosition, settle, stepSimulation, type Point, type SimLink } from './layout';
import { buildQuadtree, repulsionAt } from './quadtree';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `node-${index}`);
const link = (source: number, target: number, weight = 1): SimLink => ({ source, target, weight });
const distance = (sim: { x: Float32Array; y: Float32Array }, a: number, b: number) => Math.hypot(sim.x[a]! - sim.x[b]!, sim.y[a]! - sim.y[b]!);

function bruteForce(x: number[], y: number[], index: number, strength: number, minDistance: number) {
  let fx = 0, fy = 0;
  for (let j = 0; j < x.length; j++) {
    if (j === index) continue;
    let dx = x[index]! - x[j]!, dy = y[index]! - y[j]!, d2 = dx * dx + dy * dy;
    if (d2 < minDistance * minDistance) { const scale = Math.sqrt(minDistance * minDistance / d2); dx *= scale; dy *= scale; d2 = minDistance * minDistance; }
    fx += dx * strength / d2; fy += dy * strength / d2;
  }
  return { fx, fy };
}

it('quadtree repulsion matches brute force exactly at theta 0 and closely at the default', () => {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < 400; i++) { const point = seedPosition(`p${i}`, 400); x.push(point.x); y.push(point.y); }
  const tree = buildQuadtree(x, y, x.length);
  expect(tree.mass[0]).toBeCloseTo(400, 6);
  let worst = 0;
  for (const index of [0, 17, 123, 399]) {
    const exact = bruteForce(x, y, index, 100, 1);
    const precise = { fx: 0, fy: 0 }, fast = { fx: 0, fy: 0 };
    repulsionAt(tree, index, x[index]!, y[index]!, 100, 0, 1, precise);
    repulsionAt(tree, index, x[index]!, y[index]!, 100, 0.9, 1, fast);
    expect(precise.fx).toBeCloseTo(exact.fx, 4);
    expect(precise.fy).toBeCloseTo(exact.fy, 4);
    worst = Math.max(worst, Math.hypot(fast.fx - exact.fx, fast.fy - exact.fy) / Math.hypot(exact.fx, exact.fy));
  }
  expect(worst).toBeLessThan(0.25);
});

it('quadtree survives coincident bodies and an empty set', () => {
  const same = Array.from({ length: 50 }, () => 3);
  const tree = buildQuadtree(same, same, 50);
  expect(tree.mass[0]).toBe(50);
  const out = { fx: 0, fy: 0 };
  repulsionAt(tree, 0, 3, 3, 100, 0.9, 5, out);
  expect(Number.isFinite(out.fx) && Number.isFinite(out.fy)).toBe(true);
  expect(Math.hypot(out.fx, out.fy)).toBeGreaterThan(0);
  expect(buildQuadtree([], [], 0).mass[0]).toBe(0);
});

it('seeds every id at a fixed place and lays the same graph out identically', () => {
  expect(seedPosition('page', 100)).toEqual(seedPosition('page', 100));
  expect(seedPosition('page', 100)).not.toEqual(seedPosition('other', 100));
  const links = [link(0, 1), link(1, 2), link(2, 0), link(3, 4)];
  const first = createSimulation(ids(8), links), second = createSimulation(ids(8), links);
  settle(first); settle(second);
  expect([...first.x]).toEqual([...second.x]);
  expect([...first.y]).toEqual([...second.y]);
});

it('pulls linked pages together, keeps every pair apart and comes to rest', () => {
  const sim = createSimulation(ids(40), [link(0, 1, 3), link(1, 2), link(0, 2), ...Array.from({ length: 12 }, (_, i) => link(10, 11 + i))]);
  const steps = settle(sim, 2000);
  expect(steps).toBeLessThan(600);
  expect(isSettled(sim)).toBe(true);
  expect(stepSimulation(sim)).toBe(false);
  // The linked triangle sits near the spring length, well inside the overall spread.
  for (const [a, b] of [[0, 1], [1, 2], [0, 2]] as const) expect(distance(sim, a, b)).toBeLessThan(110);
  let total = 0, pairsCount = 0;
  for (let i = 0; i < sim.count; i++) for (let j = i + 1; j < sim.count; j++) { total += distance(sim, i, j); pairsCount++; }
  expect(total / pairsCount).toBeGreaterThan(150);
  for (let i = 0; i < sim.count; i++) {
    expect(Number.isFinite(sim.x[i]!) && Number.isFinite(sim.y[i]!)).toBe(true);
    for (let j = i + 1; j < sim.count; j++) expect(distance(sim, i, j)).toBeGreaterThan(4);
  }
  const box = bounds(sim)!;
  expect(box.maxX - box.minX).toBeLessThan(4000);
});

it('keeps known positions on refresh and places a new page beside its neighbours', () => {
  const before = createSimulation(ids(30), [link(0, 1), link(1, 2), link(5, 6)]);
  settle(before);
  const previous = new Map<string, Point>(ids(30).map((id, index) => [id, { x: before.x[index]!, y: before.y[index]! }]));
  const same = createSimulation(ids(30), [link(0, 1), link(1, 2), link(5, 6)], previous);
  expect(same.alpha).toBeLessThan(0.1);
  settle(same);
  for (let i = 0; i < 30; i++) expect(Math.hypot(same.x[i]! - before.x[i]!, same.y[i]! - before.y[i]!)).toBeLessThan(12);

  const grown = createSimulation([...ids(30), 'new'], [link(0, 1), link(1, 2), link(5, 6), link(30, 5)], previous);
  expect(Math.hypot(grown.x[30]! - before.x[5]!, grown.y[30]! - before.y[5]!)).toBeLessThan(30);
  expect(grown.x[3]).toBe(before.x[3]);
  expect(grown.alpha).toBeGreaterThan(0.1);
  expect(grown.alpha).toBeLessThan(1);
});

it('a held node stays put while the rest relaxes, and reheating restarts a settled layout', () => {
  const sim = createSimulation(ids(6), [link(0, 1), link(1, 2)]);
  settle(sim);
  sim.fixed[1] = 1; sim.x[1] = 500; sim.y[1] = -300; sim.alphaTarget = 0.25; reheat(sim, 0.25);
  for (let i = 0; i < 80; i++) stepSimulation(sim);
  expect([sim.x[1], sim.y[1]]).toEqual([500, -300]);
  expect(distance(sim, 0, 1)).toBeLessThan(200);
  expect(isSettled(sim)).toBe(false);
  sim.fixed[1] = 0; sim.alphaTarget = 0;
  settle(sim);
  expect(isSettled(sim)).toBe(true);
});

it('steps two thousand pages with several thousand links without numerical trouble', () => {
  const count = 2000, links: SimLink[] = [];
  for (let i = 0; i < 6000; i++) links.push(link((i * 7919) % count, (i * 104729 + 13) % count));
  const sim = createSimulation(ids(count), links);
  const started = performance.now();
  for (let i = 0; i < 10; i++) stepSimulation(sim);
  const perStep = (performance.now() - started) / 10;
  expect(perStep).toBeLessThan(250);
  for (let i = 0; i < count; i++) expect(Number.isFinite(sim.x[i]!) && Number.isFinite(sim.y[i]!)).toBe(true);
});

it('finds the node under a point and nothing in empty space', () => {
  const sim = createSimulation(['a', 'b'], [], new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]));
  expect(nodeAt(sim, 3, 2, () => 5, 2)).toBe(0);
  expect(nodeAt(sim, 96, 0, () => 5, 2)).toBe(1);
  expect(nodeAt(sim, 50, 0, () => 5, 2)).toBe(-1);
  expect(bounds(createSimulation([], []))).toBeNull();
});
