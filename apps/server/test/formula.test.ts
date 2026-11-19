import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { computeRow, computedDependencyProblem, databaseSchemaProblem, evaluateView, formulaDepthLimit, formulaFromDisplay, formulaToDisplay, parseFormula,
  rollupSourceDatabases, type DatabaseRow, type PropertyDefinition } from '@nbase/contracts';

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

test('formulas read other formulas and rollups of the row, worked out in dependency order', () => {
  const total: PropertyDefinition = { id: ids.f, name: '金额', type: 'formula', formula: { expression: '', resultType: 'number' } };
  const rollup: PropertyDefinition = { id: randomUUID(), name: '件数', type: 'rollup', rollup: { relationPropertyId: randomUUID(), targetPropertyId: randomUUID(), fn: 'count', resultType: 'number' } };
  const doubled: PropertyDefinition = { id: randomUUID(), name: '双倍', type: 'formula', formula: { expression: '', resultType: 'number' } };
  // Listed before what it reads, so only a dependency order gets it right.
  const schema: PropertyDefinition[] = [...properties, doubled, total, rollup];
  total.formula!.expression = formulaFromDisplay('prop("单价") * prop("件数")', schema);
  doubled.formula!.expression = formulaFromDisplay('prop("金额") * 2', schema);
  assert.ok(parseFormula(doubled.formula!.expression, schema).ok);
  const item = row({ [ids.price]: 3 });
  const source = { rows: [row(), row()], schema: properties, target: properties[0]! };
  assert.deepEqual(computeRow(item, schema, new Map([[rollup.id, source]])), { [rollup.id]: 2, [ids.f]: 6, [doubled.id]: 12 });
  // A rollup without a source keeps the value already read from the cache.
  assert.deepEqual(computeRow({ ...item, computed: { [rollup.id]: 5 } }, schema), { [rollup.id]: 5, [ids.f]: 15, [doubled.id]: 30 });
  assert.deepEqual(computeRow({ ...item, computed: { [rollup.id]: 5 } }, schema, new Map(), ids.f), { [rollup.id]: 5, [ids.f]: 15 });
  assert.equal(databaseSchemaProblem(schema, [{ id: randomUUID(), name: 'v', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} }]), null);
  const tagged: PropertyDefinition[] = [...properties, { id: randomUUID(), name: '标签', type: 'tags' }];
  const parsedTags = parseFormula(formulaFromDisplay('prop("标签")', tagged), tagged);
  assert.equal(parsedTags.ok, false);
  assert.match(parsedTags.ok ? '' : parsedTags.error, /关联和标签/u);
});

test('cycles between computed fields are found with their path, and left empty when old data has one', () => {
  const db = randomUUID();
  const a: PropertyDefinition = { id: randomUUID(), name: 'A', type: 'formula', formula: { expression: '', resultType: 'number' } };
  const b: PropertyDefinition = { id: randomUUID(), name: 'B', type: 'formula', formula: { expression: '', resultType: 'number' } };
  const ok: PropertyDefinition = { id: randomUUID(), name: 'C', type: 'formula', formula: { expression: '', resultType: 'number' } };
  const schema = [...properties, a, b, ok];
  a.formula!.expression = formulaFromDisplay('prop("B") + 1', schema);
  b.formula!.expression = formulaFromDisplay('prop("A") + 1', schema);
  ok.formula!.expression = formulaFromDisplay('prop("单价") + 1', schema);
  const problem = computedDependencyProblem(db, new Map([[db, schema]]));
  assert.equal(problem?.kind, 'cycle');
  assert.deepEqual(problem!.path.map(node => node.name), ['A', 'B', 'A']);
  assert.deepEqual(computeRow(row({ [ids.price]: 1 }), schema), { [ok.id]: 2 });
  const self: PropertyDefinition = { id: randomUUID(), name: '自己', type: 'formula', formula: { expression: '', resultType: 'number' } };
  self.formula!.expression = `prop("${self.id}") + 1`;
  assert.deepEqual(computedDependencyProblem(db, new Map([[db, [...properties, self]]]))!.path.map(node => node.name), ['自己', '自己']);
  assert.equal(computedDependencyProblem(db, new Map([[db, [...properties, ok]]])), null);
});

test('cycles through rollups of linked databases and chains that are too deep are rejected', () => {
  const [orders, customers] = [randomUUID(), randomUUID()];
  const link = { o: randomUUID(), c: randomUUID() };
  const orderTotal: PropertyDefinition = { id: randomUUID(), name: '订单额', type: 'formula', formula: { expression: '', resultType: 'number' } };
  const customerSum: PropertyDefinition = { id: randomUUID(), name: '客户总额', type: 'rollup', rollup: { relationPropertyId: link.c, targetPropertyId: orderTotal.id, fn: 'sum', resultType: 'number' } };
  const orderBack: PropertyDefinition = { id: randomUUID(), name: '回读', type: 'rollup', rollup: { relationPropertyId: link.o, targetPropertyId: customerSum.id, fn: 'sum', resultType: 'number' } };
  const orderSchema: PropertyDefinition[] = [{ id: randomUUID(), name: '名称', type: 'title' },
    { id: link.o, name: '客户', type: 'relation', relation: { databaseId: customers, pairedPropertyId: link.c, owner: true } }, orderTotal, orderBack];
  orderTotal.formula!.expression = `prop("${orderBack.id}") + 1`;
  const customerSchema: PropertyDefinition[] = [{ id: randomUUID(), name: '名称', type: 'title' },
    { id: link.c, name: '订单', type: 'relation', relation: { databaseId: orders, pairedPropertyId: link.o, owner: false } }, customerSum];
  const schemas = new Map([[orders, orderSchema], [customers, customerSchema]]);
  assert.deepEqual(rollupSourceDatabases(orderSchema), [customers]);
  const cycle = computedDependencyProblem(customers, schemas);
  assert.equal(cycle?.kind, 'cycle');
  assert.deepEqual(cycle!.path.map(node => `${node.databaseId === orders ? '订单' : '客户'}.${node.name}`), ['客户.客户总额', '订单.订单额', '订单.回读', '客户.客户总额']);
  // Without the back reference the chain is fine.
  orderTotal.formula!.expression = '1';
  assert.equal(computedDependencyProblem(customers, schemas), null);

  const chain: PropertyDefinition[] = [{ id: randomUUID(), name: '名称', type: 'title' }];
  for (let index = 0; index <= formulaDepthLimit; index += 1) {
    const previous = chain.at(-1)!;
    chain.push({ id: randomUUID(), name: `第${index}`, type: 'formula', formula: { expression: index === 0 ? '1' : `prop("${previous.id}") + 1`, resultType: 'number' } });
  }
  const deep = computedDependencyProblem(orders, new Map([[orders, chain]]));
  assert.equal(deep?.kind, 'depth');
  assert.equal(deep!.path.length, formulaDepthLimit + 1);
  assert.equal(computedDependencyProblem(orders, new Map([[orders, chain.slice(0, -1)]])), null);
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
