import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $setSelection, CAN_REDO_COMMAND, CAN_UNDO_COMMAND, COMMAND_PRIORITY_LOW, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND } from 'lexical';
import type { BaseSelection, TextFormatType } from 'lexical';
import { $createHeadingNode, $createQuoteNode, $isHeadingNode } from '@lexical/rich-text';
import { $createCodeNode } from '@lexical/code';
import { $isListNode, INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND } from '@lexical/list';
import { $createLinkNode, $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $setBlocksType } from '@lexical/selection';
import { $deleteTableColumnAtSelection, $deleteTableRowAtSelection, $getTableCellNodeFromLexicalNode, $insertTableColumnAtSelection, $insertTableRowAtSelection, $isTableSelection, INSERT_TABLE_COMMAND } from '@lexical/table';
import { INSERT_HORIZONTAL_RULE_COMMAND } from '@lexical/react/LexicalHorizontalRuleNode';
import { mergeRegister } from '@lexical/utils';
import { isSafeLinkUrl } from '../markdown';

type Props = { readOnly: boolean; onNotice?: ((message: string) => void) | undefined };
type ToolbarState = { block: string; bold: boolean; italic: boolean; strikethrough: boolean; code: boolean; link: string; table: boolean };
const emptyState: ToolbarState = { block: 'paragraph', bold: false, italic: false, strikethrough: false, code: false, link: '', table: false };

export function ToolbarPlugin({ readOnly, onNotice }: Props) {
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
        setState({ block, bold: selection.hasFormat('bold'), italic: selection.hasFormat('italic'), strikethrough: selection.hasFormat('strikethrough'), code: selection.hasFormat('code'), link, table: Boolean($getTableCellNodeFromLexicalNode(node)) });
      } else if ($isTableSelection(selection)) {
        setState((previous) => ({ ...previous, table: true }));
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
  const blockChange = (value: string) => edit(() => {
    if (value === 'bullet') editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    else if (value === 'number') editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    else if (value === 'check') editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
    else {
      if (['bullet', 'number', 'check'].includes(state.block)) editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        if (value === 'h1' || value === 'h2' || value === 'h3') $setBlocksType(selection, () => $createHeadingNode(value));
        else if (value === 'quote') $setBlocksType(selection, () => $createQuoteNode());
        else if (value === 'code') $setBlocksType(selection, () => $createCodeNode());
        else $setBlocksType(selection, () => $createParagraphNode());
      }
    }
  });
  const button = (label: string, content: ReactNode, action: () => void, active = false, disabled = false) => <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={readOnly || disabled} className={active ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={action}>{content}</button>;
  const format = (type: TextFormatType) => edit(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, type));
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
        {button('行内代码', <span className="nbase-code-icon">&lt;/&gt;</span>, () => format('code'), state.code)}
      </div>
      <div className="nbase-tool-group">
        {button('编辑链接', '链接', () => { setLinkUrl(state.link); setLinkError(''); setLinkOpen((open) => !open); }, Boolean(state.link))}
        {button('插入分割线', '—', () => edit(() => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)))}
        {button('插入 3 × 3 表格', '表格', () => {
          if (state.table) { onNotice?.('请先将光标移到表格外；暂不支持嵌套表格。'); return; }
          edit(() => editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: '3', rows: '3', includeHeaders: true }));
        })}
      </div>
      {readOnly && <span className="nbase-readonly-label">只读</span>}
    </div>
    {state.table && !readOnly && <div className="nbase-table-toolbar" role="toolbar" aria-label="表格操作">
      <span>表格</span>
      {button('在上方插入行', '上方插行', () => edit(() => { $insertTableRowAtSelection(false); }))}
      {button('在下方插入行', '下方插行', () => edit(() => { $insertTableRowAtSelection(true); }))}
      {button('在左侧插入列', '左侧插列', () => edit(() => { $insertTableColumnAtSelection(false); }))}
      {button('在右侧插入列', '右侧插列', () => edit(() => { $insertTableColumnAtSelection(true); }))}
      {button('删除当前行', '删除行', () => edit($deleteTableRowAtSelection))}
      {button('删除当前列', '删除列', () => edit($deleteTableColumnAtSelection))}
      <small>Tab 切换单元格</small>
    </div>}
    {linkOpen && !readOnly && <form className="nbase-link-form" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
      <label htmlFor={`link-${editor.getKey()}`}>链接地址</label>
      <input id={`link-${editor.getKey()}`} autoFocus value={linkUrl} placeholder="https://example.com" onChange={(event) => setLinkUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setLinkOpen(false); editor.focus(); } }} />
      <button type="submit">应用</button><button type="button" onClick={() => { edit(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)); setLinkOpen(false); }}>移除</button><button type="button" onClick={() => { setLinkOpen(false); editor.focus(); }}>取消</button>
      {linkError && <span role="alert">{linkError}</span>}
    </form>}
  </div>;
}
