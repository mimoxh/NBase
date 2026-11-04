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
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface PageDocument extends PageSummary {
  content: StoredDocumentContent;
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
}

export interface PageStateRequest {
  clientMutationId: string;
  expectedRevision: string;
}

export interface TrashPageRequest extends PageStateRequest {
  /** When supplied, the server rejects deletion if the current active subtree differs. */
  expectedSubtreeIds?: string[];
}
