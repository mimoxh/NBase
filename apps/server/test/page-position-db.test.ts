import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { PageDocument, PageTreeResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'page position integration password only';
const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [{
  type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: '正文' }],
}] } } };

test('manual page order survives retries, parent moves and an exhausted gap without new revisions', {
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
    assert.ok(await runMigrations(pool) >= 12);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '排序测试');
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin }, payload: { loginName: 'owner', password } });
    assert.equal(login.statusCode, 200);
    const read = { cookie: String(login.headers['set-cookie']).split(';', 1)[0]! };
    const write = { ...read, origin, 'x-csrf-token': login.json().csrfToken as string };
    const create = async (title: string, parentId: string | null = null) => {
      const response = await app.inject({ method: 'POST', url: `${base}/pages`, headers: write,
        payload: { clientMutationId: randomUUID(), parentId, title, content } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<PageDocument>();
    };
    const place = (pageId: string, afterPageId: string | null) => app.inject({ method: 'PUT',
      url: `${base}/pages/${pageId}/position`, headers: write, payload: { afterPageId } });
    const titles = async (parentId: string | null = null) => {
      const tree = await app.inject({ url: `${base}/page-tree`, headers: read });
      assert.equal(tree.statusCode, 200, tree.body);
      return tree.json<PageTreeResponse>().pages.filter(page => page.parentId === parentId).map(page => page.title);
    };

    const a = await create('甲');
    const b = await create('乙');
    const c = await create('丙');
    assert.deepEqual(await titles(), ['甲', '乙', '丙']);

    assert.equal((await place(c.id, null)).statusCode, 204);
    assert.deepEqual(await titles(), ['丙', '甲', '乙']);
    assert.equal((await place(c.id, a.id)).statusCode, 204);
    assert.equal((await place(c.id, a.id)).statusCode, 204);
    assert.deepEqual(await titles(), ['甲', '丙', '乙']);

    const unchanged = await app.inject({ url: `${base}/pages/${c.id}`, headers: read });
    assert.equal(unchanged.json<PageDocument>().revision, c.revision);

    assert.equal((await place(a.id, a.id)).statusCode, 400);
    assert.equal((await place(randomUUID(), null)).statusCode, 404);
    const child = await create('子', a.id);
    assert.equal((await place(b.id, child.id)).statusCode, 409);

    // Repeated halving uses up the gap and forces one renumbering of the group.
    for (let round = 0; round < 24; round += 1) {
      assert.equal((await place(round % 2 ? b.id : c.id, a.id)).statusCode, 204);
    }
    assert.equal((await titles()).length, 3);
    assert.equal((await titles())[0], '甲');

    const moved = await app.inject({ method: 'PATCH', url: `${base}/pages/${b.id}`, headers: write,
      payload: { clientMutationId: randomUUID(), expectedRevision: b.revision, parentId: a.id } });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.deepEqual(await titles(a.id), ['子', '乙']);
  } finally {
    await app.close();
    await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});
