import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { cellText, databaseSchemaProblem, defaultDatabaseSchema, evaluateView, isSerializedDatabaseView, resolveRelativeDate, retainFilters,
  rowSearchText, rowValueProblem, type DatabaseRow, type DatabaseView, type PropertyDefinition } from '@nbase/contracts';
import { mergeRowProperties, rowIndexText } from '../src/databases/schema.js';
import { validateDocumentContent } from '../src/pages/validate.js';

const ids = { title: randomUUID(), text: randomUUID(), number: randomUUID(), status: randomUUID(), tags: randomUUID(),
  date: randomUUID(), done: randomUUID(), view: randomUUID(), todo: randomUUID(), doing: randomUUID(), red: randomUUID() };

const properties: PropertyDefinition[] = [
  { id: ids.title, name: '名称', type: 'title' },
  { id: ids.text, name: '备注', type: 'text' },
  { id: ids.number, name: '价格', type: 'number' },
  { id: ids.status, name: '状态', type: 'select', options: [
    { id: ids.todo, name: '待办', color: 'gray' }, { id: ids.doing, name: '进行中', color: 'blue' }] },
  { id: ids.tags, name: '标签', type: 'multi_select', options: [{ id: ids.red, name: '重要', color: 'red' }] },
  { id: ids.date, name: '日期', type: 'date' },
  { id: ids.done, name: '完成', type: 'checkbox' },
];

function view(patch: Partial<DatabaseView> = {}): DatabaseView {
  return { id: ids.view, name: '表格', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [],
    widths: {}, ...patch };
}

function row(title: string, values: DatabaseRow['properties'], createdAt = '2026-11-01T00:00:00.000Z'): DatabaseRow {
  return { id: randomUUID(), title, icon: null, properties: values, revision: '1', createdAt, updatedAt: createdAt };
}

const rows = [
  row('苹果', { [ids.number]: 5, [ids.status]: ids.doing, [ids.date]: '2026-11-03', [ids.done]: true, [ids.text]: '红色' }),
  row('香蕉', { [ids.number]: 2, [ids.status]: ids.todo, [ids.tags]: [ids.red] }),
  row('', { [ids.number]: 9 }),
  row('樱桃', { [ids.date]: '2026-10-30' }),
];

test('schema validation requires one title property and valid view conditions', () => {
  const schema = defaultDatabaseSchema({ title: ids.title, view: ids.view });
  assert.equal(databaseSchemaProblem(schema.properties, schema.views), null);
  assert.equal(databaseSchemaProblem(properties, [view()]), null);
  assert.equal(databaseSchemaProblem([], [view()]), 'property-count');
  assert.equal(databaseSchemaProblem(properties.filter(p => p.type !== 'title'), [view()]), 'title-property');
  assert.equal(databaseSchemaProblem([...properties, { id: randomUUID(), name: '二', type: 'title' }], [view()]), 'title-property');
  assert.equal(databaseSchemaProblem(properties, [view({ filters: [{ propertyId: ids.done, operator: 'contains', value: 'x' }] })]),
    'view-filter');
  assert.equal(databaseSchemaProblem(properties, [view({ sorts: [{ propertyId: randomUUID(), direction: 'asc' }] })]), 'view-sort');
  assert.equal(databaseSchemaProblem([{ ...properties[0]!, extra: 1 } as PropertyDefinition], [view()]), 'property-invalid');
  assert.equal(databaseSchemaProblem(properties, [view({ widths: { [ids.text]: 10 } })]), 'view-invalid');
  const deleted = properties.map(p => p.id === ids.text ? { ...p, deletedAt: '2026-11-07T00:00:00.000Z' } : p);
  assert.equal(databaseSchemaProblem(deleted, [view({ sorts: [{ propertyId: ids.text, direction: 'asc' }] })]), 'view-sort');
});

