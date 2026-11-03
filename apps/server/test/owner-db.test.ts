import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { maintainOwner } from '../src/auth/maintain-owner.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { createSessionTokens } from '../src/auth/session.js';

// Pause a real transaction before COMMIT to exercise both lock orders deterministically.
function holdCommit(pool: pg.Pool) {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  const held = { query: pool.query.bind(pool), async connect() {
    const client = await pool.connect();
    return {
      async query(sql: string, values?: unknown[]) {
        if (sql === 'COMMIT') { arrived(); await gate; }
        return client.query(sql, values);
      },
      release() { client.release(); },
    };
  } } as unknown as Pick<pg.Pool, 'connect' | 'query'>;
  return { held, ready, release };
}

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
async function waitForAccountLock(pool: pg.Pool, sqlPattern: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock' AND query LIKE $1
    ) AS waiting`, [sqlPattern]);
    if (result.rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The concurrent account transaction did not enter a real PostgreSQL lock wait');
}
test('owner maintenance is atomic and invalidates in-flight logins in both lock orders', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to the disposable local PostgreSQL instance',
  timeout: 30000,
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000 });
  const databaseName = `nbase_owner_test_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    source.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: source.toString(), max: 4, connectionTimeoutMillis: 5000 });
    await runMigrations(pool);
    const originalHash = await hashPassword('original owner test password');
    const replacementHash = await hashPassword('replacement owner test password');
    const owner = await initializeOwner(pool, 'owner', originalHash, '维护测试');
    // Exact v4 schema -> v5 migration must retain the original account and memberships.
    await pool.query('ALTER TABLE users DROP COLUMN auth_epoch');
    await pool.query('DELETE FROM schema_migrations WHERE version = 5');
    assert.equal(await runMigrations(pool), 1);
    const repository = new PgAuthRepository(pool);
    const original = (await repository.findAccount('owner'))!;
    assert.equal(original.id, owner.userId);
    assert.equal(original.authEpoch, '1');
    const session = createSessionTokens();
    assert.equal(await repository.createSession(original, session), true);
    await assert.rejects(maintainOwner(pool, 'wrong-owner', replacementHash), /does not match/);
    assert.equal((await repository.loadSession(session.tokenHash))?.revoked, false);
    assert.equal((await repository.findAccount('owner'))?.passwordHash, originalHash);

    // A database error after updating the password must roll back password, epoch and revocations.
    await pool.query(`CREATE FUNCTION reject_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected revoke failure'; END $$;
      CREATE TRIGGER reject_revoke BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_revoke()`);
    await assert.rejects(maintainOwner(pool, 'owner', replacementHash), /injected revoke failure/);
    assert.equal((await repository.findAccount('owner'))?.authEpoch, '1');
    assert.equal((await repository.findAccount('owner'))?.passwordHash, originalHash);
    assert.equal((await repository.loadSession(session.tokenHash))?.revoked, false);
    await pool.query('DROP TRIGGER reject_revoke ON sessions; DROP FUNCTION reject_revoke()');

    // Maintenance holds the lock first: a previously verified password cannot start a session.
    const resetGate = holdCommit(pool);
    const resetting = maintainOwner(resetGate.held, 'owner', replacementHash);
    try {
      await resetGate.ready;
      const lateLogin = repository.createSession(original, createSessionTokens());
      await waitForAccountLock(pool, 'SELECT password_hash, auth_epoch%');
      resetGate.release();
      await resetting;
      assert.equal(await lateLogin, false);
    } finally { resetGate.release(); }
    assert.equal((await repository.loadSession(session.tokenHash))?.revoked, true);
    const updated = (await repository.findAccount('owner'))!;
    assert.equal(await verifyPassword('original owner test password', updated.passwordHash), false);
    assert.equal(await verifyPassword('replacement owner test password', updated.passwordHash), true);

    // Login holds the lock first: maintenance revokes the newly inserted session too.
    const loginGate = holdCommit(pool);
    const nextSession = createSessionTokens();
    const loggingIn = new PgAuthRepository(loginGate.held).createSession(updated, nextSession);
    try {
      await loginGate.ready;
      const revoking = maintainOwner(pool, 'owner');
      await waitForAccountLock(pool, '%JOIN instance_state i ON%');
      loginGate.release();
      assert.equal(await loggingIn, true);
      await revoking;
    } finally { loginGate.release(); }
    assert.equal((await repository.loadSession(nextSession.tokenHash))?.revoked, true);
    assert.equal(await repository.createSession(updated, createSessionTokens()), false);
    const current = (await repository.findAccount('owner'))!;
    assert.equal(current.passwordHash, replacementHash);
    assert.equal(await repository.createSession(current, createSessionTokens()), true);
    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [owner.userId]);
    await assert.rejects(maintainOwner(pool, 'owner', originalHash), /disabled/);
    assert.equal(await repository.createSession(current, createSessionTokens()), false);
  } finally {
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});
