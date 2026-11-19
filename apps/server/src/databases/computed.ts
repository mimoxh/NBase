import { activeProperties, computeRow, formulaDepthLimit, isComputedProperty, type DatabaseRow, type PropertyDefinition, type RollupSource } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { databaseRow, loadDatabaseSchema, type RowRecord } from './schema.js';

type Db = Pick<PoolClient, 'query'>;

const batchSize = 200;
const computedWorkerLockKey = '2026110901';
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
    // Computed fields of linked rows come from their cache, which the worker fills upstream first.
    const linked = await client.query<RowRecord & { owner_id: string; computed_json: DatabaseRow['computed'] | null }>(`SELECT l.${self} AS owner_id,
        ${rowColumns}, c.values_json AS computed_json
      FROM database_row_links l JOIN pages p ON p.workspace_id = l.workspace_id AND p.id = l.${other} AND p.deleted_at IS NULL
      LEFT JOIN database_computed c ON c.workspace_id = p.workspace_id AND c.row_id = p.id
      WHERE l.workspace_id = $1 AND l.property_id = $2 AND l.${self} = ANY($3::uuid[])`, [workspaceId, propertyId, rows.map(row => row.id)]);
    for (const row of rows) perRow.set(row.id, perRow.get(row.id) ?? new Map());
    for (const row of rows) {
      perRow.get(row.id)!.set(def.id, { rows: [], schema: targetSchema.properties_json, target });
    }
    for (const item of linked.rows) perRow.get(item.owner_id)!.get(def.id)!.rows.push({ ...databaseRow(item), computed: item.computed_json ?? {} });
  }
  for (const row of rows) result.set(row.id, computeRow(row, properties, perRow.get(row.id) ?? new Map()));
  return result;
}

async function queueRows(client: Db, workspaceId: string, databaseId: string, rowIds: string[]): Promise<void> {
  if (!rowIds.length) return;
  await client.query(`INSERT INTO database_computed_dirty AS q (workspace_id, database_id, row_id)
    SELECT DISTINCT $1::uuid, $2::uuid, id FROM unnest($3::uuid[]) AS v(id)
    ON CONFLICT (workspace_id, row_id) DO UPDATE SET generation = q.generation + 1`, [workspaceId, databaseId, rowIds]);
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
  await queueLinkedRows(client, workspaceId, properties, rowIds, () => true);
}

