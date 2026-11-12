import { pageIdFromReferenceUrl, whiteboardContent, whiteboardContentProblem } from '@nbase/contracts';
import { cloneElements, elementText, indexElements, normalizeForSave, type El, type Elements } from './model';

/** Clipboard payloads carry detached copies, so pasting never depends on the source board. */
export const clipboardMime = 'application/x-nbase-whiteboard';
const marker = 'nbaseWhiteboard';

export function serializeElements(elements: Elements, newId: () => string): string {
  const copies = normalizeForSave(cloneElements(elements, indexElements(elements), { x: 0, y: 0 }, newId));
  return JSON.stringify({ [marker]: 1, elements: copies });
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
