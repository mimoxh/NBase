import { useEffect, useState, type ReactNode } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { isFootnoteId } from '@nbase/contracts';
import {
  $applyNodeReplacement, COMMAND_PRIORITY_EDITOR, createCommand, DecoratorNode, ElementNode, setDOMUnmanaged,
  type LexicalEditor, type NodeKey, type SerializedElementNode, type SerializedLexicalNode,
} from 'lexical';
import '../footnotes.css';

const revealFootnote = createCommand<HTMLElement>('REVEAL_FOOTNOTE');
const lastReferences = new WeakMap<LexicalEditor, Map<string, HTMLElement>>();

function matchingElements(editor: LexicalEditor, attribute: string, id: string): HTMLElement[] {
  return Array.from(editor.getRootElement()?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? [])
    .filter(element => element.getAttribute(attribute) === id);
}

function jump(editor: LexicalEditor, target: HTMLElement): void {
  editor.dispatchCommand(revealFootnote, target);
  target.scrollIntoView?.({ block: 'nearest' });
  target.focus({ preventScroll: true });
}

export function FootnoteNavigationPlugin({ reveal }: { reveal: (element: HTMLElement) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(revealFootnote, element => {
    reveal(element);
    return true;
  }, COMMAND_PRIORITY_EDITOR), [editor, reveal]);
  return null;
}

function FootnoteReference({ id, editor }: { id: string; editor: LexicalEditor }) {
  const [missing, setMissing] = useState(false);
  return <><button type="button" className="nbase-footnote-reference" data-nbase-footnote-ref={id}
    aria-label={`跳转到脚注 ${id}`} onClick={event => {
      const definitions = matchingElements(editor, 'data-nbase-footnote-definition', id);
      const target = definitions.length === 1 ? definitions[0]?.querySelector<HTMLElement>('[data-nbase-footnote-back]') : null;
      setMissing(!target);
      if (!target) return;
      let references = lastReferences.get(editor);
      if (!references) { references = new Map(); lastReferences.set(editor, references); }
      references.set(id, event.currentTarget);
      jump(editor, target);
    }}>{id}</button>{missing && <span role="status" className="nbase-footnote-status">脚注 {id} 的定义缺失或重复</span>}</>;
}

export class FootnoteReferenceNode extends DecoratorNode<ReactNode> {
  __footnoteId: string;
  static getType(): string { return 'footnote-reference'; }
  static clone(node: FootnoteReferenceNode): FootnoteReferenceNode { return new FootnoteReferenceNode(node.__footnoteId, node.__key); }
  constructor(footnoteId = '', key?: NodeKey) { super(key); this.__footnoteId = footnoteId; }
  static importJSON(value: SerializedLexicalNode & { footnoteId?: unknown }): FootnoteReferenceNode {
    if (!isFootnoteId(value.footnoteId)) throw new Error('脚注引用标识无效');
    return $createFootnoteReferenceNode(value.footnoteId);
  }
  exportJSON() { return { ...super.exportJSON(), footnoteId: this.getFootnoteId() }; }
  getFootnoteId(): string { return this.getLatest().__footnoteId; }
  getTextContent(): string { return `[^${this.getFootnoteId()}]`; }
  createDOM(): HTMLElement { const span = document.createElement('sup'); return span; }
  updateDOM(): false { return false; }
  exportDOM() {
    const element = document.createElement('sup');
    element.textContent = this.getTextContent();
    return { element };
  }
  decorate(editor: LexicalEditor): ReactNode { return <FootnoteReference editor={editor} id={this.getFootnoteId()} />; }
}

export class FootnoteDefinitionNode extends ElementNode {
  __footnoteId: string;
  static getType(): string { return 'footnote-definition'; }
  static clone(node: FootnoteDefinitionNode): FootnoteDefinitionNode { return new FootnoteDefinitionNode(node.__footnoteId, node.__key); }
  constructor(footnoteId = '', key?: NodeKey) { super(key); this.__footnoteId = footnoteId; }
  static importJSON(value: SerializedElementNode & { footnoteId?: unknown }): FootnoteDefinitionNode {
    if (!isFootnoteId(value.footnoteId)) throw new Error('脚注定义标识无效');
    return $createFootnoteDefinitionNode(value.footnoteId).updateFromJSON(value);
  }
  exportJSON() { return { ...super.exportJSON(), footnoteId: this.getFootnoteId() }; }
  getFootnoteId(): string { return this.getLatest().__footnoteId; }
  isShadowRoot(): true { return true; }
  createDOM(_config: unknown, editor: LexicalEditor): HTMLElement {
    const id = this.getFootnoteId();
    const element = document.createElement('aside');
    element.className = 'nbase-footnote-definition';
    element.dataset.nbaseFootnoteDefinition = id;
    const button = document.createElement('button');
    button.type = 'button';
    button.contentEditable = 'false';
    button.dataset.nbaseFootnoteBack = '';
    button.textContent = `脚注 ${id} ↩`;
    button.setAttribute('aria-label', `返回脚注 ${id} 的引用`);
    button.addEventListener('click', () => {
      const root = editor.getRootElement();
      const last = lastReferences.get(editor)?.get(id);
      const target = last && root?.contains(last) ? last : matchingElements(editor, 'data-nbase-footnote-ref', id)[0];
      if (target) jump(editor, target);
    });
    setDOMUnmanaged(button);
    element.append(button);
    return element;
  }
  getDOMSlot(element: HTMLElement) {
    return super.getDOMSlot(element).withAfter(element.querySelector(':scope > [data-nbase-footnote-back]'));
  }
  updateDOM(): false { return false; }
  exportDOM() { return { element: document.createElement('aside') }; }
}

export function $createFootnoteReferenceNode(id: string): FootnoteReferenceNode {
  return $applyNodeReplacement(new FootnoteReferenceNode(id));
}
export function $createFootnoteDefinitionNode(id: string): FootnoteDefinitionNode {
  return $applyNodeReplacement(new FootnoteDefinitionNode(id));
}
export function $isFootnoteReferenceNode(node: unknown): node is FootnoteReferenceNode { return node instanceof FootnoteReferenceNode; }
export function $isFootnoteDefinitionNode(node: unknown): node is FootnoteDefinitionNode { return node instanceof FootnoteDefinitionNode; }
