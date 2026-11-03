import { Component, forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { createEditor } from 'lexical';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { $collectOutline, $createSnapshot, createContentFromMarkdown, isSafeLinkUrl, MARKDOWN_TRANSFORMERS } from './markdown';
import { EDITOR_NODES } from './nodes';
import type { DocumentEditorHandle, DocumentEditorProps } from './types';
import { ToolbarPlugin } from './plugins/ToolbarPlugin';
import { SafePastePlugin } from './plugins/SafePastePlugin';
import { CodeHighlightPlugin } from './plugins/CodeHighlightPlugin';
import { CodeCopyPlugin } from './plugins/CodeCopyPlugin';
import { EquationPlugin } from './plugins/EquationPlugin';
import { SlashCommandPlugin } from './plugins/SlashCommandPlugin';
import { $insertAttachments, AttachmentWorkspaceContext } from './nodes/AttachmentNode';
import 'katex/dist/katex.min.css';
import './editor.css';

const theme = {
  paragraph: 'nbase-paragraph', quote: 'nbase-quote', link: 'nbase-link',
  heading: { h1: 'nbase-heading-1', h2: 'nbase-heading-2', h3: 'nbase-heading-3' },
  text: { bold: 'nbase-bold', italic: 'nbase-italic', strikethrough: 'nbase-strikethrough', code: 'nbase-inline-code' },
  list: { ul: 'nbase-list-ul', ol: 'nbase-list-ol', listitem: 'nbase-list-item', listitemChecked: 'nbase-check-checked', listitemUnchecked: 'nbase-check-unchecked', nested: { listitem: 'nbase-list-nested' } },
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
function findVisibleText(root: HTMLElement, phrase: string): boolean {
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
  if (attachment) { attachment.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); return true; }
  const equation = [...root.querySelectorAll<HTMLElement>('.nbase-equation-node')].find(item =>
    item.dataset.equation?.toLocaleLowerCase().includes(phrase.toLocaleLowerCase()));
  if (equation) { equation.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); return true; }
  return false;
}

function StateBridge({ props, editorRef }: { props: DocumentEditorProps; editorRef: Ref<DocumentEditorHandle> }) {
  const [editor] = useLexicalComposerContext();
  const callbacks = useRef(props);
  callbacks.current = props;
  useImperativeHandle(editorRef, () => ({
    getSnapshot: () => editor.read('latest', $createSnapshot),
    focus: () => { if (editor.isEditable()) editor.focus(); },
    insertAttachments: attachments => {
      if (editor.isEditable() && attachments.length) editor.update(() => $insertAttachments(attachments));
    },
    findText: phrase => {
      const root = editor.getRootElement();
      return root ? findVisibleText(root, phrase) : false;
    },
  }), [editor]);
  useLayoutEffect(() => { editor.setEditable(!props.readOnly); }, [editor, props.readOnly]);
  useLayoutEffect(() => {
    const initial = editor.read('latest', $createSnapshot);
    let signature = JSON.stringify(initial.content.editorState);
    callbacks.current.onReady?.(props.documentId, initial);
    const updateAnchors = () => editor.read('latest', () => {
      for (const item of $collectOutline()) {
        const element = editor.getElementByKey(item.id.replace(/^heading-/, ''));
        if (element) element.id = item.id;
      }
    });
    updateAnchors();
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      updateAnchors();
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      const snapshot = editorState.read($createSnapshot, { editor });
      const nextSignature = JSON.stringify(snapshot.content.editorState);
      if (nextSignature === signature) return;
      signature = nextSignature;
      callbacks.current.onChange(props.documentId, snapshot);
    });
  }, [editor, props.documentId]);
  return null;
}

function EditorInstance({ props, editorRef }: { props: DocumentEditorProps; editorRef: Ref<DocumentEditorHandle> }) {
  const [failure, setFailure] = useState('');
  const noticeRef = useRef(props.onNotice);
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
  return <AttachmentWorkspaceContext.Provider value={props.workspaceId ?? null}><LexicalComposer initialConfig={config}>
    <div className="document-editor" data-readonly={Boolean(props.readOnly)}>
      {failure && <div className="nbase-editor-error" role="alert"><strong>编辑器发生错误，原始内容仍保留。</strong><span>{failure}</span><details><summary>查看打开时的原始内容</summary><pre>{props.initialMarkdown ?? JSON.stringify(props.initialContent, null, 2)}</pre></details></div>}
      <ToolbarPlugin readOnly={Boolean(props.readOnly)} onNotice={props.onNotice} />
      <div className="nbase-editor-surface">
        <RichTextPlugin contentEditable={<ContentEditable className="nbase-editor-content" aria-label="文档正文" spellCheck={false} />} placeholder={<div className="nbase-editor-placeholder">{props.readOnly ? '这篇文档暂无正文。' : '输入 / 选择样式，或 # 标题、- 列表…'}</div>} ErrorBoundary={LexicalErrorBoundary} />
      </div>
      <HistoryPlugin /><ListPlugin /><CheckListPlugin />
      <LinkPlugin validateUrl={isSafeLinkUrl} attributes={{ rel: 'noopener noreferrer' }} />
      <TablePlugin hasTabHandler hasHorizontalScroll hasNestedTables={false} />
      <HorizontalRulePlugin /><MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
      <CodeHighlightPlugin /><CodeCopyPlugin onNotice={props.onNotice} />
      <EquationPlugin /><SlashCommandPlugin />
      <SafePastePlugin onNotice={props.onNotice} onUploadFiles={props.onUploadFiles} />
      <StateBridge props={props} editorRef={editorRef} />
    </div>
  </LexicalComposer></AttachmentWorkspaceContext.Provider>;
}

export const DocumentEditor = forwardRef<DocumentEditorHandle, DocumentEditorProps>(function DocumentEditor(props, ref) {
  const original = props.initialContent ? JSON.stringify(props.initialContent, null, 2) : props.initialMarkdown ?? '';
  return <EditorBoundary key={props.documentId} original={original}><EditorInstance props={props} editorRef={ref} /></EditorBoundary>;
});
