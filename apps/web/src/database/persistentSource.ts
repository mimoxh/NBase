import { databaseSchemaProblem, type CreateDatabaseRequest, type DatabaseDocument, type DatabaseQueryRequest, type DatabaseQueryResponse, type DatabaseRow,
  type DatabaseRowsResponse, type DatabaseSchemaResponse, type PageDocument, type UpdateDatabaseSchemaRequest } from '@nbase/contracts';
import { createContentFromMarkdown } from '../editor/markdown';
import { ApiError, pageClient, request, workspacePath } from '../persistence/client';
import type { DatabaseDataSource, RowPatch } from './source';

function isDatabaseDocument(value: unknown): value is DatabaseDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<DatabaseDocument>;
  return typeof doc.schemaRevision === 'string' && Array.isArray(doc.rows) && !!doc.page && typeof doc.page.id === 'string'
    && databaseSchemaProblem(doc.properties, doc.views) === null;
}

/** A lost response is answered from the server's receipt for the same mutation. */
async function withReceipt<T>(workspaceId: string, mutationId: string, send: () => Promise<T>): Promise<T> {
  try { return await send(); }
  catch (error) {
    if (!(error instanceof ApiError) || !['TIMEOUT', 'NETWORK_UNAVAILABLE'].includes(error.code)) throw error;
    const receipt = await pageClient.receipt(workspaceId, mutationId).catch(() => null);
    if (!receipt) throw error;
    return receipt.response as unknown as T;
  }
}

export function rowFromPage(page: PageDocument): DatabaseRow {
  return { id: page.id, title: page.title, icon: page.icon ?? null, properties: page.properties ?? {},
    revision: page.revision, createdAt: page.createdAt, updatedAt: page.updatedAt };
}

export const databaseClient = {
  get: async (workspaceId: string, databaseId: string, signal?: AbortSignal): Promise<DatabaseDocument> => {
    const doc = await request<unknown>(`${workspacePath(workspaceId)}/databases/${encodeURIComponent(databaseId)}?rows=none`,
      'GET', undefined, undefined, signal);
    if (!isDatabaseDocument(doc)) throw new ApiError(0, 'INVALID_RESPONSE');
    return doc;
  },
  query: (workspaceId: string, databaseId: string, body: DatabaseQueryRequest, csrfToken: string) =>
    request<DatabaseQueryResponse>(`${workspacePath(workspaceId)}/databases/${encodeURIComponent(databaseId)}/query`, 'POST', body, csrfToken),
  readRows: async (workspaceId: string, databaseId: string, ids: string[], csrfToken: string) =>
    (await request<DatabaseRowsResponse>(`${workspacePath(workspaceId)}/databases/${encodeURIComponent(databaseId)}/rows/read`, 'POST', { ids }, csrfToken)).rows,
  create: (workspaceId: string, body: CreateDatabaseRequest, csrfToken: string) =>
    withReceipt(workspaceId, body.clientMutationId, () =>
      request<DatabaseDocument>(`${workspacePath(workspaceId)}/databases`, 'POST', body, csrfToken)),
  updateSchema: (workspaceId: string, databaseId: string, body: UpdateDatabaseSchemaRequest, csrfToken: string) =>
    withReceipt(workspaceId, body.clientMutationId, () =>
      request<DatabaseSchemaResponse>(`${workspacePath(workspaceId)}/databases/${encodeURIComponent(databaseId)}`,
        'PATCH', body, csrfToken)),
};

export interface PersistentSourceOptions {
  workspaceId: string;
  csrfToken: string;
  canWrite: boolean;
  openPage: (pageId: string) => void;
  notice: (text: string) => void;
  /** Row deletion uses the workspace's durable trash action. */
  trashRow: (row: DatabaseRow) => Promise<void>;
  /** Keeps the workspace's cached page in step when a row it holds changes elsewhere. */
  onRowSaved?: (page: PageDocument) => void;
}

export function createPersistentSource(options: PersistentSourceOptions): DatabaseDataSource {
  const { workspaceId, csrfToken } = options;
  return {
    canWrite: options.canWrite,
    load: (databaseId, signal) => databaseClient.get(workspaceId, databaseId, signal),
    query: (databaseId, body) => databaseClient.query(workspaceId, databaseId, body, csrfToken),
    readRows: (databaseId, ids) => databaseClient.readRows(workspaceId, databaseId, ids, csrfToken),
    saveSchema: (databaseId, schema, expectedRevision) => databaseClient.updateSchema(workspaceId, databaseId,
      { clientMutationId: crypto.randomUUID(), expectedRevision, ...schema }, csrfToken),
    createRow: async (databaseId, title, properties) => {
      const body = { clientMutationId: crypto.randomUUID(), parentId: databaseId, title,
        content: createContentFromMarkdown(''), properties };
      const page = await withReceipt(workspaceId, body.clientMutationId, () => pageClient.create(workspaceId, body, csrfToken));
      return rowFromPage(page);
    },
    updateRow: async (rowId, expectedRevision, patch: RowPatch) => {
      const body = { clientMutationId: crypto.randomUUID(), expectedRevision, ...patch };
      const page = await withReceipt(workspaceId, body.clientMutationId, () => pageClient.update(workspaceId, rowId, body, csrfToken));
      options.onRowSaved?.(page);
      return rowFromPage(page);
    },
    moveRow: (_databaseId, rowId, afterRowId) => pageClient.setPosition(workspaceId, rowId, afterRowId, csrfToken),
    trashRow: row => options.trashRow(row),
    openRow: rowId => options.openPage(rowId),
    openDatabase: databaseId => options.openPage(databaseId),
    notice: options.notice,
  };
}
