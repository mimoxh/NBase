import { pageIdFromReferenceUrl, whiteboardContent, whiteboardContentProblem } from '@nbase/contracts';
import { cloneElements, elementText, indexElements, normalizeForSave, type El, type Elements } from './model';

/** Clipboard payloads carry detached copies, so pasting never depends on the source board. */
export const clipboardMime = 'application/x-nbase-whiteboard';
const marker = 'nbaseWhiteboard';

/** `imageUrl` says where each copied image can be read, so a paste into another workspace can bring the image along. */
export function serializeElements(elements: Elements, newId: () => string, imageUrl?: (attachmentId: string) => string | null): string {
  const copies = normalizeForSave(cloneElements(elements, indexElements(elements), { x: 0, y: 0 }, newId));
  const images: Record<string, string> = {};
  for (const el of copies) {
    const url = el.type === 'image' ? imageUrl?.(el.attachmentId) : null;
    if (el.type === 'image' && url) images[el.attachmentId] = url;
  }
  return JSON.stringify({ [marker]: 1, elements: copies, ...(Object.keys(images).length ? { images } : {}) });
}

const attachmentPath = /^\/api\/workspaces\/[0-9a-f-]{36}\/attachments\/[0-9a-f-]{36}\/content$/i;

/**
 * Where the images of a clipboard payload were copied from. Clipboard text can come from anywhere,
 * so only this site's own attachment addresses (and its in-memory images) are accepted.
 */
export function clipboardImageSources(text: string, origin: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!text.startsWith('{') || !text.includes(marker)) return result;
  try {
    const images = (JSON.parse(text) as { images?: unknown }).images;
    if (typeof images !== 'object' || images === null) return result;
    for (const [id, value] of Object.entries(images)) {
      if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) continue;
      if (value.startsWith(`blob:${origin}/`)) { result.set(id, value); continue; }
      const url = new URL(value, origin);
      if (url.origin === origin && attachmentPath.test(url.pathname) && !url.search && !url.hash) result.set(id, url.pathname);
    }
  } catch { /* Not a payload this site wrote. */ }
  return result;
}

/** Elements from a clipboard payload, or null when it is not a valid whiteboard payload. */
export function parseElements(text: string): El[] | null {
  if (!text.startsWith('{') || !text.includes(marker)) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || (value as Record<string, unknown>)[marker] !== 1) return null;
    const elements = (value as { elements?: unknown }).elements;
    if (!Array.isArray(elements) || whiteboardContentProblem(whiteboardContent(elements as El[])) !== null) return null;
    return elements as El[];
  } catch { return null; }
}

/** Plain-text fallback for pasting into other applications. */
export function plainText(elements: Elements): string {
  return elements.map(elementText).filter(Boolean).join('\n');
}

/** A pasted NBase page link (relative or absolute) becomes a page card. */
export function pageIdFromPastedText(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  const direct = pageIdFromReferenceUrl(value);
  if (direct) return direct;
  try {
    const url = new URL(value);
    return pageIdFromReferenceUrl(`/?page=${url.searchParams.get('page') ?? ''}`) && url.pathname === '/'
      ? pageIdFromReferenceUrl(`/?page=${url.searchParams.get('page')}`) : null;
  } catch { return null; }
}
