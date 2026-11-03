import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseConfig, readSecretFile, serverConfig } from '../src/config.js';

test('persistent mode fails closed for missing, mixed or invalid configuration', async () => {
  assert.equal((await serverConfig({})).database, undefined);
  await assert.rejects(serverConfig({ NBASE_REQUIRE_DATABASE: '1' }), /configuration is required/);
  await assert.rejects(databaseConfig({ NBASE_DATABASE_URL: '' }), /PostgreSQL URL/);
  await assert.rejects(databaseConfig({ NBASE_DATABASE_URL: 'postgres://host/db', NBASE_DATABASE_HOST: 'host' }), /not both/);
  await assert.rejects(databaseConfig({ NBASE_DATABASE_HOST: 'host' }), /required together/);
  await assert.rejects(serverConfig({ NBASE_DATABASE_URL: 'postgres://host/db', NBASE_PUBLIC_ORIGIN: 'http://public.test',
    NBASE_ATTACHMENT_DIR: '/data' }), /local loopback/);
});

test('file credentials preserve URL-special characters and reject invalid secret files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nbase-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'password');
  const password = 'test-only:@/%$ plus space';
  await writeFile(file, password + '\r\n');
  const config = await databaseConfig({ NBASE_DATABASE_HOST: 'db', NBASE_DATABASE_NAME: 'nbase',
    NBASE_DATABASE_USER: 'nbase', NBASE_DATABASE_PASSWORD_FILE: file });
  assert.equal(config?.password, password);
  assert.equal(config?.port, 5432);
  for (const value of ['', 'first\nsecond', 'x'.repeat(4097)]) {
    await writeFile(file, value);
    await assert.rejects(readSecretFile(file));
  }
});
