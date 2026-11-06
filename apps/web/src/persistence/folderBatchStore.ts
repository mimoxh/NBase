import type { AttachmentMetadata, UpdatePageRequest } from '@nbase/contracts';
import type { FolderImportPlan, FolderSourceFile } from './folderPlan';

export type FolderItemStatus = 'pending' | 'success' | 'failed' | 'cancelled';

export interface FolderBatchScope {
  userId: string;
  workspaceId: string;
}

export interface FolderBatchPage {
  key: string;
  status: FolderItemStatus;
  skeleton?: { id: string; revision: string };
  createStarted?: boolean;
  cancelAfterCreate?: boolean;
  pendingUpdate?: UpdatePageRequest;
  error?: string;
}

export interface FolderBatchAttachment {
  path: string;
  status: FolderItemStatus;
  metadata?: AttachmentMetadata;
  invalidFile?: boolean;
  uploadStarted?: boolean;
  error?: string;
}

export interface FolderImportBatch extends FolderBatchScope {
  id: string;
  scope: string;
  createdAt: string;
  plan: FolderImportPlan;
  pages: FolderBatchPage[];
  attachments: FolderBatchAttachment[];
  run?: { token: string; expires: number };
  paused?: string;
}

const batchStore = 'batches';
const sourceStore = 'sources';
const leaseDuration = 60_000;
const scopeKey = (scope: FolderBatchScope) => JSON.stringify([scope.userId, scope.workspaceId]);
export const folderLockName = (scope: FolderBatchScope, id: string) => 'nbase-folder:' + scopeKey(scope) + ':' + id;

function folderDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nbase-folder-imports', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(batchStore, { keyPath: 'id' }).createIndex('scope', 'scope');
      request.result.createObjectStore(sourceStore, { keyPath: ['id', 'path'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地导入记录。'));
  });
}

async function transact<T>(stores: string[], mode: IDBTransactionMode,
  run: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await folderDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      const fail = (error: Error) => { reject(error); tx.abort(); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('本地导入记录未能保存。'));
      try { run(tx, value => { result = value; }, fail); }
      catch (error) { fail(error instanceof Error ? error : new Error('本地导入记录操作失败。')); }
    });
  } finally { db.close(); }
}

export function newFolderBatch(scope: FolderBatchScope, plan: FolderImportPlan): FolderImportBatch {
  return {
    ...scope, id: crypto.randomUUID(), scope: scopeKey(scope), plan, createdAt: new Date().toISOString(),
    pages: plan.pages.map(page => ({ key: page.key, status: 'pending' })),
    attachments: plan.attachments.map(file => ({ path: file.path, status: 'pending' })),
  };
}

function scopedBatch(request: IDBRequest<unknown>, scope: FolderBatchScope): FolderImportBatch | null {
  const batch = request.result as FolderImportBatch | undefined;
  return batch?.scope === scopeKey(scope) ? batch : null;
}

export const folderBatchStore = {
  create(batch: FolderImportBatch, sources: readonly FolderSourceFile[]): Promise<void> {
    return transact([batchStore, sourceStore], 'readwrite', (tx, done) => {
      tx.objectStore(batchStore).add(batch);
      const store = tx.objectStore(sourceStore);
      for (const source of sources) store.add({ id: batch.id, ...source });
      done(undefined);
    });
  },
  list(scope: FolderBatchScope): Promise<FolderImportBatch[]> {
    return transact([batchStore], 'readonly', (tx, done) => {
      const request = tx.objectStore(batchStore).index('scope').getAll(scopeKey(scope));
      request.onsuccess = () => done((request.result as FolderImportBatch[])
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
  },
  start(scope: FolderBatchScope, id: string, token: string, ownsBrowserLock: boolean): Promise<FolderImportBatch> {
    return transact([batchStore], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore(batchStore);
      const request = store.get(id);
      request.onsuccess = () => {
        const batch = scopedBatch(request, scope);
        if (!batch) { fail(new Error('找不到此工作区的导入批次。')); return; }
        if (!ownsBrowserLock && batch.run && batch.run.expires > Date.now()) {
          fail(new Error('批次仍由另一个标签页处理，请稍后重试。')); return;
        }
        batch.run = { token, expires: Date.now() + leaseDuration };
        store.put(batch);
        done(batch);
      };
    });
  },
  source(batch: FolderImportBatch, path: string): Promise<File> {
    return transact([batchStore, sourceStore], 'readonly', (tx, done, fail) => {
      const lookup = tx.objectStore(batchStore).get(batch.id);
      lookup.onsuccess = () => {
        if (!scopedBatch(lookup, batch)) { fail(new Error('本地导入批次已不可用。')); return; }
        const request = tx.objectStore(sourceStore).get([batch.id, path]);
        request.onsuccess = () => {
          const file = (request.result as FolderSourceFile | undefined)?.file;
          if (file instanceof File) done(file);
          else fail(new Error('缺少本地文件：' + path));
        };
      };
    });
  },
  save(batch: FolderImportBatch, token: string, release = false): Promise<void> {
    return transact([batchStore], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore(batchStore);
      const request = store.get(batch.id);
      request.onsuccess = () => {
        if (scopedBatch(request, batch)?.run?.token !== token) {
          fail(new Error('批次已由另一个标签页接管，请刷新记录。')); return;
        }
        const next = { ...batch, run: { token, expires: Date.now() + leaseDuration } };
        if (release) {
          const { run: _run, ...completed } = next;
          store.put(completed);
        } else store.put(next);
        done(undefined);
      };
    });
  },
  remove(scope: FolderBatchScope, id: string): Promise<void> {
    return transact([batchStore, sourceStore], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore(batchStore);
      const request = store.get(id);
      request.onsuccess = () => {
        const batch = scopedBatch(request, scope);
        if (!batch) { fail(new Error('找不到此工作区的导入批次。')); return; }
        if (batch.run && batch.run.expires > Date.now()) {
          fail(new Error('批次仍在处理，请稍后重试。')); return;
        }
        store.delete(id);
        tx.objectStore(sourceStore).delete(IDBKeyRange.bound([id], [id, []]));
        done(undefined);
      };
    });
  },
};
