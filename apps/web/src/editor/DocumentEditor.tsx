import { Component, forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { createEditor, HISTORY_PUSH_TAG } from 'lexical';
import type { HistoryState } from '@lexical/history';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { createEmptyHistoryState, HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { createContentFromMarkdown, isSafeLinkUrl, MARKDOWN_TRANSFORMERS, readEditorSnapshot } from './markdown';
import { EDITOR_NODES } from './nodes';
import type { DocumentEditorHandle, DocumentEditorProps } from './types';
import { ToolbarPlugin } from './plugins/ToolbarPlugin';
import { SafePastePlugin } from './plugins/SafePastePlugin';
import { CodeHighlightPlugin } from './plugins/CodeHighlightPlugin';
import { CodeCopyPlugin } from './plugins/CodeCopyPlugin';
import { BlockContextMenuPlugin } from './plugins/BlockContextMenuPlugin';
import { EquationPlugin } from './plugins/EquationPlugin';
import { SlashCommandPlugin } from './plugins/SlashCommandPlugin';
import { CalloutPlugin } from './plugins/CalloutPlugin';
import { FindReplacePlugin } from './plugins/FindReplacePlugin';
import { SectionFoldingPlugin, type SectionFoldingHandle } from './plugins/SectionFoldingPlugin';
import { PageReferencesProvider } from './nodes/PageReferenceNode';
import { PageReferencePlugin } from './plugins/PageReferencePlugin';
import { MermaidPlugin } from './plugins/MermaidPlugin';
import { DatabaseViewPlugin } from './plugins/DatabaseViewPlugin';
import { DatabaseEmbeddingProvider } from './nodes/DatabaseViewNode';
import { WhiteboardViewPlugin } from './plugins/WhiteboardViewPlugin';
import { EmbeddedPagesProvider, EmbedPathProvider } from '../embed/source';
import { ListIndentPlugin } from './plugins/ListIndentPlugin';
import { LinkInteractionPlugin } from './plugins/LinkInteractionPlugin';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';
import { BlockHandlePlugin } from './plugins/BlockHandlePlugin';
import { WordCountPlugin } from './plugins/WordCountPlugin';
import { ShortcutsPlugin } from './plugins/ShortcutsPlugin';
import { revealInToggles, TogglePlugin } from './plugins/TogglePlugin';
import { TableColumnResizePlugin } from './plugins/TableColumnResizePlugin';
import { BookmarkPlugin } from './plugins/BookmarkPlugin';
import { BlockReferencePlugin } from './plugins/BlockReferencePlugin';
import { BlockResolverContext } from './nodes/BlockReferenceNode';
import { FootnoteNavigationPlugin } from './nodes/FootnoteNodes';
import { $insertAttachments, AttachmentWorkspaceContext } from './nodes/AttachmentNode';
import 'katex/dist/katex.min.css';
import { listTheme } from './listTheme';
import './editor.css';
import './formats.css';

const theme = {
  paragraph: 'nbase-paragraph', quote: 'nbase-quote', link: 'nbase-link',
  heading: { h1: 'nbase-heading-1', h2: 'nbase-heading-2', h3: 'nbase-heading-3' },
  text: { bold: 'nbase-bold', italic: 'nbase-italic', strikethrough: 'nbase-strikethrough', code: 'nbase-inline-code', highlight: 'nbase-highlight' },
  list: listTheme,
  code: 'nbase-code-block', table: 'nbase-table', tableCell: 'nbase-table-cell', tableCellHeader: 'nbase-table-header', tableCellSelected: 'nbase-table-selected', tableSelection: 'nbase-table-selection', tableRow: 'nbase-table-row', hr: 'nbase-rule',
  codeHighlight: {
    atrule: 'nbase-token-attr', attr: 'nbase-token-attr', boolean: 'nbase-token-property', builtin: 'nbase-token-selector',
    cdata: 'nbase-token-comment', char: 'nbase-token-selector', class: 'nbase-token-function', 'class-name': 'nbase-token-function',
    comment: 'nbase-token-comment', constant: 'nbase-token-property', deleted: 'nbase-token-property', doctype: 'nbase-token-comment',
    entity: 'nbase-token-operator', 'env-var': 'nbase-token-variable', environment: 'nbase-token-variable', 'file-descriptor': 'nbase-token-variable',
    function: 'nbase-token-function', important: 'nbase-token-variable', inserted: 'nbase-token-selector',
    keyword: 'nbase-token-attr', namespace: 'nbase-token-variable', number: 'nbase-token-property', operator: 'nbase-token-variable',
    parameter: 'nbase-token-variable', prolog: 'nbase-token-comment', property: 'nbase-token-property', punctuation: 'nbase-token-punctuation',
    regex: 'nbase-token-variable', selector: 'nbase-token-selector', shebang: 'nbase-token-comment', string: 'nbase-token-selector',
    symbol: 'nbase-token-property', tag: 'nbase-token-property', url: 'nbase-token-operator', variable: 'nbase-token-variable',
  },
};

class EditorBoundary extends Component<{ children: ReactNode; original: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="nbase-editor-error" role="alert"><strong>编辑器未能打开此文档。</strong><p>原始内容仍保留在下方，请复制后重试。</p><pre>{this.props.original}</pre></div> : this.props.children;
  }
}

/** Select a visible match without changing Lexical nodes or persisting a search highlight. */
function findVisibleText(root: HTMLElement, phrase: string, reveal: (element: HTMLElement) => void): boolean {
  if (!phrase) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || node.parentElement?.closest('.nbase-attachment-download,.nbase-attachment-loading,.nbase-attachment-error,.nbase-equation-node')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: { node: Text; start: number; end: number }[] = [];
  let joined = '';
  let previousBlock: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const block = node.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th') ?? null;
    if (segments.length && block !== previousBlock) joined += ' ';
    const start = joined.length;
    joined += node.textContent;
    segments.push({ node, start, end: joined.length });
    previousBlock = block;
  }
  const position = joined.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
  if (position >= 0) {
    const first = segments.find(item => item.end > position);
    const last = segments.find(item => item.end >= position + phrase.length);
    if (first && last) {
      if (first.node.parentElement) reveal(first.node.parentElement);
      if (last.node.parentElement && last.node.parentElement !== first.node.parentElement) reveal(last.node.parentElement);
      root.focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(first.node, Math.max(0, position - first.start));
      range.setEnd(last.node, Math.min(last.node.length, position + phrase.length - last.start));
      const selection = window.getSelection();
      selection?.removeAllRanges(); selection?.addRange(range);
      first.node.parentElement?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      return true;
    }
  }
  const attachment = [...root.querySelectorAll<HTMLElement>('.nbase-attachment-node')].find(item =>
    [item.dataset.fileName, item.dataset.alt].some(value => value?.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())));
  if (attachment) { reveal(attachment); attachment.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); return true; }
  const equation = [...root.querySelectorAll<HTMLElement>('.nbase-equation-node')].find(item =>
    item.dataset.equation?.toLocaleLowerCase().includes(phrase.toLocaleLowerCase()));
  if (equation) { reveal(equation); equation.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); return true; }
  const callout = [...root.querySelectorAll<HTMLElement>('[data-callout-label]')].find(item =>
    item.dataset.calloutLabel?.toLocaleLowerCase().includes(phrase.toLocaleLowerCase()));
  if (callout) { reveal(callout); callout.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); return true; }
  return false;
}

