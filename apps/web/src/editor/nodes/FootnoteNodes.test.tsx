// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { createContentFromMarkdown } from '../markdown';
import { EDITOR_NODES } from '../nodes';
import { FootnoteNavigationPlugin } from './FootnoteNodes';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const reveal = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  reveal.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount(markdown: string, readOnly: boolean) {
  const content = createContentFromMarkdown(markdown);
  await act(() => root.render(<LexicalComposer initialConfig={{ namespace: 'footnotes-test', nodes: EDITOR_NODES,
    editorState: JSON.stringify(content.editorState), editable: !readOnly, onError: error => { throw error; } }}>
    <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
    <FootnoteNavigationPlugin reveal={reveal} />
  </LexicalComposer>));
}

it.each([false, true])('returns to the clicked repeated reference and reveals the target in read-only mode %s', async readOnly => {
  await mount('正文[^a] 与第二处[^a]。\n\n[^a]: 注释正文。', readOnly);
  const references = host.querySelectorAll<HTMLButtonElement>('[data-nbase-footnote-ref]');
  const back = host.querySelector<HTMLButtonElement>('[data-nbase-footnote-back]')!;
  expect(references).toHaveLength(2);
  expect(host.querySelector('[data-nbase-footnote-definition]')?.textContent).toContain('注释正文。');
  await act(() => references[1]!.click());
  expect(document.activeElement).toBe(back);
  expect(reveal).toHaveBeenLastCalledWith(back);
  await act(() => back.click());
  expect(document.activeElement).toBe(references[1]);
  expect(reveal).toHaveBeenLastCalledWith(references[1]);
});

it('falls back to the first reference after initial opening', async () => {
  await mount('第一处[^a] 与第二处[^a]。\n\n[^a]: 说明。', true);
  await act(() => host.querySelector<HTMLButtonElement>('[data-nbase-footnote-back]')!.click());
  expect(document.activeElement).toBe(host.querySelector('[data-nbase-footnote-ref]'));
});