/** Rows of other databases whose rollups, through a relation of `properties`, read a target `reads` accepts. */
async function queueLinkedRows(client: Db, workspaceId: string, properties: PropertyDefinition[], rowIds: string[],
  reads: (targetPropertyId: string) => boolean): Promise<void> {
  for (const def of activeProperties(properties)) {
    if (def.type !== 'relation' || !def.relation) continue;
    const other = await loadDatabaseSchema(client, workspaceId, def.relation.databaseId);
    const dependent = other && activeProperties(other.properties_json).some(item => item.type === 'rollup'
      && item.rollup!.relationPropertyId === def.relation!.pairedPropertyId && reads(item.rollup!.targetPropertyId));
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

function canonical(values: DatabaseRow['computed'] | null | undefined): string {
  return JSON.stringify(Object.entries(values ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Fills the cache for rows and queues the rows downstream whose rollups read a computed field that changed, so
 * a chain of databases is worked out in order, each after the one it reads.
 */
async function store(client: Db, workspaceId: string, databaseId: string, properties: PropertyDefinition[], rows: DatabaseRow[]): Promise<void> {
  if (!rows.length) return;
  const values = await computeValues(client, workspaceId, properties, rows);
  const before = await client.query<{ row_id: string; values_json: DatabaseRow['computed'] }>(`SELECT row_id, values_json FROM database_computed
    WHERE workspace_id = $1 AND row_id = ANY($2::uuid[])`, [workspaceId, rows.map(row => row.id)]);
  const old = new Map(before.rows.map(row => [row.row_id, canonical(row.values_json)]));
  await client.query(`INSERT INTO database_computed (workspace_id, database_id, row_id, values_json)
    SELECT $1, $2, v.id, v.body::jsonb FROM unnest($3::uuid[], $4::text[]) AS v(id, body)
    ON CONFLICT (workspace_id, row_id) DO UPDATE SET values_json = EXCLUDED.values_json`,
  [workspaceId, databaseId, rows.map(row => row.id), rows.map(row => JSON.stringify(values.get(row.id) ?? {}))]);
  const changed = rows.filter(row => old.get(row.id) !== canonical(values.get(row.id))).map(row => row.id);
  const computedIds = new Set(activeProperties(properties).filter(isComputedProperty).map(def => def.id));
  if (changed.length && computedIds.size) await queueLinkedRows(client, workspaceId, properties, changed, id => computedIds.has(id));
}

interface PendingDatabase { workspaceId: string; databaseId: string; dirty: boolean }

/** Pending databases looked at per batch to find one whose inputs are current. */
const pendingScan = 50;

/**
 * The database to work on next: one whose rollups read no computed field of another database that still has
 * work, so results flow downstream in order. Rows waiting individually come before sweeps. When every candidate
 * waits on another, which only a cycle left by older data can cause, the first is taken.
 */
async function nextPending(client: Db): Promise<PendingDatabase | null> {
  const dirty = await client.query<{ workspace_id: string; database_id: string }>(`SELECT workspace_id, database_id FROM database_computed_dirty
    GROUP BY workspace_id, database_id LIMIT ${pendingScan}`);
  const sweeps = await client.query<{ workspace_id: string; page_id: string }>(`SELECT workspace_id, page_id FROM databases
    WHERE computed_done_generation < computed_generation LIMIT ${pendingScan}`);
  const candidates: PendingDatabase[] = [
    ...dirty.rows.map(row => ({ workspaceId: row.workspace_id, databaseId: row.database_id, dirty: true })),
    ...sweeps.rows.map(row => ({ workspaceId: row.workspace_id, databaseId: row.page_id, dirty: false })),
  ];
  if (candidates.length <= 1) return candidates[0] ?? null;
  const pending = new Set(candidates.map(item => `${item.workspaceId}:${item.databaseId}`));
  for (const candidate of candidates) {
    const upstream = await computedUpstream(client, candidate.workspaceId, candidate.databaseId);
    if (!upstream.some(id => id !== candidate.databaseId && pending.has(`${candidate.workspaceId}:${id}`))) return candidate;
  }
  return candidates[0]!;
}

/** Other databases whose computed fields the rollups of a database read. */
async function computedUpstream(client: Db, workspaceId: string, databaseId: string): Promise<string[]> {
  const schema = await loadDatabaseSchema(client, workspaceId, databaseId);
  if (!schema) return [];
  const active = new Map(activeProperties(schema.properties_json).map(def => [def.id, def]));
  const result = new Set<string>();
  for (const def of active.values()) {
    if (def.type !== 'rollup') continue;
    const relation = active.get(def.rollup!.relationPropertyId);
    if (relation?.type !== 'relation' || !relation.relation || result.has(relation.relation.databaseId)) continue;
    const other = await loadDatabaseSchema(client, workspaceId, relation.relation.databaseId);
    const target = other && activeProperties(other.properties_json).find(item => item.id === def.rollup!.targetPropertyId);
    if (target && isComputedProperty(target)) result.add(relation.relation.databaseId);
  }
  return [...result];
}

/**
 * Databases this one reads computed fields from, directly or further up, up to the depth a chain may have.
 * A database's computed values are stale while any of them still has work.
 */
export async function computedSources(client: Db, workspaceId: string, databaseId: string): Promise<string[]> {
  const seen = new Set<string>([databaseId]);
  let frontier = [databaseId];
  for (let depth = 0; depth < formulaDepthLimit && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of await computedUpstream(client, workspaceId, id)) {
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  seen.delete(databaseId);
  return [...seen];
}

/** Works through one batch without the workspace lock. Returns false when no batch can be taken. */
export async function runComputedBatch(pool: Pick<Pool, 'connect'>, limit = batchSize): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize cache writers, including sweeps, without holding dirty-row locks during computation.
    const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [computedWorkerLockKey]);
    if (!lock.rows[0]!.acquired) { await client.query('COMMIT'); return false; }
    const next = await nextPending(client);
    if (!next) { await client.query('COMMIT'); return false; }
    if (next.dirty) {
      const { workspaceId, databaseId } = next;
      const jobs = (await client.query<{ row_id: string; generation: string }>(`SELECT row_id, generation::text FROM database_computed_dirty
        WHERE workspace_id = $1 AND database_id = $2 LIMIT $3`, [workspaceId, databaseId, limit])).rows;
      const ids = jobs.map(row => row.row_id);
      const schema = await loadDatabaseSchema(client, workspaceId, databaseId);
      if (schema) await store(client, workspaceId, databaseId, schema.properties_json, await loadRows(client, workspaceId, ids));
      // An edit may have bumped this job's generation or still be holding its row lock. Leave both for another batch.
      await client.query(`WITH finished AS (
        SELECT q.row_id FROM database_computed_dirty q
        JOIN unnest($2::uuid[], $3::bigint[]) AS v(id, generation) ON q.row_id = v.id AND q.generation = v.generation
        WHERE q.workspace_id = $1 FOR UPDATE OF q SKIP LOCKED
      ) DELETE FROM database_computed_dirty q USING finished f WHERE q.workspace_id = $1 AND q.row_id = f.row_id`,
      [workspaceId, ids, jobs.map(row => row.generation)]);
      await client.query('COMMIT');
      return true;
    }
    const head = await client.query<{ workspace_id: string; page_id: string; properties_json: PropertyDefinition[]; computed_cursor: string | null }>(`
      SELECT workspace_id, page_id, properties_json, computed_cursor FROM databases WHERE workspace_id = $1 AND page_id = $2
        AND computed_done_generation < computed_generation FOR UPDATE SKIP LOCKED`, [next.workspaceId, next.databaseId]);
    const job = head.rows[0];
    // A schema save holds the row; another batch picks it up afterwards.
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
