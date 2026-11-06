import { pageReferenceLabelLimit, pageReferenceUrl, type AttachmentMetadata, type StoredDocumentContent } from '@nbase/contracts';

export type FolderNode = Record<string, unknown>;

export function isFolderObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function trimUtf16(value: string, max: number): string {
  return value.slice(0, max).replace(/[\ud800-\udbff]$/, '');
}

/** Visits serialized nodes, leaving code and children of ordinary links intact. */
export function mapFolderDocument(content: StoredDocumentContent, replace: (node: FolderNode) => FolderNode): StoredDocumentContent {
  const visit = (node: unknown): unknown => {
    if (!isFolderObject(node)) return node;
    const replaced = replace(node);
    if (replaced !== node || node.type === 'code' || node.type === 'link' || node.type === 'autolink'
      || !Array.isArray(node.children)) return replaced;
    const children = node.children.map(visit);
    return children.some((child, index) => child !== (node.children as unknown[])[index])
      ? { ...node, children } : node;
  };
  return { ...content, editorState: { ...content.editorState, root: visit(content.editorState.root) } };
}

function labelText(node: unknown): string {
  if (!isFolderObject(node)) return '';
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.children)) return node.children.map(labelText).join('');
  return '';
}

const imageDestination = /^!\[(?:\\.|[^\]\\])*\]\((?:<([^<>\r\n]*)>|((?:\\.|[^\s()\\])*))(?:\s+"(?:\\.|[^"\\])*")?\)$/u;
const unescapePunctuation = (value: string) => value.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const escapeLabel = (value: string) => value.replace(/[\\\[\]]/g, '\\$&');

export function folderNodeLink(node: FolderNode): { url: string; label: string; image: boolean } | null {
  if ((node.type === 'link' || node.type === 'autolink') && typeof node.url === 'string') {
    return { url: node.url, label: labelText(node), image: false };
  }
  if (node.type !== 'image-reference' || typeof node.markdown !== 'string') return null;
  const match = imageDestination.exec(node.markdown);
  if (!match) return null;
  return { url: unescapePunctuation(match[1] ?? match[2] ?? ''), label: String(node.alt ?? ''), image: true };
}

const unsafePath = /[\\:\u0000-\u001f\u007f-\u009f\p{Cs}]/u;

export function normalizeFolderPath(path: string): string | null {
  const pieces = path.split('/');
  if (!path || path.length > 1024 || pieces.length > 32 || unsafePath.test(path)
    || pieces.some(piece => !piece || piece === '.' || piece === '..')) return null;
  return pieces.map(piece => piece.normalize('NFC')).join('/');
}

export function folderParentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

export function folderBaseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export type FolderDestination =
  | { kind: 'outside' | 'external' | 'anchor' }
  | { kind: 'local'; path: string; hasSuffix: boolean };

/** Decode one URL component at a time, rejecting encoded separators and escapes above the selected root. */
export function folderDestination(url: string, source: string): FolderDestination {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return { kind: 'external' };
  if (url.startsWith('#') || url.startsWith('?')) return { kind: 'anchor' };
  if (url.startsWith('/') || unsafePath.test(url)) return { kind: 'outside' };
  const delimiter = url.search(/[?#]/);
  const raw = delimiter === -1 ? url : url.slice(0, delimiter);
  if (!raw) return { kind: 'anchor' };
  const parts = folderParentPath(source).split('/').filter(Boolean);
  for (const encoded of raw.split('/')) {
    let part: string;
    try { part = decodeURIComponent(encoded).normalize('NFC'); }
    catch { return { kind: 'outside' }; }
    if (part.includes('/') || unsafePath.test(part)) return { kind: 'outside' };
    if (part === '..') {
      if (!parts.length) return { kind: 'outside' };
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  const path = normalizeFolderPath(parts.join('/'));
  return path ? { kind: 'local', path, hasSuffix: delimiter >= 0 } : { kind: 'outside' };
}

export function folderText(text: string): FolderNode {
  return { type: 'text', version: 1, text, format: 0, detail: 0, mode: 'normal', style: '' };
}

export function folderPageReference(targetPageId: string, label: string, fallback: string): FolderNode {
  const safeLabel = trimUtf16((label || fallback).replace(/[\p{Cc}\p{Cs}\u2028\u2029]/gu, ' ').trim(), pageReferenceLabelLimit);
  return { type: 'page-reference', version: 1, targetPageId, label: safeLabel || '页面引用' };
}

export function folderAttachment(metadata: AttachmentMetadata, label: string): FolderNode {
  return { type: 'attachment', version: 1, attachmentId: metadata.id, fileName: metadata.fileName,
    mediaType: metadata.mediaType, alt: trimUtf16(label, 500) };
}

export function folderMarkdownLink(url: string, label: string, image = false): FolderNode {
  if (image) return { ...folderText('图片：' + label), type: 'image-reference', mode: 'token',
    markdown: '![' + escapeLabel(label) + '](' + url + ')', alt: label };
  return { type: 'link', version: 1, children: [folderText(label)], direction: null,
    format: '', indent: 0, url, rel: null, target: null, title: null };
}

export function keepFolderLinkLiteral(url: string, label: string): FolderNode {
  return folderText('[' + escapeLabel(label) + '](' + url + ')');
}

export function keepExternalPageReference(node: FolderNode): FolderNode {
  return folderMarkdownLink(pageReferenceUrl(String(node.targetPageId)), String(node.label));
}
