import type { CalendarSyncFields, CalendarSyncKind } from '@nbase/contracts';
import type { PoolClient } from 'pg';

/**
 * Fields kept by calendar sync sources. Kept here, apart from the calendar routes, because the page and
 * database write paths check them.
 */
export function keptPropertyIds(row: { kind: CalendarSyncKind; fields_json: CalendarSyncFields }): string[] {
  if (row.kind !== 'ics-url') return [];
  const f = row.fields_json;
  return [f.titleId, f.dateId, f.locationId, f.descriptionId, f.uidId];
}

export interface SyncLock { propertyIds: Set<string> }

/** The fields of a database that a subscription keeps, or null when nothing is locked. */
export async function syncLock(client: Pick<PoolClient, 'query'>, workspaceId: string, databaseId: string): Promise<SyncLock | null> {
  const result = await client.query<{ kind: CalendarSyncKind; fields_json: CalendarSyncFields }>(`SELECT kind, fields_json
    FROM calendar_sync_sources WHERE workspace_id = $1 AND database_id = $2 AND kind = 'ics-url'`, [workspaceId, databaseId]);
  const row = result.rows[0];
  return row ? { propertyIds: new Set(keptPropertyIds(row)) } : null;
}

/**
 * Whether a write would change a kept field. `title` is the title being written and `previousTitle` the
 * current one (absent for a new row, where any title but the empty one is a change); property values
 * are compared with `previous` the same way.
 */
export function changesKeptField(lock: SyncLock | null, change: { title?: string | undefined; previousTitle?: string | undefined;
  properties?: Record<string, unknown> | undefined; previous?: Record<string, unknown> | null | undefined }): boolean {
  if (!lock) return false;
  if (change.title !== undefined && change.title !== (change.previousTitle ?? '')) return true;
  for (const [id, value] of Object.entries(change.properties ?? {})) {
    if (lock.propertyIds.has(id) && canonical(value) !== canonical(change.previous?.[id])) return true;
  }
  return false;
}

function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
}

/** Property ids of every sync source of a database, which may not be removed or change type. */
export async function managedPropertyIds(client: Pick<PoolClient, 'query'>, workspaceId: string, databaseId: string): Promise<Set<string>> {
  const result = await client.query<{ fields_json: CalendarSyncFields }>(`SELECT fields_json FROM calendar_sync_sources
    WHERE workspace_id = $1 AND database_id = $2`, [workspaceId, databaseId]);
  return new Set(result.rows.flatMap(row => [row.fields_json.titleId, row.fields_json.dateId, row.fields_json.locationId,
    row.fields_json.descriptionId, row.fields_json.uidId]));
}
