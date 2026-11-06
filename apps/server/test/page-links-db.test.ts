import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { pageBacklinkLimit, type PageBacklinksResponse, type PageDocument } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'backlink integration password only';
const text = (value: string) => ({ type: 'text', version: 1, text: value });
const ref = (targetPageId: string, label: string) => ({ type: 'page-reference', version: 1, targetPageId, label });
const content = (...children: object[]) => ({ schemaVersion: 1, editorState: { root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children }],
} } });

test('saved page backlinks follow revision, trash and workspace boundaries', {
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
    assert.ok(await runMigrations(pool) >= 10);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '反链测试');
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin }, payload: { loginName: 'owner', password } });
    assert.equal(login.statusCode, 200);
    const read = { cookie: String(login.headers['set-cookie']).split(';', 1)[0]! };
    const write = { ...read, origin, 'x-csrf-token': login.json().csrfToken as string };
    const get = (path: string) => app.inject({ url: base + path, headers: read });
    const mutate = (method: 'POST' | 'PATCH', path: string, payload: object) =>
      app.inject({ method, url: base + path, headers: write, payload: { clientMutationId: randomUUID(), ...payload } });
    const create = async (title: string, body = content(text(title))) => {
      const response = await mutate('POST', '/pages', { parentId: null, title, content: body });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<PageDocument>();
    };
    const update = async (page: PageDocument, patch: object) => {
      const response = await mutate('PATCH', `/pages/${page.id}`, { expectedRevision: page.revision, ...patch });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<PageDocument>();
    };
    const action = async (page: PageDocument, kind: 'trash' | 'restore' | 'restore-version', payload = {}) => {
      const response = await mutate('POST', `/pages/${page.id}/${kind}`, { expectedRevision: page.revision, ...payload });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<PageDocument>();
    };
    const backlinksPath = (pageId: string) => `/pages/${pageId}/backlinks`;
    const backlinks = async (pageId: string) => {
      const response = await get(backlinksPath(pageId));
      assert.equal(response.statusCode, 200, response.body);
      return response.json<PageBacklinksResponse>();
    };

    const folder = await create('目录');
    let target = await create('原目标');
    const alternate = await create('另一目标');
    assert.deepEqual(await backlinks(target.id), { links: [], truncated: false });
    assert.equal((await app.inject({ url: base + backlinksPath(target.id) })).statusCode, 401);
    const originalBody = content(ref(alternate.id, '另一个引用'), text(' 前文 '), ref(target.id, '混排 API 别名'),
      text(' 接着 '), ref(target.id, '重复目标'), text(' 后文'));
    let note = await create('来源', originalBody);
    const legacy = await create('旧格式', content(text('保留 [[原目标]] 原文')));
    const first = (await backlinks(target.id)).links;
    assert.deepEqual(first.map(link => [link.sourcePageId, link.occurrence]), [[note.id, 1], [note.id, 2]]);
    assert.match(first[0]!.snippet, /前文 混排 API 别名 接着 重复目标 后文/);
    assert.equal((await get('/search?q=api')).json().results[0].pageId, note.id);
    assert.equal((await get(`/search?q=${target.id}`)).json().results.length, 0);

    target = await update(target, { title: '已改名', parentId: folder.id });
    assert.deepEqual((await backlinks(target.id)).links, first);
    note = await update(note, { title: '来源新名' });
    assert.deepEqual((await backlinks(target.id)).links.map(link => [link.sourceTitle, link.sourceRevision]),
      [['来源新名', note.revision], ['来源新名', note.revision]]);
    note = await action(note, 'trash');
    assert.equal((await backlinks(target.id)).links.length, 0);
    note = await action(note, 'restore');
    assert.equal((await backlinks(target.id)).links.length, 2);
    target = await action(target, 'trash');
    assert.equal((await get(backlinksPath(target.id))).statusCode, 404);
    note = await update(note, { content: originalBody });
    target = await action(target, 'restore');
    assert.equal((await backlinks(target.id)).links.length, 2);

    note = await update(note, { content: content(text('已移除全部引用')) });
    assert.equal((await backlinks(target.id)).links.length, 0);
    note = await action(note, 'restore-version', { sourceRevision: '1' });
    assert.equal((await backlinks(target.id)).links.length, 2);
    note = await update(note, { content: content(...Array.from({ length: pageBacklinkLimit + 1 }, (_, n) => ref(target.id, `第 ${n} 处`))) });
    const bounded = await backlinks(target.id);
    assert.equal(bounded.links.length, pageBacklinkLimit);
    assert.equal(bounded.truncated, true);
    note = await update(note, { content: originalBody });
    assert.deepEqual((await backlinks(target.id)).links.map(link => link.occurrence), [1, 2]);

    const foreignWorkspace = randomUUID(), foreignPage = randomUUID();
    await pool.query('INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1, $2, $3)', [foreignWorkspace, '外部', owner.userId]);
    await pool.query(`INSERT INTO pages (id, workspace_id, title, content_json, content_schema_version)
      VALUES ($1, $2, $3, $4, 1)`, [foreignPage, foreignWorkspace, '外部页面', JSON.stringify(content(text('外部')))]);
    assert.equal((await get(backlinksPath(foreignPage))).statusCode, 404);
    for (const id of [foreignPage, randomUUID()]) {
      const rejected = await mutate('PATCH', `/pages/${note.id}`,
        { expectedRevision: note.revision, content: content(ref(id, '越权引用')) });
      assert.equal(rejected.statusCode, 422);
      assert.equal(rejected.json().error, 'PAGE_REFERENCE_INVALID');
      assert.equal((await get(`/pages/${note.id}`)).json().revision, note.revision);
    }

    // Drop the derived index in this disposable DB to exercise the v9 → v10 upgrade.
    await pool.query('DROP TABLE page_links; DELETE FROM schema_migrations WHERE version = 10');
    await pool.query('UPDATE pages SET search_text = $2 WHERE id = $1', [note.id, '待回填']);
    assert.equal(await runMigrations(pool), 1);
    assert.equal(await runMigrations(pool), 0);
    assert.deepEqual((await backlinks(target.id)).links.map(link => link.occurrence), [1, 2]);
    assert.equal((await get('/search?q=api')).json().results[0].pageId, note.id);
    const current = (await get(`/pages/${note.id}`)).json<PageDocument>();
    assert.deepEqual([current.content, current.revision, current.updatedAt], [note.content, note.revision, note.updatedAt]);
    const legacyAfter = (await get(`/pages/${legacy.id}`)).json<PageDocument>();
    assert.deepEqual([legacyAfter.content, legacyAfter.revision], [legacy.content, legacy.revision]);

    await pool.query("UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2",
      [owner.workspaceId, owner.userId]);
    assert.equal((await backlinks(target.id)).links.length, 2);
    assert.equal((await mutate('PATCH', `/pages/${note.id}`,
      { expectedRevision: note.revision, content: content(text('越权写入')) })).statusCode, 403);
  } finally {
    await app.close();
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  }
});
