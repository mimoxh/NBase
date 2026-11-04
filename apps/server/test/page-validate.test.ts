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

test('rejects excessive content size', () => {
  const large = content();
  large.editorState.root.children[0]!.children[0]!.text = '字'.repeat(400_000);
  reject(large, 'CONTENT_INVALID');
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
