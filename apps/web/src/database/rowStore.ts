import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { applyRowPatch, databaseQueryWindow, flatFilters, type DatabaseQueryRequest, type DatabaseRow, type RowProperties } from '@nbase/contracts';
import { announceDatabaseChange, failureText, subscribeDatabase, type DatabaseDataSource, type RowPatch } from './source';

const cacheLimit = 3000;
const fetchDelayMs = 30;
const refreshDelayMs = 150;
const queryDelayMs = 200;

function newer(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/**
 * The rows of one view: the full id order, and only the row bodies around what is on screen. A row with a queued
 * write stays cached, so an edit can never be evicted. Own edits patch in place; the order is re-read on request.
 */
export class RowStore {
  order: string[] = [];
  total = 0;
  allRows = 0;
  loading = true;
  error = '';
  /** An edit may have changed which rows match or where they sort. */
  orderStale = false;
  pending: ReadonlySet<string> = new Set();

  private readonly rows = new Map<string, DatabaseRow>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly origin = Symbol('rows');
  private request: DatabaseQueryRequest | null = null;
  private titlePropertyId: string | null = null;
  private wanted: [number, number] = [0, databaseQueryWindow];
  private generation = 0;
  private version = 0;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly source: DatabaseDataSource, private readonly databaseId: string) {}

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
    };
  }

  rowAt(index: number): DatabaseRow | undefined {
    const id = this.order[index];
    return id === undefined ? undefined : this.rows.get(id);
  }

  rowById(id: string): DatabaseRow | undefined { return this.rows.get(id); }

  setQuery(request: DatabaseQueryRequest, titlePropertyId: string | null, immediate: boolean): void {
    this.request = request;
    this.titlePropertyId = titlePropertyId;
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
      this.total = result.total;
      this.allRows = result.allRows;
      this.error = '';
      this.orderStale = false;
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
      if (held && (this.queues.has(row.id) || newer(held.revision, row.revision))) continue;
      this.rows.delete(row.id);
      this.rows.set(row.id, row);
    }
    this.evict();
  }

  private evict(): void {
    if (this.rows.size <= cacheLimit) return;
    const visible = new Set(this.order.slice(this.wanted[0], this.wanted[1]));
    for (const id of this.rows.keys()) {
      if (this.rows.size <= cacheLimit) return;
      if (!this.queues.has(id) && !visible.has(id)) this.rows.delete(id);
    }
  }

  ensure(start: number, end: number): void {
    this.wanted = [start, end];
    this.scheduleFetch();
  }

  private scheduleFetch(): void {
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => { this.fetchTimer = null; void this.fetchMissing(); }, fetchDelayMs);
  }

  private async fetchMissing(): Promise<void> {
    const generation = this.generation;
    const missing = this.order.slice(this.wanted[0], this.wanted[1]).filter(id => !this.rows.has(id) && !this.inFlight.has(id));
    for (let index = 0; index < missing.length; index += databaseQueryWindow) {
      const ids = missing.slice(index, index + databaseQueryWindow);
      ids.forEach(id => this.inFlight.add(id));
      try {
        const rows = await this.source.readRows(this.databaseId, ids);
        this.merge(rows);
        this.emit();
      } catch (failure) {
        this.source.notice(failureText(failure, '部分行暂时无法读取。'));
        return;
      } finally { ids.forEach(id => this.inFlight.delete(id)); }
      if (generation !== this.generation) return;
    }
  }

  private setPending(keys: string[], on: boolean): void {
    const next = new Set(this.pending);
    for (const key of keys) { if (on) next.add(key); else next.delete(key); }
    this.pending = next;
  }

  private touchesView(patch: RowPatch): boolean {
    if (!this.request) return false;
    const used = new Set([...flatFilters(this.request.filters), ...this.request.sorts].map(item => item.propertyId));
    return (patch.title !== undefined && !!this.titlePropertyId && used.has(this.titlePropertyId))
      || Object.keys(patch.properties ?? {}).some(id => used.has(id));
  }

  private fail(failure: unknown, fallback: string): void {
    this.source.notice(failureText(failure, fallback));
    this.scheduleRefresh(0);
  }

  updateRow(rowId: string, patch: RowPatch): Promise<boolean> {
    const keys = [...(patch.title !== undefined ? [`${rowId}:title`] : []),
      ...Object.keys(patch.properties ?? {}).map(id => `${rowId}:${id}`)];
    this.setPending(keys, true);
    // Show the value right away, marked as unconfirmed, and replace it with the server's row.
    const current = this.rows.get(rowId);
    if (current) this.rows.set(rowId, { ...current, ...(patch.title !== undefined ? { title: patch.title } : {}),
      properties: patch.properties ? applyRowPatch(current.properties, patch.properties) : current.properties });
    if (this.touchesView(patch)) this.orderStale = true;
    this.emit();
    const previous = this.queues.get(rowId) ?? Promise.resolve();
    const run: Promise<boolean> = previous.catch(() => undefined).then(async () => {
      const row = this.rows.get(rowId);
      if (!row) return false;
      try {
        const saved = await this.source.updateRow(rowId, row.revision, patch);
        const latest = this.rows.get(rowId);
        if (latest) this.rows.set(rowId, { ...saved, title: latest.title, properties: latest.properties });
        announceDatabaseChange(this.databaseId, this.origin);
        return true;
      } catch (failure) {
        this.fail(failure, '修改未保存。');
        return false;
      } finally {
        this.setPending(keys, false);
        if (this.queues.get(rowId) === run) this.queues.delete(rowId);
        this.emit();
      }
    });
    this.queues.set(rowId, run);
    return run;
  }

  async createRow(title = '', properties: RowProperties = {}): Promise<DatabaseRow | null> {
    try {
      const row = await this.source.createRow(this.databaseId, title, properties);
      this.rows.set(row.id, row);
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

  async trashRow(rowId: string): Promise<void> {
    const row = this.rows.get(rowId);
    if (!row) return;
    try {
      await this.source.trashRow(row);
      this.order = this.order.filter(id => id !== rowId);
      this.total -= 1;
      this.allRows -= 1;
      this.rows.delete(rowId);
      this.emit();
      announceDatabaseChange(this.databaseId, this.origin);
    } catch (failure) { this.fail(failure, '删除未完成。'); }
  }
}

/** One store per database view; `request` is keyed by content, so an unchanged view does not re-query. */
export function useRowStore(source: DatabaseDataSource, databaseId: string, request: DatabaseQueryRequest | null,
  titlePropertyId: string | null): RowStore {
  const store = useMemo(() => new RowStore(source, databaseId), [source, databaseId]);
  useEffect(() => store.connect(), [store]);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const key = request ? JSON.stringify(request) : '';
  useEffect(() => {
    if (!request) return;
    // Typing in a filter should not query on every key; opening a view should not wait.
    store.setQuery(request, titlePropertyId, store.loading);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, titlePropertyId]);
  return store;
}
