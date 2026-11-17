import type { CalendarSyncFields, CalendarSyncKind } from '@nbase/contracts';
import type { PoolClient } from 'pg';

type Db = Pick<PoolClient, 'query'>;

interface LockSource { kind: CalendarSyncKind; fields_json: CalendarSyncFields; caldav_json?: { writable?: boolean } | null }

function syncedIds(f: CalendarSyncFields): string[] {
  return [f.titleId, f.dateId, f.locationId, f.descriptionId, f.uidId];
}

/**
 * Fields kept by calendar sync sources. Kept here, apart from the calendar routes, because the page and
 * database write paths check them. A subscription keeps all synced fields; a CalDAV source always keeps
 * the external ID, and everything when the external calendar is read-only.
 */
export function keptPropertyIds(row: LockSource): string[] {
  if (row.kind === 'ics-url') return syncedIds(row.fields_json);
  if (row.kind === 'caldav') return row.caldav_json?.writable ? [row.fields_json.uidId] : syncedIds(row.fields_json);
  return [];
}

export interface SyncLock {
  /** Kept on every row. */
  propertyIds: Set<string>;
  /** Whether the title is kept on every row. */
  titleKept: boolean;
  /** Title and synced fields, kept on the rows in `rows`. */
  rowPropertyIds: Set<string>;
  /** Rows of the asked ones that are kept entirely: CalDAV events with attendees. */
  rows: Set<string>;
}

/**
 * The fields of a database that a sync source keeps, or null when nothing is locked. `rowIds` are rows
 * about to be written, checked for row-level locks.
 */
export async function syncLock(client: Db, workspaceId: string, databaseId: string, rowIds: string[] = []): Promise<SyncLock | null> {
  const result = await client.query<LockSource & { id: string }>(`SELECT id, kind, fields_json, caldav_json
    FROM calendar_sync_sources WHERE workspace_id = $1 AND database_id = $2 AND kind IN ('ics-url', 'caldav')`, [workspaceId, databaseId]);
  const row = result.rows[0];
  if (!row) return null;
  const propertyIds = new Set(keptPropertyIds(row));
  const rows = new Set<string>();
  if (row.kind === 'caldav' && row.caldav_json?.writable && rowIds.length) {
    const locked = await client.query<{ row_id: string }>(`SELECT row_id FROM calendar_sync_items
      WHERE workspace_id = $1 AND source_id = $2 AND attendees AND row_id = ANY($3::uuid[])`,
    [workspaceId, row.id, rowIds.map(id => id.toLowerCase())]);
    for (const item of locked.rows) rows.add(item.row_id);
  }
  return { propertyIds, titleKept: propertyIds.has(row.fields_json.titleId), rowPropertyIds: new Set(syncedIds(row.fields_json)), rows };
}

/**
 * Whether a write would change a kept field. `title` is the title being written and `previousTitle` the
 * current one (absent for a new row, where any title but the empty one is a change); property values
 * are compared with `previous` the same way. `rowId` names an existing row, for row-level locks.
 */
export function changesKeptField(lock: SyncLock | null, change: { title?: string | undefined; previousTitle?: string | undefined;
  properties?: Record<string, unknown> | undefined; previous?: Record<string, unknown> | null | undefined; rowId?: string | undefined }): boolean {
  if (!lock) return false;
  const whole = change.rowId !== undefined && lock.rows.has(change.rowId.toLowerCase());
  const ids = whole ? lock.rowPropertyIds : lock.propertyIds;
  if ((lock.titleKept || whole) && change.title !== undefined && change.title !== (change.previousTitle ?? '')) return true;
  for (const [id, value] of Object.entries(change.properties ?? {})) {
    if (ids.has(id) && canonical(value) !== canonical(change.previous?.[id])) return true;
  }
  return false;
}

function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
}

/** Property ids of every sync source of a database, which may not be removed or change type. */
export async function managedPropertyIds(client: Db, workspaceId: string, databaseId: string): Promise<Set<string>> {
  const result = await client.query<{ fields_json: CalendarSyncFields }>(`SELECT fields_json FROM calendar_sync_sources
    WHERE workspace_id = $1 AND database_id = $2`, [workspaceId, databaseId]);
  return new Set(result.rows.flatMap(row => syncedIds(row.fields_json)));
}

/** Seconds after a local change to a CalDAV database before it is written back. */
export const caldavPushDelaySeconds = 30;

/**
 * Brings the next run of a CalDAV source forward after rows of its database changed, so local edits reach the server
 * soon. Rows of any database may belong to the workspace's aggregate calendar, so that source is brought forward too.
 */
export async function nudgeCaldav(client: Db, workspaceId: string, databaseId: string | null): Promise<void> {
  if (!databaseId) return;
  await client.query(`UPDATE calendar_sync_sources SET next_run_at = LEAST(COALESCE(next_run_at, now() + $3 * interval '1 second'),
      now() + $3 * interval '1 second')
    WHERE workspace_id = $1 AND kind = 'caldav' AND (database_id = $2 OR (aggregate_user_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM databases d WHERE d.workspace_id = $1 AND d.page_id = $2)))`, [workspaceId, databaseId, caldavPushDelaySeconds]);
}

/** After whole databases went to the trash or came back: the aggregate calendar follows soon. */
export async function nudgeAggregate(client: Db, workspaceId: string): Promise<void> {
  await client.query(`UPDATE calendar_sync_sources SET next_run_at = LEAST(COALESCE(next_run_at, now() + $2 * interval '1 second'),
      now() + $2 * interval '1 second')
    WHERE workspace_id = $1 AND aggregate_user_id IS NOT NULL`, [workspaceId, caldavPushDelaySeconds]);
}
