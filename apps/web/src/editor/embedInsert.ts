import { $createParagraphNode, $getRoot, $getSelection, $isParagraphNode, $isRangeSelection, $isRootNode } from 'lexical';
import type { ElementNode, LexicalNode } from 'lexical';
import { $isCalloutNode } from './nodes/CalloutNode';
import { $isToggleNode } from './nodes/ToggleNode';

/** Embedded databases and whiteboards live at the top level or inside toggles and callouts, at any depth of those. */
function $holdsEmbeds(node: ElementNode | null): boolean {
  if (!node) return false;
  if ($isRootNode(node)) return true;
  return ($isToggleNode(node) || $isCalloutNode(node)) && $holdsEmbeds(node.getParent());
}

/**
 * Places an embed block at the caret: it takes over an empty paragraph (such as the one a slash
 * command was typed in, which Markdown could not keep between blocks), otherwise it goes after
 * the nearest block that sits in a place embeds are allowed in.
 */
export function $insertEmbedBlock(node: LexicalNode): void {
  const selection = $getSelection();
  let block: LexicalNode | null = $isRangeSelection(selection) ? selection.anchor.getNode() : null;
  while (block && !$isRootNode(block) && !$holdsEmbeds(block.getParent())) block = block.getParent();
  if (!block || $isRootNode(block)) $getRoot().append(node);
  else {
    const parent = block.getParent();
    // A toggle's first block is its summary line and has to stay a paragraph.
    const summary = $isToggleNode(parent) && block.getIndexWithinParent() === 0;
    if ($isParagraphNode(block) && block.getChildrenSize() === 0 && !summary) block.replace(node);
    else block.insertAfter(node);
  }
  if (!node.getNextSibling()) node.insertAfter($createParagraphNode());
  node.selectNext();
}
