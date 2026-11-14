import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isCodeNode } from '@lexical/code';
import {
  $deleteTableColumnAtSelection, $deleteTableRowAtSelection, $getTableCellNodeFromLexicalNode,
  $getTableNodeFromLexicalNodeOrThrow, $insertTableColumnAtSelection, $insertTableRowAtSelection, $isTableSelection,
} from '@lexical/table';
import { $findMatchingParent } from '@lexical/utils';
import {
  $getNearestNodeFromDOMNode, $getNodeByKey, $getSelection, $isRangeSelection, $setSelection,
} from 'lexical';
import type { BaseSelection, LexicalEditor, LexicalNode, NodeKey } from 'lexical';
import { calloutKinds, calloutTitleMaxLength, isCalloutTitle, type CalloutKind } from '@nbase/contracts';
import { CODE_LANGUAGES } from '../codeLanguages';
import { $calloutForNode, $isCalloutNode, $unwrapCallout, calloutLabels } from '../nodes/CalloutNode';
import { $alignTableColumn, $moveTableLine, type TableAlignment } from '../tableEditing';
import { $canMergeSelection, $canSplitSelection, $hasMergedCells, $mergeSelectedCells, $splitSelectedCell } from '../tableLayout';
import { EditorMenu, type EditorMenuEntry } from './EditorMenu';

type Props = { onNotice?: ((message: string) => void) | undefined };
type Menu = { label: string; x: number; y: number; items: EditorMenuEntry[] };
type TitleEdit = { key: NodeKey; x: number; y: number; title: string };

type Context =
  | { kind: 'table'; canMerge: boolean; canSplit: boolean; merged: boolean; align: TableAlignment }
  | { kind: 'code'; key: NodeKey; language: string }
  | { kind: 'callout'; key: NodeKey; calloutKind: CalloutKind; title: string };

/** Language choices for a code block; an unknown stored language stays listed and selected. */
export function codeLanguageEntries(current: string, pick: (language: string) => void): EditorMenuEntry[] {
  const value = current || 'plain';
  const entries: EditorMenuEntry[] = CODE_LANGUAGES.map(([language, label]) =>
    ({ key: 'lang-' + language, label, checked: language === value, onSelect: () => pick(language) }));
  if (!CODE_LANGUAGES.some(([language]) => language === value)) {
    entries.push({ key: 'lang-' + value, label: value, checked: true, onSelect: () => pick(value) });
  }
  return entries;
}

export function setCodeLanguage(editor: LexicalEditor, key: NodeKey, language: string) {
  editor.update(() => {
    const node = $getNodeByKey(key);
    if ($isCodeNode(node) && node.getLanguage() !== language) node.setLanguage(language);
  });
}

export function menuHost(editor: LexicalEditor): Element {
  return editor.getRootElement()?.closest('.nb-app') ?? document.body;
}

function $contextFor(node: LexicalNode): Context | null {
  const cell = $getTableCellNodeFromLexicalNode(node);
  if (cell) {
    const selection = $getSelection();
    const inCell = ($isRangeSelection(selection) && $getTableCellNodeFromLexicalNode(selection.anchor.getNode())?.is(cell))
      || ($isTableSelection(selection) && selection.getNodes().some(item => item.is(cell)));
    // Keep a multi-cell selection that includes the clicked cell, so it can be merged.
    if (!inCell) cell.selectEnd();
    const format = cell.getFormatType();
    return { kind: 'table', canMerge: $canMergeSelection(), canSplit: $canSplitSelection(),
      merged: $hasMergedCells($getTableNodeFromLexicalNodeOrThrow(cell)),
      align: format === 'center' || format === 'right' ? format : 'left' };
  }
  const code = $findMatchingParent(node, $isCodeNode);
  if ($isCodeNode(code)) return { kind: 'code', key: code.getKey(), language: code.getLanguage() ?? '' };
  const callout = $calloutForNode(node);
  if (callout) return { kind: 'callout', key: callout.getKey(), calloutKind: callout.getKind(), title: callout.getTitle() };
  return null;
}

