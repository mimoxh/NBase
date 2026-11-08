import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { DatabaseDocument, DatabaseSchemaResponse, PropertyDefinition } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { runSearchBatch } from '../src/databases/worker.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';

function content(text: string) {
  return { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text, style: '' }] },
  ] } } };
}

test('databases keep schema, rows, history and trash consistent', {
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

    // Create a database under a document page; replaying the same mutation returns the same database.
    const parent = await inject({ method: 'POST', url: `${base}/pages`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '项目', content: content('') } });
    assert.equal(parent.statusCode, 201, parent.body);
    const createPayload = { clientMutationId: randomUUID(), parentId: parent.json().id, title: '阅读清单' };
    const createdDb = await inject({ method: 'POST', url: `${base}/databases`, headers: write, payload: createPayload });
    assert.equal(createdDb.statusCode, 201, createdDb.body);
    const db = createdDb.json() as DatabaseDocument;
    assert.equal(db.page.kind, 'database');
    assert.equal(db.properties.length, 1);
    const replay = await inject({ method: 'POST', url: `${base}/databases`, headers: write, payload: createPayload });
    assert.equal(replay.json().page.id, db.page.id);
    const nested = await inject({ method: 'POST', url: `${base}/databases`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: db.page.id, title: '套娃' } });
    assert.equal(nested.statusCode, 422);

    // Schema update with a stale revision conflicts; hard removal of a property is refused.
    const status: PropertyDefinition = { id: randomUUID(), name: '状态', type: 'select',
      options: [{ id: randomUUID(), name: '在读', color: 'blue' }] };
    const note: PropertyDefinition = { id: randomUUID(), name: '笔记', type: 'text' };
    const properties = [...db.properties, status, note];
    const schemaPatch = { clientMutationId: randomUUID(), expectedRevision: db.schemaRevision, properties, views: db.views };
    const updated = await inject({ method: 'PATCH', url: `${base}/databases/${db.page.id}`, headers: write, payload: schemaPatch });
    assert.equal(updated.statusCode, 200, updated.body);
    const schema = updated.json() as DatabaseSchemaResponse;
    const stale = await inject({ method: 'PATCH', url: `${base}/databases/${db.page.id}`, headers: write,
      payload: { ...schemaPatch, clientMutationId: randomUUID() } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().currentRevision, schema.schemaRevision);
    const removal = await inject({ method: 'PATCH', url: `${base}/databases/${db.page.id}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: schema.schemaRevision, properties: db.properties, views: db.views } });
    assert.equal(removal.statusCode, 422);

    // Rows are pages under the database; values are validated against the schema.
    const badRow = await inject({ method: 'POST', url: `${base}/pages`, headers: write, payload: {
      clientMutationId: randomUUID(), parentId: db.page.id, title: '错', content: content(''),
      properties: { [status.id]: randomUUID() } } });
    assert.equal(badRow.statusCode, 422);
    const rowCreate = await inject({ method: 'POST', url: `${base}/pages`, headers: write, payload: {
      clientMutationId: randomUUID(), parentId: db.page.id, title: '三体', content: content('第一部'),
      properties: { [status.id]: status.options![0]!.id } } });
    assert.equal(rowCreate.statusCode, 201, rowCreate.body);
    const row = rowCreate.json();
    assert.equal(row.kind, 'row');
    const patched = await inject({ method: 'PATCH', url: `${base}/pages/${row.id}`, headers: write, payload: {
      clientMutationId: randomUUID(), expectedRevision: row.revision, properties: { [note.id]: '宇宙社会学' } } });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(patched.json().properties, { [status.id]: status.options![0]!.id, [note.id]: '宇宙社会学' });
    const conflict = await inject({ method: 'PATCH', url: `${base}/pages/${row.id}`, headers: write, payload: {
      clientMutationId: randomUUID(), expectedRevision: row.revision, properties: { [note.id]: null } } });
    assert.equal(conflict.statusCode, 409);
    const moveOut = await inject({ method: 'PATCH', url: `${base}/pages/${row.id}`, headers: write, payload: {
      clientMutationId: randomUUID(), expectedRevision: patched.json().revision, parentId: null } });
    assert.equal(moveOut.statusCode, 422);
    const moveIn = await inject({ method: 'PATCH', url: `${base}/pages/${parent.json().id}`, headers: write, payload: {
      clientMutationId: randomUUID(), expectedRevision: parent.json().revision, parentId: db.page.id } });
    assert.equal(moveIn.statusCode, 422);

    // Search finds rows by property values; the tree hides rows.
    const search = await inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('宇宙社会学')}`, headers: read });
    assert.deepEqual(search.json().results.map((r: { pageId: string }) => r.pageId), [row.id]);
    const optionSearch = await inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('在读')}`, headers: read });
    assert.deepEqual(optionSearch.json().results.map((r: { pageId: string }) => r.pageId), [row.id]);
    const tree = await inject({ method: 'GET', url: `${base}/page-tree`, headers: read });
    const treeIds = tree.json().pages.map((p: { id: string }) => p.id);
    assert.ok(treeIds.includes(db.page.id));
    assert.ok(!treeIds.includes(row.id));

    // Renaming an option reindexes rows without touching their revisions.
    const renamed = properties.map(p => p.id === status.id ? { ...p, options: [{ ...status.options![0]!, name: '已读' }] } : p);
    const rename = await inject({ method: 'PATCH', url: `${base}/databases/${db.page.id}`, headers: write, payload: {
      clientMutationId: randomUUID(), expectedRevision: schema.schemaRevision, properties: renamed, views: db.views } });
    assert.equal(rename.statusCode, 200, rename.body);
    const reindexed = await inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('已读')}`, headers: read });
    assert.equal(reindexed.json().results.length, 1);

    // A large database is reindexed in the background: batches resume from the cursor and keep row revisions.
    await pool.query(`UPDATE pages SET search_text = 'stale' WHERE id = $1`, [row.id]);
    await pool.query(`UPDATE databases SET search_generation = search_generation + 1 WHERE page_id = $1`, [db.page.id]);
    assert.equal(await runSearchBatch(pool, 1), true);
    while (await runSearchBatch(pool, 1)) { /* drain */ }
    const swept = await pool.query<{ search_text: string; revision: string; indexed: string }>(`SELECT p.search_text, p.revision::text AS revision,
      (d.search_generation - d.search_indexed_generation)::text AS indexed FROM pages p JOIN databases d ON d.page_id = p.parent_id WHERE p.id = $1`, [row.id]);
    assert.match(swept.rows[0]!.search_text, /已读/);
    assert.equal(swept.rows[0]!.revision, patched.json().revision);
    assert.equal(swept.rows[0]!.indexed, '0');

    // History restores the earlier values.
    const restored = await inject({ method: 'POST', url: `${base}/pages/${row.id}/restore-version`, headers: write, payload: {
      clientMutationId: randomUUID(), expectedRevision: patched.json().revision, sourceRevision: row.revision } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().properties, { [status.id]: status.options![0]!.id });

    // Reading the database returns rows in manual order.
    const second = await inject({ method: 'POST', url: `${base}/pages`, headers: write, payload: {
      clientMutationId: randomUUID(), parentId: db.page.id, title: '球状闪电', content: content('') } });
    assert.equal(second.statusCode, 201);
    const position = await inject({ method: 'PUT', url: `${base}/pages/${second.json().id}/position`, headers: write,
      payload: { afterPageId: null } });
    assert.equal(position.statusCode, 204, position.body);
    const loaded = await inject({ method: 'GET', url: `${base}/databases/${db.page.id}`, headers: read });
    assert.deepEqual(loaded.json().rows.map((r: { title: string }) => r.title), ['球状闪电', '三体']);

    // Trashing the database takes its rows; a row cannot be restored on its own while the database is gone.
    const dbPage = await inject({ method: 'GET', url: `${base}/pages/${db.page.id}`, headers: read });
    const trashed = await inject({ method: 'POST', url: `${base}/pages/${db.page.id}/trash`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: dbPage.json().revision } });
    assert.equal(trashed.statusCode, 200, trashed.body);
    assert.equal((await inject({ method: 'GET', url: `${base}/databases/${db.page.id}`, headers: read })).statusCode, 404);
    const trashedRow = await inject({ method: 'GET', url: `${base}/trash/${row.id}`, headers: read });
    // Rows that leave with their database keep their revision, take no snapshot and stay out of the trash list.
    assert.equal(trashedRow.json().revision, restored.json().revision);
    const trashList = await inject({ method: 'GET', url: `${base}/trash`, headers: read });
    assert.deepEqual(trashList.json().pages.map((p: { id: string }) => p.id), [db.page.id]);
    const lonely = await inject({ method: 'POST', url: `${base}/pages/${row.id}/restore`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: trashedRow.json().revision } });
    assert.equal(lonely.statusCode, 409);
    assert.equal(lonely.json().error, 'DATABASE_UNAVAILABLE');
    const trashedDb = await inject({ method: 'GET', url: `${base}/trash/${db.page.id}`, headers: read });
    const back = await inject({ method: 'POST', url: `${base}/pages/${db.page.id}/restore`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: trashedDb.json().revision } });
    assert.equal(back.statusCode, 200, back.body);
    const reloaded = await inject({ method: 'GET', url: `${base}/databases/${db.page.id}`, headers: read });
    assert.equal(reloaded.json().rows.length, 2);
  } finally {
    await app?.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
