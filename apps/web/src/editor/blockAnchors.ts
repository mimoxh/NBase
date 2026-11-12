import { blockIdKey, isBlockId } from '@nbase/contracts';
import { $getRoot, $getState, $isElementNode, $setState, createState } from 'lexical';
import type { ElementNode, LexicalNode } from 'lexical';

/** A block's persistent anchor for block references; never derived from runtime node keys. */
export const blockIdState = createState(blockIdKey, { parse: value => isBlockId(value) ? value : null });

export function $blockIdOf(node: LexicalNode): string | null {
  return $isElementNode(node) ? $getState(node, blockIdState) : null;
}

export function newBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(byte => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
}

/** Returns the block's anchor, assigning one (an ordinary, undoable edit) the first time. */
export function $ensureBlockId(block: ElementNode): string {
  const existing = $blockIdOf(block);
  if (existing) return existing;
  const id = newBlockId();
  $setState(block, blockIdState, id);
  return id;
}

export function $findBlockById(id: string): ElementNode | null {
  const visit = (node: LexicalNode): ElementNode | null => {
    if (!$isElementNode(node)) return null;
    if ($blockIdOf(node) === id) return node;
    for (const child of node.getChildren()) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit($getRoot());
}

type Json = { $?: Record<string, unknown>; children?: Json[]; text?: unknown; label?: unknown; type?: unknown };

/** Visible text of an anchored block in saved content, for showing a reference's current wording. */
export function blockTextFromContent(root: unknown, id: string): string | null {
  const text = (node: Json): string => (typeof node.text === 'string' ? node.text : typeof node.label === 'string' ? node.label : '')
    + (node.children ?? []).map(text).join('');
  const find = (node: Json): string | null => {
    if (node.$?.[blockIdKey] === id) return text(node).replace(/\s+/g, ' ').trim();
    for (const child of node.children ?? []) {
      const found = find(child);
      if (found !== null) return found;
    }
    return null;
  };
  return root && typeof root === 'object' ? find(root as Json) : null;
}

/** A pending jump survives the page switch that a click on a reference to another page causes. */
let pendingJump: { pageId: string; blockId: string } | null = null;
export function requestBlockJump(pageId: string, blockId: string): void { pendingJump = { pageId, blockId }; }
export function takeBlockJump(pageId: string): string | null {
  if (pendingJump?.pageId !== pageId) return null;
  const { blockId } = pendingJump;
  pendingJump = null;
  return blockId;
}
