import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { blockAlignments, type BlockAlignment, type TextStyle } from '@nbase/contracts';
import { $createTextNode, $getRoot, $getSelection, $isRangeSelection, $setSelection, CAN_REDO_COMMAND, CAN_UNDO_COMMAND, COMMAND_PRIORITY_LOW, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND } from 'lexical';
import type { BaseSelection, LexicalNode, TextFormatType } from 'lexical';
import { $isHeadingNode } from '@lexical/rich-text';
import { $isCodeNode } from '@lexical/code';
import { $isListNode } from '@lexical/list';
import { $createLinkNode, $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $isTableSelection } from '@lexical/table';
import { mergeRegister } from '@lexical/utils';
import { isSafeLinkUrl } from '../markdown';
import { $applyBlockStyle } from '../blockStyles';
import type { BlockStyle } from '../blockStyles';
import { $changeIndent, $selectedIndentBlocks, $selectedListItems } from '../listIndent';
import { OPEN_LINK_FORM_COMMAND } from './FloatingToolbarPlugin';
import { $applyTextStyle, $selectionAlignment, $selectionTextStyle, $setAlignment } from '../textFormatting';
import { TextColorMenu } from './TextColorMenu';
import { Popover } from '../../components/Popover';

const alignmentLabels: Record<BlockAlignment, string> = { left: '左对齐', center: '居中', right: '右对齐', justify: '两端对齐' };

type Props = { readOnly: boolean; onNotice?: ((message: string) => void) | undefined; findPanel?: ReactNode };
type ToolbarState = { block: string; bold: boolean; italic: boolean; strikethrough: boolean; highlight: boolean; code: boolean; link: string; indentable: boolean; inCodeBlock: boolean; textStyle: TextStyle; align: BlockAlignment | null };
const emptyState: ToolbarState = { block: 'paragraph', bold: false, italic: false, strikethrough: false, highlight: false, code: false, link: '', indentable: false, inCodeBlock: false, textStyle: {}, align: null };

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
  const [colorOpen, setColorOpen] = useState(false);
  const savedSelection = useRef<BaseSelection | null>(null);
  const openLinkForm = useRef(() => {});
  const linkInput = useRef<HTMLInputElement>(null);
  // Opened from a slash command, the editor reclaims focus as its update settles, after autoFocus ran.
  useEffect(() => {
    if (!linkOpen) return;
    const frame = requestAnimationFrame(() => linkInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [linkOpen]);
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
        setState({ block, bold: selection.hasFormat('bold'), italic: selection.hasFormat('italic'), strikethrough: selection.hasFormat('strikethrough'), highlight: selection.hasFormat('highlight'), code: selection.hasFormat('code'), link,
          indentable: $selectedListItems() !== null || $selectedIndentBlocks() !== null, inCodeBlock: $enclosingCodeBlock(node) !== null,
          textStyle: $selectionTextStyle(), align: $selectionAlignment() });
      } else if ($isTableSelection(selection)) {
        setState((previous) => ({ ...previous, indentable: false, inCodeBlock: false, textStyle: {}, align: null }));
      }
    };
    editor.read('latest', update);
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => editorState.read(update)),
      editor.registerCommand(CAN_UNDO_COMMAND, (value) => { setCanUndo(value); return false; }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(CAN_REDO_COMMAND, (value) => { setCanRedo(value); return false; }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(OPEN_LINK_FORM_COMMAND, () => { openLinkForm.current(); return true; }, COMMAND_PRIORITY_LOW),
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
  const button = (label: string, content: ReactNode, action: () => void, active = false, disabled = false) => <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={readOnly || disabled} className={active ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={action}>{content}</button>;
  const format = (type: TextFormatType) => edit(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, type));
  openLinkForm.current = () => { setLinkUrl(state.link); setLinkError(''); setLinkOpen(true); };
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
        {button('减少缩进 Shift+Tab', '⇤', () => edit(() => { $changeIndent(editor, -1); }), false, !state.indentable)}
        {button('增加缩进 Tab', '⇥', () => edit(() => { $changeIndent(editor, 1); }), false, !state.indentable)}
      </div>
      <div className="nbase-tool-group">
        {button('粗体 Ctrl+B', <b>B</b>, () => format('bold'), state.bold)}
        {button('斜体 Ctrl+I', <i>I</i>, () => format('italic'), state.italic)}
        {button('删除线', <s>S</s>, () => format('strikethrough'), state.strikethrough)}
        {button('文字高亮', <mark className="nbase-highlight">高亮</mark>, () => format('highlight'), state.highlight, state.code || state.inCodeBlock)}
        {button('行内代码', <span className="nbase-code-icon">&lt;/&gt;</span>, () => format('code'), state.code)}
        <span className="nbase-color-anchor">
          {button('文字和背景颜色', <span className="nbase-color-icon" style={{ ...(state.textStyle.color ? { color: `var(--nb-c-${state.textStyle.color})` } : {}),
            ...(state.textStyle.background ? { backgroundColor: `var(--nb-bg-${state.textStyle.background})` } : {}) }}>A</span>,
          () => setColorOpen(open => !open), Boolean(state.textStyle.color || state.textStyle.background), state.inCodeBlock)}
          {colorOpen && !readOnly && <Popover label="文字和背景颜色" className="nbase-color-popover" portal width={292} onClose={() => setColorOpen(false)}>
            <TextColorMenu value={state.textStyle} onPick={patch => { edit(() => $applyTextStyle(patch)); setColorOpen(false); }} />
          </Popover>}
        </span>
      </div>
      <div className="nbase-tool-group">
        <select aria-label="段落对齐" value={state.align ?? 'left'} disabled={readOnly || !state.align}
          onChange={event => { const value = event.target.value as BlockAlignment; edit(() => $setAlignment(value)); }}>
          {blockAlignments.map(value => <option key={value} value={value}>{alignmentLabels[value]}</option>)}
        </select>
      </div>
      {readOnly && <span className="nbase-readonly-label">只读</span>}
    </div>
    {findPanel}
    {linkOpen && !readOnly && <form className="nbase-link-form" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
      <label htmlFor={`link-${editor.getKey()}`}>链接地址</label>
      <input ref={linkInput} id={`link-${editor.getKey()}`} autoFocus value={linkUrl} placeholder="https://example.com" onChange={(event) => setLinkUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setLinkOpen(false); editor.focus(); } }} />
      <button type="submit">应用</button><button type="button" onClick={() => { edit(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)); setLinkOpen(false); }}>移除</button><button type="button" onClick={() => { setLinkOpen(false); editor.focus(); }}>取消</button>
      {linkError && <span role="alert">{linkError}</span>}
    </form>}
  </div>;
}
