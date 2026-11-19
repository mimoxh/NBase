/**
 * Local copies of co-edited pages (docs/architecture/realtime.md): the whole Yjs state of a room as this browser
 * last saw it, kept while it holds changes of this browser that no revision contains yet. Separate from the
 * single-user drafts in drafts.ts, which pages without a room keep using.
 */
export interface RoomRecord {
  /** `${userId}:${workspaceId}:${pageId}:${epoch}` */
  key: string;
  userId: string;
  workspaceId: string;
  pageId: string;
  epoch: number;
  baseRevision: string;
  title: string;
  /** Yjs update holding the whole document. */
  update: Uint8Array;
  /** Highest clock of each Yjs client id this browser wrote with, as `[clientId, clock]`. */
  local: [number, number][];
  /** The room's state vector as last confirmed by the server. */
  acked: [number, number][];
  updatedAt: string;
}

export interface RoomStore {
  forPage(userId: string, workspaceId: string, pageId: string): Promise<RoomRecord[]>;
  put(record: RoomRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

export function roomRecordKey(userId: string, workspaceId: string, pageId: string, epoch: number): string {
  return `${userId}:${workspaceId}:${pageId}:${epoch}`;
}

export function memoryRoomStore(): RoomStore {
  const records = new Map<string, RoomRecord>();
  const copy = (record: RoomRecord): RoomRecord => ({ ...record, update: record.update.slice(),
    local: record.local.map(([client, clock]) => [client, clock]), acked: record.acked.map(([client, clock]) => [client, clock]) });
  return {
    async forPage(userId, workspaceId, pageId) {
      return [...records.values()].filter(record => record.userId === userId && record.workspaceId === workspaceId
        && record.pageId === pageId).map(copy);
    },
    async put(record) { records.set(record.key, copy(record)); },
    async remove(key) { records.delete(key); },
  };
}

const databaseName = 'nbase-collab-rooms';
const storeName = 'rooms';

export function indexedDbRoomStore(factory: IDBFactory = indexedDB): RoomStore {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: 'key' });
      store.createIndex('page', ['userId', 'workspaceId', 'pageId']);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = null; reject(request.error ?? new Error('IndexedDB unavailable')); };
    request.onblocked = () => { opened = null; reject(new Error('IndexedDB blocked')); };
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await database();
    const transaction = db.transaction(storeName, mode);
    const request = work(transaction.objectStore(storeName));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    return request.result;
  };
  return {
    async forPage(userId, workspaceId, pageId) {
      const rows = await run('readonly', store => store.index('page').getAll([userId, workspaceId, pageId]) as IDBRequest<RoomRecord[]>);
      return rows.map(row => ({ ...row, update: new Uint8Array(row.update) }));
    },
    async put(record) { await run('readwrite', store => store.put(record)); },
    async remove(key) { await run('readwrite', store => store.delete(key)); },
  };
}

/** IndexedDB when the browser offers it; otherwise copies last only as long as the tab. */
export function defaultRoomStore(): RoomStore {
  return typeof indexedDB === 'undefined' ? memoryRoomStore() : indexedDbRoomStore();
}
