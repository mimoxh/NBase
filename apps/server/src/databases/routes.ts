import { randomUUID } from 'node:crypto';
import { databaseQueryWindow, databaseRelationLimit, databaseSchemaHistoryPage, databaseSchemaProblem, defaultDatabaseSchema,
  isRestoreDatabaseSchemaRequest, planSchemaRestore, type RestoreDatabaseSchemaResponse, isChangeRelationRequest, isCreateRelationRequest, isDatabaseAggregateRequest, isDatabaseBulkRequest, isDatabaseQueryRequest,
  type ChangeRelationResponse, type CreateDatabaseRequest,
  type DatabaseBulkResponse, type DatabaseDocument, type DatabaseSchemaResponse, type DatabaseView, type PageSummary, type PropertyDefinition,
  type UpdateDatabaseSchemaRequest } from '@nbase/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { isRevision, isUuid, PageError, type PgPageRepository } from '../pages/repository.js';
import { sendError } from '../pages/routes.js';
import { managedPropertyIds } from '../calendar/locks.js';
import { attendeeRowIds, sourceForDatabase, toSyncSource } from '../calendar/sources.js';
import { validatePageIcon } from '../pages/validate.js';
import { applyBulk } from './bulk.js';
import { markSchemaChanged } from './computed.js';
import { activeDatabaseIds, checkComputedDependencies, listSchemaHistory, loadSchemaVersion, readSchemaVersion,
  recordSchemaVersion } from './history.js';
import { changeRelation, createRelation, mirrorRelationDeletion, relationsUnchanged } from './relations.js';
import { readDatabaseRows, runDatabaseAggregate, runDatabaseQuery } from './query.js';
import { databaseRow, loadDatabaseSchema, rowTagIdsColumn, searchProjection, type DatabaseSchemaRow, type RowRecord } from './schema.js';
import { DatabaseWorker, selectRowsForIndex, writeRowSearchText } from './worker.js';

interface WorkspaceParams { workspaceId: string }
interface DatabaseParams extends WorkspaceParams { pageId: string }

const emptyContent = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0,
  direction: null, children: [] } } };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestError(): never { throw new WorkspaceRouteError(400, 'INVALID_REQUEST'); }

function createBody(value: unknown): CreateDatabaseRequest {
  if (!object(value) || !isUuid(value.clientMutationId) || !(value.parentId === null || isUuid(value.parentId))
    || typeof value.title !== 'string' || value.title.length > 255) requestError();
  const body: CreateDatabaseRequest = { clientMutationId: value.clientMutationId, parentId: value.parentId, title: value.title };
  if (Object.hasOwn(value, 'icon')) body.icon = validatePageIcon(value.icon);
  return body;
}

function updateBody(value: unknown): UpdateDatabaseSchemaRequest {
  if (!object(value) || !isUuid(value.clientMutationId) || !isRevision(value.expectedRevision)
    || !Array.isArray(value.properties) || !Array.isArray(value.views)) requestError();
  if (databaseSchemaProblem(value.properties, value.views)) throw new PageError(422, 'DATABASE_SCHEMA_INVALID');
  return { clientMutationId: value.clientMutationId, expectedRevision: value.expectedRevision,
    properties: value.properties as PropertyDefinition[], views: value.views as DatabaseView[] };
}

interface DatabasePageRow {
  id: string; workspace_id: string; parent_id: string | null; title: string; icon: string | null;
  cover: PageSummary['cover']; revision: string; created_at: Date; updated_at: Date;
}

function pageSummary(row: DatabasePageRow): PageSummary {
  return { id: row.id, workspaceId: row.workspace_id, parentId: row.parent_id, title: row.title, icon: row.icon ?? null,
    cover: row.cover ?? null, kind: 'database', revision: row.revision, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString() };
}

/** The plain read is for tools and tests; the app reads rows through /query, which has no such cap. */
const wholeReadLimit = 2000;

