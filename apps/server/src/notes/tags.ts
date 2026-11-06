import { randomUUID } from 'node:crypto';
import { tagNameKey, tagNameLimit, type WorkspaceTag } from '@nbase/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace } from '../auth/workspace.js';
import { isUuid, PageError, type PgPageRepository } from '../pages/repository.js';
import { sendError } from '../pages/routes.js';
import { PageFieldError } from '../pages/validate.js';

interface WorkspaceParams { workspaceId: string }
interface TagParams extends WorkspaceParams { tagId: string }
interface TagRow { id: string; name: string; page_count: number }

function mutationBody(value: unknown): { clientMutationId: string; name?: unknown } {
  if (!value || typeof value !== 'object' || !('clientMutationId' in value) || !isUuid(value.clientMutationId)) {
    throw new PageFieldError();
  }
  return { clientMutationId: value.clientMutationId, ...('name' in value ? { name: value.name } : {}) };
}

function validateTagName(value: unknown): { name: string; key: string } {
  if (typeof value !== 'string') throw new PageFieldError();
  const name = value.trim().normalize('NFC');
  if (!name || name.length > tagNameLimit * 2 || [...name].length > tagNameLimit || /[\p{Cc}\p{Cs}]/u.test(name)) {
    throw new PageFieldError();
  }
  return { name, key: tagNameKey(name) };
}

const tagColumns = `t.id, t.name, (
  SELECT count(p.id)::int FROM page_tags pt JOIN pages p ON p.workspace_id = pt.workspace_id AND p.id = pt.page_id
  WHERE pt.workspace_id = t.workspace_id AND pt.tag_id = t.id AND p.deleted_at IS NULL
) AS page_count`;
const toTag = ({ id, name, page_count }: TagRow): WorkspaceTag => ({ id, name, pageCount: page_count });

export function registerTagRoutes(app: FastifyInstance, pool: Pool, pages: PgPageRepository,
  auth: AuthRepository, publicOrigin: string): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const authorize = (request: FastifyRequest, workspaceId: string, write: boolean) =>
    authorizeWorkspace(request, auth, origin, secure, workspaceId, write, write ? 'application/json' : undefined);
  const tagsPath = '/api/workspaces/:workspaceId/tags';

  app.get<{ Params: WorkspaceParams }>(tagsPath, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, false);
      const result = await pool.query<TagRow>(`SELECT ${tagColumns} FROM workspace_tags t
        JOIN workspace_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = $2
        WHERE t.workspace_id = $1 ORDER BY t.name_key, t.id`, [workspaceId, actorId]);
      return reply.send({ tags: result.rows.map(toTag) });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: WorkspaceParams }>(tagsPath, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const body = mutationBody(request.body);
      const { name, key } = validateTagName(body.name);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'tag-create', null, { name }, async client => {
        const id = randomUUID();
        const inserted = await client.query(`INSERT INTO workspace_tags (workspace_id, id, name, name_key)
          VALUES ($1, $2, $3, $4) ON CONFLICT ON CONSTRAINT workspace_tags_name_key DO NOTHING RETURNING id`,
        [workspaceId, id, name, key]);
        if (!inserted.rowCount) throw new PageError(409, 'TAG_NAME_CONFLICT');
        return { statusCode: 201, body: { id, name, pageCount: 0 } satisfies WorkspaceTag };
      }, () => null);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.patch<{ Params: TagParams }>(`${tagsPath}/:tagId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const tagId = request.params.tagId.toLowerCase();
      if (!isUuid(tagId)) throw new PageError(404, 'NOT_FOUND');
      const body = mutationBody(request.body);
      const { name, key } = validateTagName(body.name);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'tag-rename', null, { tagId, name }, async client => {
        try {
          const updated = await client.query(`UPDATE workspace_tags SET name = $3, name_key = $4
            WHERE workspace_id = $1 AND id = $2`, [workspaceId, tagId, name, key]);
          if (!updated.rowCount) throw new PageError(404, 'NOT_FOUND');
        } catch (error) {
          if (error && typeof error === 'object' && 'constraint' in error && error.constraint === 'workspace_tags_name_key') {
            throw new PageError(409, 'TAG_NAME_CONFLICT');
          }
          throw error;
        }
        const current = await client.query<TagRow>(`SELECT ${tagColumns} FROM workspace_tags t WHERE t.workspace_id = $1 AND t.id = $2`,
          [workspaceId, tagId]);
        return { statusCode: 200, body: toTag(current.rows[0]!) };
      }, () => null);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.delete<{ Params: TagParams }>(`${tagsPath}/:tagId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const tagId = request.params.tagId.toLowerCase();
      if (!isUuid(tagId)) throw new PageError(404, 'NOT_FOUND');
      const body = mutationBody(request.body);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'tag-remove', null, { tagId }, async client => {
        const deleted = await client.query('DELETE FROM workspace_tags WHERE workspace_id = $1 AND id = $2', [workspaceId, tagId]);
        if (!deleted.rowCount) throw new PageError(404, 'NOT_FOUND');
        return { statusCode: 204, body: {} };
      }, () => null);
      return reply.code(result.statusCode).send();
    } catch (error) { return sendError(request, reply, error, secure); }
  });
}
