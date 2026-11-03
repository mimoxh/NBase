import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

test('owner password uses a salted adaptive hash and rejects bad credentials', async () => {
  const password = 'correct horse battery staple';
  const stored = await hashPassword(password);
  assert.match(stored, /^scrypt:1:131072:8:1:/);
  assert.equal(stored.includes(password), false);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword('incorrect password', stored), false);
  assert.equal(await verifyPassword(password, `${stored}!`), false);
});

test('owner password creation rejects short secrets', async () => {
  await assert.rejects(hashPassword('short'), /at least 15 characters/);
});
