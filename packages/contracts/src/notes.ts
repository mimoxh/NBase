import type { StoredDocumentContent } from './pages.js';

export const pageTagLimit = 20;
export const tagNameLimit = 32;
export const builtinTemplateIds = ['reading', 'meeting', 'troubleshooting'] as const;
export const defaultNoteTimeZone = 'Asia/Shanghai';
export const quickCaptureLimit = 2000;
export const quickCaptureMarker = 'nbaseQuickCapture';

export interface WorkspaceTag {
  id: string;
  name: string;
  pageCount: number;
}

export interface TagWriteRequest {
  clientMutationId: string;
  name: string;
}

export interface NoteTemplate {
  id: string;
  name: string;
  builtin: boolean;
  revision: string | null;
  content: StoredDocumentContent;
}

export interface SaveNoteTemplateRequest {
  clientMutationId: string;
  name: string;
  content: StoredDocumentContent;
  expectedRevision?: string;
}

export interface TemplatePreviewRequest {
  templateId: string;
  title: string;
  date?: string;
}

export interface TemplatePreview {
  content: StoredDocumentContent;
  missingAttachments: string[];
}

export interface CopyPageRequest {
  clientMutationId: string;
  sourceRevision: string;
  title: string;
  parentId: string | null;
}

export interface DailyNoteSettings {
  timeZone: string;
  parentId: string | null;
  templateId: string | null;
}

export interface DailyNoteStatus {
  settings: DailyNoteSettings;
  today: string;
  date: string;
  page: { id: string; revision: string; deleted: boolean } | null;
}

export interface OpenDailyNoteRequest {
  clientMutationId: string;
  date: string;
  /** undefined uses the workspace default, null selects a blank page. */
  templateId?: string | null;
}

export interface QuickCaptureRequest {
  clientMutationId: string;
  date: string;
  text: string;
  expectedRevision?: string;
}

export interface DailyNoteSettingsRequest extends DailyNoteSettings {
  clientMutationId: string;
}
