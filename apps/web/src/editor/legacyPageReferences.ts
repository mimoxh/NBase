import { $isCodeNode } from '@lexical/code';
import { $isLinkNode } from '@lexical/link';
import { $getRoot, $isElementNode, $isTextNode, $setSelection, type LexicalNode, type TextNode } from 'lexical';
import { $createPageReferenceNode, isPageReferenceLabel } from './nodes/PageReferenceNode';
import { exactReferenceTitle, type PageReferenceCatalog } from './pageReferenceCatalog';

/** Keep literal legacy markers in Markdown until an authorized editor explicitly applies the preview. */
export const legacyPageReferencePattern = /(?<!(?<!\\)(?:\\\\)*\\)\[\[([^[\]\r\n]{1,255})\]\]/u;

interface ReferenceSpan { node: TextNode; start: number; end: number }
interface ConvertibleReference { label: string; pageId: string; spans: ReferenceSpan[] }
interface UnresolvedReference { label: string; reason: 'missing' | 'ambiguous' }

export function $scanLegacyPageReferences(catalog: PageReferenceCatalog) {
  const convertible: ConvertibleReference[] = [];
  const unresolved: UnresolvedReference[] = [];
  const pattern = new RegExp(legacyPageReferencePattern.source, 'gu');
  let spans: ReferenceSpan[] = [];
  let text = '';
  const flush = () => {
    let first = 0;
    for (const match of text.matchAll(pattern)) {
      const label = match[1]!.trim();
      if (!isPageReferenceLabel(label)) continue;
      const pageId = catalog.byExactTitle.get(exactReferenceTitle(label));
      if (!pageId) {
        unresolved.push({ label, reason: pageId === null ? 'ambiguous' : 'missing' });
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      while (spans[first] && spans[first]!.end <= start) first++;
      const affected: ReferenceSpan[] = [];
      for (let index = first; spans[index] && spans[index]!.start < end; index++) {
        const span = spans[index]!;
        affected.push({ node: span.node, start: Math.max(start, span.start) - span.start, end: Math.min(end, span.end) - span.start });
      }
      convertible.push({ label, pageId, spans: affected });
    }
    spans = [];
    text = '';
  };

  function visit(node: LexicalNode): void {
    if ($isCodeNode(node) || $isLinkNode(node)) {
      flush();
      return;
    }
    if ($isElementNode(node)) {
      const boundary = !node.isInline();
      if (boundary) flush();
      node.getChildren().forEach(visit);
      if (boundary) flush();
    } else if ($isTextNode(node) && node.getType() === 'text' && !node.hasFormat('code') && !node.isToken() && !node.isSegmented()) {
      const start = text.length;
      text += node.getTextContent();
      spans.push({ node, start, end: text.length });
    } else {
      flush();
    }
  }

  $getRoot().getChildren().forEach(visit);
  flush();
  return { convertible, unresolved };
}

/** Apply all ranges backwards so earlier offsets and neighboring text formatting stay valid. */
export function $applyLegacyPageReferences(matches: readonly ConvertibleReference[]): void {
  if (!matches.length) return;
  $setSelection(null);
  for (let index = matches.length - 1; index >= 0; index--) {
    const { label, pageId, spans } = matches[index]!;
    for (let part = spans.length - 1; part >= 0; part--) {
      const { node, start, end } = spans[part]!;
      const pieces = node.splitText(start, end);
      const matched = pieces[start === 0 ? 0 : 1]!;
      if (part === 0) matched.replace($createPageReferenceNode(pageId, label));
      else matched.remove();
    }
  }
}
