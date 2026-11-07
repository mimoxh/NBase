import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDocumentIndex, extractSearchText } from '../src/pages/search-text.js';

test('search text follows visible Chinese content across formatting without indexing link URLs or JSON keys', () => {
  const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [
      { type: 'text', version: 1, text: '项' },
      { type: 'text', version: 1, text: '目计划', format: 1 },
      { type: 'link', version: 1, url: 'https://private.example/never-search-this', children: [
        { type: 'text', version: 1, text: ' API' },
      ] },
    ] },
    { type: 'paragraph', version: 1, children: [{ type: 'attachment', version: 1,
      attachmentId: '11111111-1111-4111-8111-111111111111', fileName: '架构图.png', alt: '架构说明', mediaType: 'image/png', caption: '系统图注' }] },
  ] } } };
  const text = extractSearchText(content);
  assert.equal(text, '项目计划 API 架构图.png 架构说明 系统图注');
  assert.equal(text.includes('private.example'), false);
  assert.equal(text.includes('attachmentId'), false);
});

test('search text includes equation source', () => {
  const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [
      { type: 'text', version: 1, text: '面积' },
      { type: 'equation', version: 1, equation: '\\pi r^2', inline: true },
    ] },
    { type: 'equation', version: 1, equation: '\\int_0^1 x dx', inline: false },
  ] } } };
  const text = extractSearchText(content);
  assert.equal(text, '面积 \\pi r^2 \\int_0^1 x dx');
});

test('search text includes a callout title and highlighted body', () => {
  const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
    { type: 'callout', version: 1, kind: 'NOTE', title: '提醒', children: [
      { type: 'paragraph', version: 1, children: [
        { type: 'text', version: 1, text: '编辑' },
        { type: 'text', version: 1, text: '体验', format: 128 },
      ] },
    ] },
  ] } } };
  assert.equal(extractSearchText(content), '提醒 编辑体验');
});

test('indexes page-reference labels and keeps occurrence positions and bounded context', () => {
  const targetPageId = '12345678-1234-1234-1234-123456789abc';
  const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [
      { type: 'text', version: 1, text: `${'旧'.repeat(150)} 前文` },
      { type: 'page-reference', version: 1, targetPageId, label: '目标别名' },
      { type: 'text', version: 1, text: '后文 ' },
      { type: 'page-reference', version: 1, targetPageId, label: '第二处' },
    ] },
  ] } } };
  const index = extractDocumentIndex(content);
  assert.match(index.searchText, /前文目标别名后文 第二处$/);
  assert.equal(index.searchText.includes(targetPageId), false);
  assert.deepEqual(index.references.map(item => [item.targetPageId, item.occurrence]), [[targetPageId, 0], [targetPageId, 1]]);
  assert.match(index.references[0]!.snippet, /^…旧+ 前文目标别名后文 第二处$/);
  assert.ok(index.references[0]!.snippet.length <= 353);
});

test('search includes visible footnote labels and body without indexing front matter', () => {
  const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1,
    $: { nbaseMarkdownFrontMatter: { author: '私有元数据' } }, children: [
      { type: 'paragraph', version: 1, children: [
        { type: 'text', version: 1, text: '正文' }, { type: 'footnote-reference', version: 1, footnoteId: '说明' },
      ] },
      { type: 'footnote-definition', version: 1, footnoteId: '说明', children: [
        { type: 'paragraph', version: 1, children: [
          { type: 'text', version: 1, text: '脚注' }, { type: 'text', version: 1, text: '正文', format: 1 },
        ] },
      ] },
    ] } } };
  assert.equal(extractSearchText(content), '正文 说明 说明 脚注正文');
});
