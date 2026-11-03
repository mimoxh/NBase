import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSearchText } from '../src/pages/search-text.js';

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
      attachmentId: '11111111-1111-4111-8111-111111111111', fileName: '架构图.png', alt: '架构说明', mediaType: 'image/png' }] },
  ] } } };
  const text = extractSearchText(content);
  assert.equal(text, '项目计划 API 架构图.png 架构说明');
  assert.equal(text.includes('private.example'), false);
  assert.equal(text.includes('attachmentId'), false);
});
