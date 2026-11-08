import { randomUUID } from 'node:crypto';
import { builtinTemplateIds, defaultNoteTimeZone } from '@nbase/contracts';
import type { CopyPageRequest, NoteTemplate, SaveNoteTemplateRequest, StoredDocumentContent, TemplatePreview } from '@nbase/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { isRevision, isUuid, PageError, PgPageRepository } from '../pages/repository.js';
import { sendError } from '../pages/routes.js';
import { attachmentReferences, validateDocumentContent } from '../pages/validate.js';

const templateLimit = 30;
const nameLimit = 80;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const textNode = (text: string) => ({ type: 'text', version: 1, text, detail: 0, format: 0, mode: 'normal', style: '' });
const block = (type: string, children: JsonObject[]) => ({ type, version: 1, children, direction: null, format: '', indent: 0 });
const paragraph = (text = '') => block('paragraph', text ? [textNode(text)] : []);
const heading = (text: string) => ({ ...block('heading', [textNode(text)]), tag: 'h2' });

const builtinDefinitions = {
  reading: { name: '读书笔记', sections: ['阅读来源', '关键观点', '摘录', '我的思考'] },
  meeting: { name: '会议记录', sections: ['参与人', '议程', '讨论与结论', '后续行动'] },
  troubleshooting: { name: '排障记录', sections: ['故障现象', '环境与复现', '排查过程', '原因与修复'] },
};
const builtins: NoteTemplate[] = builtinTemplateIds.map(id => {
  const { name, sections } = builtinDefinitions[id];
  return {
    id, name, builtin: true, revision: null,
    content: {
      schemaVersion: 1,
      editorState: { root: block('root', [
        paragraph('主题：{{title}}'), paragraph('日期：{{date}}'),
        ...sections.flatMap(section => [heading(section), paragraph()]),
      ]) },
    },
  };
});

interface TemplateRow {
  id: string;
  name: string;
  content_json: StoredDocumentContent;
  revision: string;
}
interface WorkspaceParams { workspaceId: string }
interface TemplateParams extends WorkspaceParams { templateId: string }
interface CopyParams extends WorkspaceParams { pageId: string }

function templateFromRow(row: TemplateRow): NoteTemplate {
  return { id: row.id, name: row.name, builtin: false, revision: row.revision, content: row.content_json };
}

function requestError(): never { throw new WorkspaceRouteError(400, 'INVALID_REQUEST'); }

export function isNoteTemplateId(value: unknown): value is string {
  return isUuid(value) || (typeof value === 'string' && (builtinTemplateIds as readonly string[]).includes(value));
}

function isPageTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isTemplateDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function saveRequest(value: unknown, update: boolean): SaveNoteTemplateRequest {
  if (!object(value) || !isUuid(value.clientMutationId) || typeof value.name !== 'string'
    || (update ? !isRevision(value.expectedRevision) : value.expectedRevision !== undefined)) requestError();
  const name = value.name.trim();
  if (!name || name.length > nameLimit || /[\u0000-\u001f\u007f]/u.test(name)) requestError();
  return {
    name, clientMutationId: value.clientMutationId, content: validateDocumentContent(value.content),
    ...(update ? { expectedRevision: value.expectedRevision as string } : {}),
  };
}

async function findTemplate(client: PoolClient, workspaceId: string, actorId: string, templateId: string): Promise<NoteTemplate> {
  const builtin = builtins.find(template => template.id === templateId);
  if (builtin) return builtin;
  if (!isUuid(templateId)) throw new PageError(404, 'NOT_FOUND');
  const result = await client.query<TemplateRow>(`
    SELECT id, name, revision::text, content_json FROM note_templates
    WHERE workspace_id = $1 AND owner_user_id = $2 AND id = $3
  `, [workspaceId, actorId, templateId]);
  if (!result.rows[0]) throw new PageError(404, 'NOT_FOUND');
  return templateFromRow(result.rows[0]);
}

async function missingReferences(client: PoolClient, workspaceId: string, content: StoredDocumentContent) {
  const references = attachmentReferences(content);
  if (!references.length) return [];
  const ids = [...new Set(references.map(item => item.id.toLowerCase()))];
  const result = await client.query<{ id: string; file_name: string; media_type: string }>(`
    SELECT id, file_name, media_type FROM attachments
    WHERE workspace_id = $1 AND id = ANY($2::uuid[])
  `, [workspaceId, ids]);
  const known = new Map(result.rows.map(row => [row.id, row]));
  return references.filter(reference => {
    const row = known.get(reference.id.toLowerCase());
    return !row || row.file_name !== reference.fileName || row.media_type !== reference.mediaType;
  });
}

