import type { PageVersionSummary } from './history.js';

export interface SearchResult {
  pageId: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  revision: string;
  updatedAt: string;
  snippet: string;
  matchField: 'title' | 'content';
  /**
   * The literal text to mark and select in `matchField` when it is not the query itself:
   * the Chinese a pinyin query matched, or one term of a query matched as separate words.
   */
  highlight?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  truncated: boolean;
}

/** Most versions or pages one history search returns. */
export const historySearchLimit = 50;

/** One saved version that matches a history search. */
export interface HistorySearchMatch extends PageVersionSummary {
  /** The account that saved the version; baseline versions from before v4 have none. */
  actor: { userId: string; loginName: string } | null;
  snippet: string;
  matchField: 'title' | 'content';
  /** As in `SearchResult`: the literal text to mark when it is not the query itself. */
  highlight?: string;
}

export interface PageHistorySearchResponse {
  /** Newest first. */
  versions: HistorySearchMatch[];
  truncated: boolean;
  /**
   * Versions in scope whose body text is not indexed yet (capped at `historySearchPendingCap`); until the
   * background indexer reaches them they match by title only.
   */
  pendingVersions: number;
}

export const historySearchPendingCap = 10000;

/** A page with at least one matching version; `version` is the best-ranked, newest matching one. */
export interface WorkspaceHistorySearchResult {
  pageId: string;
  /** The page's current title and icon, not the version's. */
  title: string;
  icon: string | null;
  parentId: string | null;
  version: HistorySearchMatch;
  matchingVersions: number;
  /** Whether the current page still matches the query, so the hit is not only in its history. */
  currentMatches: boolean;
}

export interface WorkspaceHistorySearchResponse {
  results: WorkspaceHistorySearchResult[];
  truncated: boolean;
  pendingVersions: number;
}
