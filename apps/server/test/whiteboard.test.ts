import assert from 'node:assert/strict';
import test from 'node:test';
import { whiteboardContent, whiteboardContentProblem, whiteboardLimits, type WhiteboardElement } from '@nbase/contracts';
import { extractDocumentIndex, extractSearchText } from '../src/pages/search-text.js';
import { attachmentReferences, ContentValidationError, validateDocumentContent } from '../src/pages/validate.js';
import { contentMatchesKind } from '../src/whiteboards/content.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const box = { x: 0, y: 0, w: 120, h: 80, angle: 0 };
const shape = (n: number, extra: object = {}): WhiteboardElement => ({ id: id(n), type: 'shape', shape: 'rect', ...box,
  fill: '#ffffff', stroke: '#1f2328', strokeWidth: 2, strokeStyle: 'solid', text: '', textColor: '#1f2328', fontSize: 16,
  textAlign: 'center', ...extra });
const connector = (n: number, from: number, to: number): WhiteboardElement => ({ id: id(n), type: 'connector', mode: 'elbow',
  source: { x: 0, y: 0, bind: { elementId: id(from), ax: 1, ay: 0.5 } }, target: { x: 10, y: 10, bind: { elementId: id(to), ax: 0, ay: 0.5 } },
  stroke: '#1f2328', strokeWidth: 2, strokeStyle: 'solid', startArrow: 'none', endArrow: 'arrow', text: '流向' });

function rejects(value: unknown) {
  assert.throws(() => validateDocumentContent(value), (error: unknown) => error instanceof ContentValidationError && error.code === 'CONTENT_INVALID');
}
const withElements = (...elements: unknown[]) => ({ ...whiteboardContent([]), board: { elements } });

test('accepts every element type and keeps the board distinguishable from documents', () => {
  const content = whiteboardContent([
    { id: id(9), type: 'frame', ...box, w: 800, h: 600, name: '第一页' },
    shape(1, { text: '开始' }), shape(2, { shape: 'diamond', text: '判断', mindParentId: null }), shape(3, { mindParentId: id(2) }),
    connector(4, 1, 2),
    { id: id(5), type: 'note', ...box, text: '便签\n第二行', color: '#fff3b0', fontSize: 16, textAlign: 'left' },
    { id: id(6), type: 'text', ...box, text: '标题文字', color: '#1f2328', fontSize: 24, textAlign: 'left', bold: true },
    { id: id(7), type: 'pen', ...box, points: [0, 0, 5.5, 8, 12, 3], color: '#d1242f', strokeWidth: 3, highlighter: true },
    { id: id(8), type: 'image', ...box, attachmentId: id(80), fileName: '图.png', mediaType: 'image/png' },
    { id: id(10), type: 'card', ...box, pageId: id(90), label: '源文档' },
  ]);
  assert.equal(whiteboardContentProblem(content), null);
  assert.equal(validateDocumentContent(content), content);
  assert.equal(contentMatchesKind('whiteboard', content), true);
  assert.equal(contentMatchesKind('document', content), false);
  assert.equal(contentMatchesKind('whiteboard', { schemaVersion: 1, editorState: content.editorState }), false);
  assert.equal(extractSearchText(content), '第一页 开始 判断 流向 便签 第二行 标题文字 图.png 源文档');
  assert.deepEqual(extractDocumentIndex(content).references, [{ targetPageId: id(90), occurrence: 0, snippet: '源文档' }]);
  assert.deepEqual(attachmentReferences(content), [{ id: id(80), fileName: '图.png', mediaType: 'image/png' }]);
  // JSONB reorders keys and an older client may send an empty root; both stay valid.
  assert.equal(whiteboardContentProblem({ board: content.board, editorState: { root: { version: 1, type: 'root', children: [] } }, schemaVersion: 1 }), null);
});

