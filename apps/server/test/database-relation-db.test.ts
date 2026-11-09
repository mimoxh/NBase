import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { ChangeRelationResponse, DatabaseDocument, DatabaseQueryResponse, DatabaseSchemaResponse, PageDocument, PropertyDefinition } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const emptyContent = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [] } } };

test('two-way relations stay consistent through edits, trash and history', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2 });
  const name = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
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
    const makeDb = async (title: string) => (await post('/databases', { clientMutationId: randomUUID(), parentId: null, title })).json() as DatabaseDocument;
    const makeRow = async (db: DatabaseDocument, title: string) => {
      const response = await post('/pages', { clientMutationId: randomUUID(), parentId: db.page.id, title, content: emptyContent, properties: {} });
      assert.equal(response.statusCode, 201, response.body);
      return response.json() as PageDocument;
    };
    const orders = await makeDb('订单');
    const customers = await makeDb('客户');
    const relation = await post(`/databases/${orders.page.id}/relations`, { clientMutationId: randomUUID(), targetDatabaseId: customers.page.id, name: '客户', pairedName: '订单' });
    assert.equal(relation.statusCode, 200, relation.body);
    const ownerField = (relation.json() as DatabaseSchemaResponse).properties.find(p => p.type === 'relation') as PropertyDefinition;
    assert.equal(ownerField.relation!.owner, true);
    const pairedId = ownerField.relation!.pairedPropertyId;
    const read = async (db: DatabaseDocument, filters: unknown[] = [], sorts: unknown[] = []) => {
      const response = await post(`/databases/${db.page.id}/query`, { filters, sorts });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as DatabaseQueryResponse;
    };
    const customerSchema = (await instance.inject({ method: 'GET', url: `${base}/databases/${customers.page.id}?rows=none`, headers: { cookie } })).json() as DatabaseDocument;
    assert.ok(customerSchema.properties.some(p => p.id === pairedId && p.relation?.owner === false));

    const o1 = await makeRow(orders, '订单一');
    const o2 = await makeRow(orders, '订单二');
    const c1 = await makeRow(customers, '张三');
    const c2 = await makeRow(customers, '李四');
    const change = (db: DatabaseDocument, row: string, property: string, add: string[], remove: string[] = []) =>
      post(`/databases/${db.page.id}/rows/${row}/relations/${property}`, { clientMutationId: randomUUID(), add, remove });

    // From the owning side.
    const linked = await change(orders, o1.id, ownerField.id, [c1.id, c2.id]);
    assert.equal(linked.statusCode, 200, linked.body);
    const body = linked.json() as ChangeRelationResponse;
    assert.deepEqual(body.row.relations![ownerField.id]!.items.map(item => item.title), ['张三', '李四']);
    assert.equal(body.otherDatabaseId, customers.page.id);
    assert.equal(body.touched[0]!.id, o1.id);
    assert.equal(body.touched[0]!.revision, '2');

    // From the paired side, which writes the owning row.
    const fromOther = await change(customers, c1.id, pairedId, [o2.id]);
    assert.equal(fromOther.statusCode, 200, fromOther.body);
    assert.deepEqual((fromOther.json() as ChangeRelationResponse).row.relations![pairedId]!.items.map(item => item.title).sort(), ['订单一', '订单二']);
    assert.equal((fromOther.json() as ChangeRelationResponse).touched[0]!.id, o2.id);
    const stored = (await pool.query<{ row_properties: Record<string, string[]>; revision: string }>('SELECT row_properties, revision::text FROM pages WHERE id = $1', [o2.id])).rows[0]!;
    assert.deepEqual(stored.row_properties[ownerField.id], [c1.id]);
    assert.equal(stored.revision, '2');
    const paired = (await pool.query<{ row_properties: Record<string, unknown> }>('SELECT row_properties FROM pages WHERE id = $1', [c1.id])).rows[0]!;
    assert.deepEqual(paired.row_properties, {});

    // Filtering and sorting, on both sides.
    const titlesOf = async (db: DatabaseDocument, filters: unknown[], sorts: unknown[] = []) => (await read(db, filters, sorts)).rows.map(row => row.title);
    assert.deepEqual(await titlesOf(orders, [{ propertyId: ownerField.id, operator: 'contains', value: '李' }]), ['订单一']);
    assert.deepEqual(await titlesOf(customers, [{ propertyId: pairedId, operator: 'contains', value: '二' }]), ['张三']);
    assert.deepEqual(await titlesOf(customers, [{ propertyId: pairedId, operator: 'is_empty' }]), []);
    assert.deepEqual(await titlesOf(orders, [], [{ propertyId: ownerField.id, direction: 'desc' }]), ['订单一', '订单二']);

    // A trashed row disappears from cells and comes back with its links.
    const trashed = await post(`/pages/${c2.id}/trash`, { clientMutationId: randomUUID(), expectedRevision: c2.revision });
    assert.equal(trashed.statusCode, 200, trashed.body);
    let first = (await read(orders)).rows.find(row => row.id === o1.id)!;
    assert.deepEqual(first.relations![ownerField.id]!.items.map(item => item.title), ['张三']);
    assert.equal(first.relations![ownerField.id]!.total, 1);
    assert.equal((await post(`/pages/${c2.id}/restore`, { clientMutationId: randomUUID(), expectedRevision: trashed.json().revision })).statusCode, 200);
    first = (await read(orders)).rows.find(row => row.id === o1.id)!;
    assert.equal(first.relations![ownerField.id]!.total, 2);

    // History restores the links along with the stored ids, and bad targets are refused.
    const removed = await change(orders, o1.id, ownerField.id, [], [c1.id, c2.id]);
    assert.equal((removed.json() as ChangeRelationResponse).row.relations?.[ownerField.id], undefined);
    const restoreVersion = await post(`/pages/${o1.id}/restore-version`, { clientMutationId: randomUUID(), expectedRevision: (removed.json() as ChangeRelationResponse).touched[0]!.revision, sourceRevision: '2' });
    assert.equal(restoreVersion.statusCode, 200, restoreVersion.body);
    first = (await read(orders)).rows.find(row => row.id === o1.id)!;
    assert.equal(first.relations![ownerField.id]!.total, 2);
    assert.equal((await change(orders, o1.id, ownerField.id, [o2.id])).statusCode, 422);
    assert.equal((await change(orders, o1.id, ownerField.id, [randomUUID()])).statusCode, 422);

    // A relation cannot be written as an ordinary property, and duplicates keep their links.
    const direct = await instance.inject({ method: 'PATCH', url: `${base}/pages/${o2.id}`, headers: write, payload: { clientMutationId: randomUUID(), expectedRevision: '2', properties: { [ownerField.id]: [c2.id] } } });
    assert.equal(direct.statusCode, 422);
    const copy = await post(`/databases/${orders.page.id}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'duplicate', ids: [o2.id] });
    assert.equal(copy.statusCode, 200, copy.body);
    const copied = (await read(orders)).rows.find(row => row.id === copy.json().rows[0].id)!;
    assert.equal(copied.relations![ownerField.id]!.total, 1);

    // Deleting one side's field removes the pair; restoring brings both back with their links.
    const ordersNow = (await instance.inject({ method: 'GET', url: `${base}/databases/${orders.page.id}?rows=none`, headers: { cookie } })).json() as DatabaseDocument;
    const soft = await instance.inject({ method: 'PATCH', url: `${base}/databases/${orders.page.id}`, headers: write, payload: { clientMutationId: randomUUID(), expectedRevision: ordersNow.schemaRevision,
      views: ordersNow.views, properties: ordersNow.properties.map(p => p.id === ownerField.id ? { ...p, deletedAt: new Date().toISOString() } : p) } });
    assert.equal(soft.statusCode, 200, soft.body);
    const pairedAfter = (await instance.inject({ method: 'GET', url: `${base}/databases/${customers.page.id}?rows=none`, headers: { cookie } })).json() as DatabaseDocument;
    assert.ok(pairedAfter.properties.find(p => p.id === pairedId)!.deletedAt);
    const reshape = await instance.inject({ method: 'PATCH', url: `${base}/databases/${customers.page.id}`, headers: write, payload: { clientMutationId: randomUUID(), expectedRevision: pairedAfter.schemaRevision,
      views: pairedAfter.views, properties: pairedAfter.properties.map(p => p.id === pairedId ? { ...p, relation: { ...p.relation!, databaseId: randomUUID() } } : p) } });
    assert.equal(reshape.statusCode, 422);

    // A database can relate to itself.
    const self = await post(`/databases/${customers.page.id}/relations`, { clientMutationId: randomUUID(), targetDatabaseId: customers.page.id, name: '上级', pairedName: '下级' });
    assert.equal(self.statusCode, 200, self.body);
    const selfOwner = (self.json() as DatabaseSchemaResponse).properties.find(p => p.name === '上级')!;
    const up = await change(customers, c1.id, selfOwner.id, [c2.id]);
    assert.equal(up.statusCode, 200, up.body);
    const down = (await read(customers)).rows.find(row => row.id === c2.id)!;
    assert.equal(down.relations![selfOwner.relation!.pairedPropertyId]!.items[0]!.title, '张三');
  } finally {
    await app?.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
