export interface SearchResult {
  pageId: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  revision: string;
  updatedAt: string;
  snippet: string;
  matchField: 'title' | 'content';
}

export interface SearchResponse {
  results: SearchResult[];
  truncated: boolean;
}
