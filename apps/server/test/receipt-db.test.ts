import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { hashPassword } from '../src/auth/password.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;

function content(text: string) {
  return { schemaVersion: 1, editorState: { root: {
    type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [
      { type: 'text', version: 1, text, style: '' },
    ] }],
  } } };
}

async function withDatabase(action: (pool: pg.Pool) => Promise<void>) {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 5000 });
  const databaseName = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
    await action(pool);
  } finally {
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
}

const storedReceipt = async (pool: pg.Pool, mutationId: string) => (await pool.query<{ response_json: Record<string, unknown> }>(
  'SELECT response_json FROM page_mutation_receipts WHERE client_mutation_id = $1', [mutationId])).rows[0]!.response_json;

test('page receipts keep one body copy and replay the body of their own revision', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, () => withDatabase(async pool => {
  await runMigrations(pool);
  const owner = await initializeOwner(pool, 'owner', await hashPassword('local integration password only'), '测试空间');
  const pages = new PgPageRepository(pool);
  const { workspaceId, userId } = owner;

  const createBody = { clientMutationId: randomUUID(), parentId: null, title: '收据', content: content('初稿') };
  const created = await pages.create(workspaceId, userId, createBody);
  const firstUpdate = { clientMutationId: randomUUID(), expectedRevision: created.body.revision, content: content('第二稿') };
  const updated = await pages.update(workspaceId, userId, created.body.id, firstUpdate);
  const secondUpdate = { clientMutationId: randomUUID(), expectedRevision: updated.body.revision, content: content('第三稿') };
  await pages.update(workspaceId, userId, created.body.id, secondUpdate);

  for (const mutationId of [createBody.clientMutationId, firstUpdate.clientMutationId, secondUpdate.clientMutationId]) {
    assert.equal('content' in await storedReceipt(pool, mutationId), false);
  }

  // The page has moved on; a late replay must still describe the original write.
  assert.deepEqual((await pages.update(workspaceId, userId, created.body.id, firstUpdate)).body, updated.body);
  assert.deepEqual((await pages.create(workspaceId, userId, createBody)).body, created.body);
  assert.deepEqual((await pages.receipt(workspaceId, userId, firstUpdate.clientMutationId))?.body, updated.body);
  const versions = await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM page_versions WHERE page_id = $1', [created.body.id]);
  assert.equal(versions.rows[0]!.count, 3);

  const trashBody = { clientMutationId: randomUUID(), expectedRevision: '3' };
  const trashed = await pages.trash(workspaceId, userId, created.body.id, trashBody);
  assert.equal('content' in await storedReceipt(pool, trashBody.clientMutationId), false);
  assert.deepEqual((await pages.trash(workspaceId, userId, created.body.id, trashBody)).body, trashed.body);
}));

test('v11 compacts only receipts proven identical to their snapshot', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, () => withDatabase(async pool => {
  await runMigrations(pool);
  const owner = await initializeOwner(pool, 'owner', await hashPassword('local integration password only'), '测试空间');
  const pages = new PgPageRepository(pool);
  const { workspaceId, userId } = owner;
  const body = { clientMutationId: randomUUID(), parentId: null, title: '旧收据', content: content('旧正文') };
  const page = (await pages.create(workspaceId, userId, body)).body;

  const legacy = async (operation: string, pageId: string | null, response: object) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO page_mutation_receipts (workspace_id, actor_user_id, client_mutation_id, operation,
      request_hash, page_id, response_status, response_json) VALUES ($1, $2, $3, $4, $5, $6, 200, $7::jsonb)`,
    [workspaceId, userId, id, operation, Buffer.alloc(32), pageId, JSON.stringify(response)]);
    return id;
  };
  const same = await legacy('update', page.id, page);
  const different = await legacy('update', page.id, { ...page, content: content('快照里没有的正文') });
  const noSnapshot = await legacy('update', page.id, { ...page, revision: '99' });
  const oddRevision = await legacy('update', page.id, { ...page, revision: 'not-a-number' });
  const template = await legacy('template-create', null, { id: randomUUID(), revision: '1', content: page.content });
  const tag = await legacy('tag-create', null, { id: randomUUID(), name: '标签' });

  await pool.query(migrations.find(migration => migration.name === 'compact_page_receipts')!.sql);

  assert.equal('content' in await storedReceipt(pool, same), false);
  for (const kept of [different, noSnapshot, oddRevision, template]) assert.equal('content' in await storedReceipt(pool, kept), true);
  assert.equal((await storedReceipt(pool, tag)).name, '标签');

  assert.deepEqual((await pages.receipt(workspaceId, userId, same))?.body, page);
  assert.deepEqual((await pages.receipt(workspaceId, userId, different))?.body.content, content('快照里没有的正文'));

  // Running it again finds nothing left to prove and changes nothing.
  const before = await pool.query('SELECT client_mutation_id, response_json FROM page_mutation_receipts ORDER BY client_mutation_id');
  await pool.query(migrations.find(migration => migration.name === 'compact_page_receipts')!.sql);
  const after = await pool.query('SELECT client_mutation_id, response_json FROM page_mutation_receipts ORDER BY client_mutation_id');
  assert.deepEqual(after.rows, before.rows);
}));
