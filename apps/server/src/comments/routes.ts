import type { CommentThreadListResponse } from '@nbase/contracts';
import { isCommentAnchor, normalizeCommentBody } from '@nbase/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspaceMember, WorkspaceRouteError } from '../auth/workspace.js';
import { sendError } from '../pages/routes.js';
import { PgCommentRepository } from './repository.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WorkspaceParams = { workspaceId: string };
type PageParams = WorkspaceParams & { pageId: string };
type ThreadParams = WorkspaceParams & { threadId: string };
type CommentParams = WorkspaceParams & { commentId: string };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

function pathId(value: string): string {
  if (!uuidPattern.test(value)) throw new WorkspaceRouteError(404, 'NOT_FOUND');
  return value.toLowerCase();
}

function bodyId(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
  return value.toLowerCase();
}

function commentBody(value: unknown): string {
  const body = normalizeCommentBody(value);
  if (body === null) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
  return body;
}

export interface CommentEvents { commentsChanged(workspaceId: string, pageId: string): void }

/**
 * Every member, viewers included, may start, answer, edit and delete their own comments (`post-read`); resolving
 * and reopening need edit rights; the owner may delete anyone's comment.
 */
export function registerCommentRoutes(app: FastifyInstance, pool: Pool, auth: AuthRepository, publicOrigin: string,
  events?: CommentEvents): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const comments = new PgCommentRepository(pool);
  const member = (request: FastifyRequest<{ Params: WorkspaceParams }>, write: boolean | 'post-read') =>
    authorizeWorkspaceMember(request, auth, origin, secure, request.params.workspaceId, write, write ? 'application/json' : undefined);
  const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown) => sendError(request, reply, error, secure);
  const changed = (workspaceId: string, pageId: string) => events?.commentsChanged(workspaceId, pageId);
  const base = '/api/workspaces/:workspaceId';

  app.get<{ Params: PageParams }>(`${base}/pages/:pageId/comments`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await member(request, false);
      return reply.send({ threads: await comments.list(request.params.workspaceId, pathId(request.params.pageId)) } satisfies CommentThreadListResponse);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: PageParams }>(`${base}/pages/:pageId/comments`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { userId } = await member(request, 'post-read');
      const pageId = pathId(request.params.pageId);
      const body = record(request.body);
      if (!isCommentAnchor(body.anchor)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
      const result = await comments.create(request.params.workspaceId, userId, pageId, bodyId(body.id), bodyId(body.commentId),
        body.anchor, commentBody(body.body));
      if (result.created) changed(request.params.workspaceId, pageId);
      return reply.code(result.created ? 201 : 200).send(result.thread);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: ThreadParams }>(`${base}/comment-threads/:threadId/replies`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { userId } = await member(request, 'post-read');
      const body = record(request.body);
      const result = await comments.reply(request.params.workspaceId, userId, pathId(request.params.threadId),
        bodyId(body.id), commentBody(body.body));
      if (result.created) changed(request.params.workspaceId, result.thread.pageId);
      return reply.code(result.created ? 201 : 200).send(result.thread);
    } catch (error) { return fail(request, reply, error); }
  });

  app.patch<{ Params: CommentParams }>(`${base}/comments/:commentId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { userId } = await member(request, 'post-read');
      const body = record(request.body);
      const thread = await comments.edit(request.params.workspaceId, userId, pathId(request.params.commentId), commentBody(body.body));
      changed(request.params.workspaceId, thread.pageId);
      return reply.send(thread);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: CommentParams }>(`${base}/comments/:commentId/delete`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { userId, role } = await member(request, 'post-read');
      record(request.body);
      const thread = await comments.remove(request.params.workspaceId, userId, role === 'owner', pathId(request.params.commentId));
      changed(request.params.workspaceId, thread.pageId);
      return reply.send(thread);
    } catch (error) { return fail(request, reply, error); }
  });

  for (const [action, resolved] of [['resolve', true], ['reopen', false]] as const) {
    app.post<{ Params: ThreadParams }>(`${base}/comment-threads/:threadId/${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const { userId } = await member(request, true);
        record(request.body);
        const thread = await comments.resolve(request.params.workspaceId, userId, pathId(request.params.threadId), resolved);
        changed(request.params.workspaceId, thread.pageId);
        return reply.send(thread);
      } catch (error) { return fail(request, reply, error); }
    });
  }
}
