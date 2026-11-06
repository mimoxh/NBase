import type { CopyPageRequest, NoteTemplate, PageDocument, SaveNoteTemplateRequest, TemplatePreview, TemplatePreviewRequest } from '@nbase/contracts';
import { request, workspacePath } from './client';

const templatesPath = (workspaceId: string) => workspacePath(workspaceId) + '/templates';
const templatePath = (workspaceId: string, id: string) => templatesPath(workspaceId) + '/' + encodeURIComponent(id);

export const noteTemplateClient = {
  list: (workspaceId: string, signal?: AbortSignal) =>
    request<NoteTemplate[]>(templatesPath(workspaceId), 'GET', undefined, undefined, signal),
  preview: (workspaceId: string, body: TemplatePreviewRequest, csrfToken: string, signal?: AbortSignal) =>
    request<TemplatePreview>(templatesPath(workspaceId) + '/preview', 'POST', body, csrfToken, signal),
  create: (workspaceId: string, body: SaveNoteTemplateRequest, csrfToken: string) =>
    request<NoteTemplate>(templatesPath(workspaceId), 'POST', body, csrfToken),
  update: (workspaceId: string, id: string, body: SaveNoteTemplateRequest, csrfToken: string) =>
    request<NoteTemplate>(templatePath(workspaceId, id), 'PATCH', body, csrfToken),
  remove: (workspaceId: string, id: string, body: { clientMutationId: string; expectedRevision: string }, csrfToken: string) =>
    request<{ deleted: true }>(templatePath(workspaceId, id), 'DELETE', body, csrfToken),
};

export function copyPage(workspaceId: string, pageId: string, body: CopyPageRequest, csrfToken: string) {
  const path = workspacePath(workspaceId) + '/pages/' + encodeURIComponent(pageId) + '/copy';
  return request<PageDocument>(path, 'POST', body, csrfToken);
}
