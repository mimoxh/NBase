import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { PageProperty } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { runHistoryTextBatch } from '../src/search/history-index.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';

function content(text: string) {
  return { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text, style: '' }] },
  ] } } };
}

const optionId = randomUUID();
const properties: PageProperty[] = [
  { id: randomUUID(), name: '负责人', type: 'text', value: '青柠' },
  { id: randomUUID(), name: '预算', type: 'number', value: 1200.5 },
  { id: randomUUID(), name: '截止', type: 'date', value: '2026-12-01' },
  { id: randomUUID(), name: '状态', type: 'select', value: optionId, options: [{ id: optionId, name: '进行中', color: 'blue' }] },
];

test('document pages keep their own properties through saves, search, history and copies', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 5000 });
  const databaseName = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
    assert.equal(await runMigrations(pool), migrations.length);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试空间');
    app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
      pages: new PgPageRepository(pool), notesPool: pool });
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
      payload: { loginName: 'owner', password: ownerPassword } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const read = { cookie };
    const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
    const inject = app.inject.bind(app);
    const search = async (q: string) => {
      const response = await inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent(q)}`, headers: read });
      assert.equal(response.statusCode, 200, response.body);
      return (response.json().results as Array<{ pageId: string }>).map(result => result.pageId);
    };

    // A new page has no properties; creating with properties stores them in order.
    const plain = await inject({ method: 'POST', url: `${base}/pages`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '普通页', content: content('正文') } });
    assert.equal(plain.statusCode, 201, plain.body);
    assert.deepEqual(plain.json().pageProperties, []);
    const createdPage = await inject({ method: 'POST', url: `${base}/pages`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '项目计划', content: content('第一段'), pageProperties: properties } });
    assert.equal(createdPage.statusCode, 201, createdPage.body);
    const pageId = createdPage.json().id as string;
    assert.deepEqual(createdPage.json().pageProperties, properties);
    const loaded = await inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: read });
    assert.deepEqual(loaded.json().pageProperties, properties);

    // Names and values (the option name for a select) are searchable; option ids are not.
    assert.ok((await search('青柠')).includes(pageId));
    assert.ok((await search('进行中')).includes(pageId));
    assert.ok((await search('负责人')).includes(pageId));
    assert.ok(!(await search(optionId)).includes(pageId));

    // Invalid shapes are refused before storage.
    const invalid: unknown[] = [
      [{ ...properties[0], name: 'title' }],
      [{ ...properties[0], name: 'Tags' }],
      [{ ...properties[0], type: 'checkbox' }],
      [{ ...properties[1], value: '12' }],
      [{ ...properties[2], value: '明天' }],
      [{ ...properties[3], value: randomUUID() }],
      [properties[0], { ...properties[1], name: '负责人' }],
      [properties[0], { ...properties[1], id: properties[0]!.id }],
      [{ ...properties[0], extra: true }],
      Array.from({ length: 51 }, (_, index) => ({ id: randomUUID(), name: `字段${index}`, type: 'text', value: null })),
    ];
    for (const bad of invalid) {
      const rejected = await inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: write,
        payload: { clientMutationId: randomUUID(), expectedRevision: '1', pageProperties: bad } });
      assert.equal(rejected.statusCode, 400, JSON.stringify(bad));
    }

    // A properties-only update is a revisioned save with a snapshot; content edits keep the properties searchable.
    const changed = properties.map(property => property.type === 'text' ? { ...property, value: '黄桃' } : property);
    const updated = await inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', pageProperties: changed } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().revision, '2');
    assert.deepEqual(updated.json().pageProperties, changed);
    const stale = await inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', pageProperties: [] } });
    assert.equal(stale.statusCode, 409);
    const edited = await inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2', content: content('第二段') } });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.deepEqual(edited.json().pageProperties, changed);
    assert.ok((await search('黄桃')).includes(pageId));
    assert.ok(!(await search('青柠')).includes(pageId));
    assert.ok((await search('第二段')).includes(pageId));

    // History keeps each revision's properties, and restoring a version brings them back.
    const v1 = await inject({ method: 'GET', url: `${base}/pages/${pageId}/history/1`, headers: read });
    assert.deepEqual(v1.json().pageProperties, properties);
    const cleared = await inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '3', pageProperties: [] } });
    assert.deepEqual(cleared.json().pageProperties, []);
    assert.ok(!(await search('黄桃')).includes(pageId));
    const restored = await inject({ method: 'POST', url: `${base}/pages/${pageId}/restore-version`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '4', sourceRevision: '1' } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().pageProperties, properties);
    assert.ok((await search('青柠')).includes(pageId));

    // The history text backfill derives the same property text a save writes.
    const savedText = await pool.query<{ search_text: string }>(
      'SELECT search_text FROM page_versions WHERE page_id = $1 AND revision = 1', [pageId]);
    await pool.query('UPDATE page_versions SET search_text = NULL WHERE page_id = $1 AND revision = 1', [pageId]);
    while (await runHistoryTextBatch(pool)) { /* drain */ }
    const rebuilt = await pool.query<{ search_text: string }>(
      'SELECT search_text FROM page_versions WHERE page_id = $1 AND revision = 1', [pageId]);
    assert.equal(rebuilt.rows[0]!.search_text, savedText.rows[0]!.search_text);
    assert.match(rebuilt.rows[0]!.search_text, /青柠/u);

    // A copy keeps the properties; a copy placed in a database becomes a row without them.
    const databaseCreated = await inject({ method: 'POST', url: `${base}/databases`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '任务库' } });
    assert.equal(databaseCreated.statusCode, 201, databaseCreated.body);
    const databaseId = databaseCreated.json().page.id as string;
    const copied = await inject({ method: 'POST', url: `${base}/pages/${pageId}/copy`, headers: write,
      payload: { clientMutationId: randomUUID(), sourceRevision: '5', title: '', parentId: null } });
    assert.equal(copied.statusCode, 201, copied.body);
    assert.deepEqual(copied.json().pageProperties, properties);
    const copiedRow = await inject({ method: 'POST', url: `${base}/pages/${pageId}/copy`, headers: write,
      payload: { clientMutationId: randomUUID(), sourceRevision: '5', title: '', parentId: databaseId } });
    assert.equal(copiedRow.statusCode, 201, copiedRow.body);
    assert.equal(copiedRow.json().kind, 'row');
    assert.equal(copiedRow.json().pageProperties, undefined);

    // Rows, databases and whiteboards cannot carry page properties.
    const row = await inject({ method: 'POST', url: `${base}/pages`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: databaseId, title: '行', content: content(''), pageProperties: properties } });
    assert.equal(row.statusCode, 422, row.body);
    assert.equal(row.json().error, 'PAGE_KIND_INVALID');
    const rowPatch = await inject({ method: 'PATCH', url: `${base}/pages/${copiedRow.json().id}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: copiedRow.json().revision, pageProperties: [] } });
    assert.equal(rowPatch.statusCode, 422, rowPatch.body);

    // Moving a page into a database leaves its own properties in its history only.
    const moved = await inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '5', parentId: databaseId } });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().kind, 'row');
    assert.equal(moved.json().pageProperties, undefined);
    const stored = await pool.query<{ page_properties: unknown }>('SELECT page_properties FROM pages WHERE id = $1', [pageId]);
    assert.equal(stored.rows[0]!.page_properties, null);
    const back = await inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '6', parentId: null } });
    assert.equal(back.statusCode, 200, back.body);
    assert.deepEqual(back.json().pageProperties, []);
  } finally {
    if (app) await app.close();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
