import type { ReactNode } from 'react';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { $applyNodeReplacement, DecoratorNode, createCommand } from 'lexical';
import type { LexicalCommand, LexicalNode, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import { isSerializedBookmark, type LinkPreview } from '@nbase/contracts';

export type SerializedBookmarkNode = Spread<LinkPreview, SerializedLexicalNode>;

/** Opens the bookmark URL form; the plugin inserts the card at the saved caret. */
export const REQUEST_BOOKMARK_COMMAND: LexicalCommand<void> = createCommand('NBASE_REQUEST_BOOKMARK');

function BookmarkCard({ nodeKey, preview }: { nodeKey: NodeKey; preview: LinkPreview }) {
  const [selected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const host = (() => { try { return new URL(preview.url).hostname; } catch { return preview.url; } })();
  // The card never loads remote favicons or images; it only links to the page.
  return <div className={`nbase-bookmark${selected ? ' is-selected' : ''}`} contentEditable={false}
    data-bookmark-label={[preview.title, preview.description, preview.siteName].join(' ')}
    onClick={event => {
      if ((event.target as HTMLElement).closest('a')) return;
      clearSelection(); setSelected(true);
    }}>
    <a href={preview.url} target="_blank" rel="noopener noreferrer nofollow" className="nbase-bookmark-link">
      <span className="nbase-bookmark-title">{preview.title || host}</span>
      {preview.description && <span className="nbase-bookmark-description">{preview.description}</span>}
      <span className="nbase-bookmark-site"><span aria-hidden="true">🔗</span>{preview.siteName || host}<span className="nbase-bookmark-url">{preview.url}</span></span>
    </a>
  </div>;
}

export class BookmarkNode extends DecoratorNode<ReactNode> {
  __preview: LinkPreview;
  static getType(): string { return 'bookmark'; }
  static clone(node: BookmarkNode): BookmarkNode { return new BookmarkNode(node.__preview, node.__key); }
  constructor(preview: LinkPreview, key?: NodeKey) { super(key); this.__preview = preview; }
  static importJSON(serialized: SerializedLexicalNode & Partial<LinkPreview>): BookmarkNode {
    if (!isSerializedBookmark(serialized as unknown as Record<string, unknown>)) throw new Error('网页书签数据无效');
    const { url = '', title = '', description = '', siteName = '' } = serialized;
    return $createBookmarkNode({ url, title, description, siteName });
  }
  exportJSON(): SerializedBookmarkNode {
    return { type: 'bookmark', version: 1, ...this.getPreview() };
  }
  createDOM(): HTMLElement { const element = document.createElement('div'); element.className = 'nbase-bookmark-block'; return element; }
  updateDOM(): false { return false; }
  isInline(): false { return false; }
  getPreview(): LinkPreview { return this.getLatest().__preview; }
  getTextContent(): string { return this.getPreview().title + '\n'; }
  decorate(): ReactNode { return <BookmarkCard nodeKey={this.__key} preview={this.__preview} />; }
}

export function $createBookmarkNode(preview: LinkPreview): BookmarkNode {
  return $applyNodeReplacement(new BookmarkNode(preview));
}

export function $isBookmarkNode(node: LexicalNode | null | undefined): node is BookmarkNode {
  return node instanceof BookmarkNode;
}
