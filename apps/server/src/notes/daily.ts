import {
  builtinTemplateIds, type DailyNoteSettings, type DailyNoteSettingsRequest, type DailyNoteStatus,
  type OpenDailyNoteRequest, type PageDocument, type QuickCaptureRequest, type TemplatePreview,
} from '@nbase/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { isRevision, isUuid, PageError, type PgPageRepository } from '../pages/repository.js';
import { sendError } from '../pages/routes.js';
import { validateDocumentContent } from '../pages/validate.js';
import {
  appendQuickCapture, blankDailyContent, normalizeNoteTimeZone, normalizeQuickCapture, noteDateAt, validNoteDate,
} from './dailyContent.js';

type WorkspaceParams = { workspaceId: string };
type Db = Pick<Pool, 'query'>;
type DailyPage = NonNullable<DailyNoteStatus['page']>;
type TemplateRenderer = (client: PoolClient, workspaceId: string, actorId: string, templateId: string,
  title: string, date: string) => Promise<TemplatePreview>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function invalid(): never { throw new WorkspaceRouteError(400, 'INVALID_REQUEST'); }

function templateId(value: unknown): value is string | null {
  return value === null || isUuid(value) || (builtinTemplateIds as readonly unknown[]).includes(value);
}

function openBody(value: unknown): OpenDailyNoteRequest {
  const body = record(value);
  if (!isUuid(body.clientMutationId) || !validNoteDate(body.date)
    || (body.templateId !== undefined && !templateId(body.templateId))) invalid();
  return { clientMutationId: body.clientMutationId, date: body.date,
    ...(body.templateId === undefined ? {} : { templateId: body.templateId }) };
}

function captureBody(value: unknown): QuickCaptureRequest {
  const body = record(value);
  const text = normalizeQuickCapture(body.text);
  if (!isUuid(body.clientMutationId) || !validNoteDate(body.date) || text === null
    || (body.expectedRevision !== undefined && !isRevision(body.expectedRevision))) invalid();
  return { clientMutationId: body.clientMutationId, date: body.date, text,
    ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }) };
}

function settingsBody(value: unknown): DailyNoteSettingsRequest {
  const body = record(value);
  const timeZone = normalizeNoteTimeZone(body.timeZone);
  if (!isUuid(body.clientMutationId) || timeZone === null
    || (body.parentId !== null && !isUuid(body.parentId)) || !templateId(body.templateId)) invalid();
  return { clientMutationId: body.clientMutationId, timeZone, parentId: body.parentId, templateId: body.templateId };
}

async function settings(db: Db, workspaceId: string, actorId: string): Promise<DailyNoteSettings> {
  const result = await db.query<DailyNoteSettings>(`
    SELECT w.note_time_zone AS "timeZone", w.daily_parent_id AS "parentId",
      CASE WHEN m.role = 'owner' OR w.daily_template_id = ANY($3::text[])
        THEN w.daily_template_id ELSE NULL END AS "templateId"
    FROM workspaces w
    JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2
    WHERE w.id = $1
  `, [workspaceId, actorId, builtinTemplateIds]);
  const row = result.rows[0];
  if (!row) throw new PageError(404, 'NOT_FOUND');
  return row;
}

async function findDaily(db: Db, workspaceId: string, actorId: string, date: string): Promise<DailyPage | null> {
  const result = await db.query<DailyPage>(`
    SELECT p.id, p.revision::text AS revision, p.deleted_at IS NOT NULL AS deleted
    FROM pages p
    JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
    WHERE p.workspace_id = $1 AND p.daily_note_date = $3::date
  `, [workspaceId, actorId, date]);
  return result.rows[0] ?? null;
}

async function requireActiveParent(client: PoolClient, workspaceId: string, parentId: string | null): Promise<void> {
  if (parentId === null) return;
  const result = await client.query('SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
    [workspaceId, parentId]);
  if (!result.rows[0]) throw new WorkspaceRouteError(409, 'DAILY_PARENT_UNAVAILABLE');
}

