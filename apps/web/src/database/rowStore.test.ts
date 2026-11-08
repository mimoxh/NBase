import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseQueryRequest, DatabaseRow } from '@nbase/contracts';
import { RowStore } from './rowStore';
import type { DatabaseDataSource } from './source';

const propertyId = '11111111-1111-4111-8111-111111111111';
const titleId = '22222222-2222-4222-8222-222222222222';
const emptyRequest: DatabaseQueryRequest = { filters: [], sorts: [] };

function row(id: string, revision = '1', title = id): DatabaseRow {
  return { id, title, icon: null, properties: {}, revision, createdAt: '', updatedAt: '' };
}

function setup(ids: string[]) {
  const server = new Map(ids.map(id => [id, row(id)]));
  const source = {
    canWrite: true,
    query: vi.fn(async () => ({ order: [...server.keys()], total: server.size, allRows: server.size,
      rows: [...server.values()].slice(0, 200), schemaRevision: '1' })),
    readRows: vi.fn(async (_db: string, wanted: string[]) => wanted.flatMap(id => server.get(id) ? [server.get(id)!] : [])),
    updateRow: vi.fn(async (id: string, expected: string, patch: { title?: string }) => {
      const saved = { ...server.get(id)!, ...(patch.title !== undefined ? { title: patch.title } : {}), revision: String(Number(expected) + 1) };
      server.set(id, saved);
      return saved;
    }),
    createRow: vi.fn(async (_db: string, title: string) => { const created = row(`new-${server.size}`, '1', title); server.set(created.id, created); return created; }),
    bulk: vi.fn(async (_db: string, request: { operation: string; items?: { id: string }[]; ids?: string[] }) => {
      const ids = request.items?.map(item => item.id) ?? request.ids ?? [];
      if (request.operation === 'trash') ids.forEach(id => server.delete(id));
      return { pageId: 'db', rows: ids.map(id => ({ id, revision: '9', updatedAt: 'now' })) };
    }),
    moveRow: vi.fn(async () => undefined),
    trashRow: vi.fn(async (target: DatabaseRow) => { server.delete(target.id); }),
    notice: vi.fn(), openRow: vi.fn(), openDatabase: vi.fn(), load: vi.fn(), saveSchema: vi.fn(),
  };
  const store = new RowStore(source as unknown as DatabaseDataSource, 'db');
  return { source, store, server };
}

const flush = async () => { await vi.advanceTimersByTimeAsync(400); };

describe('row store', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('holds the whole order but fetches only the window it is asked for', async () => {
    const { store, source } = setup(Array.from({ length: 1000 }, (_, i) => `r${i}`));
    store.setQuery(emptyRequest, titleId, true);
    await flush();
    expect(store.order).toHaveLength(1000);
    expect(store.rowAt(0)?.id).toBe('r0');
    expect(store.rowAt(500)).toBeUndefined();
    store.ensure(500, 540);
    await flush();
    expect(store.rowAt(500)?.id).toBe('r500');
    expect(source.readRows).toHaveBeenCalledTimes(1);
    expect(source.readRows.mock.calls[0]![1]).toHaveLength(40);
  });

  it('keeps a row with a queued write through eviction and chains revisions', async () => {
    const { store, source } = setup(Array.from({ length: 4000 }, (_, i) => `r${i}`));
    store.setQuery(emptyRequest, titleId, true);
    await flush();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalUpdate = source.updateRow.getMockImplementation()!;
    source.updateRow.mockImplementationOnce(async (id, expected, patch) => { await gate; return originalUpdate(id, expected, patch); });
    const first = store.updateRow('r0', { title: '第一次' });
    const second = store.updateRow('r0', { title: '第二次' });
    expect(store.rowAt(0)?.title).toBe('第二次');
    // Scrolling far away pushes the cache past its limit while the write is still open.
    for (let start = 200; start < 3800; start += 200) { store.ensure(start, start + 200); await flush(); }
    expect(store.rowAt(0)?.title).toBe('第二次');
    release();
    await Promise.all([first, second]);
    expect(source.updateRow.mock.calls.map(call => call[1])).toEqual(['1', '2']);
    expect(store.rowAt(0)?.revision).toBe('3');
  });

  it('does not let an older server row replace a newer one', async () => {
    const { store, server } = setup(['a']);
    store.setQuery(emptyRequest, titleId, true);
    await flush();
    await store.updateRow('a', { title: '新' });
    server.set('a', row('a', '1', '旧'));
    await store.refresh();
    expect(store.rowAt(0)?.title).toBe('新');
  });

  it('splices order locally for inserts, moves and trash', async () => {
    const { store, source } = setup(['a', 'b', 'c']);
    store.setQuery(emptyRequest, titleId, true);
    await flush();
    await store.createRow('新');
    expect(store.order).toEqual(['a', 'b', 'c', 'new-3']);
    expect(store.total).toBe(4);
    await store.moveRow('c', null);
    expect(store.order).toEqual(['c', 'a', 'b', 'new-3']);
    expect(source.moveRow).toHaveBeenCalledWith('db', 'c', null);
    await store.trashRow('a');
    expect(store.order).toEqual(['c', 'b', 'new-3']);
    expect(store.allRows).toBe(3);
    expect(source.query).toHaveBeenCalledTimes(1);
  });

  it('marks the order stale only when an edit touches a field the view uses', async () => {
    const { store } = setup(['a']);
    store.setQuery({ filters: [{ propertyId, operator: 'is_empty' }], sorts: [] }, titleId, true);
    await flush();
    await store.updateRow('a', { title: '无关' });
    expect(store.orderStale).toBe(false);
    await store.updateRow('a', { properties: { [propertyId]: 'x' } });
    expect(store.orderStale).toBe(true);
    await store.refresh();
    expect(store.orderStale).toBe(false);
  });

  it('sends bulk writes in chunks and takes the new revisions', async () => {
    const { store, source } = setup(Array.from({ length: 450 }, (_, i) => `r${i}`));
    store.setQuery(emptyRequest, titleId, true);
    await flush();
    const progress: number[] = [];
    const done = store.patchRows(store.order.map(id => ({ id, title: '批量' })), value => progress.push(value));
    await vi.runAllTimersAsync();
    expect(await done).toBe(true);
    expect(source.bulk.mock.calls.length).toBeGreaterThan(1);
    expect(source.bulk.mock.calls.every(call => (call[1].items?.length ?? 0) <= 500)).toBe(true);
    expect(progress.at(-1)).toBe(450);
    expect(store.rowAt(0)).toMatchObject({ title: '批量', revision: '9' });

    const trashed = store.trashRows(['r0', 'r1']);
    await vi.runAllTimersAsync();
    expect(await trashed).toBe(true);
    expect(store.total).toBe(448);
    expect(store.rowAt(0)?.id).toBe('r2');
  });

  it('reports a failed save and re-reads', async () => {
    const { store, source } = setup(['a']);
    store.setQuery(emptyRequest, titleId, true);
    await flush();
    source.updateRow.mockRejectedValueOnce(Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' }));
    expect(await store.updateRow('a', { title: 'x' })).toBe(false);
    expect(source.notice).toHaveBeenCalledWith('数据已在别处修改，已重新载入最新内容。');
    await flush();
    expect(source.query).toHaveBeenCalledTimes(2);
  });
});
