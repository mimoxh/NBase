import { activeProperties, computedDependencyProblem, databaseSchemaChangePreview, diffDatabaseSchemas, formulaDepthLimit, isComputedProperty,
  rollupSourceDatabases, type DatabaseSchemaHistoryResponse, type DatabaseSchemaOperation, type DatabaseSchemaVersion,
  type DatabaseSchemaVersionSummary, type DatabaseView, type PropertyDefinition } from '@nbase/contracts';
import type { PoolClient } from 'pg';
import { PageError } from '../pages/repository.js';
import { loadDatabaseSchema } from './schema.js';

type Db = Pick<PoolClient, 'query'>;

/**
 * Keeps the schema a write just produced as a version. Called after every write of `properties_json` or
 * `views_json`, in the same transaction, so the history has each revision the database had.
 */
export async function recordSchemaVersion(client: Db, workspaceId: string, databaseId: string, actorId: string | null,
  operation: Exclude<DatabaseSchemaOperation, 'baseline'>, restoredFrom: string | null = null): Promise<void> {
  await client.query(`INSERT INTO database_schema_versions (workspace_id, database_id, revision, properties_json, views_json, saved_at,
      actor_user_id, operation, restored_from)
    SELECT workspace_id, page_id, revision, properties_json, views_json, updated_at, $3, $4, $5 FROM databases
    WHERE workspace_id = $1 AND page_id = $2 ON CONFLICT DO NOTHING`, [workspaceId, databaseId, actorId, operation, restoredFrom]);
}

interface VersionRow {
  revision: string; properties_json: PropertyDefinition[]; views_json: DatabaseView[]; saved_at: Date;
  actor_user_id: string | null; actor_name: string | null; operation: DatabaseSchemaOperation; restored_from: string | null;
}

const versionColumns = `v.revision::text AS revision, v.properties_json, v.views_json, v.saved_at, v.actor_user_id, u.login_name AS actor_name,
  v.operation, v.restored_from::text AS restored_from`;

function summary(row: VersionRow, previous: VersionRow | undefined, limit = databaseSchemaChangePreview): DatabaseSchemaVersionSummary {
  const changes = previous ? diffDatabaseSchemas({ properties: previous.properties_json, views: previous.views_json },
    { properties: row.properties_json, views: row.views_json }) : [];
  return { revision: row.revision, savedAt: row.saved_at.toISOString(),
    actor: row.actor_user_id ? { id: row.actor_user_id, name: row.actor_name ?? '' } : null,
    operation: row.operation, restoredFrom: row.restored_from, changes: changes.slice(0, limit), changeCount: changes.length };
}

/** A database not in the trash. Membership of the reader is checked by the route's `authorizeWorkspace`. */
async function visibleDatabase(client: Db, workspaceId: string, databaseId: string): Promise<boolean> {
  const found = await client.query(`SELECT 1 FROM databases d
    JOIN pages p ON p.workspace_id = d.workspace_id AND p.id = d.page_id AND p.deleted_at IS NULL AND p.kind = 'database'
    WHERE d.workspace_id = $1 AND d.page_id = $2`, [workspaceId, databaseId]);
  return found.rows.length > 0;
}

/** Newest first, `limit` at a time, each compared with the version before it. */
export async function listSchemaHistory(client: Db, workspaceId: string, databaseId: string,
  before: string | null, limit: number): Promise<DatabaseSchemaHistoryResponse | null> {
  if (!await visibleDatabase(client, workspaceId, databaseId)) return null;
  const rows = await client.query<VersionRow>(`SELECT ${versionColumns} FROM database_schema_versions v
    LEFT JOIN users u ON u.id = v.actor_user_id
    WHERE v.workspace_id = $1 AND v.database_id = $2 AND ($3::bigint IS NULL OR v.revision < $3::bigint)
    ORDER BY v.revision DESC LIMIT $4`, [workspaceId, databaseId, before, limit + 1]);
  const shown = rows.rows.slice(0, limit);
  return { versions: shown.map((row, index) => summary(row, rows.rows[index + 1])),
    nextBefore: rows.rows.length > limit ? shown.at(-1)!.revision : null };
}

