import { $generateNodesFromSerializedNodes } from '@lexical/clipboard';
import { $isCodeNode } from '@lexical/code';
import { $isListNode } from '@lexical/list';
import { $isHeadingNode, $isQuoteNode } from '@lexical/rich-text';
import { blockIdKey, quickCaptureMarker } from '@nbase/contracts';
import { $createParagraphNode, $getRoot, $isElementNode, $isParagraphNode, $isRootNode } from 'lexical';
import type { LexicalNode, SerializedLexicalNode } from 'lexical';
import { $isFootnoteDefinitionNode } from './nodes/FootnoteNodes';

export type BlockPlacement = 'before' | 'after';

type SerializedBlock = SerializedLexicalNode & {
  children?: SerializedBlock[];
  $?: Record<string, unknown>;
};

/** The direct child of the root that holds `node`. */
export function $topLevelBlock(node: LexicalNode): LexicalNode | null {
  for (let current: LexicalNode | null = node; current; current = current.getParent()) {
    if ($isRootNode(current.getParent())) return current;
  }
  return null;
}

export function $moveBlockTo(block: LexicalNode, target: LexicalNode, placement: BlockPlacement): boolean {
  if (block.is(target)) return false;
  const neighbour = placement === 'before' ? target.getPreviousSibling() : target.getNextSibling();
  if (block.is(neighbour)) return false;
  if (placement === 'before') target.insertBefore(block);
  else target.insertAfter(block);
  return true;
}

/** Moves past the nearest sibling that `visible` accepts, so folded sections count as one step. */
export function $moveBlockBy(block: LexicalNode, direction: -1 | 1, visible: (node: LexicalNode) => boolean = () => true): boolean {
  const step = (node: LexicalNode) => direction < 0 ? node.getPreviousSibling() : node.getNextSibling();
  let target = step(block);
  while (target && !visible(target)) target = step(target);
  return target ? $moveBlockTo(block, target, direction < 0 ? 'before' : 'after') : false;
}

function serialized(node: LexicalNode): SerializedBlock {
  const value = node.exportJSON() as SerializedBlock;
  // A quick-capture marker locates exactly one heading, so a copy must not carry it.
  if (value.$) {
    // Nor may a copy carry the original's block anchor, which references point at.
    const { [quickCaptureMarker]: _marker, [blockIdKey]: _anchor, ...state } = value.$;
    if (Object.keys(state).length) value.$ = state;
    else delete value.$;
  }
  return $isElementNode(node) ? { ...value, children: node.getChildren().map(serialized) } : value;
}

function $containsFootnoteDefinition(node: LexicalNode): boolean {
  return $isFootnoteDefinitionNode(node)
    || ($isElementNode(node) && node.getChildren().some($containsFootnoteDefinition));
}

/** Footnote identifiers are unique in a page, so a definition cannot be copied. */
export function $canDuplicateBlock(block: LexicalNode): boolean {
  return !$containsFootnoteDefinition(block);
}

export function $duplicateBlock(block: LexicalNode): LexicalNode | null {
  if (!$canDuplicateBlock(block)) return null;
  const [copy] = $generateNodesFromSerializedNodes([serialized(block)]);
  if (!copy) return null;
  block.insertAfter(copy);
  return copy;
}

export function $deleteBlock(block: LexicalNode): void {
  block.remove();
  const root = $getRoot();
  if (root.isEmpty()) root.append($createParagraphNode()).selectEnd();
}

export function $canConvertBlock(block: LexicalNode): boolean {
  return $isParagraphNode(block) || $isHeadingNode(block) || $isQuoteNode(block) || $isListNode(block) || $isCodeNode(block);
}

/** Selects the whole block, so a style change reaches every item of a list. */
export function $selectWholeBlock(block: LexicalNode): void {
  if (!$isElementNode(block)) return;
  const { key, offset, type } = block.selectStart().anchor;
  block.selectEnd().anchor.set(key, offset, type);
}