function attachmentKey(id: string, fileName: string, mediaType: string): string {
  return JSON.stringify([id.toLowerCase(), fileName, mediaType]);
}

/** The caller authorizes the workspace; personal templates additionally require their owner. */
export async function renderNoteTemplate(client: PoolClient, workspaceId: string, actorId: string,
  templateId: string, title: string, date: string): Promise<TemplatePreview> {
  const template = await findTemplate(client, workspaceId, actorId, templateId);
  const original = validateDocumentContent(template.content);
  const missing = await missingReferences(client, workspaceId, original);
  const missingKeys = new Set(missing.map(item => attachmentKey(item.id, item.fileName, item.mediaType)));
  function expand(node: unknown, isRootChild = false): unknown {
    if (!object(node)) return node;
    if (node.type === 'attachment' && missingKeys.has(attachmentKey(
      String(node.attachmentId), String(node.fileName), String(node.mediaType),
    ))) {
      const label = '附件不可用：' + String(node.fileName);
      return isRootChild ? paragraph(label) : textNode(label);
    }
    if (node.type === 'text' && typeof node.text === 'string') {
      const text = node.text.replace(/\{\{(title|date)\}\}/g, (_, name: string) => name === 'title' ? title : date);
      return text === node.text ? node : { ...node, text };
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: node.children.map(child => expand(child, node.type === 'root')) };
    }
    return node;
  }
  const content = validateDocumentContent({
    ...original, editorState: { ...original.editorState, root: expand(original.editorState.root) },
  });
  return { content, missingAttachments: [...new Set(missing.map(item => item.fileName))] };
}

async function workspaceDate(client: PoolClient, workspaceId: string): Promise<string> {
  const result = await client.query<{ date: string }>(`
    SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE
      COALESCE(to_jsonb(w)->>'note_time_zone', $2), 'YYYY-MM-DD') AS date
    FROM workspaces w WHERE id = $1
  `, [workspaceId, defaultNoteTimeZone]);
  if (!result.rows[0]) throw new PageError(404, 'NOT_FOUND');
  return result.rows[0].date;
}

async function assertTemplateAttachments(client: PoolClient, workspaceId: string, content: StoredDocumentContent): Promise<void> {
  if ((await missingReferences(client, workspaceId, content)).length) throw new PageError(422, 'ATTACHMENT_INVALID');
}

async function staleOrMissingTemplate(client: PoolClient, workspaceId: string, actorId: string, templateId: string): Promise<never> {
  const template = await findTemplate(client, workspaceId, actorId, templateId);
  throw new PageError(409, 'REVISION_CONFLICT', template.revision ?? undefined);
}

