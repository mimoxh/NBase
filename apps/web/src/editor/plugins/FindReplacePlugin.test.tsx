// @vitest-environment jsdom
import { createEmptyHistoryState, HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, HISTORY_PUSH_TAG, REDO_COMMAND, UNDO_COMMAND } from 'lexical';
import type { LexicalEditor } from 'lexical';
import { act, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $findDocumentMatches, $replaceDocumentMatches, allDocumentMatches } from '../findDocument';
import { $createSnapshot, createContentFromMarkdown } from '../markdown';
import { EDITOR_NODES } from '../nodes';
import { $createAttachmentNode } from '../nodes/AttachmentNode';
import { FindReplacePlugin } from './FindReplacePlugin';

function createTestEditor(markdown: string) {
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(createContentFromMarkdown(markdown).editorState));
  return editor;
}

describe('page find index', () => {
  it('matches literal mixed-language text across formatting while keeping block and cell boundaries', () => {
    const editor = createTestEditor('汉**Ab**[字](https://example.com)\n\n尾\n\n| 前 | 后 |\n| --- | --- |\n| 甲 | 乙 |\n\n```js\nlet x = /a.*/;\n```');
    editor.read('latest', () => {
      expect([...allDocumentMatches($findDocumentMatches('汉ab', { title: '汉AB' }))].map(match => match.kind)).toEqual(['title', 'body']);
      expect($findDocumentMatches('汉ab', { title: '汉AB', caseSensitive: true }).count).toBe(0);
      expect($findDocumentMatches('字尾').count).toBe(0);
      expect($findDocumentMatches('甲乙').count).toBe(0);
      expect($findDocumentMatches('/a.*/').count).toBe(1);
      expect([...allDocumentMatches($findDocumentMatches('b字'))][0]?.replaceable).toBe(false);
    });
  });

  it('retains unmatched text, source formatting, and link targets', () => {
    const editor = createTestEditor('前**甲**乙*丙丁*后 [甲乙](https://example.com/path) $甲乙$');
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createAttachmentNode('11111111-1111-1111-1111-111111111111', '甲乙', '截图.png', 'image/png')));
      const result = $replaceDocumentMatches(allDocumentMatches($findDocumentMatches('甲乙', { title: '甲乙标题' })), '替换', '甲乙标题', true);
      expect(result).toMatchObject({ title: '替换标题', changed: 3, skipped: 2 });
    }, { discrete: true });
    expect(editor.read('latest', $createSnapshot).markdown).toContain('前**替换***丙丁*后 [替换](https://example.com/path) $甲乙$');
  });

  it('does not partially replace when the title or body growth exceeds its limit', () => {
    const editor = createTestEditor('正文 甲甲');
    editor.update(() => {
      const title = '甲'.repeat(255);
      const index = $findDocumentMatches('甲', { title });
      expect($replaceDocumentMatches(allDocumentMatches(index), '乙乙', title, true).titleTooLong).toBe(true);
      expect($replaceDocumentMatches(allDocumentMatches(index), '乙乙', title, false, 0).bodyTooLarge).toBe(true);
      expect($getRoot().getTextContent()).toBe('正文 甲甲');
    }, { discrete: true });
  });
});

let host: HTMLDivElement;
let root: Root;
let activeEditor: LexicalEditor;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function CaptureEditor() {
  const [editor] = useLexicalComposerContext();
  activeEditor = editor;
  return null;
}

