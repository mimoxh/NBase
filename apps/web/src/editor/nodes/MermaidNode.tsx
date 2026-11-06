import { useState, type ReactNode } from 'react';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $applyNodeReplacement, createCommand, DecoratorNode } from 'lexical';
import type { DOMExportOutput, LexicalCommand, LexicalEditor, NodeKey, SerializedLexicalNode } from 'lexical';
import { isStoredMermaidSource, type SerializedMermaidNode } from '@nbase/contracts';
import { MermaidCopyButton, MermaidPreview } from '../MermaidPreview';

export const INSERT_MERMAID_COMMAND: LexicalCommand<NodeKey | undefined> = createCommand('INSERT_MERMAID');
export const EDIT_MERMAID_COMMAND: LexicalCommand<NodeKey> = createCommand('EDIT_MERMAID');

function MermaidView({ editor, nodeKey, source }: { editor: LexicalEditor; nodeKey: NodeKey; source: string }) {
  const editable = useLexicalEditable();
  const [preview, setPreview] = useState(false);
  return <div className="nbase-mermaid">
    <div className="nbase-mermaid-actions">
      <strong>Mermaid</strong>
      <button type="button" className="nb-btn" aria-expanded={preview} onClick={() => setPreview(!preview)}>
        {preview ? '关闭预览' : '预览图表'}
      </button>
      {editable && <button type="button" className="nb-btn" onClick={() => editor.dispatchCommand(EDIT_MERMAID_COMMAND, nodeKey)}>编辑图表</button>}
      <MermaidCopyButton source={source} />
    </div>
    <MermaidPreview source={source} requested={preview} />
    <details><summary>图表源码</summary><pre>{source}</pre></details>
  </div>;
}

export class MermaidNode extends DecoratorNode<ReactNode> {
  __source: string;

  static getType(): string { return 'mermaid'; }
  static clone(node: MermaidNode): MermaidNode { return new MermaidNode(node.__source, node.__key); }

  constructor(source = '', key?: NodeKey) {
    super(key);
    this.__source = source;
  }

  static importJSON(value: SerializedLexicalNode & Partial<SerializedMermaidNode>): MermaidNode {
    if (!isStoredMermaidSource(value.source)) throw new Error('无效的 Mermaid 源码。');
    return $createMermaidNode(value.source);
  }

  exportJSON(): SerializedMermaidNode {
    return { type: 'mermaid', version: 1, source: this.getTextContent() };
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'nbase-mermaid-node';
    return element;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('pre');
    element.textContent = this.getTextContent();
    return { element };
  }

  updateDOM(): boolean { return false; }
  isInline(): boolean { return false; }
  getTextContent(): string { return this.getLatest().__source; }
  setSource(source: string): this { const node = this.getWritable(); node.__source = source; return node; }

  decorate(editor: LexicalEditor): ReactNode {
    return <MermaidView editor={editor} nodeKey={this.getKey()} source={this.getTextContent()} />;
  }
}

export function $createMermaidNode(source: string): MermaidNode {
  return $applyNodeReplacement(new MermaidNode(source));
}

export function $isMermaidNode(node: unknown): node is MermaidNode {
  return node instanceof MermaidNode;
}
