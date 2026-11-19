import { describe, expect, it } from 'vitest';
import { whiteboardContent, whiteboardContentProblem, type WhiteboardShape, type WhiteboardText } from '@nbase/contracts';
import { parseElements, plainText, serializeElements } from './clipboard';
import { Controller, type PointerInput } from './controller';
import { addMindChild, createMindRoot, mindDropTarget, mindLayoutOf, moveMindNode, setMindCollapsed, setMindLayout } from './mind';
import { cloneElements, connectorPath, createConnector, createShape, elementToStrokes, indexElements, markProvisional, normalizeForSave, translate, withWaypoints,
  type Connector, type El } from './model';
import { moveCorner, removeCorner, routeCorners, routeElbow, routeThrough, segmentCrosses, slideSegment, splitSegment } from './route';
import { editRuns, normalizeRuns, rangeStyle, runsText, styleRange } from './runs';
import { BoardStore } from './store';
import { approximateMeasure as measure, layoutText, wrapText } from './text';
import type { Point, Rect } from './geometry';

let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const rect = (x: number, y: number, w = 100, h = 60) => createShape(uid(), { x, y, w, h });
const valid = (elements: readonly El[]) => expect(whiteboardContentProblem(whiteboardContent(normalizeForSave(elements)))).toBeNull();
const byId = (elements: readonly El[], id: string) => elements.find(el => el.id === id) as WhiteboardShape;
const bound = (id: string) => ({ x: 0, y: 0, bind: { elementId: id, ax: 0.5, ay: 0.5 } });
const orthogonal = (points: readonly Point[]) => points.every((p, i) => i === 0 || p.x === points[i - 1]!.x || p.y === points[i - 1]!.y);
const crossesAny = (points: readonly Point[], boxes: readonly Rect[]) => points.some((p, i) => i > 0 && boxes.some(box => segmentCrosses(points[i - 1]!, p, box)));

