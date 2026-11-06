import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $applyNodeReplacement, createCommand, DecoratorNode, type LexicalEditor, type NodeKey, type SerializedLexicalNode } from 'lexical';
import { pageIdFromReferenceUrl, pageReferenceLabelLimit, pageReferenceUrl } from '@nbase/contracts';
import type { PageSummary, SerializedPageReference } from '@nbase/contracts';
import { buildPageReferenceCatalog, type PageReferenceCatalog } from '../pageReferenceCatalog';

type References = { pages: readonly PageSummary[]; open: (pageId: string) => void };
const PageReferencesContext = createContext<{ catalog: PageReferenceCatalog; open: References['open'] } | null>(null);

export function PageReferencesProvider({ references, children }: { references: References | undefined; children: ReactNode }) {
  const pages = references?.pages;
  const open = references?.open;
  const catalog = useMemo(() => pages ? buildPageReferenceCatalog(pages) : null, [pages]);
  return <PageReferencesContext.Provider value={useMemo(() => catalog && open ? { catalog, open } : null, [catalog, open])}>
    {children}
  </PageReferencesContext.Provider>;
}

export function usePageReferences() { return useContext(PageReferencesContext); }

export const EDIT_PAGE_REFERENCE_COMMAND = createCommand<NodeKey>('EDIT_PAGE_REFERENCE');

export function isPageReferenceLabel(label: unknown): label is string {
  return typeof label === 'string' && label.length <= pageReferenceLabelLimit && !!label.trim()
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(label);
}

function PageReferenceView({ editor, nodeKey, targetPageId, label }: {
  editor: LexicalEditor; nodeKey: NodeKey; targetPageId: string; label: string;
}) {
  const references = usePageReferences();
  const editable = useLexicalEditable();
  const broken = references !== null && !references.catalog.activeIds.has(targetPageId);
  return <>
    {broken
      ? <span className="nbase-page-reference-broken" role="link" aria-disabled="true" title="目标页面已删除或不可访问">{label}</span>
      : <a className="nbase-link" href={pageReferenceUrl(targetPageId)} onClick={event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !references) return;
        event.preventDefault();
        references.open(targetPageId);
      }}>{label}</a>}
    {editable && references && <button type="button" className="nbase-page-reference-edit" aria-label="编辑页面引用文字"
      title="编辑页面引用文字" onMouseDown={event => event.preventDefault()} onClick={() => editor.dispatchCommand(EDIT_PAGE_REFERENCE_COMMAND, nodeKey)} />}
  </>;
}

export class PageReferenceNode extends DecoratorNode<ReactNode> {
  __targetPageId: string;
  __label: string;

  static getType(): string { return 'page-reference'; }
  static clone(node: PageReferenceNode): PageReferenceNode {
    return new PageReferenceNode(node.__targetPageId, node.__label, node.__key);
  }
  constructor(targetPageId = '', label = '', key?: NodeKey) {
    super(key);
    this.__targetPageId = targetPageId;
    this.__label = label;
  }
  static importJSON(value: SerializedLexicalNode & { targetPageId?: unknown; label?: unknown }): PageReferenceNode {
    const target = typeof value.targetPageId === 'string' ? pageIdFromReferenceUrl('/?page=' + value.targetPageId) : null;
    if (!target || !isPageReferenceLabel(value.label)) throw new Error('页面引用数据无效');
    return $createPageReferenceNode(target, value.label);
  }
  exportJSON(): SerializedPageReference {
    return { type: 'page-reference', version: 1, targetPageId: this.getTargetPageId(), label: this.getTextContent() };
  }
  getTargetPageId(): string { return this.getLatest().__targetPageId; }
  getTextContent(): string { return this.getLatest().__label; }
  setLabel(label: string): void { this.getWritable().__label = label; }
  createDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'nbase-page-reference';
    element.dataset.nbasePageReference = this.getTargetPageId();
    return element;
  }
  updateDOM(): false { return false; }
  exportDOM() {
    const element = document.createElement('a');
    element.setAttribute('href', pageReferenceUrl(this.getTargetPageId()));
    element.textContent = this.getTextContent();
    return { element };
  }
  decorate(editor: LexicalEditor): ReactNode {
    return <PageReferenceView editor={editor} nodeKey={this.getKey()} targetPageId={this.getTargetPageId()} label={this.getTextContent()} />;
  }
}

export function $createPageReferenceNode(targetPageId: string, label: string): PageReferenceNode {
  return $applyNodeReplacement(new PageReferenceNode(targetPageId, label));
}

export function $isPageReferenceNode(node: unknown): node is PageReferenceNode {
  return node instanceof PageReferenceNode;
}