/**
 * Right-click menus for tables, code blocks and callouts. Other blocks, read-only views and
 * Shift+right-click keep the browser's own menu (copy, paste, spelling).
 */
export function BlockContextMenuPlugin({ onNotice }: Props) {
  const [editor] = useLexicalComposerContext();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [titleEdit, setTitleEdit] = useState<TitleEdit | null>(null);
  // Enter, blur and Escape can all follow one another; only the first one settles the edit.
  const pendingTitle = useRef<TitleEdit | null>(null);
  pendingTitle.current = titleEdit;
  const saved = useRef<BaseSelection | null>(null);
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  useEffect(() => {
    const run = (action: () => void) => {
      editor.update(() => {
        if (saved.current) $setSelection(saved.current.clone());
        action();
      });
      editor.focus();
    };
    const byKey = (key: NodeKey, action: (node: LexicalNode) => void) => {
      editor.update(() => { const node = $getNodeByKey(key); if (node) action(node); });
      editor.focus();
    };
    const copy = (key: NodeKey) => {
      const text = editor.read('latest', () => { const node = $getNodeByKey(key); return $isCodeNode(node) ? node.getTextContent() : null; });
      if (text === null) return;
      void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(
        () => noticeRef.current?.('已复制代码。'),
        () => noticeRef.current?.('复制失败，请在代码块中手动选择内容复制。'));
    };
    const itemsFor = (context: Context, x: number, y: number): Menu => {
      if (context.kind === 'table') {
        const movable = !context.merged;
        const moveHint = movable ? undefined : '含合并单元格的表格不能整行或整列移动，请先拆分。';
        const align = (value: TableAlignment, label: string) => ({ key: 'align-' + value, label, checked: context.align === value,
          onSelect: () => run(() => $alignTableColumn(value)) });
        const move = (key: string, label: string, axis: 'row' | 'column', direction: -1 | 1) => ({ key, label, disabled: !movable,
          hint: moveHint, onSelect: () => run(() => { $moveTableLine(axis, direction); }) });
        return { label: '表格操作', x, y, items: [
          { key: 'row-above', label: '在上方插入行', onSelect: () => run(() => { $insertTableRowAtSelection(false); }) },
          { key: 'row-below', label: '在下方插入行', onSelect: () => run(() => { $insertTableRowAtSelection(true); }) },
          { key: 'col-left', label: '在左侧插入列', onSelect: () => run(() => { $insertTableColumnAtSelection(false); }) },
          { key: 'col-right', label: '在右侧插入列', onSelect: () => run(() => { $insertTableColumnAtSelection(true); }) },
          'divider',
          { key: 'merge', label: '合并单元格', disabled: !context.canMerge, hint: context.canMerge ? undefined : '先拖选多个单元格', onSelect: () => run($mergeSelectedCells) },
          { key: 'split', label: '拆分单元格', disabled: !context.canSplit, onSelect: () => run($splitSelectedCell) },
          { key: 'align', label: '列对齐', children: [align('left', '左对齐'), align('center', '居中'), align('right', '右对齐')] },
          { key: 'move', label: '移动行列', disabled: !movable, hint: moveHint, children: [
            move('row-up', '上移行', 'row', -1), move('row-down', '下移行', 'row', 1),
            move('col-leftward', '左移列', 'column', -1), move('col-rightward', '右移列', 'column', 1)] },
          'divider',
          { key: 'delete-row', label: '删除当前行', danger: true, onSelect: () => run($deleteTableRowAtSelection) },
          { key: 'delete-col', label: '删除当前列', danger: true, onSelect: () => run($deleteTableColumnAtSelection) },
        ] };
      }
      if (context.kind === 'code') {
        const key = context.key;
        return { label: '代码块操作', x, y, items: [
          { key: 'language', label: '代码语言', children: codeLanguageEntries(context.language,
            language => { setCodeLanguage(editor, key, language); editor.focus(); }) },
          { key: 'copy', label: '复制代码', onSelect: () => copy(key) },
        ] };
      }
      const { key, title } = context;
      return { label: '提示块操作', x, y, items: [
        { key: 'kind', label: '提示类型', children: calloutKinds.map(kind => ({ key: 'kind-' + kind, label: calloutLabels[kind],
          checked: kind === context.calloutKind, onSelect: () => byKey(key, node => { if ($isCalloutNode(node)) node.setKind(kind); }) })) },
        { key: 'title', label: title ? '修改标题…' : '添加标题…', onSelect: () => setTitleEdit({ key, x, y, title }) },
        'divider',
        { key: 'unwrap', label: '转换为普通正文', onSelect: () => byKey(key, node => { if ($isCalloutNode(node)) $unwrapCallout(node); }) },
      ] };
    };

    const onContextMenu = (event: MouseEvent) => {
      if (event.shiftKey || !editor.isEditable() || editor.isComposing()) return;
      const root = editor.getRootElement();
      // The keyboard menu key targets the editor root; use the caret instead.
      const fromKeyboard = event.target === root || (event.clientX === 0 && event.clientY === 0);
      let context: Context | null = null;
      editor.update(() => {
        let node: LexicalNode | null = null;
        if (!fromKeyboard && event.target instanceof Node) node = $getNearestNodeFromDOMNode(event.target);
        else {
          const selection = $getSelection();
          node = $isRangeSelection(selection) || $isTableSelection(selection) ? selection.anchor.getNode() : null;
        }
        context = node ? $contextFor(node) : null;
        saved.current = $getSelection()?.clone() ?? null;
      }, { discrete: true });
      if (!context) return;
      event.preventDefault();
      let { clientX: x, clientY: y } = event;
      if (fromKeyboard) {
        const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
        const box = range && (range.width || range.height) ? range : root?.getBoundingClientRect();
        x = box?.left ?? 0; y = (box?.bottom ?? 0) + 4;
      }
      setTitleEdit(null);
      setMenu(itemsFor(context, x, y));
    };
    let current: HTMLElement | null = null;
    const unregister = editor.registerRootListener(root => {
      current?.removeEventListener('contextmenu', onContextMenu);
      current = root;
      root?.addEventListener('contextmenu', onContextMenu);
    });
    return () => { unregister(); current?.removeEventListener('contextmenu', onContextMenu); };
  }, [editor]);

  const applyTitle = (input: HTMLInputElement) => {
    const edit = pendingTitle.current;
    if (!edit) return;
    pendingTitle.current = null;
    setTitleEdit(null);
    const title = input.value.trim();
    if (!isCalloutTitle(title)) { noticeRef.current?.('提示块标题须为单行文字。'); editor.focus(); return; }
    if (title !== edit.title) editor.update(() => { const node = $getNodeByKey(edit.key); if ($isCalloutNode(node)) node.setTitle(title); });
    editor.focus();
  };

  return <>
    {menu && <EditorMenu label={menu.label} x={menu.x} y={menu.y} items={menu.items} host={menuHost(editor)}
      onClose={restore => { setMenu(null); if (restore) editor.focus(); }} />}
    {titleEdit && createPortal(<form className="nbase-callout-title-form" aria-label="提示块标题"
      style={{ left: Math.min(titleEdit.x, window.innerWidth - 300), top: titleEdit.y }}
      onSubmit={event => { event.preventDefault(); applyTitle(event.currentTarget.elements.namedItem('title') as HTMLInputElement); }}>
      <input name="title" aria-label="提示块标题" placeholder="可选标题，留空则不显示" autoFocus maxLength={calloutTitleMaxLength}
        defaultValue={titleEdit.title} onBlur={event => applyTitle(event.currentTarget)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); pendingTitle.current = null; setTitleEdit(null); editor.focus(); } }} />
    </form>, menuHost(editor))}
  </>;
}