test('row values are checked against their property', () => {
  assert.equal(rowValueProblem(properties, ids.number, 3.5), null);
  assert.equal(rowValueProblem(properties, ids.number, '3'), 'value-invalid');
  assert.equal(rowValueProblem(properties, ids.number, Number.NaN), 'value-invalid');
  assert.equal(rowValueProblem(properties, ids.status, ids.todo), null);
  assert.equal(rowValueProblem(properties, ids.status, randomUUID()), 'option-unknown');
  assert.equal(rowValueProblem(properties, ids.tags, [ids.red, ids.red]), 'value-invalid');
  assert.equal(rowValueProblem(properties, ids.date, '2026-02-30'), 'value-invalid');
  assert.equal(rowValueProblem(properties, ids.done, false), 'value-invalid');
  assert.equal(rowValueProblem(properties, ids.done, null), null);
  assert.equal(rowValueProblem(properties, ids.title, 'x'), 'property-readonly');
  assert.equal(rowValueProblem(properties, randomUUID(), 'x'), 'property-unknown');
  assert.equal(rowValueProblem(properties, ids.text, ''), 'value-invalid');
  assert.deepEqual(mergeRowProperties(properties, { [ids.number]: 1, [ids.text]: 'a' }, { [ids.number]: null, [ids.done]: true }),
    { [ids.text]: 'a', [ids.done]: true });
  assert.throws(() => mergeRowProperties(properties, {}, { [ids.done]: 'yes' as unknown as boolean }));
});

test('evaluateView filters, sorts with empties last and keeps manual order otherwise', () => {
  assert.deepEqual(evaluateView(rows, properties, view()).rows.map(r => r.title), ['苹果', '香蕉', '', '樱桃']);
  const byPrice = evaluateView(rows, properties, view({ sorts: [{ propertyId: ids.number, direction: 'desc' }] }));
  assert.deepEqual(byPrice.rows.map(r => r.title), ['', '苹果', '香蕉', '樱桃']);
  const byPriceAsc = evaluateView(rows, properties, view({ sorts: [{ propertyId: ids.number, direction: 'asc' }] }));
  assert.deepEqual(byPriceAsc.rows.map(r => r.title), ['香蕉', '苹果', '', '樱桃']);
  const byStatus = evaluateView(rows, properties, view({ sorts: [{ propertyId: ids.status, direction: 'asc' }] }));
  assert.deepEqual(byStatus.rows.map(r => r.title), ['香蕉', '苹果', '', '樱桃']);
  const done = evaluateView(rows, properties, view({ filters: [{ propertyId: ids.done, operator: 'is_checked' }] }));
  assert.deepEqual(done.rows.map(r => r.title), ['苹果']);
  const cheap = evaluateView(rows, properties, view({ filters: [{ propertyId: ids.number, operator: 'lt', value: 6 }] }));
  assert.deepEqual(cheap.rows.map(r => r.title), ['苹果', '香蕉']);
  const titled = evaluateView(rows, properties, view({ filters: [{ propertyId: ids.title, operator: 'is_not_empty' },
    { propertyId: ids.date, operator: 'gte', value: '2026-11-01' }] }));
  assert.deepEqual(titled.rows.map(r => r.title), ['苹果']);
  const tagged = evaluateView(rows, properties, view({ filters: [{ propertyId: ids.tags, operator: 'contains', value: ids.red }] }));
  assert.deepEqual(tagged.rows.map(r => r.title), ['香蕉']);
  const unfinished = evaluateView(rows, properties, view({ filters: [{ propertyId: ids.text, operator: 'contains', value: '' }] }));
  assert.equal(unfinished.rows.length, rows.length);
  const columns = evaluateView(rows, properties, view({ hiddenPropertyIds: [ids.text, ids.title],
    propertyOrder: [ids.done, ids.number] })).columns.map(c => c.id);
  assert.deepEqual(columns, [ids.title, ids.done, ids.number, ids.status, ids.tags, ids.date]);
});

test('values written under another type read as empty', () => {
  const retyped = properties.map(p => p.id === ids.number ? { ...p, type: 'text' as const } : p);
  const result = evaluateView(rows, retyped, view({ filters: [{ propertyId: ids.number, operator: 'is_empty' }] }));
  assert.equal(result.rows.length, rows.length);
});

test('a retyped option property keeps its options and never shows option ids as text', () => {
  const retyped = properties.map(p => p.id === ids.status ? { ...p, type: 'text' as const } : p);
  assert.equal(databaseSchemaProblem(retyped, [view()]), null);
  const def = retyped.find(p => p.id === ids.status)!;
  const typed = row('手写', { [ids.status]: '自己输入的文字' });
  assert.equal(cellText(rows[0]!, def), '');
  assert.equal(cellText(typed, def), '自己输入的文字');
  assert.equal(rowSearchText(retyped, { [ids.status]: ids.doing }), '');
  const empty = evaluateView(rows, retyped, view({ filters: [{ propertyId: ids.status, operator: 'is_empty' }] }));
  assert.equal(empty.rows.length, rows.length);
});

