import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { WorkspaceTag } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { registerTagRoutes } from '../src/notes/tags.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'tag integration password only';
const content = { schemaVersion: 1, editorState: { root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [
    { type: 'text', version: 1, text: '中文 Release 正文' },
  ] }],
} } };

test('workspace tags preserve stable associations, search and permissions', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const databaseName = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: source.toString(), connectionTimeoutMillis: 5000 });
  const testUrl = new URL(source);
  testUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), connectionTimeoutMillis: 5000 });
  const auth = new PgAuthRepository(pool);
  const pages = new PgPageRepository(pool);
  const app = await buildApp({ auth: { repository: auth, publicOrigin: origin }, pages });
  registerTagRoutes(app, pool, pages, auth, origin);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await runMigrations(pool);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '标签测试');
    const base = `/api/workspaces/${owner.workspaceId}`;
    assert.equal((await app.inject({ url: `${base}/tags` })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin }, payload: { loginName: 'owner', password } });
    assert.equal(login.statusCode, 200);
    const read = { cookie: String(login.headers['set-cookie']).split(';', 1)[0]! };
    const write = { ...read, origin, 'x-csrf-token': login.json().csrfToken as string };
    const get = (path: string) => app.inject({ url: base + path, headers: read });
    const mutate = (method: 'POST' | 'PATCH' | 'DELETE', path: string, payload: object) =>
      app.inject({ method, url: base + path, headers: write, payload });
    const getTags = async () => (await get('/tags')).json<{ tags: WorkspaceTag[] }>().tags;
    const getTag = async (id: string) => (await getTags()).find(tag => tag.id === id);

    const firstBody = { clientMutationId: randomUUID(), name: '  项目 Cafe\u0301  ' };
    const first = await mutate('POST', '/tags', firstBody);
    assert.equal(first.statusCode, 201, first.body);
    const { id: firstId, name } = first.json<WorkspaceTag>();
    assert.equal(name, '项目 Café');
    assert.deepEqual((await mutate('POST', '/tags', firstBody)).json(), first.json());
    const duplicate = await mutate('POST', '/tags', { clientMutationId: randomUUID(), name: '项目 CAFÉ' });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, 'TAG_NAME_CONFLICT');
    for (const [spelling, folded] of [['Straße', 'STRASSE'], ['ΟΣ', 'ος'], ['ﬃ', 'FFI']]) {
      const tag = await mutate('POST', '/tags', { clientMutationId: randomUUID(), name: spelling });
      assert.equal(tag.statusCode, 201, tag.body);
      assert.equal((await mutate('POST', '/tags', { clientMutationId: randomUUID(), name: folded })).statusCode, 409);
    }
    assert.equal((await mutate('POST', '/tags', { clientMutationId: randomUUID(), name: '甲'.repeat(33) })).statusCode, 400);
    const second = await mutate('POST', '/tags', { clientMutationId: randomUUID(), name: '资料 Release' });
    assert.equal(second.statusCode, 201, second.body);
    const secondId = second.json<WorkspaceTag>().id;
    const both = [firstId, secondId].sort();

    const create = (title: string, tagIds: string[]) =>
      mutate('POST', '/pages', { clientMutationId: randomUUID(), parentId: null, title, content, tagIds });
    const match = await create('两种标签', both);
    assert.equal(match.statusCode, 201, match.body);
    const matchId = match.json().id as string;
    assert.deepEqual(match.json().tagIds, both);
    const partial = await create('部分匹配', [firstId]);
    assert.equal(partial.statusCode, 201, partial.body);
    assert.equal((await getTag(firstId))?.pageCount, 2);
    assert.deepEqual((await get('/page-tree')).json().pages.find((p: { id: string }) => p.id === matchId).tagIds, both);
    const filter = `/search?tagIds=${both.join(',')}`;
    for (const path of [filter, `${filter}&q=release`]) {
      const result = await get(path);
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json().results.map((item: { pageId: string }) => item.pageId), [matchId]);
    }

    const otherWorkspace = randomUUID(), otherTag = randomUUID();
    await pool.query('INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1, $2, $3)',
      [otherWorkspace, '其他工作区', owner.userId]);
    await pool.query('INSERT INTO workspace_tags (workspace_id, id, name, name_key) VALUES ($1, $2, $3, $3)',
      [otherWorkspace, otherTag, '其他标签']);
    const invalid = await mutate('PATCH', `/pages/${matchId}`, {
      clientMutationId: randomUUID(), expectedRevision: '1', tagIds: [otherTag],
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error, 'TAG_INVALID');
    assert.equal((await get(`/pages/${matchId}`)).json().revision, '1');
    assert.equal((await get(`/search?tagIds=${otherTag}`)).json().results.length, 0);
    assert.equal((await app.inject({ url: `/api/workspaces/${otherWorkspace}/tags`, headers: read })).statusCode, 404);

    const renamed = await mutate('PATCH', `/tags/${firstId}`, { clientMutationId: randomUUID(), name: '项目新名' });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.deepEqual(renamed.json(), { id: firstId, name: '项目新名', pageCount: 2 });
    const renamedConflict = await mutate('PATCH', `/tags/${firstId}`, { clientMutationId: randomUUID(), name: '资料 release' });
    assert.equal(renamedConflict.json().error, 'TAG_NAME_CONFLICT');
    assert.deepEqual((await get(`/pages/${matchId}`)).json().tagIds, both);
    const changed = await mutate('PATCH', `/pages/${matchId}`, {
      clientMutationId: randomUUID(), expectedRevision: '1', tagIds: [secondId],
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(changed.json().tagIds, [secondId]);
    const stale = await mutate('PATCH', `/pages/${matchId}`, { clientMutationId: randomUUID(), expectedRevision: '1', tagIds: both });
    assert.equal(stale.statusCode, 409);

    const trashed = await mutate('POST', `/pages/${matchId}/trash`, { clientMutationId: randomUUID(), expectedRevision: '2' });
    assert.equal(trashed.statusCode, 200, trashed.body);
    assert.equal((await getTag(secondId))?.pageCount, 0);
    assert.equal((await get(`/search?tagIds=${secondId}`)).json().results.length, 0);
    const restored = await mutate('POST', `/pages/${matchId}/restore`, { clientMutationId: randomUUID(), expectedRevision: '3' });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().tagIds, [secondId]);
    assert.equal((await getTag(secondId))?.pageCount, 1);
    const remove = { clientMutationId: randomUUID() };
    assert.equal((await mutate('DELETE', `/tags/${secondId}`, remove)).statusCode, 204);
    assert.equal((await mutate('DELETE', `/tags/${secondId}`, remove)).statusCode, 204);
    assert.deepEqual((await get(`/pages/${matchId}`)).json().tagIds, []);
    assert.equal(await getTag(secondId), undefined);
    assert.equal((await get('/mutations/' + firstBody.clientMutationId)).statusCode, 404);

    await pool.query("UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2",
      [owner.workspaceId, owner.userId]);
    assert.equal((await get('/tags')).statusCode, 200);
    assert.equal((await mutate('POST', '/tags', { clientMutationId: randomUUID(), name: 'viewer' })).statusCode, 403);
  } finally {
    await app.close();
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); }
    finally { await admin.end(); }
  }
});
