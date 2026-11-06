export const markdownFrontMatterKey = 'nbaseMarkdownFrontMatter';
export const markdownFrontMatterMaxBytes = 16 * 1024;
export const markdownFrontMatterMaxDepth = 8;
export const markdownFrontMatterMaxNodes = 512;

export type MarkdownMetadataValue = null | boolean | number | string | MarkdownMetadataValue[] | { [key: string]: MarkdownMetadataValue };
export type MarkdownFrontMatter = Record<string, MarkdownMetadataValue>;

export function isMarkdownDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isMarkdownMetadataKey(key: string): boolean {
  return key.length > 0 && key.length <= 100 && !/[\p{Cc}\p{Cs}]/u.test(key)
    && key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
}

/** Metadata must also be safe when a caller supplies Lexical JSON directly. */
export function isMarkdownFrontMatter(value: unknown): value is MarkdownFrontMatter {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.hasOwn(value, 'title') || Object.hasOwn(value, 'tags')) return false;
  if ('date' in value && !isMarkdownDate(value.date)) return false;
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > markdownFrontMatterMaxNodes || depth > markdownFrontMatterMaxDepth) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= markdownFrontMatterMaxBytes && !/[\u0000\p{Cs}]/u.test(item);
    if (typeof item === 'number') return Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item));
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
    if (!item || typeof item !== 'object') return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    return (prototype === Object.prototype || prototype === null)
      && Object.entries(item).every(([key, child]) => isMarkdownMetadataKey(key) && visit(child, depth + 1));
  };
  return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= markdownFrontMatterMaxBytes;
}

/** A bounded identifier that can be written verbatim in both Markdown footnote forms. */
export function isFootnoteId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^[\p{L}\p{N}._-]+$/u.test(value);
}
