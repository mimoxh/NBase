import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { applyRowPatch, databaseBulkLimit, databaseQueryWindow, flatFilters, type BulkRowPatch, type DatabaseQueryRequest, type DatabaseRow,
  type DatabaseRowGroup, type PropertyValue, type RowProperties } from '@nbase/contracts';
import { announceDatabaseChange, failureText, subscribeDatabase, type DatabaseDataSource, type RowPatch } from './source';

const cacheLimit = 3000;
const fetchDelayMs = 30;
const refreshDelayMs = 150;
const queryDelayMs = 200;
const computingPollMs = 2000;
const bulkStartChunk = 200;
const bulkMaxBytes = 1_500_000;
const bulkFastMs = 200;
const bulkSlowMs = 800;
const encoder = new TextEncoder();

function newer(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/**
 * The rows of one view: the full id order, and only the row bodies around what is on screen. A row with a queued
 * write stays cached, so an edit can never be evicted. Own edits patch in place; the order is re-read on request.
 */
export class RowStore {
  order: string[] = [];
  /** Board columns, when the query asked for them. */
  groups: DatabaseRowGroup[] = [];
  total = 0;
  allRows = 0;
  loading = true;
  error = '';
  /** An edit may have changed which rows match or where they sort. */
  orderStale = false;
  /** The view depends on formulas or rollups that are still being recalculated. */
  computing = false;
  pending: ReadonlySet<string> = new Set();

  private readonly rows = new Map<string, DatabaseRow>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private rowReads = { fresh: new Set<string>(), inFlight: new Set<string>() };
  private readonly listeners = new Set<() => void>();
  private readonly origin = Symbol('rows');
  private request: DatabaseQueryRequest | null = null;
  private titlePropertyId: string | null = null;
  private computedIds: string[] = [];
  private wanted: [number, number] = [0, databaseQueryWindow];
  private wantedIds: string[] = [];
  private generation = 0;
  private version = 0;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly source: DatabaseDataSource, readonly databaseId: string) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;

  private emit(): void { this.version += 1; for (const listener of this.listeners) listener(); }

  /** Follows changes made by other views of this database. */
  connect(): () => void {
    const unsubscribe = subscribeDatabase(this.databaseId, from => { if (from !== this.origin) this.scheduleRefresh(refreshDelayMs); });
    return () => {
      unsubscribe();
      if (this.fetchTimer) clearTimeout(this.fetchTimer);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.generation += 1;
      this.rowReads = { fresh: new Set(), inFlight: new Set() };
    };
  }

  rowAt(index: number): DatabaseRow | undefined {
    const id = this.order[index];
    return id === undefined ? undefined : this.rows.get(id);
  }

  rowById(id: string): DatabaseRow | undefined { return this.rows.get(id); }

  setQuery(request: DatabaseQueryRequest, titlePropertyId: string | null, immediate: boolean, computedIds: string[] = []): void {
    this.request = request;
    this.titlePropertyId = titlePropertyId;
    this.computedIds = computedIds;
    this.scheduleRefresh(immediate ? 0 : queryDelayMs);
  }

  refresh(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    return this.run();
  }

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.run(); }, delay);
  }

  private async run(): Promise<void> {
    if (!this.request) return;
    const generation = ++this.generation;
    try {
      const result = await this.source.query(this.databaseId, this.request);
      if (generation !== this.generation) return;
      this.order = result.order;
      this.groups = result.groups ?? [];
      this.total = result.total;
      this.allRows = result.allRows;
      this.error = '';
      this.orderStale = false;
      this.computing = Boolean(result.computedStale) && this.usesComputed();
      if (this.computing) this.scheduleRefresh(computingPollMs);
      // Keep cached rows visible, but only the bodies from this query are current.
      this.rowReads = { fresh: new Set(), inFlight: new Set() };
      this.merge(result.rows);
    } catch (failure) {
      if (generation !== this.generation) return;
      this.error = failureText(failure, '数据库暂时无法读取。');
    }
    this.loading = false;
    this.emit();
    this.scheduleFetch();
  }

  /** Server rows replace cached ones, except rows with queued writes and anything older than what is held. */
  private merge(rows: DatabaseRow[]): void {
    for (const row of rows) {
      const held = this.rows.get(row.id);
      if (this.queues.has(row.id)) continue;
      this.rowReads.fresh.add(row.id);
      if (held && newer(held.revision, row.revision)) continue;
      this.rows.delete(row.id);
      this.rows.set(row.id, row);
    }
    this.evict();
  }

  private dropRow(id: string): void {
    this.rows.delete(id);
    this.rowReads.fresh.delete(id);
  }

  private evict(): void {
    if (this.rows.size <= cacheLimit) return;
    const visible = new Set([...this.order.slice(this.wanted[0], this.wanted[1]), ...this.wantedIds]);
    for (const id of this.rows.keys()) {
      if (this.rows.size <= cacheLimit) return;
      if (!this.queues.has(id) && !visible.has(id)) this.dropRow(id);
    }
  }

  ensure(start: number, end: number): void {
    this.wanted = [start, end];
    this.wantedIds = [];
    this.scheduleFetch();
  }

  /** Board columns ask for specific rows rather than a range of the flat order. */
  ensureIds(ids: string[]): void {
    this.wanted = [0, 0];
    this.wantedIds = ids;
    this.scheduleFetch();
  }

  /** Moves a card between board columns, writing the new group value. */
  moveToGroup(rowId: string, toKey: string | null, propertyId: string, value: PropertyValue | null): Promise<boolean> {
    this.groups = this.placeInGroup(this.groups.map(group => ({ ...group, ids: group.ids.filter(id => id !== rowId) })), rowId, toKey);
    return this.updateRow(rowId, { properties: { [propertyId]: value } });
  }

  private placeInGroup(groups: DatabaseRowGroup[], rowId: string, key: string | null): DatabaseRowGroup[] {
    return groups.some(group => group.key === key)
      ? groups.map(group => group.key === key ? { ...group, ids: [rowId, ...group.ids] } : group)
      : [...groups, { key, ids: [rowId] }];
  }

  private scheduleFetch(): void {
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => { this.fetchTimer = null; void this.fetchWindow(); }, fetchDelayMs);
  }

  private async fetchWindow(): Promise<void> {
    const reads = this.rowReads;
    const wanted = [...this.order.slice(this.wanted[0], this.wanted[1]), ...this.wantedIds];
    for (let index = 0; index < wanted.length; index += databaseQueryWindow) {
      const ids = wanted.slice(index, index + databaseQueryWindow)
        .filter(id => !reads.fresh.has(id) && !reads.inFlight.has(id) && !this.queues.has(id));
      if (!ids.length) continue;
      ids.forEach(id => reads.inFlight.add(id));
      try {
        const rows = await this.source.readRows(this.databaseId, ids);
        if (reads !== this.rowReads) return;
        this.merge(rows);
        this.emit();
      } catch (failure) {
        if (reads === this.rowReads) this.source.notice(failureText(failure, '部分行暂时无法读取。'));
        return;
      } finally { ids.forEach(id => reads.inFlight.delete(id)); }
    }
  }

  private setPending(keys: string[], on: boolean): void {
    const next = new Set(this.pending);
    for (const key of keys) { if (on) next.add(key); else next.delete(key); }
    this.pending = next;
  }

  private usedProperties(): Set<string> {
    return new Set(this.request ? [...flatFilters(this.request.filters), ...this.request.sorts].map(item => item.propertyId) : []);
  }

  private usesComputed(): boolean {
    const used = this.usedProperties();
    return this.computedIds.some(id => used.has(id));
  }

  /** Formula and rollup cells depend on the server, so a saved row is read back. */
  private refreshComputed(rowId: string): void {
    if (!this.computedIds.length) return;
    const reads = this.rowReads;
    this.source.readRows(this.databaseId, [rowId]).then(rows => {
      if (reads !== this.rowReads) return;
      this.merge(rows);
      this.emit();
    }).catch(() => undefined);
  }

  private touchesView(patch: RowPatch): boolean {
    if (!this.request) return false;
    const used = this.usedProperties();
    if (this.usesComputed()) return true;
    return (patch.title !== undefined && !!this.titlePropertyId && used.has(this.titlePropertyId))
      || patch.tagIds !== undefined || Object.keys(patch.properties ?? {}).some(id => used.has(id));
  }

  private fail(failure: unknown, fallback: string): void {
    this.source.notice(failureText(failure, fallback));
    this.scheduleRefresh(0);
  }

  private finishWrites(ids: string[], write: Promise<unknown>): void {
    let needsFetch = false;
    for (const id of ids) {
      if (this.queues.get(id) !== write) continue;
      this.queues.delete(id);
      if (!this.rowReads.fresh.has(id)) needsFetch = true;
    }
    if (needsFetch) this.scheduleFetch();
  }

  updateRow(rowId: string, patch: RowPatch): Promise<boolean> {
    const keys = [...(patch.title !== undefined ? [`${rowId}:title`] : []),
      ...Object.keys(patch.properties ?? {}).map(id => `${rowId}:${id}`)];
    this.setPending(keys, true);
    // Show the value right away, marked as unconfirmed, and replace it with the server's row.
    const current = this.rows.get(rowId);
    if (current) this.rows.set(rowId, { ...current, ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.tagIds !== undefined ? { tagIds: patch.tagIds } : {}),
      properties: patch.properties ? applyRowPatch(current.properties, patch.properties) : current.properties });
    if (this.touchesView(patch)) this.orderStale = true;
    this.emit();
    const previous = this.queues.get(rowId) ?? Promise.resolve();
    const run: Promise<boolean> = previous.catch(() => undefined).then(async () => {
      try {
        const row = this.rows.get(rowId);
        if (!row) return false;
        const saved = await this.source.updateRow(rowId, row.revision, patch);
        const latest = this.rows.get(rowId);
        if (latest) this.rows.set(rowId, { ...saved, title: latest.title, properties: latest.properties,
          ...(latest.tagIds ? { tagIds: latest.tagIds } : {}),
          ...(latest.relations ? { relations: latest.relations } : {}), ...(latest.computed ? { computed: latest.computed } : {}) });
        announceDatabaseChange(this.databaseId, this.origin);
        this.refreshComputed(rowId);
        return true;
      } catch (failure) {
        this.fail(failure, '修改未保存。');
        return false;
      } finally {
        this.setPending(keys, false);
        this.finishWrites([rowId], run);
        this.emit();
      }
    });
    this.queues.set(rowId, run);
    return run;
  }

  async createRow(title = '', properties: RowProperties = {}, groupKey?: string | null): Promise<DatabaseRow | null> {
    try {
      const row = await this.source.createRow(this.databaseId, title, properties);
      this.rows.set(row.id, row);
      if (groupKey !== undefined) this.groups = this.placeInGroup(this.groups, row.id, groupKey);
      if (!this.order.includes(row.id)) {
        this.order = [...this.order, row.id];
        this.total += 1;
        this.allRows += 1;
      }
      if (this.request && (this.request.filters.length || this.request.sorts.length)) this.orderStale = true;
      this.emit();
      announceDatabaseChange(this.databaseId, this.origin);
      return row;
    } catch (failure) { this.fail(failure, '新行未创建。'); return null; }
  }

  async moveRow(rowId: string, afterRowId: string | null): Promise<void> {
    const rest = this.order.filter(id => id !== rowId);
    const index = afterRowId === null ? 0 : rest.indexOf(afterRowId) + 1;
    this.order = [...rest.slice(0, index), rowId, ...rest.slice(index)];
    this.emit();
    try {
      await this.source.moveRow(this.databaseId, rowId, afterRowId);
      announceDatabaseChange(this.databaseId, this.origin);
    } catch (failure) { this.fail(failure, '行顺序未保存。'); }
  }

  /** Sends items in chunks small enough to keep the workspace free for other saves, slowing down if a chunk runs long. */
  private async inChunks<T>(items: T[], send: (chunk: T[]) => Promise<void>, onProgress?: (done: number) => void): Promise<void> {
    let size = bulkStartChunk;
    let index = 0;
    while (index < items.length) {
      let end = index;
      let bytes = 0;
      while (end < items.length && end - index < size) {
        bytes += encoder.encode(JSON.stringify(items[end])).length;
        if (end > index && bytes > bulkMaxBytes) break;
        end += 1;
      }
      const started = performance.now();
      await send(items.slice(index, end));
      const elapsed = performance.now() - started;
      size = elapsed < bulkFastMs ? Math.min(databaseBulkLimit, Math.ceil(size * 1.5)) : elapsed > bulkSlowMs ? Math.max(50, Math.floor(size / 2)) : size;
      index = end;
      onProgress?.(index);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  private async settled(ids: string[]): Promise<void> {
    await Promise.allSettled(ids.flatMap(id => { const queue = this.queues.get(id); return queue ? [queue] : []; }));
  }

  /** Writes many rows at once. Hydrated rows change right away; a failure re-reads the view. */
  patchRows(items: BulkRowPatch[], onProgress?: (done: number) => void): Promise<boolean> {
    const ids = items.map(item => item.id);
    const previous = this.settled(ids);
    let stale = false;
    for (const item of items) {
      const current = this.rows.get(item.id);
      if (current) this.rows.set(item.id, { ...current, ...(item.title !== undefined ? { title: item.title } : {}),
        properties: item.properties ? applyRowPatch(current.properties, item.properties) : current.properties });
      stale = stale || this.touchesView(item);
    }
    if (stale) this.orderStale = true;
    const run = previous.then(async () => {
      try {
        await this.inChunks(items, async chunk => {
          const result = await this.source.bulk(this.databaseId, { clientMutationId: crypto.randomUUID(), operation: 'patch', items: chunk });
          for (const saved of result.rows) {
            const current = this.rows.get(saved.id);
            if (current && !newer(current.revision, saved.revision)) this.rows.set(saved.id, { ...current, revision: saved.revision, updatedAt: saved.updatedAt });
          }
        }, onProgress);
        announceDatabaseChange(this.databaseId, this.origin);
        if (this.computedIds.length) void this.refresh();
        return true;
      } catch (failure) { this.fail(failure, '批量修改未全部完成。'); return false; }
      finally { this.finishWrites(ids, run); }
    });
    // The same per-row queue protects optimistic values from reads and orders subsequent writes.
    for (const id of ids) this.queues.set(id, run);
    this.emit();
    return run;
  }

  /**
   * Creates rows from fixed chunks with fixed mutation ids, so resuming after a failure cannot create a row
   * twice. Returns how many chunks are done.
   */
  async importChunks(chunks: { title: string; properties: RowProperties }[][], mutationIds: string[], from: number,
    onProgress: (done: number) => void): Promise<number> {
    let done = from;
    try {
      for (; done < chunks.length; done += 1) {
        await this.source.bulk(this.databaseId, { clientMutationId: mutationIds[done]!, operation: 'create', rows: chunks[done]! });
        onProgress(done + 1);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (failure) {
      this.source.notice(failureText(failure, '导入中断。'));
    }
    await this.refresh();
    announceDatabaseChange(this.databaseId, this.origin);
    return done;
  }

  async trashRows(ids: string[], onProgress?: (done: number) => void): Promise<boolean> {
    await this.settled(ids);
    const gone = new Set<string>();
    try {
      await this.inChunks(ids, async chunk => {
        const result = await this.source.bulk(this.databaseId, { clientMutationId: crypto.randomUUID(), operation: 'trash', ids: chunk });
        for (const saved of result.rows) { gone.add(saved.id); this.dropRow(saved.id); }
        this.order = this.order.filter(id => !gone.has(id));
        this.total = this.order.length;
        this.allRows -= result.rows.length;
        gone.clear();
        this.emit();
      }, onProgress);
      announceDatabaseChange(this.databaseId, this.origin);
      return true;
    } catch (failure) { this.fail(failure, '批量删除未全部完成。'); return false; }
  }

  /** Copies rows; the copies join the view on the following read. */
  async duplicateRows(ids: string[], placeNextToSource: boolean, onProgress?: (done: number) => void): Promise<string[]> {
    const created: string[] = [];
    try {
      await this.inChunks(ids, async chunk => {
        const result = await this.source.bulk(this.databaseId, { clientMutationId: crypto.randomUUID(), operation: 'duplicate', ids: chunk });
        created.push(...result.rows.map(row => row.id));
      }, onProgress);
      if (ids.length === 1 && created[0] && placeNextToSource) await this.source.moveRow(this.databaseId, created[0], ids[0]!);
      await this.refresh();
      announceDatabaseChange(this.databaseId, this.origin);
    } catch (failure) { this.fail(failure, '复制未全部完成。'); }
    return created;
  }

  /** Links or unlinks rows from either side of a relation. Throws so the picker can report a failure. */
  async changeRelation(rowId: string, propertyId: string, add: string[], remove: string[]): Promise<void> {
    await this.settled([rowId]);
    const result = await this.source.changeRelation(this.databaseId, rowId, propertyId, { clientMutationId: crypto.randomUUID(), add, remove });
    this.rows.set(rowId, result.row);
    for (const saved of result.touched) {
      const current = this.rows.get(saved.id);
      if (current && saved.id !== rowId) this.rows.set(saved.id, { ...current, revision: saved.revision, updatedAt: saved.updatedAt });
    }
    if (this.request && [...flatFilters(this.request.filters), ...this.request.sorts].some(item => item.propertyId === propertyId)) this.orderStale = true;
    this.emit();
    // In a self-relation the other end is in this table too, so those rows are read again.
    if (result.otherDatabaseId === this.databaseId) {
      for (const id of [...add, ...remove]) { if (id !== rowId && !this.queues.has(id)) this.dropRow(id); }
      this.scheduleFetch();
    }
    announceDatabaseChange(this.databaseId, this.origin);
    if (result.otherDatabaseId !== this.databaseId) announceDatabaseChange(result.otherDatabaseId);
  }

  async trashRow(rowId: string): Promise<void> {
    const row = this.rows.get(rowId);
    if (!row) return;
    try {
      await this.source.trashRow(row);
      this.order = this.order.filter(id => id !== rowId);
      this.total -= 1;
      this.allRows -= 1;
      this.dropRow(rowId);
      this.emit();
      announceDatabaseChange(this.databaseId, this.origin);
    } catch (failure) { this.fail(failure, '删除未完成。'); }
  }
}

/** One store per database view; `request` is keyed by content, so an unchanged view does not re-query. */
export function useRowStore(source: DatabaseDataSource, databaseId: string, request: DatabaseQueryRequest | null,
  titlePropertyId: string | null, computedIds = ''): RowStore {
  const store = useMemo(() => new RowStore(source, databaseId), [source, databaseId]);
  useEffect(() => store.connect(), [store]);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const key = request ? JSON.stringify(request) : '';
  useEffect(() => {
    if (!request) return;
    // Typing in a filter should not query on every key; opening a view should not wait.
    store.setQuery(request, titlePropertyId, store.loading, computedIds ? computedIds.split(',') : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, titlePropertyId, computedIds]);
  return store;
}
