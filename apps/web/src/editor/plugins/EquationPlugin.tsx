import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isNodeSelection, $isParagraphNode, $isRangeSelection, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from 'lexical';
import type { LexicalEditor, NodeKey } from 'lexical';
import { mergeRegister } from '@lexical/utils';
import katex from 'katex';
import { $createEquationNode, $getEquationNodeByKey, $isEquationNode, $requestEquationEdit, consumeEquationEditRequests, KATEX_OPTIONS, OPEN_EQUATION_EDITOR_COMMAND } from '../nodes/EquationNode';

type Target = { key: NodeKey; equation: string; inline: boolean };

function EquationPopover({ editor, target, onClose }: {
  editor: LexicalEditor; target: Target; onClose: () => void;
}) {
  const [source, setSource] = useState(target.equation);
  const [error, setError] = useState('');
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const confirm = useCallback(() => {
    const value = target.inline ? source.replace(/\s*\n\s*/g, ' ').trim() : source.trim();
    editor.update(() => {
      const node = $getEquationNodeByKey(target.key);
      if (!node) return;
      if (!value) { node.selectNext(); node.remove(); }
      else { node.setEquation(value); node.selectNext(); }
    });
    onClose();
    editor.focus();
  }, [editor, onClose, source, target]);

  const cancel = useCallback(() => {
    editor.update(() => {
      const node = $getEquationNodeByKey(target.key);
      if (node && !node.getEquation().trim()) node.remove();
    });
    onClose();
    editor.focus();
  }, [editor, onClose, target.key]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    if (!source.trim()) { preview.textContent = ''; setError(''); return; }
    try {
      katex.render(source, preview, { ...KATEX_OPTIONS, displayMode: !target.inline });
      setError('');
    } catch (failure) {
      preview.textContent = '';
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [source, target.inline]);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = editor.getElementByKey(target.key);
      const box = boxRef.current;
      if (!anchor || !box) { setPosition(null); return; }
      const rect = anchor.getBoundingClientRect();
      const own = box.getBoundingClientRect();
      const top = rect.bottom + 6 + own.height > window.innerHeight - 8
        ? Math.max(8, rect.top - own.height - 6)
        : rect.bottom + 6;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - own.width - 8));
      setPosition(previous => previous && previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [editor, target.key]);

  useEffect(() => {
    // Defer focus past the mount commit — selection reconciliation right
    // after the node insert can otherwise steal focus back to the editor.
    const id = window.setTimeout(() => { textRef.current?.focus(); textRef.current?.select(); }, 0);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) cancel();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [cancel]);

  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    const isEnter = event.key === 'Enter';
    if (target.inline ? isEnter && !event.shiftKey : isEnter && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      confirm();
    }
  };

  return createPortal(
    <div ref={boxRef} className="nbase-equation-popover" role="dialog" aria-label="编辑公式"
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}>
      <textarea ref={textRef} aria-label="LaTeX 源码" value={source} spellCheck={false}
        placeholder={target.inline ? '例如 x^2 + y^2' : '例如 \\int_0^1 x\\,dx'}
        onChange={event => setSource(event.target.value)} onKeyDown={keyDown} />
      <div ref={previewRef} className="nbase-equation-preview" />
      {error && <div className="nbase-equation-preview-error" role="alert">{error}</div>}
      <div className="nbase-equation-actions">
        <small>{target.inline ? 'Enter 确认 · Esc 取消' : 'Ctrl+Enter 确认 · Esc 取消'}</small>
        <button type="button" onClick={cancel}>取消</button>
        <button type="button" className="primary" onClick={confirm}>确认</button>
      </div>
    </div>, document.body);
}

/** Equation popover editing: click, node-selected Enter, and auto-open after insertion. */
export function EquationPlugin() {
  const [editor] = useLexicalComposerContext();
  const [editing, setEditing] = useState<Target | null>(null);

  const open = useCallback((key: NodeKey) => {
    if (!editor.isEditable()) return;
    const target = editor.read('latest', () => {
      const node = $getEquationNodeByKey(key);
      return node ? { equation: node.getEquation(), inline: node.isInline() } : null;
    });
    if (target) setEditing({ key, ...target });
  }, [editor]);

  useEffect(() => mergeRegister(
    editor.registerCommand(OPEN_EQUATION_EDITOR_COMMAND, key => { open(key); return true; }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(KEY_ENTER_COMMAND, event => {
      if (event?.shiftKey || editor.isComposing() || (event && (event.isComposing || event.keyCode === 229))) return false;
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        const node = selection.getNodes().find($isEquationNode);
        if (!node) return false;
        event?.preventDefault();
        open(node.getKey());
        return true;
      }
      // `$$` alone in a paragraph + Enter becomes an empty block equation.
      if ($isRangeSelection(selection)) {
        const parent = selection.anchor.getNode().getParent();
        if ($isParagraphNode(parent) && parent.getTextContent() === '$$') {
          event?.preventDefault();
          const node = $createEquationNode('', false);
          parent.replace(node);
          node.selectNext();
          $requestEquationEdit(node);
          return true;
        }
      }
      return false;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerUpdateListener(() => {
      const keys = consumeEquationEditRequests();
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]!;
        if (editor.read('latest', () => $getEquationNodeByKey(key) !== null)) {
          // Defer past the commit: mounting the popover focuses the textarea,
          // and doing it inside the listener pass can trip Lexical's
          // selection reconciliation before the commit has settled.
          setTimeout(() => open(key), 0);
          return;
        }
      }
    }),
  ), [editor, open]);

  return editing ? <EquationPopover editor={editor} target={editing} onClose={() => setEditing(null)} /> : null;
}