describe('obstacle-avoiding elbow routes', () => {
  it('keeps the plain route when nothing is in the way and goes around what is', () => {
    const from = { point: { x: 0, y: 0 }, side: 'right' as const }, to = { point: { x: 400, y: 0 }, side: 'left' as const };
    expect(routeElbow(from, to, [])).toEqual({ points: [{ x: 0, y: 0 }, { x: 400, y: 0 }], avoided: false });
    const wall: Rect = { x: 150, y: -60, w: 100, h: 120 };
    const around = routeElbow(from, to, [wall]);
    expect(around.avoided).toBe(true);
    expect(orthogonal(around.points)).toBe(true);
    expect(crossesAny(around.points, [wall])).toBe(false);
    expect(around.points[0]).toEqual(from.point);
    expect(around.points.at(-1)).toEqual(to.point);
    // A detour turns as few times as it can: up (or down), across, back.
    expect(around.points.length).toBeLessThanOrEqual(6);
  });

  it('routes bound connectors around other shapes on the board', () => {
    const a = rect(0, 0, 100, 100), b = rect(500, 0, 100, 100), middle = rect(220, -40, 120, 180);
    const connector = createConnector(uid(), bound(a.id), bound(b.id));
    const path = connectorPath(connector, indexElements([a, b, middle, connector]));
    expect(orthogonal(path.points)).toBe(true);
    expect(crossesAny(path.points, [middle])).toBe(false);
    // The same board state gives the very same route object back.
    const index = indexElements([a, b, middle, connector]);
    expect(connectorPath(connector, index)).toBe(connectorPath(connector, index));
  });

  it('reuses routes across rebuilt but unmoved elements and keeps clear routes during a gesture', () => {
    const a = rect(0, 0, 100, 100), b = rect(500, 0, 100, 100), middle = rect(220, -40, 120, 180), aside = rect(260, 300, 60, 40);
    const connector = createConnector(uid(), bound(a.id), bound(b.id));
    const board: El[] = [a, b, middle, aside, connector];
    const first = connectorPath(connector, indexElements(board));
    // Saving rebuilds every element; a route whose inputs did not change is not searched again.
    const rebuilt = JSON.parse(JSON.stringify(board)) as El[];
    expect(connectorPath(rebuilt[4] as Connector, indexElements(rebuilt))).toBe(first);
    // While a gesture moves an unrelated box that stays clear of the route, the route is kept.
    const step = translate(board, new Set([aside.id]), 10, 0);
    const stepIndex = indexElements(step);
    markProvisional(stepIndex);
    expect(connectorPath(step[4] as Connector, stepIndex)).toBe(first);
    // A box moved into its way reroutes it at once.
    const top = first.points.reduce((min, p) => Math.min(min, p.y), Infinity);
    const blocking = translate(board, new Set([aside.id]), -30, top - 300 - 20);
    const blockingIndex = indexElements(blocking);
    markProvisional(blockingIndex);
    const moved = blocking[3] as WhiteboardShape;
    const rerouted = connectorPath(blocking[4] as Connector, blockingIndex);
    expect(rerouted).not.toBe(first);
    expect(crossesAny(rerouted.points, [middle, moved])).toBe(false);
    // The settled state is routed afresh and matches a board that never went through the gesture.
    const settled = connectorPath(step[4] as Connector, indexElements(step));
    const fresh = JSON.parse(JSON.stringify(step)) as El[];
    const fromScratch = connectorPath({ ...(fresh[4] as Connector), id: uid() }, indexElements(fresh));
    expect(settled.points).toEqual(fromScratch.points);
  });
  it('runs through bend points and keeps them when a bound end moves', () => {
    const from = { point: { x: 0, y: 0 }, side: 'right' as const }, to = { point: { x: 400, y: 200 }, side: 'left' as const };
    const route = routeThrough(from, [{ x: 300, y: 0 }, { x: 300, y: 200 }], to);
    expect(orthogonal(route)).toBe(true);
    expect(route).toContainEqual({ x: 300, y: 0 });
    const a = rect(0, 0, 100, 100), b = rect(400, 200, 100, 100);
    const connector: Connector = { ...createConnector(uid(), bound(a.id), bound(b.id)), waypoints: [{ x: 300, y: 50 }, { x: 300, y: 250 }] };
    const moved = translate([a, b, connector], new Set([b.id]), 0, 120);
    const path = connectorPath(moved[2] as Connector, indexElements(moved));
    expect(path.manual).toBe(true);
    expect(orthogonal(path.points)).toBe(true);
    expect(path.points.some(p => p.x === 300)).toBe(true);
    expect(path.points.at(-1)).toEqual({ x: 400, y: 370 });
  });

  it('slides, splits and removes corners while staying orthogonal', () => {
    const route = [{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 200 }, { x: 300, y: 200 }];
    const slid = slideSegment(route, 1, 40);
    expect(slid).toEqual([{ x: 190, y: 0 }, { x: 190, y: 200 }]);
    // Sliding a segment that touches an end leaves a stub there and steps over.
    const first = [route[0]!, ...slideSegment(route, 0, 30), route[3]!];
    expect(orthogonal(first)).toBe(true);
    expect(first[1]).toEqual({ x: 20, y: 0 });
    expect(first.some(p => p.y === 30)).toBe(true);
    const split = splitSegment(route, 2, { x: 220, y: 200 });
    expect(split).toEqual([{ x: 150, y: 0 }, { x: 150, y: 200 }, { x: 220, y: 200 }, { x: 220, y: 200 }]);
    expect(routeCorners(route)).toEqual([1, 2]);
    const fewer = [route[0]!, ...removeCorner(route, 1), route[3]!];
    expect(orthogonal(fewer)).toBe(true);
    expect(routeCorners(fewer).length).toBeLessThan(2);
    const cornered = [route[0]!, ...moveCorner(route, 2, { x: 180, y: 150 }), route[3]!];
    expect(orthogonal(cornered)).toBe(true);
    expect(cornered).toContainEqual({ x: 180, y: 150 });
  });

  it('stores only the bend points that change something', () => {
    const a = rect(0, 0, 100, 100), b = rect(400, 200, 100, 100);
    const connector = createConnector(uid(), bound(a.id), bound(b.id));
    const index = indexElements([a, b, connector]);
    const auto = connectorPath(connector, index).points;
    // Bend points on the automatic route say nothing new and go away.
    expect(withWaypoints(connector, auto.slice(1, -1), index).waypoints).toBeUndefined();
    const manual = withWaypoints(connector, [{ x: 320, y: 50 }, { x: 320, y: 250 }], index);
    expect(manual.waypoints?.length).toBeGreaterThan(0);
    expect(connectorPath(manual, index).points.filter(p => p.x === 320)).toHaveLength(2);
    valid([a, b, manual]);
  });

  it('remaps bend points and styled text with new ids when copied', () => {
    const a = rect(0, 0, 100, 100), b = rect(400, 200, 100, 100);
    const connector: Connector = { ...createConnector(uid(), bound(a.id), bound(b.id)), waypoints: [{ x: 300, y: 50 }, { x: 300, y: 250 }] };
    const styled: WhiteboardShape = { ...a, text: '加粗 plain', runs: [{ text: '加粗', bold: true }, { text: ' plain' }] };
    const elements = [styled, b, connector];
    const copies = cloneElements(elements, indexElements(elements), { x: 10, y: 20 }, uid);
    const copy = copies.find(el => el.type === 'connector') as Connector;
    expect(copy.id).not.toBe(connector.id);
    expect(copy.waypoints).toEqual([{ x: 310, y: 70 }, { x: 310, y: 270 }]);
    expect(copy.source.bind!.elementId).toBe(copies[0]!.id);
    expect((copies[0] as WhiteboardShape).runs).toEqual(styled.runs);
    const pasted = parseElements(serializeElements(elements, uid))!;
    expect((pasted[0] as WhiteboardShape).runs).toEqual(styled.runs);
    expect((pasted[2] as Connector).waypoints).toEqual(connector.waypoints);
    expect((pasted[2] as Connector).source.bind!.elementId).toBe(pasted[0]!.id);
    expect(plainText(elements)).toBe('加粗 plain');
    valid([...elements, ...copies]);
  });
});

