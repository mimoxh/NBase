import { $isListItemNode, $isListNode, type ListItemNode } from '@lexical/list';
import { $findMatchingParent } from '@lexical/utils';
import { $getSelection, $isRangeSelection, OUTDENT_CONTENT_COMMAND } from 'lexical';
import type { ElementNode, LexicalEditor, LexicalNode } from 'lexical';
import { $alignable } from './textFormatting';

/** Zero-based, so six visible levels; well inside the server's 64-layer depth limit. */
export const maxListIndent = 5;

function $listItemOf(node: LexicalNode): ListItemNode | null {
  return $findMatchingParent(node, $isListItemNode);
}

/** List items carrying the selection, in document order; null unless both ends are in a list. */
export function $selectedListItems(): ListItemNode[] | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  if (!$listItemOf(selection.anchor.getNode()) || !$listItemOf(selection.focus.getNode())) return null;
  const items = new Map<string, ListItemNode>();
  for (const node of selection.getNodes()) {
    const item = $listItemOf(node);
    // A wrapper item only holds a nested list; its children are the real items.
    if (item && !item.getChildren().some($isListNode)) items.set(item.getKey(), item);
  }
  return items.size ? [...items.values()] : null;
}

export type ListIndentResult = 'not-list' | 'blocked' | 'first-item' | 'applied';

/**
 * The first item of a level has no parent to nest under; nesting it anyway would leave an empty
 * bullet that Markdown cannot hold. A selection that includes one still nests the other items.
 */
const $hasParentCandidate = (item: ListItemNode) => item.getPreviousSibling() !== null;

export function $changeListIndent(editor: LexicalEditor, delta: 1 | -1): ListIndentResult {
  const items = $selectedListItems();
  if (!items) return 'not-list';
  if (delta > 0) {
    if (!items.some($hasParentCandidate)) return 'first-item';
    if (items.some(item => item.getIndent() >= maxListIndent)) return 'blocked';
    // Checked item by item in document order: a parent nested a moment ago becomes the previous
    // sibling of its own first child, which can then follow it.
    for (const item of items) if ($hasParentCandidate(item)) item.setIndent(item.getIndent() + 1);
    return 'applied';
  }
  if (items.every(item => item.getIndent() === 0)) return 'blocked';
  editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
  return 'applied';
}


/** Paragraph and heading levels; exported as `<div style="margin-left:…em">`, 2em per level. */
export const maxBlockIndent = 5;

/** Paragraphs and headings carrying the selection, the same blocks that take an alignment. */
export function $selectedIndentBlocks(): ElementNode[] | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const blocks = new Map<string, ElementNode>();
  for (const node of [selection.anchor.getNode(), ...selection.getNodes()]) {
    const block = $alignable(node);
    if (block) blocks.set(block.getKey(), block);
  }
  return blocks.size ? [...blocks.values()] : null;
}

export type IndentResult = 'none' | 'blocked' | 'first-item' | 'applied';

/** Whether Tab would change anything; mirrors the limits in `$changeIndent`. */
export function $canIncreaseIndent(): boolean {
  const items = $selectedListItems();
  if (items) return items.some($hasParentCandidate) && items.every(item => item.getIndent() < maxListIndent);
  const blocks = $selectedIndentBlocks();
  return blocks !== null && blocks.every(block => block.getIndent() < maxBlockIndent);
}

/** List items nest under the previous item; paragraphs and headings shift by one level. */
export function $changeIndent(editor: LexicalEditor, delta: 1 | -1): IndentResult {
  const list = $changeListIndent(editor, delta);
  if (list !== 'not-list') return list;
  const blocks = $selectedIndentBlocks();
  if (!blocks) return 'none';
  if (delta > 0 ? blocks.some(block => block.getIndent() >= maxBlockIndent) : blocks.every(block => block.getIndent() === 0)) return 'blocked';
  for (const block of blocks) block.setIndent(Math.min(maxBlockIndent, Math.max(0, block.getIndent() + delta)));
  return 'applied';
}
