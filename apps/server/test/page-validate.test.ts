import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentValidationError, validateDocumentContent } from '../src/pages/validate.js';

function content() {
  return {
    schemaVersion: 1,
    editorState: { root: {
      type: 'root', version: 1, children: [{
        type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: '测试', style: '' }],
      }],
    } },
  };
}

function reject(value: unknown, code: ContentValidationError['code']) {
  assert.throws(() => validateDocumentContent(value), (error: unknown) => error instanceof ContentValidationError && error.code === code);
}

test('accepts supported versioned Lexical content', () => {
  assert.equal(validateDocumentContent(content()).schemaVersion, 1);
});

test('rejects unknown versions and nodes rather than replacing stored content', () => {
  const unknownVersion = content();
  unknownVersion.schemaVersion = 2;
  reject(unknownVersion, 'CONTENT_VERSION_UNSUPPORTED');
  const unknownNode = content();
  unknownNode.editorState.root.children[0]!.type = 'future-widget';
  reject(unknownNode, 'CONTENT_INVALID');
});

test('rejects executable links, custom CSS, nested tables and merged cells', () => {
  const link = content();
  link.editorState.root.children[0] = {
    type: 'link', version: 1, url: 'javascript:alert(1)', children: [{ type: 'text', version: 1, text: 'bad', style: '' }],
  } as never;
  reject(link, 'CONTENT_INVALID');
  const style = content();
  style.editorState.root.children[0]!.children[0]!.style = 'background:url(https://example.test/x)';
  reject(style, 'CONTENT_INVALID');
  const cell = content();
  cell.editorState.root.children[0] = {
    type: 'tablecell', version: 1, colSpan: 2, rowSpan: 1, children: [],
  } as never;
  reject(cell, 'CONTENT_INVALID');
});

test('accepts equation nodes and rejects malformed ones', () => {
  const valid = content();
  valid.editorState.root.children[0]!.children = [
    { type: 'equation', version: 1, equation: 'x^2', inline: true },
    { type: 'equation', version: 1, equation: '\\frac{a}{b}', inline: false },
  ] as never;
  assert.equal(validateDocumentContent(valid).schemaVersion, 1);
  const badSource = content();
  badSource.editorState.root.children[0]!.children = [{ type: 'equation', version: 1, equation: 42, inline: true }] as never;
  reject(badSource, 'CONTENT_INVALID');
  const badInline = content();
  badInline.editorState.root.children[0]!.children = [{ type: 'equation', version: 1, equation: 'x', inline: 'yes' }] as never;
  reject(badInline, 'CONTENT_INVALID');
  const tooLong = content();
  tooLong.editorState.root.children[0]!.children = [{ type: 'equation', version: 1, equation: 'x'.repeat(10_001), inline: true }] as never;
  reject(tooLong, 'CONTENT_INVALID');
});

test('accepts callout kinds and bounded titles with highlighted text', () => {
  const valid = content();
  valid.editorState.root.children[0] = {
    type: 'callout', version: 1, kind: 'WARNING', title: '注意 <原样标题>',
    children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: '亮点', format: 128 }] }],
  } as never;
  assert.equal(validateDocumentContent(valid).schemaVersion, 1);
  for (const changes of [{ kind: 'unknown' }, { title: '换\n行' }, { title: '长'.repeat(121) }, { children: null }]) {
    const invalid = structuredClone(valid);
    Object.assign(invalid.editorState.root.children[0]!, changes);
    reject(invalid, 'CONTENT_INVALID');
  }
});

test('rejects excessive content size', () => {
  const large = content();
  large.editorState.root.children[0]!.children[0]!.text = '字'.repeat(400_000);
  reject(large, 'CONTENT_INVALID');
});

test('page references require a lowercase UUID and a bounded single-line label', () => {
  const valid = content();
  const node = { type: 'page-reference', version: 1, targetPageId: '12345678-1234-1234-1234-123456789abc', label: '架构 API' };
  valid.editorState.root.children[0]!.children = [node] as never;
  assert.equal(validateDocumentContent(valid).schemaVersion, 1);
  for (const overrides of [
    { targetPageId: 'javascript:bad' }, { targetPageId: node.targetPageId.toUpperCase() },
    { label: '  ' }, { label: '行\n内' }, { label: '行\u2028内' }, { label: '字'.repeat(256) }, { children: [] },
  ]) {
    const bad = content();
    bad.editorState.root.children[0]!.children = [{ ...node, ...overrides }] as never;
    reject(bad, 'CONTENT_INVALID');
  }
  for (const type of ['link', 'autolink', 'code']) {
    const wrapped = content();
    wrapped.editorState.root.children[0]!.children = [{ type, version: 1, url: '/target', children: [node] }] as never;
    reject(wrapped, 'CONTENT_INVALID');
  }
});