describe('styled text runs', () => {
  const defaults = { fontSize: 16 };

  it('styles a range, merges neighbours and drops what repeats the element style', () => {
    const runs = styleRange('hello world', undefined, 0, 5, { bold: true }, defaults)!;
    expect(runs).toEqual([{ text: 'hello', bold: true }, { text: ' world' }]);
    expect(runsText(runs)).toBe('hello world');
    const both = styleRange('hello world', runs, 5, 11, { bold: true }, defaults);
    expect(both).toEqual([{ text: 'hello world', bold: true }]);
    expect(styleRange('hello world', both, 0, 11, { bold: null }, defaults)).toBeUndefined();
    const coloured = styleRange('hello world', runs, 3, 8, { color: 'red', fontSize: 24 }, defaults)!;
    expect(runsText(coloured)).toBe('hello world');
    expect(rangeStyle('hello world', coloured, 3, 5)).toEqual({ bold: true, color: 'red', fontSize: 24 });
    expect(rangeStyle('hello world', coloured, 0, 8)).toEqual({});
    expect(normalizeRuns([{ text: 'a', fontSize: 16 }, { text: 'b', italic: false }], defaults)).toBeUndefined();
  });

  it('carries styles through typing', () => {
    const runs = styleRange('abcdef', undefined, 2, 4, { italic: true }, defaults);
    expect(editRuns(runs, 'abcdef', 'abcXdef', defaults)).toEqual([{ text: 'ab' }, { text: 'cXd', italic: true }, { text: 'ef' }]);
    expect(editRuns(runs, 'abcdef', 'abef', defaults)).toBeUndefined();
    expect(editRuns(undefined, 'abc', 'abcd', defaults)).toBeUndefined();
  });

  it('wraps styled text like plain text, with bigger runs making taller lines', () => {
    const text = 'alpha beta gamma delta';
    const plain = layoutText({ text, fontSize: 16 }, 90, measure);
    expect(plain.lines.map(line => line.segments.map(s => s.text).join(''))).toEqual(wrapText(text, 90, 16, false, measure));
    const runs = styleRange(text, undefined, 0, 5, { fontSize: 32 }, defaults);
    const styled = layoutText({ text, runs, fontSize: 16 }, 90, measure);
    expect(styled.lines[0]!.height).toBeGreaterThan(plain.lines[0]!.height);
    expect(styled.lines.flatMap(line => line.segments.map(s => s.text)).join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    for (const line of styled.lines) expect(line.width).toBeLessThanOrEqual(Math.max(90, 32 * 0.55 * 5));
  });

  it('keeps old boards without runs as they are and checks runs on save', () => {
    const shape = { ...rect(0, 0), text: 'old' };
    expect('runs' in normalizeForSave([shape])[0]!).toBe(false);
    const saves: El[][] = [];
    new BoardStore([shape], false, next => saves.push(next));
    expect(saves).toHaveLength(0);
    const bad = { ...shape, runs: [{ text: 'ol' }] };
    expect(whiteboardContentProblem(whiteboardContent([bad]))).not.toBeNull();
    const good = { ...shape, runs: [{ text: 'o', bold: true }, { text: 'ld' }] };
    expect(whiteboardContentProblem(whiteboardContent([good]))).toBeNull();
  });

  it('applies run styles from the editor as one change', () => {
    const shape = { ...rect(0, 0, 200, 80), text: 'hello world' };
    const saves: El[][] = [];
    const store = new BoardStore([shape], false, next => saves.push(next));
    store.size = { width: 1000, height: 800 };
    const controller = new Controller(store, { measure, newId: uid, openPage: () => undefined, contextMenu: () => undefined, notice: () => undefined });
    controller.startEditing(shape.id);
    controller.styleText(0, 5, { bold: true });
    controller.styleText(6, 11, { color: 'blue' });
    expect(controller.editingStyle(0, 5)).toEqual({ bold: true });
    controller.editText('hello big world');
    controller.finishEditing();
    const saved = byId(store.elements, shape.id);
    expect(saved.text).toBe('hello big world');
    expect(runsText(saved.runs!)).toBe('hello big world');
    expect(saved.runs![0]).toEqual({ text: 'hello', bold: true });
    valid(store.elements);
    store.undo();
    expect(byId(store.elements, shape.id).runs).toBeUndefined();
  });
});

describe('organisation chart layout', () => {
  function chart() {
    const root = createMindRoot(uid(), 400, 0, '公司', measure);
    const ids = { root: root.id, a: uid(), a1: uid(), a2: uid(), b: uid(), c: uid() };
    let elements: El[] = [root];
    elements = addMindChild(elements, ids.root, ids.a, measure);
    elements = addMindChild(elements, ids.a, ids.a1, measure);
    elements = addMindChild(elements, ids.a, ids.a2, measure);
    elements = addMindChild(elements, ids.root, ids.b, measure);
    elements = addMindChild(elements, ids.root, ids.c, measure);
    return { elements: setMindLayout(elements, ids.root, 'down'), ids };
  }
  const cx = (node: WhiteboardShape) => node.x + node.w / 2;

  it('puts children in rows under their parents, centred and in order', () => {
    const { elements, ids } = chart();
    expect(mindLayoutOf(elements, ids.root)).toBe('down');
    const [root, a, a1, a2, b, c] = [ids.root, ids.a, ids.a1, ids.a2, ids.b, ids.c].map(id => byId(elements, id));
    expect(root!.mindLayout).toBe('down');
    for (const kid of [a!, b!, c!]) expect(kid.y).toBe(a!.y);
    expect(a!.y).toBeGreaterThan(root!.y + root!.h);
    expect(a!.x + a!.w).toBeLessThan(b!.x);
    expect(b!.x + b!.w).toBeLessThan(c!.x);
    expect(Math.abs((cx(a1!) + cx(a2!)) / 2 - cx(a!))).toBeLessThan(0.5);
    expect(a1!.y).toBeGreaterThan(a!.y + a!.h);
    valid(elements);
    // The layout is saved on the root only.
    expect(normalizeForSave(elements).filter(el => (el as WhiteboardShape).mindLayout)).toHaveLength(1);
  });

  it('closes up when a branch is collapsed and reorders on a sideways drop', () => {
    const { elements, ids } = chart();
    const open = byId(elements, ids.b).x;
    const collapsed = setMindCollapsed(elements, ids.a, true);
    expect(byId(collapsed, ids.b).x).toBeLessThan(open);
    // Dropping a left of a1 among its siblings in the row puts it first.
    const index = indexElements(elements);
    const a2 = byId(elements, ids.a2), a1 = byId(elements, ids.a1);
    const drop = mindDropTarget(elements, index, ids.a2, { x: a1.x - 4, y: a1.y + a1.h + 30 })!;
    expect(drop).toMatchObject({ parentId: ids.a, beforeId: ids.a1, side: 'down' });
    const moved = moveMindNode(elements, ids.a2, drop);
    expect(byId(moved, ids.a2).x).toBeLessThan(byId(moved, ids.a1).x);
    expect(byId(moved, ids.a2).y).toBe(a2.y);
    // Dropping onto another node makes it the parent, still growing down.
    const onC = mindDropTarget(elements, index, ids.a1, { x: cx(byId(elements, ids.c)), y: byId(elements, ids.c).y + 5 })!;
    expect(onC).toMatchObject({ parentId: ids.c, side: 'down' });
    const reparented = moveMindNode(elements, ids.a1, onC);
    const c = byId(reparented, ids.c), a1Moved = byId(reparented, ids.a1);
    expect(a1Moved.mindParentId).toBe(ids.c);
    expect(a1Moved.y).toBeGreaterThan(c.y + c.h);
    expect(Math.abs(cx(a1Moved) - cx(c))).toBeLessThan(0.5);
    valid(reparented);
  });

  it('switches back to a sideways map', () => {
    const { elements, ids } = chart();
    const sideways = setMindLayout(elements, ids.root, 'right');
    expect(byId(sideways, ids.root).mindLayout).toBeUndefined();
    expect(byId(sideways, ids.a).x).toBeGreaterThan(byId(sideways, ids.root).x + byId(sideways, ids.root).w);
  });
});

describe('creation tools', () => {
  it('hand back to select after one shape, or keep going when locked', () => {
    const saves: El[][] = [];
    const store = new BoardStore([], false, next => saves.push(next));
    store.size = { width: 1000, height: 800 };
    const controller = new Controller(store, { measure, newId: uid, openPage: () => undefined, contextMenu: () => undefined, notice: () => undefined });
    const pointer = (x: number, y: number): PointerInput => ({ x, y, button: 0, pointerId: 1, pointerType: 'mouse', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
    const drag = (from: [number, number], to: [number, number]) => {
      controller.pointerDown(pointer(...from)); controller.pointerMove(pointer(...to)); controller.pointerUp(pointer(...to));
    };
    store.setTool('shape');
    drag([100, 100], [200, 200]);
    expect(store.tool).toBe('select');
    store.setTool('shape');
    drag([300, 100], [400, 200]);
    expect(store.elements).toHaveLength(2);
    store.setTool('shape', true);
    drag([100, 300], [200, 400]);
    drag([300, 300], [400, 400]);
    expect(store.tool).toBe('shape');
    expect(store.elements).toHaveLength(4);
    expect(saves).toHaveLength(4);
    controller.keyDown({ key: 'Escape', code: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false });
    expect([store.tool, store.toolLocked]).toEqual(['select', false]);
    // A press whose release never arrived does not block the next one.
    store.setTool('shape', true);
    controller.pointerDown(pointer(500, 500)); controller.pointerMove(pointer(600, 600));
    controller.pointerDown(pointer(700, 500)); controller.pointerMove(pointer(800, 600)); controller.pointerUp(pointer(800, 600));
    expect(store.elements).toHaveLength(6);
  });
});

describe('turning elements into strokes for the eraser', () => {
  it('redraws a shape as its outline, keeping its id, and its text as free text', () => {
    const shape: WhiteboardShape = { ...rect(0, 0, 200, 100), text: '标题', runs: [{ text: '标', bold: true }, { text: '题' }] };
    const strokes = elementToStrokes(shape, indexElements([shape]), uid, measure)!;
    expect(strokes[0]).toMatchObject({ id: shape.id, type: 'pen', x: 0, y: 0, w: 200, h: 100 });
    const label = strokes[1] as WhiteboardText;
    expect(label).toMatchObject({ type: 'text', text: '标题', runs: shape.runs });
    expect(label.x + label.w / 2).toBeCloseTo(100, 0);
    valid(strokes);
  });

  it('redraws a connector as a line with its arrowhead', () => {
    const connector = createConnector(uid(), { x: 0, y: 0 }, { x: 300, y: 0 }, { mode: 'straight' });
    const strokes = elementToStrokes(connector, indexElements([connector]), uid, measure)!;
    expect(strokes.map(el => el.type)).toEqual(['pen', 'pen']);
    expect(strokes[0]!.id).toBe(connector.id);
    valid(strokes);
  });

  it('erases part of a shape in one undoable step and explains it once', () => {
    const shape = rect(100, 100, 200, 100);
    const saves: El[][] = [];
    const notices: string[] = [];
    const store = new BoardStore([shape], false, next => saves.push(next));
    store.size = { width: 1000, height: 800 };
    const controller = new Controller(store, { measure, newId: uid, openPage: () => undefined, contextMenu: () => undefined, notice: text => notices.push(text) });
    const pointer = (x: number, y: number): PointerInput => ({ x, y, button: 0, pointerId: 1, pointerType: 'mouse', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
    const drag = (from: [number, number], to: [number, number]) => {
      controller.pointerDown(pointer(...from)); controller.pointerMove(pointer((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
      controller.pointerMove(pointer(...to)); controller.pointerUp(pointer(...to));
    };
    store.setTool('eraser');
    store.setStyle({ eraserMode: 'stroke' });
    // Through the middle of the filled box without reaching the outline: nothing happens.
    drag([180, 150], [220, 150]);
    expect(saves).toHaveLength(0);
    drag([200, 60], [200, 240]);
    expect(saves).toHaveLength(1);
    expect(store.elements.every(el => el.type === 'pen')).toBe(true);
    expect(store.elements.length).toBe(2);
    expect(notices).toHaveLength(1);
    valid(store.elements);
    drag([150, 60], [150, 240]);
    expect(notices).toHaveLength(1);
    store.undo(); store.undo();
    expect(store.elements).toEqual([shape]);
  });
});
