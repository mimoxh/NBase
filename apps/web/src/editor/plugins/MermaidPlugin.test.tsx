// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { createEmptyHistoryState, HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { $getRoot, $isElementNode, $isRangeSelection, $getSelection, KEY_ENTER_COMMAND, REDO_COMMAND, UNDO_COMMAND, type LexicalEditor } from 'lexical';
import { $createSnapshot, createContentFromMarkdown, MARKDOWN_TRANSFORMERS } from '../markdown';
import { EDITOR_NODES } from '../nodes';
import { $isMermaidNode, EDIT_MERMAID_COMMAND, INSERT_MERMAID_COMMAND } from '../nodes/MermaidNode';
import { fencedMermaidSource } from '../mermaidSource';
import { MermaidPlugin } from './MermaidPlugin';

const render = vi.hoisted(() => vi.fn(async (_source: string, _signal: AbortSignal) => new Blob(['<svg/>'])));
vi.mock('../renderMermaid', () => ({ renderMermaid: render }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let editor: LexicalEditor;

function Capture() { [editor] = useLexicalComposerContext(); return null; }

function mount(markdown: string, editable = true) {
  const history = createEmptyHistoryState();
  return act(() => root.render(<LexicalComposer initialConfig={{ namespace: 'mermaid-ui-test', nodes: EDITOR_NODES, editable,
    editorState: JSON.stringify(createContentFromMarkdown(markdown).editorState), onError: error => { throw error; } }}>
    <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
    <HistoryPlugin externalHistoryState={history} />
    <MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
    <MermaidPlugin historyState={history} /><Capture />
  </LexicalComposer>));
}

function key() {
  return editor.read('latest', () => {
    const node = $getRoot().getChildren().find($isMermaidNode);
    if (!node) throw new Error('Mermaid missing');
    return node.getKey();
  });
}
const snapshot = () => editor.read('latest', $createSnapshot);
const button = (label: string, parent: ParentNode = host) => {
  const element = [...parent.querySelectorAll('button')].find(item => item.textContent === label);
  if (!element) throw new Error('Button missing ' + label);
  return element;
};
async function changeSource(source: string) {
  const element = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, source);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(label: string, parent: ParentNode = host) { await act(async () => { button(label, parent).click(); }); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:mermaid-test'; } static revokeObjectURL() {} });
  render.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('opens, previews and cancels source edits while leaving document content unchanged', async () => {
  await mount(fencedMermaidSource('flowchart LR\n A[原文] --> B[完成]'));
  const before = snapshot().content;
  await act(() => { editor.dispatchCommand(EDIT_MERMAID_COMMAND, key()); });
  expect(snapshot().content).toEqual(before);
  await changeSource('sequenceDiagram\n A->>B: 未应用');
  await click('预览图表', host.querySelector('dialog')!);
  await vi.waitFor(() => expect(render).toHaveBeenCalled());
  expect(snapshot().content).toEqual(before);
  await click('取消');
  expect(snapshot().content).toEqual(before);
  expect(host.querySelector('dialog')).toBeNull();
});

it('applies source as one undo step and restores it with redo', async () => {
  await mount(fencedMermaidSource('flowchart LR\n A --> B'));
  const before = snapshot().content;
  await act(() => { editor.dispatchCommand(EDIT_MERMAID_COMMAND, key()); });
  const source = '\nsequenceDiagram\n 用户->>服务: 请求\n';
  await changeSource(source);
  await click('应用');
  expect(snapshot().markdown).toBe(fencedMermaidSource(source));
  await act(() => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(snapshot().content).toEqual(before);
  await act(() => { editor.dispatchCommand(REDO_COMMAND, undefined); });
  expect(snapshot().markdown).toBe(fencedMermaidSource(source));
});

it('lets read-only history previews render and copy without opening source editing', async () => {
  await mount(fencedMermaidSource('flowchart LR\n A --> B'), false);
  const before = snapshot().content;
  expect(host.textContent).not.toContain('编辑图表');
  expect(button('复制源码')).toBeTruthy();
  await click('预览图表');
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(host.querySelector('img.nbase-mermaid-image')?.getAttribute('src')).toBe('blob:mermaid-test'));
  await act(() => { expect(editor.dispatchCommand(EDIT_MERMAID_COMMAND, key())).toBe(false); });
  expect(snapshot().content).toEqual(before);
});

it('keeps invalid source available and shows a diagnostic without starting a renderer', async () => {
  const source = 'flowchart LR\n A --> B\n click A "https://outside.invalid"';
  await mount(fencedMermaidSource(source), false);
  await click('预览图表');
  expect(render).not.toHaveBeenCalled();
  expect(host.querySelector('pre')?.textContent).toBe(source);
  expect(host.textContent).toContain('外部资源');
});

it('inserts from the shared command and leaves a paragraph ready after the block', async () => {
  await mount('段落');
  await act(() => {
    editor.update(() => $getRoot().selectEnd(), { discrete: true });
    expect(editor.dispatchCommand(INSERT_MERMAID_COMMAND, undefined)).toBe(true);
  });
  expect(host.querySelector('dialog')).toBeTruthy();
  expect(editor.read('latest', () => $getRoot().getLastChild()?.getType())).toBe('paragraph');
});

it('opens the source editor from a typed Mermaid fence through the normal Markdown shortcut', async () => {
  await mount('正文');
  const body = host.querySelector<HTMLElement>('[contenteditable]')!;
  await act(() => {
    body.focus();
    editor.update(() => {
      const rootNode = $getRoot();
      const paragraph = rootNode.getFirstChild();
      if (!$isElementNode(paragraph)) throw new Error('paragraph missing');
      paragraph.clear().selectEnd().insertText(String.fromCharCode(96).repeat(3) + 'mermaid');
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
    }, { discrete: true });
  });
  await act(() => { editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent('keydown', { key: 'Enter' })); });
  expect(host.querySelector('dialog')).toBeTruthy();
  expect(editor.read('latest', () => $getRoot().getFirstChild()?.getType())).toBe('mermaid');
});
