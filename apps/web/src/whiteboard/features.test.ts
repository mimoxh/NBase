import { describe, expect, it } from 'vitest';
import { whiteboardContent, whiteboardContentProblem, whiteboardLimits, type WhiteboardNote, type WhiteboardShape } from '@nbase/contracts';
import { clipboardImageSources, parseElements, serializeElements } from './clipboard';
import { Controller, type PointerInput } from './controller';
import { elbowPath } from './geometry';
import { addMindChild, createMindRoot, mindChildren, mindDropTarget, mindLayoutOf, moveMindNode, setMindCollapsed, setMindLayout } from './mind';
import { applyStyle, cloneElements, connectorPath, createConnector, createShape, dependentSet, erasePen, groupChain, groupToEnter, indexElements,
  locateElement, mindVisibility, movingSet, normalizeForSave, penPoints, setGroup, visibleElements, withGroups, type Connector, type El } from './model';
import { boardToSvg } from './render/export';
import { darkTheme } from './render/colors';
import { BoardStore } from './store';
import { approximateMeasure as measure } from './text';

let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const rect = (x: number, y: number, w = 100, h = 60) => createShape(uid(), { x, y, w, h });
const valid = (elements: readonly El[]) => expect(whiteboardContentProblem(whiteboardContent(normalizeForSave(elements)))).toBeNull();
const byId = (elements: readonly El[], id: string) => elements.find(el => el.id === id) as WhiteboardShape;

/** root → [one → [deep], two, three], laid out to the right of the root. */
function mindMap() {
  const root = createMindRoot(uid(), 200, 300, '中心', measure);
  const ids = { root: root.id, one: uid(), deep: uid(), two: uid(), three: uid() };
  let elements: El[] = [root];
  elements = addMindChild(elements, ids.root, ids.one, measure);
  elements = addMindChild(elements, ids.one, ids.deep, measure);
  elements = addMindChild(elements, ids.root, ids.two, measure);
  elements = addMindChild(elements, ids.root, ids.three, measure);
  return { elements, ids };
}