import { PageFieldError, validatePageCover, validatePageIcon } from '../src/pages/validate.js';

function iconReject(value: unknown) {
  assert.throws(() => validatePageIcon(value), (error: unknown) => error instanceof PageFieldError);
}

test('page icon accepts a single emoji grapheme', () => {
  for (const icon of ['📄', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣', '👍🏽', '❤️', '#️⃣']) {
    assert.equal(validatePageIcon(icon), icon, icon);
  }
  assert.equal(validatePageIcon(null), null);
});

test('page icon rejects non-emoji, multi-grapheme and hostile values', () => {
  for (const bad of ['AB', 'A', 'a', '页', 'x📄', '📄x', '📄📄', ' ', '', '📄 ', '📄\n',
    '📄\u202e', '\u2066📄', '📄\u0000', 'x'.repeat(33), '📄'.repeat(2), 5, {}, ['📄'], undefined]) {
    iconReject(bad);
  }
});

test('page cover only accepts preset identifiers', () => {
  assert.equal(validatePageCover(null), null);
  for (const cover of ['sage', 'ochre', 'slate', 'rose', 'sand', 'sky']) {
    assert.equal(validatePageCover(cover), cover);
  }
  for (const bad of ['beige', 'SAGE', 'https://x', 'sage ', '', 1, {}, ['sage'], undefined]) {
    assert.throws(() => validatePageCover(bad), (error: unknown) => error instanceof PageFieldError);
  }
});

test('front matter is bounded JSON metadata on the document root with a valid calendar date', () => {
  const valid = content();
  Object.assign(valid.editorState.root, { $: { nbaseMarkdownFrontMatter: {
    date: '2024-02-29', author: '作者', options: { reviewed: true, items: [1, null, '中文'] },
  } } });
  assert.equal(validateDocumentContent(valid).schemaVersion, 1);
  for (const metadata of [
    { title: '覆盖页面标题' }, { tags: ['标签'] }, { date: '2023-02-29' }, { date: '2024-13-01' },
    { date: '2024-01-01T00:00:00Z' }, { value: Number.POSITIVE_INFINITY },
    JSON.parse('{"nested":{"__proto__":true}}'), { value: '长'.repeat(6000) }, { value: Array(513).fill('值') },
  ]) {
    const invalid = content();
    Object.assign(invalid.editorState.root, { $: { nbaseMarkdownFrontMatter: metadata } });
    reject(invalid, 'CONTENT_INVALID');
  }
  const misplaced = content();
  Object.assign(misplaced.editorState.root.children[0]!, { $: { nbaseMarkdownFrontMatter: { author: '正文' } } });
  reject(misplaced, 'CONTENT_INVALID');
});

test('footnotes accept repeated references and root definitions but reject malformed or misplaced nodes', () => {
  const reference = { type: 'footnote-reference', version: 1, footnoteId: '中文_1' };
  const definition = { type: 'footnote-definition', version: 1, footnoteId: '中文_1',
    children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: '注释' }] }] };
  const valid = content();
  valid.editorState.root.children[0]!.children = [reference, reference] as never;
  valid.editorState.root.children.push(definition as never);
  assert.equal(validateDocumentContent(valid).schemaVersion, 1);
  for (const overrides of [{ footnoteId: ' ' }, { footnoteId: '<script>' }, { footnoteId: 'x'.repeat(65) }, { children: [] }]) {
    const invalid = structuredClone(valid);
    Object.assign(invalid.editorState.root.children[0]!.children[0]!, overrides);
    reject(invalid, 'CONTENT_INVALID');
  }
  for (const type of ['link', 'code']) {
    const invalid = content();
    invalid.editorState.root.children[0] = { type, version: 1, url: '/safe', children: [reference] } as never;
    reject(invalid, 'CONTENT_INVALID');
  }
  const nested = content();
  nested.editorState.root.children[0]!.children = [definition] as never;
  reject(nested, 'CONTENT_INVALID');
  const malformed = content();
  malformed.editorState.root.children = [{ ...definition, children: undefined }] as never;
  reject(malformed, 'CONTENT_INVALID');
});
