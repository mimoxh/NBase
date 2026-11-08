import { rowSearchText, rowValueProblem, applyRowPatch, type PropertyDefinition, type PropertyValue,
  type RowProperties } from '@nbase/contracts';
import type { PoolClient } from 'pg';

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
