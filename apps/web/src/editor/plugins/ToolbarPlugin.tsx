import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TableActions } from './TableActions';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { calloutKinds, calloutTitleMaxLength, isCalloutKind, isCalloutTitle, type CalloutKind } from '@nbase/contracts';
import { $createTextNode, $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, $setSelection, CAN_REDO_COMMAND, CAN_UNDO_COMMAND, COMMAND_PRIORITY_LOW, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND } from 'lexical';
import type { BaseSelection, LexicalNode, TextFormatType } from 'lexical';
import { $isHeadingNode } from '@lexical/rich-text';
import { $isCodeNode } from '@lexical/code';
import { $isListNode } from '@lexical/list';
import { $createLinkNode, $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $deleteTableColumnAtSelection, $deleteTableRowAtSelection, $getTableCellNodeFromLexicalNode, $insertTableColumnAtSelection, $insertTableRowAtSelection, $isTableSelection, INSERT_TABLE_COMMAND } from '@lexical/table';
import { INSERT_HORIZONTAL_RULE_COMMAND } from '@lexical/react/LexicalHorizontalRuleNode';
import { mergeRegister } from '@lexical/utils';
import { isSafeLinkUrl } from '../markdown';
import { $applyBlockStyle } from '../blockStyles';
import type { BlockStyle } from '../blockStyles';
import { CODE_LANGUAGES } from '../codeLanguages';
import { $calloutForNode, $isCalloutNode, $unwrapCallout, calloutLabels } from '../nodes/CalloutNode';

type Props = { readOnly: boolean; onNotice?: ((message: string) => void) | undefined; findPanel?: ReactNode };
type CalloutState = { key: string; kind: CalloutKind; title: string };
type ToolbarState = { block: string; bold: boolean; italic: boolean; strikethrough: boolean; highlight: boolean; code: boolean; link: string; table: boolean; codeKey: string; codeLanguage: string; callout: CalloutState | null };
const emptyState: ToolbarState = { block: 'paragraph', bold: false, italic: false, strikethrough: false, highlight: false, code: false, link: '', table: false, codeKey: '', codeLanguage: '', callout: null };

function $enclosingCodeBlock(node: LexicalNode): LexicalNode | null {
  for (let current: LexicalNode | null = node; current; current = current.getParent()) {
    if ($isCodeNode(current)) return current;
  }
  return null;
}

