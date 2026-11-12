import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { $applyNodeReplacement, createCommand, DecoratorNode } from 'lexical';
import type { LexicalCommand, LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode } from 'lexical';
import { blockReferenceUrl, isSerializedBlockReference, type SerializedBlockReference } from '@nbase/contracts';
import { usePageReferences } from './PageReferenceNode';
import { requestBlockJump } from '../blockAnchors';

/** Reads a block's current text from its saved page; null when the block no longer exists. */
export type BlockResolver = (pageId: string, blockId: string) => Promise<string | null>;
export const BlockResolverContext = createContext<{ documentId: string; resolve?: BlockResolver | undefined } | null>(null);

/** Scrolls the open editor to an anchored block, or reports that it is missing. */
export const JUMP_TO_BLOCK_COMMAND: LexicalCommand<string> = createCommand('NBASE_JUMP_TO_BLOCK');

function BlockReferenceView({ editor, targetPageId, blockId, label }: { editor: LexicalEditor; targetPageId: string; blockId: string; label: string }) {
  const references = usePageReferences();
  const context = useContext(BlockResolverContext);
  const [live, setLive] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!context?.resolve) return;
    let current = true;
    context.resolve(targetPageId, blockId).then(text => { if (current) setLive(text); }, () => undefined);
    return () => { current = false; };
  }, [blockId, context, targetPageId]);
  const pageMissing = references !== null && !references.catalog.activeIds.has(targetPageId);
  const missing = pageMissing || live === null;
  const text = live ? (live.length > 80 ? live.slice(0, 80) + '…' : live) : label;
  const open = () => {
    if (context?.documentId === targetPageId) { editor.dispatchCommand(JUMP_TO_BLOCK_COMMAND, blockId); return; }
    if (!references) return;
    requestBlockJump(targetPageId, blockId);
    references.open(targetPageId);
  };
  return <a className={`nbase-block-reference${missing ? ' is-missing' : ''}`} href={blockReferenceUrl(targetPageId, blockId)}
    title={missing ? '引用的块已删除或不可访问，显示的是引用时的文字' : '块引用：' + (live ?? label)}
    onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!missing) open();
    }}>{text}</a>;
}

export class BlockReferenceNode extends DecoratorNode<ReactNode> {
  __targetPageId: string;
  __blockId: string;
  __label: string;
  static getType(): string { return 'block-reference'; }
  static clone(node: BlockReferenceNode): BlockReferenceNode {
    return new BlockReferenceNode(node.__targetPageId, node.__blockId, node.__label, node.__key);
  }
  constructor(targetPageId = '', blockId = '', label = '', key?: NodeKey) {
    super(key);
    this.__targetPageId = targetPageId; this.__blockId = blockId; this.__label = label;
  }
  static importJSON(value: SerializedLexicalNode & Partial<SerializedBlockReference>): BlockReferenceNode {
    if (!isSerializedBlockReference(value as unknown as Record<string, unknown>)) throw new Error('块引用数据无效');
    return $createBlockReferenceNode(value.targetPageId!, value.blockId!, value.label!);
  }
  exportJSON(): SerializedBlockReference {
    const self = this.getLatest();
    return { type: 'block-reference', version: 1, targetPageId: self.__targetPageId, blockId: self.__blockId, label: self.__label };
  }
  isInline(): true { return true; }
  getTargetPageId(): string { return this.getLatest().__targetPageId; }
  getBlockId(): string { return this.getLatest().__blockId; }
  getTextContent(): string { return this.getLatest().__label; }
  createDOM(): HTMLElement {
    const element = document.createElement('span');
    // Shares the page-reference marker so backlink jumps count occurrences in document order.
    element.dataset.nbasePageReference = this.__targetPageId;
    return element;
  }
  updateDOM(): false { return false; }
  decorate(editor: LexicalEditor): ReactNode {
    return <BlockReferenceView editor={editor} targetPageId={this.__targetPageId} blockId={this.__blockId} label={this.__label} />;
  }
}

export function $createBlockReferenceNode(targetPageId: string, blockId: string, label: string): BlockReferenceNode {
  return $applyNodeReplacement(new BlockReferenceNode(targetPageId, blockId, label));
}

export function $isBlockReferenceNode(node: LexicalNode | null | undefined): node is BlockReferenceNode {
  return node instanceof BlockReferenceNode;
}
