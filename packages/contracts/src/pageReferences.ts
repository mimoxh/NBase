export const pageReferenceLabelLimit = 255;
export const pageBacklinkLimit = 100;

export interface SerializedPageReference {
  type: 'page-reference';
  version: 1;
  targetPageId: string;
  label: string;
}

export interface PageBacklink {
  sourcePageId: string;
  sourceTitle: string;
  sourceRevision: string;
  /** Zero-based index among page references in the saved source document. */
  occurrence: number;
  snippet: string;
}

export interface PageBacklinksResponse {
  links: PageBacklink[];
  truncated: boolean;
}

const referenceUrl = /^\/\?page=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function pageReferenceUrl(pageId: string): string {
  return `/?page=${encodeURIComponent(pageId)}`;
}

export function pageIdFromReferenceUrl(url: string): string | null {
  return referenceUrl.exec(url)?.[1]?.toLowerCase() ?? null;
}
