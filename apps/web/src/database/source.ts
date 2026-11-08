import { useCallback, useEffect, useRef, useState } from 'react';
import { applyRowPatch, type DatabaseDocument, type DatabaseRow, type DatabaseSchemaResponse, type DatabaseView,
  type PropertyDefinition, type PropertyValue, type RowProperties } from '@nbase/contracts';

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
  load(databaseId: string, signal?: AbortSignal): Promise<DatabaseDocument>;
  saveSchema(databaseId: string, schema: DatabaseSchema, expectedRevision: string): Promise<DatabaseSchemaResponse>;
  createRow(databaseId: string, title: string, properties: RowProperties): Promise<DatabaseRow>;
  updateRow(rowId: string, expectedRevision: string, patch: RowPatch): Promise<DatabaseRow>;
  moveRow(databaseId: string, rowId: string, afterRowId: string | null): Promise<void>;
  trashRow(row: DatabaseRow): Promise<void>;
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

function subscribe(databaseId: string, listener: Listener): () => void {
  const set = listeners.get(databaseId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(databaseId, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(databaseId); };
}

const conflictCodes = new Set(['REVISION_CONFLICT', 'MUTATION_CONFLICT']);

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

function failureText(error: unknown, fallback: string): string {
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
  /** Cells whose new value waits for the server: `${rowId}:${propertyId}` or `${rowId}:title`. */
  pending: ReadonlySet<string>;
  reload: () => Promise<void>;
  saveSchema: (schema: DatabaseSchema) => Promise<boolean>;
  updateRow: (rowId: string, patch: RowPatch) => Promise<boolean>;
  createRow: (title?: string, properties?: RowProperties) => Promise<DatabaseRow | null>;
  moveRow: (rowId: string, afterRowId: string | null) => Promise<void>;
  trashRow: (rowId: string) => Promise<void>;
}

/**
 * Loads one database and serializes its writes: schema saves go one at a time with the latest
 * revision, and each row has its own queue so a second edit waits for the first revision.
 */
export function useDatabase(source: DatabaseDataSource, databaseId: string): DatabaseState {
  const [doc, setDocState] = useState<DatabaseDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const docRef = useRef<DatabaseDocument | null>(null);
  const origin = useRef(Symbol('view')).current;
  const sequence = useRef(0);
  const desiredSchema = useRef<DatabaseSchema | null>(null);
  const schemaBusy = useRef(false);
  const rowQueues = useRef(new Map<string, Promise<unknown>>());
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
    return subscribe(databaseId, from => { if (from !== origin) void reload(); });
  }, [databaseId, reload, origin, setDoc]);

  const fail = useCallback((failure: unknown, fallback: string) => {
    sourceRef.current.notice(failureText(failure, fallback));
    void reload();
  }, [reload]);

  const markPending = (keys: string[], on: boolean) => setPending(previous => {
    const next = new Set(previous);
    for (const key of keys) { if (on) next.add(key); else next.delete(key); }
    return next;
  });

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

  const updateRow = useCallback((rowId: string, patch: RowPatch): Promise<boolean> => {
    const keys = [...(patch.title !== undefined ? [`${rowId}:title`] : []),
      ...Object.keys(patch.properties ?? {}).map(id => `${rowId}:${id}`)];
    markPending(keys, true);
    // Show the value right away, marked as unconfirmed, and replace it with the server's row.
    const current = docRef.current;
    if (current) setDoc({ ...current, rows: current.rows.map(row => row.id !== rowId ? row : {
      ...row, ...(patch.title !== undefined ? { title: patch.title } : {}),
      properties: patch.properties ? applyRowPatch(row.properties, patch.properties) : row.properties,
    }) });
    const previous = rowQueues.current.get(rowId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const row = docRef.current?.rows.find(item => item.id === rowId);
      if (!row) return false;
      try {
        const saved = await sourceRef.current.updateRow(rowId, row.revision, patch);
        const latest = docRef.current;
        if (latest) setDoc({ ...latest, rows: latest.rows.map(item => item.id === rowId
          ? { ...saved, title: item.title, properties: item.properties } : item) });
        announceDatabaseChange(databaseId, origin);
        return true;
      } catch (failure) {
        fail(failure, '修改未保存。');
        return false;
      } finally { markPending(keys, false); }
    });
    rowQueues.current.set(rowId, run);
    return run;
  }, [databaseId, fail, origin, setDoc]);

  const createRow = useCallback(async (title = '', properties: RowProperties = {}) => {
    try {
      const row = await sourceRef.current.createRow(databaseId, title, properties);
      const latest = docRef.current;
      if (latest && !latest.rows.some(item => item.id === row.id)) setDoc({ ...latest, rows: [...latest.rows, row] });
      announceDatabaseChange(databaseId, origin);
      return row;
    } catch (failure) { fail(failure, '新行未创建。'); return null; }
  }, [databaseId, fail, origin, setDoc]);

  const moveRow = useCallback(async (rowId: string, afterRowId: string | null) => {
    const current = docRef.current;
    if (!current) return;
    const moving = current.rows.find(row => row.id === rowId);
    if (!moving) return;
    const rest = current.rows.filter(row => row.id !== rowId);
    const index = afterRowId === null ? 0 : rest.findIndex(row => row.id === afterRowId) + 1;
    setDoc({ ...current, rows: [...rest.slice(0, index), moving, ...rest.slice(index)] });
    try {
      await sourceRef.current.moveRow(databaseId, rowId, afterRowId);
      announceDatabaseChange(databaseId, origin);
    } catch (failure) { fail(failure, '行顺序未保存。'); }
  }, [databaseId, fail, origin, setDoc]);

  const trashRow = useCallback(async (rowId: string) => {
    const row = docRef.current?.rows.find(item => item.id === rowId);
    if (!row) return;
    try {
      await sourceRef.current.trashRow(row);
      await reload();
      announceDatabaseChange(databaseId, origin);
    } catch (failure) { fail(failure, '删除未完成。'); }
  }, [databaseId, fail, origin, reload]);

  return { doc, loading, error, pending, reload, saveSchema, updateRow, createRow, moveRow, trashRow };
}