function FindFixture({ initialTitle, markdown, readOnly = false, reveal }: {
  initialTitle: string; markdown: string; readOnly?: boolean; reveal?: (element: HTMLElement) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const history = useMemo(createEmptyHistoryState, []);
  const config = useMemo(() => ({ namespace: 'test', nodes: EDITOR_NODES, editable: !readOnly,
    editorState: JSON.stringify(createContentFromMarkdown(markdown).editorState), onError: (error: Error) => { throw error; } }), [readOnly, markdown]);
  return <div className="nb-scroll"><h1 data-nbase-find-title>{title}</h1><LexicalComposer initialConfig={config}>
    <FindReplacePlugin title={title} readOnly={readOnly} onReplaceTitle={setTitle} historyState={history} reveal={reveal} />
    <RichTextPlugin contentEditable={<ContentEditable aria-label="正文" />} ErrorBoundary={LexicalErrorBoundary} />
    <HistoryPlugin externalHistoryState={history} />
    <CaptureEditor />
  </LexicalComposer></div>;
}

const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const counter = () => host.querySelector('output')?.textContent;
const title = () => host.querySelector('[data-nbase-find-title]')?.textContent;
const body = () => activeEditor.read('latest', $createSnapshot);
const openFind = () => act(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
});
const click = (label: string) => act(() => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  button?.click();
});
const setField = (label: string, value: string) => act(() => {
  const input = field(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const undo = () => act(() => { activeEditor.dispatchCommand(UNDO_COMMAND, undefined); });
const redo = () => act(() => { activeEditor.dispatchCommand(REDO_COMMAND, undefined); });

describe('page find bar', () => {
  it('locates and wraps in read-only mode and clears on a new editor', async () => {
    const reveal = vi.fn();
    await act(() => root.render(<FindFixture key="a" initialTitle="汉ABC" markdown="汉**abc**" readOnly reveal={reveal} />));
    const before = body().content;
    await openFind();
    await setField('查找内容', '汉abc');
    expect(counter()).toBe('1 / 2');
    await click('上一处命中');
    expect(counter()).toBe('2 / 2');
    expect(reveal).toHaveBeenCalledWith(expect.any(HTMLElement));
    await click('下一处命中');
    expect(counter()).toBe('1 / 2');
    expect(host.querySelector('[aria-label="替换为"]')).toBeNull();
    expect(body().content).toEqual(before);
    await act(() => root.render(<FindFixture key="b" initialTitle="另一个页面" markdown="不同正文" />));
    expect(counter()).toBeUndefined();
    expect(host.querySelector('[data-nbase-find-active]')).toBeNull();
  });

  it('applies title and body together and restores both with one undo after a later edit', async () => {
    await act(() => root.render(<FindFixture initialTitle="甲标题" markdown="甲**甲**" />));
    await openFind();
    await setField('查找内容', '甲');
    await setField('替换为', '乙');
    expect(counter()).toBe('1 / 3');
    await click('全部替换');
    expect(title()).toBe('乙标题');
    expect(body().markdown).toBe('乙**乙**');
    expect(JSON.stringify(body().content)).not.toContain('甲标题');
    await act(() => activeEditor.update(() => { $getRoot().append($createParagraphNode().append($createTextNode('后续输入'))); }, { tag: HISTORY_PUSH_TAG }));
    await undo();
    expect(title()).toBe('乙标题');
    expect(body().markdown).toBe('乙**乙**');
    await undo();
    expect(title()).toBe('甲标题');
    expect(body().markdown).toBe('甲**甲**');
    await redo();
    expect(title()).toBe('乙标题');
    expect(body().markdown).toBe('乙**乙**');
  });

  it('undoes the first title-only replacement without changing serialized body', async () => {
    await act(() => root.render(<FindFixture initialTitle="待替换标题" markdown="保留正文" />));
    const before = body().content;
    await openFind();
    await setField('查找内容', '待替换');
    await setField('替换为', '修改');
    await click('替换当前');
    expect(title()).toBe('修改标题');
    await undo();
    expect(title()).toBe('待替换标题');
    expect(body().content).toEqual(before);
    await redo();
    expect(title()).toBe('修改标题');
  });

  it('keeps the previous query during IME composition and updates after it ends', async () => {
    await act(() => root.render(<FindFixture initialTitle="中文" markdown="中文与输入法" />));
    await openFind();
    await setField('查找内容', '中文');
    expect(counter()).toBe('1 / 2');
    await act(() => { field('查找内容').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await setField('查找内容', 'shurufa');
    expect(counter()).toBe('1 / 2');
    await setField('查找内容', '输入法');
    await act(() => { field('查找内容').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入法' })); });
    expect(counter()).toBe('1 / 1');
  });
});
