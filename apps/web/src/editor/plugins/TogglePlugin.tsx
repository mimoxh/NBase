import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import {
  $createParagraphNode, $findMatchingParent, $getNearestNodeFromDOMNode, $getSelection, $isParagraphNode,
  $isRangeSelection, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_LOW, KEY_BACKSPACE_COMMAND, KEY_ENTER_COMMAND, TextNode,
} from 'lexical';
import type { LexicalEditor } from 'lexical';
import { $isToggleNode, $normalizeToggle, $toggleOfSummary, $unwrapToggle, collapsedToggles, ToggleNode } from '../nodes/ToggleNode';
import { $canonicalizeTextStyle } from '../textFormatting';

const storageKey = (documentId: string) => 'nbase:toggles:' + documentId;
const toggleElements = (editor: LexicalEditor) => [...editor.getRootElement()?.querySelectorAll<HTMLElement>('.nbase-toggle') ?? []];

function readStored(documentId: string): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(documentId)) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item)) : [];
  } catch { return []; }
}

/** Remembered by position in the page: node keys do not survive a reload, and the document must not change. */
function store(editor: LexicalEditor, documentId: string): void {
  const closed = toggleElements(editor).flatMap((element, index) => element.dataset.open === 'false' ? [index] : []);
  try {
    if (closed.length) localStorage.setItem(storageKey(documentId), JSON.stringify(closed.slice(0, 500)));
    else localStorage.removeItem(storageKey(documentId));
  } catch { /* Storage is optional view state. */ }
}

export function setToggleOpen(editor: LexicalEditor, element: HTMLElement, open: boolean): void {
  const key = editor.read('latest', () => $getNearestNodeFromDOMNode(element)?.getKey());
  if (!key) return;
  const keys = collapsedToggles(editor);
  if (open) keys.delete(key); else keys.add(key);
  element.dataset.open = String(open);
}

/** Opens every collapsed toggle around `element`, so a search hit or jump target becomes visible. */
export function revealInToggles(editor: LexicalEditor, element: HTMLElement): void {
  for (let closed = element.closest<HTMLElement>('.nbase-toggle[data-open="false"]'); closed;
    closed = closed.parentElement?.closest<HTMLElement>('.nbase-toggle[data-open="false"]') ?? null) {
    setToggleOpen(editor, closed, true);
  }
}

export function TogglePlugin({ documentId }: { documentId: string }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let restored = false;
    const restore = () => {
      if (restored || !editor.getRootElement()) return;
      restored = true;
      const closed = new Set(readStored(documentId));
      toggleElements(editor).forEach((element, index) => { if (closed.has(index)) setToggleOpen(editor, element, false); });
    };

    // The disclosure marker is the container's own left gutter beside the summary line.
    const onClick = (event: MouseEvent) => {
      const element = event.target instanceof HTMLElement && event.target.classList.contains('nbase-toggle') ? event.target : null;
      const summary = element?.firstElementChild;
      if (!element || !summary || event.clientY > summary.getBoundingClientRect().bottom) return;
      event.preventDefault();
      setToggleOpen(editor, element, element.dataset.open === 'false');
      store(editor, documentId);
    };
    const $summaryToggle = () => {
      const selection = $getSelection();
      return $isRangeSelection(selection) && selection.isCollapsed() ? $toggleOfSummary(selection.anchor.getNode()) : null;
    };
    return mergeRegister(
      editor.registerRootListener((root, previous) => {
        previous?.removeEventListener('click', onClick);
        root?.addEventListener('click', onClick);
        // The first reconciliation may still be pending when the root is attached.
        if (root) queueMicrotask(restore);
      }),
      editor.registerNodeTransform(ToggleNode, $normalizeToggle),
      editor.registerNodeTransform(TextNode, $canonicalizeTextStyle),
      editor.registerCommand(KEY_ENTER_COMMAND, event => {
        if (!event || event.shiftKey || event.isComposing || event.keyCode === 229
          || editor.isComposing() || !editor.isEditable()) return false;
        const toggle = $summaryToggle();
        if (toggle) {
          const element = editor.getElementByKey(toggle.getKey());
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            if (element) { setToggleOpen(editor, element, element.dataset.open === 'false'); store(editor, documentId); }
            return true;
          }
          // The new line lands in the body, which must be visible to type into.
          if (element?.dataset.open === 'false') { setToggleOpen(editor, element, true); store(editor, documentId); }
          return false;
        }
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const paragraph = $findMatchingParent(selection.anchor.getNode(), $isParagraphNode);
        const parent = paragraph?.getParent();
        if (!paragraph || !paragraph.isEmpty() || paragraph.getNextSibling() || !$isToggleNode(parent)
          || parent.getFirstChild()?.is(paragraph)) return false;
        event.preventDefault();
        parent.insertAfter($createParagraphNode()).selectStart();
        if (parent.getChildrenSize() > 2) paragraph.remove();
        return true;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, event => {
        const selection = $getSelection();
        const toggle = $summaryToggle();
        if (!toggle || !$isRangeSelection(selection) || selection.anchor.offset !== 0 || !editor.isEditable()) return false;
        const summary = toggle.getFirstChild();
        const first = $isParagraphNode(summary) ? summary.getFirstDescendant() : null;
        if (first && !selection.anchor.getNode().is(first) && !selection.anchor.getNode().is(summary)) return false;
        event?.preventDefault();
        $unwrapToggle(toggle);
        return true;
      }, COMMAND_PRIORITY_LOW),
    );
  }, [documentId, editor]);
  return null;
}
