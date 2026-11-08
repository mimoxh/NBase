import { randomUUID } from 'node:crypto';
import { databaseRowLimit, databaseSchemaProblem, defaultDatabaseSchema, type CreateDatabaseRequest, type DatabaseDocument,
  type DatabaseRow, type DatabaseSchemaResponse, type DatabaseView, type PageSummary, type PropertyDefinition,
  type RowProperties, type UpdateDatabaseSchemaRequest } from '@nbase/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { isRevision, isUuid, PageError, type PgPageRepository } from '../pages/repository.js';
import { sendError } from '../pages/routes.js';
import { extractDocumentIndex } from '../pages/search-text.js';
import { validatePageIcon } from '../pages/validate.js';
import { loadDatabaseSchema, rowIndexText } from './schema.js';

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

/** Stable JSON for comparing schemas regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

interface DatabasePageRow {
  id: string; workspace_id: string; parent_id: string | null; title: string; icon: string | null;
  cover: PageSummary['cover']; revision: string; created_at: Date; updated_at: Date;
}

interface RowRecord {
  id: string; title: string; icon: string | null; row_properties: RowProperties | null; revision: string;
  created_at: Date; updated_at: Date;
}

function pageSummary(row: DatabasePageRow): PageSummary {
  return { id: row.id, workspaceId: row.workspace_id, parentId: row.parent_id, title: row.title, icon: row.icon ?? null,
    cover: row.cover ?? null, kind: 'database', revision: row.revision, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString() };
}

function databaseRow(row: RowRecord): DatabaseRow {
  return { id: row.id, title: row.title, icon: row.icon ?? null, properties: row.row_properties ?? {}, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

async function readDatabase(db: Pick<Pool, 'query'>, workspaceId: string, actorId: string,
  pageId: string): Promise<DatabaseDocument | null> {
  const page = await db.query<DatabasePageRow & { properties_json: PropertyDefinition[]; views_json: DatabaseView[];
    schema_revision: string }>(`
    SELECT p.id, p.workspace_id, p.parent_id, p.title, p.icon, p.cover, p.revision::text AS revision, p.created_at, p.updated_at,
      d.properties_json, d.views_json, d.revision::text AS schema_revision
    FROM pages p
    JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
    JOIN databases d ON d.workspace_id = p.workspace_id AND d.page_id = p.id
    WHERE p.workspace_id = $1 AND p.id = $3 AND p.deleted_at IS NULL AND p.kind = 'database'
  `, [workspaceId, actorId, pageId]);
  const head = page.rows[0];
  if (!head) return null;
  const rows = await db.query<RowRecord>(`
    SELECT id, title, icon, row_properties, revision::text AS revision, created_at, updated_at FROM pages
    WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL AND kind = 'row'
    ORDER BY sort_position, id LIMIT $3
  `, [workspaceId, pageId, databaseRowLimit]);
  return { page: pageSummary(head), properties: head.properties_json, views: head.views_json,
    schemaRevision: head.schema_revision, rows: rows.rows.map(databaseRow) };
}

/** Option names and property removal change what row search text should contain. */
async function reindexRows(client: PoolClient, workspaceId: string, pageId: string,
  properties: PropertyDefinition[]): Promise<void> {
  const rows = await client.query<{ id: string; content_json: Parameters<typeof extractDocumentIndex>[0];
    row_properties: RowProperties | null }>(`SELECT id, content_json, row_properties FROM pages
    WHERE workspace_id = $1 AND parent_id = $2 AND kind = 'row'`, [workspaceId, pageId]);
  if (!rows.rows.length) return;
  const ids: string[] = [];
  const texts: string[] = [];
  for (const row of rows.rows) {
    ids.push(row.id);
    texts.push(rowIndexText(extractDocumentIndex(row.content_json).searchText, properties, row.row_properties ?? {}));
  }
  await client.query(`UPDATE pages p SET search_text = v.text
    FROM unnest($2::uuid[], $3::text[]) AS v(id, text) WHERE p.workspace_id = $1 AND p.id = v.id`, [workspaceId, ids, texts]);
}

export function registerDatabaseRoutes(app: FastifyInstance, pool: Pool, pages: PgPageRepository,
  auth: AuthRepository, publicOrigin: string): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const authorize = (request: FastifyRequest, workspaceId: string, write: boolean) =>
    authorizeWorkspace(request, auth, origin, secure, workspaceId, write, write ? 'application/json' : undefined);
  const base = '/api/workspaces/:workspaceId/databases';

  app.get<{ Params: DatabaseParams }>(`${base}/:pageId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      const actorId = await authorize(request, workspaceId, false);
      if (!isUuid(pageId)) throw new PageError(404, 'NOT_FOUND');
      const database = await readDatabase(pool, workspaceId, actorId, pageId.toLowerCase());
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
      const result = await pages.mutate<DatabaseSchemaResponse>(workspaceId, actorId, body.clientMutationId,
        'database-update', pageId, body, async client => {
          const active = await client.query('SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
            [workspaceId, pageId]);
          const current = active.rows[0] ? await loadDatabaseSchema(client, workspaceId, pageId, true) : null;
          if (!current) throw new PageError(404, 'NOT_FOUND');
          if (current.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', current.revision);
          // Properties are only soft-deleted, and the title property keeps its identity.
          const next = new Map(body.properties.map(property => [property.id, property]));
          for (const property of current.properties_json) {
            const replacement = next.get(property.id);
            if (!replacement || (property.type === 'title') !== (replacement.type === 'title')) {
              throw new PageError(422, 'DATABASE_SCHEMA_INVALID');
            }
          }
          const updated = await client.query<{ revision: string }>(`UPDATE databases SET properties_json = $3::jsonb,
            views_json = $4::jsonb, revision = revision + 1, updated_at = now()
            WHERE workspace_id = $1 AND page_id = $2 RETURNING revision::text AS revision`,
          [workspaceId, pageId, JSON.stringify(body.properties), JSON.stringify(body.views)]);
          if (canonical(current.properties_json) !== canonical(body.properties)) {
            await reindexRows(client, workspaceId, pageId, body.properties);
          }
          return { statusCode: 200, body: { pageId, properties: body.properties, views: body.views,
            schemaRevision: updated.rows[0]!.revision } };
        }, response => response.pageId);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });
}
