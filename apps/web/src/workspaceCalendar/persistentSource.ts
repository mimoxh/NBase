import { defaultCalendarSettings, type CalDavDiscoverResponse, type CalendarEventsRequest, type CalendarEventsResponse,
  type CalendarImportRequest, type CalendarImportResponse, type CalendarReaderContext, type CalendarSettings, type CalendarSourcesResponse,
  type CalendarSyncConflictsResponse, type CalendarSyncListResponse, type CalendarSyncSource, type CreateCalendarSubscriptionRequest,
  type ResolveCalendarConflictRequest, type ResolveCalendarConflictResponse, type UpdateCalendarSyncRequest } from '@nbase/contracts';
import { ApiError, pageClient, request, workspacePath } from '../persistence/client';
import { databaseClient, rowFromPage } from '../database/persistentSource';
import { copiedProperties, detachedSkip } from '../database/views/CalendarView';
import { createContentFromMarkdown } from '../editor/markdown';
import type { CalendarSyncApi, RowDateWrite, WorkspaceCalendarSource } from './source';

export interface PersistentCalendarOptions {
  workspaceId: string;
  csrfToken: string;
  canWrite: boolean;
  context: CalendarReaderContext;
  notice: (text: string) => void;
  openRow: (rowId: string) => void;
  openDatabase: (databaseId: string) => void;
  openDailyNote: (date: string, pageId?: string) => void;
  /** A row open in the workbench is written through `updatePageMeta`, so its revision stays in step with body saves. */
  isRowOpen?: (rowId: string) => boolean;
  writeOpenRowDate?: (rowId: string, propertyId: string, value: string) => Promise<boolean>;
  /** Tells open database views to reload after a calendar write. */
  onDatabaseChanged?: (databaseId: string) => void;
}

/** Discovery and credential checks talk to the external server, which may answer slowly (30 s per request). */
export const caldavTimeoutMs = 90_000;

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

export function createPersistentCalendarSource(options: PersistentCalendarOptions): WorkspaceCalendarSource {
  const { workspaceId, csrfToken } = options;
  const base = workspacePath(workspaceId);
  const path = (suffix: string) => `${base}/calendar${suffix}`;

  const sync: CalendarSyncApi = {
    list: signal => request<CalendarSyncListResponse>(path('/sync'), 'GET', undefined, undefined, signal),
    importIcs: body => withReceipt(workspaceId, body.clientMutationId, () =>
      request<CalendarImportResponse>(path('/import'), 'POST', body, csrfToken)),
    subscribe: body => withReceipt(workspaceId, body.clientMutationId, () =>
      request<CalendarSyncSource>(path('/subscriptions'), 'POST', body, csrfToken)),
    update: (id, body) => request<CalendarSyncSource>(path(`/sync/${encodeURIComponent(id)}`), 'PATCH', body, csrfToken),
    run: id => request<CalendarSyncSource>(path(`/sync/${encodeURIComponent(id)}/run`), 'POST', {}, csrfToken),
    remove: id => request<void>(path(`/sync/${encodeURIComponent(id)}`), 'DELETE', {}, csrfToken),
    discoverCaldav: body => request<CalDavDiscoverResponse>(path('/caldav/discover'), 'POST', body, csrfToken, undefined, caldavTimeoutMs),
    createCaldav: body => withReceipt(workspaceId, body.clientMutationId, () =>
      request<CalendarSyncSource>(path('/caldav'), 'POST', body, csrfToken, undefined, caldavTimeoutMs)),
    updateCredentials: (id, credentials) => {
      const body: UpdateCalendarSyncRequest = { credentials };
      return request<CalendarSyncSource>(path(`/sync/${encodeURIComponent(id)}`), 'PATCH', body, csrfToken, undefined, caldavTimeoutMs);
    },
    conflicts: (id, signal) => request<CalendarSyncConflictsResponse>(path(`/sync/${encodeURIComponent(id)}/conflicts`), 'GET', undefined, undefined, signal),
    resolveConflict: (id, rowId, choice) => {
      const body: ResolveCalendarConflictRequest = { choice };
      return request<ResolveCalendarConflictResponse>(path(`/sync/${encodeURIComponent(id)}/conflicts/${encodeURIComponent(rowId)}`), 'POST', body, csrfToken);
    },
  };

  return {
    persistent: true,
    canWrite: options.canWrite,
    listDatabases: signal => request<CalendarSourcesResponse>(path('/sources'), 'GET', undefined, undefined, signal),
    loadSettings: async signal => {
      const settings = await request<CalendarSettings>(path('/settings'), 'GET', undefined, undefined, signal);
      return settings ?? defaultCalendarSettings;
    },
    saveSettings: settings => request<void>(path('/settings'), 'PUT', settings, csrfToken),
    loadEvents: (from, to, signal) => {
      const body: CalendarEventsRequest = { from, to, context: options.context };
      return request<CalendarEventsResponse>(path('/events'), 'POST', body, csrfToken, signal);
    },
    writeRowDate: async (write: RowDateWrite) => {
      if (options.isRowOpen?.(write.rowId) && options.writeOpenRowDate) {
        return options.writeOpenRowDate(write.rowId, write.propertyId, write.value);
      }
      const body = { clientMutationId: crypto.randomUUID(), expectedRevision: write.expectedRevision,
        properties: { [write.propertyId]: write.value } };
      try {
        await withReceipt(workspaceId, body.clientMutationId, () => pageClient.update(workspaceId, write.rowId, body, csrfToken));
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return false;
        throw error;
      }
    },
    createEvent: async ({ databaseId, propertyId, value }) => {
      const body = { clientMutationId: crypto.randomUUID(), parentId: databaseId, title: '',
        content: createContentFromMarkdown(''), properties: { [propertyId]: value } };
      const page = await withReceipt(workspaceId, body.clientMutationId, () => pageClient.create(workspaceId, body, csrfToken));
      options.onDatabaseChanged?.(databaseId);
      return page.id;
    },
    createDetachedRow: async ({ databaseId, rowId, propertyId, value }) => {
      const [doc, series] = await Promise.all([
        databaseClient.get(workspaceId, databaseId), pageClient.get(workspaceId, rowId)]);
      const properties = { ...copiedProperties(rowFromPage(series), doc.properties, detachedSkip(doc)), [propertyId]: value };
      const body = { clientMutationId: crypto.randomUUID(), parentId: databaseId, title: series.title,
        content: createContentFromMarkdown(''), properties };
      const page = await withReceipt(workspaceId, body.clientMutationId, () => pageClient.create(workspaceId, body, csrfToken));
      options.onDatabaseChanged?.(databaseId);
      return page.id;
    },
    openRow: options.openRow,
    openDatabase: options.openDatabase,
    openDailyNote: options.openDailyNote,
    notice: options.notice,
    sync,
  };
}