function setup(elements: El[] = [], readOnly = false) {
  const saves: El[][] = [];
  const notices: string[] = [];
  const store = new BoardStore(elements, readOnly, next => saves.push(next));
  store.size = { width: 1000, height: 800 };
  const controller = new Controller(store, { measure, newId: uid, openPage: () => undefined, contextMenu: () => undefined, notice: text => notices.push(text) });
  const pointer = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput =>
    ({ x, y, button: 0, pointerId: 1, pointerType: 'mouse', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });
  const click = (x: number, y: number) => { controller.pointerDown(pointer(x, y)); controller.pointerUp(pointer(x, y)); };
  const drag = (from: [number, number], to: [number, number]) => {
    controller.pointerDown(pointer(...from));
    controller.pointerMove(pointer((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
    controller.pointerMove(pointer(...to));
    controller.pointerUp(pointer(...to));
  };
  const key = (k: string, extra: Partial<Parameters<Controller['keyDown']>[0]> = {}) =>
    controller.keyDown({ key: k, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...extra });
  return { store, controller, saves, notices, click, drag, key };
}
const centre = (el: { x: number; y: number; w: number; h: number }): [number, number] => [el.x + el.w / 2, el.y + el.h / 2];

describe('nested groups', () => {
  it('stacks group levels, picks by level and takes one level away at a time', () => {
    const a = rect(0, 0), b = rect(200, 0), c = rect(400, 0), d = rect(600, 0);
    const inner = uid(), outer = uid();
    let elements = setGroup([a, b, c, d], new Set([a.id, b.id]), inner);
    elements = setGroup(elements, new Set([a.id, b.id, c.id]), outer);
    expect(groupChain(byId(elements, a.id))).toEqual([inner, outer]);
    expect(groupChain(byId(elements, c.id))).toEqual([outer]);
    valid(elements);
    expect([...withGroups(elements, new Set([a.id]))].sort()).toEqual([a.id, b.id, c.id].sort());
    expect([...withGroups(elements, new Set([a.id]), outer)].sort()).toEqual([a.id, b.id].sort());
    expect([...withGroups(elements, new Set([c.id]), outer)]).toEqual([c.id]);
    expect([...withGroups(elements, new Set([a.id]), inner)]).toEqual([a.id]);
    expect([groupToEnter(byId(elements, a.id), null), groupToEnter(byId(elements, a.id), outer), groupToEnter(byId(elements, a.id), inner)]).toEqual([outer, inner, null]);
    expect(groupToEnter(d, null)).toBeNull();
    // Moving follows the level that is picked.
    expect(movingSet(elements, new Set([a.id]), indexElements(elements), outer).has(c.id)).toBe(false);

    const flat = setGroup(elements, new Set([a.id, b.id, c.id]), null);
    expect(groupChain(byId(flat, a.id))).toEqual([inner]);
    expect(groupChain(byId(flat, c.id))).toEqual([]);
    // Inside the entered group the level below it is the one that goes.
    const opened = setGroup(elements, new Set([a.id, b.id]), null, outer);
    expect(groupChain(byId(opened, a.id))).toEqual([outer]);
    // A group made inside an entered group nests under it.
    const made = uid();
    const nested = setGroup(setGroup(elements, new Set([d.id]), outer), new Set([c.id, d.id]), made, outer);
    expect(groupChain(byId(nested, c.id))).toEqual([made, outer]);
    valid(nested);
  });

  it('copies keep their nesting under fresh ids, or stay in the group they were copied inside', () => {
    const a = rect(0, 0), b = rect(200, 0), c = rect(400, 0);
    const inner = uid(), outer = uid();
    const elements = setGroup(setGroup([a, b, c], new Set([a.id, b.id]), inner), new Set([a.id, b.id, c.id]), outer);
    const copies = cloneElements(elements, indexElements(elements), { x: 10, y: 10 }, uid);
    const [ca, cb, cc] = copies.map(groupChain);
    expect(ca).toEqual(cb);
    expect(ca![1]).toBe(cc![0]);
    expect([inner, outer]).not.toContain(ca![0]);
    expect([inner, outer]).not.toContain(ca![1]);
    const inside = cloneElements(elements.slice(0, 2), indexElements(elements), { x: 10, y: 10 }, uid, new Set([outer]));
    expect(groupChain(inside[0]!)[1]).toBe(outer);
    expect(groupChain(inside[0]!)[0]).not.toBe(inner);
    valid([...elements, ...copies, ...inside]);
  });

  it('rejects group chains the contract does not allow', () => {
    const a = rect(0, 0);
    const bad = (extra: object) => whiteboardContentProblem(whiteboardContent([{ ...a, ...extra } as El]));
    expect(bad({ groupParents: [uid()] })).not.toBeNull();
    const group = uid();
    expect(bad({ groupId: group, groupParents: [group] })).not.toBeNull();
    expect(bad({ groupId: group, groupParents: [] })).not.toBeNull();
    expect(bad({ groupId: group, groupParents: Array.from({ length: whiteboardLimits.maxGroupDepth }, uid) })).not.toBeNull();
    expect(bad({ groupId: group, groupParents: Array.from({ length: whiteboardLimits.maxGroupDepth - 1 }, uid) })).toBeNull();
  });
});

describe('mind maps', () => {
  it('folds a branch away and brings it back', () => {
    const { elements, ids } = mindMap();
    const connector = createConnector(uid(), { x: 0, y: 0, bind: { elementId: ids.deep, ax: 0.5, ay: 0.5 } }, { x: 900, y: 900 });
    const board = [...elements, connector];
    const folded = setMindCollapsed(board, ids.one, true);
    const visibility = mindVisibility(folded);
    expect([...visibility.hidden].sort()).toEqual([ids.deep, connector.id].sort());
    expect(visibility.counts.get(ids.one)).toBe(1);
    expect(visibleElements(folded).map(el => el.id)).not.toContain(ids.deep);
    valid(folded);
    // Leaves cannot fold, and folding twice changes nothing.
    expect(setMindCollapsed(folded, ids.two, true)).toBe(folded);
    expect(setMindCollapsed(folded, ids.one, true)).toBe(folded);
    const open = setMindCollapsed(folded, ids.one, false);
    expect(mindVisibility(open).hidden.size).toBe(0);
    expect(byId(open, ids.one).mindCollapsed).toBeUndefined();
    // A new child shows itself by opening its parent.
    const grown = addMindChild(folded, ids.one, uid(), measure);
    expect(byId(grown, ids.one).mindCollapsed).toBeUndefined();
    // The fold flag only belongs on mind nodes.
    expect(whiteboardContentProblem(whiteboardContent([{ ...rect(0, 0), mindCollapsed: true }]))).not.toBeNull();
  });

  it('lays branches out to the right, to the left or on both sides', () => {
    const { elements, ids } = mindMap();
    const root = byId(elements, ids.root);
    expect(mindLayoutOf(elements, ids.root)).toBe('right');
    expect(mindChildren(elements, ids.root).every(node => node.x > root.x + root.w)).toBe(true);

    const left = setMindLayout(elements, ids.root, 'left');
    expect(mindLayoutOf(left, ids.root)).toBe('left');
    expect(mindChildren(left, ids.root).every(node => node.x + node.w < root.x)).toBe(true);
    expect(byId(left, ids.deep).x + byId(left, ids.deep).w).toBeLessThan(byId(left, ids.one).x);
    expect(byId(left, ids.root).x).toBe(root.x);
    valid(left);

    const both = setMindLayout(elements, ids.root, 'both');
    expect(mindLayoutOf(both, ids.root)).toBe('both');
    expect(mindChildren(both, ids.root).map(node => node.mindSide ?? 'right')).toEqual(['right', 'right', 'left']);
    expect(byId(both, ids.three).x + byId(both, ids.three).w).toBeLessThan(root.x);
    valid(both);
    expect(mindLayoutOf(setMindLayout(both, ids.root, 'right'), ids.root)).toBe('right');
    // A side only means something directly under a root.
    expect(whiteboardContentProblem(whiteboardContent([{ ...byId(elements, ids.root), mindSide: 'left' }]))).not.toBeNull();
  });

  it('moves a branch to another parent, to another place among its siblings, or out of the map', () => {
    const { elements, ids } = mindMap();
    const adopted = moveMindNode(elements, ids.three, { parentId: ids.one, side: 'right' });
    expect(byId(adopted, ids.three).mindParentId).toBe(ids.one);
    expect(mindChildren(adopted, ids.one).map(node => node.id)).toEqual([ids.deep, ids.three]);
    expect(byId(adopted, ids.three).x).toBeGreaterThan(byId(adopted, ids.one).x + byId(adopted, ids.one).w);
    valid(adopted);
    // A node never moves under its own branch.
    expect(moveMindNode(elements, ids.one, { parentId: ids.deep, side: 'right' })).toBe(elements);

    const first = moveMindNode(elements, ids.three, { parentId: ids.root, beforeId: ids.one, side: 'right' });
    expect(mindChildren(first, ids.root).map(node => node.id)).toEqual([ids.three, ids.one, ids.two]);
    expect(byId(first, ids.three).y).toBeLessThan(byId(first, ids.one).y);
    // Back where it was: the same board, so nothing is saved.
    expect(moveMindNode(elements, ids.three, { parentId: ids.root, afterId: ids.two, side: 'right' })).toBe(elements);
    expect(moveMindNode(elements, ids.two, { parentId: ids.root, beforeId: ids.three, side: 'right' })).toBe(elements);

    const leftSide = moveMindNode(elements, ids.two, { parentId: ids.root, side: 'left' });
    expect(byId(leftSide, ids.two).mindSide).toBe('left');
    const detached = moveMindNode(leftSide, ids.two, { parentId: null, side: 'right' });
    expect(byId(detached, ids.two).mindParentId).toBeNull();
    expect(byId(detached, ids.two).mindSide).toBeUndefined();
    valid(detached);
  });

  it('reads a drop from where the pointer is', () => {
    const { elements, ids } = mindMap();
    const index = indexElements(elements);
    const one = byId(elements, ids.one), two = byId(elements, ids.two);
    expect(mindDropTarget(elements, index, ids.three, { x: one.x + 5, y: one.y + 5 })).toMatchObject({ parentId: ids.one });
    expect(mindDropTarget(elements, index, ids.three, { x: one.x + 5, y: one.y - 8 })).toMatchObject({ parentId: ids.root, beforeId: ids.one });
    expect(mindDropTarget(elements, index, ids.one, { x: two.x + 5, y: two.y + two.h + 7 })).toMatchObject({ parentId: ids.root, beforeId: ids.three });
    expect(mindDropTarget(elements, index, ids.three, { x: 5000, y: 5000 })).toMatchObject({ parentId: null });
    // Roots are moved, not re-attached, and a node cannot land on its own branch.
    expect(mindDropTarget(elements, index, ids.root, { x: one.x + 5, y: one.y + 5 })).toBeNull();
    const deep = byId(elements, ids.deep);
    expect(mindDropTarget(elements, index, ids.one, { x: deep.x + 5, y: deep.y + 5 })?.parentId).not.toBe(ids.deep);
  });

  it('copies a branch as a map of its own', () => {
    const { elements, ids } = mindMap();
    const index = indexElements(elements);
    expect([...dependentSet(elements, new Set([ids.one]), index)].sort()).toEqual([ids.one, ids.deep].sort());
    expect(movingSet(elements, new Set([ids.one]), index).size).toBe(5);
  });
});

describe('elbow connectors', () => {
  it('slides the middle segment within what the route allows', () => {
    const base = elbowPath({ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'left');
    expect(base.free).toMatchObject({ axis: 'x', shift: 0, from: { x: 100 } });
    const shifted = elbowPath({ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'left', 30);
    expect(shifted.free).toMatchObject({ shift: 30, from: { x: 130 } });
    expect(shifted.points.some(p => p.x === 130)).toBe(true);
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'left', 1000).free).toMatchObject({ shift: 80, from: { x: 180 } });
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'left', -1000).free!.from.x).toBe(20);
    // Same-facing ends: the segment stays beyond both of them.
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'right', -500).free!.from.x).toBe(220);
    // Corner routes and routes whose middle has no length offer nothing to drag.
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'top').free).toBeNull();
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 200, y: 0 }, 'left').free).toBeNull();
    for (const path of [base, shifted]) for (let i = 1; i < path.points.length; i += 1) {
      expect(path.points[i]!.x === path.points[i - 1]!.x || path.points[i]!.y === path.points[i - 1]!.y).toBe(true);
    }
  });

  it('keeps the shift only where it means something', () => {
    const a = rect(0, 0, 100, 100), b = rect(400, 200, 100, 100);
    const end = (id: string) => ({ x: 0, y: 0, bind: { elementId: id, ax: 0.5, ay: 0.5 } });
    const connector: Connector = { ...createConnector(uid(), end(a.id), end(b.id)), bend: 40 };
    const index = indexElements([a, b, connector]);
    expect(connectorPath(connector, index).bend).toMatchObject({ axis: 'x', shift: 40, point: { x: 290, y: 150 } });
    const saved = normalizeForSave([a, b, connector]);
    expect((saved[2] as Connector).bend).toBe(40);
    valid(saved);
    expect((normalizeForSave([a, b, { ...connector, mode: 'straight' }])[2] as Connector).bend).toBeUndefined();
    expect((normalizeForSave([a, b, { ...connector, bend: 0 }])[2] as Connector).bend).toBeUndefined();
    expect(whiteboardContentProblem(whiteboardContent([a, b, { ...connector, bend: Number.NaN }]))).not.toBeNull();
  });
});

