import { attachmentPresentationOf, isAttachmentPresentation, type AttachmentPresentation, type StoredDocumentContent } from '@nbase/contracts';

type JsonNode = Record<string, unknown> & { children?: unknown };

const occurrenceLimit = 20_000;

function childrenOf(node: JsonNode): JsonNode[] {
  return Array.isArray(node.children) ? node.children as JsonNode[] : [];
}

function visit(node: JsonNode, depth: number, found: JsonNode[]): void {
  if (depth > 64 || found.length > occurrenceLimit) return;
  if (node.type === 'attachment') found.push(node);
  childrenOf(node).forEach(child => visit(child, depth + 1, found));
}

function attachmentsIn(node: JsonNode): JsonNode[] {
  const found: JsonNode[] = [];
  visit(node, 0, found);
  return found;
}

function rootOf(content: StoredDocumentContent): JsonNode {
  return content.editorState.root as unknown as JsonNode;
}

function textOf(node: JsonNode): string {
  return typeof node.text === 'string' ? node.text : childrenOf(node).map(textOf).join('');
}

function captionsIn(block: JsonNode): string[] {
  if (block.type === 'table') return [];
  return attachmentsIn(block).flatMap(node => typeof node.caption === 'string' ? [node.caption] : []);
}

/** One record per attachment occurrence in document order; the page manifest stores these. */
export function attachmentPresentations(content: StoredDocumentContent): AttachmentPresentation[] {
  return attachmentsIn(rootOf(content)).map(node => attachmentPresentationOf(node as AttachmentPresentation));
}

export function hasAttachmentPresentation(list: AttachmentPresentation[]): boolean {
  return list.some(item => Object.keys(item).length > 0);
}

/** Validated manifest records, or undefined when the field is missing or was edited by hand. */
export function readAttachmentPresentations(value: unknown): AttachmentPresentation[] | undefined {
  if (!Array.isArray(value) || value.length > occurrenceLimit || !value.every(isAttachmentPresentation)) return undefined;
  return value.map(attachmentPresentationOf);
}

function paragraph(text: string): JsonNode {
  return { type: 'paragraph', version: 1, direction: null, format: '', indent: 0, textFormat: 0, textStyle: '',
    children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }] };
}

/** Markdown has no caption, so exports show one as the paragraph below its image. */
export function withCaptionParagraphs(content: StoredDocumentContent): StoredDocumentContent {
  const root = rootOf(content);
  const blocks = childrenOf(root);
  if (!blocks.some(block => captionsIn(block).length)) return content;
  const children = blocks.flatMap(block => [block, ...captionsIn(block).map(paragraph)]);
  return { ...content, editorState: { ...content.editorState, root: { ...root, children } } } as StoredDocumentContent;
}

/**
 * Restores manifest records after an NBase ZIP import and drops the caption
 * paragraphs the export added. Skips everything if any attachment failed to
 * rebuild, because records are matched by position.
 */
export function restoreAttachmentPresentations(content: StoredDocumentContent, list: AttachmentPresentation[] | undefined): StoredDocumentContent {
  if (!list || !hasAttachmentPresentation(list)) return content;
  const copy = structuredClone(content);
  const root = rootOf(copy);
  const nodes = attachmentsIn(root);
  if (nodes.length !== list.length) return content;
  nodes.forEach((node, index) => {
    const record = list[index]!;
    if (Object.keys(record).length && String(node.mediaType).startsWith('image/')) {
      Object.assign(node, record);
    }
  });
  const kept: JsonNode[] = [];
  const blocks = childrenOf(root);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    kept.push(block);
    for (const caption of captionsIn(block)) {
      const next = blocks[index + 1];
      if (next?.type === 'paragraph' && textOf(next) === caption) index += 1;
    }
  }
  root.children = kept;
  return copy;
}