async function readDatabase(db: Pick<Pool, 'query'>, workspaceId: string, actorId: string,
  pageId: string, withRows: boolean, credentialKeyId: string | null): Promise<DatabaseDocument | null> {
  const page = await db.query<DatabasePageRow & { properties_json: PropertyDefinition[]; views_json: DatabaseView[];
    schema_revision: string }>(`
    SELECT p.id, p.workspace_id, p.parent_id, p.title, p.icon, p.cover, p.revision::text AS revision, p.created_at, p.updated_at,
      d.properties_json, d.views_json, d.revision::text AS schema_revision
    FROM pages p
    JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2 AND m.removed_at IS NULL
    JOIN databases d ON d.workspace_id = p.workspace_id AND d.page_id = p.id
    WHERE p.workspace_id = $1 AND p.id = $3 AND p.deleted_at IS NULL AND p.kind = 'database'
  `, [workspaceId, actorId, pageId]);
  const head = page.rows[0];
  if (!head) return null;
  const source = await sourceForDatabase(db, workspaceId, pageId);
  const readOnlyRowIds = source?.kind === 'caldav' ? await attendeeRowIds(db, workspaceId, source.id) : undefined;
  const sync = source ? { calendarSync: toSyncSource(source, { keyId: credentialKeyId, ...(readOnlyRowIds ? { readOnlyRowIds } : {}) }) } : {};
  if (!withRows) return { page: pageSummary(head), properties: head.properties_json, views: head.views_json,
    schemaRevision: head.schema_revision, rows: [], ...sync };
  const rows = await db.query<RowRecord>(`
    SELECT p.id, p.title, p.icon, p.row_properties, p.revision::text AS revision, p.created_at, p.updated_at, ${rowTagIdsColumn} FROM pages p
    WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.deleted_at IS NULL AND p.kind = 'row'
    ORDER BY p.sort_position, p.id LIMIT $3
  `, [workspaceId, pageId, wholeReadLimit]);
  return { page: pageSummary(head), properties: head.properties_json, views: head.views_json,
    schemaRevision: head.schema_revision, rows: rows.rows.map(databaseRow), ...sync };
}

/** Up to this many rows are reindexed in the schema transaction; larger databases go to the background worker. */
const inlineReindexLimit = 500;

/**
 * Option names and property removal change what row search text should contain. Reports whether
 * the background worker has work, since the workspace lock must not be held across a large database.
 */
async function reindexRows(client: PoolClient, workspaceId: string, pageId: string, properties: PropertyDefinition[]): Promise<boolean> {
  const rows = await selectRowsForIndex(client, workspaceId, pageId, null, inlineReindexLimit + 1);
  if (rows.length <= inlineReindexLimit) {
    await writeRowSearchText(client, workspaceId, rows, properties);
    // A sweep already under way would only redo the same text.
    await client.query(`UPDATE databases SET search_indexed_generation = search_generation, search_cursor = NULL
      WHERE workspace_id = $1 AND page_id = $2`, [workspaceId, pageId]);
    return false;
  }
  await client.query(`UPDATE databases SET search_generation = search_generation + 1, search_cursor = NULL
    WHERE workspace_id = $1 AND page_id = $2`, [workspaceId, pageId]);
  return true;
}

interface SchemaWrite {
  properties: PropertyDefinition[];
  views: DatabaseView[];
  operation: 'update' | 'restore';
  restoredFrom?: string;
}

/**
 * Writes fields and views of a locked database whose revision the caller checked, and records the version.
 * Returns the saved schema and whether the background worker has work.
 */
