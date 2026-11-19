import { whiteboardContent, type WhiteboardContent } from '@nbase/contracts';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { RoomProvider } from '../persistence/collab/roomClient';
import { normalizeForSave, type El } from './model';
import type { BoardCollab, BoardStore, RemoteBoardUser } from './store';

const localOrigin = Symbol('whiteboard-local');
const normalizeOrigin = Symbol('whiteboard-normalize');

type Change = { id: string; before: El | null; after: El | null };
interface Entry { changes: Change[]; beforeOrder: string[]; afterOrder: string[] }
interface BoardAwareness {
  selection: string[];
  editingId: string | null;
  previews: Record<string, El | null>;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
const elementMap = (elements: readonly El[]) => new Map(elements.map(element => [element.id, element]));
const idsOf = (elements: readonly El[]) => elements.map(element => element.id);

export function readWhiteboardElements(doc: Y.Doc): El[] {
  const map = doc.getMap<El>('elements');
  const order = doc.getArray<string>('order').toArray();
  const result: El[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const element = map.get(id);
    if (element && !seen.has(id)) { result.push(element); seen.add(id); }
  }
  // A malformed or interrupted writer must not make elements unreachable; valid writers repair the array below.
  for (const id of [...map.keys()].sort()) if (!seen.has(id)) result.push(map.get(id)!);
  return result;
}

export function whiteboardHasContent(doc: Y.Doc): boolean {
  return doc.getMap('elements').size > 0 || doc.getArray('order').length > 0 || doc.getText('title').length > 0;
}

function cleanOrder(map: Y.Map<El>, order: Y.Array<string>): void {
  const seen = new Set<string>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order.get(index);
    if (!map.has(id) || seen.has(id)) order.delete(index);
    else seen.add(id);
  }
  const missing = [...map.keys()].filter(id => !seen.has(id)).sort();
  if (missing.length) order.insert(order.length, missing);
}

function predecessor(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id);
  return index > 0 ? ids[index - 1]! : null;
}

/** Applies only additions, deletions and moves between the two local orders, leaving concurrent remote ids alone. */
function writeOrder(map: Y.Map<El>, order: Y.Array<string>, before: readonly string[], after: readonly string[]): void {
  cleanOrder(map, order);
  const beforeSet = new Set(before);
  for (const id of after) {
    if (!map.has(id)) continue;
    const added = !beforeSet.has(id);
    if (!added && predecessor(before, id) === predecessor(after, id)) continue;
    const current = order.toArray();
    const at = current.indexOf(id);
    if (at >= 0) order.delete(at);
    const previous = predecessor(after, id);
    const anchor = previous ? order.toArray().indexOf(previous) : -1;
    const index = previous ? anchor + 1 : 0;
    order.insert(Math.max(0, Math.min(order.length, index)), [id]);
  }
  cleanOrder(map, order);
}

function changesBetween(before: readonly El[], after: readonly El[]): Change[] {
  const oldMap = elementMap(before), newMap = elementMap(after);
  const changes: Change[] = [];
  for (const [id, oldElement] of oldMap) {
    const newElement = newMap.get(id) ?? null;
    if (!sameValue(oldElement, newElement)) changes.push({ id, before: oldElement, after: newElement });
  }
  for (const [id, newElement] of newMap) if (!oldMap.has(id)) changes.push({ id, before: null, after: newElement });
  return changes;
}

function applyChanges(map: Y.Map<El>, changes: readonly Change[], reverse: boolean, guarded: boolean): void {
  for (const change of changes) {
    const before = reverse ? change.after : change.before;
    const after = reverse ? change.before : change.after;
    const current = map.get(change.id) ?? null;
    if (guarded && !sameValue(current, before)) continue;
    if (after) map.set(change.id, after); else map.delete(change.id);
  }
}

/** One transaction for a finished gesture, a text keystroke, or a normalization write-back. */
export function writeWhiteboard(doc: Y.Doc, before: readonly El[], after: readonly El[], origin: unknown = localOrigin): El[] {
  const changes = changesBetween(before, after);
  const beforeOrder = idsOf(before), afterOrder = idsOf(after);
  doc.transact(() => {
    const map = doc.getMap<El>('elements'), order = doc.getArray<string>('order');
    applyChanges(map, changes, false, false);
    writeOrder(map, order, beforeOrder, afterOrder);
  }, origin);
  return readWhiteboardElements(doc);
}

export function seedWhiteboard(doc: Y.Doc, elements: readonly El[]): void {
  if (whiteboardHasContent(doc)) return;
  writeWhiteboard(doc, [], normalizeForSave(elements), localOrigin);
}

/** Runs the ordinary pre-save normalization and shares any fixes before the saver reads its state vector. */
export function normalizedWhiteboardContent(doc: Y.Doc): WhiteboardContent {
  const before = readWhiteboardElements(doc);
  const after = normalizeForSave(before);
  if (!sameValue(before, after)) writeWhiteboard(doc, before, after, normalizeOrigin);
  return whiteboardContent(readWhiteboardElements(doc));
}

