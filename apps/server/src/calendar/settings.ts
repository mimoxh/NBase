import { activeProperties, defaultCalendarSettings, isCalendarProperty, isCalendarSettings, withAutoAddedSources, type CalendarDateProperty,
  type CalendarSettings, type PropertyDefinition } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';

type Db = Pick<Pool | PoolClient, 'query'>;

/** Databases GET /calendar/sources lists at most. */
export const calendarDatabaseListLimit = 200;

export interface CalendarDatabaseRow {
  page_id: string;
  title: string;
  icon: string | null;
  properties_json: PropertyDefinition[];
  calendar_hidden: boolean;
}

export function dateProperties(properties: PropertyDefinition[]): CalendarDateProperty[] {
  return activeProperties(properties).filter(isCalendarProperty)
    .map(p => ({ id: p.id, name: p.name, type: p.type as CalendarDateProperty['type'] }));
}

/** Live databases with a date-like property, in the order the workspace calendar lists them. */
export async function listCalendarDatabases(db: Db, workspaceId: string): Promise<CalendarDatabaseRow[]> {
  const result = await db.query<CalendarDatabaseRow>(`
    SELECT d.page_id, p.title, p.icon, d.properties_json, d.calendar_hidden FROM databases d
    JOIN pages p ON p.workspace_id = d.workspace_id AND p.id = d.page_id AND p.deleted_at IS NULL AND p.kind = 'database'
    WHERE d.workspace_id = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.properties_json) e
      WHERE e->>'type' IN ('date', 'created_time', 'updated_time') AND COALESCE(e->>'deletedAt', '') = '')
    ORDER BY p.title COLLATE nbase_zh, p.id LIMIT $2`, [workspaceId, calendarDatabaseListLimit]);
  return result.rows;
}

/** Stored settings with the databases they do not mention added; a database switched off keeps its entry, so it is not added again. */
export function effectiveSettings(stored: CalendarSettings, databases: readonly Pick<CalendarDatabaseRow, 'page_id' | 'properties_json'>[]): CalendarSettings {
  return withAutoAddedSources(stored, databases.map(database => ({ databaseId: database.page_id, dateProperties: dateProperties(database.properties_json) })));
}

export async function storedSettings(db: Db, workspaceId: string, userId: string): Promise<CalendarSettings> {
  const result = await db.query<{ settings_json: unknown }>('SELECT settings_json FROM calendar_settings WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId]);
  const stored = result.rows[0]?.settings_json;
  return isCalendarSettings(stored) ? stored : defaultCalendarSettings;
}

export async function loadEffectiveSettings(db: Db, workspaceId: string, userId: string,
  databases?: CalendarDatabaseRow[]): Promise<CalendarSettings> {
  const [stored, listed] = await Promise.all([storedSettings(db, workspaceId, userId), databases ?? listCalendarDatabases(db, workspaceId)]);
  return effectiveSettings(stored, listed);
}

export interface AggregateScope { databaseId: string; propertyId: string }

/**
 * What the aggregate calendar of a source holds: the (database, date property) pairs the aggregate user shows on the
 * workspace calendar, limited to ordinary databases. Databases with a source, or made by one and still hidden, are left out.
 */
export async function aggregateScopes(db: Db, workspaceId: string, userId: string | null): Promise<AggregateScope[]> {
  if (!userId) return [];
  const databases = await listCalendarDatabases(db, workspaceId);
  const settings = await loadEffectiveSettings(db, workspaceId, userId, databases);
  const synced = await db.query<{ database_id: string }>('SELECT database_id FROM calendar_sync_sources WHERE workspace_id = $1', [workspaceId]);
  const excluded = new Set(synced.rows.map(row => row.database_id));
  const byId = new Map(databases.map(database => [database.page_id, database]));
  const seen = new Set<string>();
  const scopes: AggregateScope[] = [];
  for (const source of settings.sources) {
    const database = byId.get(source.databaseId);
    if (!source.visible || !database || database.calendar_hidden || excluded.has(database.page_id)) continue;
    const property = activeProperties(database.properties_json).find(p => p.id === source.propertyId);
    const key = `${source.databaseId}:${source.propertyId}`;
    if (property?.type !== 'date' || seen.has(key)) continue;
    seen.add(key);
    scopes.push({ databaseId: source.databaseId, propertyId: source.propertyId });
  }
  return scopes;
}