export async function readSchemaVersion(client: Db, workspaceId: string, databaseId: string,
  revision: string): Promise<DatabaseSchemaVersion | null> {
  if (!await visibleDatabase(client, workspaceId, databaseId)) return null;
  const rows = await client.query<VersionRow>(`SELECT ${versionColumns} FROM database_schema_versions v
    LEFT JOIN users u ON u.id = v.actor_user_id
    WHERE v.workspace_id = $1 AND v.database_id = $2 AND v.revision <= $3::bigint ORDER BY v.revision DESC LIMIT 2`,
  [workspaceId, databaseId, revision]);
  const row = rows.rows[0];
  if (!row || row.revision !== revision) return null;
  return { ...summary(row, rows.rows[1], Infinity), pageId: databaseId, properties: row.properties_json, views: row.views_json };
}

/** The stored version a restore starts from, read in the writer's transaction. */
export async function loadSchemaVersion(client: Db, workspaceId: string, databaseId: string, revision: string) {
  const rows = await client.query<{ properties_json: PropertyDefinition[]; views_json: DatabaseView[] }>(`SELECT properties_json, views_json
    FROM database_schema_versions WHERE workspace_id = $1 AND database_id = $2 AND revision = $3::bigint`, [workspaceId, databaseId, revision]);
  return rows.rows[0] ?? null;
}

/** Databases among `ids` that exist and are not in the trash. */
export async function activeDatabaseIds(client: Db, workspaceId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await client.query<{ id: string }>(`SELECT d.page_id AS id FROM databases d
    JOIN pages p ON p.workspace_id = d.workspace_id AND p.id = d.page_id AND p.deleted_at IS NULL
    WHERE d.workspace_id = $1 AND d.page_id = ANY($2::uuid[])`, [workspaceId, ids]);
  return new Set(rows.rows.map(row => row.id));
}

/** What the order of computation depends on: computed fields and the relations their rollups follow. */
function computedProjection(properties: PropertyDefinition[]): string {
  return JSON.stringify(activeProperties(properties).filter(def => isComputedProperty(def) || def.type === 'relation')
    .map(def => [def.id, def.formula?.expression ?? null, def.rollup ?? null, def.relation?.databaseId ?? null]));
}

/** At most this many databases are read to follow rollups; chains are also cut by `formulaDepthLimit`. */
const dependencyDatabaseLimit = 100;

/**
 * Rejects a schema whose computed fields read each other in a cycle, or in a chain longer than `formulaDepthLimit`,
 * following rollups into other databases. Schemas whose computed fields did not change are not checked, so a cycle
 * left by older data does not block unrelated edits.
 */
export async function checkComputedDependencies(client: Db, workspaceId: string, databaseId: string,
  before: PropertyDefinition[] | null, after: PropertyDefinition[]): Promise<void> {
  if (before && computedProjection(before) === computedProjection(after)) return;
  if (!after.some(def => isComputedProperty(def) && !def.deletedAt)) return;
  const schemas = new Map<string, PropertyDefinition[]>([[databaseId, after]]);
  let frontier = [databaseId];
  for (let depth = 0; depth <= formulaDepthLimit && frontier.length && schemas.size < dependencyDatabaseLimit; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of rollupSourceDatabases(schemas.get(id)!)) {
        if (schemas.has(other) || schemas.size >= dependencyDatabaseLimit) continue;
        const schema = await loadDatabaseSchema(client, workspaceId, other);
        if (!schema) continue;
        schemas.set(other, schema.properties_json);
        next.push(other);
      }
    }
    frontier = next;
  }
  const problem = computedDependencyProblem(databaseId, schemas);
  if (!problem) return;
  throw new PageError(422, problem.kind === 'cycle' ? 'DATABASE_FORMULA_CYCLE' : 'DATABASE_FORMULA_DEPTH', undefined, undefined,
    { path: problem.path, depthLimit: formulaDepthLimit });
}