test('checkbox sorting follows the chosen direction', () => {
  const sorted = (direction: 'asc' | 'desc') => evaluateView(rows, properties,
    view({ sorts: [{ propertyId: ids.done, direction }] })).rows.map(r => r.title);
  assert.deepEqual(sorted('asc'), ['香蕉', '', '樱桃', '苹果']);
  assert.deepEqual(sorted('desc'), ['苹果', '香蕉', '', '樱桃']);
});

test('time filters compare the local day shown in the cell', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const created: PropertyDefinition = { id: randomUUID(), name: '创建时间', type: 'created_time' };
    const late = [row('晚上', {}, '2026-11-07T20:00:00.000Z')];
    const on = (value: string) => evaluateView(late, [properties[0]!, created],
      view({ filters: [{ propertyId: created.id, operator: 'equals', value }] })).rows.length;
    assert.equal(on('2026-11-08'), 1);
    assert.equal(on('2026-11-07'), 0);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('relative dates resolve to inclusive days around today', () => {
  const today = '2026-11-11'; // A Wednesday.
  assert.deepEqual(resolveRelativeDate('this_week', today, 1), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(resolveRelativeDate('this_week', today, 0), { from: '2026-11-08', to: '2026-11-14' });
  assert.deepEqual(resolveRelativeDate('last_week', today, 1), { from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(resolveRelativeDate('this_month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(resolveRelativeDate('last_month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(resolveRelativeDate('last_7_days', today), { from: '2026-11-05', to: today });
  assert.equal(resolveRelativeDate('someday', today), null);
  const onDate = (value: string, operator: 'equals' | 'gt' | 'lte') => evaluateView(rows, properties,
    view({ filters: [{ propertyId: ids.date, operator, value }] }), { today: '2026-11-04', weekStart: 1 }).rows.map(r => r.title);
  assert.deepEqual(onDate('@this_week', 'equals'), ['苹果']);
  assert.deepEqual(onDate('@last_week', 'lte'), ['樱桃']);
  assert.deepEqual(onDate('@last_week', 'gt'), ['苹果']);
});

test('or groups need one match and ignore conditions still being typed', () => {
  const cheapOrDone = view({ filters: [{ any: [{ propertyId: ids.number, operator: 'lt', value: 3 }, { propertyId: ids.done, operator: 'is_checked' }] }] });
  assert.equal(databaseSchemaProblem(properties, [cheapOrDone]), null);
  assert.deepEqual(evaluateView(rows, properties, cheapOrDone).rows.map(r => r.title), ['苹果', '香蕉']);
  const halfTyped = view({ filters: [{ any: [{ propertyId: ids.text, operator: 'contains' }, { propertyId: ids.number, operator: 'lt', value: 3 }] }] });
  assert.deepEqual(evaluateView(rows, properties, halfTyped).rows.map(r => r.title), ['香蕉']);
  assert.equal(databaseSchemaProblem(properties, [view({ filters: [{ any: [] }] })]), 'view-invalid');
  assert.deepEqual(retainFilters([{ any: [{ propertyId: ids.text, operator: 'is_empty' }] }], () => false), []);
});

test('row search text contains text, url and option names', () => {
  const values = { [ids.text]: '红色', [ids.status]: ids.doing, [ids.tags]: [ids.red], [ids.number]: 5 };
  assert.equal(rowSearchText(properties, values), '红色\n进行中\n重要');
  assert.equal(rowIndexText('正文', properties, values), '正文 红色 进行中 重要');
  assert.equal(rowIndexText('', properties, {}), '');
});

test('database view blocks are accepted only as top-level references', () => {
  const block = { type: 'database-view', version: 1, databaseId: ids.view, viewId: null };
  assert.equal(isSerializedDatabaseView(block), true);
  assert.equal(isSerializedDatabaseView({ ...block, databaseId: ids.view.toUpperCase() }), false);
  assert.equal(isSerializedDatabaseView({ ...block, rows: [] }), false);
  const doc = (children: unknown[]) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children } } });
  assert.doesNotThrow(() => validateDocumentContent(doc([block])));
  assert.throws(() => validateDocumentContent(doc([{ type: 'paragraph', version: 1, children: [block] }])));
  assert.throws(() => validateDocumentContent(doc([{ ...block, databaseId: 'x' }])));
});
