/** A liveness response, not a database or production readiness check. */
export type {
  ApiErrorResponse,
  AuthErrorCode,
  AuthSessionResponse,
  AuthUser,
  AuthWorkspace,
  LoginRequest,
} from './auth.js';
export { pageCoverIds } from './pages.js';
export { calloutKinds, calloutTitleMaxLength, isCalloutKind, isCalloutTitle } from './callouts.js';
export type { CalloutKind } from './callouts.js';
export { builtinTemplateIds, defaultNoteTimeZone, pageTagLimit, quickCaptureLimit, quickCaptureMarker, tagNameLimit } from './notes.js';
export type { CopyPageRequest, DailyNoteSettings, DailyNoteSettingsRequest, DailyNoteStatus, NoteTemplate,
  OpenDailyNoteRequest, QuickCaptureRequest, SaveNoteTemplateRequest, TagWriteRequest, TemplatePreview,
  TemplatePreviewRequest, WorkspaceTag } from './notes.js';
export type {
  CreatePageRequest,
  PageCoverId,
  PageDocument,
  PageListResponse,
  PageStateRequest,
  PageTreeResponse,
  PageSummary,
  StoredDocumentContent,
  TrashPageRequest,
  UpdatePageRequest,
} from './pages.js';
export type { FavoriteListResponse } from './favorites.js';
export { pageBacklinkLimit, pageIdFromReferenceUrl, pageReferenceLabelLimit, pageReferenceUrl } from './pageReferences.js';
export type { PageBacklink, PageBacklinksResponse, SerializedPageReference } from './pageReferences.js';
export type { AttachmentMetadata } from './attachments.js';
export { isStoredMermaidSource } from './mermaid.js';
export type { SerializedMermaidNode } from './mermaid.js';
export { isFootnoteId, isMarkdownDate, isMarkdownFrontMatter, isMarkdownMetadataKey, markdownFrontMatterKey,
  markdownFrontMatterMaxBytes, markdownFrontMatterMaxDepth, markdownFrontMatterMaxNodes } from './markdownMetadata.js';
export type { MarkdownFrontMatter, MarkdownMetadataValue } from './markdownMetadata.js';
export type { SearchResponse, SearchResult } from './search.js';
export type { PageHistoryResponse, PageVersion, PageVersionOperation, PageVersionSummary,
  RestorePageVersionRequest, TrashedPageDocument, TrashedPageSummary, TrashListResponse } from './history.js';

export interface HealthResponse {
  service: 'nbase';
  status: 'ok';
  stage: 'foundation';
  /** Describes which storage path is configured, not database readiness. */
  persistence: 'not-configured' | 'accounts-only' | 'page-api';
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return data.service === 'nbase'
    && data.status === 'ok'
    && data.stage === 'foundation'
    && (data.persistence === 'not-configured' || data.persistence === 'accounts-only' || data.persistence === 'page-api');
}
export { tagNameKey } from './tagNameKey.js';
