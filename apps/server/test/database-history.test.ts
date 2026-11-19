import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { describeRestoreNote, describeSchemaChange, diffDatabaseSchemas, groupMoveValue, groupRows, isGroupableProperty, isRestoreDatabaseSchemaRequest,
  planSchemaRestore, rowGroupKeys, type DatabaseRow, type DatabaseView, type PropertyDefinition } from '@nbase/contracts';

const view = (patch: Partial<DatabaseView> = {}): DatabaseView => ({ id: randomUUID(), name: '表格', type: 'table', filters: [], sorts: [],
  hiddenPropertyIds: [], propertyOrder: [], widths: {}, ...patch });
const row = (values: DatabaseRow['properties'], title = 'r'): DatabaseRow => ({ id: randomUUID(), title, icon: null, properties: values, revision: '1',
  createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z' });

const ids = { title: randomUUID(), text: randomUUID(), multi: randomUUID(), a: randomUUID(), b: randomUUID(), c: randomUUID(), rel: randomUUID(), pair: randomUUID(), other: randomUUID() };
const title: PropertyDefinition = { id: ids.title, name: '名称', type: 'title' };
const multi: PropertyDefinition = { id: ids.multi, name: '标记', type: 'multi_select', options: [
  { id: ids.a, name: 'A', color: 'red' }, { id: ids.b, name: 'B', color: 'blue' }, { id: ids.c, name: 'C', color: 'green' }] };

test('a multi-select board puts a row in the column of each option and the rest in the column without options', () => {
  assert.equal(isGroupableProperty(multi), true);
  const rows = [row({ [ids.multi]: [ids.b, ids.a] }, 'ab'), row({}, 'none'), row({ [ids.multi]: [ids.c] }, 'c'), row({ [ids.multi]: ['gone'] }, 'removed')];
  assert.deepEqual(rowGroupKeys(rows[0]!, multi), [ids.a, ids.b]);
  assert.deepEqual(rowGroupKeys(rows[3]!, multi), [null]);
  const groups = groupRows(rows, multi);
  const titles = new Map(rows.map(item => [item.id, item.title]));
  assert.deepEqual(groups.map(group => [group.key, group.ids.map(id => titles.get(id))]),
    [[ids.a, ['ab']], [ids.b, ['ab']], [null, ['none', 'removed']], [ids.c, ['c']]]);
  // Column counts add up to occurrences, not rows.
  assert.equal(groups.reduce((sum, group) => sum + group.ids.length, 0), 5);
});

test('moving a multi-select card swaps the option of the column it left for the one it joins', () => {
  assert.deepEqual(groupMoveValue(multi, [ids.a, ids.b], ids.a, ids.c), [ids.b, ids.c]);
  assert.deepEqual(groupMoveValue(multi, [ids.a, ids.b], ids.a, ids.b), [ids.b]);
  assert.deepEqual(groupMoveValue(multi, undefined, null, ids.a), [ids.a]);
  assert.equal(groupMoveValue(multi, [ids.a, ids.b], ids.a, null), null);
  assert.deepEqual(groupMoveValue(multi, ['gone', ids.a], ids.a, ids.b), [ids.b]);
  const select: PropertyDefinition = { id: randomUUID(), name: '状态', type: 'select', options: multi.options! };
  assert.equal(groupMoveValue(select, ids.a, ids.a, ids.b), ids.b);
  const checkbox: PropertyDefinition = { id: randomUUID(), name: '完成', type: 'checkbox' };
  assert.equal(groupMoveValue(checkbox, true, 'true', 'false'), null);
  assert.equal(groupMoveValue(checkbox, undefined, 'false', 'true'), true);
});

test('the difference of two schema versions lists field and view changes', () => {
  const table = view();
  const before = { properties: [title, { id: ids.text, name: '备注', type: 'text' } as PropertyDefinition, multi], views: [table] };
  const after = {
    properties: [title, { id: ids.text, name: '说明', type: 'url' } as PropertyDefinition,
      { ...multi, options: multi.options!.slice(0, 2), deletedAt: null }, { id: randomUUID(), name: '金额', type: 'formula', formula: { expression: '1', resultType: 'number' } } as PropertyDefinition],
    views: [{ ...table, filters: [{ propertyId: ids.text, operator: 'is_empty' as const }] }, view({ name: '看板', type: 'board', groupPropertyId: ids.multi })],
  };
  const changes = diffDatabaseSchemas(before, after);
  assert.deepEqual(changes.map(describeSchemaChange), [
    '字段“备注”改名为“说明”', '字段“说明”的类型从文本改为网址', '修改字段“标记”的选项', '新增字段“金额”', '修改视图“表格”的筛选', '新增视图“看板”',
  ]);
  const removed = diffDatabaseSchemas(after, { ...after, properties: after.properties.map(def => def.id === ids.text ? { ...def, deletedAt: '2026-11-17T00:00:00.000Z' } : def) });
  assert.deepEqual(removed.map(describeSchemaChange), ['删除字段“说明”']);
  assert.deepEqual(diffDatabaseSchemas(after, after), []);
  const reordered = diffDatabaseSchemas(after, { ...after, views: [...after.views].reverse() });
  assert.deepEqual(reordered.map(describeSchemaChange), ['调整视图顺序']);
});

test('restoring a version soft-deletes newer fields, brings deleted ones back and reports what cannot come back', () => {
  const now = '2026-11-17T08:00:00.000Z';
  const later: PropertyDefinition = { id: randomUUID(), name: '新字段', type: 'number' };
  const relation: PropertyDefinition = { id: ids.rel, name: '客户', type: 'relation', relation: { databaseId: ids.other, pairedPropertyId: ids.pair, owner: true } };
  const formula: PropertyDefinition = { id: randomUUID(), name: '公式', type: 'formula', formula: { expression: `prop("${later.id}") + 1`, resultType: 'number' } };
  const rollup: PropertyDefinition = { id: randomUUID(), name: '汇总', type: 'rollup', rollup: { relationPropertyId: ids.rel, targetPropertyId: randomUUID(), fn: 'count', resultType: 'number' } };
  const text: PropertyDefinition = { id: ids.text, name: '备注', type: 'text' };
  const old = view({ filters: [{ propertyId: later.id, operator: 'is_empty' }], sorts: [{ propertyId: ids.text, direction: 'asc' }] });
  const target = { properties: [title, text, relation, formula, rollup], views: [old] };
  const current = {
    properties: [{ ...title, name: '标题' }, { ...text, name: '改名', deletedAt: '2026-11-16T00:00:00.000Z' },
      { ...relation, name: '改名关联', deletedAt: '2026-11-16T00:00:00.000Z' }, formula, rollup, later],
    views: [view({ name: '后来的视图' })],
  };
  const plan = planSchemaRestore(current, target, { activeDatabaseIds: new Set(), managedPropertyIds: new Set(), now });
  const byId = new Map(plan.properties.map(def => [def.id, def]));
  assert.equal(byId.get(ids.title)!.name, '名称');
  assert.equal(byId.get(ids.text)!.name, '备注');
  assert.equal(byId.get(ids.text)!.deletedAt, undefined);
  // The relation's database is gone: it stays deleted, its pairing untouched.
  assert.equal(byId.get(ids.rel)!.deletedAt, '2026-11-16T00:00:00.000Z');
  assert.deepEqual(byId.get(ids.rel)!.relation, relation.relation);
  assert.equal(byId.get(later.id)!.deletedAt, now);
  assert.deepEqual(plan.properties.map(def => def.id), [ids.title, ids.text, ids.rel, formula.id, rollup.id, later.id]);
  assert.deepEqual(plan.views[0]!.filters, []);
  assert.deepEqual(plan.views[0]!.sorts, old.sorts);
  assert.deepEqual(plan.notes.map(note => note.kind), ['relation-target-missing', 'formula-invalid', 'rollup-invalid', 'view-adjusted']);
  assert.match(describeRestoreNote(plan.notes[0]!), /目标数据库已删除/u);
  assert.match(describeRestoreNote(plan.notes[1]!), /公式“公式”无法计算/u);

  const back = planSchemaRestore(current, target, { activeDatabaseIds: new Set([ids.other]), managedPropertyIds: new Set([later.id]), now });
  const restored = new Map(back.properties.map(def => [def.id, def]));
  assert.equal(restored.get(ids.rel)!.deletedAt, undefined);
  assert.equal(restored.get(ids.rel)!.name, '客户');
  // A calendar field stays as it is.
  assert.equal(restored.get(later.id)!.deletedAt, undefined);
  assert.deepEqual(back.notes.map(note => note.kind), ['property-synced']);
  assert.deepEqual(back.views[0]!.filters, old.filters);
});

test('restore requests carry a mutation id and the expected schema revision', () => {
  assert.equal(isRestoreDatabaseSchemaRequest({ clientMutationId: randomUUID(), expectedRevision: '3' }), true);
  assert.equal(isRestoreDatabaseSchemaRequest({ clientMutationId: randomUUID(), expectedRevision: '0' }), false);
  assert.equal(isRestoreDatabaseSchemaRequest({ clientMutationId: 'x', expectedRevision: '3' }), false);
  assert.equal(isRestoreDatabaseSchemaRequest({ clientMutationId: randomUUID(), expectedRevision: '3', extra: 1 }), false);
});