export function registerTemplateRoutes(app: FastifyInstance, pool: Pool, pages: PgPageRepository,
  auth: AuthRepository, publicOrigin: string): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const authorize = (request: FastifyRequest, workspaceId: string, write: boolean) =>
    authorizeWorkspace(request, auth, origin, secure, workspaceId, write, write ? 'application/json' : undefined);
  const base = '/api/workspaces/:workspaceId/templates';

  app.get<{ Params: WorkspaceParams }>(base, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, false);
      const result = await pool.query<TemplateRow>(`
        SELECT id, name, revision::text, content_json FROM note_templates
        WHERE workspace_id = $1 AND owner_user_id = $2 ORDER BY created_at, id
      `, [workspaceId, actorId]);
      return reply.send([...builtins, ...result.rows.map(templateFromRow)]);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: WorkspaceParams }>(base, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const body = saveRequest(request.body, false);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'template-create', null, body, async client => {
        await assertTemplateAttachments(client, workspaceId, body.content);
        const count = await client.query<{ count: number }>(`
          SELECT count(*)::integer AS count FROM note_templates WHERE workspace_id = $1 AND owner_user_id = $2
        `, [workspaceId, actorId]);
        if (count.rows[0]!.count >= templateLimit) throw new WorkspaceRouteError(422, 'TEMPLATE_LIMIT');
        const inserted = await client.query<TemplateRow>(`
          INSERT INTO note_templates (id, workspace_id, owner_user_id, name, content_json)
          VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, name, revision::text, content_json
        `, [randomUUID(), workspaceId, actorId, body.name, JSON.stringify(body.content)]);
        return { statusCode: 201, body: templateFromRow(inserted.rows[0]!) };
      }, () => null);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.patch<{ Params: TemplateParams }>(base + '/:templateId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, templateId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (!isUuid(templateId)) throw new PageError(404, 'NOT_FOUND');
      const body = saveRequest(request.body, true);
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'template-update', null,
        { templateId, ...body }, async client => {
          await assertTemplateAttachments(client, workspaceId, body.content);
          const updated = await client.query<TemplateRow>(`
            UPDATE note_templates SET name = $4, content_json = $5::jsonb, updated_at = now(), revision = revision + 1
            WHERE workspace_id = $1 AND owner_user_id = $2 AND id = $3 AND revision = $6
            RETURNING id, name, revision::text, content_json
          `, [workspaceId, actorId, templateId, body.name, JSON.stringify(body.content), body.expectedRevision]);
          if (!updated.rows[0]) return staleOrMissingTemplate(client, workspaceId, actorId, templateId);
          return { statusCode: 200, body: templateFromRow(updated.rows[0]) };
        }, () => null);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.delete<{ Params: TemplateParams }>(base + '/:templateId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, templateId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (!isUuid(templateId)) throw new PageError(404, 'NOT_FOUND');
      const value = request.body;
      if (!object(value) || !isUuid(value.clientMutationId) || !isRevision(value.expectedRevision)) requestError();
      const body = { templateId, expectedRevision: value.expectedRevision };
      const result = await pages.mutate(workspaceId, actorId, value.clientMutationId, 'template-delete', null, body, async client => {
        const deleted = await client.query(`
          DELETE FROM note_templates WHERE workspace_id = $1 AND owner_user_id = $2 AND id = $3 AND revision = $4
        `, [workspaceId, actorId, templateId, body.expectedRevision]);
        if (!deleted.rowCount) return staleOrMissingTemplate(client, workspaceId, actorId, templateId);
        return { statusCode: 200, body: { deleted: true } };
      }, () => null);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: WorkspaceParams }>(base + '/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const value = request.body;
      if (!object(value) || !isNoteTemplateId(value.templateId) || !isPageTitle(value.title)
        || (value.date !== undefined && !isTemplateDate(value.date))) requestError();
      const client = await pool.connect();
      try {
        return reply.send(await renderNoteTemplate(client, workspaceId, actorId, value.templateId, value.title,
          value.date ?? await workspaceDate(client, workspaceId)));
      } finally { client.release(); }
    } catch (error) { return sendError(request, reply, error, secure); }
  });

  app.post<{ Params: CopyParams }>('/api/workspaces/:workspaceId/pages/:pageId/copy', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, pageId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      if (!isUuid(pageId)) throw new PageError(404, 'NOT_FOUND');
      const value = request.body;
      if (!object(value) || !isUuid(value.clientMutationId) || !isRevision(value.sourceRevision) || !isPageTitle(value.title)
        || !(value.parentId === null || isUuid(value.parentId))) requestError();
      const body: CopyPageRequest = {
        clientMutationId: value.clientMutationId, sourceRevision: value.sourceRevision,
        title: value.title.trim(), parentId: value.parentId,
      };
      const result = await pages.mutate(workspaceId, actorId, body.clientMutationId, 'copy', pageId, body, async client => {
        const source = await pages.getInTransaction(client, workspaceId, pageId);
        if (body.sourceRevision !== source.revision) throw new PageError(409, 'REVISION_CONFLICT', source.revision);
        // Copying a database or a row would need its schema and values; not supported yet.
        if (source.kind !== 'document') throw new PageError(422, 'PAGE_KIND_INVALID');
        const defaultTitle = (source.title.trim() || '未命名页面').slice(0, 251).replace(/[\ud800-\udbff]$/u, '') + '（副本）';
        return pages.createInTransaction(client, workspaceId, actorId, {
          clientMutationId: body.clientMutationId, parentId: body.parentId, title: body.title || defaultTitle,
          content: validateDocumentContent(source.content), icon: source.icon, cover: source.cover,
          ...(source.tagIds ? { tagIds: source.tagIds } : {}),
        });
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return sendError(request, reply, error, secure); }
  });
}
