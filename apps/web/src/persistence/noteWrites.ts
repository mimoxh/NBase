import type { CopyPageRequest, OpenDailyNoteRequest, PageDocument, QuickCaptureRequest } from '@nbase/contracts';
import { request, workspacePath } from './client';
import { copyPage } from './noteTemplateClient';

export type NoteWrite =
  | { kind: 'copy'; sourceId: string; body: CopyPageRequest }
  | { kind: 'daily'; body: OpenDailyNoteRequest }
  | { kind: 'quick'; targetPageId?: string; body: QuickCaptureRequest };

export function writeNote(workspaceId: string, csrfToken: string, write: NoteWrite): Promise<PageDocument> {
  if (write.kind === 'copy') return copyPage(workspaceId, write.sourceId, write.body, csrfToken);
  const path = write.kind === 'daily' ? '/daily-note' : '/quick-capture';
  return request<PageDocument>(workspacePath(workspaceId) + path, 'POST', write.body, csrfToken);
}
