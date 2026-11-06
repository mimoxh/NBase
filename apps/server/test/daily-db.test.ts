import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { quickCaptureMarker } from '@nbase/contracts';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { registerDailyRoutes } from '../src/notes/daily.js';
import { blankDailyContent, noteDateAt } from '../src/notes/dailyContent.js';
import { PageError, PgPageRepository } from '../src/pages/repository.js';

const databaseUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'disposable daily test password';

test('daily notes and capture honor dates, permissions, revisions, receipts and the trash', {
  skip: !databaseUrl && 'Set NBASE_TEST_DATABASE_URL to the disposable local PostgreSQL instance',
}, async () => {
  assert.ok(databaseUrl);
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '54329');
  assert.equal(url.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  const database = 'nbase_p2_daily_' + randomUUID().replaceAll('-', '');
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await admin.query('CREATE DATABASE "' + database + '"');
    created = true;
    url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 5000 });
    await runMigrations(pool);
    assert.equal(await runMigrations(pool), 0);
    const hash = await hashPassword(password);
    const owner = await initializeOwner(pool, 'owner', hash, '测试工作区');
    const auth = new PgAuthRepository(pool);
    const pages = new PgPageRepository(pool);
    const fastify = await buildApp({ auth: { repository: auth, publicOrigin: origin }, pages });
    app = fastify;
    registerDailyRoutes(fastify, pool, pages, auth, origin, async (_client, _workspace, _actor, id, title, date) => {
      if (id !== 'reading') throw new PageError(404, 'NOT_FOUND');
      return { content: { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
        { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: title + ' / ' + date }] },
      ] } } }, missingAttachments: [] };
    });

    async function login(name: string) {
      const response = await fastify.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
        payload: { loginName: name, password } });
      assert.equal(response.statusCode, 200, response.body);
      return { cookie: String(response.headers['set-cookie']).split(';')[0]!, origin,
        'x-csrf-token': response.json().csrfToken as string };
    }
    const headers = await login('owner');
    const base = '/api/workspaces/' + owner.workspaceId;
    const daily = base + '/daily-note';
    const quick = base + '/quick-capture';
    const status = (date: string) => fastify.inject({ method: 'GET', url: daily + '?date=' + date, headers });
    const post = (endpoint: string, payload: object) => fastify.inject({ method: 'POST', url: endpoint, headers, payload });

    assert.equal((await fastify.inject({ method: 'GET', url: daily })).statusCode, 401);
    assert.equal((await fastify.inject({ method: 'GET', url: '/api/workspaces/' + randomUUID() + '/daily-note', headers })).statusCode, 404);
    const initial = await status('2026-11-04');
    assert.deepEqual(initial.json().settings, { timeZone: 'Asia/Shanghai', parentId: null, templateId: null });
    assert.equal((await status('2026-02-29')).statusCode, 400);

    const parent = await post(base + '/pages', { clientMutationId: randomUUID(), title: '每日笔记', parentId: null,
      content: blankDailyContent() });
    assert.equal(parent.statusCode, 201, parent.body);
    const settings = { clientMutationId: randomUUID(), timeZone: 'America/Los_Angeles', parentId: parent.json().id,
      templateId: 'reading' };
    const putSettings = (payload: object) => fastify.inject({ method: 'PUT', url: daily + '/settings', headers, payload });
    assert.equal((await putSettings({ ...settings, timeZone: '+08:00' })).statusCode, 400);
    assert.equal((await putSettings({ ...settings, parentId: randomUUID() })).json().error, 'DAILY_PARENT_UNAVAILABLE');
    assert.equal((await putSettings(settings)).statusCode, 200);
    assert.equal((await putSettings(settings)).statusCode, 200);
    assert.equal((await status('2026-11-04')).json().today, noteDateAt(settings.timeZone, new Date()));

    const date = '2026-11-04';
    const create = { clientMutationId: randomUUID(), date };
    const openResponses = await Promise.all([post(daily, create), post(daily, { ...create, clientMutationId: randomUUID() })]);
    assert.deepEqual(openResponses.map(result => result.statusCode).sort(), [200, 201]);
    const pageId = openResponses[0].json().id as string;
    assert.equal(openResponses[1].json().id, pageId);
    assert.equal(openResponses[0].json().parentId, parent.json().id);
    assert.equal(openResponses[0].json().content.editorState.root.children[0].children[0].text, date + ' / ' + date);
    assert.equal((await post(daily, create)).json().id, pageId);
    const pageUrl = base + '/pages/' + pageId;
    const moved = await fastify.inject({ method: 'PATCH', url: pageUrl, headers, payload: {
      clientMutationId: randomUUID(), expectedRevision: '1', title: '已改名', parentId: null,
    } });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await status(date)).json().page.id, pageId);

    const writes = ['第一条', '第二条'].map(text => ({ clientMutationId: randomUUID(), date, expectedRevision: '2', text }));
    const captured = await Promise.all(writes.map(payload => post(quick, payload)));
    assert.deepEqual(captured.map(result => result.statusCode).sort(), [200, 409]);
    const winner = captured.findIndex(result => result.statusCode === 200);
    const other = 1 - winner;
    assert.equal(captured[other]!.json().currentRevision, '3');
    assert.equal((await post(quick, writes[winner]!)).json().revision, '3');
    const winning = captured[winner]!.json();
    const heading = winning.content.editorState.root.children.find((node: { type: string }) => node.type === 'heading');
    heading.children[0].text = '改名后的随手记';
    assert.equal((await fastify.inject({ method: 'PATCH', url: pageUrl, headers, payload: {
      clientMutationId: randomUUID(), expectedRevision: '3', content: winning.content,
    } })).statusCode, 200);
    const appended = await post(quick, { ...writes[other], expectedRevision: '4' });
    assert.equal(appended.statusCode, 200, appended.body);
    const body = appended.json().content.editorState.root.children;
    assert.equal(body.filter((node: { $?: Record<string, unknown> }) => node.$?.[quickCaptureMarker] === true).length, 1);
    assert.deepEqual(body.map((node: { children: { text: string }[] }) => node.children[0]?.text),
      [date + ' / ' + date, '改名后的随手记', writes[winner]!.text, writes[other]!.text]);
    assert.equal((await fastify.inject({ method: 'GET', url: base + '/mutations/' + writes[winner]!.clientMutationId,
      headers })).json().response.revision, '3');

    const next = { clientMutationId: randomUUID(), date: '2026-11-05', text: '没有当日笔记也能记录' };
    const newCapture = await post(quick, next);
    assert.equal(newCapture.statusCode, 201, newCapture.body);
    assert.equal(newCapture.json().revision, '1');
    assert.equal((await post(quick, next)).json().id, newCapture.json().id);
    assert.equal((await post(quick, { ...next, clientMutationId: randomUUID() })).json().error, 'REVISION_CONFLICT');
    const trashed = await post(pageUrl + '/trash', { clientMutationId: randomUUID(), expectedRevision: '5' });
    assert.equal(trashed.statusCode, 200, trashed.body);
    assert.equal((await status(date)).json().page.deleted, true);
    assert.equal((await post(daily, { date, clientMutationId: randomUUID() })).json().error, 'DAILY_NOTE_TRASHED');
    assert.equal((await post(quick, { date, text: '尝试重复', clientMutationId: randomUUID() })).json().error, 'DAILY_NOTE_TRASHED');
    const restored = await post(pageUrl + '/restore', { clientMutationId: randomUUID(), expectedRevision: '6' });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual((await status(date)).json().page, { id: pageId, revision: '7', deleted: false });

    for (const role of ['viewer', 'editor']) {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id, login_name, password_hash) VALUES ($1, $2, $3)', [id, role, hash]);
      await pool.query('INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)',
        [owner.workspaceId, id, role]);
    }
    const viewer = await login('viewer');
    const editor = await login('editor');
    assert.equal((await fastify.inject({ method: 'GET', url: daily, headers: viewer })).statusCode, 200);
    assert.equal((await fastify.inject({ method: 'POST', url: quick, headers: viewer, payload: next })).statusCode, 403);
    assert.equal((await fastify.inject({ method: 'PUT', url: daily + '/settings', headers: editor, payload: settings })).statusCode, 403);
  } finally {
    await app?.close();
    await pool?.end();
    if (created) await admin.query('DROP DATABASE "' + database + '"');
    await admin.end();
  }
});
