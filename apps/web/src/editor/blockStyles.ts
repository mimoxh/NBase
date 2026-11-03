import { $createParagraphNode, $getSelection, $isRangeSelection } from 'lexical';
import type { LexicalEditor, LexicalNode } from 'lexical';
import { $createCodeNode } from '@lexical/code';
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { $isListNode, INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND } from '@lexical/list';
import { $setBlocksType } from '@lexical/selection';

function $insideList(node: LexicalNode): boolean {
  for (let current: LexicalNode | null = node; current; current = current.getParent()) {
    if ($isListNode(current)) return true;
  }
  return false;
}

export type BlockStyle = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'quote' | 'code';

export const BLOCK_STYLES: BlockStyle[] = ['paragraph', 'h1', 'h2', 'h3', 'bullet', 'number', 'check', 'quote', 'code'];

/** Shared paragraph-style rules: the toolbar select and the slash menu must behave identically. Call inside editor.update. */
export function $applyBlockStyle(editor: LexicalEditor, value: BlockStyle): void {
  if (value === 'bullet') { editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined); return; }
  if (value === 'number') { editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined); return; }
  if (value === 'check') { editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined); return; }
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  if ($insideList(selection.anchor.getNode())) editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
  const current = $getSelection();
  if (!$isRangeSelection(current)) return;
  if (value === 'h1' || value === 'h2' || value === 'h3') $setBlocksType(current, () => $createHeadingNode(value));
  else if (value === 'quote') $setBlocksType(current, () => $createQuoteNode());
  else if (value === 'code') $setBlocksType(current, () => $createCodeNode());
  else $setBlocksType(current, () => $createParagraphNode());
}
