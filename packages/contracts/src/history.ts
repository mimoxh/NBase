import type { RowProperties } from './databases.js';
import type { PageCoverId, PageDocument, PageStateRequest, PageSummary, StoredDocumentContent } from './pages.js';

export type PageVersionOperation = 'baseline' | 'create' | 'update' | 'trash' | 'restore' | 'restore-version';

export interface PageVersionSummary {
  revision: string;
  title: string;
  savedAt: string;
  operation: PageVersionOperation;
  deleted: boolean;
}

export interface PageVersion extends PageVersionSummary {
  pageId: string;
  parentId: string | null;
  icon: string | null;
  cover: PageCoverId | null;
  content: StoredDocumentContent;
  /** Row pages only. */
  properties?: RowProperties;
}

export interface PageHistoryResponse {
  versions: PageVersionSummary[];
  nextBeforeRevision: string | null;
}

export interface RestorePageVersionRequest extends PageStateRequest {
  sourceRevision: string;
}

export interface TrashedPageSummary extends PageSummary {
  deletedAt: string;
  deletionGroupId: string;
}

export interface TrashedPageDocument extends PageDocument {
  deletedAt: string;
  deletionGroupId: string;
}

export interface TrashListResponse {
  pages: TrashedPageSummary[];
  nextCursor: string | null;
}
