import type { CreatePageRequest, PageStateRequest, StoredDocumentContent, UpdatePageRequest } from '@nbase/contracts';

const databaseName = 'nbase-local-drafts';
const storeName = 'page-drafts';
const createStoreName = 'pending-creates';
const actionStoreName = 'pending-actions';

export interface LocalPendingAction {
  key: string;
  userId: string;
  workspaceId: string;
  pageId: string;
  title: string;
  operation: 'trash' | 'restore' | 'restore-version';
  body: PageStateRequest & { sourceRevision?: string; expectedSubtreeIds?: string[] };
  affectedIds: string[];
  createdAt: string;
}

export interface LocalPendingCreate {
  key: string;
  userId: string;
  workspaceId: string;
  body: CreatePageRequest;
  createdAt: string;
  resolvesDraftPageId?: string;
  resolvesDrafts?: DraftVersion[];
}

/** The exact saved version of a draft that a recovery or copy intends to resolve. */
export interface DraftVersion {
  key: string;
  sequence: number;
  updatedAt: string;
  title: string;
  content: StoredDocumentContent;
  pendingMutationId?: string;
}

export interface LocalPageDraft {
  key: string;
  pageId: string;
  workspaceId: string;
  userId: string;
  title: string;
  content: StoredDocumentContent;
  markdown: string;
  baseRevision: string;
  sequence: number;
  updatedAt: string;
  pending?: UpdatePageRequest;
  recoveredFrom?: DraftVersion[];
}

export function draftVersion(draft: LocalPageDraft): DraftVersion {
  return {
    key: draft.key, sequence: draft.sequence, updatedAt: draft.updatedAt,
    title: draft.title, content: draft.content,
    ...(draft.pending ? { pendingMutationId: draft.pending.clientMutationId } : {}),
  };
}

export function sameDraftVersion(draft: LocalPageDraft, version: DraftVersion): boolean {
  return draft.key === version.key && draft.sequence === version.sequence
    && draft.updatedAt === version.updatedAt && draft.title === version.title
    && draft.pending?.clientMutationId === version.pendingMutationId
    && JSON.stringify(draft.content) === JSON.stringify(version.content);
}

export function draftKey(userId: string, workspaceId: string, pageId: string, tabId: string): string {
  return `${userId}:${workspaceId}:${pageId}:${tabId}`;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'key' });
      if (!request.result.objectStoreNames.contains(createStoreName)) request.result.createObjectStore(createStoreName, { keyPath: 'key' });
      if (!request.result.objectStoreNames.contains(actionStoreName)) request.result.createObjectStore(actionStoreName, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地草稿库无法打开'));
  });
}

async function operation<T>(mode: IDBTransactionMode,
  name: string,
  action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      let value: T;
      const request = action(transaction.objectStore(name));
      request.onsuccess = () => { value = request.result; };
      request.onerror = () => reject(request.error ?? new Error('本地草稿操作失败'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('本地草稿写入失败'));
      transaction.onabort = () => reject(transaction.error ?? new Error('本地草稿操作中止'));
    });
  } finally {
    db.close();
  }
}

export const localDrafts = {
  forPages: async (userId: string, workspaceId: string, pageIds: string[]): Promise<LocalPageDraft[]> => {
    const all = await operation<LocalPageDraft[]>('readonly', storeName, store => store.getAll());
    const ids = new Set(pageIds);
    return all.filter(draft => draft.userId === userId && draft.workspaceId === workspaceId && ids.has(draft.pageId));
  },
  get: (key: string) => operation<LocalPageDraft | undefined>('readonly', storeName, store => store.get(key)),
  forPage: async (userId: string, workspaceId: string, pageId: string): Promise<LocalPageDraft[]> => {
    const all = await operation<LocalPageDraft[]>('readonly', storeName, store => store.getAll());
    return all.filter(draft => draft.userId === userId && draft.workspaceId === workspaceId && draft.pageId === pageId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  put: (draft: LocalPageDraft) => operation<IDBValidKey>('readwrite', storeName, store => store.put(draft)),
  remove: (key: string) => operation<undefined>('readwrite', storeName, store => store.delete(key)),
  removeIfVersion: async (version: DraftVersion): Promise<boolean> => {
    const db = await database();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        let removed = false;
        const request = store.get(version.key);
        request.onsuccess = () => {
          const current = request.result as LocalPageDraft | undefined;
          if (current && sameDraftVersion(current, version)) {
            store.delete(version.key);
            removed = true;
          }
        };
        request.onerror = () => reject(request.error ?? new Error('本机草稿读取失败'));
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () => reject(transaction.error ?? new Error('本机草稿清理失败'));
        transaction.onabort = () => reject(transaction.error ?? new Error('本机草稿清理中止'));
      });
    } finally { db.close(); }
  },
  removeIfUnchanged: (draft: LocalPageDraft) => localDrafts.removeIfVersion(draftVersion(draft)),
  getCreate: (key: string) => operation<LocalPendingCreate | undefined>('readonly', createStoreName, store => store.get(key)),
  forScopeCreates: async (userId: string, workspaceId: string): Promise<LocalPendingCreate[]> => {
    const all = await operation<LocalPendingCreate[]>('readonly', createStoreName, store => store.getAll());
    return all.filter(pending => pending.userId === userId && pending.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  putCreate: (draft: LocalPendingCreate) => operation<IDBValidKey>('readwrite', createStoreName, store => store.put(draft)),
  removeCreate: (key: string) => operation<undefined>('readwrite', createStoreName, store => store.delete(key)),
  forScopeActions: async (userId: string, workspaceId: string): Promise<LocalPendingAction[]> => {
    const all = await operation<LocalPendingAction[]>('readonly', actionStoreName, store => store.getAll());
    return all.filter(item => item.userId === userId && item.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  putAction: (pending: LocalPendingAction) => operation<IDBValidKey>('readwrite', actionStoreName, store => store.put(pending)),
  removeAction: (key: string) => operation<undefined>('readwrite', actionStoreName, store => store.delete(key)),
};
