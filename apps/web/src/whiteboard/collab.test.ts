import { describe, expect, it } from 'vitest';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { WhiteboardShape } from '@nbase/contracts';
import type { RoomProvider } from '../persistence/collab/roomClient';
import { normalizedWhiteboardContent, readWhiteboardElements, seedWhiteboard, WhiteboardBinding } from './collab';
import { createConnector, createShape, type El } from './model';
import { BoardStore } from './store';

let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const rect = (x: number, extra: Partial<WhiteboardShape> = {}) => ({ ...createShape(uid(), { x, y: 0, w: 100, h: 60 }), ...extra });
const shape = (elements: readonly El[], id: string) => elements.find(element => element.id === id) as WhiteboardShape;

function provider(doc: Y.Doc): RoomProvider {
  const awareness = new Awareness(doc);
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    awareness,
    connect() { for (const listener of listeners.get('sync') ?? []) listener(true); },
    disconnect() { awareness.setLocalState(null); },
    on(type, listener) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
    off(type, listener) { listeners.get(type)?.delete(listener); },
  };
}

function exchangeDocuments(a: Y.Doc, b: Y.Doc): void {
  const updateA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const updateB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(a, updateB, 'remote');
  Y.applyUpdate(b, updateA, 'remote');
}

function exchangeAwareness(a: Awareness, b: Awareness): void {
  applyAwarenessUpdate(a, encodeAwarenessUpdate(b, [...b.getStates().keys()]), 'remote');
  applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [...a.getStates().keys()]), 'remote');
}

function pair(initial: readonly El[]) {
  const docs = [new Y.Doc(), new Y.Doc()] as const;
  seedWhiteboard(docs[0], initial);
  Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]), 'remote');
  const stores = initial.map(() => new BoardStore([...initial], false, () => undefined));
  const providers = docs.map(provider);
  const bindings = stores.map((store, index) => new WhiteboardBinding(store, docs[index]!, providers[index]!, {
    username: index ? '乙' : '甲', cursorColor: index ? '#30a46c' : '#e5484d', seed: initial,
  }));
  exchangeAwareness(providers[0]!.awareness, providers[1]!.awareness);
  return { docs, stores, providers, bindings };
}

