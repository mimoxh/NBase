import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { PageDocument, SearchResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { runPinyinBatch } from '../src/search/worker.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'search integration password only';
const content = (value: string) => ({ schemaVersion: 1, editorState: { root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: value }] }],
} } });

test('page search ranks literal matches first, adds segmented and pinyin matches, and backfills keys', {
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
    await runMigrations(pool);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '搜索测试');
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password } });
    const read = { cookie: String(login.headers['set-cookie']).split(';', 1)[0]! };
    const write = { ...read, origin, 'x-csrf-token': login.json().csrfToken as string };
    const create = async (title: string, body: string) => {
      const response = await app.inject({ method: 'POST', url: `${base}/pages`, headers: write,
        payload: { clientMutationId: randomUUID(), parentId: null, title, content: content(body) } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<PageDocument>();
    };
    const search = async (q: string) => {
      const response = await app.inject({ url: `${base}/search?q=${encodeURIComponent(q)}`, headers: read });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<SearchResponse>().results;
    };
    const titles = async (q: string) => (await search(q)).map(result => result.title);

    const separate = await create('会议纪要', '我们讨论了项目的范围，然后制定了计划。');
    const body = await create('周报', '本周完成项目计划的评审。');
    const longer = await create('项目计划书草稿', '内容');
    const exact = await create('项目计划', '这是第一季度的安排。');
    await create('Release notes', 'Plan for 50% off_sale');
    assert.deepEqual(await titles('项目计划'), ['项目计划', '项目计划书草稿', '周报', '会议纪要']);
    const terms = (await search('项目计划')).find(result => result.pageId === separate.id)!;
    assert.equal(terms.matchField, 'content');
    assert.equal(terms.highlight, '项目');
    assert.deepEqual(await titles('50%'), ['Release notes']);
    assert.deepEqual(await titles('off_sale'), ['Release notes']);

    const initials = await search('xmjh');
    assert.deepEqual(initials.map(result => result.pageId), [exact.id, longer.id, body.id]);
    assert.equal(initials[0]!.highlight, '项目计划');
    assert.equal(initials[2]!.matchField, 'content');
    assert.equal(initials[2]!.highlight, '项目计划');
    assert.deepEqual((await search('xiangmu jihua')).map(result => result.pageId).slice(0, 3), [exact.id, longer.id, body.id]);
    assert.deepEqual((await search('项目jihua')).map(result => result.pageId), [exact.id, longer.id, body.id]);

    // A path that edits search text without computing keys leaves the page on the literal path until backfill.
    await pool.query("UPDATE pages SET search_text = search_text || ' 追加' WHERE id = $1", [body.id]);
    const pending = await pool.query('SELECT search_body_pinyin IS NULL AS missing FROM pages WHERE id = $1', [body.id]);
    assert.equal(pending.rows[0]?.missing, true);
    assert.deepEqual((await search('xmjh')).map(result => result.pageId), [exact.id, longer.id]);
    assert.deepEqual((await search('追加')).map(result => result.pageId), [body.id]);
    while (await runPinyinBatch(pool)) { /* drain */ }
    assert.deepEqual((await search('xmjh')).map(result => result.pageId), [exact.id, longer.id, body.id]);

    const trashed = await app.inject({ method: 'POST', url: `${base}/pages/${exact.id}/trash`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: exact.revision } });
    assert.equal(trashed.statusCode, 200, trashed.body);
    assert.equal((await search('xmjh')).some(result => result.pageId === exact.id), false);
    const other = await app.inject({ url: `/api/workspaces/${randomUUID()}/search?q=xmjh`, headers: read });
    assert.equal(other.statusCode, 404);
  } finally {
    await app.close();
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  }
});