function StateBridge({ props, editorRef, folding, history }: { props: DocumentEditorProps; editorRef: Ref<DocumentEditorHandle>;
  history: HistoryState;
  folding: { current: SectionFoldingHandle | null } }) {
  const [editor] = useLexicalComposerContext();
  const callbacks = useRef(props);
  callbacks.current = props;
  useImperativeHandle(editorRef, () => ({
    getSnapshot: () => readEditorSnapshot(editor.getEditorState()),
    focus: () => { if (editor.isEditable()) editor.focus(); },
    insertAttachments: attachments => {
      if (editor.isEditable() && attachments.length) editor.update(() => $insertAttachments(attachments));
    },
    replaceContent: content => {
      if (!editor.isEditable() || content.schemaVersion !== 1) return false;
      const next = editor.parseEditorState(content.editorState);
      if (next.isEmpty()) throw new Error('转换后的正文为空或不完整。');
      if (JSON.stringify(readEditorSnapshot(editor.getEditorState()).content)
        === JSON.stringify(readEditorSnapshot(next).content)) return false;
      history.current ??= { editor, editorState: editor.getEditorState() };
      editor.setEditorState(next, { tag: HISTORY_PUSH_TAG });
      return true;
    },
    findText: phrase => {
      const root = editor.getRootElement();
      return root ? findVisibleText(root, phrase, element => { revealInToggles(editor, element); folding.current?.reveal(element); }) : false;
    },
    jumpToHeading: id => folding.current?.jump(id),
    locatePageReference: (targetPageId, occurrence) => {
      const nodes = editor.getRootElement()?.querySelectorAll<HTMLElement>('[data-nbase-page-reference]');
      if (!nodes) return false;
      const node = occurrence === undefined ? [...nodes].find(item => item.dataset.nbasePageReference === targetPageId)
        : nodes.item(occurrence);
      if (!node || node.dataset.nbasePageReference !== targetPageId) return false;
      revealInToggles(editor, node);
      folding.current?.reveal(node);
      node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      node.querySelector<HTMLElement>('a,button')?.focus({ preventScroll: true });
      return true;
    },
  }), [editor, folding, history]);
  useLayoutEffect(() => { editor.setEditable(!props.readOnly); }, [editor, props.readOnly]);
  useLayoutEffect(() => {
    const initial = readEditorSnapshot(editor.getEditorState());
    let signature = JSON.stringify(initial.content.editorState);
    folding.current?.refresh(initial.outline);
    callbacks.current.onReady?.(props.documentId, initial);
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      const snapshot = readEditorSnapshot(editorState);
      folding.current?.refresh(snapshot.outline);
      const nextSignature = JSON.stringify(snapshot.content.editorState);
      if (nextSignature === signature) return;
      signature = nextSignature;
      callbacks.current.onChange(props.documentId, snapshot);
    });
  }, [editor, folding, props.documentId]);
  return null;
}

