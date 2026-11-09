import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { computeRow, databaseSchemaProblem, evaluateView, formulaFromDisplay, formulaToDisplay, parseFormula, type DatabaseRow, type PropertyDefinition } from '@nbase/contracts';

const ids = { title: randomUUID(), price: randomUUID(), count: randomUUID(), status: randomUUID(), date: randomUUID(), done: randomUUID(), option: randomUUID(), f: randomUUID() };
const properties: PropertyDefinition[] = [
  { id: ids.title, name: '名称', type: 'title' }, { id: ids.price, name: '单价', type: 'number' }, { id: ids.count, name: '数量', type: 'number' },
  { id: ids.status, name: '状态', type: 'select', options: [{ id: ids.option, name: '完成', color: 'blue' }] },
  { id: ids.date, name: '日期', type: 'date' }, { id: ids.done, name: '勾选', type: 'checkbox' },
];
const row = (values: DatabaseRow['properties'] = {}, title = '苹果'): DatabaseRow => ({ id: randomUUID(), title, icon: null, properties: values, revision: '1', createdAt: '2026-11-07T20:00:00.000Z', updatedAt: '2026-11-07T20:00:00.000Z' });
const stored = (text: string) => formulaFromDisplay(text, properties);
const run = (text: string, values: DatabaseRow['properties'] = { [ids.price]: 2.5, [ids.count]: 4, [ids.status]: ids.option, [ids.date]: '2026-01-31', [ids.done]: true }) => {
  const parsed = parseFormula(stored(text), properties);
  assert.ok(parsed.ok, parsed.ok ? '' : `${text}: ${parsed.error}`);
  return parsed.node.run(row(values));
};
const errorOf = (text: string) => { const parsed = parseFormula(stored(text), properties); assert.equal(parsed.ok, false, text); return parsed.ok ? '' : parsed.error; };

test('formulas calculate with precedence, fields and functions', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('prop("单价") * prop("数量")'), 10);
  assert.equal(run('-prop("单价") + 1'), -1.5);
  assert.equal(run('prop("名称") + "！"'), '苹果！');
  assert.equal(run('concat(prop("名称"), " ", prop("数量"))'), '苹果 4');
  assert.equal(run('prop("状态")'), '完成');
  assert.equal(run('if(prop("数量") > 3, "多", "少")'), '多');
  assert.equal(run('prop("勾选") && !false'), true);
  assert.equal(run('round(3.14159, 2)'), 3.14);
  assert.equal(run('max(1, prop("数量"), 2)'), 4);
  assert.equal(run('length("中文ab")'), 4);
  assert.equal(run('contains(prop("名称"), "苹")'), true);
  assert.equal(run('dateAdd(prop("日期"), 1, "months")'), '2026-02-28');
  assert.equal(run('dateDiff(dateAdd(prop("日期"), 3, "days"), prop("日期"), "days")'), 3);
  assert.equal(run('year(prop("日期")) * 100 + month(prop("日期"))'), 202601);
});

test('empty fields and bad arithmetic give empty results, never exceptions', () => {
  assert.equal(run('prop("单价") * 2', {}), null);
  assert.equal(run('1 / 0'), null);
  assert.equal(run('5 % 0'), null);
  assert.equal(run('prop("单价") > 1', {}), false);
  assert.equal(run('empty(prop("单价"))', {}), true);
  assert.equal(run('prop("勾选")', {}), false);
  assert.equal(run('concat(prop("单价"), "x")', {}), 'x');
  assert.equal(run('dateAdd(prop("日期"), 1, "days")', {}), null);
});

test('mistakes are reported in words and nothing can execute', () => {
  assert.match(errorOf('1 +'), /没有写完/);
  assert.match(errorOf('prop("不存在")'), /不存在/);
  assert.match(errorOf('1 + "a"'), /数字/);
  assert.match(errorOf('if(1, 2, 3)'), /真假值/);
  assert.match(errorOf('if(true, 1, "a")'), /类型不一致/);
  assert.match(errorOf('foo(1)'), /没有函数/);
  assert.match(errorOf('constructor(1)'), /没有函数/);
  assert.match(errorOf('toString()'), /没有函数/);
  assert.match(errorOf('process.exit()'), /数字/);
  assert.match(errorOf('a[0]'), /无法识别/);
  assert.match(errorOf('"未结束'), /引号/);
  assert.match(errorOf('round()'), /参数个数/);
  assert.match(parseFormula('', properties).ok ? '' : (parseFormula('', properties) as { error: string }).error, /还没有/);
  assert.match(errorOf('1'.repeat(2001)), /太长/);
});

test('field references are stored by id and shown by name', () => {
  const text = 'prop("单价") + prop("数量")';
  const expression = stored(text);
  assert.ok(expression.includes(ids.price));
  assert.equal(formulaToDisplay(expression, properties), text);
  const renamed = properties.map(p => p.id === ids.price ? { ...p, name: '价"格' } : p);
  assert.equal(formulaToDisplay(expression, renamed), 'prop("价\\"格") + prop("数量")');
  assert.equal(formulaFromDisplay(formulaToDisplay(expression, renamed), renamed), expression);
});

test('formulas cannot read computed fields, so there are no cycles', () => {
  const withFormula: PropertyDefinition[] = [...properties, { id: ids.f, name: '金额', type: 'formula', formula: { expression: stored('prop("单价") * 2'), resultType: 'number' } }];
  const parsed = parseFormula(formulaFromDisplay('prop("金额") + 1', withFormula), withFormula);
  assert.equal(parsed.ok, false);
  assert.equal(databaseSchemaProblem(withFormula, [{ id: randomUUID(), name: 'v', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} }]), null);
});

test('computed values filter, sort and total as their result type', () => {
  const formula: PropertyDefinition = { id: ids.f, name: '金额', type: 'formula', formula: { expression: stored('prop("单价") * 2'), resultType: 'number' } };
  const schema = [...properties, formula];
  const rows = [row({ [ids.price]: 3 }, 'a'), row({ [ids.price]: 1 }, 'b'), row({}, 'c')].map(item => ({ ...item, computed: computeRow(item, schema) }));
  const view = (patch: object) => ({ id: randomUUID(), name: 'v', type: 'table' as const, filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {}, ...patch });
  assert.deepEqual(rows[2]!.computed, {});
  assert.deepEqual(evaluateView(rows, schema, view({ filters: [{ propertyId: ids.f, operator: 'gt', value: 3 }] })).rows.map(r => r.title), ['a']);
  assert.deepEqual(evaluateView(rows, schema, view({ sorts: [{ propertyId: ids.f, direction: 'asc' }] })).rows.map(r => r.title), ['b', 'a', 'c']);
  assert.deepEqual(evaluateView(rows, schema, view({ filters: [{ propertyId: ids.f, operator: 'is_empty' }] })).rows.map(r => r.title), ['c']);
});
