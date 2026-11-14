import type { ReactNode } from 'react';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $applyNodeReplacement, $getNodeByKey, createCommand, DecoratorNode } from 'lexical';
import type { DOMExportOutput, LexicalCommand, LexicalEditor, NodeKey, SerializedLexicalNode } from 'lexical';
import { isSerializedWhiteboardView, pageReferenceUrl, type SerializedWhiteboardView } from '@nbase/contracts';
import { WhiteboardEmbed } from '../../embed/WhiteboardEmbed';
import { useIsolatedFromEditor } from './DatabaseViewNode';

export const INSERT_WHITEBOARD_VIEW_COMMAND: LexicalCommand<{ pageId: string }> = createCommand('INSERT_WHITEBOARD_VIEW');
/** `new` creates a whiteboard first; `link` lets the person pick one. */
export const REQUEST_WHITEBOARD_VIEW_COMMAND: LexicalCommand<'new' | 'link'> = createCommand('REQUEST_WHITEBOARD_VIEW');

const markdownLabel = '白板';

/** Markdown form: a link on its own line, so other tools still show where the board lives. */
export function whiteboardViewMarkdown(pageId: string, height: number | null): string {
  return `[${markdownLabel}](${pageReferenceUrl(pageId)}#nbase-whiteboard-view${height ? `=${height}` : ''})`;
}
export const whiteboardViewMarkdownPattern =
  /^\[白板\]\(\/\?page=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#nbase-whiteboard-view(?:=(\d{3,4}))?\)\s*$/;

function WhiteboardViewBlock({ editor, nodeKey, pageId, height }: {
  editor: LexicalEditor; nodeKey: NodeKey; pageId: string; height: number | null;
}) {
  const editable = useLexicalEditable();
  const isolated = useIsolatedFromEditor();
  const remove = () => editor.update(() => { $getNodeByKey(nodeKey)?.remove(); });
  const setHeight = (next: number) => editor.update(() => {
    const node = $getNodeByKey(nodeKey);
    if ($isWhiteboardViewNode(node) && node.getHeight() !== next) node.setHeight(next);
  });
  return <div className="nbase-whiteboard-block" ref={isolated}>
    <WhiteboardEmbed pageId={pageId} editable={editable} height={height ?? undefined} onHeight={editable ? setHeight : undefined}
      actions={editable && <button type="button" className="nb-btn nb-btn-quiet" onClick={remove}>从正文移除</button>} />
  </div>;
}

/**
 * A whiteboard inside a document. It stores only the page id and the block height; the board
 * stays in its own page, so drawing here never changes the document's revision.
 */
export class WhiteboardViewNode extends DecoratorNode<ReactNode> {
  __pageId: string;
  __height: number | null;

  static getType(): string { return 'whiteboard-view'; }
  static clone(node: WhiteboardViewNode): WhiteboardViewNode {
    return new WhiteboardViewNode(node.__pageId, node.__height, node.__key);
  }

  constructor(pageId = '', height: number | null = null, key?: NodeKey) {
    super(key);
    this.__pageId = pageId;
    this.__height = height;
  }

  static importJSON(value: SerializedLexicalNode & Partial<SerializedWhiteboardView>): WhiteboardViewNode {
    const candidate = { type: value.type, version: value.version, pageId: value.pageId,
      ...(value.height === undefined ? {} : { height: value.height }) };
    if (!isSerializedWhiteboardView(candidate)) throw new Error('无效的白板嵌入。');
    return $createWhiteboardViewNode(candidate.pageId, candidate.height ?? null);
  }

  exportJSON(): SerializedWhiteboardView {
    const height = this.getHeight();
    return { type: 'whiteboard-view', version: 1, pageId: this.getPageId(), ...(height === null ? {} : { height }) };
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'nbase-whiteboard-node';
    // Backlinks count this block like a page reference, so it carries the same marker.
    element.dataset.nbasePageReference = this.__pageId;
    return element;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('a');
    element.href = pageReferenceUrl(this.getPageId());
    element.textContent = markdownLabel;
    return { element };
  }

  updateDOM(): boolean { return false; }
  isInline(): boolean { return false; }
  getTextContent(): string { return ''; }
  getPageId(): string { return this.getLatest().__pageId; }
  getHeight(): number | null { return this.getLatest().__height; }
  setHeight(height: number | null): this { const node = this.getWritable(); node.__height = height; return node; }

  decorate(editor: LexicalEditor): ReactNode {
    return <WhiteboardViewBlock editor={editor} nodeKey={this.getKey()} pageId={this.getPageId()} height={this.getHeight()} />;
  }
}

export function $createWhiteboardViewNode(pageId: string, height: number | null = null): WhiteboardViewNode {
  return $applyNodeReplacement(new WhiteboardViewNode(pageId.toLowerCase(), height));
}

export function $isWhiteboardViewNode(node: unknown): node is WhiteboardViewNode {
  return node instanceof WhiteboardViewNode;
}
