// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { $getRoot, $getSelection, $isRangeSelection, KEY_ENTER_COMMAND, UNDO_COMMAND, type LexicalEditor } from 'lexical';
import { createContentFromMarkdown } from '../markdown';
import { EDITOR_NODES } from '../nodes';
import { $applyCallout, $isCalloutNode, $unwrapCallout } from '../nodes/CalloutNode';
import { CalloutPlugin } from './CalloutPlugin';

it('converts a quote to a callout, leaves empty callouts with Enter, and undoes unwrapping', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let editor!: LexicalEditor;
  function CaptureEditor() {
    [editor] = useLexicalComposerContext();
    return null;
  }
  try {
    const initial = createContentFromMarkdown('> **引用**\n\n> [!IMPORTANT]');
    await act(() => root.render(<LexicalComposer initialConfig={{
      namespace: 'callout-test', nodes: EDITOR_NODES, editorState: JSON.stringify(initial.editorState),
      onError: error => { throw error; },
    }}>
      <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
      <HistoryPlugin />
      <CalloutPlugin />
      <CaptureEditor />
    </LexicalComposer>));
    await act(() => editor.update(() => {
      $getRoot().getFirstChildOrThrow().selectEnd();
      $applyCallout('WARNING');
    }));
    expect(host.querySelector('[data-callout-kind="WARNING"] strong')?.textContent).toBe('引用');
    await act(() => editor.update(() => {
      const callout = $getRoot().getFirstChild();
      if (!$isCalloutNode(callout)) throw new Error('Expected callout');
      callout.setTitle('修改后的标题');
    }));
    expect(host.querySelector('[data-callout-kind="WARNING"]')?.getAttribute('aria-label')).toBe('注意 · 修改后的标题');
    await act(() => editor.update(() => {
      const callout = $getRoot().getFirstChild();
      if (!$isCalloutNode(callout)) throw new Error('Expected callout');
      $unwrapCallout(callout);
    }));
    expect(host.querySelector('[data-callout-kind="WARNING"]')).toBeNull();
    expect(host.querySelector('p')?.textContent).toBe('修改后的标题');
    await act(() => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
    expect(host.querySelector('[data-callout-kind="WARNING"] strong')?.textContent).toBe('引用');

    await act(() => editor.update(() => $getRoot().getLastChildOrThrow().selectEnd()));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    await act(() => { editor.dispatchCommand(KEY_ENTER_COMMAND, enter); });
    expect(enter.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-callout-kind="IMPORTANT"] + p')).toBeTruthy();
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.getNode().getParent()?.getType()).toBe('root');
    });
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
