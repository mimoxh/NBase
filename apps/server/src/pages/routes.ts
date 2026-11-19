import { databasePropertyLimit, historySearchLimit, isPageProperties, pageTagLimit, pageVersionLabelLimit, pageVersionNoteLimit, type CreatePageRequest,
  type PageProperty, type PageStateRequest, type PageVersionLabelRequest, type PropertyValue, type RowProperties,
  type CollabWrite, type UpdatePageRequest } from '@nbase/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../auth/repository.js';
import {
  clearSessionCookie, publicOriginConfig,
} from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { ContentValidationError, PageFieldError, validateDocumentContent, validatePageCover, validatePageIcon } from './validate.js';
import { decodePageCursor, decodeSiblingCursor, isRevision, isUuid, PageError, PgPageRepository } from './repository.js';
import { parseCollabWrite } from '../live/rooms.js';

interface WorkspaceParams { workspaceId: string }
interface PageParams extends WorkspaceParams { pageId: string }
interface MutationParams extends WorkspaceParams { clientMutationId: string }
interface VersionParams extends PageParams { revision: string }

const RouteError = WorkspaceRouteError;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function title(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255;
}

function parentId(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function pageTagIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > pageTagLimit || !value.every(isUuid)) {
    throw new RouteError(400, 'INVALID_REQUEST');
  }
  const ids = value.map(id => id.toLowerCase()).sort();
  if (new Set(ids).size !== ids.length) throw new RouteError(400, 'INVALID_REQUEST');
  return ids;
}

/** Shape check only; values are checked against the database schema inside the write transaction. */
function rowProperties(value: unknown, allowNull: boolean): Record<string, PropertyValue | null> {
  if (!object(value) || Object.keys(value).length > databasePropertyLimit) throw new RouteError(400, 'INVALID_REQUEST');
  for (const [key, item] of Object.entries(value)) {
    const valid = isUuid(key) && key === key.toLowerCase() && (
      (item === null && allowNull) || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      || (Array.isArray(item) && item.every(entry => typeof entry === 'string')));
    if (!valid) throw new RouteError(400, 'INVALID_REQUEST');
  }
  return value as Record<string, PropertyValue | null>;
}

function pageProperties(value: unknown): PageProperty[] {
  if (!isPageProperties(value)) throw new RouteError(400, 'INVALID_REQUEST');
  return value;
}

function createBody(value: unknown): CreatePageRequest {
  if (!object(value) || !isUuid(value.clientMutationId) || !parentId(value.parentId) || !title(value.title)) {
    throw new RouteError(400, 'INVALID_REQUEST');
  }
  const body: CreatePageRequest = {
    clientMutationId: value.clientMutationId,
    parentId: value.parentId,
    title: value.title,
    content: validateDocumentContent(value.content),
  };
  if (Object.hasOwn(value, 'icon')) body.icon = validatePageIcon(value.icon);
  if (Object.hasOwn(value, 'cover')) body.cover = validatePageCover(value.cover);
  if (Object.hasOwn(value, 'tagIds')) body.tagIds = pageTagIds(value.tagIds);
  if (Object.hasOwn(value, 'properties')) body.properties = rowProperties(value.properties, false) as RowProperties;
  if (Object.hasOwn(value, 'pageProperties')) body.pageProperties = pageProperties(value.pageProperties);
  return body;
}

