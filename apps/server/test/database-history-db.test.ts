import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { formulaDepthLimit, groupMoveValue, type ComputedDependencyError, type DatabaseDocument, type DatabaseQueryResponse, type DatabaseSchemaHistoryResponse,
  type DatabaseSchemaResponse, type DatabaseSchemaVersion, type DatabaseView, type PageDocument, type PropertyDefinition,
  type RestoreDatabaseSchemaResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runComputedBatch } from '../src/databases/computed.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const skip = !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance';

type App = Awaited<ReturnType<typeof buildApp>>;
type InjectResponse = Awaited<ReturnType<App['inject']>>;
interface Harness {
  app: App; pool: pg.Pool; base: string; workspaceId: string; userId: string;
  patch: (path: string, payload: unknown) => Promise<InjectResponse>;
  post: (path: string, payload: unknown) => Promise<InjectResponse>;
  get: (path: string) => Promise<InjectResponse>;
  makeDb: (title: string) => Promise<DatabaseDocument>;
  schema: (id: string) => Promise<DatabaseDocument>;
  save: (id: string, change: (doc: DatabaseDocument) => { properties: PropertyDefinition[]; views?: DatabaseView[] }) => Promise<InjectResponse>;
  drain: () => Promise<number>;
}

async function withApp(work: (h: Harness) => Promise<void>): Promise<void> {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2 });
  const name = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  let app: App | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await runMigrations(pool);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试');
    app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin }, pages: new PgPageRepository(pool), notesPool: pool });
    const instance = app;
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
    const post = (path: string, payload: unknown) => instance.inject({ method: 'POST', url: `${base}${path}`, headers: write, payload: payload as object });
    const get = (path: string) => instance.inject({ method: 'GET', url: `${base}${path}`, headers: { cookie } });
    const schema = async (id: string) => (await get(`/databases/${id}?rows=none`)).json() as DatabaseDocument;
    const db = pool;
    await work({
      app: instance, pool: db, base, workspaceId: owner.workspaceId, userId: owner.userId, post, get, schema,
      patch: (path, payload) => instance.inject({ method: 'PATCH', url: `${base}${path}`, headers: write, payload: payload as object }),
      makeDb: async title => {
        const response = await post('/databases', { clientMutationId: randomUUID(), parentId: null, title });
        assert.equal(response.statusCode, 201, response.body);
        return response.json() as DatabaseDocument;
      },
      save: async (id, change) => {
        const doc = await schema(id);
        const next = change(doc);
        return instance.inject({ method: 'PATCH', url: `${base}/databases/${id}`, headers: write,
          payload: { clientMutationId: randomUUID(), expectedRevision: doc.schemaRevision, properties: next.properties, views: next.views ?? doc.views } });
      },
      // The app's own worker may hold the computed lock, so this waits until no work is left at all.
      drain: async () => {
        let batches = 0;
        for (;;) {
          if (await runComputedBatch(db)) { batches += 1; continue; }
          const left = await db.query(`SELECT 1 FROM database_computed_dirty UNION ALL
            SELECT 1 FROM databases WHERE computed_done_generation < computed_generation LIMIT 1`);
          if (!left.rows.length) return batches;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      },
    });
  } finally {
    await app?.close();
    await pool?.end();
    try { if (created) await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); }
  }
}

const formula = (name: string, expression: string): PropertyDefinition => ({ id: randomUUID(), name, type: 'formula', formula: { expression, resultType: 'number' } });

