import { randomUUID } from 'node:crypto';
import type { CalendarImportWarning, CalendarSyncCounts, CalendarSyncError, CalendarSyncFields, CalendarSyncKind,
  CalendarSyncSource, DatabaseView, PropertyDefinition } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { PageError, type PgPageRepository } from '../pages/repository.js';
import { keptPropertyIds } from './locks.js';

/** Errors of calendar routes that are not page errors; sent as `{ error: code }`. */
export class CalendarRouteError extends Error {
  constructor(public readonly statusCode: number, public readonly code: CalendarSyncError | 'NOT_FOUND' | 'SYNC_RUNNING'
    | 'SYNC_KIND_INVALID' | 'IMPORT_TARGET_INVALID' | 'CONFLICT_CHOICE_INVALID') { super(code); }
}

/** What a CalDAV source keeps in caldav_json; none of it is secret. */
export interface CaldavConfig {
  serverUrl: string;
  calendarUrl: string;
  calendarName: string;
  writable: boolean;
  color: string | null;
}

export interface SourceRow {
  id: string;
  workspace_id: string;
  database_id: string;
  kind: CalendarSyncKind;
  name: string;
  url: string | null;
  interval_minutes: number | null;
  fields_json: CalendarSyncFields;
  status: 'idle' | 'running' | 'error';
  last_synced_at: Date | null;
  last_error: CalendarSyncError | null;
  last_counts_json: CalendarSyncCounts | null;
  warnings_json: CalendarImportWarning[];
  event_count: number;
  next_run_at: Date | null;
  http_etag: string | null;
  http_last_modified: string | null;
  created_by: string;
  caldav_json: CaldavConfig | null;
  credential_key_id: string | null;
  sync_token: string | null;
  ctag: string | null;
  conflict_count: number;
}

export const sourceColumns = `s.id, s.workspace_id, s.database_id, s.kind, s.name, s.url, s.interval_minutes, s.fields_json, s.status,
  s.last_synced_at, s.last_error, s.last_counts_json, s.warnings_json, s.event_count, s.next_run_at, s.http_etag,
  s.http_last_modified, s.created_by, s.caldav_json, s.credential_key_id, s.sync_token, s.ctag,
  (SELECT count(*)::int FROM calendar_sync_conflicts c WHERE c.source_id = s.id) AS conflict_count`;

/** A claim older than this belongs to a process that died; the source may be taken again. */
export const staleClaim = `interval '30 minutes'`;

