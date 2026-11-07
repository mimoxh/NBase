import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { $isCodeNode } from '@lexical/code';
import { $isLinkNode } from '@lexical/link';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $findMatchingParent, mergeRegister } from '@lexical/utils';
import {
  $getSelection, $isRangeSelection, COMMAND_PRIORITY_LOW, FORMAT_TEXT_COMMAND, KEY_ESCAPE_COMMAND, createCommand,
} from 'lexical';
import type { LexicalCommand, TextFormatType } from 'lexical';
import './floatingToolbar.css';

/** Asks the main toolbar to open its link form for the current selection. */
export const OPEN_LINK_FORM_COMMAND: LexicalCommand<void> = createCommand('NBASE_OPEN_LINK_FORM');

type Marks = Record<'bold' | 'italic' | 'strikethrough' | 'highlight' | 'code', boolean> & { link: boolean };

const narrowScreen = '(hover: none), (max-width: 720px)';

/** The selection's formats, or null where the toolbar must stay away. */
function $marks(): Marks | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed() || !selection.getTextContent().trim()) return null;
  const nodes = selection.getNodes();
  if (nodes.some(node => $findMatchingParent(node, $isCodeNode))) return null;
  return {
    bold: selection.hasFormat('bold'), italic: selection.hasFormat('italic'),
    strikethrough: selection.hasFormat('strikethrough'), highlight: selection.hasFormat('highlight'),
    code: selection.hasFormat('code'),
    link: nodes.some(node => $findMatchingParent(node, $isLinkNode)),
  };
}

/** Formatting for selected words, above the selection; wide pointer screens only. */
export function FloatingToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [marks, setMarks] = useState<Marks | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const pointerDown = useRef(false);
  const dismissed = useRef(false);

  const refresh = useCallback(() => {
    const next = pointerDown.current || dismissed.current || editor.isComposing() || !editor.isEditable()
      || window.matchMedia?.(narrowScreen).matches ? null : editor.read('latest', $marks);
    setMarks(next);
  }, [editor]);

  useEffect(() => {
    const onDown = () => { pointerDown.current = true; dismissed.current = false; setMarks(null); };
    const onUp = () => { if (pointerDown.current) { pointerDown.current = false; refresh(); } };
    const stopRoot = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('pointerdown', onDown);
      root?.addEventListener('pointerdown', onDown);
    });
    document.addEventListener('pointerup', onUp);
    return mergeRegister(
      stopRoot,
      () => document.removeEventListener('pointerup', onUp),
      editor.registerUpdateListener(({ prevEditorState, editorState }) => {
        if (prevEditorState._selection !== editorState._selection) refresh();
      }),
      editor.registerCommand(KEY_ESCAPE_COMMAND, () => {
        if (!element.current) return false;
        dismissed.current = true;
        setMarks(null);
        return true;
      }, COMMAND_PRIORITY_LOW),
    );
  }, [editor, refresh]);

  const open = Boolean(marks);
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const box = element.current;
      const selection = window.getSelection();
      if (!box || !selection?.rangeCount) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const above = rect.top - box.offsetHeight - 8;
      setPosition({
        // The sticky page toolbar owns the top of the viewport.
        top: above >= 96 ? above : rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left + rect.width / 2 - box.offsetWidth / 2, window.innerWidth - box.offsetWidth - 8)),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, marks]);

  if (!marks || !editable) return null;
  const button = (label: string, content: ReactNode, active: boolean, run: () => void) => <button type="button"
    title={label} aria-label={label} aria-pressed={active} className={active ? 'is-active' : ''}
    onMouseDown={event => event.preventDefault()} onClick={run}>{content}</button>;
  const format = (type: TextFormatType) => () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, type);
  return <div ref={element} className="nbase-floating-toolbar" role="toolbar" aria-label="选中文字格式"
    style={position ?? { visibility: 'hidden', top: 0, left: 0 }}>
    {button('粗体', <b>B</b>, marks.bold, format('bold'))}
    {button('斜体', <i>I</i>, marks.italic, format('italic'))}
    {button('删除线', <s>S</s>, marks.strikethrough, format('strikethrough'))}
    {button('文字高亮', <mark className="nbase-highlight">高亮</mark>, marks.highlight, format('highlight'))}
    {button('行内代码', <span className="nbase-code-icon">&lt;/&gt;</span>, marks.code, format('code'))}
    {button('链接', '链接', marks.link, () => editor.dispatchCommand(OPEN_LINK_FORM_COMMAND, undefined))}
  </div>;
}
