import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';

function fakePool(appliedRows: Array<{ version: number; checksum: string }> = [], failSchema = false) {
  const statements: string[] = [];
  let released = false;
  const client = {
    async query(sql: string) {
      statements.push(sql.trim());
      if (sql.includes('SELECT version, checksum')) return { rows: appliedRows };
      if (failSchema && sql.includes('CREATE TABLE users')) throw new Error('schema write failed');
      return { rows: [] };
    },
    release() { released = true; },
  };
  const pool = { async connect() { return client; } } as unknown as Pick<Pool, 'connect'>;
  return { pool, statements, wasReleased: () => released };
}

test('initial migration commits once, and a matching migration is safe to rerun', async () => {
  const first = fakePool();
  assert.equal(await runMigrations(first.pool), migrations.length);
  assert.ok(first.statements.some((statement) => statement.includes('CREATE TABLE pages')));
  assert.ok(first.statements.some((statement) => statement.includes('CREATE TABLE attachments')));
  assert.ok(first.statements.some((statement) => statement.includes('ADD COLUMN search_text')));
  assert.ok(first.statements.some((statement) => statement.includes('CREATE TABLE page_versions')));
  assert.equal(first.statements.at(-1), 'COMMIT');
  assert.equal(first.wasReleased(), true);

  const applied = migrations.map(migration => ({ version: migration.version,
    checksum: createHash('sha256').update(migration.sql).digest('hex') }));
  const second = fakePool(applied);
  assert.equal(await runMigrations(second.pool), 0);
  assert.equal(second.statements.some((statement) => statement.includes('CREATE TABLE pages')), false);
  assert.equal(second.statements.at(-1), 'COMMIT');
});

test('schema drift or a newer database version aborts before business tables change', async () => {
  for (const appliedRows of [
    [{ version: 1, checksum: 'modified' }],
    [{ version: migrations.at(-1)!.version + 1, checksum: 'future' }],
  ]) {
    const state = fakePool(appliedRows);
    await assert.rejects(runMigrations(state.pool), /checksum differs|newer than this server/);
    assert.equal(state.statements.some((statement) => statement.includes('CREATE TABLE pages')), false);
    assert.equal(state.statements.at(-1), 'ROLLBACK');
    assert.equal(state.wasReleased(), true);
  }
});

test('a failed schema write rolls back and releases its connection', async () => {
  const state = fakePool([], true);
  await assert.rejects(runMigrations(state.pool), /schema write failed/);
  assert.equal(state.statements.at(-1), 'ROLLBACK');
  assert.equal(state.wasReleased(), true);
});
