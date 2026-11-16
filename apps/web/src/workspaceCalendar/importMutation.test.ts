import { describe, expect, it } from 'vitest';
import { beginImportMutation, clearPendingImport, loadPendingImport } from './importMutation';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe('import mutation persistence', () => {
  it('returns the same mutation id after a reload, so a lost response can be retried', () => {
    const storage = memoryStorage();
    const mutation = beginImportMutation(storage, { parentId: null, name: '团队日历' }, 'team.ics', 'fixed-id');
    expect(mutation.clientMutationId).toBe('fixed-id');
    expect(loadPendingImport(storage)).toEqual(mutation);
  });

  it('clears the record after a confirmed result', () => {
    const storage = memoryStorage();
    beginImportMutation(storage, { databaseId: 'db-1' }, 'team.ics');
    clearPendingImport(storage);
    expect(loadPendingImport(storage)).toBeNull();
  });

  it('treats corrupt or partial data as no pending import', () => {
    const storage = memoryStorage();
    storage.setItem('nbase.calendar.import-mutation', '{not json');
    expect(loadPendingImport(storage)).toBeNull();
    storage.setItem('nbase.calendar.import-mutation', '{"clientMutationId":1}');
    expect(loadPendingImport(storage)).toBeNull();
  });
});
