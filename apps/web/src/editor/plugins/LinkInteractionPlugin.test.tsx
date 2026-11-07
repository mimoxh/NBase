// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import {
  $createParagraphNode, $createTextNode, $getRoot, KEY_ENTER_COMMAND, KEY_SPACE_COMMAND, UNDO_COMMAND,
  type ElementNode, type LexicalEditor, type TextNode,
} from 'lexical';
import { $pasteUrl, standaloneUrl, trailingUrl } from '../autoLink';
import { createContentFromMarkdown, isSafeLinkUrl, readEditorSnapshot } from '../markdown';
import { EDITOR_NODES } from '../nodes';
import { DocumentEditor } from '../DocumentEditor';
import { LinkInteractionPlugin } from './LinkInteractionPlugin';

let host: HTMLDivElement;
let root: Root;
let editor!: LexicalEditor;

function Capture() {
  [editor] = useLexicalComposerContext();
  return null;
}

async function mount(markdown: string, editable = true) {
  const initial = createContentFromMarkdown(markdown);
  await act(() => root.render(<LexicalComposer initialConfig={{
    namespace: 'link-test', nodes: EDITOR_NODES, editable, editorState: JSON.stringify(initial.editorState),
    theme: { link: 'nbase-link' }, onError: error => { throw error; },
  }}>
    <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
    <HistoryPlugin /><LinkPlugin validateUrl={isSafeLinkUrl} /><LinkInteractionPlugin /><Capture />
  </LexicalComposer>));
}

async function typed(text: string) {
  await act(() => editor.update(() => {
    const paragraph = $createParagraphNode().append($createTextNode(text));
    $getRoot().clear().append(paragraph);
    paragraph.selectEnd();
  }, { discrete: true }));
}

async function space() {
  const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
  await act(() => { editor.dispatchCommand(KEY_SPACE_COMMAND, event); });
  return event;
}

