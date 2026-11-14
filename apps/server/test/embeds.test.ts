import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseSchemaProblem, defaultDatabaseSchema, evaluateView, whiteboardContent, whiteboardPageReferences,
  type DatabaseRow, type DatabaseView, type PropertyDefinition, type WhiteboardElement } from '@nbase/contracts';
import { extractDocumentIndex } from '../src/pages/search-text.js';
import { ContentValidationError, validateDocumentContent } from '../src/pages/validate.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const paragraph = (text = '') => ({ type: 'paragraph', version: 1, children: text ? [{ type: 'text', version: 1, text, style: '' }] : [] });
const board = (extra: object = {}) => ({ type: 'whiteboard-view', version: 1, pageId: id(1), ...extra });
const database = { type: 'database-view', version: 1, databaseId: id(2), viewId: null };
const document = (...children: unknown[]) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children } } });
const rejects = (value: unknown) => assert.throws(() => validateDocumentContent(value),
  (error: unknown) => error instanceof ContentValidationError && error.code === 'CONTENT_INVALID');

test('embedded whiteboards and databases are accepted at the top level and inside toggles and callouts', () => {
  validateDocumentContent(document(paragraph('前文'), board(), database, board({ height: 600 })));
  const toggle = { type: 'toggle', version: 1, children: [paragraph('摘要'), board(), database] };
  const callout = { type: 'callout', version: 1, kind: 'NOTE', title: '', children: [paragraph('说明'), toggle, database] };
  validateDocumentContent(document(toggle, callout));
});

test('embeds are rejected inside quotes, lists and tables, and with a malformed shape', () => {
  rejects(document({ type: 'quote', version: 1, children: [board()] }));
  rejects(document({ type: 'list', version: 1, listType: 'bullet', children: [{ type: 'listitem', version: 1, children: [database] }] }));
  rejects(document({ type: 'table', version: 1, children: [{ type: 'tablerow', version: 1, children: [{ type: 'tablecell', version: 1, children: [board()] }] }] }));
  // A toggle inside a quote is not a place for embeds either.
  rejects(document({ type: 'quote', version: 1, children: [{ type: 'toggle', version: 1, children: [paragraph('摘要'), board()] }] }));
  rejects(document(board({ pageId: 'not-a-uuid' })));
  rejects(document(board({ height: 20 })));
  rejects(document(board({ height: 480.5 })));
  rejects(document(board({ children: [] })));
  rejects(document(board({ title: '多余的键' })));
});

test('an embedded whiteboard is indexed as a link to its page and shares the counter with page references', () => {
  const reference = { type: 'page-reference', version: 1, targetPageId: id(3), label: '另一页' };
  const index = extractDocumentIndex(document({ type: 'paragraph', version: 1, children: [reference] }, board(),
    { type: 'toggle', version: 1, children: [paragraph('摘要'), board({ pageId: id(4) })] }) as never);
  assert.deepEqual(index.references.map(item => [item.targetPageId, item.occurrence]), [[id(3), 0], [id(1), 1], [id(4), 2]]);
  assert.equal(index.references[1]!.snippet, '嵌入的白板');
  assert.equal(index.searchText, '另一页 摘要');
});

test('whiteboards accept preview cards and database views, and link to both', () => {
  const box = { x: 0, y: 0, w: 400, h: 300, angle: 0 };
  const elements: WhiteboardElement[] = [
    { id: id(10), type: 'card', ...box, pageId: id(1), label: '页面' },
    { id: id(11), type: 'card', ...box, pageId: id(2), label: '预览', view: 'preview' },
    { id: id(12), type: 'database', ...box, databaseId: id(3) },
    { id: id(13), type: 'database', ...box, databaseId: id(3), viewId: id(4) },
  ];
  const content = whiteboardContent(elements);
  validateDocumentContent(content);
  assert.deepEqual(whiteboardPageReferences(content.board).map(item => [item.targetPageId, item.occurrence]),
    [[id(1), 0], [id(2), 1], [id(3), 2], [id(3), 3]]);
  rejects(whiteboardContent([{ ...elements[1]!, view: 'full' } as unknown as WhiteboardElement]));
  rejects(whiteboardContent([{ ...elements[2]!, databaseId: 'x' } as unknown as WhiteboardElement]));
  rejects(whiteboardContent([{ ...elements[2]!, text: '多余的键' } as unknown as WhiteboardElement]));
});

test('a tags property reads the page tags: filters by tag id, sorts by count, and exists at most once', () => {
  const schema = defaultDatabaseSchema({ title: id(20), view: id(21) });
  const tags: PropertyDefinition = { id: id(22), name: '标签', type: 'tags' };
  const properties = [...schema.properties, tags];
  const row = (n: number, title: string, tagIds?: string[]): DatabaseRow => ({ id: id(n), title, icon: null, properties: {},
    revision: '1', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...(tagIds ? { tagIds } : {}) });
  const rows = [row(30, '无标签'), row(31, '两个', [id(40), id(41)]), row(32, '一个', [id(40)])];
  const view = (patch: Partial<DatabaseView>): DatabaseView => ({ ...schema.views[0]!, ...patch });
  const titles = (patch: Partial<DatabaseView>) => evaluateView(rows, properties, view(patch)).rows.map(item => item.title);
  assert.deepEqual(titles({ filters: [{ propertyId: tags.id, operator: 'contains', value: id(41) }] }), ['两个']);
  assert.deepEqual(titles({ filters: [{ propertyId: tags.id, operator: 'not_contains', value: id(41) }] }), ['无标签', '一个']);
  assert.deepEqual(titles({ filters: [{ propertyId: tags.id, operator: 'is_empty' }] }), ['无标签']);
  assert.deepEqual(titles({ filters: [{ propertyId: tags.id, operator: 'is_not_empty' }] }), ['两个', '一个']);
  assert.deepEqual(titles({ sorts: [{ propertyId: tags.id, direction: 'asc' }] }), ['一个', '两个', '无标签']);
  assert.deepEqual(titles({ sorts: [{ propertyId: tags.id, direction: 'desc' }] }), ['两个', '一个', '无标签']);
  assert.equal(databaseSchemaProblem(properties, schema.views), null);
  assert.equal(databaseSchemaProblem([...properties, { ...tags, id: id(23), name: '标签 2' }], schema.views), 'tags-property');
  assert.equal(databaseSchemaProblem([...properties, { ...tags, id: id(23), name: '已删', deletedAt: '2026-11-01T00:00:00.000Z' }], schema.views), null);
});
