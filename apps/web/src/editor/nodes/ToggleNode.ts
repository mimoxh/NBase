import { $isHeadingNode, $isQuoteNode } from '@lexical/rich-text';
import { $getTableCellNodeFromLexicalNode } from '@lexical/table';
import {
  $applyNodeReplacement, $createParagraphNode, $findMatchingParent, $getSelection, $isElementNode,
  $isParagraphNode, $isRangeSelection, $isRootOrShadowRoot, ElementNode,
} from 'lexical';
import type { EditorConfig, LexicalEditor, LexicalNode, NodeKey, ParagraphNode, SerializedElementNode } from 'lexical';

/** Collapsed toggles are view state: per editor, never part of the document or its history. */
const collapsed = new WeakMap<LexicalEditor, Set<NodeKey>>();

export function collapsedToggles(editor: LexicalEditor): Set<NodeKey> {
  let keys = collapsed.get(editor);
  if (!keys) collapsed.set(editor, keys = new Set());
  return keys;
}

/** A collapsible block: the first child is the summary line, the rest is the body. */
export class ToggleNode extends ElementNode {
  static getType(): string { return 'toggle'; }
  static clone(node: ToggleNode): ToggleNode { return new ToggleNode(node.__key); }
  static importJSON(serialized: SerializedElementNode): ToggleNode {
    return $createToggleNode().updateFromJSON(serialized);
  }
  // No canBeEmpty override: Lexical resolves a click inside a non-empty-able element to a neighbouring block.
  isShadowRoot(): true { return true; }
  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'nbase-toggle';
    dom.dataset.open = String(!collapsedToggles(editor).has(this.__key));
    return dom;
  }
  updateDOM(): false { return false; }
}

export function $createToggleNode(): ToggleNode {
  return $applyNodeReplacement(new ToggleNode());
}

export function $isToggleNode(node: LexicalNode | null | undefined): node is ToggleNode {
  return node instanceof ToggleNode;
}

export function $toggleForNode(node: LexicalNode): ToggleNode | null {
  return $findMatchingParent(node, $isToggleNode);
}

/** The toggle whose summary line holds `node`, if any. */
export function $toggleOfSummary(node: LexicalNode): ToggleNode | null {
  const block = $findMatchingParent(node, item => $isToggleNode(item.getParent()));
  const toggle = block?.getParent();
  return $isToggleNode(toggle) && toggle.getFirstChild()?.is(block) ? toggle : null;
}

/** Keeps the summary a plain, unaligned paragraph; called from a node transform. */
export function $normalizeToggle(toggle: ToggleNode): void {
  const first = toggle.getFirstChild();
  if (!$isParagraphNode(first)) {
    const summary = $createParagraphNode();
    if (first && ($isHeadingNode(first) || $isQuoteNode(first))) {
      summary.append(...first.getChildren());
      first.replace(summary);
    } else if (first) first.insertBefore(summary);
    else toggle.append(summary);
  } else if (first.getFormatType() !== '') first.setFormat('');
}

/** Turns the current paragraph into a toggle summary, or inserts an empty toggle after other blocks. */
export function $applyToggle(): ToggleNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const block = $findMatchingParent(selection.anchor.getNode(), node => $isRootOrShadowRoot(node.getParent()));
  // Table cells are shadow roots too, and a toggle cannot be expressed inside a table.
  if (!block || $getTableCellNodeFromLexicalNode(block)) return null;
  const toggle = $createToggleNode();
  let summary: ParagraphNode;
  if ($isParagraphNode(block)) {
    block.insertBefore(toggle);
    summary = block;
  } else {
    block.insertAfter(toggle);
    summary = $createParagraphNode();
  }
  // Only the summary: an empty body line would catch the caret while the summary is still empty.
  toggle.append(summary);
  summary.setFormat('');
  summary.selectEnd();
  return toggle;
}

export function $unwrapToggle(toggle: ToggleNode): void {
  const first = toggle.getFirstChild();
  for (const child of toggle.getChildren()) toggle.insertBefore(child);
  toggle.remove();
  if ($isElementNode(first)) first.selectStart();
}
