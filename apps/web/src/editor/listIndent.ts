import { $isListItemNode, $isListNode, type ListItemNode } from '@lexical/list';
import { $findMatchingParent } from '@lexical/utils';
import { $getSelection, $isRangeSelection, INDENT_CONTENT_COMMAND, OUTDENT_CONTENT_COMMAND } from 'lexical';
import type { LexicalEditor, LexicalNode } from 'lexical';

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

export type ListIndentResult = 'not-list' | 'blocked' | 'applied';

/**
 * Only list items change: paragraph indentation has no Markdown form, so source
 * editing would refuse it. The first item of a level has no parent to nest under.
 */
export function $changeListIndent(editor: LexicalEditor, delta: 1 | -1): ListIndentResult {
  const items = $selectedListItems();
  if (!items) return 'not-list';
  if (delta > 0) {
    if (!items[0]!.getPreviousSibling() || items.some(item => item.getIndent() >= maxListIndent)) return 'blocked';
    editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
    return 'applied';
  }
  if (items.every(item => item.getIndent() === 0)) return 'blocked';
  editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
  return 'applied';
}
