import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { PageDocument, PageHistorySearchResponse, WorkspaceHistorySearchResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { runHistoryTextBatch } from '../src/search/history-index.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'history search integration password only';
const content = (value: string) => ({ schemaVersion: 1, editorState: { root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: value }] }],
} } });

test('history search finds old versions per page and across the workspace, with caps, roles, trash and backfill', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
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
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '历史搜索测试');
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
    const update = async (page: PageDocument, patch: Record<string, unknown>) => {
      const response = await app.inject({ method: 'PATCH', url: `${base}/pages/${page.id}`, headers: write,
        payload: { clientMutationId: randomUUID(), expectedRevision: page.revision, ...patch } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<PageDocument>();
    };
    const inPage = async (pageId: string, q: string, extra = '') => {
      const response = await app.inject({ url: `${base}/pages/${pageId}/history-search?q=${encodeURIComponent(q)}${extra}`, headers: read });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<PageHistorySearchResponse>();
    };
    const across = async (q: string, extra = '') => {
      const response = await app.inject({ url: `${base}/history-search?q=${encodeURIComponent(q)}${extra}`, headers: read });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<WorkspaceHistorySearchResponse>();
    };
    const revisions = async (pageId: string, q: string) => (await inPage(pageId, q)).versions.map(item => item.revision);

    let report = await create('项目周报', '本周讨论预算方案');
    report = await update(report, { content: content('本周讨论招聘计划') });
    report = await update(report, { content: content('总结') });
    report = await update(report, { title: '项目月报' });

    const budget = await inPage(report.id, '预算');
    assert.deepEqual(budget.versions.map(item => [item.revision, item.matchField, item.snippet, item.actor?.loginName]),
      [['1', 'content', '本周讨论预算方案', 'owner']]);
    assert.equal(budget.versions[0]!.highlight, undefined);
    assert.deepEqual([budget.truncated, budget.pendingVersions], [false, 0]);
    // Terms found apart, as in the page search; the highlight is the term found first.
    const terms = await inPage(report.id, '招聘 本周');
    assert.deepEqual(terms.versions.map(item => [item.revision, item.highlight]), [['2', '本周']]);
    assert.deepEqual(await revisions(report.id, '项目周报'), ['3', '2', '1']);
    assert.deepEqual(await revisions(report.id, '月报'), ['4']);
    assert.deepEqual(await revisions(report.id, '没有这个词'), []);

    // Many versions: results are newest first and capped.
    let busy = await create('流水账', '第 0 次 共同词');
    for (let index = 1; index <= 12; index += 1) busy = await update(busy, { content: content(`第 ${index} 次 共同词`) });
    const capped = await inPage(busy.id, '共同词', '&limit=5');
    assert.deepEqual(capped.versions.map(item => item.revision), ['13', '12', '11', '10', '9']);
    assert.equal(capped.truncated, true);
    assert.equal((await inPage(busy.id, '共同词')).versions.length, 13);
    assert.equal((await inPage(busy.id, '共同词')).truncated, false);

    // Across the workspace: one result per page, pages that only match in their history first.
    const current = await create('预算总表', '今年的预算');
    const workspace = await across('预算');
    assert.deepEqual(workspace.results.map(item => [item.pageId, item.title, item.version.revision, item.currentMatches, item.matchingVersions]),
      [[report.id, '项目月报', '1', false, 1], [current.id, '预算总表', '1', true, 1]]);
    assert.equal(workspace.results[0]!.version.title, '项目周报');
    assert.deepEqual((await across('共同词', '&limit=1')).results.map(item => [item.pageId, item.version.revision, item.matchingVersions]),
      [[busy.id, '13', 13]]);
    assert.equal((await across('预算', `&tagIds=${randomUUID()}`)).results.length, 0);

    // Pages in the trash leave the workspace search; their own history stays searchable.
    const trashed = await app.inject({ method: 'POST', url: `${base}/pages/${report.id}/trash`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: report.revision } });
    assert.equal(trashed.statusCode, 200, trashed.body);
    assert.deepEqual((await across('预算')).results.map(item => item.pageId), [current.id]);
    assert.deepEqual(await revisions(report.id, '预算'), ['1']);

    // Versions saved before migration 29 match by title only until the indexer reaches them.
    await pool.query('UPDATE page_versions SET search_text = NULL WHERE page_id = $1 AND revision < 13', [busy.id]);
    const waiting = await inPage(busy.id, '共同词');
    assert.deepEqual([waiting.versions.map(item => item.revision), waiting.pendingVersions], [['13'], 12]);
    assert.equal((await across('共同词')).pendingVersions, 12);
    assert.deepEqual((await inPage(busy.id, '流水账')).versions.length, 13);
    while (await runHistoryTextBatch(pool, 5)) { /* drain */ }
    const filled = await inPage(busy.id, '共同词');
    assert.deepEqual([filled.versions.length, filled.pendingVersions], [13, 0]);
    assert.equal(filled.versions.at(-1)!.snippet, '第 0 次 共同词');

    // Long text: the snippet is cut around the match.
    const long = await create('长文', `${'前文'.repeat(2000)}关键句在这里${'后文'.repeat(2000)}`);
    const longHit = (await inPage(long.id, '关键句')).versions[0]!;
    assert.ok(longHit.snippet.startsWith('…') && longHit.snippet.endsWith('…') && longHit.snippet.includes('关键句在这里'), longHit.snippet);
    assert.ok(longHit.snippet.length < 200, String(longHit.snippet.length));

    // Validation and access.
    for (const query of ['', '?q=', '?q=%20', `?q=${'长'.repeat(101)}`, '?q=a&limit=0', '?q=a&limit=51', '?q=a%01']) {
      assert.equal((await app.inject({ url: `${base}/history-search${query}`, headers: read })).statusCode, 400, query);
      assert.equal((await app.inject({ url: `${base}/pages/${busy.id}/history-search${query}`, headers: read })).statusCode, 400, query);
    }
    assert.equal((await app.inject({ url: `${base}/history-search?tagIds=${randomUUID()}`, headers: read })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}/pages/${busy.id}/history-search?q=a&tagIds=${randomUUID()}`, headers: read })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}/pages/not-a-page/history-search?q=a`, headers: read })).statusCode, 404);
    assert.equal((await app.inject({ url: `${base}/history-search?q=a` })).statusCode, 401);
    assert.equal((await app.inject({ url: `/api/workspaces/${randomUUID()}/history-search?q=a`, headers: read })).statusCode, 404);
    await pool.query('UPDATE workspace_memberships SET role = $2 WHERE user_id = $1', [owner.userId, 'viewer']);
    assert.equal((await across('共同词')).results.length, 1);
    assert.equal((await inPage(busy.id, '共同词')).versions.length, 13);
    await pool.query('UPDATE workspace_memberships SET removed_at = now() WHERE user_id = $1', [owner.userId]);
    assert.equal((await app.inject({ url: `${base}/history-search?q=a`, headers: read })).statusCode, 404);
    assert.equal((await app.inject({ url: `${base}/pages/${busy.id}/history-search?q=a`, headers: read })).statusCode, 404);
  } finally {
    await app.close();
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  }
});
