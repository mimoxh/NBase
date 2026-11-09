import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatabaseAggregateRequest, DatabaseAggregateResponse, DatabaseBulkRequest, DatabaseBulkResponse, DatabaseDocument, DatabaseQueryRequest, DatabaseQueryResponse, DatabaseRow, DatabaseSchemaResponse, DatabaseView,
  PropertyDefinition, PropertyValue, RowProperties } from '@nbase/contracts';

export interface RowPatch {
  title?: string;
  properties?: Record<string, PropertyValue | null>;
}

export interface DatabaseSchema {
  properties: PropertyDefinition[];
  views: DatabaseView[];
}

/**
 * Storage behind a database view. The persistent workspace talks to the API; the demo
 * keeps everything in session memory. Views never write rows or schemas any other way.
 */
export interface DatabaseDataSource {
  readonly canWrite: boolean;
  /** Schema and views; rows come from `query`. */
  load(databaseId: string, signal?: AbortSignal): Promise<DatabaseDocument>;
  query(databaseId: string, request: DatabaseQueryRequest): Promise<DatabaseQueryResponse>;
  readRows(databaseId: string, ids: string[]): Promise<DatabaseRow[]>;
  bulk(databaseId: string, request: DatabaseBulkRequest): Promise<DatabaseBulkResponse>;
  aggregate(databaseId: string, request: DatabaseAggregateRequest): Promise<DatabaseAggregateResponse>;
  saveSchema(databaseId: string, schema: DatabaseSchema, expectedRevision: string): Promise<DatabaseSchemaResponse>;
  createRow(databaseId: string, title: string, properties: RowProperties): Promise<DatabaseRow>;
  updateRow(rowId: string, expectedRevision: string, patch: RowPatch): Promise<DatabaseRow>;
  moveRow(databaseId: string, rowId: string, afterRowId: string | null): Promise<void>;
  trashRow(row: DatabaseRow): Promise<void>;
  /** Builds and downloads a ZIP of the rows' bodies with the given CSV. Absent where bodies cannot be packaged. */
  packageRows?(doc: DatabaseDocument, rows: DatabaseRow[], csv: string): Promise<void>;
  openRow(rowId: string): void;
  openDatabase(databaseId: string): void;
  notice(text: string): void;
}

export class DatabaseSourceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type Listener = (origin: symbol) => void;
const listeners = new Map<string, Set<Listener>>();

/** Tells other open views of the same database (a page and an inline block) to reload. */
export function announceDatabaseChange(databaseId: string, origin: symbol = Symbol('external')): void {
  for (const listener of listeners.get(databaseId) ?? []) listener(origin);
}

export function subscribeDatabase(databaseId: string, listener: Listener): () => void {
  const set = listeners.get(databaseId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(databaseId, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(databaseId); };
}

const exportRequests = new Map<string, Set<() => void>>();

/** Lets the page menu open the export menu of a database shown below it. */
export function requestDatabaseExport(databaseId: string): void {
  for (const listener of exportRequests.get(databaseId) ?? []) listener();
}

export function subscribeDatabaseExport(databaseId: string, listener: () => void): () => void {
  const set = exportRequests.get(databaseId) ?? new Set();
  set.add(listener);
  exportRequests.set(databaseId, set);
  return () => { set.delete(listener); if (!set.size) exportRequests.delete(databaseId); };
}

const conflictCodes = new Set(['REVISION_CONFLICT', 'MUTATION_CONFLICT']);

export function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

export function failureText(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (conflictCodes.has(code)) return '数据已在别处修改，已重新载入最新内容。';
  if (code === 'PROPERTY_INVALID') return '这个值不符合字段设置，未保存。';
  if (code === 'DATABASE_ROW_LIMIT') return '这个数据库已达到行数上限。';
  if (code === 'DATABASE_SCHEMA_INVALID') return '字段或视图设置无效，未保存。';
  if (code === 'TIMEOUT' || code === 'NETWORK_UNAVAILABLE') return '网络不可用，修改未确认，已重新载入。';
  if (code === 'FORBIDDEN') return '没有修改权限。';
  return error instanceof Error && error.message && !/^[A-Z_]+$/.test(error.message) ? error.message : fallback;
}

export interface DatabaseState {
  doc: DatabaseDocument | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  saveSchema: (schema: DatabaseSchema) => Promise<boolean>;
}

/** Loads one database's schema and serializes its saves, always with the latest revision. Rows live in `RowStore`. */
export function useDatabase(source: DatabaseDataSource, databaseId: string): DatabaseState {
  const [doc, setDocState] = useState<DatabaseDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const docRef = useRef<DatabaseDocument | null>(null);
  const origin = useRef(Symbol('view')).current;
  const sequence = useRef(0);
  const desiredSchema = useRef<DatabaseSchema | null>(null);
  const schemaBusy = useRef(false);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const setDoc = useCallback((next: DatabaseDocument | null) => { docRef.current = next; setDocState(next); }, []);

  const reload = useCallback(async () => {
    const run = ++sequence.current;
    try {
      const loaded = await sourceRef.current.load(databaseId);
      if (run !== sequence.current) return;
      setDoc(loaded); setError('');
    } catch (failure) {
      if (run !== sequence.current) return;
      const code = errorCode(failure);
      setError(code === 'NOT_FOUND' ? '数据库不存在或已移入回收站。' : failureText(failure, '数据库暂时无法读取。'));
    } finally { if (run === sequence.current) setLoading(false); }
  }, [databaseId, setDoc]);

  useEffect(() => {
    setLoading(true); setDoc(null); setError('');
    void reload();
    return subscribeDatabase(databaseId, from => { if (from !== origin) void reload(); });
  }, [databaseId, reload, origin, setDoc]);

  const fail = useCallback((failure: unknown, fallback: string) => {
    sourceRef.current.notice(failureText(failure, fallback));
    void reload();
  }, [reload]);

  const schemaWaiters = useRef<((saved: boolean) => void)[]>([]);
  const flushSchema = useCallback(async () => {
    if (schemaBusy.current || !desiredSchema.current || !docRef.current) return;
    const body = desiredSchema.current;
    desiredSchema.current = null;
    schemaBusy.current = true;
    let saved = false;
    try {
      const result = await sourceRef.current.saveSchema(databaseId, body, docRef.current.schemaRevision);
      if (docRef.current) setDoc({ ...docRef.current, schemaRevision: result.schemaRevision,
        ...(desiredSchema.current ? {} : { properties: result.properties, views: result.views }) });
      announceDatabaseChange(databaseId, origin);
      saved = true;
    } catch (failure) {
      desiredSchema.current = null;
      fail(failure, '字段或视图设置未保存。');
    } finally {
      schemaBusy.current = false;
      if (saved && desiredSchema.current) void flushSchema();
      else {
        const waiters = schemaWaiters.current;
        schemaWaiters.current = [];
        for (const resolve of waiters) resolve(saved);
      }
    }
  }, [databaseId, fail, origin, setDoc]);

  /** Resolves once this schema (or a later one that replaced it) is confirmed. */
  const saveSchema = useCallback((schema: DatabaseSchema): Promise<boolean> => {
    if (!docRef.current || !sourceRef.current.canWrite) return Promise.resolve(false);
    setDoc({ ...docRef.current, ...schema });
    desiredSchema.current = schema;
    const done = new Promise<boolean>(resolve => schemaWaiters.current.push(resolve));
    void flushSchema();
    return done;
  }, [flushSchema, setDoc]);

  return { doc, loading, error, reload, saveSchema };
}
