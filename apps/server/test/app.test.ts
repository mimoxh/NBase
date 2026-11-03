import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isHealthResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import type { PgPageRepository } from '../src/pages/repository.js';
import type { PgAttachmentRepository } from '../src/attachments/repository.js';
import type { AuthRepository } from '../src/auth/repository.js';

test('health reports only liveness and explicitly unconfigured persistence', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(isHealthResponse(response.json()), true);
  assert.equal((await app.inject('/api/ready')).statusCode, 503);
});

test('readiness reflects storage failure and recovery independently from liveness', async (t) => {
  let available = true;
  const app = await buildApp({
    auth: { repository: {} as AuthRepository, publicOrigin: 'http://127.0.0.1:3001' },
    pages: {} as PgPageRepository, attachments: {} as PgAttachmentRepository,
    readyCheck: async () => { if (!available) throw new Error('private storage details'); },
  });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/ready')).statusCode, 200);
  available = false;
  const failed = await app.inject('/api/ready');
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal(failed.body.includes('private'), false);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  available = true;
  assert.equal((await app.inject('/api/ready')).statusCode, 200);
});

test('web assets work without masking missing API endpoints', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nbase-static-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>NBase</title>');
  const app = await buildApp({ staticRoot: root });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);
  for (const url of ['/api/missing', '/assets/missing.js']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'NOT_FOUND' });
  }
});
