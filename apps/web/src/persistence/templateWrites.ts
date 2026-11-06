import type { SaveNoteTemplateRequest, StoredDocumentContent } from '@nbase/contracts';

export interface TemplateWriteScope { userId: string; workspaceId: string }
export type TemplateMutation =
  | { kind: 'save'; id: string | null; body: SaveNoteTemplateRequest }
  | { kind: 'delete'; id: string; body: { clientMutationId: string; expectedRevision: string } };

export interface TemplateWrite extends TemplateWriteScope {
  key: string;
  version: string;
  createdAt: string;
  operation: TemplateMutation;
  /** Delete requests also retain the original template for copying or recovery. */
  snapshot: { name: string; content: StoredDocumentContent };
  state: 'pending' | 'rejected';
  failure?: string;
}

export const templateWriteKey = (scope: TemplateWriteScope, mutationId: string) =>
  JSON.stringify([scope.userId, scope.workspaceId, mutationId]);

export function newTemplateWrite(scope: TemplateWriteScope, operation: TemplateMutation,
  snapshot: TemplateWrite['snapshot']): TemplateWrite {
  return structuredClone({ ...scope, key: templateWriteKey(scope, operation.body.clientMutationId),
    version: crypto.randomUUID(), createdAt: new Date().toISOString(), operation, snapshot, state: 'pending' });
}

export function sameTemplateWrite(current: TemplateWrite | undefined, expected: TemplateWrite): boolean {
  return Boolean(current && current.key === templateWriteKey(current, current.operation.body.clientMutationId)
    && expected.key === templateWriteKey(expected, expected.operation.body.clientMutationId)
    && current.key === expected.key && current.version === expected.version
    && JSON.stringify(current) === JSON.stringify(expected));
}

function belongs(record: TemplateWrite, scope: TemplateWriteScope): boolean {
  return record.userId === scope.userId && record.workspaceId === scope.workspaceId
    && record.key === templateWriteKey(record, record.operation.body.clientMutationId);
}

export class TemplateWriteConflict extends Error {
  constructor() { super('本机模板记录已有变化，请重新读取并恢复对应记录。'); }
}

const databaseName = 'nbase-template-writes';
const storeName = 'template-writes';
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'key' });
    request.onblocked = () => { blocked = true; reject(new Error('本机模板记录正在使用，请关闭旧版本标签页后重试。')); };
    request.onerror = () => reject(request.error ?? new Error('无法打开本机模板记录。'));
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  });
}

async function transaction<T>(mode: IDBTransactionMode,
  action: (store: IDBObjectStore, done: (value: T) => void, fail: (reason: Error) => void) => void): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(storeName, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('本机模板记录未能保存。'));
      tx.onerror = () => reject(tx.error ?? new Error('本机模板记录操作失败。'));
      const fail = (reason: Error) => { reject(reason); tx.abort(); };
      try { action(tx.objectStore(storeName), value => { result = value; }, fail); }
      catch (reason) { fail(reason instanceof Error ? reason : new Error('本机模板记录操作失败。')); }
    });
  } finally { database.close(); }
}

export const templateWriteStore = {
  list(scope: TemplateWriteScope): Promise<TemplateWrite[]> {
    return transaction('readonly', (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => done((request.result as TemplateWrite[]).filter(record => belongs(record, scope))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
  },
  get(scope: TemplateWriteScope, mutationId: string): Promise<TemplateWrite | undefined> {
    return transaction('readonly', (store, done) => {
      const request = store.get(templateWriteKey(scope, mutationId));
      request.onsuccess = () => {
        const record = request.result as TemplateWrite | undefined;
        done(record && belongs(record, scope) ? record : undefined);
      };
    });
  },
  /** A correction replaces only the exact, explicitly rejected operation. */
  put(record: TemplateWrite, expected: TemplateWrite | null): Promise<void> {
    if (!belongs(record, record) || (expected && (!belongs(expected, record)
      || (record.key !== expected.key && expected.state !== 'rejected')))) return Promise.reject(new TemplateWriteConflict());
    return transaction('readwrite', (store, done, fail) => {
      const request = store.get(expected?.key ?? record.key);
      request.onsuccess = () => {
        const current = request.result as TemplateWrite | undefined;
        if (!expected) {
          if (sameTemplateWrite(current, record)) { done(undefined); return; }
          if (current) { fail(new TemplateWriteConflict()); return; }
          store.put(record); done(undefined); return;
        }
        if (!sameTemplateWrite(current, expected)) { fail(new TemplateWriteConflict()); return; }
        if (record.key === expected.key) {
          if (JSON.stringify(record.operation) !== JSON.stringify(expected.operation)) { fail(new TemplateWriteConflict()); return; }
          store.put(record); done(undefined); return;
        }
        const next = store.get(record.key);
        next.onsuccess = () => {
          if (next.result !== undefined) { fail(new TemplateWriteConflict()); return; }
          store.put(record); store.delete(expected.key); done(undefined);
        };
      };
    });
  },
  removeIfVersion(record: TemplateWrite): Promise<boolean> {
    if (!belongs(record, record)) return Promise.resolve(false);
    return transaction('readwrite', (store, done) => {
      const request = store.get(record.key);
      request.onsuccess = () => {
        const matches = sameTemplateWrite(request.result as TemplateWrite | undefined, record);
        if (matches) store.delete(record.key);
        done(matches);
      };
    });
  },
};
