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