export function urlHost(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

/** Fields a subscription keeps: hand edits would be overwritten by the next sync, so they are refused. */
export function readOnlyPropertyIds(row: Pick<SourceRow, 'kind' | 'fields_json' | 'caldav_json'>): string[] {
  return keptPropertyIds(row);
}

export interface SourceView {
  /** Id of the credential key this server holds, or null without one; decides `credentialsOk`. */
  keyId: string | null;
  /** Rows with attendees; only GET /databases/:id lists them. */
  readOnlyRowIds?: string[];
}

export function toSyncSource(row: SourceRow, view: SourceView = { keyId: null }): CalendarSyncSource {
  const caldav = row.kind === 'caldav' && row.caldav_json ? {
    serverHost: urlHost(row.caldav_json.serverUrl) ?? '', calendarName: row.caldav_json.calendarName, writable: row.caldav_json.writable,
    credentialsOk: view.keyId !== null && row.credential_key_id === view.keyId, conflictCount: row.conflict_count ?? 0,
  } : null;
  return {
    id: row.id, databaseId: row.database_id, kind: row.kind, name: row.name, urlHost: urlHost(row.url),
    intervalMinutes: row.interval_minutes, status: row.status, lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastError: row.last_error, lastCounts: row.last_counts_json, warnings: row.warnings_json ?? [], eventCount: row.event_count,
    fields: row.fields_json, readOnlyPropertyIds: readOnlyPropertyIds(row), caldav,
    ...(view.readOnlyRowIds ? { readOnlyRowIds: view.readOnlyRowIds } : {}),
  };
}

/** Rows of a writable CalDAV source whose events have attendees, which are never written back. */
export async function attendeeRowIds(db: Pick<PoolClient, 'query'>, workspaceId: string, sourceId: string, rowIds?: string[]): Promise<string[]> {
  const result = await db.query<{ row_id: string }>(`SELECT i.row_id FROM calendar_sync_items i
    JOIN pages p ON p.workspace_id = i.workspace_id AND p.id = i.row_id AND p.deleted_at IS NULL
    WHERE i.workspace_id = $1 AND i.source_id = $2 AND i.attendees AND ($3::uuid[] IS NULL OR i.row_id = ANY($3::uuid[]))
    ORDER BY i.row_id`, [workspaceId, sourceId, rowIds ?? null]);
  return result.rows.map(row => row.row_id);
}

export async function sourceForDatabase(db: Pick<PoolClient, 'query'>, workspaceId: string, databaseId: string): Promise<SourceRow | null> {
  const result = await db.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s
    WHERE s.workspace_id = $1 AND s.database_id = $2`, [workspaceId, databaseId]);
  return result.rows[0] ?? null;
}

const emptyContent = { schemaVersion: 1 as const, editorState: { root: { type: 'root', version: 1, format: '', indent: 0,
  direction: null, children: [] } } };

/** Schema of a new calendar database: 名称, 时间, 地点, 说明 and a hidden 外部 ID; a calendar view, then a table. */
export function syncDatabaseSchema(): { properties: PropertyDefinition[]; views: DatabaseView[]; fields: CalendarSyncFields } {
  const fields: CalendarSyncFields = { titleId: randomUUID(), dateId: randomUUID(), locationId: randomUUID(),
    descriptionId: randomUUID(), uidId: randomUUID() };
  const view = (name: string, type: DatabaseView['type']): DatabaseView => ({ id: randomUUID(), name, type,
    ...(type === 'calendar' ? { datePropertyId: fields.dateId } : {}), filters: [], sorts: [], hiddenPropertyIds: [fields.uidId],
    propertyOrder: [], widths: {} });
  return {
    properties: [
      { id: fields.titleId, name: '名称', type: 'title' },
      { id: fields.dateId, name: '时间', type: 'date' },
      { id: fields.locationId, name: '地点', type: 'text' },
      { id: fields.descriptionId, name: '说明', type: 'text' },
      { id: fields.uidId, name: '外部 ID', type: 'text' },
    ],
    views: [view('日历', 'calendar'), view('表格', 'table')],
    fields,
  };
}

/** Creates the database a new source writes to. The parent must be a document or the top level. */
export async function createSyncDatabase(client: PoolClient, pages: PgPageRepository, workspaceId: string, actorId: string,
  parentId: string | null, name: string, clientMutationId: string): Promise<{ databaseId: string; fields: CalendarSyncFields }> {
  if (parentId !== null) {
    const parent = await client.query<{ kind: string }>('SELECT kind FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
      [workspaceId, parentId]);
    if (!parent.rows[0]) throw new PageError(422, 'PAGE_TREE_INVALID');
    if (parent.rows[0].kind !== 'document') throw new PageError(422, 'PAGE_KIND_INVALID');
  }
  const created = await pages.createInTransaction(client, workspaceId, actorId,
    { clientMutationId, parentId, title: name, content: emptyContent }, 'database');
  const schema = syncDatabaseSchema();
  await client.query(`INSERT INTO databases (workspace_id, page_id, properties_json, views_json) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
    [workspaceId, created.body.id, JSON.stringify(schema.properties), JSON.stringify(schema.views)]);
  return { databaseId: created.body.id, fields: schema.fields };
}

export async function insertSource(client: PoolClient, values: { workspaceId: string; databaseId: string; kind: CalendarSyncKind;
  name: string; url: string | null; intervalMinutes: number | null; fields: CalendarSyncFields; actorId: string;
  clientMutationId: string; id?: string; caldav?: { config: CaldavConfig; cipher: Buffer; keyId: string } }): Promise<SourceRow> {
  const result = await client.query<SourceRow>(`INSERT INTO calendar_sync_sources AS s (id, workspace_id, database_id, kind, name, url,
      interval_minutes, fields_json, created_by, client_mutation_id, next_run_at, caldav_json, credential_cipher, credential_key_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, CASE WHEN $4 IN ('ics-url', 'caldav') THEN now() END, $11::jsonb, $12, $13)
    RETURNING ${sourceColumns}`,
  [values.id ?? randomUUID(), values.workspaceId, values.databaseId, values.kind, values.name, values.url, values.intervalMinutes,
    JSON.stringify(values.fields), values.actorId, values.clientMutationId, values.caldav ? JSON.stringify(values.caldav.config) : null,
    values.caldav?.cipher ?? null, values.caldav?.keyId ?? null]);
  return result.rows[0]!;
}