describe('erasing part of a stroke', () => {
  const stroke = (): Extract<El, { type: 'pen' }> => ({ id: uid(), type: 'pen', x: 0, y: 100, w: 200, h: 0, angle: 0, points: [0, 0, 200, 0], color: '#1f2328', strokeWidth: 4 });

  it('cuts a stroke where the eraser crosses it and keeps the rest', () => {
    const pen = stroke();
    const pieces = erasePen(pen, [{ x: 100, y: 60 }, { x: 100, y: 140 }], 6, uid)!;
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.id).toBe(pen.id);
    expect(pieces[1]!.id).not.toBe(pen.id);
    const xs = pieces.map(piece => penPoints(piece).map(p => p.x));
    expect(Math.max(...xs[0]!)).toBeLessThan(93);
    expect(Math.min(...xs[1]!)).toBeGreaterThan(107);
    expect(Math.min(...xs[0]!)).toBe(0);
    expect(Math.max(...xs[1]!)).toBe(200);
    valid(pieces);
  });

  it('leaves untouched strokes alone and removes strokes that are rubbed out entirely', () => {
    const pen = stroke();
    expect(erasePen(pen, [{ x: 100, y: 0 }, { x: 150, y: 20 }], 6, uid)).toBeNull();
    expect(erasePen(pen, [{ x: -10, y: 100 }, { x: 210, y: 100 }], 6, uid)).toEqual([]);
    // Trimming an end leaves one piece that keeps the id.
    const trimmed = erasePen(pen, [{ x: 190, y: 90 }, { x: 205, y: 110 }], 6, uid)!;
    expect(trimmed.map(piece => piece.id)).toEqual([pen.id]);
    expect(trimmed[0]!.w).toBeLessThan(190);
  });
});

