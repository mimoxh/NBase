import type { DocumentContent } from './types';

export interface SourceDraftScope {
  userId: string;
  workspaceId: string;
  pageId: string;
  instanceId: string;
}

export interface SourceDraftInput {
  source: string;
  baseContent: DocumentContent;
  baseRevision: string;
  recoveredFrom?: SourceDraftVersion[];
}

export interface SourceDraft extends SourceDraftScope, SourceDraftInput {
  key: string;
  pageKey: string;
  sequence: number;
  updatedAt: string;
}

export type SourceDraftVersion = Omit<SourceDraft, 'recoveredFrom' | 'pageKey'>;
export type SourceDraftPage = Pick<SourceDraftScope, 'userId' | 'workspaceId' | 'pageId'>;

export const sourceDraftKey = (scope: SourceDraftScope) => JSON.stringify([scope.userId, scope.workspaceId, scope.pageId, scope.instanceId]);
const pageKey = (scope: SourceDraftPage) => JSON.stringify([scope.userId, scope.workspaceId, scope.pageId]);

export function sourceDraftVersion(draft: SourceDraft): SourceDraftVersion {
  const { pageKey: _pageKey, recoveredFrom: _recoveredFrom, ...version } = draft;
  return version;
}

/** Matching timestamps alone is insufficient when another tab writes during an apply. */
export function sameSourceDraftVersion(draft: SourceDraft | undefined, version: SourceDraftVersion): boolean {
  return Boolean(draft && sourceDraftKey(version) === version.key && sourceDraftKey(draft) === version.key && draft.key === version.key
    && draft.sequence === version.sequence && draft.updatedAt === version.updatedAt
    && draft.source === version.source && draft.baseRevision === version.baseRevision
    && JSON.stringify(draft.baseContent) === JSON.stringify(version.baseContent));
}

export class SourceDraftConflict extends Error {
  constructor() { super('此实例的源码草稿已有更新。当前输入仍保留，请重新读取并显式恢复草稿。'); }
}

interface SourceDraftStorage {
  list(scope: SourceDraftPage): Promise<SourceDraft[]>;
  put(draft: SourceDraft, expected: SourceDraftVersion | null): Promise<void>;
  removeIfVersion(version: SourceDraftVersion): Promise<boolean>;
}

const databaseName = 'nbase-source-drafts';
const storeName = 'source-drafts';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: 'key' }).createIndex('page', 'pageKey');
    };
    request.onblocked = () => { blocked = true; reject(new Error('本机源码草稿数据库正在使用，请关闭旧版本标签页后重试。')); };
    request.onerror = () => reject(request.error ?? new Error('无法打开本机源码草稿。'));
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
      const fail = (reason: Error) => { reject(reason); tx.abort(); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('本机源码草稿未能保存。'));
      try { action(tx.objectStore(storeName), value => { result = value; }, fail); }
      catch (error) { fail(error instanceof Error ? error : new Error('本机源码草稿操作失败。')); }
    });
  } finally { database.close(); }
}

export const sourceDraftStore: SourceDraftStorage = {
  list(scope) {
    return transaction('readonly', (store, done) => {
      const request = store.index('page').getAll(pageKey(scope));
      request.onsuccess = () => done((request.result as SourceDraft[])
        .filter(draft => draft.pageKey === pageKey(scope) && pageKey(draft) === pageKey(scope)
          && draft.key === sourceDraftKey(draft))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    });
  },
  put(draft, expected) {
    if (draft.key !== sourceDraftKey(draft) || draft.pageKey !== pageKey(draft)
      || draft.sequence !== (expected?.sequence ?? 0) + 1 || (expected && expected.key !== draft.key)) {
      return Promise.reject(new SourceDraftConflict());
    }
    return transaction('readwrite', (store, done, fail) => {
      const request = store.get(draft.key);
      request.onsuccess = () => {
        const current = request.result as SourceDraft | undefined;
        if (expected ? !sameSourceDraftVersion(current, expected) : current !== undefined) {
          fail(new SourceDraftConflict()); return;
        }
        store.put(draft);
        done(undefined);
      };
    });
  },
  removeIfVersion(version) {
    if (version.key !== sourceDraftKey(version)) return Promise.resolve(false);
    return transaction('readwrite', (store, done) => {
      const request = store.get(version.key);
      request.onsuccess = () => {
        const matches = sameSourceDraftVersion(request.result as SourceDraft | undefined, version);
        if (matches) store.delete(version.key);
        done(matches);
      };
    });
  },
};

/** Each keystroke is enqueued immediately; a failed save never makes a later input disappear. */
export class SourceDraftQueue {
  private current: SourceDraft | null;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private pending = 0;
  private guarded = false;
  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };

  private updateUnloadGuard() {
    if (typeof window === 'undefined') return;
    const needed = this.pending > 0 || this.failure !== undefined;
    if (needed && !this.guarded) window.addEventListener('beforeunload', this.beforeUnload);
    if (!needed && this.guarded) window.removeEventListener('beforeunload', this.beforeUnload);
    this.guarded = needed;
  }

  constructor(private readonly scope: SourceDraftScope, initial: SourceDraft | null = null,
    private readonly storage: SourceDraftStorage = sourceDraftStore) {
    if (initial && (initial.key !== sourceDraftKey(scope) || initial.key !== sourceDraftKey(initial))) throw new SourceDraftConflict();
    this.current = initial;
  }

  get latest(): SourceDraft | null { return this.current; }

  enqueue(input: SourceDraftInput): Promise<SourceDraft> {
    this.pending++;
    // Install in the input event, before cloning or waiting for earlier transactions.
    this.updateUnloadGuard();
    // Baselines and adopted versions belong to this edit, independent of future React props.
    let captured: SourceDraftInput;
    try { captured = structuredClone(input); }
    catch (reason) {
      this.pending--; this.failure = reason; this.updateUnloadGuard();
      return Promise.reject(reason);
    }
    const write = this.tail.then(async () => {
      const draft: SourceDraft = { ...this.scope, ...captured, key: sourceDraftKey(this.scope), pageKey: pageKey(this.scope),
        sequence: (this.current?.sequence ?? 0) + 1, updatedAt: new Date().toISOString() };
      await this.storage.put(draft, this.current ? sourceDraftVersion(this.current) : null);
      this.current = draft;
      this.failure = undefined;
      return draft;
    });
    this.tail = write.then(() => {}, reason => { this.failure = reason; })
      .finally(() => { this.pending--; this.updateUnloadGuard(); });
    return write;
  }

  async flush(): Promise<SourceDraft | null> {
    let pending: Promise<void>;
    do { pending = this.tail; await pending; } while (pending !== this.tail);
    if (this.failure !== undefined) throw this.failure;
    return this.current;
  }

  /** The version is captured before awaiting so a newer edit cannot be deleted by cleanup. */
  async clear(version: SourceDraftVersion): Promise<boolean> {
    const removed = await this.storage.removeIfVersion(version);
    if (removed && this.current && sameSourceDraftVersion(this.current, version)) this.current = null;
    return removed;
  }

  /** Call only after explicit abandonment and all queued transactions have settled. */
  abandonUnsavedInput(): void {
    if (this.pending) throw new Error('请先等待本机草稿写入结束。');
    this.failure = undefined;
    this.updateUnloadGuard();
  }
}
