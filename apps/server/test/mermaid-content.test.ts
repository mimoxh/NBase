import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentValidationError, validateDocumentContent } from '../src/pages/validate.js';
import { extractSearchText } from '../src/pages/search-text.js';

const source = '%%{ init: {"securityLevel": "loose"}}%%\nflowchart TD\n  A[原始 🎉 源码] --> B[保留]';
const node = { type: 'mermaid', version: 1, source };
function content(block: unknown = node) {
  return { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [block] } } };
}

test('stores Mermaid source verbatim including unsupported or invalid rendering syntax', () => {
  const saved = validateDocumentContent(content());
  assert.deepEqual(saved, content());
  assert.match(extractSearchText(saved), /A\[原始 🎉 源码\] --> B\[保留\]/);
  assert.equal(extractSearchText(saved).includes('"source"'), false);
});

test('Mermaid source rejects malformed leaves, invalid Unicode and oversized documents', () => {
  for (const change of [
    { source: 3 }, { source: null }, { source: '\u0000' }, { source: '\ud800' },
    { source: '字'.repeat(400_000) }, { children: [] }, { version: 2 },
  ]) {
    assert.throws(() => validateDocumentContent(content({ ...node, ...change })), ContentValidationError);
  }
});

test('rejects Mermaid embedded in links, code and tables', () => {
  for (const parent of [
    { type: 'link', version: 1, url: '/local', children: [node] },
    { type: 'autolink', version: 1, url: 'https://example.com', children: [node] },
    { type: 'code', version: 1, children: [node] },
    { type: 'table', version: 1, children: [{ type: 'tablerow', version: 1, children: [
      { type: 'tablecell', version: 1, colSpan: 1, rowSpan: 1, children: [node] },
    ] }] },
  ]) {
    assert.throws(() => validateDocumentContent(content(parent)), ContentValidationError);
  }
});
