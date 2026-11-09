import { activeProperties, computeRow, isComputedProperty, type DatabaseRow, type PropertyDefinition, type RollupSource } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { databaseRow, loadDatabaseSchema, type RowRecord } from './schema.js';

type Db = Pick<PoolClient, 'query'>;

const batchSize = 200;
/** More dependent rows than this are recalculated by a sweep rather than listed under the workspace lock. */
const fanOutLimit = 200;

const rowColumns = `p.id, p.title, p.icon, p.row_properties, p.revision::text AS revision, p.created_at, p.updated_at`;

function hasComputed(properties: PropertyDefinition[]): boolean {
  return properties.some(def => isComputedProperty(def) && !def.deletedAt);
}

/** Formula and rollup results for rows. Used both when rows are read and when the cache is filled. */
export async function computeValues(client: Db, workspaceId: string, properties: PropertyDefinition[], rows: DatabaseRow[]): Promise<Map<string, DatabaseRow['computed']>> {
  const result = new Map<string, DatabaseRow['computed']>();
  if (!rows.length || !hasComputed(properties)) return result;
  const rollups = activeProperties(properties).filter(def => def.type === 'rollup');
  const perRow = new Map<string, Map<string, RollupSource>>();
  for (const def of rollups) {
    const relation = activeProperties(properties).find(item => item.id === def.rollup!.relationPropertyId && item.type === 'relation');
    if (!relation?.relation) continue;
    const targetSchema = await loadDatabaseSchema(client, workspaceId, relation.relation.databaseId);
    // Counting linked rows needs no target field.
    const target = targetSchema && (activeProperties(targetSchema.properties_json).find(item => item.id === def.rollup!.targetPropertyId) ?? (def.rollup!.fn === 'count' ? relation : undefined));
    if (!targetSchema || !target) continue;
    const propertyId = relation.relation.owner ? relation.id : relation.relation.pairedPropertyId;
    const [self, other] = relation.relation.owner ? ['source_row_id', 'target_row_id'] : ['target_row_id', 'source_row_id'];
    const linked = await client.query<RowRecord & { owner_id: string }>(`SELECT l.${self} AS owner_id, ${rowColumns}
      FROM database_row_links l JOIN pages p ON p.workspace_id = l.workspace_id AND p.id = l.${other} AND p.deleted_at IS NULL
      WHERE l.workspace_id = $1 AND l.property_id = $2 AND l.${self} = ANY($3::uuid[])`, [workspaceId, propertyId, rows.map(row => row.id)]);
    for (const row of rows) perRow.set(row.id, perRow.get(row.id) ?? new Map());
    for (const row of rows) {
      perRow.get(row.id)!.set(def.id, { rows: [], schema: targetSchema.properties_json, target });
    }
    for (const item of linked.rows) perRow.get(item.owner_id)!.get(def.id)!.rows.push(databaseRow(item));
  }
  for (const row of rows) result.set(row.id, computeRow(row, properties, perRow.get(row.id) ?? new Map()));
  return result;
}

async function queueRows(client: Db, workspaceId: string, databaseId: string, rowIds: string[]): Promise<void> {
  if (!rowIds.length) return;
  await client.query(`INSERT INTO database_computed_dirty (workspace_id, database_id, row_id)
    SELECT $1, $2, id FROM unnest($3::uuid[]) AS v(id) ON CONFLICT DO NOTHING`, [workspaceId, databaseId, rowIds]);
}

export async function queueSweep(client: Db, workspaceId: string, databaseId: string): Promise<void> {
  await client.query(`UPDATE databases SET computed_generation = computed_generation + 1, computed_cursor = NULL WHERE workspace_id = $1 AND page_id = $2`,
    [workspaceId, databaseId]);
}

/**
 * Queues recalculation after rows of a database changed: the rows themselves, and rows in other databases
 * whose rollups read them. Runs in the writer's transaction, so a change and its queue entry commit together.
 */
export async function markRowsChanged(client: Db, workspaceId: string, databaseId: string, properties: PropertyDefinition[], rowIds: string[]): Promise<void> {
  if (!rowIds.length) return;
  if (hasComputed(properties)) await queueRows(client, workspaceId, databaseId, rowIds);
  for (const def of activeProperties(properties)) {
    if (def.type !== 'relation' || !def.relation) continue;
    const other = await loadDatabaseSchema(client, workspaceId, def.relation.databaseId);
    const dependent = other && activeProperties(other.properties_json).some(item => item.type === 'rollup' && item.rollup!.relationPropertyId === def.relation!.pairedPropertyId);
    if (!dependent) continue;
    const propertyId = def.relation.owner ? def.id : def.relation.pairedPropertyId;
    const [self, opposite] = def.relation.owner ? ['source_row_id', 'target_row_id'] : ['target_row_id', 'source_row_id'];
    const linked = await client.query<{ id: string }>(`SELECT l.${opposite} AS id FROM database_row_links l
      WHERE l.workspace_id = $1 AND l.property_id = $2 AND l.${self} = ANY($3::uuid[]) LIMIT ${fanOutLimit + 1}`, [workspaceId, propertyId, rowIds]);
    if (linked.rows.length > fanOutLimit) await queueSweep(client, workspaceId, def.relation.databaseId);
    else await queueRows(client, workspaceId, def.relation.databaseId, linked.rows.map(row => row.id));
  }
}