describe('text weight and finding elements', () => {
  it('sets and clears bold on shapes, notes and free text', () => {
    const shape = rect(0, 0);
    const note: WhiteboardNote = { id: uid(), type: 'note', x: 0, y: 200, w: 200, h: 100, angle: 0, text: '便签', color: '#fff3b0', fontSize: 16, textAlign: 'left' };
    const ids = new Set([shape.id, note.id]);
    const bold = applyStyle([shape, note], ids, { bold: true });
    expect(bold.map(el => (el as WhiteboardNote).bold)).toEqual([true, true]);
    valid(bold);
    expect(applyStyle(bold, ids, { bold: true })).toBe(bold);
    const plain = applyStyle(bold, ids, { bold: false });
    expect(plain.every(el => !('bold' in el))).toBe(true);
    expect(applyStyle([shape, note], ids, { bold: false })[0]).toBe(shape);
  });

  it('finds the element behind a search hit or a backlink', () => {
    const page = uid(), other = uid();
    const card = (pageId: string): El => ({ id: uid(), type: 'card', x: 0, y: 0, w: 200, h: 60, angle: 0, pageId, label: '卡片' });
    const titled = { ...rect(0, 0), text: '季度  目标\nOKR' };
    const first = card(other), second = card(page), third = card(page);
    const elements: El[] = [rect(0, 0), titled, first, second, third];
    expect(locateElement(elements, { text: '目标 okr' })).toEqual({ id: titled.id, exact: true });
    expect(locateElement(elements, { text: '不存在' })).toBeNull();
    expect(locateElement(elements, { text: '  ' })).toBeNull();
    expect(locateElement(elements, { reference: { pageId: page.toUpperCase(), occurrence: 2 } })).toEqual({ id: third.id, exact: true });
    // The board changed since the backlink was indexed: fall back to the first card for the page.
    expect(locateElement(elements, { reference: { pageId: page, occurrence: 0 } })).toEqual({ id: second.id, exact: false });
    expect(locateElement(elements, { reference: { pageId: uid(), occurrence: 0 } })).toBeNull();
  });
});