/** One short transaction under the workspace lock, for editors and owners. */
export async function withWorkspaceLock<T>(pool: Pool, workspaceId: string, actorId: string,
  action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const membership = await client.query<{ role: string }>(`SELECT m.role FROM workspaces w
      JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2 WHERE w.id = $1 FOR UPDATE OF w`, [workspaceId, actorId]);
    if (!membership.rows[0]) throw new PageError(404, 'NOT_FOUND');
    if (membership.rows[0].role === 'viewer') throw new PageError(403, 'FORBIDDEN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Marks a source as syncing. Returns null when another run holds it. */
export async function claimSource(db: Pick<PoolClient, 'query'>, sourceId: string): Promise<SourceRow | null> {
  const result = await db.query<SourceRow>(`UPDATE calendar_sync_sources s SET status = 'running', running_since = now(), updated_at = now()
    WHERE s.id = $1 AND (s.status <> 'running' OR s.running_since < now() - ${staleClaim}) RETURNING ${sourceColumns}`, [sourceId]);
  return result.rows[0] ?? null;
}

export interface SyncOutcome {
  error?: CalendarSyncError;
  counts?: CalendarSyncCounts;
  warnings?: CalendarImportWarning[];
  http?: { etag: string | null; lastModified: string | null };
  /** CalDAV collection state after a run. */
  caldav?: { syncToken: string | null; ctag: string | null; writable: boolean | null };
}

/** Ends a run: records the outcome and, for subscriptions, when the next one is due. */
export async function finishSource(db: Pick<Pool, 'query'>, sourceId: string, outcome: SyncOutcome): Promise<SourceRow | null> {
  const result = await db.query<SourceRow>(`UPDATE calendar_sync_sources s SET
      status = CASE WHEN $2::text IS NULL THEN 'idle' ELSE 'error' END, running_since = NULL, last_error = $2::text,
      last_synced_at = CASE WHEN $2::text IS NULL THEN now() ELSE s.last_synced_at END,
      last_counts_json = COALESCE($3::jsonb, s.last_counts_json), warnings_json = COALESCE($4::jsonb, s.warnings_json),
      event_count = (SELECT count(*)::int FROM calendar_sync_items i WHERE i.source_id = s.id AND i.removed_at IS NULL),
      http_etag = CASE WHEN $5::boolean THEN $6::text ELSE s.http_etag END,
      http_last_modified = CASE WHEN $5::boolean THEN $7::text ELSE s.http_last_modified END,
      sync_token = CASE WHEN $8::boolean THEN $9::text ELSE s.sync_token END,
      ctag = CASE WHEN $8::boolean THEN $10::text ELSE s.ctag END,
      caldav_json = CASE WHEN $11::boolean IS NULL OR s.caldav_json IS NULL THEN s.caldav_json
        ELSE jsonb_set(s.caldav_json, '{writable}', to_jsonb($11::boolean)) END,
      next_run_at = CASE WHEN s.kind IN ('ics-url', 'caldav') THEN now() + s.interval_minutes * interval '1 minute' END, updated_at = now()
    WHERE s.id = $1 RETURNING ${sourceColumns}`,
  [sourceId, outcome.error ?? null, outcome.counts ? JSON.stringify(outcome.counts) : null,
    outcome.warnings ? JSON.stringify(outcome.warnings) : null, outcome.http !== undefined,
    outcome.http?.etag?.slice(0, 512) ?? null, outcome.http?.lastModified?.slice(0, 100) ?? null,
    outcome.caldav !== undefined, outcome.caldav?.syncToken && outcome.caldav.syncToken.length <= 2000 ? outcome.caldav.syncToken : null,
    outcome.caldav?.ctag && outcome.caldav.ctag.length <= 1000 ? outcome.caldav.ctag : null, outcome.caldav?.writable ?? null]);
  return result.rows[0] ?? null;
}