/** After a schema change: this database's rows, and those of databases whose rollups read it. */
export async function markSchemaChanged(client: Db, workspaceId: string, databaseId: string, properties: PropertyDefinition[]): Promise<void> {
  if (hasComputed(properties)) await queueSweep(client, workspaceId, databaseId);
  for (const def of activeProperties(properties)) {
    if (def.type !== 'relation' || !def.relation || def.relation.databaseId === databaseId) continue;
    const other = await loadDatabaseSchema(client, workspaceId, def.relation.databaseId);
    if (other && activeProperties(other.properties_json).some(item => item.type === 'rollup' && item.rollup!.relationPropertyId === def.relation!.pairedPropertyId)) {
      await queueSweep(client, workspaceId, def.relation.databaseId);
    }
  }
}

async function loadRows(client: Db, workspaceId: string, ids: string[]): Promise<DatabaseRow[]> {
  const result = await client.query<RowRecord>(`SELECT ${rowColumns} FROM pages p WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[]) AND p.kind = 'row'`, [workspaceId, ids]);
  return result.rows.map(databaseRow);
}

async function store(client: Db, workspaceId: string, databaseId: string, properties: PropertyDefinition[], rows: DatabaseRow[]): Promise<void> {
  if (!rows.length) return;
  const values = await computeValues(client, workspaceId, properties, rows);
  await client.query(`INSERT INTO database_computed (workspace_id, database_id, row_id, values_json)
    SELECT $1, $2, v.id, v.body::jsonb FROM unnest($3::uuid[], $4::text[]) AS v(id, body)
    ON CONFLICT (workspace_id, row_id) DO UPDATE SET values_json = EXCLUDED.values_json`,
  [workspaceId, databaseId, rows.map(row => row.id), rows.map(row => JSON.stringify(values.get(row.id) ?? {}))]);
}

/** Works through one batch without the workspace lock. Returns false when nothing is waiting. */
export async function runComputedBatch(pool: Pool, limit = batchSize): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dirty = await client.query<{ workspace_id: string; database_id: string; row_id: string }>(`SELECT workspace_id, database_id, row_id FROM database_computed_dirty
      ORDER BY database_id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    if (dirty.rows[0]) {
      const { workspace_id: workspaceId, database_id: databaseId } = dirty.rows[0];
      const ids = dirty.rows.filter(row => row.database_id === databaseId).map(row => row.row_id);
      const schema = await loadDatabaseSchema(client, workspaceId, databaseId);
      if (schema) await store(client, workspaceId, databaseId, schema.properties_json, await loadRows(client, workspaceId, ids));
      await client.query('DELETE FROM database_computed_dirty WHERE workspace_id = $1 AND row_id = ANY($2::uuid[])', [workspaceId, ids]);
      await client.query('COMMIT');
      return true;
    }
    const head = await client.query<{ workspace_id: string; page_id: string; properties_json: PropertyDefinition[]; computed_cursor: string | null }>(`
      SELECT workspace_id, page_id, properties_json, computed_cursor FROM databases WHERE computed_done_generation < computed_generation LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const job = head.rows[0];
    if (!job) { await client.query('COMMIT'); return false; }
    const picked = await client.query<{ id: string }>(`SELECT id FROM pages WHERE workspace_id = $1 AND parent_id = $2 AND kind = 'row'
      AND ($3::uuid IS NULL OR id > $3::uuid) ORDER BY id LIMIT $4`, [job.workspace_id, job.page_id, job.computed_cursor, limit]);
    const ids = picked.rows.map(row => row.id);
    await store(client, job.workspace_id, job.page_id, job.properties_json, await loadRows(client, job.workspace_id, ids));
    if (ids.length < limit) {
      await client.query(`UPDATE databases SET computed_done_generation = computed_generation, computed_cursor = NULL WHERE workspace_id = $1 AND page_id = $2`, [job.workspace_id, job.page_id]);
    } else {
      await client.query('UPDATE databases SET computed_cursor = $3 WHERE workspace_id = $1 AND page_id = $2', [job.workspace_id, job.page_id, ids.at(-1)]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
