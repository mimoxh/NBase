import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { aggregateRows, aggregatesFor, evaluateView, filterOperatorsFor, operatorNeedsValue, relativeDateTokens, type DatabaseDocument, type DatabaseQueryResponse,
  type DatabaseView, type PropertyDefinition, type ViewFilterEntry, type ViewSort } from '@nbase/contracts';
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
const timeZone = 'Asia/Shanghai';

test('server query matches evaluateView for every filter and sort', {
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
    const read = { cookie };
    const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };

    const db = (await instance.inject({ method: 'POST', url: `${base}/databases`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '对照表' } })).json() as DatabaseDocument;
    const opts = ['甲', '乙', '丙'].map(option => ({ id: randomUUID(), name: option, color: 'blue' as const }));
    const removedOption = randomUUID();
    const fields = {
      text: { id: randomUUID(), name: '文本', type: 'text' },
      number: { id: randomUUID(), name: '数字', type: 'number' },
      select: { id: randomUUID(), name: '单选', type: 'select', options: opts },
      multi: { id: randomUUID(), name: '多选', type: 'multi_select', options: opts },
      date: { id: randomUUID(), name: '日期', type: 'date' },
      done: { id: randomUUID(), name: '勾选', type: 'checkbox' },
      url: { id: randomUUID(), name: '网址', type: 'url' },
      created: { id: randomUUID(), name: '创建', type: 'created_time' },
      updated: { id: randomUUID(), name: '更新', type: 'updated_time' },
      formerSelect: { id: randomUUID(), name: '曾是单选', type: 'text', options: opts },
    } satisfies Record<string, PropertyDefinition>;
    const properties: PropertyDefinition[] = [...db.properties, ...Object.values(fields)];
    const saved = await instance.inject({ method: 'PATCH', url: `${base}/databases/${db.page.id}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: db.schemaRevision, properties, views: db.views } });
    assert.equal(saved.statusCode, 200, saved.body);

    const f = fields;
    const samples: [string, Record<string, unknown>, string][] = [
      ['b10', { [f.text.id]: '苹果', [f.number.id]: 0, [f.select.id]: opts[0]!.id, [f.multi.id]: [opts[1]!.id, opts[0]!.id], [f.date.id]: '2026-11-08', [f.done.id]: true, [f.url.id]: 'https://example.com/a', [f.formerSelect.id]: opts[0]!.id }, '2026-11-07T20:00:00.000Z'],
      ['b2', { [f.text.id]: 'APPLE pie', [f.number.id]: -1.5, [f.select.id]: opts[2]!.id, [f.multi.id]: [opts[0]!.id], [f.date.id]: '2026-02-28', [f.url.id]: 'mailto:a@b.c', [f.formerSelect.id]: '手写' }, '2026-11-07T15:59:00.000Z'],
      ['Apple', { [f.number.id]: 9007199, [f.select.id]: removedOption, [f.multi.id]: [removedOption], [f.date.id]: '2024-02-29' }, '2026-11-07T16:01:00.000Z'],
      ['apple', { [f.text.id]: '香蕉', [f.date.id]: '2026-02-31', [f.url.id]: '不是网址' }, '2026-01-01T00:00:00.000Z'],
      ['  ', { [f.number.id]: 1.5, [f.select.id]: '不是编号', [f.date.id]: '2025-02-29', [f.text.id]: 12 }, '2026-06-15T12:00:00.000Z'],
      ['', {}, '2025-12-31T23:30:00.000Z'],
      ['中文', { [f.select.id]: opts[1]!.id, [f.multi.id]: [opts[2]!.id], [f.done.id]: false, [f.number.id]: '5' }, '2026-11-08T01:00:00.000Z'],
      ['阿', { [f.select.id]: opts[1]!.id, [f.date.id]: 'x' }, '2026-11-08T02:00:00.000Z'],
    ];
    for (const [title, , createdAt] of samples) {
      const row = await instance.inject({ method: 'POST', url: `${base}/pages`, headers: write,
        payload: { clientMutationId: randomUUID(), parentId: db.page.id, title, content: emptyContent, properties: {} } });
      assert.equal(row.statusCode, 201, row.body);
      const values = samples.find(sample => sample[2] === createdAt)![1];
      await pool.query('UPDATE pages SET row_properties = $2::jsonb, created_at = $3, updated_at = $3 WHERE id = $1',
        [row.json().id, JSON.stringify(values), createdAt]);
    }
    const doc = (await instance.inject({ method: 'GET', url: `${base}/databases/${db.page.id}`, headers: read })).json() as DatabaseDocument;
    assert.equal(doc.rows.length, samples.length);

    const context = { timeZone, weekStart: 1 as const };
    const view = (filters: ViewFilterEntry[], sorts: ViewSort[]): DatabaseView => ({ id: randomUUID(), name: 'v', type: 'table', filters, sorts,
      hiddenPropertyIds: [], propertyOrder: [], widths: {} });
    const check = async (label: string, filters: ViewFilterEntry[], sorts: ViewSort[] = []) => {
      const response = await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/query`, headers: write,
        payload: { filters, sorts, context } });
      assert.equal(response.statusCode, 200, `${label}: ${response.body}`);
      const body = response.json() as DatabaseQueryResponse;
      const titleOf = (id: string) => doc.rows.find(row => row.id === id)?.title;
      assert.deepEqual(body.order.map(titleOf), evaluateView(doc.rows, properties, view(filters, sorts), context).rows.map(row => row.title), label);
      assert.equal(body.total, body.order.length);
      assert.deepEqual(body.rows.map(row => row.id), body.order.slice(0, 200));
    };

    const valuesFor = (def: PropertyDefinition): (string | number)[] => {
      switch (def.type) {
        case 'number': return [0, 1.5, -1.5, 9007199];
        case 'select': case 'multi_select': return [opts[0]!.id, opts[1]!.id, removedOption];
        case 'date': case 'created_time': case 'updated_time':
          return ['2026-11-08', '2026-11-07', '2026-02-28', ...relativeDateTokens.map(token => `@${token}`)];
        default: return ['苹果', 'apple', 'APPLE PIE', '%', '_', "'", '手写', opts[0]!.id];
      }
    };
    let cases = 0;
    for (const def of properties) {
      for (const operator of filterOperatorsFor(def.type)) {
        for (const value of operatorNeedsValue(operator) ? valuesFor(def) : [undefined]) {
          await check(`${def.name} ${operator} ${String(value)}`, [{ propertyId: def.id, operator, ...(value === undefined ? {} : { value }) }]);
          cases += 1;
        }
      }
      for (const direction of ['asc', 'desc'] as const) {
        await check(`sort ${def.name} ${direction}`, [], [{ propertyId: def.id, direction }]);
        cases += 1;
      }
    }
    assert.ok(cases > 150, `only ${cases} cases`);

    // Footer statistics agree with the in-memory calculation, with and without filters.
    const checkAggregates = async (filters: ViewFilterEntry[]) => {
      const items = properties.flatMap(def => aggregatesFor(def.type).map(fn => ({ propertyId: def.id, fn })));
      const response = await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/aggregate`, headers: write, payload: { filters, items, context } });
      assert.equal(response.statusCode, 200, response.body);
      const matching = evaluateView(doc.rows, properties, view(filters, []), context).rows;
      const expected = aggregateRows(matching, properties, items);
      const actual = response.json().values as (number | string | null)[];
      actual.forEach((value, index) => {
        const label = `${properties.find(p => p.id === items[index]!.propertyId)!.name} ${items[index]!.fn}`;
        if (typeof expected[index] === 'number') assert.ok(Math.abs((value as number) - (expected[index] as number)) < 1e-6, `${label}: ${value} vs ${expected[index]}`);
        else assert.equal(value, expected[index], label);
      });
    };
    await checkAggregates([]);
    await checkAggregates([{ propertyId: f.number.id, operator: 'gt', value: 0 }]);
    await checkAggregates([{ propertyId: f.text.id, operator: 'equals', value: '没有这样的值' }]);

    // Groups, incomplete conditions inside a group, unknown properties and combined sorts.
    await check('or', [{ any: [{ propertyId: f.number.id, operator: 'gt', value: 1 }, { propertyId: f.done.id, operator: 'is_checked' }] }]);
    await check('and of or', [{ any: [{ propertyId: f.select.id, operator: 'equals', value: opts[0]!.id }, { propertyId: f.select.id, operator: 'equals', value: opts[1]!.id }] },
      { propertyId: f.number.id, operator: 'is_empty' }]);
    await check('half typed or', [{ any: [{ propertyId: f.text.id, operator: 'contains' }, { propertyId: f.number.id, operator: 'gt', value: 1 }] }]);
    await check('only half typed', [{ any: [{ propertyId: f.text.id, operator: 'contains' }] }]);
    await check('unknown', [{ propertyId: randomUUID(), operator: 'equals', value: 'x' }], [{ propertyId: randomUUID(), direction: 'asc' }]);
    await check('two sorts', [], [{ propertyId: f.done.id, direction: 'desc' }, { propertyId: f.select.id, direction: 'asc' }]);

    // Windows, trashed rows, bad requests and a zone only one side knows.
    const first = (await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/query`, headers: write,
      payload: { filters: [], sorts: [] } })).json() as DatabaseQueryResponse;
    const window = await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/rows/read`, headers: write,
      payload: { ids: [first.order[2], randomUUID(), first.order[0]] } });
    assert.deepEqual(window.json().rows.map((row: { id: string }) => row.id), [first.order[2], first.order[0]]);
    const badZone = await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/query`, headers: write,
      payload: { filters: [], sorts: [], context: { timeZone: 'Mars/Olympus' } } });
    assert.equal(badZone.statusCode, 200, badZone.body);
    const badBody = await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/query`, headers: write, payload: { filters: 1, sorts: [] } });
    assert.equal(badBody.statusCode, 400);
    const noOrigin = await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/query`, headers: read, payload: { filters: [], sorts: [] } });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal((await instance.inject({ method: 'POST', url: `${base}/databases/${randomUUID()}/query`, headers: write, payload: { filters: [], sorts: [] } })).statusCode, 404);
    // Bulk writes: receipts make retries safe, values are checked, and each row keeps a version and its body.
    const bulk = (payload: Record<string, unknown>) => instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/rows/bulk`, headers: write, payload });
    const createMutation = randomUUID();
    const createBody = { clientMutationId: createMutation, operation: 'create',
      rows: [{ title: '批量一', properties: { [f.number.id]: 1, [f.text.id]: '可搜索词' } }, { title: '批量二', properties: {} }] };
    const bulkCreated = await bulk(createBody);
    assert.equal(bulkCreated.statusCode, 200, bulkCreated.body);
    const [one, two] = bulkCreated.json().rows as { id: string; revision: string }[];
    assert.deepEqual((await bulk(createBody)).json().rows, bulkCreated.json().rows);
    const count = async () => (await pool!.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE parent_id = $1 AND deleted_at IS NULL`, [db.page.id])).rows[0]!.n;
    assert.equal(await count(), samples.length + 2);
    assert.equal((await bulk({ clientMutationId: randomUUID(), operation: 'create', rows: [{ title: 'x', properties: { [f.number.id]: 'bad' } }] })).statusCode, 422);
    assert.equal((await bulk({ clientMutationId: randomUUID(), operation: 'patch', items: [{ id: one!.id, revision: '999', title: 'x' }] })).statusCode, 409);

    await pool.query(`UPDATE pages SET content_json = $2::jsonb WHERE id = $1`, [one!.id, JSON.stringify({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
      { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: '正文词', style: '' }] }] } } })]);
    const patched = await bulk({ clientMutationId: randomUUID(), operation: 'patch', items: [
      { id: one!.id, properties: { [f.text.id]: '新词' } }, { id: two!.id, title: '改名', properties: { [f.number.id]: 2 } }] });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(patched.json().rows.map((row: { revision: string }) => row.revision), ['2', '2']);
    const search = (await pool.query<{ search_text: string }>('SELECT search_text FROM pages WHERE id = $1', [one!.id])).rows[0]!.search_text;
    assert.match(search, /正文词/);
    assert.match(search, /新词/);
    assert.doesNotMatch(search, /可搜索词/);
    assert.equal((await pool.query('SELECT 1 FROM page_versions WHERE page_id = $1', [one!.id])).rows.length, 2);

    const duplicated = await bulk({ clientMutationId: randomUUID(), operation: 'duplicate', ids: [one!.id] });
    assert.equal(duplicated.statusCode, 200, duplicated.body);
    const copy = (await pool.query<{ title: string; search_text: string; content_json: unknown }>('SELECT title, search_text, content_json FROM pages WHERE id = $1', [duplicated.json().rows[0].id])).rows[0]!;
    assert.equal(copy.title, '批量一 副本');
    assert.match(copy.search_text, /正文词/);

    const trashedRows = await bulk({ clientMutationId: randomUUID(), operation: 'trash', ids: [two!.id, duplicated.json().rows[0].id] });
    assert.equal(trashedRows.statusCode, 200, trashedRows.body);
    const trashList = await instance.inject({ method: 'GET', url: `${base}/trash`, headers: read });
    assert.equal(trashList.json().pages.length, 2);
    const individual = await instance.inject({ method: 'POST', url: `${base}/pages/${two!.id}/restore`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: trashedRows.json().rows.find((row: { id: string }) => row.id === two!.id).revision } });
    assert.equal(individual.statusCode, 200, individual.body);
    assert.equal(await count(), samples.length + 2);

    await pool.query(`UPDATE workspace_memberships SET role = 'viewer' WHERE user_id = $1`, [owner.userId]);
    assert.equal((await bulk({ clientMutationId: randomUUID(), operation: 'trash', ids: [one!.id] })).statusCode, 403);
    assert.equal((await instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/query`, headers: write, payload: { filters: [], sorts: [] } })).statusCode, 200);
  } finally {
    await app?.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
