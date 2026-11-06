import { isCalloutKind, isCalloutTitle, type CalloutKind } from '@nbase/contracts';
import { $isQuoteNode } from '@lexical/rich-text';
import {
  $applyNodeReplacement, $createParagraphNode, $createTextNode, $findMatchingParent,
  $getSelection, $isElementNode, $isParagraphNode, $isRangeSelection, ElementNode,
} from 'lexical';
import type { LexicalNode, NodeKey, SerializedElementNode } from 'lexical';

type SerializedCalloutNode = SerializedElementNode & { kind: CalloutKind; title: string };

export const calloutLabels: Record<CalloutKind, string> = {
  NOTE: '备注', WARNING: '注意', IMPORTANT: '结论',
};

function renderLabel(dom: HTMLElement, kind: CalloutKind, title: string): void {
  const label = title ? `${calloutLabels[kind]} · ${title}` : calloutLabels[kind];
  dom.dataset.calloutKind = kind;
  dom.dataset.calloutLabel = label;
  dom.setAttribute('aria-label', label);
}

export class CalloutNode extends ElementNode {
  __kind: CalloutKind;
  __title: string;

  static getType(): string { return 'callout'; }
  static clone(node: CalloutNode): CalloutNode {
    return new CalloutNode(node.__kind, node.__title, node.__key);
  }
  constructor(kind: CalloutKind = 'NOTE', title = '', key?: NodeKey) {
    super(key);
    this.__kind = kind;
    this.__title = title;
  }
  static importJSON(serialized: SerializedCalloutNode): CalloutNode {
    if (!isCalloutKind(serialized.kind) || !isCalloutTitle(serialized.title)) throw new Error('提示块数据无效');
    return $createCalloutNode(serialized.kind, serialized.title).updateFromJSON(serialized);
  }
  exportJSON(): SerializedCalloutNode {
    return { ...super.exportJSON(), kind: this.getKind(), title: this.getTitle() };
  }
  isShadowRoot(): true { return true; }
  createDOM(): HTMLElement {
    const dom = document.createElement('aside');
    dom.className = 'nbase-callout';
    renderLabel(dom, this.getKind(), this.getTitle());
    return dom;
  }
  updateDOM(previous: CalloutNode, dom: HTMLElement): false {
    if (previous.__kind !== this.__kind || previous.__title !== this.__title) {
      renderLabel(dom, this.__kind, this.__title);
    }
    return false;
  }
  getKind(): CalloutKind { return this.getLatest().__kind; }
  setKind(kind: CalloutKind): void { this.getWritable().__kind = kind; }
  getTitle(): string { return this.getLatest().__title; }
  setTitle(title: string): void { this.getWritable().__title = title; }
}

export function $createCalloutNode(kind: CalloutKind, title = ''): CalloutNode {
  return $applyNodeReplacement(new CalloutNode(kind, title));
}

export function $isCalloutNode(node: LexicalNode | null | undefined): node is CalloutNode {
  return node instanceof CalloutNode;
}

export function $calloutForNode(node: LexicalNode): CalloutNode | null {
  return $findMatchingParent(node, $isCalloutNode);
}

/** Wrap a paragraph or quote in place, or insert an empty block after other block types. */
export function $applyCallout(kind: CalloutKind): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const existing = $calloutForNode(anchor);
  if (existing) {
    existing.setKind(kind);
    return;
  }
  const block = anchor.getTopLevelElement();
  if (!block) return;

  const callout = $createCalloutNode(kind);
  if ($isParagraphNode(block)) {
    block.insertBefore(callout);
    callout.append(block);
  } else if ($isQuoteNode(block)) {
    block.insertBefore(callout);
    if (block.isShadowRoot()) callout.append(...block.getChildren());
    else callout.append($createParagraphNode().append(...block.getChildren()));
    block.remove();
  } else {
    block.insertAfter(callout);
    callout.append($createParagraphNode());
  }
  if (callout.isEmpty()) callout.append($createParagraphNode());
  callout.selectEnd();
}

export function $unwrapCallout(callout: CalloutNode): void {
  const title = callout.getTitle();
  if (title) callout.insertBefore($createParagraphNode().append($createTextNode(title)));
  if (callout.isEmpty()) callout.append($createParagraphNode());
  const last = callout.getLastChild();
  for (const child of callout.getChildren()) callout.insertBefore(child);
  if ($isElementNode(last)) last.selectEnd();
  else last?.selectNext();
  callout.remove();
}
