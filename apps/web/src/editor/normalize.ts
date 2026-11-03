import type { SerializedRootNode } from 'lexical';
import type { DocumentContent } from './types';

type JsonObject = Record<string, unknown>;

const textNode = (text: string): JsonObject => ({ type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 });
const linebreakNode = (): JsonObject => ({ type: 'linebreak', version: 1 });

function codeText(children: unknown): string {
  if (!Array.isArray(children)) return '';
  let text = '';
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const node = child as JsonObject;
    if (node.type === 'linebreak') text += '\n';
    else if (node.type === 'tab') text += '\t';
    else if (typeof node.text === 'string') text += node.text;
  }
  return text;
}

/**
 * Prism highlighting replaces code text with `code-highlight` tokens and splits
 * it at every line. Persistence only cares about the visible code text, so code
 * children are always compared and stored in one canonical text + linebreak
 * shape; re-tokenizing then can never register as an edit.
 */
function normalizeCodeChildren(children: unknown): JsonObject[] {
  const nodes: JsonObject[] = [];
  codeText(children).split('\n').forEach((line, index) => {
    if (index) nodes.push(linebreakNode());
    if (line) nodes.push(textNode(line));
  });
  return nodes;
}

function normalizeNode(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const record = node as JsonObject;
  if (record.type === 'code') return { ...record, children: normalizeCodeChildren(record.children) };
  if (Array.isArray(record.children)) return { ...record, children: record.children.map(normalizeNode) };
  return node;
}

/** Idempotent canonical form used for saved content, drafts and server comparisons. */
export function normalizeDocumentContent(content: DocumentContent): DocumentContent {
  if (!content || content.schemaVersion !== 1 || !content.editorState) return content;
  return {
    ...content,
    editorState: { ...content.editorState, root: normalizeNode(content.editorState.root) as SerializedRootNode },
  };
}
