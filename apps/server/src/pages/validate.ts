import { pageCoverIds, type PageCoverId, type StoredDocumentContent } from '@nbase/contracts';

export const maxContentBytes = 1024 * 1024;
const maxNodes = 20_000;
const maxDepth = 64;
const elementTypes = new Set([
  'root', 'paragraph', 'heading', 'quote', 'list', 'listitem', 'code',
  'link', 'autolink', 'table', 'tablerow', 'tablecell',
]);
const leafTypes = new Set(['text', 'code-highlight', 'linebreak', 'tab', 'horizontalrule', 'image-reference', 'attachment', 'equation']);
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirrors the editor's supported protocols; persisted links must stay safe after reopening. */
function safeLinkUrl(url: string): boolean {
  const value = url.trim();
  if (!value || /[\u0000-\u0020\u007f-\u009f\\]/.test(value) || /&(?:#\w+|\w+);/.test(value)) return false;
  if (value.startsWith('//')) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return scheme ? ['http', 'https', 'mailto'].includes(scheme) : !/^[^/?#]*:/.test(value);
}

export class ContentValidationError extends Error {
  constructor(public readonly code: 'CONTENT_INVALID' | 'CONTENT_VERSION_UNSUPPORTED') {
    super(code);
  }
}

function invalid(): never { throw new ContentValidationError('CONTENT_INVALID'); }

export function validateDocumentContent(value: unknown): StoredDocumentContent {
  if (!object(value)) invalid();
  if (value.schemaVersion !== 1) throw new ContentValidationError('CONTENT_VERSION_UNSUPPORTED');
  let json: string;
  try { json = JSON.stringify(value); } catch { return invalid(); }
  if (Buffer.byteLength(json, 'utf8') > maxContentBytes) invalid();
  if (!object(value.editorState) || !object(value.editorState.root)) invalid();

  let count = 0;
  function visit(node: unknown, depth: number, inTable: boolean): void {
    if (!object(node) || depth > maxDepth || ++count > maxNodes) invalid();
    if (Object.keys(node).some((key) => forbiddenKeys.has(key))) invalid();
    if (typeof node.type !== 'string' || node.version !== 1) invalid();
    if (node.textStyle !== undefined && node.textStyle !== '') invalid();
    if (node.style !== undefined && node.style !== '') invalid();
    if (node.type === 'table' && inTable) invalid();
    if ((node.type === 'link' || node.type === 'autolink')
      && (typeof node.url !== 'string' || !safeLinkUrl(node.url))) invalid();
    if (node.type === 'heading' && !['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(String(node.tag))) invalid();
    if (node.type === 'list' && !['bullet', 'number', 'check'].includes(String(node.listType))) invalid();
    if (node.type === 'tablecell' && (node.colSpan !== 1 || node.rowSpan !== 1)) invalid();
    if (node.type === 'image-reference'
      && (typeof node.markdown !== 'string' || typeof node.alt !== 'string')) invalid();
    if (node.type === 'equation' && (typeof node.equation !== 'string' || node.equation.length > 10_000
      || typeof node.inline !== 'boolean')) invalid();
    if (node.type === 'attachment' && (!uuidPattern.test(String(node.attachmentId))
      || typeof node.alt !== 'string' || node.alt.length > 500
      || typeof node.fileName !== 'string' || node.fileName.length < 1 || node.fileName.length > 180
      || typeof node.mediaType !== 'string' || node.mediaType.length > 100)) invalid();

    if (elementTypes.has(node.type)) {
      if (!Array.isArray(node.children)) invalid();
      for (const child of node.children) visit(child, depth + 1, inTable || node.type === 'table');
      return;
    }
    if (!leafTypes.has(node.type) || node.children !== undefined) invalid();
    if (['text', 'code-highlight', 'tab', 'image-reference'].includes(node.type) && typeof node.text !== 'string') invalid();
  }

  if (value.editorState.root.type !== 'root') invalid();
  visit(value.editorState.root, 0, false);
  return value as unknown as StoredDocumentContent;
}

export class PageFieldError extends Error {
  constructor() { super('INVALID_REQUEST'); }
}

function invalidField(): never { throw new PageFieldError(); }

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const iconStart = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?\u20E3)/u;
const iconForbidden = /[\u0000-\u001f\u007f-\u009f\s\u202a-\u202e\u2066-\u2069]/u;

/** Page icons are exactly one emoji grapheme (ZWJ, modifier and keycap sequences allowed). */
export function validatePageIcon(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 32) invalidField();
  if ([...graphemeSegmenter.segment(value)].length !== 1) invalidField();
  if (!iconStart.test(value) || iconForbidden.test(value)) invalidField();
  return value;
}

/** Covers are client-rendered CSS presets from the shared allow-list. */
export function validatePageCover(value: unknown): PageCoverId | null {
  if (value === null) return null;
  if (typeof value === 'string' && (pageCoverIds as readonly string[]).includes(value)) return value as PageCoverId;
  return invalidField();
}

export interface AttachmentReference { id: string; fileName: string; mediaType: string }

/** Call only after validateDocumentContent has bounded the tree. */
export function attachmentReferences(content: StoredDocumentContent): AttachmentReference[] {
  const result: AttachmentReference[] = [];
  const visit = (node: unknown): void => {
    const value = node as Record<string, unknown>;
    if (value.type === 'attachment') result.push({ id: String(value.attachmentId),
      fileName: String(value.fileName), mediaType: String(value.mediaType) });
    if (Array.isArray(value.children)) value.children.forEach(visit);
  };
  visit(content.editorState.root);
  return result;
}
