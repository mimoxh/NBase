import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { PageDocument, PageHistoryResponse, PageVersion, PageVersionSummary } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'version label integration password only';
const content = (text: string) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [{
  type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text }],
}] } } });

test('named versions keep the page revision and history, filter the list and survive later edits and restores', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const database = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: source.toString(), connectionTimeoutMillis: 5000 });
  const testUrl = new URL(source);
  testUrl.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), connectionTimeoutMillis: 5000 });
  const app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
    pages: new PgPageRepository(pool) });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    assert.ok(await runMigrations(pool) >= 25);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '命名版本测试');
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin }, payload: { loginName: 'owner', password } });
    assert.equal(login.statusCode, 200);
    const read = { cookie: String(login.headers['set-cookie']).split(';', 1)[0]! };
    const write = { ...read, origin, 'x-csrf-token': login.json().csrfToken as string };

    const createdPage = await app.inject({ method: 'POST', url: `${base}/pages`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '计划', content: content('第一版') } });
    assert.equal(createdPage.statusCode, 201, createdPage.body);
    let page = createdPage.json<PageDocument>();
    const update = async (text: string) => {
      const response = await app.inject({ method: 'PATCH', url: `${base}/pages/${page.id}`, headers: write,
        payload: { clientMutationId: randomUUID(), expectedRevision: page.revision, content: content(text) } });
      assert.equal(response.statusCode, 200, response.body);
      page = response.json<PageDocument>();
    };
    await update('第二版');
    await update('第三版');
    assert.equal(page.revision, '3');

    const label = (revision: string, payload: unknown, headers: Record<string, string> = write, pageId = page.id) =>
      app.inject({ method: 'PUT', url: `${base}/pages/${pageId}/history/${revision}/label`, headers, payload: payload as object });
    const history = async (query = '') => {
      const response = await app.inject({ url: `${base}/pages/${page.id}/history${query}`, headers: read });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<PageHistoryResponse>();
    };
    const versionCount = async () => Number((await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM page_versions WHERE page_id = $1', [page.id])).rows[0]!.count);

    assert.deepEqual((await history()).versions.map(item => [item.revision, item.label, item.note]),
      [['3', null, null], ['2', null, null], ['1', null, null]]);

    const named = await label('2', { label: '  评审稿  ', note: '  第一轮评审后\n待补充预算  ' });
    assert.equal(named.statusCode, 200, named.body);
    assert.deepEqual(named.json<PageVersionSummary>(), { ...named.json<PageVersionSummary>(),
      revision: '2', label: '评审稿', note: '第一轮评审后\n待补充预算', operation: 'update', deleted: false });
    const retried = await label('2', { label: '评审稿', note: '第一轮评审后\n待补充预算' });
    assert.equal(retried.statusCode, 200);
    assert.deepEqual(retried.json(), named.json());

    const reread = await app.inject({ url: `${base}/pages/${page.id}`, headers: read });
    assert.equal(reread.json<PageDocument>().revision, '3');
    assert.equal(reread.json<PageDocument>().updatedAt, page.updatedAt);
    assert.equal(await versionCount(), 3);

    const detail = await app.inject({ url: `${base}/pages/${page.id}/history/2`, headers: read });
    assert.equal(detail.json<PageVersion>().label, '评审稿');
    assert.equal(detail.json<PageVersion>().note, '第一轮评审后\n待补充预算');
    assert.deepEqual((await history('?named=true')).versions.map(item => item.revision), ['2']);

    // Blank strings mean none; a label of 100 code points fits even when they take two UTF-16 units each.
    const emoji = '🙂'.repeat(100);
    const blankNote = await label('3', { label: emoji, note: '   ' });
    assert.equal(blankNote.statusCode, 200, blankNote.body);
    assert.equal(blankNote.json<PageVersionSummary>().note, null);
    assert.deepEqual((await history('?named=true&limit=1')).versions.map(item => item.revision), ['3']);
    assert.equal((await history('?named=true&limit=1')).nextBeforeRevision, '3');
    assert.deepEqual((await history('?named=true&beforeRevision=3')).versions.map(item => item.revision), ['2']);

    for (const invalid of [
      { label: null, note: '只有备注' }, { label: '只有名称' }, { note: null }, { label: 'x'.repeat(101), note: null },
      { label: '换\n行', note: null }, { label: '制\t表', note: null }, { label: '名称', note: 'x'.repeat(1001) },
      { label: '名称', note: '响铃\u0007' }, { label: '\ud800', note: null }, { label: 3, note: null }, [],
    ]) {
      const response = await label('1', invalid);
      assert.equal(response.statusCode, 400, JSON.stringify(invalid));
    }
    const lineEnds = await label('1', { label: '名称', note: '缩进\t与\r\n换行\r结束' });
    assert.equal(lineEnds.statusCode, 200, lineEnds.body);
    assert.equal(lineEnds.json<PageVersionSummary>().note, '缩进\t与\n换行\n结束');
    assert.equal((await label('1', { label: '  ', note: null })).json<PageVersionSummary>().label, null);
    assert.equal((await app.inject({ url: `${base}/pages/${page.id}/history?named=yes`, headers: read })).statusCode, 400);

    assert.equal((await label('9', { label: '不存在', note: null })).statusCode, 404);
    assert.equal((await label('1', { label: '不存在', note: null }, write, randomUUID())).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/workspaces/${randomUUID()}/pages/${page.id}/history/1/label`,
      headers: write, payload: { label: '跨工作区', note: null } })).statusCode, 404);
    assert.equal((await label('1', { label: '无令牌', note: null }, { ...read, origin })).statusCode, 403);
    assert.equal((await label('1', { label: '未登录', note: null }, { origin })).statusCode, 401);

    await pool.query('UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, owner.userId, 'viewer']);
    assert.equal((await history('?named=true')).versions.length, 2);
    assert.equal((await label('2', { label: '只读用户', note: null })).statusCode, 403);
    await pool.query('UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, owner.userId, 'owner']);
    assert.equal((await history('?named=true')).versions.find(item => item.revision === '2')?.label, '评审稿');

    // Restoring a named version makes an unnamed new revision; later edits leave every name in place.
    const restored = await app.inject({ method: 'POST', url: `${base}/pages/${page.id}/restore-version`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: '3', sourceRevision: '2' } });
    assert.equal(restored.statusCode, 200, restored.body);
    page = restored.json<PageDocument>();
    await update('第五版');
    const all = await history();
    assert.deepEqual(all.versions.map(item => [item.revision, item.label]),
      [['5', null], ['4', null], ['3', emoji], ['2', '评审稿'], ['1', null]]);
    assert.equal(all.versions.find(item => item.revision === '4')?.operation, 'restore-version');

    const cleared = await label('2', { label: null, note: null });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual([cleared.json<PageVersionSummary>().label, cleared.json<PageVersionSummary>().note], [null, null]);
    assert.deepEqual((await history('?named=true')).versions.map(item => item.revision), ['3']);

    // The database refuses a note without a name even when the route is bypassed.
    await assert.rejects(pool.query(`UPDATE page_versions SET label = NULL, note = '孤立备注'
      WHERE page_id = $1 AND revision = 3`, [page.id]), /page_versions_note_needs_label/);
  } finally {
    await app.close();
    await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});
