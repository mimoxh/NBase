import { isFootnoteId, isSerializedBlockReference, pageReferenceLabelLimit, type SerializedPageReference, type StoredDocumentContent } from '@nbase/contracts';

import { isWhiteboardContent, whiteboardIndex } from '../whiteboards/content.js';

const separatingElements = new Set(['paragraph', 'heading', 'quote', 'callout', 'toggle', 'listitem', 'code', 'tablecell', 'footnote-definition']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const contextLength = 48;

export interface IndexedPageReference { targetPageId: string; occurrence: number; snippet: string }

export function isPageReference(value: Record<string, unknown>): value is Record<string, unknown> & SerializedPageReference {
  return value.type === 'page-reference' && value.version === 1 && value.children === undefined
    && typeof value.targetPageId === 'string' && uuidPattern.test(value.targetPageId)
    && typeof value.label === 'string' && value.label.length <= pageReferenceLabelLimit && Boolean(value.label.trim())
    && !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value.label);
}

const normalizeWhitespace = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** Flatten adjacent text leaves and retain reference positions for contextual snippets. */
function inspectDocument(content: StoredDocumentContent, collectReferences: boolean) {
  if (isWhiteboardContent(content)) return whiteboardIndex(content);
  const pieces: string[] = [];
  const locations: { targetPageId: string; occurrence: number; start: number; end: number }[] = [];
  let length = 0;
  let occurrence = 0;
  const append = (text: string) => { pieces.push(text); length += text.length; };
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 64) return;
    const value = node as Record<string, unknown>;
    // Block references share the occurrence counter: both index into page_links and render with the same DOM marker.
    if (value.type === 'page-reference' || value.type === 'block-reference') {
      const ordinal = occurrence++;
      if (value.type === 'page-reference' ? isPageReference(value) : isSerializedBlockReference(value)) {
        const start = length;
        const reference = value as { label: string; targetPageId: string };
        append(reference.label);
        if (collectReferences) locations.push({ targetPageId: reference.targetPageId.toLowerCase(), occurrence: ordinal, start, end: length });
      }
    } else if ((value.type === 'footnote-reference' || value.type === 'footnote-definition') && isFootnoteId(value.footnoteId)) {
      append(' ' + value.footnoteId + ' ');
    } else if (value.type === 'callout') {
      if (typeof value.title === 'string') append(` ${value.title} `);
    } else if (value.type === 'bookmark') {
      for (const key of ['title', 'description', 'siteName'] as const) if (typeof value[key] === 'string') append(` ${value[key]} `);
    } else if (value.type === 'mermaid') {
      if (typeof value.source === 'string') append(` ${value.source} `);
    } else if (value.type === 'equation') {
      if (typeof value.equation === 'string') append(` ${value.equation} `);
    } else if (value.type === 'attachment') {
      if (typeof value.fileName === 'string') append(` ${value.fileName} `);
      if (typeof value.alt === 'string' && value.alt !== value.fileName) append(` ${value.alt} `);
      if (typeof value.caption === 'string') append(` ${value.caption} `);
    } else if (typeof value.text === 'string') append(value.text);
    if (Array.isArray(value.children)) value.children.forEach(child => visit(child, depth + 1));
    if (separatingElements.has(String(value.type))) append(' ');
  };
  visit(content.editorState.root, 0);
  const raw = pieces.join('');
  const references: IndexedPageReference[] = locations.map(({ targetPageId, occurrence, start, end }) => {
    const from = Math.max(0, start - contextLength);
    const to = Math.min(raw.length, end + contextLength);
    const excerpt = normalizeWhitespace(raw.slice(from, to).replace(/^\p{Cs}|\p{Cs}$/gu, ''));
    return { targetPageId, occurrence, snippet: `${from > 0 ? '…' : ''}${excerpt}${to < raw.length ? '…' : ''}` };
  });
  return { searchText: normalizeWhitespace(raw), references };
}

export function extractSearchText(content: StoredDocumentContent): string {
  return inspectDocument(content, false).searchText;
}

export function extractDocumentIndex(content: StoredDocumentContent): { searchText: string; references: IndexedPageReference[] } {
  return inspectDocument(content, true);
}
