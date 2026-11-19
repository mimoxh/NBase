import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { defaultDatabaseSchema } from '@nbase/contracts';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { searchPageHistory, searchWorkspaceHistory } from '../src/search/history.js';
import { runHistoryTextBatch } from '../src/search/history-index.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const content = (...texts: string[]) => JSON.stringify({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1,
  children: texts.map(text => ({ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text }] })) } } });

test('migration 29 copies the current text into each page\'s newest version and leaves older ones to the indexer', {
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
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await pool.query(`CREATE TABLE schema_migrations (version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of migrations.filter(item => item.version < 29)) {
      await pool.query(migration.sql);
      await pool.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex')]);
    }
    const owner = await initializeOwner(pool, 'owner', await hashPassword('migration test password only'), '迁移测试');
    const ws = owner.workspaceId;
    const version = (pageId: string, revision: number, title: string, body: string, parentId: string | null = null,
      rowProperties: Record<string, unknown> | null = null) => pool.query(`INSERT INTO page_versions (workspace_id, page_id,
        revision, title, parent_id, content_json, content_schema_version, saved_at, actor_user_id, operation, row_properties)
      VALUES ($1, $2, $3::bigint, $4, $5, $6::jsonb, 1, now() - ($3::bigint * interval '1 minute'), $7, $8, $9::jsonb)`,
    [ws, pageId, revision, title, parentId, body, owner.userId, revision === 1 ? 'create' : 'update', rowProperties && JSON.stringify(rowProperties)]);

    const note = randomUUID();
    await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, revision)
      VALUES ($1, $2, NULL, '会议记录', $3::jsonb, 1, '第三版 当前内容', 3)`, [note, ws, content('第三版', '当前内容')]);
    await version(note, 1, '会议草稿', content('第一版', '旧词甲'));
    await version(note, 2, '会议记录', content('第二版', '旧词乙'));
    await version(note, 3, '会议记录', content('第三版', '当前内容'));

    const dbId = randomUUID();
    const propertyId = randomUUID();
    const schema = defaultDatabaseSchema({ title: randomUUID(), view: randomUUID() });
    const properties = [...schema.properties, { id: propertyId, name: '备注', type: 'text' }];
    await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, kind)
      VALUES ($1, $2, NULL, '任务表', $3::jsonb, 1, '', 'database')`, [dbId, ws, content()]);
    await pool.query(`INSERT INTO databases (workspace_id, page_id, properties_json, views_json) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [ws, dbId, JSON.stringify(properties), JSON.stringify(schema.views)]);
    const row = randomUUID();
    await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, kind,
      row_properties, revision) VALUES ($1, $2, $3, '一行', $4::jsonb, 1, '行正文 现在的备注', 'row', $5::jsonb, 2)`,
    [row, ws, dbId, content('行正文'), JSON.stringify({ [propertyId]: '现在的备注' })]);
    await version(row, 1, '一行', content('行正文'), dbId, { [propertyId]: '最初的备注' });
    await version(row, 2, '一行', content('行正文'), dbId, { [propertyId]: '现在的备注' });

    assert.equal(await runMigrations(pool), migrations.filter(item => item.version >= 29).length);
    const texts = async () => (await pool.query<{ page_id: string; revision: string; search_text: string | null }>(
      'SELECT page_id, revision::text, search_text FROM page_versions ORDER BY page_id = $1 DESC, revision', [note])).rows
      .map(item => [item.page_id === note ? 'note' : 'row', item.revision, item.search_text]);
    assert.deepEqual(await texts(), [['note', '1', null], ['note', '2', null], ['note', '3', '第三版 当前内容'],
      ['row', '1', null], ['row', '2', '行正文 现在的备注']]);

    // Before the indexer runs, old versions are found by title only, and the response says how many are waiting.
    const early = await searchPageHistory(pool, ws, owner.userId, note, '旧词甲', 50);
    assert.deepEqual([early.versions.length, early.pendingVersions], [0, 2]);
    assert.deepEqual((await searchPageHistory(pool, ws, owner.userId, note, '会议草稿', 50)).versions.map(item => item.revision), ['1']);

    assert.equal(await runHistoryTextBatch(pool, 2), true);
    while (await runHistoryTextBatch(pool)) { /* drain */ }
    assert.deepEqual(await texts(), [['note', '1', '第一版 旧词甲'], ['note', '2', '第二版 旧词乙'], ['note', '3', '第三版 当前内容'],
      ['row', '1', '行正文 最初的备注'], ['row', '2', '行正文 现在的备注']]);
    assert.equal(await runHistoryTextBatch(pool), false);

    const found = await searchPageHistory(pool, ws, owner.userId, note, '旧词甲', 50);
    assert.deepEqual(found.versions.map(item => [item.revision, item.matchField, item.snippet]), [['1', 'content', '第一版 旧词甲']]);
    assert.equal(found.pendingVersions, 0);
    const across = await searchWorkspaceHistory(pool, ws, owner.userId, '最初的备注', 20, []);
    assert.deepEqual(across.results.map(item => [item.pageId, item.version.revision, item.currentMatches]), [[row, '1', false]]);
    assert.equal(await runMigrations(pool), 0);
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});
