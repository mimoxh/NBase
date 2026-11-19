import { commentAnchorDepthLimit, commentQuoteLimit, type CommentAnchor } from '@nbase/contracts';
import { $getNearestNodeFromDOMNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection } from 'lexical';
import type { ElementNode, LexicalEditor, LexicalNode } from 'lexical';
import { $blockIdOf, $findBlockById } from './blockAnchors';

/** Single-line, length-limited text as the server stores it. */
export function commentQuote(text: string): string {
  return [...text.replace(/[\p{Cc}\p{Cs}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, commentQuoteLimit).join('');
}

function $blockOf(node: LexicalNode | null): ElementNode | null {
  for (let current = node; current; current = current.getParent()) {
    if ($isElementNode(current) && !current.isInline() && current.getParent() !== null) return current;
  }
  return null;
}

function $pathOf(block: ElementNode): number[] | null {
  const path: number[] = [];
  for (let current: LexicalNode = block; current.getParent(); current = current.getParent()!) path.unshift(current.getIndexWithinParent());
  return path.length >= 1 && path.length <= commentAnchorDepthLimit ? path : null;
}

/**
 * The block under the reader's selection, or null when the selection is outside this editor. The DOM selection is
 * read first so that read-only pages, where Lexical keeps no selection, still work.
 */
export function readCommentAnchor(editor: LexicalEditor): CommentAnchor | null {
  const root = editor.getRootElement();
  const dom = window.getSelection();
  const domNode = dom?.anchorNode && root?.contains(dom.anchorNode) ? dom.anchorNode : null;
  const selected = domNode && dom && !dom.isCollapsed ? dom.toString() : '';
  return editor.read(() => {
    let node: LexicalNode | null = domNode ? $getNearestNodeFromDOMNode(domNode) : null;
    if (!node) {
      const selection = $getSelection();
      node = $isRangeSelection(selection) ? selection.anchor.getNode() : null;
    }
    const block = $blockOf(node);
    if (!block) return null;
    const path = $pathOf(block);
    if (!path) return null;
    const blockText = commentQuote(block.getTextContent());
    const quote = commentQuote(selected);
    return { blockId: $blockIdOf(block), path, quote: quote && blockText.includes(quote) ? quote : blockText };
  });
}

function $blockAtPath(path: number[]): ElementNode | null {
  let node: LexicalNode | null = $getRoot();
  for (const index of path) node = $isElementNode(node) ? node.getChildAtIndex(index) : null;
  return $isElementNode(node) ? node : null;
}

function $firstBlockWith(quote: string): ElementNode | null {
  let found: ElementNode | null = null;
  const visit = (node: LexicalNode): void => {
    if (found || !$isElementNode(node)) return;
    const children = node.getChildren();
    // Prefer the innermost block holding the quote, so a paragraph wins over the list or table around it.
    for (const child of children) visit(child);
    if (!found && !node.isInline() && node.getParent() !== null && commentQuote(node.getTextContent()).includes(quote)) found = node;
  };
  visit($getRoot());
  return found;
}

/** Anchor id, then the block at the stored path if it still holds the quote, then the first block holding it. */
export function findCommentBlock(editor: LexicalEditor, anchor: CommentAnchor): HTMLElement | null {
  const key = editor.read(() => {
    const byId = anchor.blockId ? $findBlockById(anchor.blockId) : null;
    if (byId) return byId.getKey();
    const atPath = $blockAtPath(anchor.path);
    if (atPath && (!anchor.quote || commentQuote(atPath.getTextContent()).includes(anchor.quote))) return atPath.getKey();
    return anchor.quote ? $firstBlockWith(anchor.quote)?.getKey() ?? null : null;
  });
  return key ? editor.getElementByKey(key) : null;
}