describe('whiteboard Y adapter', () => {
  it('converges concurrent edits of different elements and uses per-element last-writer-wins', () => {
    const a = rect(0), b = rect(200);
    const { docs, stores, bindings } = pair([a, b]);
    stores[0]!.commit([{ ...a, x: 40 }, b]);
    stores[1]!.commit([a, { ...b, text: '乙的文字' }]);
    exchangeDocuments(...docs);
    expect(readWhiteboardElements(docs[0])).toEqual(readWhiteboardElements(docs[1]));
    expect(shape(stores[0]!.elements, a.id).x).toBe(40);
    expect(shape(stores[0]!.elements, b.id).text).toBe('乙的文字');

    stores[0]!.commit(stores[0]!.elements.map(element => element.id === a.id ? { ...element, text: '甲' } : element));
    stores[1]!.commit(stores[1]!.elements.map(element => element.id === a.id ? { ...element, text: '乙' } : element));
    exchangeDocuments(...docs);
    expect(readWhiteboardElements(docs[0])).toEqual(readWhiteboardElements(docs[1]));
    expect(shape(stores[0]!.elements, a.id).text).toBe(shape(stores[1]!.elements, a.id).text);
    expect(['甲', '乙']).toContain(shape(stores[0]!.elements, a.id).text);
    bindings.forEach(binding => binding.dispose());
  });

  it('keeps order complete and identical after concurrent insertions and reordering', () => {
    const a = rect(0), b = rect(200), c = rect(400), d = rect(600);
    const { docs, stores, bindings } = pair([a, b]);
    stores[0]!.commit([b, a, c]);
    stores[1]!.commit([a, b, d]);
    exchangeDocuments(...docs);
    const first = readWhiteboardElements(docs[0]);
    expect(first).toEqual(readWhiteboardElements(docs[1]));
    expect(new Set(first.map(element => element.id))).toEqual(new Set([a.id, b.id, c.id, d.id]));
    expect(docs[0]!.getArray<string>('order').toArray()).toEqual(docs[1]!.getArray<string>('order').toArray());
    expect(new Set(docs[0]!.getArray<string>('order').toArray()).size).toBe(4);
    bindings.forEach(binding => binding.dispose());
  });

  it('undoes only this store\'s operation, not a remote element or a later remote write', () => {
    const a = rect(0), b = rect(200);
    const { docs, stores, bindings } = pair([a, b]);
    stores[0]!.commit([{ ...a, x: 50 }, b]);
    stores[1]!.commit([a, { ...b, x: 300 }]);
    exchangeDocuments(...docs);
    stores[0]!.undo();
    exchangeDocuments(...docs);
    expect(shape(stores[0]!.elements, a.id).x).toBe(0);
    expect(shape(stores[0]!.elements, b.id).x).toBe(300);

    stores[0]!.redo();
    exchangeDocuments(...docs);
    expect(shape(stores[0]!.elements, a.id).x).toBe(50);
    stores[1]!.commit(stores[1]!.elements.map(element => element.id === a.id ? { ...element, x: 90 } : element));
    exchangeDocuments(...docs);
    stores[0]!.undo();
    exchangeDocuments(...docs);
    expect(shape(stores[0]!.elements, a.id).x).toBe(90);
    bindings.forEach(binding => binding.dispose());
  });

  it('keeps drag previews and text-editing indicators in awareness, outside documents and undo', () => {
    const a = rect(0), b = rect(200);
    const { docs, stores, providers, bindings } = pair([a, b]);
    const before = Y.encodeStateAsUpdate(docs[0]);
    stores[0]!.select([a.id]);
    stores[0]!.begin();
    stores[0]!.preview([{ ...a, x: 120 }, b]);
    stores[0]!.editingId = a.id;
    stores[0]!.emit();
    exchangeAwareness(providers[0]!.awareness, providers[1]!.awareness);
    expect(stores[1]!.remotePreviews.get(a.id)).toMatchObject({ x: 120 });
    expect(stores[1]!.remoteUsers[0]).toMatchObject({ name: '甲', selection: [a.id], editingId: a.id });
    expect(stores[0]!.canUndo).toBe(false);
    expect(stores[1]!.canUndo).toBe(false);
    expect(Y.encodeStateAsUpdate(docs[0])).toEqual(before);
    expect(readWhiteboardElements(docs[1])[0]).toMatchObject({ x: 0 });

    stores[0]!.cancel();
    exchangeAwareness(providers[0]!.awareness, providers[1]!.awareness);
    expect(stores[1]!.remotePreviews.size).toBe(0);
    bindings.forEach(binding => binding.dispose());
  });

  it('writes connector and concurrent mind-cycle normalization fixes back into the Y document', () => {
    const a = rect(0, { mindParentId: null }), b = rect(200, { mindParentId: null });
    const cyclicA = { ...a, mindParentId: b.id }, cyclicB = { ...b, mindParentId: a.id };
    const dangling = createConnector(uid(), { x: 0, y: 0, bind: { elementId: uid(), ax: 0.5, ay: 0.5 } }, { x: 20, y: 20 });
    const doc = new Y.Doc();
    seedWhiteboard(doc, [cyclicA, cyclicB, dangling]);
    const saved = normalizedWhiteboardContent(doc);
    const elements = saved.board.elements;
    expect(elements.filter(element => element.type === 'shape' && element.mindParentId === null)).toHaveLength(1);
    expect(elements.find(element => element.type === 'connector')).not.toHaveProperty('source.bind');
    expect(readWhiteboardElements(doc)).toEqual(elements);

    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc), 'remote');
    expect(normalizedWhiteboardContent(other).board.elements).toEqual(elements);
  });
});