const markdown = () => readEditorSnapshot(editor.getEditorState()).markdown;
const anchor = () => host.querySelector<HTMLAnchorElement>('a.nbase-link')!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('URL detection', () => {
  it('finds a URL ending at the caret and leaves prose punctuation outside', () => {
    expect(trailingUrl('见 https://a.com/x')).toMatchObject({ start: 2, text: 'https://a.com/x', url: 'https://a.com/x' });
    expect(trailingUrl('见https://a.com')).toMatchObject({ start: 1, text: 'https://a.com' });
    expect(trailingUrl('www.a.com')).toMatchObject({ url: 'https://www.a.com' });
    expect(trailingUrl('https://a.com.')).toMatchObject({ text: 'https://a.com' });
    expect(trailingUrl('(https://a.com/x_(y))')).toMatchObject({ text: 'https://a.com/x_(y)' });
  });

  it('ignores Markdown link syntax, page triggers and things that are not URLs', () => {
    for (const text of ['[a](https://a.com', '[[https://a.com', 'xhttps://a.com', 'www.a', 'https://', 'a.com', 'javascript:alert(1)']) {
      expect(trailingUrl(text)).toBeNull();
    }
  });

  it('accepts only clipboard text that is one safe URL', () => {
    expect(standaloneUrl(' https://a.com/中文 \n')).toMatchObject({ url: 'https://a.com/中文' });
    expect(standaloneUrl('https://a.com 和其他文字')).toBeNull();
    expect(standaloneUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('typing', () => {
  it('links a URL on space with one undo step back to plain text', async () => {
    await mount('正文');
    await typed('看 https://a.com');
    expect((await space()).defaultPrevented).toBe(true);
    expect(markdown()).toBe('看 [https://a.com](https://a.com) ');
    expect(anchor().getAttribute('href')).toBe('https://a.com');
    await act(() => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
    expect(markdown()).toBe('看 https://a.com');
    expect(host.querySelector('a')).toBeNull();
  });

  it('links on Enter and keeps a trailing full stop outside the link', async () => {
    await mount('正文');
    await typed('https://a.com.');
    await act(() => { editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent('keydown', { key: 'Enter' })); });
    expect(markdown()).toContain('[https://a.com](https://a.com).');
  });

  it('skips composition, inline code and existing links', async () => {
    await mount('正文');
    await typed('https://a.com');
    const composing = new KeyboardEvent('keydown', { key: ' ', isComposing: true });
    await act(() => { editor.dispatchCommand(KEY_SPACE_COMMAND, composing); });
    expect(host.querySelector('a')).toBeNull();

    await act(() => editor.update(() => {
      const text = $createTextNode('https://a.com').toggleFormat('code');
      const paragraph = $createParagraphNode().append(text);
      $getRoot().clear().append(paragraph);
      text.selectEnd();
    }, { discrete: true }));
    expect((await space()).defaultPrevented).toBe(false);
    expect(host.querySelector('a')).toBeNull();
  });

  it('pastes a URL as a link at the caret or over selected words', async () => {
    await mount('正文');
    await typed('前');
    await act(() => editor.update(() => { $pasteUrl(editor, 'https://a.com'); }, { discrete: true }));
    expect(markdown()).toBe('前[https://a.com](https://a.com)');

    await typed('选中');
    await act(() => editor.update(() => {
      $getRoot().getFirstDescendant()!.selectStart();
      $getRoot().getFirstChild<ElementNode>()!.select(0, 1);
    }, { discrete: true }));
    await act(() => editor.update(() => { $pasteUrl(editor, 'https://b.com'); }, { discrete: true }));
    expect(markdown()).toBe('[选中](https://b.com)');
  });
});

describe('opening and the card', () => {
  it('opens on a read-only click, and only with Ctrl or Cmd while editing', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await mount('[文字](https://a.com)', false);
    const readOnlyClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(() => { anchor().dispatchEvent(readOnlyClick); });
    expect(readOnlyClick.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://a.com', '_blank', 'noopener,noreferrer');

    open.mockClear();
    await act(() => { editor.setEditable(true); });
    await act(() => { anchor().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(open).not.toHaveBeenCalled();
    await act(() => { anchor().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows the card for the caret, edits the address and removes the link without losing its text', async () => {
    await mount('[文字](https://a.com) 后');
    await act(() => editor.update(() => { ($getRoot().getFirstDescendant() as TextNode).select(1, 1); }, { discrete: true }));
    const card = () => host.querySelector<HTMLElement>('.nbase-link-card');
    const button = (label: string) => [...card()!.querySelectorAll('button')].find(item => item.textContent === label)!;
    expect(card()?.textContent).toContain('https://a.com');

    await act(() => button('编辑').click());
    const input = card()!.querySelector('input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(() => { set.call(input, 'javascript:alert(1)'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => button('应用').click());
    expect(card()!.querySelector('[role="alert"]')).not.toBeNull();
    expect(markdown()).toContain('(https://a.com)');

    await act(() => { set.call(input, 'https://b.com'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => button('应用').click());
    expect(markdown()).toContain('[文字](https://b.com)');

    await act(() => editor.update(() => { $getRoot().getFirstDescendant()!.selectStart(); }, { discrete: true }));
    await act(() => editor.update(() => { ($getRoot().getFirstDescendant() as TextNode).select(1, 1); }, { discrete: true }));
    await act(() => button('移除').click());
    expect(markdown()).toBe('文字 后');
    expect(card()).toBeNull();
  });

  it('offers only opening and copying on read-only pages', async () => {
    vi.useFakeTimers();
    try {
      await mount('[文字](https://a.com)', false);
      await act(() => { anchor().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
      await act(() => { vi.advanceTimersByTime(250); });
      const labels = [...host.querySelectorAll('.nbase-link-card button')].map(item => item.textContent);
      expect(labels).toEqual(['打开', '复制']);
    } finally { vi.useRealTimers(); }
  });
});

it('never rewrites a stored bare URL merely by opening the page', async () => {
  const onChange = vi.fn();
  const content = createContentFromMarkdown('裸网址 https://a.com 和 www.b.com 保持文字');
  await act(() => root.render(<DocumentEditor documentId="bare-url" initialContent={content} onChange={onChange} />));
  await act(async () => { await Promise.resolve(); });
  expect(onChange).not.toHaveBeenCalled();
  expect(host.querySelector('a.nbase-link')).toBeNull();
});
