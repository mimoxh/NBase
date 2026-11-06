import { $isLinkNode } from '@lexical/link';
import { $getNodeByKey, $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, $setSelection } from 'lexical';
import type { LexicalNode, NodeKey } from 'lexical';
import { AttachmentNode } from './nodes/AttachmentNode';
import { $isCalloutNode, calloutLabels } from './nodes/CalloutNode';

interface TextSpan {
  key: NodeKey;
  start: number;
  end: number;
  writable: boolean;
  link: NodeKey | null;
}

interface MatchGroup {
  text: string;
  offsets: number[];
  spans: TextSpan[] | null;
}

export interface DocumentMatchIndex {
  groups: MatchGroup[];
  count: number;
}

export type DocumentMatch = { text: string; replaceable: boolean } & (
  | { kind: 'title'; start: number; end: number }
  | { kind: 'body'; spans: TextSpan[] }
);

/** Index text as separate runs so matches cannot cross block or cell boundaries. */
export function $findDocumentMatches(query: string, { title = '', caseSensitive = false } = {}): DocumentMatchIndex {
  const index: DocumentMatchIndex = { groups: [], count: 0 };
  if (!query) return index;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  const add = (text: string, spans: TextSpan[] | null) => {
    const offsets: number[] = [];
    for (const match of text.matchAll(pattern)) offsets.push(match.index, match.index + match[0].length);
    if (offsets.length) {
      index.groups.push({ text, offsets, spans });
      index.count += offsets.length / 2;
    }
  };

  add(title, null);
  let spans: TextSpan[] = [];
  let text = '';
  const flush = () => { add(text, spans); text = ''; spans = []; };
  const append = (node: LexicalNode, value: string, writable: boolean, link: NodeKey | null) => {
    if (!value) return;
    const start = text.length;
    text += value;
    spans.push({ key: node.getKey(), start, end: text.length, writable, link });
  };
  const visit = (node: LexicalNode, link: NodeKey | null) => {
    if ($isElementNode(node)) {
      const boundary = !node.isInline();
      if (boundary) flush();
      if ($isCalloutNode(node)) {
        const label = calloutLabels[node.getKind()];
        const title = node.getTitle();
        append(node, title ? `${label} · ${title}` : label, false, null);
        flush();
      }
      for (const child of node.getChildren()) visit(child, $isLinkNode(node) ? node.getKey() : link);
      if (boundary) flush();
    } else if ($isTextNode(node)) {
      append(node, node.getTextContent(), ['text', 'code-highlight'].includes(node.getType())
        && !node.isToken() && !node.isSegmented(), link);
    } else if ($isLineBreakNode(node)) {
      append(node, '\n', false, link);
    } else if (node instanceof AttachmentNode) {
      const { fileName, alt } = node.exportJSON();
      append(node, fileName, false, link);
      if (alt && alt !== fileName) append(node, ` ${alt}`, false, link);
    } else {
      if (!node.isInline()) flush();
      append(node, node.getTextContent(), false, link);
      if (!node.isInline()) flush();
    }
  };
  for (const node of $getRoot().getChildren()) visit(node, null);
  flush();
  return index;
}

function matchInGroup(group: MatchGroup, offset: number): DocumentMatch {
  const start = group.offsets[offset]!;
  const end = group.offsets[offset + 1]!;
  const text = group.text.slice(start, end);
  if (!group.spans) return { kind: 'title', start, end, text, replaceable: true };

  let first = 0;
  let last = group.spans.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (group.spans[middle]!.end <= start) first = middle + 1;
    else last = middle;
  }
  const spans: TextSpan[] = [];
  for (let position = first; position < group.spans.length; position++) {
    const span = group.spans[position]!;
    if (span.start >= end) break;
    spans.push({ ...span, start: Math.max(start, span.start) - span.start, end: Math.min(end, span.end) - span.start });
  }
  const replaceable = spans.length > 0 && spans.every(span => span.writable && span.link === spans[0]!.link);
  return { kind: 'body', text, spans, replaceable };
}

export function documentMatchAt(index: DocumentMatchIndex, position: number): DocumentMatch | null {
  if (position < 0) return null;
  for (const group of index.groups) {
    const count = group.offsets.length / 2;
    if (position < count) return matchInGroup(group, position * 2);
    position -= count;
  }
  return null;
}

export function* allDocumentMatches(index: DocumentMatchIndex): Iterable<DocumentMatch> {
  for (const group of index.groups) {
    for (let offset = 0; offset < group.offsets.length; offset += 2) yield matchInGroup(group, offset);
  }
}

interface Edit { start: number; end: number; text: string }

function applyEdits(text: string, edits: Edit[]): string {
  const fragments: string[] = [];
  let offset = 0;
  for (const edit of edits) {
    fragments.push(text.slice(offset, edit.start), edit.text);
    offset = edit.end;
  }
  fragments.push(text.slice(offset));
  return fragments.join('');
}

/** Apply each text leaf once, keeping the rest of the document and its formatting intact. */
export function $replaceDocumentMatches(matches: Iterable<DocumentMatch>, replacement: string, title: string,
  replaceTitle: boolean, maxGrowthBytes = 1024 * 1024) {
  const titleEdits: Edit[] = [];
  const bodyEdits = new Map<NodeKey, Edit[]>();
  const encoder = new TextEncoder();
  const replacementBytes = encoder.encode(JSON.stringify(replacement)).length;
  const matchSizes = new Map<string, number>();
  let growthBytes = 0;
  let changed = 0;
  let skipped = 0;
  for (const match of matches) {
    if (!match.replaceable || (match.kind === 'title' && !replaceTitle)) { skipped++; continue; }
    if (match.text === replacement) continue;
    changed++;
    if (match.kind === 'title') { titleEdits.push({ start: match.start, end: match.end, text: replacement }); continue; }
    const matchBytes = matchSizes.get(match.text) ?? encoder.encode(JSON.stringify(match.text)).length;
    matchSizes.set(match.text, matchBytes);
    growthBytes += replacementBytes - matchBytes;
    if (growthBytes > maxGrowthBytes) return { title, bodyChanged: false, changed: 0, skipped, titleTooLong: false, bodyTooLarge: true };
    match.spans.forEach(({ key, start, end }, position) => {
      const edits = bodyEdits.get(key) ?? [];
      edits.push({ start, end, text: position === 0 ? replacement : '' });
      bodyEdits.set(key, edits);
    });
  }
  const nextTitle = applyEdits(title, titleEdits);
  if (titleEdits.length && nextTitle.length > 255) return { title, bodyChanged: false, changed: 0, skipped, titleTooLong: true, bodyTooLarge: false };

  if (bodyEdits.size) $setSelection(null);
  for (const [key, edits] of bodyEdits) {
    const node = $getNodeByKey(key);
    if ($isTextNode(node)) node.setTextContent(applyEdits(node.getTextContent(), edits));
  }
  return { title: nextTitle, bodyChanged: bodyEdits.size > 0, changed, skipped, titleTooLong: false, bodyTooLarge: false };
}
