import type { StoredDocumentContent } from '@nbase/contracts';
import { textStyleCss } from '@nbase/contracts';
import type { SerializedNode } from './tree';

/** Test builders for serialized Lexical JSON (kept beside the exporter so both test files share them). */
export const text = (value: string, format = 0, style = ''): SerializedNode => ({ type: 'text', version: 1, text: value, format, style, mode: 'normal', detail: 0 });
export const paragraph = (children: SerializedNode[], format = ''): SerializedNode => ({ type: 'paragraph', version: 1, format, indent: 0, direction: null, children });
export const heading = (tag: string, children: SerializedNode[], format = ''): SerializedNode => ({ type: 'heading', version: 1, tag, format, indent: 0, children });
export const list = (listType: string, items: SerializedNode[], start = 1): SerializedNode => ({ type: 'list', version: 1, listType, start, tag: listType === 'number' ? 'ol' : 'ul', children: items });
export const item = (children: SerializedNode[], checked?: boolean): SerializedNode => ({ type: 'listitem', version: 1, value: 1, children, ...(checked === undefined ? {} : { checked }) });
export const cell = (children: SerializedNode[], headerState = 0, extra: Record<string, unknown> = {}): SerializedNode =>
  ({ type: 'tablecell', version: 1, headerState, colSpan: 1, rowSpan: 1, children, ...extra });
export const row = (cells: SerializedNode[]): SerializedNode => ({ type: 'tablerow', version: 1, children: cells });
export const table = (rows: SerializedNode[], extra: Record<string, unknown> = {}): SerializedNode => ({ type: 'table', version: 1, children: rows, ...extra });
export const content = (children: SerializedNode[]): StoredDocumentContent =>
  ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0, direction: null, children } } }) as unknown as StoredDocumentContent;
export const red = textStyleCss({ color: 'red', background: 'yellow' });

export const imageId = '11111111-1111-4111-8111-111111111111';
export const pdfId = '22222222-2222-4222-8222-222222222222';
export const audioId = '33333333-3333-4333-8333-333333333333';
export const pageId = '44444444-4444-4444-8444-444444444444';

/** A PNG header with the given size; enough for size sniffing and packaging. */
export function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

export function sampleDocument(): StoredDocumentContent {
  return content([
    heading('h2', [text('第二级标题')], 'center'),
    paragraph([text('粗体', 1), text('斜体', 2), text('删除', 4), text('代码', 16), text('高亮', 128), text('彩色', 0, red),
      { type: 'link', version: 1, url: 'https://example.com/a?b=1&c=2', children: [text('安全链接')] },
      { type: 'page-reference', version: 1, targetPageId: pageId, label: '另一页' },
      { type: 'footnote-reference', version: 1, footnoteId: '1' },
      { type: 'equation', version: 1, equation: 'a^2+b^2', inline: true }], 'justify'),
    paragraph([text('右对齐')], 'right'),
    list('bullet', [item([text('一')]), item([list('bullet', [item([text('一.一')])])]), item([text('二')])]),
    list('number', [item([text('第一步')]), item([text('第二步')])], 3),
    list('number', [item([text('重新开始')])]),
    list('check', [item([text('完成')], true), item([text('待办')], false)]),
    { type: 'quote', version: 1, children: [text('引用文字')] },
    { type: 'callout', version: 1, kind: 'WARNING', title: '小心', children: [paragraph([text('提示正文')])] },
    { type: 'toggle', version: 1, children: [paragraph([text('折叠标题')]), paragraph([text('折叠正文')])] },
    { type: 'code', version: 1, language: 'javascript', children: [text('const a = 1;'), { type: 'linebreak', version: 1 }, { type: 'tab', version: 1 }, text('a < 2')] },
    table([row([cell([paragraph([text('表头')])], 1), cell([paragraph([text('列二')])], 1)]), row([cell([paragraph([text('甲')])]), cell([paragraph([text('乙')], 'center')])])]),
    { type: 'horizontalrule', version: 1 },
    paragraph([{ type: 'attachment', version: 1, attachmentId: imageId, alt: '示意图', fileName: 'a.png', mediaType: 'image/png', width: 50, align: 'center', caption: '图一' }]),
    { type: 'equation', version: 1, equation: '\\frac{1}{2}', inline: false },
    { type: 'mermaid', version: 1, source: 'flowchart LR\nA-->B' },
    { type: 'database-view', version: 1, databaseId: pageId, viewId: null },
    paragraph([{ type: 'image-reference', version: 1, text: '', markdown: '![外图](https://example.com/x.png)', alt: '外图' }]),
    { type: 'footnote-definition', version: 1, footnoteId: '1', children: [paragraph([text('脚注内容')])] },
  ]);
}
