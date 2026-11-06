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
import { $getRoot, KEY_ARROW_DOWN_COMMAND, KEY_ENTER_COMMAND, UNDO_COMMAND, type LexicalEditor } from 'lexical';
import type { PageSummary } from '@nbase/contracts';
import { $createSnapshot, createContentFromMarkdown } from '../markdown';
import { EDITOR_NODES } from '../nodes';
import { PageReferencesProvider } from '../nodes/PageReferenceNode';
import { buildPageReferenceCatalog, searchPageReferences } from '../pageReferenceCatalog';
import { PageReferencePlugin } from './PageReferencePlugin';

const id = (suffix: number) => `11111111-1111-4111-8111-${String(suffix).padStart(12, '0')}`;
const summary = (suffix: number, title: string, parentId: string | null = null): PageSummary => ({
  id: id(suffix), workspaceId: id(9), parentId, title, icon: null, cover: null, revision: '1', createdAt: '', updatedAt: '',
});
const pages = [summary(1, '研发'), summary(2, '运营'), summary(3, '同名', id(1)), summary(4, '同名', id(2)), summary(5, '唯一')];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let editor: LexicalEditor;
const open = vi.fn();

function CaptureEditor() {
  [editor] = useLexicalComposerContext();
  return null;
}

function mount(markdown: string, available = pages) {
  const initial = createContentFromMarkdown(markdown);
  const history = createEmptyHistoryState();
  return act(() => root.render(<PageReferencesProvider references={{ pages: available, open }}>
    <LexicalComposer initialConfig={{ namespace: 'reference-test', nodes: EDITOR_NODES,
      editorState: JSON.stringify(initial.editorState), onError: error => { throw error; } }}>
      <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
      <HistoryPlugin externalHistoryState={history} />
      <PageReferencePlugin historyState={history} />
      <CaptureEditor />
    </LexicalComposer>
  </PageReferencesProvider>));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  open.mockClear();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('finds same-title candidates by their parent path', () => {
  const catalog = buildPageReferenceCatalog(pages);
  expect(searchPageReferences(catalog, '同名').map(option => [option.id, option.parentPath]))
    .toEqual([[id(3), '研发'], [id(4), '运营']]);
  expect(searchPageReferences(catalog, '运营 / 同名').map(option => option.id)).toEqual([id(4)]);
});

it('previews old references without editing, converts only unique targets and undoes them together', async () => {
  await mount('前 **[[唯一]]** 和 [[唯一]]，还有 [[同名]]、[[缺失]] 与 `[[唯一]]`。');
  const before = editor.read('latest', $createSnapshot).content;
  expect(host.querySelector('[data-nbase-page-reference]')).toBeNull();
  expect(host.textContent).toContain('2 处可以转换，2 处将保留原文');
  const apply = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '转换可唯一解析的引用')!;
  await act(() => apply.click());
  expect(Array.from(host.querySelectorAll('[data-nbase-page-reference]')).map(node => node.getAttribute('data-nbase-page-reference')))
    .toEqual([id(5), id(5)]);
  expect(editor.read('latest', $createSnapshot).plainText).toContain('还有 [[同名]]、[[缺失]] 与 [[唯一]]。');
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(editor.read('latest', $createSnapshot).content).toEqual(before);
  expect(host.textContent).toContain('2 处可以转换，2 处将保留原文');
});

it('selects a duplicate title by keyboard while composing Enter keeps the query as text', async () => {
  await mount('正文 ');
  const body = host.querySelector<HTMLElement>('[contenteditable]')!;
  await act(() => {
    body.focus();
    editor.update(() => $getRoot().selectEnd().insertText('[[同名'), { discrete: true });
  });
  const choices = () => Array.from(document.querySelectorAll('[aria-label="引用页面"] [role="option"]'));
  expect(choices().map(node => node.textContent)).toEqual(['同名研发', '同名运营']);
  await act(() => { editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent('keydown', { key: 'Enter', isComposing: true })); });
  expect(host.querySelector('[data-nbase-page-reference]')).toBeNull();
  await act(() => { editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
  expect(choices()[1]?.getAttribute('aria-selected')).toBe('true');
  await act(() => { editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent('keydown', { key: 'Enter' })); });
  const reference = host.querySelector(`[data-nbase-page-reference="${id(4)}"] a`);
  expect(reference?.textContent).toBe('同名');
  await act(() => { (reference as HTMLAnchorElement).click(); });
  expect(open).toHaveBeenCalledWith(id(4));
});
