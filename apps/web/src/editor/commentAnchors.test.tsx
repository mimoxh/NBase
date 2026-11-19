// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCommentAnchor } from '@nbase/contracts';
import { DocumentEditor } from './DocumentEditor';
import { commentQuote } from './commentAnchors';
import { createContentFromMarkdown } from './markdown';
import type { DocumentEditorHandle } from './types';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function select(text: string, start = 0, end?: number) {
  const walker = document.createTreeWalker(host.querySelector('[aria-label="文档正文"]')!, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes(text)) {
      const offset = node.data.indexOf(text);
      const range = document.createRange();
      range.setStart(node, offset + start);
      range.setEnd(node, offset + (end ?? start));
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      return;
    }
  }
  throw new Error(`no text ${text}`);
}

describe('comment anchors', () => {
  it('normalizes quotes to one line within the limit', () => {
    expect(commentQuote(' 第一行\n\t第二行 \u0007 ')).toBe('第一行 第二行');
    expect([...commentQuote('字'.repeat(600))]).toHaveLength(500);
  });

  it('anchors the block under the selection in a read-only page and finds it again after edits elsewhere', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const content = createContentFromMarkdown('# 标题\n\n第一段文字\n\n- 列表一\n- 列表二\n\n最后一段');
    await act(() => root.render(<DocumentEditor ref={ref} documentId="comments" initialContent={content} readOnly onChange={() => {}} />));
    expect(ref.current!.commentAnchor()).toBeNull();

    select('列表二', 0, 2);
    const listAnchor = ref.current!.commentAnchor()!;
    expect(isCommentAnchor(listAnchor)).toBe(true);
    expect(listAnchor).toMatchObject({ blockId: null, quote: '列表' });
    expect(listAnchor.path).toHaveLength(2);

    select('第一段文字', 1);
    const paragraph = ref.current!.commentAnchor()!;
    expect(paragraph).toEqual({ blockId: null, path: [1], quote: '第一段文字' });
    expect(ref.current!.locateComment(paragraph, false)).toBe(true);

    const moved = createContentFromMarkdown('新开头\n\n# 标题\n\n第一段文字\n\n最后一段');
    await act(() => root.render(<DocumentEditor key="moved" ref={ref} documentId="comments" initialContent={moved} readOnly onChange={() => {}} />));
    // The path now points at the heading, which no longer holds the quote; the text search finds the paragraph.
    expect(ref.current!.locateComment(paragraph, false)).toBe(true);
    expect(ref.current!.locateComment({ blockId: null, path: [9], quote: '已删除的句子' }, false)).toBe(false);
    expect(ref.current!.locateComment({ blockId: 'zzzz0000', path: [9], quote: '' }, false)).toBe(false);
  });

  it('prefers a block anchor id when the block has one', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const content = createContentFromMarkdown('<!-- ^para0001 -->\n\n带锚点的段落\n\n另一段');
    await act(() => root.render(<DocumentEditor ref={ref} documentId="anchored" initialContent={content} onChange={() => {}} />));
    select('带锚点的段落', 2);
    const anchor = ref.current!.commentAnchor()!;
    expect(anchor.blockId).toBe('para0001');
    expect(ref.current!.locateComment({ ...anchor, path: [5], quote: '完全不同的文字' }, true)).toBe(true);
  });
});
