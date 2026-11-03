import { $applyNodeReplacement, TextNode } from 'lexical';
import type { EditorConfig, NodeKey, SerializedTextNode, Spread } from 'lexical';

type SerializedImageReferenceNode = Spread<{ markdown: string; alt: string }, SerializedTextNode>;

/** A non-loading image reference. Rendering this node never creates an img or fetches a URL. */
export class ImageReferenceNode extends TextNode {
  __markdown: string;
  __alt: string;

  static getType(): string { return 'image-reference'; }
  static clone(node: ImageReferenceNode): ImageReferenceNode {
    return new ImageReferenceNode(node.__markdown, node.__alt, node.__key);
  }
  constructor(markdown = '', alt = '', key?: NodeKey) {
    super(`图片：${alt || '无描述'}（未加载）`, key);
    this.__markdown = markdown;
    this.__alt = alt;
    this.__mode = 1;
  }
  static importJSON(serialized: SerializedImageReferenceNode): ImageReferenceNode {
    return $createImageReferenceNode(serialized.markdown, serialized.alt);
  }
  exportJSON(): SerializedImageReferenceNode {
    return { ...super.exportJSON(), type: 'image-reference', version: 1,
      markdown: this.getLatest().__markdown, alt: this.getLatest().__alt };
  }
  getMarkdown(): string { return this.getLatest().__markdown; }
  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.classList.add('editor-image-reference');
    element.title = '图片引用已保留；不会自动加载外部图片';
    element.setAttribute('aria-label', this.getTextContent());
    return element;
  }
  isTextEntity(): true { return true; }
  canInsertTextBefore(): false { return false; }
  canInsertTextAfter(): false { return false; }
}

export function $createImageReferenceNode(markdown: string, alt: string): ImageReferenceNode {
  return $applyNodeReplacement(new ImageReferenceNode(markdown, alt));
}