async function writeSchema(client: PoolClient, workspaceId: string, actorId: string, pageId: string, current: DatabaseSchemaRow,
  write: SchemaWrite): Promise<{ response: DatabaseSchemaResponse; backgroundWork: boolean }> {
  // Properties are only soft-deleted, and the title property keeps its identity.
  const next = new Map(write.properties.map(property => [property.id, property]));
  // Fields a calendar source writes keep their type and stay, so the next sync still has a place to write.
  const managed = await managedPropertyIds(client, workspaceId, pageId);
  for (const property of current.properties_json) {
    const replacement = next.get(property.id);
    if (!replacement || (property.type === 'title') !== (replacement.type === 'title')) {
      throw new PageError(422, 'DATABASE_SCHEMA_INVALID');
    }
    if (managed.has(property.id) && (replacement.type !== property.type || (replacement.deletedAt && !property.deletedAt))) {
      throw new PageError(422, 'DATABASE_SCHEMA_INVALID', undefined, 'property-synced');
    }
  }
  if (!relationsUnchanged(current.properties_json, write.properties)) throw new PageError(422, 'DATABASE_SCHEMA_INVALID');
  await checkComputedDependencies(client, workspaceId, pageId, current.properties_json, write.properties);
  const properties = await mirrorRelationDeletion(client, workspaceId, actorId, current.properties_json, write.properties);
  const updated = await client.query<{ revision: string }>(`UPDATE databases SET properties_json = $3::jsonb,
    views_json = $4::jsonb, revision = revision + 1, updated_at = now()
    WHERE workspace_id = $1 AND page_id = $2 RETURNING revision::text AS revision`,
  [workspaceId, pageId, JSON.stringify(properties), JSON.stringify(write.views)]);
  await recordSchemaVersion(client, workspaceId, pageId, actorId, write.operation, write.restoredFrom ?? null);
  let backgroundWork = false;
  if (searchProjection(current.properties_json) !== searchProjection(properties)
    && await reindexRows(client, workspaceId, pageId, properties)) backgroundWork = true;
  if (JSON.stringify(current.properties_json) !== JSON.stringify(properties)) {
    await markSchemaChanged(client, workspaceId, pageId, properties);
    backgroundWork = true;
  }
  return { response: { pageId, properties, views: write.views, schemaRevision: updated.rows[0]!.revision }, backgroundWork };
}