function updateBody(value: unknown): UpdatePageRequest {
  if (!object(value) || !isUuid(value.clientMutationId) || !isRevision(value.expectedRevision)
    || !(['title', 'parentId', 'content', 'icon', 'cover', 'tagIds', 'properties', 'pageProperties'].some((key) => Object.hasOwn(value, key)))) {
    throw new RouteError(400, 'INVALID_REQUEST');
  }
  if (Object.hasOwn(value, 'title') && !title(value.title)) throw new RouteError(400, 'INVALID_REQUEST');
  if (Object.hasOwn(value, 'parentId') && !parentId(value.parentId)) throw new RouteError(400, 'INVALID_REQUEST');
  const body: UpdatePageRequest = { clientMutationId: value.clientMutationId, expectedRevision: value.expectedRevision };
  if (Object.hasOwn(value, 'title')) body.title = value.title as string;
  if (Object.hasOwn(value, 'parentId')) body.parentId = value.parentId as string | null;
  if (Object.hasOwn(value, 'content')) body.content = validateDocumentContent(value.content);
  if (Object.hasOwn(value, 'icon')) body.icon = validatePageIcon(value.icon);
  if (Object.hasOwn(value, 'cover')) body.cover = validatePageCover(value.cover);
  if (Object.hasOwn(value, 'tagIds')) body.tagIds = pageTagIds(value.tagIds);
  if (Object.hasOwn(value, 'properties')) body.properties = rowProperties(value.properties, true);
  if (Object.hasOwn(value, 'pageProperties')) body.pageProperties = pageProperties(value.pageProperties);
  if (Object.hasOwn(value, 'collab')) {
    if (!parseCollabWrite(value.collab)) throw new RouteError(400, 'INVALID_REQUEST');
    body.collab = value.collab as CollabWrite;
  }
  return body;
}

function stateBody(value: unknown): PageStateRequest {
  if (!object(value) || !isUuid(value.clientMutationId) || !isRevision(value.expectedRevision)) {
    throw new RouteError(400, 'INVALID_REQUEST');
  }
  return { clientMutationId: value.clientMutationId, expectedRevision: value.expectedRevision };
}

function labelText(value: unknown, limit: number, controls: RegExp): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || /\p{Cs}/u.test(value)) throw new RouteError(400, 'INVALID_REQUEST');
  const text = value.trim();
  if (!text) return null;
  if ([...text].length > limit || controls.test(text)) throw new RouteError(400, 'INVALID_REQUEST');
  return text;
}

/** `q` (trimmed), optional comma-separated `tagIds` and `limit`; a search needs a phrase or, where allowed, tags. */
function searchQuery(query: unknown, allowTags: boolean, defaultLimit: number): { phrase: string; tagIds: string[]; limit: number } {
  if (!object(query) || (query.q !== undefined && typeof query.q !== 'string')
    || (query.tagIds !== undefined && (!allowTags || typeof query.tagIds !== 'string'))) throw new RouteError(400, 'INVALID_REQUEST');
  const tagIds = typeof query.tagIds === 'string' ? pageTagIds(query.tagIds.split(',')) : [];
  const phrase = typeof query.q === 'string' ? query.q.trim() : '';
  if ((!phrase && !tagIds.length) || phrase.length > 100 || Buffer.byteLength(phrase, 'utf8') > 256
    || /[\u0000-\u001f\u007f]/.test(phrase)) throw new RouteError(400, 'INVALID_REQUEST');
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RouteError(400, 'INVALID_REQUEST');
  return { phrase, tagIds, limit };
}

/** Blank strings mean "none"; a note needs a label so that every note belongs to a named version. */
function labelBody(value: unknown): PageVersionLabelRequest {
  if (!object(value) || !Object.hasOwn(value, 'label') || !Object.hasOwn(value, 'note')) throw new RouteError(400, 'INVALID_REQUEST');
  const label = labelText(value.label, pageVersionLabelLimit, /[\u0000-\u001f\u007f]/);
  const note = labelText(typeof value.note === 'string' ? value.note.replace(/\r\n?/g, '\n') : value.note, pageVersionNoteLimit, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  if (note !== null && label === null) throw new RouteError(400, 'INVALID_REQUEST');
  return { label, note };
}

export function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown, secure: boolean) {
  reply.header('Cache-Control', 'no-store');
  if (error instanceof PageError) return reply.code(error.statusCode).send(error.response());
  if (error instanceof ContentValidationError) return reply.code(422).send({ error: error.code });
  if (error instanceof PageFieldError) return reply.code(400).send({ error: 'INVALID_REQUEST' });
  if (error instanceof WorkspaceRouteError) {
    if (error.clearCookie) reply.header('Set-Cookie', clearSessionCookie(secure));
    return reply.code(error.statusCode).send({ error: error.code });
  }
  request.log.error({ err: error }, 'Page request unavailable');
  return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
}

