import type { RowProperties } from './databases.js';
import type { PageProperty } from './pageProperties.js';
import type { PageCoverId, PageDocument, PageStateRequest, PageSummary, StoredDocumentContent } from './pages.js';

export type PageVersionOperation = 'baseline' | 'create' | 'update' | 'trash' | 'restore' | 'restore-version';

/** Characters (code points) after trimming. */
export const pageVersionLabelLimit = 100;
export const pageVersionNoteLimit = 1000;

export interface PageVersionSummary {
  revision: string;
  title: string;
  savedAt: string;
  operation: PageVersionOperation;
  deleted: boolean;
  /** A version with a label is a named version. */
  label: string | null;
  /** Only a named version has a note. */
  note: string | null;
}

export interface PageVersion extends PageVersionSummary {
  pageId: string;
  parentId: string | null;
  icon: string | null;
  cover: PageCoverId | null;
  content: StoredDocumentContent;
  /** Row pages only. */
  properties?: RowProperties;
  /** Document pages with properties only. */
  pageProperties?: PageProperty[];
}

export interface PageHistoryResponse {
  versions: PageVersionSummary[];
  nextBeforeRevision: string | null;
}

/** Sets the absolute label state of one version; `label: null` clears the name and the note. */
export interface PageVersionLabelRequest {
  label: string | null;
  note: string | null;
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
