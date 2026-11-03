/** A liveness response, not a database or production readiness check. */
export type {
  ApiErrorResponse,
  AuthErrorCode,
  AuthSessionResponse,
  AuthUser,
  AuthWorkspace,
  LoginRequest,
} from './auth.js';
export type {
  CreatePageRequest,
  PageDocument,
  PageListResponse,
  PageStateRequest,
  PageSummary,
  StoredDocumentContent,
  TrashPageRequest,
  UpdatePageRequest,
} from './pages.js';
export type { AttachmentMetadata } from './attachments.js';
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
