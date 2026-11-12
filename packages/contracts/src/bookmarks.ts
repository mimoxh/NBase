/** Metadata of a web bookmark card; the server reads it once, the document stores it. */
export interface LinkPreview { url: string; title: string; description: string; siteName: string }

export const bookmarkLimits = { url: 2000, title: 300, description: 1000, siteName: 120 } as const;

const control = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit && !control.test(value);

export function isSerializedBookmark(node: Record<string, unknown>): boolean {
  if (!text(node.url, bookmarkLimits.url) || !/^https?:\/\/[^\s]+$/i.test(String(node.url))) return false;
  return text(node.title, bookmarkLimits.title) && text(node.description, bookmarkLimits.description)
    && text(node.siteName, bookmarkLimits.siteName);
}