test('rejects unknown types, extra keys, unsafe values and a non-empty document body', () => {
  rejects(withElements({ ...shape(1), type: 'widget' }));
  rejects(withElements({ ...shape(1), onclick: 'x' }));
  rejects(withElements(JSON.parse(`{"__proto__":{"a":1},${JSON.stringify(shape(1)).slice(1)}`)));
  rejects(withElements({ ...shape(1), constructor: 1 }));
  rejects(withElements({ ...shape(1), id: 'not-a-uuid' }));
  rejects(withElements({ ...shape(1), id: id(1).toUpperCase().replace('0', 'A') }));
  rejects(withElements({ ...shape(1), x: Number.NaN }));
  rejects(withElements({ ...shape(1), w: Number.POSITIVE_INFINITY }));
  rejects(withElements({ ...shape(1), w: -1 }));
  rejects(withElements({ ...shape(1), x: 1e9 }));
  rejects(withElements({ ...shape(1), fill: 'url(javascript:1)' }));
  rejects(withElements({ ...shape(1), fill: 'red' }));
  rejects(withElements({ ...shape(1), text: 'x'.repeat(whiteboardLimits.maxText + 1) }));
  rejects(withElements({ ...shape(1), text: 'a\u0000b' }));
  rejects(withElements({ ...shape(1), fontSize: 1000 }));
  rejects(withElements({ ...shape(1), strokeStyle: 'wavy' }));
  rejects(withElements(shape(1), shape(1)));
  rejects(withElements({ id: id(8), type: 'image', ...box, attachmentId: 'x', fileName: 'a.png', mediaType: 'image/png' }));
  rejects(withElements({ id: id(8), type: 'image', ...box, attachmentId: id(1), fileName: 'a.pdf', mediaType: 'application/pdf' }));
  rejects(withElements({ id: id(8), type: 'card', ...box, pageId: 'x', label: '' }));
  rejects(withElements({ id: id(8), type: 'pen', ...box, points: [0, 0, 1], color: '#000000', strokeWidth: 2 }));
  rejects(withElements({ id: id(8), type: 'pen', ...box, points: [0, 0, 1, '2'], color: '#000000', strokeWidth: 2 }));
  rejects(withElements({ id: id(8), type: 'frame', ...box, name: 'n'.repeat(201) }));
  rejects({ ...whiteboardContent([]), extra: true });
  rejects({ ...whiteboardContent([]), board: { elements: [], viewport: { x: 0, y: 0, zoom: 1 } } });
  rejects({ ...whiteboardContent([]), board: { elements: 'none' } });
  rejects({ ...whiteboardContent([]), editorState: { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: '藏在正文里' }] }] } } });
  assert.throws(() => validateDocumentContent({ ...whiteboardContent([]), schemaVersion: 2 }),
    (error: unknown) => error instanceof ContentValidationError && error.code === 'CONTENT_VERSION_UNSUPPORTED');
});

test('rejects dangling bindings, connector-to-connector bindings and mind-map cycles', () => {
  assert.equal(whiteboardContentProblem(withElements(shape(1), shape(2), connector(3, 1, 2))), null);
  rejects(withElements(shape(1), connector(3, 1, 2)));
  rejects(withElements(shape(1), shape(2), connector(3, 1, 2), connector(4, 1, 3)));
  rejects(withElements(shape(1, { mindParentId: id(5) })));
  rejects(withElements(shape(1, { mindParentId: id(2) }), shape(2)));
  rejects(withElements(shape(1, { mindParentId: id(2) }), shape(2, { mindParentId: id(1) })));
  rejects(withElements(shape(1, { mindParentId: id(1) })));
});

test('enforces element count and byte limits', () => {
  const many = Array.from({ length: whiteboardLimits.maxElements + 1 }, (_, n) => ({ id: id(n), type: 'frame', ...box, name: '' }));
  rejects(withElements(...many));
  const heavy = Array.from({ length: 120 }, (_, n) => ({ id: id(n), type: 'note', ...box, text: '字'.repeat(3000), color: '#fff3b0',
    fontSize: 16, textAlign: 'left' }));
  assert.equal(whiteboardContentProblem(withElements(...heavy)), 'size');
  rejects(withElements(...heavy));
});
