import { describe, expect, it } from 'vitest';
import { whiteboardContent, whiteboardContentProblem, type WhiteboardShape, type WhiteboardText } from '@nbase/contracts';
import { clipboardMime, pageIdFromPastedText, parseElements, serializeElements } from './clipboard';
import { Controller, type PointerInput } from './controller';
import { connectorPath, createShape, type Connector, type El } from './model';
import { BoardStore } from './store';
import { approximateMeasure } from './text';

let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

function setup(elements: El[] = [], readOnly = false) {
  const saves: El[][] = [];
  const opened: string[] = [];
  const store = new BoardStore(elements, readOnly, next => saves.push(next));
  store.size = { width: 1000, height: 800 };
  const controller = new Controller(store, { measure: approximateMeasure, newId: uid, openPage: id => opened.push(id), contextMenu: () => undefined, notice: () => undefined });
  const pointer = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput =>
    ({ x, y, button: 0, pointerId: 1, pointerType: 'mouse', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });
  const drag = (from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}) => {
    controller.pointerDown(pointer(...from, extra));
    controller.pointerMove(pointer((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, extra));
    controller.pointerMove(pointer(...to, extra));
    controller.pointerUp(pointer(...to, extra));
  };
  const key = (k: string, extra: Partial<Parameters<Controller['keyDown']>[0]> = {}) =>
    controller.keyDown({ key: k, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...extra });
  return { store, controller, saves, opened, pointer, drag, key };
}

const valid = (elements: El[]) => expect(whiteboardContentProblem(whiteboardContent(elements))).toBeNull();

