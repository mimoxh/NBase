import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { defaultDatabaseSchema } from '@nbase/contracts';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const content = JSON.stringify({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [] } } });

test('migration 27 keeps the current schema of every database as its first history version', {
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
    for (const migration of migrations.filter(item => item.version < 27)) {
      await pool.query(migration.sql);
      await pool.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex')]);
    }
    const owner = await initializeOwner(pool, 'owner', await hashPassword('migration test password only'), '迁移测试');
    const id = randomUUID();
    const schema = defaultDatabaseSchema({ title: randomUUID(), view: randomUUID() });
    await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, kind)
      VALUES ($1, $2, NULL, '旧表', $3::jsonb, 1, '', 'database')`, [id, owner.workspaceId, content]);
    await pool.query(`INSERT INTO databases (workspace_id, page_id, properties_json, views_json, revision, updated_at)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, 7, '2026-11-01T00:00:00Z')`, [owner.workspaceId, id, JSON.stringify(schema.properties), JSON.stringify(schema.views)]);

    assert.equal(await runMigrations(pool), migrations.filter(item => item.version >= 27).length);
    const versions = await pool.query<{ revision: string; operation: string; actor_user_id: string | null; saved_at: Date; properties_json: unknown }>(
      'SELECT revision::text, operation, actor_user_id, saved_at, properties_json FROM database_schema_versions WHERE database_id = $1', [id]);
    assert.deepEqual(versions.rows.map(row => [row.revision, row.operation, row.actor_user_id, row.saved_at.toISOString()]),
      [['7', 'baseline', null, '2026-11-01T00:00:00.000Z']]);
    assert.deepEqual(versions.rows[0]!.properties_json, schema.properties);
    assert.equal(await runMigrations(pool), 0);
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});