export function registerDailyRoutes(app: FastifyInstance, pool: Pool, pages: PgPageRepository, auth: AuthRepository,
  publicOrigin: string, renderTemplate: TemplateRenderer): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const base = '/api/workspaces/:workspaceId';
  const authorize = (request: FastifyRequest, workspaceId: string, write: boolean) =>
    authorizeWorkspace(request, auth, origin, secure, workspaceId, write, write ? 'application/json' : undefined);

  const dailyContent = async (client: PoolClient, workspaceId: string, actorId: string, id: string | null,
    date: string, implicit: boolean): Promise<PageDocument['content']> => {
    if (id === null) return blankDailyContent();
    try {
      const preview = await renderTemplate(client, workspaceId, actorId, id, date, date);
      if (preview.missingAttachments.length > 0) throw new WorkspaceRouteError(409, 'DAILY_TEMPLATE_ATTACHMENTS_MISSING');
      return preview.content;
    } catch (error) {
      if (implicit && error instanceof PageError && error.code === 'NOT_FOUND') return blankDailyContent();
      throw error;
    }
  };

  const createDaily = async (client: PoolClient, workspaceId: string, actorId: string,
    body: OpenDailyNoteRequest, captureText?: string) => {
    const defaults = await settings(client, workspaceId, actorId);
    await requireActiveParent(client, workspaceId, defaults.parentId);
    const content = await dailyContent(client, workspaceId, actorId,
      body.templateId === undefined ? defaults.templateId : body.templateId, body.date, body.templateId === undefined);
    const result = await pages.createInTransaction(client, workspaceId, actorId, {
      clientMutationId: body.clientMutationId, title: body.date, parentId: defaults.parentId,
      content: captureText === undefined ? validateDocumentContent(content) : appendQuickCapture(content, captureText),
    });
    await client.query('UPDATE pages SET daily_note_date = $3::date WHERE workspace_id = $1 AND id = $2',
      [workspaceId, result.body.id, body.date]);
    return result;
  };

  app.get<{ Params: WorkspaceParams }>(base + '/daily-note', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { workspaceId } = request.params;
    try {
      const actorId = await authorize(request, workspaceId, false);
      const query = record(request.query);
      if (query.date !== undefined && !validNoteDate(query.date)) invalid();
      const configured = await settings(pool, workspaceId, actorId);
      const today = noteDateAt(configured.timeZone, new Date());
      const date = query.date ?? today;
      return reply.send({ settings: configured, today, date, page: await findDaily(pool, workspaceId, actorId, date) } satisfies DailyNoteStatus);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: WorkspaceParams }>(base + '/daily-note', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { workspaceId } = request.params;
    try {
      const actorId = await authorize(request, workspaceId, true);
      const body = openBody(request.body);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'open-daily-note', null, body, async client => {
        const found = await findDaily(client, workspaceId, actorId, body.date);
        if (found?.deleted) throw new WorkspaceRouteError(409, 'DAILY_NOTE_TRASHED');
        if (found) return { statusCode: 200, body: await pages.getInTransaction(client, workspaceId, found.id) };
        return createDaily(client, workspaceId, actorId, body);
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: WorkspaceParams }>(base + '/quick-capture', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { workspaceId } = request.params;
    try {
      const actorId = await authorize(request, workspaceId, true);
      const body = captureBody(request.body);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'quick-capture', null, body, async client => {
        const found = await findDaily(client, workspaceId, actorId, body.date);
        if (found?.deleted) throw new WorkspaceRouteError(409, 'DAILY_NOTE_TRASHED');
        if (!found) {
          if (body.expectedRevision !== undefined) throw new PageError(409, 'REVISION_CONFLICT');
          return createDaily(client, workspaceId, actorId, body, body.text);
        }
        if (found.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', found.revision);
        const current = await pages.getInTransaction(client, workspaceId, found.id);
        return pages.updateInTransaction(client, workspaceId, actorId, current.id, {
          clientMutationId: body.clientMutationId, expectedRevision: body.expectedRevision,
          content: appendQuickCapture(current.content, body.text),
        });
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.put<{ Params: WorkspaceParams }>(base + '/daily-note/settings', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { workspaceId } = request.params;
    try {
      const actorId = await authorize(request, workspaceId, true);
      const body = settingsBody(request.body);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'daily-note-settings', null, body, async (client, role) => {
        if (role !== 'owner') throw new PageError(403, 'FORBIDDEN');
        await requireActiveParent(client, workspaceId, body.parentId);
        const today = noteDateAt(body.timeZone, new Date());
        await dailyContent(client, workspaceId, actorId, body.templateId, today, false);
        await client.query(`
          UPDATE workspaces SET note_time_zone = $2, daily_parent_id = $3, daily_template_id = $4
          WHERE id = $1
        `, [workspaceId, body.timeZone, body.parentId, body.templateId]);
        const { timeZone, parentId, templateId } = body;
        return { statusCode: 200, body: { timeZone, parentId, templateId } };
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });
}