/** The database for a schema write, locked, at the revision the reader expects. */
async function lockedSchema(client: PoolClient, workspaceId: string, pageId: string, expectedRevision: string): Promise<DatabaseSchemaRow> {
  const active = await client.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND kind = 'database'`,
    [workspaceId, pageId]);
  const current = active.rows[0] ? await loadDatabaseSchema(client, workspaceId, pageId, true) : null;
  if (!current) throw new PageError(404, 'NOT_FOUND');
  if (current.revision !== expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', current.revision);
  return current;
}
/** `credentialKeyId` is the id of the CalDAV credential key this server holds, for `calendarSync.caldav.credentialsOk`. */
export function registerDatabaseRoutes(app: FastifyInstance, pool: Pool, pages: PgPageRepository,
  auth: AuthRepository, publicOrigin: string, credentialKeyId: string | null = null): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const worker = new DatabaseWorker(pool, error => app.log.error({ err: error }, 'database worker failed'));
  worker.start();
  app.addHook('onClose', () => worker.close());
  const authorize = (request: FastifyRequest, workspaceId: string, write: boolean | 'post-read') =>
    authorizeWorkspace(request, auth, origin, secure, workspaceId, write, write ? 'application/json' : undefined);
  const base = '/api/workspaces/:workspaceId/databases';

  app.post<{ Params: DatabaseParams }>(`${base}/:pageId/query`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      const actorId = await authorize(request, workspaceId, 'post-read');
      if (!isUuid(pageId)) throw new PageError(404, 'NOT_FOUND');
      if (!isDatabaseQueryRequest(request.body)) requestError();
      const result = await runDatabaseQuery(pool, workspaceId, actorId, pageId.toLowerCase(), request.body);
      if (!result) throw new PageError(404, 'NOT_FOUND');
      return reply.send(result);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: DatabaseParams }>(`${base}/:pageId/relations`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new PageError(404, 'NOT_FOUND');
      const pageId = request.params.pageId.toLowerCase();
      const body = request.body;
      if (!isCreateRelationRequest(body)) requestError();
      const result = await pages.mutate<DatabaseSchemaResponse>(workspaceId, actorId, body.clientMutationId, 'database-relation-create', pageId, body,
        async client => ({ statusCode: 200, body: await createRelation(client, workspaceId, actorId, pageId, body) }), response => response.pageId);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: DatabaseParams & { rowId: string; propertyId: string } }>(`${base}/:pageId/rows/:rowId/relations/:propertyId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (![request.params.pageId, request.params.rowId, request.params.propertyId].every(isUuid)) throw new PageError(404, 'NOT_FOUND');
      const [pageId, rowId, propertyId] = [request.params.pageId, request.params.rowId, request.params.propertyId].map(id => id.toLowerCase()) as [string, string, string];
      const body = request.body;
      if (!isChangeRelationRequest(body)) requestError();
      const result = await pages.mutate<ChangeRelationResponse>(workspaceId, actorId, body.clientMutationId, 'database-relation-change', pageId, { rowId, propertyId, ...body },
        async client => ({ statusCode: 200, body: await changeRelation(client, workspaceId, actorId, pageId, rowId, propertyId, body, pages.snapshot.bind(pages)) }), response => response.pageId);
      worker.nudge();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: DatabaseParams }>(`${base}/:pageId/aggregate`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      const actorId = await authorize(request, workspaceId, 'post-read');
      if (!isUuid(pageId)) throw new PageError(404, 'NOT_FOUND');
      if (!isDatabaseAggregateRequest(request.body)) requestError();
      const result = await runDatabaseAggregate(pool, workspaceId, actorId, pageId.toLowerCase(), request.body);
      if (!result) throw new PageError(404, 'NOT_FOUND');
      return reply.send(result);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: DatabaseParams }>(`${base}/:pageId/rows/bulk`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new PageError(404, 'NOT_FOUND');
      const pageId = request.params.pageId.toLowerCase();
      const body = request.body;
      if (!isDatabaseBulkRequest(body)) requestError();
      const result = await pages.mutate<DatabaseBulkResponse>(workspaceId, actorId, body.clientMutationId, 'database-bulk', pageId, body,
        async client => ({ statusCode: 200, body: await applyBulk(client, workspaceId, actorId, pageId, body, pages.snapshot.bind(pages)) }),
        response => response.pageId);
      worker.nudge();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: DatabaseParams }>(`${base}/:pageId/rows/read`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      const actorId = await authorize(request, workspaceId, 'post-read');
      if (!isUuid(pageId)) throw new PageError(404, 'NOT_FOUND');
      const body = request.body;
      if (!object(body) || !Array.isArray(body.ids) || body.ids.length > databaseQueryWindow || !body.ids.every(isUuid)) requestError();
      const preview = body.relationPreview;
      if (preview !== undefined && !(Number.isInteger(preview) && (preview as number) >= 1 && (preview as number) <= databaseRelationLimit)) requestError();
      const rows = await readDatabaseRows(pool, workspaceId, actorId, pageId.toLowerCase(), (body.ids as string[]).map(id => id.toLowerCase()), preview as number | undefined);
      if (!rows) throw new PageError(404, 'NOT_FOUND');
      return reply.send({ rows });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: DatabaseParams; Querystring: { rows?: string } }>(`${base}/:pageId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      const actorId = await authorize(request, workspaceId, false);
      if (!isUuid(pageId)) throw new PageError(404, 'NOT_FOUND');
      const database = await readDatabase(pool, workspaceId, actorId, pageId.toLowerCase(), request.query.rows !== 'none',
        credentialKeyId);
      if (!database) throw new PageError(404, 'NOT_FOUND');
      return reply.send(database);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: WorkspaceParams }>(base, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const body = createBody(request.body);
      const result = await pages.mutate<DatabaseDocument>(workspaceId, actorId, body.clientMutationId, 'database-create', null,
        body, async client => {
          const created = await pages.createInTransaction(client, workspaceId, actorId, {
            clientMutationId: body.clientMutationId, parentId: body.parentId, title: body.title, content: emptyContent,
            ...(body.icon !== undefined ? { icon: body.icon } : {}),
          }, 'database');
          const schema = defaultDatabaseSchema({ title: randomUUID(), view: randomUUID() });
          const inserted = await client.query<{ revision: string }>(`INSERT INTO databases
            (workspace_id, page_id, properties_json, views_json) VALUES ($1, $2, $3::jsonb, $4::jsonb)
            RETURNING revision::text AS revision`,
          [workspaceId, created.body.id, JSON.stringify(schema.properties), JSON.stringify(schema.views)]);
          await recordSchemaVersion(client, workspaceId, created.body.id, actorId, 'create');
          const { content: _content, properties: _properties, ...page } = created.body;
          void _content; void _properties;
          return { statusCode: 201, body: { page, properties: schema.properties, views: schema.views,
            schemaRevision: inserted.rows[0]!.revision, rows: [] } };
        }, response => response.page.id);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.patch<{ Params: DatabaseParams }>(`${base}/:pageId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new PageError(404, 'NOT_FOUND');
      const pageId = request.params.pageId.toLowerCase();
      const body = updateBody(request.body);
      let backgroundWork = false;
      const result = await pages.mutate<DatabaseSchemaResponse>(workspaceId, actorId, body.clientMutationId,
        'database-update', pageId, body, async client => {
          const current = await lockedSchema(client, workspaceId, pageId, body.expectedRevision);
          const saved = await writeSchema(client, workspaceId, actorId, pageId, current,
            { properties: body.properties, views: body.views, operation: 'update' });
          backgroundWork = saved.backgroundWork;
          return { statusCode: 200, body: saved.response };
        }, response => response.pageId);
      if (backgroundWork) worker.nudge();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: DatabaseParams; Querystring: { before?: string; limit?: string } }>(`${base}/:pageId/schema-history`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      await authorize(request, workspaceId, false);
      if (!isUuid(pageId)) throw new PageError(404, 'NOT_FOUND');
      const { before, limit } = request.query;
      if (before !== undefined && !isRevision(before)) requestError();
      const count = limit === undefined ? databaseSchemaHistoryPage : Number(limit);
      if (!Number.isInteger(count) || count < 1 || count > databaseSchemaHistoryPage) requestError();
      const client = await pool.connect();
      try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const history = await listSchemaHistory(client, workspaceId, pageId.toLowerCase(), before ?? null, count);
        await client.query('COMMIT');
        if (!history) throw new PageError(404, 'NOT_FOUND');
        return reply.send(history);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: DatabaseParams & { revision: string } }>(`${base}/:pageId/schema-history/:revision`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId, revision } = request.params;
      await authorize(request, workspaceId, false);
      if (!isUuid(pageId) || !isRevision(revision)) throw new PageError(404, 'NOT_FOUND');
      const version = await readSchemaVersion(pool, workspaceId, pageId.toLowerCase(), revision);
      if (!version) throw new PageError(404, 'NOT_FOUND');
      return reply.send(version);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: DatabaseParams & { revision: string } }>(`${base}/:pageId/schema-history/:revision/restore`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, revision } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (!isUuid(request.params.pageId) || !isRevision(revision)) throw new PageError(404, 'NOT_FOUND');
      const pageId = request.params.pageId.toLowerCase();
      const body = request.body;
      if (!isRestoreDatabaseSchemaRequest(body)) requestError();
      let backgroundWork = false;
      const result = await pages.mutate<RestoreDatabaseSchemaResponse>(workspaceId, actorId, body.clientMutationId,
        'database-schema-restore', pageId, { revision, ...body }, async client => {
          const current = await lockedSchema(client, workspaceId, pageId, body.expectedRevision);
          const version = await loadSchemaVersion(client, workspaceId, pageId, revision);
          if (!version) throw new PageError(404, 'NOT_FOUND');
          const relationTargets = [...current.properties_json, ...version.properties_json]
            .flatMap(def => def.type === 'relation' && def.relation ? [def.relation.databaseId] : []);
          const plan = planSchemaRestore({ properties: current.properties_json, views: current.views_json as DatabaseView[] },
            { properties: version.properties_json, views: version.views_json }, {
              activeDatabaseIds: await activeDatabaseIds(client, workspaceId, [...new Set(relationTargets)]),
              managedPropertyIds: await managedPropertyIds(client, workspaceId, pageId),
              now: new Date().toISOString(),
            });
          const problem = databaseSchemaProblem(plan.properties, plan.views);
          if (problem) throw new PageError(422, 'DATABASE_SCHEMA_INVALID', undefined, problem);
          const saved = await writeSchema(client, workspaceId, actorId, pageId, current,
            { properties: plan.properties, views: plan.views, operation: 'restore', restoredFrom: revision });
          backgroundWork = saved.backgroundWork;
          return { statusCode: 200, body: { ...saved.response, restoredFrom: revision, notes: plan.notes } };
        }, response => response.pageId);
      if (backgroundWork) worker.nudge();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });
}