describe('controller persistence rules', () => {
  it('never saves for panning, zooming, selecting or clicking empty space', () => {
    const shape = createShape(uid(), { x: 100, y: 100, w: 100, h: 80 });
    const { store, controller, saves, pointer, drag } = setup([shape]);
    controller.wheel({ x: 10, y: 10 }, 0, 120, 0, false, false);
    controller.wheel({ x: 10, y: 10 }, 0, -120, 0, true, false);
    store.zoomToFit(); store.resetZoom();
    store.setView({ x: 0, y: 0, zoom: 1 });
    controller.pointerDown(pointer(150, 140)); controller.pointerUp(pointer(150, 140));
    expect(store.selection.has(shape.id)).toBe(true);
    drag([600, 600], [700, 700]);
    store.setTool('hand'); drag([500, 500], [400, 400]);
    expect(saves).toHaveLength(0);
  });

  it('creates a shape by dragging as one undoable save', () => {
    const { store, saves, drag, key } = setup();
    store.setTool('shape');
    drag([100, 100], [300, 220]);
    expect(saves).toHaveLength(1);
    const shape = store.elements[0] as WhiteboardShape;
    expect([shape.type, shape.w, shape.h]).toEqual(['shape', 200, 120]);
    expect(store.tool).toBe('select');
    valid(store.elements);
    key('z', { ctrlKey: true });
    expect(store.elements).toHaveLength(0);
    key('z', { ctrlKey: true, shiftKey: true });
    expect(store.elements).toHaveLength(1);
    expect(saves).toHaveLength(3);
  });

  it('keeps connectors attached while their targets move', () => {
    const a = createShape(uid(), { x: 0, y: 0, w: 100, h: 100 }), b = createShape(uid(), { x: 400, y: 0, w: 100, h: 100 });
    const { store, saves, drag } = setup([a, b]);
    store.setTool('connector');
    drag([50, 50], [450, 50]);
    const connector = store.elements.find(el => el.type === 'connector') as Connector;
    expect(connector.source.bind?.elementId).toBe(a.id);
    expect(connector.target.bind?.elementId).toBe(b.id);
    // Move b down; the connector follows without being edited itself.
    drag([450, 50], [450, 350]);
    const moved = store.elements.find(el => el.id === b.id) as WhiteboardShape;
    expect(moved.y).toBe(300);
    const end = connectorPath(store.elements.find(el => el.type === 'connector') as Connector, store.index).points.at(-1)!;
    expect(end.y).toBeGreaterThanOrEqual(300);
    expect(saves).toHaveLength(2);
    valid(store.elements);
  });

  it('saves while typing but undoes a whole edit in one step, and drops empty text', () => {
    const { store, controller, saves, pointer, key } = setup();
    store.setTool('text');
    controller.pointerDown(pointer(100, 100)); controller.pointerUp(pointer(100, 100));
    expect(store.editingId).not.toBeNull();
    controller.finishEditing();
    expect(store.elements).toHaveLength(0);
    expect(saves).toHaveLength(0);

    store.setTool('text');
    controller.pointerDown(pointer(100, 100)); controller.pointerUp(pointer(100, 100));
    controller.editText('中'); controller.editText('中文'); controller.editText('中文输入');
    expect(saves).toHaveLength(3);
    controller.finishEditing();
    const text = store.elements[0] as WhiteboardText;
    expect(text.text).toBe('中文输入');
    expect(text.w).toBeGreaterThan(60);
    key('z', { ctrlKey: true });
    expect(store.elements).toHaveLength(0);

    // Typing then clearing a new text element saves the cleared board back.
    store.setTool('text');
    controller.pointerDown(pointer(100, 100)); controller.pointerUp(pointer(100, 100));
    controller.editText('x'); controller.editText('');
    controller.finishEditing();
    expect(saves.at(-1)).toEqual([]);
  });

  it('builds a mind map from the keyboard', () => {
    const { store, controller, pointer, key } = setup();
    store.setTool('mind');
    controller.pointerDown(pointer(200, 300)); controller.pointerUp(pointer(200, 300));
    const root = store.elements[0]!;
    expect(key('Tab')).toBe(true);
    controller.editText('分支一');
    controller.finishEditing('sibling');
    controller.editText('分支二');
    controller.finishEditing();
    const nodes = store.elements.filter(el => el.type === 'shape') as WhiteboardShape[];
    expect(nodes).toHaveLength(3);
    expect(nodes.filter(node => node.mindParentId === root.id).map(node => node.text)).toEqual(['分支一', '分支二']);
    valid(store.elements);
  });

  it('erases, deletes, duplicates, groups and respects locks', () => {
    const a = createShape(uid(), { x: 0, y: 0, w: 100, h: 100 }), b = createShape(uid(), { x: 200, y: 0, w: 100, h: 100 });
    const { store, controller, drag, key } = setup([a, b]);
    store.select([a.id, b.id]);
    key('g', { ctrlKey: true });
    expect(new Set(store.elements.map(el => el.groupId)).size).toBe(1);
    key('d', { ctrlKey: true });
    expect(store.elements).toHaveLength(4);
    expect(store.selection.has(a.id)).toBe(false);
    key('Delete');
    expect(store.elements.map(el => el.id)).toEqual([a.id, b.id]);
    store.select([a.id]);
    key('l', { ctrlKey: true, shiftKey: true });
    expect(store.elements[0]!.locked).toBe(true);
    key('Delete');
    expect(store.elements).toHaveLength(2);
    store.setTool('eraser');
    drag([-20, 50], [320, 50]);
    expect(store.elements.map(el => el.id)).toEqual([a.id]);
    controller.refreshOverlay();
  });

  it('read-only boards select and open cards but never change', () => {
    const page = uid();
    const card: El = { id: uid(), type: 'card', x: 0, y: 0, w: 200, h: 60, angle: 0, pageId: page, label: '源文档' };
    const { store, controller, saves, drag, key } = setup([card], true);
    drag([100, 30], [400, 300]);
    expect((store.elements[0] as typeof card).x).toBe(0);
    key('Delete'); store.setTool('shape');
    expect(store.tool).toBe('select');
    controller.doubleClick({ x: 100, y: 30 });
    expect(saves).toHaveLength(0);
  });
});

describe('clipboard payloads', () => {
  it('round-trips detached copies and recognises page links', () => {
    const a = createShape(uid(), { x: 0, y: 0, w: 100, h: 100 });
    const text = serializeElements([a], uid);
    const parsed = parseElements(text)!;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).not.toBe(a.id);
    expect(parseElements('{"nbaseWhiteboard":1,"elements":[{"type":"widget"}]}')).toBeNull();
    expect(parseElements('hello')).toBeNull();
    expect(clipboardMime).toContain('whiteboard');
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(pageIdFromPastedText(`/?page=${id}`)).toBe(id);
    expect(pageIdFromPastedText(`http://127.0.0.1:5173/?page=${id}`)).toBe(id);
    expect(pageIdFromPastedText('just text')).toBeNull();
  });
});
