import type { PageKind, PropertyValue, RowProperties } from './databases.js';
import type { CollabWrite } from './realtime.js';
import type { PageProperty } from './pageProperties.js';

/** API content is validated on the server before storage. The web editor owns Lexical's node types. */
export interface StoredDocumentContent {
  schemaVersion: number;
  editorState: { root: unknown };
}

export const pageCoverIds = ['sage', 'ochre', 'slate', 'rose', 'sand', 'sky'] as const;
export type PageCoverId = typeof pageCoverIds[number];

export interface PageSummary {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  /** One grapheme emoji, or null when the page has no icon. */
  icon: string | null;
  /** CSS preset identifier rendered by the client, or null for no cover. */
  cover: PageCoverId | null;
  /** Omitted by older servers and stored receipts. */
  tagIds?: string[];
  /** Omitted by older servers and stored receipts; treat as 'document'. */
  kind?: PageKind;
  /**
   * Database pages made by a calendar import or sync source, also after syncing stopped, until they are
   * revealed (POST /calendar/databases/:id/reveal). Clients keep them and their rows out of navigation and
   * pickers; the calendar opens them. Omitted when false.
   */
  calendarSync?: true;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface PageDocument extends PageSummary {
  content: StoredDocumentContent;
  /**
   * Who saved the current revision. Null for revisions without a recorded actor; omitted by older servers and
   * stored receipts.
   */
  lastEditor?: { userId: string; loginName: string } | null;
  /** Row pages only: property values keyed by property id. */
  properties?: RowProperties;
  /** Document pages only: the page's own properties, in display order. Omitted by older servers. */
  pageProperties?: PageProperty[];
}

export interface PageListResponse {
  pages: PageSummary[];
  nextCursor: string | null;
}

export interface PageTreeResponse {
  pages: PageSummary[];
  truncated: boolean;
}

export interface CreatePageRequest {
  clientMutationId: string;
  parentId: string | null;
  title: string;
  content: StoredDocumentContent;
  icon?: string | null;
  cover?: PageCoverId | null;
  tagIds?: string[];
  /** Only when the parent is a database; the page becomes a row. */
  properties?: RowProperties;
  /** Document pages only. */
  pageProperties?: PageProperty[];
}

export interface UpdatePageRequest {
  clientMutationId: string;
  expectedRevision: string;
  title?: string;
  parentId?: string | null;
  content?: StoredDocumentContent;
  /** null removes the icon; omitted leaves it unchanged. */
  icon?: string | null;
  cover?: PageCoverId | null;
  tagIds?: string[];
  /** Row pages only: partial patch, null removes a value. */
  properties?: Record<string, PropertyValue | null>;
  /** Document pages only: replaces all of the page's properties. */
  pageProperties?: PageProperty[];
  /** Set by a real-time room's saver (docs/architecture/realtime.md); the room's epoch replaces the revision check. */
  collab?: CollabWrite;
}

export interface PageStateRequest {
  clientMutationId: string;
  expectedRevision: string;
}

export interface TrashPageRequest extends PageStateRequest {
  /** When supplied, the server rejects deletion if the current active subtree differs. */
  expectedSubtreeIds?: string[];
}
