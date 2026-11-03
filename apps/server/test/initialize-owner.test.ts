import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { initializeOwner } from '../src/auth/initialize-owner.js';

function fakePool(initialized: boolean) {
  const statements: string[] = [];
  let released = false;
  const client = {
    async query(sql: string) {
      statements.push(sql.trim());
      if (sql.includes('SELECT owner_user_id')) return { rowCount: initialized ? 1 : 0, rows: initialized ? [{}] : [] };
      return { rowCount: 1, rows: [] };
    },
    release() { released = true; },
  };
  return {
    pool: { async connect() { return client; } } as unknown as Pick<Pool, 'connect'>,
    statements,
    wasReleased: () => released,
  };
}

test('owner bootstrap writes owner, workspace and membership in one transaction', async () => {
  const state = fakePool(false);
  const identity = await initializeOwner(state.pool, 'owner', 'hashed-password', '我的空间');
  assert.match(identity.userId, /^[0-9a-f-]{36}$/);
  assert.match(identity.workspaceId, /^[0-9a-f-]{36}$/);
  assert.equal(state.statements.filter((statement) => statement.startsWith('INSERT')).length, 4);
  assert.equal(state.statements.at(-1), 'COMMIT');
  assert.equal(state.wasReleased(), true);
});

test('owner bootstrap refuses an existing instance before inserting anything', async () => {
  const state = fakePool(true);
  await assert.rejects(initializeOwner(state.pool, 'owner', 'hashed-password', '我的空间'), /already initialized/);
  assert.equal(state.statements.some((statement) => statement.startsWith('INSERT')), false);
  assert.equal(state.statements.at(-1), 'ROLLBACK');
  assert.equal(state.wasReleased(), true);
});