export interface PageEvents { pageSaved(workspaceId: string, pageId: string, revision: string, actorId: string): void }

export function registerPageRoutes(app: FastifyInstance, pages: PgPageRepository,
  auth: AuthRepository, publicOrigin: string, events?: PageEvents): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const saved = (workspaceId: string, pageId: string, actorId: string, result: { statusCode: number; body: unknown }) => {
    const body = result.body as { revision?: unknown };
    if (result.statusCode < 300 && typeof body.revision === 'string') events?.pageSaved(workspaceId, pageId, body.revision, actorId);
  };

  const authorize = (request: FastifyRequest, workspaceId: string, write: boolean | 'post-read') =>
    authorizeWorkspace(request, auth, origin, secure, workspaceId, write, write ? 'application/json' : undefined);

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/pages', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      const query: unknown = request.query;
      if (!object(query)) throw new RouteError(400, 'INVALID_REQUEST');
      const rawParent = query.parentId;
      const parent = rawParent === undefined || rawParent === '' ? null : rawParent;
      if (!parentId(parent)) throw new RouteError(400, 'INVALID_REQUEST');
      const rawLimit = query.limit;
      const limit = rawLimit === undefined ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RouteError(400, 'INVALID_REQUEST');
      const rawCursor = query.cursor;
      const cursor = rawCursor === undefined ? null : typeof rawCursor === 'string' ? decodeSiblingCursor(rawCursor) : null;
      if (rawCursor !== undefined && !cursor) throw new RouteError(400, 'INVALID_REQUEST');
      return reply.send(await pages.list(request.params.workspaceId, actorId, parent, limit, cursor));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/page-tree', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      return reply.send(await pages.tree(request.params.workspaceId, actorId));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/search', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      const { phrase, tagIds, limit } = searchQuery(request.query, true, 20);
      return reply.send(await pages.search(request.params.workspaceId, actorId, phrase, limit, tagIds));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/history-search', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      const { phrase, tagIds, limit } = searchQuery(request.query, true, 20);
      if (!phrase) throw new RouteError(400, 'INVALID_REQUEST');
      return reply.send(await pages.searchHistory(request.params.workspaceId, actorId, phrase, limit, tagIds));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId/history-search', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const { phrase, limit } = searchQuery(request.query, false, historySearchLimit);
      return reply.send(await pages.searchPageHistory(request.params.workspaceId, actorId, request.params.pageId, phrase, limit));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const page = await pages.get(request.params.workspaceId, actorId, request.params.pageId);
      return page ? reply.send(page) : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId/history', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const query: unknown = request.query;
      if (!object(query)) throw new RouteError(400, 'INVALID_REQUEST');
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100
        || (query.beforeRevision !== undefined && !isRevision(query.beforeRevision))
        || (query.named !== undefined && query.named !== 'true')) throw new RouteError(400, 'INVALID_REQUEST');
      return reply.send(await pages.history(request.params.workspaceId, actorId, request.params.pageId,
        limit, query.beforeRevision as string | undefined ?? null, query.named === 'true'));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId/backlinks', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      const actorId = await authorize(request, workspaceId, false);
      if (!isUuid(pageId)) throw new RouteError(404, 'NOT_FOUND');
      const backlinks = await pages.backlinks(workspaceId, actorId, pageId);
      return backlinks ? reply.send(backlinks) : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: VersionParams }>('/api/workspaces/:workspaceId/pages/:pageId/history/:revision', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      if (!isUuid(request.params.pageId) || !isRevision(request.params.revision)) throw new RouteError(404, 'NOT_FOUND');
      const version = await pages.version(request.params.workspaceId, actorId, request.params.pageId, request.params.revision);
      return version ? reply.send(version) : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.put<{ Params: VersionParams }>('/api/workspaces/:workspaceId/pages/:pageId/history/:revision/label', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, true);
      if (!isUuid(request.params.pageId) || !isRevision(request.params.revision)) throw new RouteError(404, 'NOT_FOUND');
      const body = labelBody(request.body);
      const version = await pages.labelVersion(request.params.workspaceId, actorId, request.params.pageId,
        request.params.revision, body.label, body.note);
      return version ? reply.send(version) : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/trash', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      const query: unknown = request.query;
      if (!object(query)) throw new RouteError(400, 'INVALID_REQUEST');
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      const cursor = typeof query.cursor === 'string' ? decodePageCursor(query.cursor) : null;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.cursor !== undefined && !cursor)) {
        throw new RouteError(400, 'INVALID_REQUEST');
      }
      return reply.send(await pages.trashList(request.params.workspaceId, actorId, limit, cursor));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: PageParams }>('/api/workspaces/:workspaceId/trash/:pageId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const page = await pages.trashed(request.params.workspaceId, actorId, request.params.pageId);
      return page ? reply.send(page) : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/favorites', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      return reply.send(await pages.favorites(request.params.workspaceId, actorId));
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.put<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId/position', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const body: unknown = request.body;
      if (!object(body) || !parentId(body.afterPageId) || body.afterPageId === request.params.pageId) {
        throw new RouteError(400, 'INVALID_REQUEST');
      }
      await pages.setPosition(request.params.workspaceId, actorId, request.params.pageId, body.afterPageId);
      return reply.code(204).send();
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.put<{ Params: PageParams }>('/api/workspaces/:workspaceId/favorites/:pageId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      // Favorites are a personal preference, so viewers may keep them too.
      const actorId = await authorize(request, request.params.workspaceId, 'post-read');
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      await pages.favoriteAdd(request.params.workspaceId, actorId, request.params.pageId);
      return reply.code(204).send();
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.delete<{ Params: PageParams }>('/api/workspaces/:workspaceId/favorites/:pageId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, 'post-read');
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      await pages.favoriteRemove(request.params.workspaceId, actorId, request.params.pageId);
      return reply.code(204).send();
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.get<{ Params: MutationParams }>('/api/workspaces/:workspaceId/mutations/:clientMutationId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, false);
      if (!isUuid(request.params.clientMutationId)) throw new RouteError(404, 'NOT_FOUND');
      const receipt = await pages.receipt(request.params.workspaceId, actorId, request.params.clientMutationId);
      return receipt ? reply.send({ statusCode: receipt.statusCode, response: receipt.body })
        : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/pages', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, true);
      const result = await pages.create(request.params.workspaceId, actorId, createBody(request.body));
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.patch<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const result = await pages.update(request.params.workspaceId, actorId, request.params.pageId, updateBody(request.body));
      saved(request.params.workspaceId, request.params.pageId, actorId, result);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId/trash', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const body: unknown = request.body;
      const state = stateBody(body);
      const ids = object(body) ? body.expectedSubtreeIds : undefined;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 2000
        || ids.some(id => !isUuid(id)) || new Set(ids.map(id => String(id).toLowerCase())).size !== ids.length)) {
        throw new RouteError(400, 'INVALID_REQUEST');
      }
      const result = await pages.trash(request.params.workspaceId, actorId, request.params.pageId,
        { ...state, ...(ids ? { expectedSubtreeIds: ids as string[] } : {}) });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId/restore', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const result = await pages.restore(request.params.workspaceId, actorId, request.params.pageId, stateBody(request.body));
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: PageParams }>('/api/workspaces/:workspaceId/pages/:pageId/restore-version', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await authorize(request, request.params.workspaceId, true);
      if (!isUuid(request.params.pageId)) throw new RouteError(404, 'NOT_FOUND');
      const body: unknown = request.body;
      const state = stateBody(body);
      if (!object(body) || !isRevision(body.sourceRevision)) throw new RouteError(400, 'INVALID_REQUEST');
      const result = await pages.restoreVersion(request.params.workspaceId, actorId, request.params.pageId,
        { ...state, sourceRevision: body.sourceRevision });
      saved(request.params.workspaceId, request.params.pageId, actorId, result);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });
}
