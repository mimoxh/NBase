import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { whiteboardContent, type PageBacklinksResponse, type PageDocument, type WhiteboardElement } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'whiteboard integration password only';
const box = { x: 0, y: 0, w: 160, h: 80, angle: 0 };
const documentContent = (value: string) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1,
  children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: value }] }] } } });
const note = (text: string): WhiteboardElement => ({ id: randomUUID(), type: 'note', ...box, text, color: '#fff3b0', fontSize: 16, textAlign: 'left' });
const card = (pageId: string, label: string): WhiteboardElement => ({ id: randomUUID(), type: 'card', ...box, pageId, label });

test('whiteboard pages share revisions, history, trash, search and backlinks with documents', {
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
    assert.ok(await runMigrations(pool) >= 19);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '白板测试');
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password } });
    assert.equal(login.statusCode, 200);
    const read = { cookie: String(login.headers['set-cookie']).split(';', 1)[0]! };
    const write = { ...read, origin, 'x-csrf-token': login.json().csrfToken as string };
    const get = (path: string) => app.inject({ url: base + path, headers: read });
    const mutate = (method: 'POST' | 'PATCH', path: string, payload: object) =>
      app.inject({ method, url: base + path, headers: write, payload: { clientMutationId: randomUUID(), ...payload } });
    const ok = async (response: Awaited<ReturnType<typeof mutate>>, status = 200) => {
      assert.equal(response.statusCode, status, response.body);
      return response.json<PageDocument>();
    };

    const target = await ok(await mutate('POST', '/pages', { parentId: null, title: '源文档', content: documentContent('正文') }), 201);
    let board = await ok(await mutate('POST', '/pages', { parentId: null, title: '架构白板',
      content: whiteboardContent([note('白板便签独有词'), card(target.id, '源文档卡片')]) }), 201);
    assert.equal(board.kind, 'whiteboard');
    assert.equal((await get('/page-tree')).json().pages.find((page: PageDocument) => page.id === board.id).kind, 'whiteboard');
    assert.equal((await get(`/search?q=${encodeURIComponent('白板便签独有词')}`)).json().results[0].pageId, board.id);
    const links = (await get(`/pages/${target.id}/backlinks`)).json<PageBacklinksResponse>().links;
    assert.deepEqual(links.map(link => [link.sourcePageId, link.occurrence, link.snippet]), [[board.id, 0, '源文档卡片']]);

    // The kind and the content shape cannot drift apart in either direction.
    for (const [page, content] of [[board, documentContent('变成文档')], [target, whiteboardContent([])]] as const) {
      const response = await mutate('PATCH', `/pages/${page.id}`, { expectedRevision: page.revision, content });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().error, 'PAGE_KIND_INVALID');
    }
    assert.equal((await mutate('POST', '/pages', { parentId: board.id, title: '子页面', content: documentContent('x') })).statusCode, 422);
    const missingCard = await mutate('PATCH', `/pages/${board.id}`, { expectedRevision: board.revision,
      content: whiteboardContent([card(randomUUID(), '不存在')]) });
    assert.equal(missingCard.json().error, 'PAGE_REFERENCE_INVALID');
    const missingImage = await mutate('PATCH', `/pages/${board.id}`, { expectedRevision: board.revision, content: whiteboardContent([
      { id: randomUUID(), type: 'image', ...box, attachmentId: randomUUID(), fileName: 'a.png', mediaType: 'image/png' }]) });
    assert.equal(missingImage.json().error, 'ATTACHMENT_INVALID');
    const invalid = await mutate('PATCH', `/pages/${board.id}`, { expectedRevision: board.revision,
      content: { ...whiteboardContent([]), board: { elements: [{ type: 'widget' }] } } });
    assert.equal(invalid.json().error, 'CONTENT_INVALID');

    // Saving, conflicts, history and trash follow the document path.
    const stale = board.revision;
    board = await ok(await mutate('PATCH', `/pages/${board.id}`, { expectedRevision: board.revision, content: whiteboardContent([note('第二版')]) }));
    assert.equal((await mutate('PATCH', `/pages/${board.id}`, { expectedRevision: stale, content: whiteboardContent([]) })).statusCode, 409);
    assert.equal((await get(`/pages/${target.id}/backlinks`)).json().links.length, 0);
    assert.equal((await get(`/search?q=${encodeURIComponent('白板便签独有词')}`)).json().results.length, 0);
    board = await ok(await mutate('POST', `/pages/${board.id}/restore-version`, { expectedRevision: board.revision, sourceRevision: '1' }));
    assert.equal(board.kind, 'whiteboard');
    assert.equal((board.content as ReturnType<typeof whiteboardContent>).board.elements.length, 2);
    assert.equal((await get(`/pages/${target.id}/backlinks`)).json().links.length, 1);
    board = await ok(await mutate('POST', `/pages/${board.id}/trash`, { expectedRevision: board.revision }));
    assert.equal((await get(`/pages/${board.id}`)).statusCode, 404);
    board = await ok(await mutate('POST', `/pages/${board.id}/restore`, { expectedRevision: board.revision }));
    assert.equal((await get(`/pages/${board.id}`)).json<PageDocument>().kind, 'whiteboard');
  } finally {
    await app.close();
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  }
});
