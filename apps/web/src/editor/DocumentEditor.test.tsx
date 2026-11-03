// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentEditor } from './DocumentEditor';
import { createContentFromMarkdown } from './markdown';
import { preparePastedHtml } from './plugins/SafePastePlugin';
import type { DocumentEditorHandle } from './types';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // jsdom has no layout; these stand-ins do not validate real selection geometry.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mounted document editor', () => {
  it('opens versioned content, exposes current Markdown and does not mark initial load dirty', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const onReady = vi.fn();
    const onChange = vi.fn();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="a"
      initialContent={createContentFromMarkdown('# 中文标题\n\n正文 **加粗**。')}
      onReady={onReady} onChange={onChange} />));
    expect(host.querySelector('[aria-label="文档正文"]')?.textContent).toContain('正文 加粗');
    expect(host.querySelector('h1')?.textContent).toBe('中文标题');
    expect(ref.current?.getSnapshot().markdown).toContain('**加粗**');
    expect(onReady).toHaveBeenCalledWith('a', expect.objectContaining({ plainText: expect.stringContaining('中文标题') }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('remounts by document identity and never reports the previous document as the new one', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const onReady = vi.fn();
    const onChange = vi.fn();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="a" initialMarkdown="文档 A" onReady={onReady} onChange={onChange} />));
    const a = ref.current!.getSnapshot().content;
    await act(() => root.render(<DocumentEditor ref={ref} documentId="b" initialMarkdown="文档 B" onReady={onReady} onChange={onChange} />));
    expect(ref.current!.getSnapshot().plainText).toBe('文档 B');
    await act(() => root.render(<DocumentEditor ref={ref} documentId="a" initialContent={a} onReady={onReady} onChange={onChange} />));
    expect(ref.current!.getSnapshot().plainText).toBe('文档 A');
    expect(onReady.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('locates a search phrase spanning plain and formatted text without editing the document', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const onChange = vi.fn();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="search"
      initialContent={createContentFromMarkdown('中文**混排**测试')}
      onChange={onChange} />));
    const before = ref.current!.getSnapshot().markdown;
    expect(ref.current!.findText('文混排测')).toBe(true);
    expect(window.getSelection()?.toString()).toBe('文混排测');
    expect(ref.current!.findText('不存在')).toBe(false);
    expect(ref.current!.getSnapshot().markdown).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('toggles reading mode without replacing content or enabling edit controls', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const onChange = vi.fn();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="a" initialMarkdown="保留内容" onChange={onChange} />));
    await act(() => root.render(<DocumentEditor ref={ref} documentId="a" initialMarkdown="不应重新加载" readOnly onChange={onChange} />));
    expect(host.querySelector('[aria-label="文档正文"]')?.getAttribute('contenteditable')).toBe('false');
    expect((host.querySelector('[aria-label="插入 3 × 3 表格"]') as HTMLButtonElement).disabled).toBe(true);
    expect(ref.current!.getSnapshot().plainText).toBe('保留内容');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies a block command and immediately exports the changed document', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const onChange = vi.fn();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="a" initialMarkdown="待转换段落" onChange={onChange} />));
    await act(() => ref.current!.focus());
    const select = host.querySelector('[aria-label="段落样式"]') as HTMLSelectElement;
    await act(() => { select.value = 'h2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(ref.current!.getSnapshot().markdown).toContain('## 待转换段落');
    expect(host.querySelector('h2')?.textContent).toBe('待转换段落');
    expect(onChange).toHaveBeenCalledWith('a', expect.objectContaining({ markdown: expect.stringContaining('## 待转换段落') }));
  });

  it('inserts a real table and can undo and redo it', async () => {
    const ref = createRef<DocumentEditorHandle>();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="table" initialMarkdown="表格示例" onChange={() => {}} />));
    await act(() => ref.current!.focus());
    await act(() => (host.querySelector('[aria-label="插入 3 × 3 表格"]') as HTMLButtonElement).click());
    expect(host.querySelectorAll('table tr')).toHaveLength(3);
    expect(host.querySelectorAll('table td,table th')).toHaveLength(9);
    expect(ref.current!.getSnapshot().markdown).toContain('| --- | --- | --- |');
    const undo = host.querySelector('[aria-label="撤销"]') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    await act(() => undo.click());
    expect(host.querySelector('table')).toBeNull();
    await act(() => (host.querySelector('[aria-label="重做"]') as HTMLButtonElement).click());
    expect(host.querySelectorAll('table tr')).toHaveLength(3);
  });

  it('keeps readable rich paste while warning only about unsupported media and unsafe links', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const notice = vi.fn();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="paste" initialMarkdown="" onChange={() => {}} onNotice={notice} />));
    await act(() => ref.current!.focus());
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      getData: (type: string) => type === 'text/html' ? '<p>正文<a href="javascript:alert(1)">危险</a><img src="https://example.com/a.png" alt="图片"></p>' : '正文危险图片',
      files: [],
    } });
    await act(() => { host.querySelector('[aria-label="文档正文"]')!.dispatchEvent(event); });
    expect(ref.current!.getSnapshot().plainText).toContain('正文危险[图片：https://example.com/a.png]');
    expect(host.querySelector('a')).toBeNull();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('不安全链接'));
    expect(notice.mock.lastCall?.[0]).not.toContain('没有可读取的文本');
  });

  it('recovers text from unsafe editor clipboard data when no plain-text flavor exists', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const notice = vi.fn();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="paste-internal" initialMarkdown="" onChange={() => {}} onNotice={notice} />));
    await act(() => ref.current!.focus());
    const event = new Event('paste', { bubbles: true, cancelable: true });
    const payload = JSON.stringify({ namespace: 'nbase-document', nodes: [{ type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', text: '保留文字' }] }] });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'application/x-lexical-editor' ? payload : '', files: [] } });
    await act(() => { host.querySelector('[aria-label="文档正文"]')!.dispatchEvent(event); });
    expect(ref.current!.getSnapshot().plainText).toContain('保留文字');
    expect(host.querySelector('a')).toBeNull();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('不安全的结构'));
  });

  it('inserts a pasted uploaded image only into the document that began the upload', async () => {
    const ref = createRef<DocumentEditorHandle>();
    const metadata = { id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
      fileName: '截图.png', mediaType: 'image/png', byteSize: 68, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() };
    let finishUpload: ((items: typeof metadata[]) => void) | undefined;
    const upload = vi.fn(() => new Promise<typeof metadata[]>(resolve => { finishUpload = resolve; }));
    const pasteFile = async () => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => '',
        files: [new File(['image'], '截图.png', { type: 'image/png' })] } });
      await act(() => { host.querySelector('[aria-label="文档正文"]')!.dispatchEvent(event); });
    };
    await act(() => root.render(<DocumentEditor ref={ref} documentId="a" initialMarkdown=""
      onChange={() => {}} onUploadFiles={upload} />));
    await act(() => ref.current!.focus());
    await pasteFile();
    expect(upload).toHaveBeenCalledTimes(1);
    await act(async () => { finishUpload!([metadata]); });
    expect(ref.current!.getSnapshot().markdown).toContain(`nbase-attachment:${metadata.id}`);

    await pasteFile();
    await act(() => root.render(<DocumentEditor ref={ref} documentId="b" initialMarkdown="新页面"
      onChange={() => {}} onUploadFiles={upload} />));
    await act(async () => { finishUpload!([metadata]); });
    expect(ref.current!.getSnapshot().markdown).toContain('新页面');
    expect(ref.current!.getSnapshot().markdown).not.toContain('nbase-attachment:');
  });
});

describe('HTML paste boundary', () => {
  it('removes executable markup and unsafe URLs, retaining visible text and image references', () => {
    const result = preparePastedHtml('<script>alert(1)</script><p onclick="alert(1)">正文<a href="java&#x73;cript:alert(1)">链接文字</a><img src="https://example.com/p.png" alt="图片说明" onerror="alert(1)"></p>');
    expect(result.document.querySelector('script,img,[onclick],[onerror],a')).toBeNull();
    expect(result.plainText).toContain('正文链接文字');
    expect(result.plainText).toContain('图片说明：https://example.com/p.png');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('preserves nested and merged table text with an explicit downgrade notice', () => {
    const result = preparePastedHtml('<table><tr><td colspan="2">外层<table><tr><td>内层</td></tr></table></td></tr></table>');
    expect(result.plainOnly).toBe(true);
    expect(result.plainText).toContain('外层');
    expect(result.plainText).toContain('内层');
    expect(result.warnings.join(' ')).toContain('文本');
  });
});
