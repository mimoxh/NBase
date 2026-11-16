import type { CalendarImportRequest } from '@nbase/contracts';

export interface PendingImportMutation {
  clientMutationId: string;
  target: CalendarImportRequest['target'];
  fileName: string;
  createdAt: string;
}

const storageKey = 'nbase.calendar.import-mutation';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The mutation id of an import attempt, persisted before the request is sent. When the response is lost,
 * the retry reuses the same id so the server can recognize the repeat instead of importing twice.
 */
export function loadPendingImport(storage: Store): PendingImportMutation | null {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<PendingImportMutation>;
    return typeof value.clientMutationId === 'string' && value.target && typeof value.target === 'object'
      && typeof value.fileName === 'string' && typeof value.createdAt === 'string'
      ? value as PendingImportMutation : null;
  } catch { return null; }
}

export function beginImportMutation(storage: Store, target: CalendarImportRequest['target'], fileName: string,
  id: string = crypto.randomUUID()): PendingImportMutation {
  const mutation: PendingImportMutation = { clientMutationId: id, target, fileName, createdAt: new Date().toISOString() };
  try { storage.setItem(storageKey, JSON.stringify(mutation)); } catch { /* A lost id only weakens retry dedupe. */ }
  return mutation;
}

export function clearPendingImport(storage: Store): void {
  try { storage.removeItem(storageKey); } catch { /* best effort */ }
}