describe('export', () => {
  it('leaves folded branches out, marks how much is hidden and can use the dark paper', () => {
    const { elements, ids } = mindMap();
    const named = elements.map(el => el.id === ids.deep ? { ...el, text: '藏起来' } as El : el.id === ids.two ? { ...el, text: '看得见', bold: true } as El : el);
    const folded = setMindCollapsed(named, ids.one, true);
    const options = { measure, pageInfo: () => null };
    const svg = boardToSvg(folded, new Map(), options);
    expect(svg).not.toContain('藏起来');
    expect(svg).toContain('看得见');
    expect(svg).toContain('font-weight="600"');
    expect(svg).toContain('<circle');
    expect(boardToSvg(named, new Map(), options)).toContain('藏起来');
    expect(boardToSvg(named, new Map(), options)).not.toContain('<circle');
    expect(boardToSvg(named, new Map(), { ...options, theme: darkTheme })).toContain(`fill="${darkTheme.canvas}"`);
  });
});

describe('clipboard images', () => {
  it('remembers where copied images live and trusts only this site', () => {
    const attachment = uid(), workspace = uid();
    const image: El = { id: uid(), type: 'image', x: 0, y: 0, w: 100, h: 80, angle: 0, attachmentId: attachment, fileName: '图.png', mediaType: 'image/png' };
    const path = `/api/workspaces/${workspace}/attachments/${attachment}/content`;
    const payload = serializeElements([image], uid, () => path);
    expect(parseElements(payload)).toHaveLength(1);
    expect([...clipboardImageSources(payload, 'http://127.0.0.1:5173')]).toEqual([[attachment, path]]);
    const forged = (url: string) => clipboardImageSources(JSON.stringify({ nbaseWhiteboard: 1, elements: [], images: { [attachment]: url } }), 'http://127.0.0.1:5173');
    expect(forged('https://evil.example/x.png').size).toBe(0);
    expect(forged('/api/session').size).toBe(0);
    expect(forged(`${path}?x=1`).size).toBe(0);
    expect(forged('javascript:alert(1)').size).toBe(0);
    expect(forged(`http://127.0.0.1:5173${path}`).get(attachment)).toBe(path);
    expect(forged('blob:http://127.0.0.1:5173/abc').size).toBe(1);
    expect(forged('blob:https://evil.example/abc').size).toBe(0);
    expect(clipboardImageSources('plain text', 'http://127.0.0.1:5173').size).toBe(0);
    expect(serializeElements([rect(0, 0)], uid, () => path)).not.toContain('images');
  });
});