function EditorInstance({ props, editorRef }: { props: DocumentEditorProps; editorRef: Ref<DocumentEditorHandle> }) {
  const [failure, setFailure] = useState('');
  const history = useMemo(createEmptyHistoryState, []);
  const folding = useRef<SectionFoldingHandle>(null);
  const noticeRef = useRef(props.onNotice);
  const resolveRef = useRef(props.resolveBlock);
  resolveRef.current = props.resolveBlock;
  const hasResolver = Boolean(props.resolveBlock);
  const resolverContext = useMemo(() => ({ documentId: props.documentId,
    resolve: hasResolver ? (pageId: string, blockId: string) => resolveRef.current?.(pageId, blockId) ?? Promise.resolve(null) : undefined }),
  [hasResolver, props.documentId]);
  const revealBlock = useCallback((element: HTMLElement) => folding.current?.reveal(element), []);
  noticeRef.current = props.onNotice;
  const config = useMemo(() => {
    const content = props.initialContent ?? createContentFromMarkdown(props.initialMarkdown ?? '');
    if (content.schemaVersion !== 1) throw new Error('不支持的文档内容版本');
    const validator = createEditor({ nodes: EDITOR_NODES, onError: (error) => { throw error; } });
    const parsed = validator.parseEditorState(content.editorState);
    if (parsed.isEmpty()) throw new Error('文档内容为空或不完整');
    return {
    namespace: 'nbase-document',
    nodes: EDITOR_NODES, theme, editable: !props.readOnly,
    editorState: JSON.stringify(content.editorState),
    onError: (error: Error) => {
      queueMicrotask(() => { setFailure(error.message); noticeRef.current?.('编辑器发生错误；请保留当前文档并重新打开。'); });
    },
  // The initial state belongs to this mounted document; edits never replace it.
  }; }, []);
  return <AttachmentWorkspaceContext.Provider value={props.workspaceId ?? null}>
    <PageReferencesProvider references={props.pageReferences}><DatabaseEmbeddingProvider value={props.databases}>
    <EmbeddedPagesProvider value={props.embeds}><EmbedPathProvider pageId={props.documentId}>
    <BlockResolverContext.Provider value={resolverContext}>
    <LexicalComposer initialConfig={config}>
    <div className="document-editor" data-readonly={Boolean(props.readOnly)}>
      {failure && <div className="nbase-editor-error" role="alert"><strong>编辑器发生错误，原始内容仍保留。</strong><span>{failure}</span><details><summary>查看打开时的原始内容</summary><pre>{props.initialMarkdown ?? JSON.stringify(props.initialContent, null, 2)}</pre></details></div>}
      <ToolbarPlugin readOnly={Boolean(props.readOnly)} onNotice={props.onNotice}
        findPanel={<FindReplacePlugin title={props.title} onReplaceTitle={props.onReplaceTitle}
          readOnly={Boolean(props.readOnly)} reveal={element => folding.current?.reveal(element)} historyState={history} />} />
      <div className="nbase-editor-surface">
        <RichTextPlugin contentEditable={<ContentEditable className="nbase-editor-content" aria-label="文档正文" spellCheck={false} />} placeholder={<div className="nbase-editor-placeholder">{props.readOnly ? '这篇文档暂无正文。' : '输入 / 选择样式，或 # 标题、- 列表…'}</div>} ErrorBoundary={LexicalErrorBoundary} />
      </div>
      <HistoryPlugin externalHistoryState={history} /><ListPlugin /><CheckListPlugin />
      <LinkPlugin validateUrl={isSafeLinkUrl} attributes={{ rel: 'noopener noreferrer' }} />
      <TablePlugin hasTabHandler hasHorizontalScroll hasNestedTables={false} />
      <HorizontalRulePlugin /><MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
      <CodeHighlightPlugin /><CodeCopyPlugin onNotice={props.onNotice} /><BlockContextMenuPlugin onNotice={props.onNotice} />
      <EquationPlugin /><SlashCommandPlugin onPickAttachment={props.onPickAttachment} /><CalloutPlugin /><PageReferencePlugin historyState={history} />
      <MermaidPlugin historyState={history} /><DatabaseViewPlugin /><WhiteboardViewPlugin documentId={props.documentId} />
      <ListIndentPlugin /><LinkInteractionPlugin onNotice={props.onNotice} />
      <FloatingToolbarPlugin /><BlockHandlePlugin onBeforeMove={element => folding.current?.expand(element)} documentId={props.documentId} onNotice={props.onNotice} />
      <ShortcutsPlugin /><WordCountPlugin /><TogglePlugin documentId={props.documentId} /><TableColumnResizePlugin /><BookmarkPlugin onLinkPreview={props.onLinkPreview} onNotice={props.onNotice} />
      <FootnoteNavigationPlugin reveal={element => folding.current?.reveal(element)} />
      <BlockReferencePlugin documentId={props.documentId} onNotice={props.onNotice} reveal={revealBlock} />
      <SafePastePlugin onNotice={props.onNotice} onUploadFiles={props.onUploadFiles} />
      <SectionFoldingPlugin ref={folding} />
      <StateBridge props={props} editorRef={editorRef} folding={folding} history={history} />
    </div>
  </LexicalComposer></BlockResolverContext.Provider></EmbedPathProvider></EmbeddedPagesProvider></DatabaseEmbeddingProvider></PageReferencesProvider></AttachmentWorkspaceContext.Provider>;
}

export const DocumentEditor = forwardRef<DocumentEditorHandle, DocumentEditorProps>(function DocumentEditor(props, ref) {
  const original = props.initialContent ? JSON.stringify(props.initialContent, null, 2) : props.initialMarkdown ?? '';
  return <EditorBoundary key={props.documentId} original={original}><EditorInstance props={props} editorRef={ref} /></EditorBoundary>;
});