test('schema history records every save, restores without losing data and respects roles and the trash', { skip }, () => withApp(async h => {
  const orders = await h.makeDb('订单');
  const customers = await h.makeDb('客户');
  const history = async (id: string, query = '') => {
    const response = await h.get(`/databases/${id}/schema-history${query}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as DatabaseSchemaHistoryResponse;
  };
  const first = await history(orders.page.id);
  assert.deepEqual(first.versions.map(v => [v.revision, v.operation]), [['1', 'create']]);
  assert.equal(first.versions[0]!.actor?.name, 'owner');

  // A field with data, a rename, a view filter and a sort.
  const note: PropertyDefinition = { id: randomUUID(), name: '备注', type: 'text' };
  assert.equal((await h.save(orders.page.id, doc => ({ properties: [...doc.properties, note] }))).statusCode, 200);
  const row = await h.post('/pages', { clientMutationId: randomUUID(), parentId: orders.page.id, title: '一号', content: { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [] } } }, properties: { [note.id]: '保留的值' } });
  assert.equal(row.statusCode, 201, row.body);
  const rowId = (row.json() as PageDocument).id;
  assert.equal((await h.save(orders.page.id, doc => ({ properties: doc.properties.map(p => p.id === note.id ? { ...p, name: '说明' } : p),
    views: doc.views.map(v => ({ ...v, filters: [{ propertyId: note.id, operator: 'is_not_empty' }], sorts: [{ propertyId: note.id, direction: 'asc' }] })) }))).statusCode, 200);
  const relation = await h.post(`/databases/${orders.page.id}/relations`, { clientMutationId: randomUUID(), targetDatabaseId: customers.page.id, name: '客户', pairedName: '订单' });
  assert.equal(relation.statusCode, 200, relation.body);
  const relationField = (relation.json() as DatabaseSchemaResponse).properties.find(p => p.type === 'relation')!;

  const listed = await history(orders.page.id);
  assert.deepEqual(listed.versions.map(v => [v.revision, v.operation]), [['4', 'relation'], ['3', 'update'], ['2', 'update'], ['1', 'create']]);
  assert.deepEqual(listed.versions[1]!.changes.map(c => [c.target, c.kind]), [['property', 'renamed'], ['view', 'filters'], ['view', 'sorts']]);
  assert.deepEqual(listed.versions[0]!.changes.map(c => [c.kind, c.name]), [['added', '客户']]);
  assert.deepEqual((await history(customers.page.id)).versions.map(v => v.operation), ['relation', 'create']);
  const paged = await history(orders.page.id, '?limit=2');
  assert.deepEqual(paged.versions.map(v => v.revision), ['4', '3']);
  assert.equal(paged.nextBefore, '3');
  const older = await history(orders.page.id, `?limit=2&before=${paged.nextBefore}`);
  assert.deepEqual(older.versions.map(v => v.revision), ['2', '1']);
  assert.equal(older.nextBefore, null);
  assert.equal((await h.get(`/databases/${orders.page.id}/schema-history?limit=0`)).statusCode, 400);
  const detail = await h.get(`/databases/${orders.page.id}/schema-history/2`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal((detail.json() as DatabaseSchemaVersion).properties.find(p => p.id === note.id)!.name, '备注');
  assert.equal((await h.get(`/databases/${orders.page.id}/schema-history/99`)).statusCode, 404);

  // Restoring version 1 soft-deletes the newer fields and drops filters on them; the row value stays.
  const restore = async (id: string, revision: string) => {
    const doc = await h.schema(id);
    return h.post(`/databases/${id}/schema-history/${revision}/restore`, { clientMutationId: randomUUID(), expectedRevision: doc.schemaRevision });
  };
  const stale = await h.post(`/databases/${orders.page.id}/schema-history/1/restore`, { clientMutationId: randomUUID(), expectedRevision: '1' });
  assert.equal(stale.statusCode, 409);
  const back = await restore(orders.page.id, '1');
  assert.equal(back.statusCode, 200, back.body);
  const restored = back.json() as RestoreDatabaseSchemaResponse;
  assert.equal(restored.restoredFrom, '1');
  assert.equal(restored.schemaRevision, '5');
  assert.ok(restored.properties.find(p => p.id === note.id)!.deletedAt);
  assert.ok(restored.properties.find(p => p.id === relationField.id)!.deletedAt);
  assert.deepEqual(restored.views[0]!.filters, []);
  assert.deepEqual(restored.notes, []);
  // The relation's pair is deleted along with it, as for any schema save.
  assert.ok((await h.schema(customers.page.id)).properties.find(p => p.id === relationField.relation!.pairedPropertyId)!.deletedAt);
  const stored = await h.pool.query<{ row_properties: Record<string, unknown> }>('SELECT row_properties FROM pages WHERE id = $1', [rowId]);
  assert.equal(stored.rows[0]!.row_properties[note.id], '保留的值');
  const afterRestore = await history(orders.page.id);
  assert.deepEqual(afterRestore.versions.slice(0, 2).map(v => [v.revision, v.operation, v.restoredFrom]), [['5', 'restore', '1'], ['4', 'relation', null]]);

  // Restoring version 3 brings the field back with its value.
  const forward = await restore(orders.page.id, '3');
  assert.equal(forward.statusCode, 200, forward.body);
  const forwardBody = forward.json() as RestoreDatabaseSchemaResponse;
  assert.equal(forwardBody.properties.find(p => p.id === note.id)!.name, '说明');
  assert.equal(forwardBody.properties.find(p => p.id === note.id)!.deletedAt, undefined);
  assert.deepEqual(forwardBody.views[0]!.filters, [{ propertyId: note.id, operator: 'is_not_empty' }]);
  const query = await h.post(`/databases/${orders.page.id}/query`, { filters: [], sorts: [] });
  assert.equal((query.json() as DatabaseQueryResponse).rows[0]!.properties[note.id], '保留的值');

  // The relation's database in the trash: restoring the version that had the relation keeps it deleted and says why.
  const customerPage = (await h.get(`/pages/${customers.page.id}`)).json() as PageDocument;
  const trashed = await h.post(`/pages/${customers.page.id}/trash`, { clientMutationId: randomUUID(), expectedRevision: customerPage.revision });
  assert.equal(trashed.statusCode, 200, trashed.body);
  assert.equal((await h.get(`/databases/${customers.page.id}/schema-history`)).statusCode, 404);
  assert.equal((await h.post(`/databases/${customers.page.id}/schema-history/1/restore`, { clientMutationId: randomUUID(), expectedRevision: '1' })).statusCode, 404);
  const withMissing = await restore(orders.page.id, '4');
  assert.equal(withMissing.statusCode, 200, withMissing.body);
  const missingBody = withMissing.json() as RestoreDatabaseSchemaResponse;
  assert.deepEqual(missingBody.notes.map(n => [n.kind, n.name]), [['relation-target-missing', '客户']]);
  assert.ok(missingBody.properties.find(p => p.id === relationField.id)!.deletedAt);
  // Back from the trash, its history is all there, and the relation can come back.
  assert.equal((await h.post(`/pages/${customers.page.id}/restore`, { clientMutationId: randomUUID(), expectedRevision: trashed.json().revision })).statusCode, 200);
  assert.deepEqual((await history(customers.page.id)).versions.map(v => v.operation), ['relation', 'relation', 'create']);
  const relinked = await restore(orders.page.id, '4');
  assert.equal(relinked.statusCode, 200, relinked.body);
  assert.equal((relinked.json() as RestoreDatabaseSchemaResponse).properties.find(p => p.id === relationField.id)!.deletedAt, undefined);
  assert.equal((await h.schema(customers.page.id)).properties.find(p => p.id === relationField.relation!.pairedPropertyId)!.deletedAt, undefined);

  // A stored formula that names a missing field comes back with a note instead of failing.
  const broken = formula('坏公式', `prop("${randomUUID()}") + 1`);
  assert.equal((await h.save(orders.page.id, doc => ({ properties: [...doc.properties, broken] }))).statusCode, 200);
  const brokenRevision = (await h.schema(orders.page.id)).schemaRevision;
  assert.equal((await h.save(orders.page.id, doc => ({ properties: doc.properties.map(p => p.id === broken.id ? { ...p, deletedAt: new Date().toISOString() } : p) }))).statusCode, 200);
  const brokenBack = await restore(orders.page.id, brokenRevision);
  assert.equal(brokenBack.statusCode, 200, brokenBack.body);
  assert.deepEqual((brokenBack.json() as RestoreDatabaseSchemaResponse).notes.map(n => [n.kind, n.name]), [['formula-invalid', '坏公式']]);

  // Viewers can read the history but not restore.
  await h.pool.query(`UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2`, [h.workspaceId, h.userId]);
  assert.equal((await h.get(`/databases/${orders.page.id}/schema-history`)).statusCode, 200);
  assert.equal((await h.get(`/databases/${orders.page.id}/schema-history/1`)).statusCode, 200);
  const doc = await h.schema(orders.page.id);
  assert.equal((await h.post(`/databases/${orders.page.id}/schema-history/1/restore`, { clientMutationId: randomUUID(), expectedRevision: doc.schemaRevision })).statusCode, 403);
  await h.pool.query(`UPDATE workspace_memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`, [h.workspaceId, h.userId]);
  const versions = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM database_schema_versions WHERE database_id = $1', [orders.page.id]);
  assert.equal(versions.rows[0]!.n, Number((await h.schema(orders.page.id)).schemaRevision));
}));

test('computed fields may read each other, cycles are refused with their path and chains are worked out in order', { skip }, () => withApp(async h => {
  const orders = await h.makeDb('订单');
  const customers = await h.makeDb('客户');
  const relation = await h.post(`/databases/${orders.page.id}/relations`, { clientMutationId: randomUUID(), targetDatabaseId: customers.page.id, name: '客户', pairedName: '订单' });
  const owner = (relation.json() as DatabaseSchemaResponse).properties.find(p => p.type === 'relation')!;
  const pairedId = owner.relation!.pairedPropertyId;
  const amount: PropertyDefinition = { id: randomUUID(), name: '金额', type: 'number' };
  const double = formula('双倍', `prop("${amount.id}") * 2`);
  const plusOne = formula('加一', `prop("${double.id}") + 1`);
  assert.equal((await h.save(orders.page.id, doc => ({ properties: [...doc.properties, amount, plusOne, double] }))).statusCode, 200);

  // A cycle inside one database.
  const a = formula('甲', '');
  const b = formula('乙', '');
  a.formula!.expression = `prop("${b.id}") + 1`;
  b.formula!.expression = `prop("${a.id}") + 1`;
  const before = (await h.schema(orders.page.id)).schemaRevision;
  const cycle = await h.save(orders.page.id, doc => ({ properties: [...doc.properties, a, b] }));
  assert.equal(cycle.statusCode, 422);
  const cycleBody = cycle.json() as ComputedDependencyError;
  assert.equal(cycleBody.error, 'DATABASE_FORMULA_CYCLE');
  assert.deepEqual(cycleBody.path.map(node => node.name), ['甲', '乙', '甲']);
  assert.equal((await h.schema(orders.page.id)).schemaRevision, before);
  assert.equal((await h.pool.query('SELECT 1 FROM database_schema_versions WHERE database_id = $1 AND revision > $2', [orders.page.id, before])).rows.length, 0);

  // A chain longer than the limit.
  const chain: PropertyDefinition[] = [];
  for (let index = 0; index <= formulaDepthLimit; index += 1) chain.push(formula(`层${index}`, index ? `prop("${chain[index - 1]!.id}") + 1` : '1'));
  const deep = await h.save(orders.page.id, doc => ({ properties: [...doc.properties, ...chain] }));
  assert.equal(deep.statusCode, 422);
  assert.equal((deep.json() as ComputedDependencyError).error, 'DATABASE_FORMULA_DEPTH');
  assert.equal((deep.json() as ComputedDependencyError).path.length, formulaDepthLimit + 1);

  // Customers sum the orders' formula and read the sum in a formula of their own.
  const total: PropertyDefinition = { id: randomUUID(), name: '订单合计', type: 'rollup', rollup: { relationPropertyId: pairedId, targetPropertyId: plusOne.id, fn: 'sum', resultType: 'number' } };
  const label = formula('合计加十', `prop("${total.id}") + 10`);
  assert.equal((await h.save(customers.page.id, doc => ({ properties: [...doc.properties, total, label] }))).statusCode, 200);
  // Reading the customers' sum back in orders would close a loop across the two databases.
  const back: PropertyDefinition = { id: randomUUID(), name: '回读', type: 'rollup', rollup: { relationPropertyId: owner.id, targetPropertyId: label.id, fn: 'sum', resultType: 'number' } };
  const loop = await h.save(orders.page.id, doc => ({ properties: [...doc.properties, back]
    .map(p => p.id === double.id ? { ...p, formula: { expression: `prop("${back.id}") * 2`, resultType: 'number' as const } } : p) }));
  assert.equal(loop.statusCode, 422, loop.body);
  assert.deepEqual((loop.json() as ComputedDependencyError).path.map(node => node.name), ['加一', '双倍', '回读', '合计加十', '订单合计', '加一']);

  // Many orders on two customers, more than one batch and more than are listed for a single change.
  const customerRows = await h.post(`/databases/${customers.page.id}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'create', rows: [{ title: '张三', properties: {} }, { title: '李四', properties: {} }] });
  assert.equal(customerRows.statusCode, 200, customerRows.body);
  const [zhang, li] = (customerRows.json() as { rows: { id: string }[] }).rows.map(row => row.id) as [string, string];
  const orderIds: string[] = [];
  for (let start = 0; start < 450; start += 150) {
    const created = await h.post(`/databases/${orders.page.id}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'create',
      rows: Array.from({ length: 150 }, (_, index) => ({ title: `订单${start + index}`, properties: { [amount.id]: 1 } })) });
    assert.equal(created.statusCode, 200, created.body);
    orderIds.push(...(created.json() as { rows: { id: string }[] }).rows.map(row => row.id));
  }
  for (let start = 0; start < 400; start += 100) {
    const linked = await h.post(`/databases/${customers.page.id}/rows/${zhang}/relations/${pairedId}`, { clientMutationId: randomUUID(), add: orderIds.slice(start, start + 100), remove: [] });
    assert.equal(linked.statusCode, 200, linked.body);
  }
  const linkedLi = await h.post(`/databases/${customers.page.id}/rows/${li}/relations/${pairedId}`, { clientMutationId: randomUUID(), add: orderIds.slice(400), remove: [] });
  assert.equal(linkedLi.statusCode, 200, linkedLi.body);
  await h.drain();
  const customerQuery = async (filters: unknown[] = []) => (await h.post(`/databases/${customers.page.id}/query`, { filters, sorts: [] })).json() as DatabaseQueryResponse;
  const cached = async () => new Map((await h.pool.query<{ row_id: string; values_json: Record<string, number> }>('SELECT row_id, values_json FROM database_computed WHERE row_id = ANY($1::uuid[])', [[zhang, li]])).rows.map(row => [row.row_id, row.values_json]));
  assert.deepEqual((await cached()).get(zhang), { [total.id]: 1200, [label.id]: 1210 });
  assert.deepEqual((await cached()).get(li), { [total.id]: 150, [label.id]: 160 });

  // Changing the orders' formula queues both databases. Customers wait until orders are done, and stay stale until then.
  assert.equal((await h.save(orders.page.id, doc => ({ properties: doc.properties.map(p => p.id === double.id ? { ...p, formula: { expression: `prop("${amount.id}") * 3`, resultType: 'number' as const } } : p) }))).statusCode, 200);
  const pending = async (id: string) => (await h.pool.query(`SELECT 1 FROM databases d WHERE page_id = $1 AND (computed_done_generation < computed_generation
    OR EXISTS (SELECT 1 FROM database_computed_dirty x WHERE x.database_id = d.page_id))`, [id])).rows.length > 0;
  assert.equal(await pending(orders.page.id), true);
  assert.equal(await pending(customers.page.id), true);
  assert.equal((await customerQuery()).computedStale, true);
  // The app's worker may take batches too; either way nothing downstream is written while its input is being worked out.
  while (await pending(orders.page.id)) {
    if (!await runComputedBatch(h.pool)) await new Promise(resolve => setTimeout(resolve, 10));
    if (!await pending(orders.page.id)) break;
    assert.equal((await cached()).get(zhang)![label.id], 1210);
    assert.equal((await customerQuery()).computedStale, true);
  }
  await h.drain();
  assert.deepEqual((await cached()).get(zhang), { [total.id]: 1600, [label.id]: 1610 });
  assert.deepEqual((await cached()).get(li), { [total.id]: 200, [label.id]: 210 });
  const settled = await customerQuery([{ propertyId: label.id, operator: 'gt', value: 1000 }]);
  assert.equal(settled.computedStale, undefined);
  assert.deepEqual(settled.rows.map(row => [row.title, row.computed]), [['张三', { [total.id]: 1600, [label.id]: 1610 }]]);

  // A row edit upstream reaches the customers' formula through the queue.
  const one = orderIds[0]!;
  const rev = (await h.pool.query<{ revision: string }>('SELECT revision::text FROM pages WHERE id = $1', [one])).rows[0]!.revision;
  const edit = await h.patch(`/pages/${one}`, { clientMutationId: randomUUID(), expectedRevision: rev, properties: { [amount.id]: 101 } });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal((await customerQuery()).computedStale, true);
  await h.drain();
  assert.deepEqual((await cached()).get(zhang), { [total.id]: 1900, [label.id]: 1910 });
}));

test('multi-select boards group by every option and a drag moves one option', { skip }, () => withApp(async h => {
  const db = await h.makeDb('任务');
  const options = [{ id: randomUUID(), name: '前端', color: 'blue' as const }, { id: randomUUID(), name: '后端', color: 'green' as const }, { id: randomUUID(), name: '测试', color: 'red' as const }];
  const tags: PropertyDefinition = { id: randomUUID(), name: '分工', type: 'multi_select', options };
  assert.equal((await h.save(db.page.id, doc => ({ properties: [...doc.properties, tags],
    views: [...doc.views, { id: randomUUID(), name: '看板', type: 'board', groupPropertyId: tags.id, filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} }] }))).statusCode, 200);
  const created = await h.post(`/databases/${db.page.id}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'create', rows: [
    { title: '登录页', properties: { [tags.id]: [options[1]!.id, options[0]!.id] } }, { title: '接口', properties: { [tags.id]: [options[1]!.id] } }, { title: '杂项', properties: {} }] });
  assert.equal(created.statusCode, 200, created.body);
  const [login, api, misc] = (created.json() as { rows: { id: string; revision: string }[] }).rows;
  const groups = async () => {
    const response = await h.post(`/databases/${db.page.id}/query`, { filters: [], sorts: [], groupBy: tags.id });
    assert.equal(response.statusCode, 200, response.body);
    const titles = new Map((response.json() as DatabaseQueryResponse).rows.map(row => [row.id, row.title]));
    return (response.json() as DatabaseQueryResponse).groups!.map(group => [group.key === null ? null : options.find(o => o.id === group.key)!.name, group.ids.map(id => titles.get(id))]);
  };
  assert.deepEqual(await groups(), [['前端', ['登录页']], ['后端', ['登录页', '接口']], [null, ['杂项']]]);
  // Dragging 登录页 from 前端 to 测试 keeps 后端.
  const value = groupMoveValue(tags, [options[1]!.id, options[0]!.id], options[0]!.id, options[2]!.id);
  const moved = await h.post(`/databases/${db.page.id}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'patch', items: [{ id: login!.id, revision: login!.revision, properties: { [tags.id]: value } }] });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual(await groups(), [['后端', ['登录页', '接口']], ['测试', ['登录页']], [null, ['杂项']]]);
  // Into the column without options, and out of it.
  const cleared = await h.post(`/databases/${db.page.id}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'patch', items: [
    { id: api!.id, properties: { [tags.id]: groupMoveValue(tags, [options[1]!.id], options[1]!.id, null) } },
    { id: misc!.id, properties: { [tags.id]: groupMoveValue(tags, undefined, null, options[0]!.id) } }] });
  assert.equal(cleared.statusCode, 200, cleared.body);
  // Groups come in order of first appearance; the board lays columns out in option order.
  assert.deepEqual(await groups(), [['后端', ['登录页']], ['测试', ['登录页']], [null, ['接口']], ['前端', ['杂项']]]);
}));
