/** API content is validated on the server before storage. The web editor owns Lexical's node types. */
export interface StoredDocumentContent {
  schemaVersion: number;
  editorState: { root: unknown };
}

export interface PageSummary {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
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
}

export interface UpdatePageRequest {
  clientMutationId: string;
  expectedRevision: string;
  title?: string;
  parentId?: string | null;
  content?: StoredDocumentContent;
}

export interface PageStateRequest {
  clientMutationId: string;
  expectedRevision: string;
}

export interface TrashPageRequest extends PageStateRequest {
  /** When supplied, the server rejects deletion if the current active subtree differs. */
  expectedSubtreeIds?: string[];
}