describe('controller', () => {
  it('groups groups, steps into them on double-click and back out with Escape', () => {
    const a = rect(0, 0), b = rect(200, 0), c = rect(400, 0);
    const { store, controller, saves, click, drag, key, notices } = setup([a, b, c]);
    store.select([a.id, b.id]); key('g', { ctrlKey: true });
    store.select([a.id, b.id, c.id]);
    expect(controller.groupState()).toEqual({ canGroup: true, canUngroup: true });
    key('g', { ctrlKey: true });
    expect(saves).toHaveLength(2);
    expect(groupChain(store.index.get(a.id)!)).toHaveLength(2);
    // One group cannot be grouped with itself.
    expect(controller.groupState().canGroup).toBe(false);
    key('g', { ctrlKey: true });
    expect(saves).toHaveLength(2);

    store.select([]);
    click(...centre(a));
    expect(store.selection.size).toBe(3);
    controller.doubleClick({ x: 50, y: 30 });
    expect([...store.selection].sort()).toEqual([a.id, b.id].sort());
    expect(store.overlay.focus).not.toBeNull();
    click(...centre(c));
    expect([...store.selection]).toEqual([c.id]);
    controller.doubleClick({ x: 50, y: 30 });
    expect([...store.selection]).toEqual([a.id]);
    expect(store.editingId).toBeNull();
    // Inside the group only the picked member moves.
    drag(centre(a), [50, 230]);
    expect([byId(store.elements, a.id).y, byId(store.elements, b.id).y]).toEqual([200, 0]);
    expect(key('Escape')).toBe(true);
    expect([...store.selection].sort()).toEqual([a.id, b.id].sort());
    key('Escape');
    expect(store.selection.size).toBe(3);
    expect(store.focusGroup).toBeNull();
    key('Escape');
    expect(store.selection.size).toBe(0);
    // Clicking outside an entered group leaves it too.
    controller.doubleClick({ x: 250, y: 30 });
    expect(store.focusGroup).not.toBeNull();
    click(800, 600);
    expect(store.focusGroup).toBeNull();

    store.select([a.id, b.id, c.id]);
    key('g', { ctrlKey: true, shiftKey: true });
    expect(groupChain(store.index.get(a.id)!)).toHaveLength(1);
    expect(groupChain(store.index.get(c.id)!)).toHaveLength(0);
    expect(notices).toEqual([]);
    valid(store.elements);
  });

  it('refuses to nest groups deeper than the limit', () => {
    const a = rect(0, 0), b = rect(200, 0);
    const { store, saves, key, notices } = setup([a, b]);
    for (let depth = 0; depth < whiteboardLimits.maxGroupDepth; depth += 1) {
      store.select(depth ? [a.id, b.id] : [a.id]);
      if (!depth) store.select([a.id, b.id]);
      // Each round needs a second unit to group with.
      const extra = rect(400 + depth * 10, 0);
      store.commit([...store.elements, extra]);
      store.select([a.id, b.id, extra.id]);
      key('g', { ctrlKey: true });
    }
    const before = saves.length;
    const extra = rect(900, 0);
    store.commit([...store.elements, extra]);
    store.select([a.id, b.id, extra.id]);
    key('g', { ctrlKey: true });
    expect(saves).toHaveLength(before + 1);
    expect(notices).toHaveLength(1);
    expect(groupChain(store.index.get(a.id)!)).toHaveLength(whiteboardLimits.maxGroupDepth);
    valid(store.elements);
  });

  it('folds mind branches, hides them from picking and lets readers fold without saving', () => {
    const { elements, ids } = mindMap();
    const { store, controller, saves, click, key } = setup(elements);
    const deep = byId(elements, ids.deep);
    click(...centre(deep));
    expect(store.selection.has(ids.deep)).toBe(true);
    controller.toggleCollapsed(ids.one);
    expect(saves).toHaveLength(1);
    expect(store.selection.size).toBe(0);
    expect(mindVisibility(store.elements).hidden.has(ids.deep)).toBe(true);
    // Where the hidden node was, there is nothing to pick; select-all skips it as well.
    click(...centre(deep));
    expect(store.selection.size).toBe(0);
    key('a', { ctrlKey: true });
    expect(store.selection.has(ids.deep)).toBe(false);
    expect(store.selection.size).toBe(4);
    // The count chip beside the node unfolds it.
    const one = byId(store.elements, ids.one);
    click(one.x + one.w + 12, one.y + one.h / 2);
    expect(mindVisibility(store.elements).hidden.size).toBe(0);
    expect(saves).toHaveLength(2);
    key('z', { ctrlKey: true });
    expect(byId(store.elements, ids.one).mindCollapsed).toBe(true);
    valid(store.elements);

    const reader = setup(elements, true);
    reader.controller.toggleCollapsed(ids.one);
    expect(mindVisibility(reader.store.elements).hidden.has(ids.deep)).toBe(true);
    expect(reader.saves).toHaveLength(0);
  });

  it('re-attaches, reorders and detaches a mind branch by dragging it', () => {
    const { elements, ids } = mindMap();
    const { store, saves, drag, key } = setup(elements);
    const at = (id: string) => centre(byId(store.elements, id));
    drag(at(ids.three), at(ids.one));
    expect(byId(store.elements, ids.three).mindParentId).toBe(ids.one);
    expect(saves).toHaveLength(1);
    valid(store.elements);
    key('z', { ctrlKey: true });
    expect(byId(store.elements, ids.three).mindParentId).toBe(ids.root);

    const one = byId(store.elements, ids.one);
    drag(at(ids.three), [one.x + 10, one.y - 8]);
    expect(mindChildren(store.elements, ids.root).map(node => node.id)).toEqual([ids.three, ids.one, ids.two]);
    // Dropped back in its own place: no save, nothing moved.
    const before = saves.length, snapshot = store.elements;
    const three = byId(store.elements, ids.three);
    drag(at(ids.three), [three.x + 10, three.y - 6]);
    expect(saves).toHaveLength(before);
    expect(store.elements).toBe(snapshot);

    drag(at(ids.two), [700, 700]);
    const detached = byId(store.elements, ids.two);
    expect(detached.mindParentId).toBeNull();
    expect(Math.abs(detached.x + detached.w / 2 - 700)).toBeLessThan(1);
    // The root still drags the whole map.
    const rootBefore = byId(store.elements, ids.root), oneBefore = byId(store.elements, ids.one);
    drag(at(ids.root), [rootBefore.x + rootBefore.w / 2 + 40, rootBefore.y + rootBefore.h / 2]);
    expect(byId(store.elements, ids.one).x).toBe(oneBefore.x + 40);
    valid(store.elements);
  });

  it('duplicates a branch as its own map and switches the layout side', () => {
    const { elements, ids } = mindMap();
    const { store, controller, key } = setup(elements);
    store.select([ids.one]);
    expect(controller.mindInfo()).toMatchObject({ rootId: ids.root, layout: 'right', hasChildren: true, collapsed: false });
    key('d', { ctrlKey: true });
    expect(store.elements).toHaveLength(7);
    const copies = store.elements.slice(5) as WhiteboardShape[];
    expect(copies[0]!.mindParentId).toBeNull();
    expect(copies[1]!.mindParentId).toBe(copies[0]!.id);
    store.select([ids.two]);
    controller.setMindLayout('left');
    expect(byId(store.elements, ids.two).x).toBeLessThan(byId(store.elements, ids.root).x);
    valid(store.elements);
  });

  it('drags the bend handle of an elbow connector and puts it back', () => {
    const a = rect(0, 0, 100, 100), b = rect(400, 200, 100, 100);
    const { store, controller, saves, drag } = setup([a, b]);
    store.setTool('connector');
    drag([50, 50], [450, 250]);
    const connector = () => store.elements.find(el => el.type === 'connector') as Connector;
    const handle = connectorPath(connector(), store.index).bend!;
    expect(handle.axis).toBe('x');
    expect(store.overlay.bend).toEqual(handle.point);
    drag([handle.point.x, handle.point.y], [handle.point.x + 50, handle.point.y + 30]);
    expect(connector().bend).toBe(50);
    expect(saves).toHaveLength(2);
    expect(connectorPath(connector(), store.index).points.some(p => p.x === handle.point.x + 50)).toBe(true);
    valid(store.elements);
    // The segment stops where the route would fold back on itself.
    const moved = connectorPath(connector(), store.index).bend!.point;
    drag([moved.x, moved.y], [moved.x + 900, moved.y]);
    expect(connector().bend).toBe(130);
    controller.resetBend();
    expect(connector().bend).toBeUndefined();
    // A tiny nudge snaps back to the default route and saves nothing.
    const before = saves.length;
    drag([handle.point.x, handle.point.y], [handle.point.x + 2, handle.point.y]);
    expect(connector().bend).toBeUndefined();
    expect(saves).toHaveLength(before);
  });

  it('rubs out part of a stroke without touching shapes, or whole elements in the other mode', () => {
    const shape = rect(150, 300, 100, 60);
    const { store, saves, drag } = setup([shape]);
    store.setTool('pen');
    drag([100, 100], [300, 100]);
    expect(store.elements.filter(el => el.type === 'pen')).toHaveLength(1);
    store.setTool('eraser');
    store.setStyle({ eraserMode: 'stroke' });
    drag([200, 60], [200, 400]);
    const pens = store.elements.filter(el => el.type === 'pen');
    expect(pens).toHaveLength(2);
    expect(store.elements.some(el => el.id === shape.id)).toBe(true);
    expect(saves).toHaveLength(2);
    valid(store.elements);
    // Passing over nothing saves nothing.
    drag([600, 600], [700, 700]);
    expect(saves).toHaveLength(2);
    store.setStyle({ eraserMode: 'element' });
    drag([120, 80], [120, 120]);
    expect(store.elements.filter(el => el.type === 'pen')).toHaveLength(1);
    drag([200, 280], [200, 380]);
    expect(store.elements.some(el => el.id === shape.id)).toBe(false);
  });

  it('brings a located element into view, unfolding what hides it, without saving', () => {
    const { elements, ids } = mindMap();
    const { store, controller, saves } = setup(setMindCollapsed(elements, ids.one, true));
    expect(controller.locate(uid())).toBe(false);
    expect(controller.locate(ids.deep)).toBe(true);
    expect([...store.selection]).toEqual([ids.deep]);
    expect(mindVisibility(store.elements).hidden.size).toBe(0);
    expect(saves).toHaveLength(0);
    const deep = byId(store.elements, ids.deep);
    const centreX = store.view.x + store.size.width / 2 / store.view.zoom;
    expect(Math.abs(centreX - (deep.x + deep.w / 2))).toBeLessThan(1);
    expect(store.view.zoom).toBeLessThanOrEqual(1);
  });
});
