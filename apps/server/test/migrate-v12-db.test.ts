import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const content = JSON.stringify({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [] } } });

test('migration 12 keeps the existing creation order and puts later pages last', {
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
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    // Build a v11 database the way older servers did; no pages exist yet, so no backfills are needed.
    await pool.query(`CREATE TABLE schema_migrations (version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of migrations.filter(item => item.version <= 11)) {
      await pool.query(migration.sql);
      await pool.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex')]);
    }
    const owner = await initializeOwner(pool, 'owner', await hashPassword('migration test password only'), '迁移测试');
    // Identifiers sort opposite to creation time, so the backfill must follow created_at.
    const pages = [
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', title: '最早', createdAt: '2026-01-01T00:00:00Z' },
      { id: '88888888-8888-4888-8888-888888888888', title: '其次', createdAt: '2026-02-01T00:00:00Z' },
      { id: '11111111-1111-4111-8111-111111111111', title: '最晚', createdAt: '2026-03-01T00:00:00Z' },
    ];
    for (const page of pages) {
      await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, created_at)
        VALUES ($1, $2, NULL, $3, $4::jsonb, 1, '', $5::timestamptz)`, [page.id, owner.workspaceId, page.title, content, page.createdAt]);
    }
    const before = await pool.query<{ revision: string; updated_at: Date }>('SELECT revision::text, updated_at FROM pages ORDER BY id');

    assert.equal(await runMigrations(pool), migrations.filter(item => item.version > 11).length);
    const ordered = await pool.query<{ title: string; sort_position: string }>(
      'SELECT title, sort_position::text FROM pages ORDER BY sort_position');
    assert.deepEqual(ordered.rows.map(row => row.title), ['最早', '其次', '最晚']);
    assert.deepEqual(ordered.rows.map(row => row.sort_position), ['1024', '2048', '3072']);
    const after = await pool.query<{ revision: string; updated_at: Date }>('SELECT revision::text, updated_at FROM pages ORDER BY id');
    assert.deepEqual(after.rows, before.rows);

    await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text)
      VALUES ($1, $2, NULL, '新建', $3::jsonb, 1, '')`, [randomUUID(), owner.workspaceId, content]);
    const latest = await pool.query<{ title: string }>('SELECT title FROM pages ORDER BY sort_position DESC LIMIT 1');
    assert.equal(latest.rows[0]?.title, '新建');
    const column = await pool.query<{ is_nullable: string }>(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'sort_position'");
    assert.equal(column.rows[0]?.is_nullable, 'NO');
    assert.equal(await runMigrations(pool), 0);
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});

test('migration 12 succeeds on an empty database', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const database = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: sourceUrl, connectionTimeoutMillis: 5000 });
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), connectionTimeoutMillis: 5000 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    assert.equal(await runMigrations(pool), migrations.length);
    const value = await pool.query<{ position: string }>("SELECT (nextval('pages_sort_position_seq') * 1024)::text AS position");
    assert.equal(value.rows[0]?.position, '1024');
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});