function travel(doc: Y.Doc, entry: Entry, reverse: boolean): El[] {
  const expectedOrder = reverse ? entry.afterOrder : entry.beforeOrder;
  const targetOrder = reverse ? entry.beforeOrder : entry.afterOrder;
  doc.transact(() => {
    const map = doc.getMap<El>('elements'), order = doc.getArray<string>('order');
    applyChanges(map, entry.changes, reverse, true);
    cleanOrder(map, order);
    const expected = new Set(expectedOrder);
    const current = order.toArray().filter(id => expected.has(id));
    const expectedPresent = expectedOrder.filter(id => map.has(id));
    // Another user's reorder wins over this undo; element undo still proceeds independently.
    if (sameIds(current, expectedPresent)) writeOrder(map, order, expectedOrder, targetOrder);
  }, localOrigin);
  return readWhiteboardElements(doc);
}

export interface WhiteboardBindingOptions {
  username: string;
  cursorColor: string;
  seed: readonly El[];
}

/** Binds a BoardStore to the room's Y.Doc and awareness without giving awareness changes an undo entry. */
export class WhiteboardBinding implements BoardCollab {
  private readonly past: Entry[] = [];
  private readonly future: Entry[] = [];
  private readonly awareness: Awareness;
  private selectionKey = '';
  private disposed = false;

  constructor(private readonly store: BoardStore, private readonly doc: Y.Doc,
    private readonly provider: RoomProvider, options: WhiteboardBindingOptions) {
    this.options = options;
    this.awareness = provider.awareness;
    store.setCollaboration(this);
    this.awareness.setLocalState({
      ...this.awareness.getLocalState(),
      user: { name: options.username, color: options.cursorColor },
      whiteboard: { selection: [...store.selection], editingId: store.editingId, previews: {} } satisfies BoardAwareness,
    });
    provider.on('sync', this.onSync);
    this.doc.on('afterTransaction', this.onDocument);
    this.awareness.on('change', this.onAwareness);
    this.unsubscribe = store.subscribe(this.syncSelection);
    provider.connect();
    if (whiteboardHasContent(doc)) store.applyRemote(readWhiteboardElements(doc));
    this.syncSelection();
    this.readAwareness();
  }

  private readonly options: WhiteboardBindingOptions;
  private readonly unsubscribe: () => void;

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  private onSync = () => { if (!this.disposed) seedWhiteboard(this.doc, this.options.seed); };

  private onDocument = (transaction: Y.Transaction) => {
    if (this.disposed || transaction.origin === localOrigin) return;
    this.store.applyRemote(readWhiteboardElements(this.doc));
  };

  commit(base: El[], next: El[], record: boolean): El[] {
    const entry: Entry = { changes: changesBetween(base, next), beforeOrder: idsOf(base), afterOrder: idsOf(next) };
    const changed = entry.changes.length > 0 || !sameIds(entry.beforeOrder, entry.afterOrder);
    const result = writeWhiteboard(this.doc, base, next, localOrigin);
    if (record && changed) {
      this.past.push(entry);
      if (this.past.length > 200) this.past.shift();
      this.future.length = 0;
    }
    this.setPreviews({});
    return result;
  }

  preview(base: El[], next: El[]): void {
    const before = elementMap(base), after = elementMap(next);
    const previews: Record<string, El | null> = {};
    for (const [id, element] of after) if (before.get(id) !== element) previews[id] = element;
    for (const id of before.keys()) if (!after.has(id)) previews[id] = null;
    this.setPreviews(previews);
  }

  cancelPreview(): void { this.setPreviews({}); }

  undo(): El[] | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push(entry);
    this.setPreviews({});
    return travel(this.doc, entry, true);
  }

  redo(): El[] | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push(entry);
    this.setPreviews({});
    return travel(this.doc, entry, false);
  }

  private localBoard(): BoardAwareness {
    return { selection: [...this.store.selection], editingId: this.store.editingId, previews: {} };
  }

  private syncSelection = () => {
    if (this.disposed) return;
    const key = JSON.stringify([[...this.store.selection], this.store.editingId]);
    if (key === this.selectionKey) return;
    this.selectionKey = key;
    const previous = this.awareness.getLocalState()?.whiteboard as BoardAwareness | undefined;
    this.awareness.setLocalStateField('whiteboard', { ...this.localBoard(), previews: previous?.previews ?? {} });
  };

  private setPreviews(previews: Record<string, El | null>): void {
    if (this.disposed) return;
    const previous = this.awareness.getLocalState()?.whiteboard as BoardAwareness | undefined;
    this.awareness.setLocalStateField('whiteboard', { ...this.localBoard(), previews });
  }

  private onAwareness = () => { if (!this.disposed) this.readAwareness(); };

  private readAwareness(): void {
    const users: RemoteBoardUser[] = [];
    const previews = new Map<string, El | null>();
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const board = (state as { whiteboard?: Partial<BoardAwareness> }).whiteboard;
      if (!board) continue;
      const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
      const selection = Array.isArray(board.selection) ? board.selection.filter((id): id is string => typeof id === 'string') : [];
      const editingId = typeof board.editingId === 'string' ? board.editingId : null;
      users.push({ clientId, name: typeof user?.name === 'string' ? user.name : '成员',
        color: typeof user?.color === 'string' ? user.color : '#3e63dd', selection, editingId });
      if (board.previews && typeof board.previews === 'object') {
        for (const [id, element] of Object.entries(board.previews)) previews.set(id, element ?? null);
      }
    }
    this.store.setRemoteBoardState(users, previews);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.provider.off('sync', this.onSync);
    this.doc.off('afterTransaction', this.onDocument);
    this.awareness.off('change', this.onAwareness);
    this.store.setRemoteBoardState([], new Map());
    this.store.setCollaboration(null);
    this.awareness.setLocalState(null);
    this.provider.disconnect();
  }
}
