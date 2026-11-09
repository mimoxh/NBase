import { rowSearchText, rowValueProblem, applyRowPatch, type DatabaseRow, type PropertyDefinition, type PropertyValue,
  type RowProperties } from '@nbase/contracts';
import type { PoolClient } from 'pg';

export interface RowRecord {
  id: string; title: string; icon: string | null; row_properties: RowProperties | null; revision: string;
  created_at: Date; updated_at: Date;
}

export function databaseRow(row: RowRecord): DatabaseRow {
  return { id: row.id, title: row.title, icon: row.icon ?? null, properties: row.row_properties ?? {}, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export interface DatabaseSchemaRow {
  properties_json: PropertyDefinition[];
  views_json: unknown[];
  revision: string;
}

/** Reads a database's schema inside the caller's transaction. */
export async function loadDatabaseSchema(client: Pick<PoolClient, 'query'>, workspaceId: string, databaseId: string,
  lock = false): Promise<DatabaseSchemaRow | null> {
  const result = await client.query<DatabaseSchemaRow>(`SELECT properties_json, views_json, revision::text AS revision
    FROM databases WHERE workspace_id = $1 AND page_id = $2${lock ? ' FOR UPDATE' : ''}`, [workspaceId, databaseId]);
  return result.rows[0] ?? null;
}

export class RowPropertiesError extends Error {
  constructor(public readonly reason: string) { super('PROPERTY_INVALID'); }
}

/** Rebuilds the derived link rows of owning rows from their stored id arrays, dropping ids that no longer exist. */
export async function syncRelationLinks(client: Pick<PoolClient, 'query'>, workspaceId: string, properties: PropertyDefinition[],
  rows: { id: string; values: RowProperties }[]): Promise<void> {
  for (const def of properties) {
    if (def.type !== 'relation' || !def.relation?.owner) continue;
    const pairs = rows.flatMap(row => {
      const value = row.values[def.id];
      return (Array.isArray(value) ? value : []).map(target => ({ source: row.id, target }));
    });
    await client.query('DELETE FROM database_row_links WHERE workspace_id = $1 AND property_id = $2 AND source_row_id = ANY($3::uuid[])',
      [workspaceId, def.id, rows.map(row => row.id)]);
    if (!pairs.length) continue;
    await client.query(`INSERT INTO database_row_links (workspace_id, property_id, source_row_id, target_row_id)
      SELECT $1, $2, v.source, v.target FROM unnest($3::uuid[], $4::uuid[]) AS v(source, target)
      JOIN pages t ON t.workspace_id = $1 AND t.id = v.target AND t.parent_id = $5 AND t.kind = 'row' ON CONFLICT DO NOTHING`,
    [workspaceId, def.id, pairs.map(pair => pair.source), pairs.map(pair => pair.target), def.relation.databaseId]);
  }
}

/** Validates a patch against the current schema and returns the merged values. */
export function mergeRowProperties(properties: PropertyDefinition[], current: RowProperties,
  patch: Record<string, PropertyValue | null>): RowProperties {
  for (const [propertyId, value] of Object.entries(patch)) {
    const problem = rowValueProblem(properties, propertyId, value);
    if (problem) throw new RowPropertiesError(problem);
  }
  return applyRowPatch(current, patch);
}

/** The part of a schema that row search text depends on; colors, order and other fields do not matter. */
export function searchProjection(properties: PropertyDefinition[]): string {
  const searchable = properties
    .filter(p => !p.deletedAt && (p.type === 'text' || p.type === 'url' || p.type === 'select' || p.type === 'multi_select'))
    .map(p => ({ id: p.id, type: p.type, options: (p.options ?? []).map(o => `${o.id}:${o.name}`).sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(searchable);
}

/** Search text for a row: body text first, then searchable property values. */
export function rowIndexText(bodyText: string, properties: PropertyDefinition[], values: RowProperties): string {
  const extra = rowSearchText(properties, values).replace(/\s+/gu, ' ').trim();
  return extra ? (bodyText ? `${bodyText} ${extra}` : extra) : bodyText;
}
