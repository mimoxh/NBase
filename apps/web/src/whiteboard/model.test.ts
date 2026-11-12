import { describe, expect, it } from 'vitest';
import { whiteboardContent, whiteboardContentProblem, type WhiteboardNote, type WhiteboardShape } from '@nbase/contracts';
import { elbowRoute, exitPoint, outlinePolygon, rotatePoint, simplifyStroke, snapRect } from './geometry';
import { History } from './history';
import { addMindChild, createMindRoot, fitMindNode, layoutMind } from './mind';
import { align, applyStyle, cloneElements, connectorPath, createConnector, createShape, distribute, elementAt, elementBounds, fitText,
  frameChildren, hitTest, indexElements, movingSet, normalizeForSave, removeElements, reorder, resizeBox, rotateElements, scaleElements,
  setGroup, translate, withGroups, type Connector, type El } from './model';
import { approximateMeasure as measure, wrapText } from './text';

let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const rect = (x: number, y: number, w = 100, h = 60, extra: Partial<WhiteboardShape> = {}) => ({ ...createShape(uid(), { x, y, w, h }), ...extra });
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01);

describe('geometry', () => {
  it('clips a ray to shape outlines', () => {
    const box = { x: 0, y: 0, w: 100, h: 100, angle: 0 };
    const hit = exitPoint({ x: 50, y: 50 }, { x: 300, y: 50 }, outlinePolygon('rect', box));
    expect(hit).toEqual({ x: 100, y: 50 });
    const diamond = exitPoint({ x: 50, y: 50 }, { x: 300, y: 300 }, outlinePolygon('diamond', box));
    close(diamond.x, 75); close(diamond.y, 75);
    const ellipse = exitPoint({ x: 50, y: 50 }, { x: 50, y: -300 }, outlinePolygon('ellipse', box));
    close(ellipse.y, 0);
  });

  it('routes orthogonal connectors with axis-aligned segments only', () => {
    for (const [from, fromSide, to, toSide] of [
      [{ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'left'], [{ x: 0, y: 0 }, 'right', { x: -200, y: 120 }, 'left'],
      [{ x: 0, y: 0 }, 'bottom', { x: 200, y: 120 }, 'left'], [{ x: 0, y: 0 }, 'top', { x: 200, y: 120 }, 'top'],
      [{ x: 0, y: 0 }, 'left', { x: 50, y: -90 }, 'bottom'],
    ] as const) {
      const route = elbowRoute(from, fromSide, to, toSide);
      expect(route[0]).toEqual(from); expect(route.at(-1)).toEqual(to);
      for (let i = 1; i < route.length; i += 1) {
        expect(Math.abs(route[i]!.x - route[i - 1]!.x) < 0.01 || Math.abs(route[i]!.y - route[i - 1]!.y) < 0.01).toBe(true);
      }
    }
  });

  it('simplifies strokes and snaps rectangles to neighbours', () => {
    const line = Array.from({ length: 50 }, (_, i) => [i, i * 2]).flat();
    expect(simplifyStroke(line, 0.5)).toEqual([0, 0, 49, 98]);
    expect(simplifyStroke([0, 0, 10, 10, 20, 0], 0.5)).toHaveLength(6);
    const snap = snapRect({ x: 103, y: 300, w: 50, h: 50 }, [{ x: 100, y: 0, w: 80, h: 40 }], 5);
    expect(snap.dx).toBe(-3); expect(snap.dy).toBe(0);
    expect(snap.guides[0]).toMatchObject({ axis: 'x', position: 100, from: 0, to: 350 });
    expect(snapRect({ x: 130, y: 300, w: 20, h: 50 }, [{ x: 100, y: 0, w: 80, h: 40 }], 5).guides).toHaveLength(1);
  });
});

describe('text', () => {
  it('wraps mixed Chinese and Latin text and breaks long words', () => {
    expect(wrapText('中文自动换行测试', 64, 16, false, measure)).toEqual(['中文自动', '换行测试']);
    expect(wrapText('hello world again', 60, 16, false, measure)).toEqual(['hello', 'world', 'again']);
    expect(wrapText('a\n\nb', 100, 16, false, measure)).toEqual(['a', '', 'b']);
    expect(wrapText('abcdefghijklmnop', 40, 16, false, measure).every(line => measure(line, 16, false) <= 40)).toBe(true);
  });

  it('grows notes and shapes with their text but lets free text shrink', () => {
    const note: WhiteboardNote = { id: uid(), type: 'note', x: 0, y: 0, w: 160, h: 80, angle: 0, text: '长'.repeat(80), color: '#fff3b0', fontSize: 16, textAlign: 'left' };
    expect(fitText(note, measure).h).toBeGreaterThan(80);
    expect(fitText({ ...note, text: '短' }, measure).h).toBe(80);
    const text = fitText({ id: uid(), type: 'text', x: 0, y: 0, w: 10, h: 10, angle: 0, text: '你好世界', color: '#000000', fontSize: 20, textAlign: 'left' }, measure, true);
    expect(text.w).toBeGreaterThanOrEqual(80); expect(text.h).toBe(28);
  });
});

describe('connectors', () => {
  it('follow bound elements and clip to their outlines', () => {
    const a = rect(0, 0), b = rect(300, 0);
    const line = createConnector(uid(), { x: 0, y: 0, bind: { elementId: a.id, ax: 0.5, ay: 0.5 } }, { x: 0, y: 0, bind: { elementId: b.id, ax: 0.5, ay: 0.5 } }, { mode: 'straight' });
    let elements: El[] = [a, b, line];
    let path = connectorPath(line, indexElements(elements));
    expect(path.points).toEqual([{ x: 100, y: 30 }, { x: 300, y: 30 }]);
    elements = translate(elements, new Set([b.id]), 0, 200);
    path = connectorPath(line, indexElements(elements));
    // Centre-to-centre line enters b through its top edge.
    close(path.points.at(-1)!.x, 305); close(path.points.at(-1)!.y, 200);
    // Resizing the target moves the end too.
    elements = elements.map(el => el.id === b.id ? { ...b, x: 400, y: 0, w: 200, h: 60 } : el);
    expect(connectorPath(line, indexElements(elements)).points.at(-1)).toEqual({ x: 400, y: 30 });
  });

  it('use explicit side anchors and face the other end otherwise', () => {
    const a = rect(0, 0), b = rect(300, 200);
    const fixed = createConnector(uid(), { x: 0, y: 0, bind: { elementId: a.id, ax: 0.5, ay: 1 } }, { x: 0, y: 0, bind: { elementId: b.id, ax: 0, ay: 0.5 } }, { mode: 'elbow' });
    const path = connectorPath(fixed, indexElements([a, b, fixed]));
    expect(path.points[0]).toEqual({ x: 50, y: 60 }); expect(path.points.at(-1)).toEqual({ x: 300, y: 230 });
    expect(path.endDirection).toEqual({ x: 1, y: 0 });
    const auto = createConnector(uid(), { x: 0, y: 0, bind: { elementId: a.id, ax: 0.5, ay: 0.5 } }, { x: 500, y: 30 }, { mode: 'curve' });
    const curved = connectorPath(auto, indexElements([a, auto]));
    expect(curved.curve?.[0]).toEqual({ x: 100, y: 30 });
    expect(elementBounds(auto, indexElements([a, auto])).w).toBeGreaterThan(400);
  });

  it('detach from deleted targets and survive normalisation', () => {
    const a = rect(0, 0), b = rect(300, 0);
    const line = createConnector(uid(), { x: 0, y: 0, bind: { elementId: a.id, ax: 0.5, ay: 0.5 } }, { x: 0, y: 0, bind: { elementId: b.id, ax: 0.5, ay: 0.5 } }, { mode: 'straight' });
    const elements: El[] = [a, b, line];
    const after = removeElements(elements, new Set([b.id]), indexElements(elements));
    const kept = after.find(el => el.id === line.id) as Connector;
    expect(kept.target).toEqual({ x: 300, y: 30 }); expect(kept.source.bind?.elementId).toBe(a.id);
    const saved = normalizeForSave(elements);
    expect((saved[2] as Connector).source).toEqual({ x: 100, y: 30, bind: { elementId: a.id, ax: 0.5, ay: 0.5 } });
    expect(whiteboardContentProblem(whiteboardContent(saved))).toBeNull();
    expect(whiteboardContentProblem(whiteboardContent(normalizeForSave(after)))).toBeNull();
  });
});

describe('editing operations', () => {
  it('resizes rotated boxes while the opposite corner stays put', () => {
    const box = { x: 0, y: 0, w: 100, h: 50, angle: Math.PI / 6 };
    const fixedBefore = rotatePoint({ x: 0, y: 0 }, { x: 50, y: 25 }, box.angle);
    const next = resizeBox(box, 'se', rotatePoint({ x: 180, y: 90 }, { x: 50, y: 25 }, box.angle));
    close(next.w, 180); close(next.h, 90);
    const fixedAfter = rotatePoint({ x: next.x, y: next.y }, { x: next.x + next.w / 2, y: next.y + next.h / 2 }, next.angle);
    close(fixedAfter.x, fixedBefore.x); close(fixedAfter.y, fixedBefore.y);
    const ratio = resizeBox({ x: 0, y: 0, w: 100, h: 50, angle: 0 }, 'se', { x: 300, y: 60 }, true);
    close(ratio.w / ratio.h, 2);
    const edge = resizeBox({ x: 0, y: 0, w: 100, h: 50, angle: 0 }, 'w', { x: -20, y: 999 });
    expect(edge).toEqual({ x: -20, y: 0, w: 120, h: 50, angle: 0 });
    expect(resizeBox({ x: 0, y: 0, w: 100, h: 50, angle: 0 }, 'e', { x: -500, y: 0 }).w).toBe(8);
    const centered = resizeBox({ x: 0, y: 0, w: 100, h: 50, angle: 0 }, 'e', { x: 120, y: 0 }, false, true);
    expect([centered.x, centered.w]).toEqual([-20, 140]);
  });

  it('scales and rotates multi-selections, including pen strokes', () => {
    const a = rect(0, 0, 100, 100), b = rect(100, 100, 100, 100);
    const pen: El = { id: uid(), type: 'pen', x: 0, y: 0, w: 10, h: 10, angle: 0, points: [0, 0, 10, 10], color: '#000000', strokeWidth: 2 };
    const ids = new Set([a.id, b.id, pen.id]);
    const scaled = scaleElements([a, b, pen], ids, { x: 0, y: 0, w: 200, h: 200 }, { x: 0, y: 0, w: 400, h: 100 });
    expect(scaled[1]).toMatchObject({ x: 200, y: 50, w: 200, h: 50 });
    expect((scaled[2] as typeof pen & { points: number[] }).points).toEqual([0, 0, 20, 5]);
    const turned = rotateElements([a, b], new Set([a.id, b.id]), { x: 100, y: 100 }, Math.PI / 2);
    expect(turned[0]).toMatchObject({ x: 100, y: 0 }); close((turned[0] as WhiteboardShape).angle, Math.PI / 2);
  });

  it('hit-tests by outline, fill and frame border', () => {
    const hollow = rect(0, 0, 100, 100, { fill: 'transparent' });
    const index = indexElements([hollow]);
    expect(hitTest(hollow, { x: 50, y: 50 }, 4, index)).toBe(false);
    expect(hitTest(hollow, { x: 1, y: 50 }, 4, index)).toBe(true);
    expect(hitTest({ ...hollow, fill: '#ffffff', shape: 'ellipse' }, { x: 4, y: 4 }, 2, index)).toBe(false);
    expect(hitTest({ ...hollow, fill: '#ffffff', shape: 'ellipse' }, { x: 50, y: 50 }, 2, index)).toBe(true);
    const frame: El = { id: uid(), type: 'frame', x: 0, y: 0, w: 400, h: 300, angle: 0, name: '页' };
    expect(hitTest(frame, { x: 200, y: 150 }, 4, index)).toBe(false);
    expect(hitTest(frame, { x: 2, y: 150 }, 4, index)).toBe(true);
    const top = rect(0, 0), below = rect(0, 0);
    expect(elementAt([below, top], { x: 10, y: 10 }, 2, indexElements([below, top]))?.id).toBe(top.id);
  });

  it('moves groups, frame contents and whole mind maps together', () => {
    const frame: El = { id: uid(), type: 'frame', x: 0, y: 0, w: 400, h: 300, angle: 0, name: '页' };
    const inside = rect(50, 50), outside = rect(900, 50), partner = rect(900, 300);
    const grouped = setGroup([frame, inside, outside, partner], new Set([outside.id, partner.id]), uid());
    const index = indexElements(grouped);
    expect(frameChildren(grouped, frame, index)).toEqual([inside.id]);
    expect([...movingSet(grouped, new Set([frame.id]), index)].sort()).toEqual([frame.id, inside.id].sort());
    expect(withGroups(grouped, new Set([outside.id])).has(partner.id)).toBe(true);
    expect(setGroup(grouped, new Set([outside.id, partner.id]), null).every(el => el.groupId === undefined)).toBe(true);
  });

  it('duplicates with fresh ids and remapped references', () => {
    const a = rect(0, 0), b = rect(300, 0);
    const line = createConnector(uid(), { x: 0, y: 0, bind: { elementId: a.id, ax: 0.5, ay: 0.5 } }, { x: 0, y: 0, bind: { elementId: b.id, ax: 0.5, ay: 0.5 } }, { mode: 'straight' });
    const all = setGroup([a, b, line], new Set([a.id, line.id]), uid());
    const copies = cloneElements([all[0]!, all[2]!], indexElements(all), { x: 20, y: 20 }, uid);
    const [copyA, copyLine] = copies as [WhiteboardShape, Connector];
    expect(copyA.id).not.toBe(a.id); expect(copyA.x).toBe(20);
    expect(copyLine.source.bind?.elementId).toBe(copyA.id);
    expect(copyLine.target).toEqual({ x: 320, y: 50 });
    expect(copyA.groupId).toBe(copyLine.groupId); expect(copyA.groupId).not.toBe(all[0]!.groupId);
    expect(whiteboardContentProblem(whiteboardContent(normalizeForSave([...all, ...copies])))).toBeNull();
  });

  it('reorders, aligns, distributes and styles', () => {
    const a = rect(0, 0, 50, 50), b = rect(100, 30, 50, 50), c = rect(400, 90, 50, 50);
    const order = (list: El[]) => list.map(el => el.id);
    expect(order(reorder([a, b, c], new Set([a.id]), 'front'))).toEqual([b.id, c.id, a.id]);
    expect(order(reorder([a, b, c], new Set([a.id]), 'forward'))).toEqual([b.id, a.id, c.id]);
    expect(order(reorder([a, b, c], new Set([c.id]), 'backward'))).toEqual([a.id, c.id, b.id]);
    expect(order(reorder([a, b, c], new Set([c.id]), 'back'))).toEqual([c.id, a.id, b.id]);
    const ids = new Set([a.id, b.id, c.id]);
    const index = indexElements([a, b, c]);
    expect(align([a, b, c], ids, 'top', index).map(el => (el as WhiteboardShape).y)).toEqual([0, 0, 0]);
    expect(align([a, b, c], ids, 'right', index).map(el => (el as WhiteboardShape).x)).toEqual([400, 400, 400]);
    expect(distribute([a, b, c], ids, 'x', index).map(el => (el as WhiteboardShape).x)).toEqual([0, 200, 400]);
    const styled = applyStyle([a], new Set([a.id]), { fill: '#ffe3e3', noteColor: '#000000', strokeWidth: 4 });
    expect(styled[0]).toMatchObject({ fill: '#ffe3e3', strokeWidth: 4 });
    expect(applyStyle(styled, new Set([a.id]), { fill: '#ffe3e3' })).toBe(styled);
  });
});

describe('mind maps', () => {
  it('lays children out to the right, keeps sibling order and deletes subtrees', () => {
    const root = createMindRoot(uid(), 0, 0, '中心主题', measure);
    let elements: El[] = [root];
    const first = uid(), second = uid(), grandchild = uid(), between = uid();
    elements = addMindChild(elements, root.id, first, measure);
    elements = addMindChild(elements, root.id, second, measure);
    elements = addMindChild(elements, first, grandchild, measure);
    elements = addMindChild(elements, root.id, between, measure, first);
    const get = (id: string) => elements.find(el => el.id === id) as WhiteboardShape;
    expect(get(first).x).toBeGreaterThan(root.x + root.w);
    expect(get(grandchild).x).toBeGreaterThan(get(first).x + get(first).w);
    expect(get(first).y).toBeLessThan(get(between).y); expect(get(between).y).toBeLessThan(get(second).y);
    close(get(grandchild).y + get(grandchild).h / 2, get(first).y + get(first).h / 2);
    expect(whiteboardContentProblem(whiteboardContent(normalizeForSave(elements)))).toBeNull();
    const moving = movingSet(elements, new Set([grandchild]), indexElements(elements));
    expect(moving.size).toBe(5);
    const grown = elements.map(el => el.id === between ? fitMindNode({ ...get(between), text: '很长的分支标题内容\n第二行\n第三行' }, measure) : el);
    const relaid = layoutMind(grown, root.id);
    expect((relaid.find(el => el.id === second) as WhiteboardShape).y).toBeGreaterThan(get(second).y);
    const pruned = removeElements(elements, new Set([first]), indexElements(elements));
    expect(pruned.map(el => el.id).sort()).toEqual([root.id, second, between].sort());
  });
});

describe('history', () => {
  it('undoes and redoes snapshots and drops redo on a new change', () => {
    const history = new History<number>(3);
    history.push(1); history.push(2);
    expect(history.undo(3)).toBe(2); expect(history.undo(2)).toBe(1); expect(history.undo(1)).toBeNull();
    expect(history.redo(1)).toBe(2);
    history.push(2);
    expect(history.canRedo).toBe(false);
    for (const value of [5, 6, 7, 8]) history.push(value);
    expect([history.undo(9), history.undo(8), history.undo(7), history.undo(6)]).toEqual([8, 7, 6, null]);
  });
});