export function ToolbarPlugin({ readOnly, onNotice, findPanel }: Props) {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState<ToolbarState>(emptyState);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  const savedSelection = useRef<BaseSelection | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = $getSelection();
      if (selection) savedSelection.current = selection.clone();
      if ($isRangeSelection(selection)) {
        const node = selection.anchor.getNode();
        let parent = node.getParent();
        let block = $isHeadingNode(node) ? node.getTag() : node.getType();
        let link = $isLinkNode(node) ? node.getURL() : '';
        while (parent) {
          if ($isLinkNode(parent)) link = parent.getURL();
          if ($isListNode(parent)) { block = parent.getListType(); break; }
          if ($isHeadingNode(parent)) block = parent.getTag();
          else if (['paragraph', 'quote', 'code'].includes(parent.getType())) block = parent.getType();
          parent = parent.getParent();
        }
        const codeBlock = $enclosingCodeBlock(node);
        const callout = $calloutForNode(node);
        setState({ block, bold: selection.hasFormat('bold'), italic: selection.hasFormat('italic'), strikethrough: selection.hasFormat('strikethrough'), highlight: selection.hasFormat('highlight'), code: selection.hasFormat('code'), link, table: Boolean($getTableCellNodeFromLexicalNode(node)),
          codeKey: codeBlock?.getKey() ?? '', codeLanguage: $isCodeNode(codeBlock) ? codeBlock.getLanguage() ?? '' : '',
          callout: callout ? { key: callout.getKey(), kind: callout.getKind(), title: callout.getTitle() } : null });
      } else if ($isTableSelection(selection)) {
        setState((previous) => ({ ...previous, table: true, codeKey: '', codeLanguage: '', callout: null }));
      }
    };
    editor.read('latest', update);
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => editorState.read(update)),
      editor.registerCommand(CAN_UNDO_COMMAND, (value) => { setCanUndo(value); return false; }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(CAN_REDO_COMMAND, (value) => { setCanRedo(value); return false; }, COMMAND_PRIORITY_LOW),
    );
  }, [editor]);
  const edit = (action: () => void) => {
    if (readOnly || !editor.isEditable()) return;
    editor.update(() => {
      if (savedSelection.current) $setSelection(savedSelection.current.clone());
      else if (!$getSelection()) $getRoot().selectEnd();
      action();
    });
    editor.focus();
  };
  const blockChange = (value: string) => edit(() => $applyBlockStyle(editor, value as BlockStyle));
  const codeLanguageChange = (value: string) => edit(() => {
    const node = $getNodeByKey(state.codeKey);
    if ($isCodeNode(node)) node.setLanguage(value);
  });
  const copyCode = () => {
    const text = editor.read('latest', () => {
      const node = $getNodeByKey(state.codeKey);
      return $isCodeNode(node) ? node.getTextContent() : null;
    });
    if (text === null) return;
    void navigator.clipboard.writeText(text).then(
      () => onNotice?.('已复制代码。'),
      () => onNotice?.('复制失败，请在代码块中手动选择内容复制。'));
  };
  const button = (label: string, content: ReactNode, action: () => void, active = false, disabled = false) => <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={readOnly || disabled} className={active ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={action}>{content}</button>;
  const format = (type: TextFormatType) => edit(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, type));
  const callout = state.callout;
  const changeCalloutTitle = (input: HTMLInputElement) => {
    if (!callout || !editor.isEditable()) return;
    const title = input.value.trim();
    if (!isCalloutTitle(title)) {
      input.value = callout.title;
      onNotice?.('提示块标题须为单行文字。');
      return;
    }
    input.value = title;
    if (title === callout.title) return;
    editor.update(() => {
      const node = $getNodeByKey(callout.key);
      if ($isCalloutNode(node)) node.setTitle(title);
    });
  };
  const applyLink = () => {
    const url = linkUrl.trim();
    if (url && !isSafeLinkUrl(url)) { setLinkError('请输入 http、https、mailto 或安全的相对链接。'); return; }
    edit(() => {
      const selection = $getSelection();
      if (url && $isRangeSelection(selection) && selection.isCollapsed() && !state.link) {
        selection.insertNodes([$createLinkNode(url, { rel: 'noopener noreferrer' }).append($createTextNode(url))]);
      } else editor.dispatchCommand(TOGGLE_LINK_COMMAND, url || null);
    });
    setLinkOpen(false);
    setLinkError('');
  };
  return <div className="nbase-editor-tools">
    <div className="nbase-editor-toolbar" role="toolbar" aria-label="文档格式">
      <div className="nbase-tool-group">
        {button('撤销', '↶', () => { editor.dispatchCommand(UNDO_COMMAND, undefined); editor.focus(); }, false, !canUndo)}
        {button('重做', '↷', () => { editor.dispatchCommand(REDO_COMMAND, undefined); editor.focus(); }, false, !canRedo)}
      </div>
      <div className="nbase-tool-group">
        <select aria-label="段落样式" value={state.block in { paragraph: 1, h1: 1, h2: 1, h3: 1, bullet: 1, number: 1, check: 1, quote: 1, code: 1 } ? state.block : 'paragraph'} disabled={readOnly} onChange={(event) => blockChange(event.target.value)}>
          <option value="paragraph">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option><option value="bullet">项目列表</option><option value="number">编号列表</option><option value="check">待办列表</option><option value="quote">引用</option><option value="code">代码块</option>
        </select>
      </div>
      <div className="nbase-tool-group">
        {button('粗体 Ctrl+B', <b>B</b>, () => format('bold'), state.bold)}
        {button('斜体 Ctrl+I', <i>I</i>, () => format('italic'), state.italic)}
        {button('删除线', <s>S</s>, () => format('strikethrough'), state.strikethrough)}
        {button('文字高亮', <mark className="nbase-highlight">高亮</mark>, () => format('highlight'), state.highlight, state.code || Boolean(state.codeKey))}
        {button('行内代码', <span className="nbase-code-icon">&lt;/&gt;</span>, () => format('code'), state.code)}
      </div>
      <div className="nbase-tool-group">
        {button('编辑链接', '链接', () => { setLinkUrl(state.link); setLinkError(''); setLinkOpen((open) => !open); }, Boolean(state.link))}
        {button('插入分割线', '—', () => edit(() => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)))}
        {button('插入 3 × 3 表格', '表格', () => {
          if (state.table) { onNotice?.('请先将光标移到表格外；暂不支持嵌套表格。'); return; }
          edit(() => editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: '3', rows: '3', includeHeaders: { rows: true, columns: false } }));
        })}
      </div>
      {readOnly && <span className="nbase-readonly-label">只读</span>}
    </div>
    {findPanel}
    {state.table && !readOnly && <div className="nbase-table-toolbar" role="toolbar" aria-label="表格操作">
      <span>表格</span>
      {button('在上方插入行', '上方插行', () => edit(() => { $insertTableRowAtSelection(false); }))}
      {button('在下方插入行', '下方插行', () => edit(() => { $insertTableRowAtSelection(true); }))}
      {button('在左侧插入列', '左侧插列', () => edit(() => { $insertTableColumnAtSelection(false); }))}
      {button('在右侧插入列', '右侧插列', () => edit(() => { $insertTableColumnAtSelection(true); }))}
      {button('删除当前行', '删除行', () => edit($deleteTableRowAtSelection))}
      {button('删除当前列', '删除列', () => edit($deleteTableColumnAtSelection))}
      <TableActions edit={edit} />
      <small>Tab 切换单元格</small>
    </div>}
    {callout && !readOnly && <div className="nbase-callout-toolbar" role="toolbar" aria-label="提示块操作">
      <select aria-label="提示块类型" value={callout.kind} onChange={event => {
        const kind = event.target.value;
        if (isCalloutKind(kind)) edit(() => {
          const node = $getNodeByKey(callout.key);
          if ($isCalloutNode(node)) node.setKind(kind);
        });
      }}>
        {calloutKinds.map(kind => <option key={kind} value={kind}>{calloutLabels[kind]}</option>)}
      </select>
      <input key={callout.key + ':' + callout.title} aria-label="提示块标题" placeholder="可选标题" maxLength={calloutTitleMaxLength}
        defaultValue={callout.title} onBlur={event => changeCalloutTitle(event.currentTarget)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) event.currentTarget.blur(); }} />
      {button('转换为普通正文', '转为正文', () => edit(() => {
        const node = $getNodeByKey(callout.key);
        if ($isCalloutNode(node)) $unwrapCallout(node);
      }))}
    </div>}
    {state.codeKey && !readOnly && <div className="nbase-code-toolbar" role="toolbar" aria-label="代码操作">
      <span>代码</span>
      <select aria-label="代码语言" value={state.codeLanguage || 'plain'}
        onChange={(event) => codeLanguageChange(event.target.value)}>
        {CODE_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        {state.codeLanguage && !CODE_LANGUAGES.some(([value]) => value === state.codeLanguage)
          && <option value={state.codeLanguage}>{state.codeLanguage}</option>}
      </select>
      {button('复制代码', '复制代码', copyCode)}
      <small>Tab 缩进</small>
    </div>}
    {linkOpen && !readOnly && <form className="nbase-link-form" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
      <label htmlFor={`link-${editor.getKey()}`}>链接地址</label>
      <input id={`link-${editor.getKey()}`} autoFocus value={linkUrl} placeholder="https://example.com" onChange={(event) => setLinkUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setLinkOpen(false); editor.focus(); } }} />
      <button type="submit">应用</button><button type="button" onClick={() => { edit(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)); setLinkOpen(false); }}>移除</button><button type="button" onClick={() => { setLinkOpen(false); editor.focus(); }}>取消</button>
      {linkError && <span role="alert">{linkError}</span>}
    </form>}
  </div>;
}
