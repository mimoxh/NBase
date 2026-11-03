import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSessionCookie,
  createSessionTokens,
  csrfTokenForSession,
  publicOriginConfig,
  readSessionToken,
  sessionCookie,
  sessionTokenHash,
  verifyCsrf,
} from '../src/auth/session.js';

test('session tokens are opaque, unique, server hashed and bound to CSRF', () => {
  const first = createSessionTokens(new Date('2026-10-25T00:00:00Z'));
  const second = createSessionTokens(new Date('2026-10-25T00:00:00Z'));
  assert.notEqual(first.token, second.token);
  assert.equal(first.token.length, 43);
  assert.deepEqual(sessionTokenHash(first.token), first.tokenHash);
  assert.equal(csrfTokenForSession(first.token), first.csrfToken);
  assert.equal(verifyCsrf(first.csrfHash, first.csrfToken), true);
  assert.equal(verifyCsrf(first.csrfHash, second.csrfToken), false);
  assert.equal(first.expiresAt.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('cookies stay host-only and secure outside loopback development', () => {
  const token = createSessionTokens().token;
  const secure = sessionCookie(token, true);
  assert.match(secure, /^__Host-nbase_session=/);
  assert.match(secure, /HttpOnly; SameSite=Strict/);
  assert.match(secure, /; Secure$/);
  assert.equal(secure.includes('Domain='), false);
  assert.equal(readSessionToken(secure, true), token);
  assert.equal(readSessionToken(`${secure}; __Host-nbase_session=${token}`, true), null);
  assert.match(clearSessionCookie(true), /Max-Age=0; Secure$/);
  assert.deepEqual(publicOriginConfig('http://127.0.0.1:3001'), { origin: 'http://127.0.0.1:3001', secure: false });
  assert.throws(() => publicOriginConfig('http://example.com'), /loopback/);
  assert.throws(() => publicOriginConfig('https://example.com/path'), /exact HTTP/);
});
