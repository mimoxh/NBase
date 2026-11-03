import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { $applyNodeReplacement, $getNodeByKey, $getSelection, $isRangeSelection, createCommand, DecoratorNode } from 'lexical';
import type { LexicalCommand, LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import { $insertNodeToNearestRoot } from '@lexical/utils';
import katex from 'katex';
import { $createParagraphNode, $getRoot } from 'lexical';

export const OPEN_EQUATION_EDITOR_COMMAND: LexicalCommand<NodeKey> = createCommand('OPEN_EQUATION_EDITOR');

export type SerializedEquationNode = Spread<{
  equation: string;
  inline: boolean;
}, SerializedLexicalNode>;

export const KATEX_OPTIONS = {
  throwOnError: true, trust: false, output: 'htmlAndMathml',
  maxExpand: 1000, maxSize: 50, strict: 'ignore',
} as const;

/** Runtime-only requests to open the equation editor; never serialized. */
const editRequests = new Set<NodeKey>();
export function $requestEquationEdit(node: EquationNode): void {
  editRequests.add(node.getKey());
}
export function consumeEquationEditRequests(): NodeKey[] {
  const keys = [...editRequests];
  editRequests.clear();
  return keys;
}

function EquationView({ editor, nodeKey, equation, inline }: {
  editor: LexicalEditor; nodeKey: NodeKey; equation: string; inline: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Keep the host element's data-equation in sync (findText queries it);
    // the createDOM attribute alone goes stale after setEquation.
    element.closest<HTMLElement>('.nbase-equation-node')?.setAttribute('data-equation', equation);
    element.classList.remove('nbase-equation-error');
    element.removeAttribute('title');
    if (!equation.trim()) { element.textContent = '空公式'; element.classList.add('nbase-equation-empty'); return; }
    element.classList.remove('nbase-equation-empty');
    try {
      katex.render(equation, element, { ...KATEX_OPTIONS, displayMode: !inline });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      element.textContent = equation;
      element.classList.add('nbase-equation-error');
      element.title = message;
    }
  }, [equation, inline]);
  return <span ref={ref} className="nbase-equation-render" role="img" aria-label={equation ? `公式 ${equation}` : '空公式'}
    onMouseDown={event => {
      if (!editor.isEditable()) return;
      event.preventDefault();
      editor.dispatchCommand(OPEN_EQUATION_EDITOR_COMMAND, nodeKey);
    }} />;
}

export class EquationNode extends DecoratorNode<ReactNode> {
  __equation: string;
  __inline: boolean;

  static getType(): string { return 'equation'; }
  static clone(node: EquationNode): EquationNode {
    return new EquationNode(node.__equation, node.__inline, node.__key);
  }
  constructor(equation = '', inline = false, key?: NodeKey) {
    super(key);
    this.__equation = equation;
    this.__inline = inline;
  }
  static importJSON(value: SerializedEquationNode): EquationNode {
    return $createEquationNode(value.equation, value.inline);
  }
  exportJSON(): SerializedEquationNode {
    return { type: 'equation', version: 1, equation: this.getLatest().__equation, inline: this.getLatest().__inline };
  }
  createDOM(): HTMLElement {
    const element = document.createElement(this.getLatest().__inline ? 'span' : 'div');
    element.className = this.getLatest().__inline ? 'nbase-equation-node nbase-equation-inline' : 'nbase-equation-node nbase-equation-block';
    element.dataset.equation = this.getLatest().__equation;
    return element;
  }
  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    if (prevNode.__inline !== this.__inline) return true;
    dom.dataset.equation = this.__equation;
    return false;
  }
  isInline(): boolean { return this.getLatest().__inline; }
  getTextContent(): string { return this.getLatest().__equation; }
  getEquation(): string { return this.getLatest().__equation; }
  setEquation(equation: string): this {
    const writable = this.getWritable();
    writable.__equation = equation;
    return writable;
  }
  decorate(editor: LexicalEditor): ReactNode {
    return <EquationView editor={editor} nodeKey={this.getKey()} equation={this.getLatest().__equation} inline={this.getLatest().__inline} />;
  }
}

export function $createEquationNode(equation: string, inline: boolean): EquationNode {
  return $applyNodeReplacement(new EquationNode(equation, inline));
}

export function $isEquationNode(node: unknown): node is EquationNode {
  return node instanceof EquationNode;
}

/** Insert an equation at the selection; block equations always land at root level. */
export function $insertEquationNode(equation: string, inline: boolean): EquationNode {
  const node = $createEquationNode(equation, inline);
  const selection = $getSelection();
  if (inline && $isRangeSelection(selection)) selection.insertNodes([node]);
  else if (inline) $getRoot().append($createParagraphNode().append(node));
  else { $insertNodeToNearestRoot(node); node.selectNext(); }
  return node;
}

export function $getEquationNodeByKey(key: NodeKey): EquationNode | null {
  const node = $getNodeByKey(key);
  return $isEquationNode(node) ? node : null;
}
