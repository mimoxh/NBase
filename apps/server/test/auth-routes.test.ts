import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthWorkspace } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import type { AccountRecord, AuthRepository, StoredSession } from '../src/auth/repository.js';
import type { SessionTokens } from '../src/auth/session.js';

const origin = 'http://127.0.0.1:3001';
const validPassword = 'a deliberately long test password';

class MemoryAuthRepository implements AuthRepository {
  readonly account: AccountRecord;
  readonly workspaces: AuthWorkspace[] = [{ id: 'workspace-1', name: '我的空间', role: 'owner' }];
  private readonly sessions = new Map<string, StoredSession>();

  constructor(passwordHash: string) {
    this.account = { id: 'user-1', loginName: 'owner', passwordHash, authEpoch: '1', disabled: false };
  }

  async findAccount(loginName: string): Promise<AccountRecord | null> {
    return loginName === this.account.loginName ? this.account : null;
  }

  async createSession(account: AccountRecord, tokens: SessionTokens): Promise<boolean> {
    this.sessions.set(tokens.tokenHash.toString('hex'), {
      userId: account.id,
      loginName: this.account.loginName,
      csrfHash: tokens.csrfHash,
      expiresAt: tokens.expiresAt,
      revoked: false,
      disabled: false,
    });
    return true;
  }

  async loadSession(tokenHash: Buffer): Promise<StoredSession | null> {
    return this.sessions.get(tokenHash.toString('hex')) ?? null;
  }

  async revokeSession(tokenHash: Buffer): Promise<void> {
    const session = await this.loadSession(tokenHash);
    if (session) session.revoked = true;
  }

  async workspacesForUser(userId: string): Promise<AuthWorkspace[]> {
    return userId === this.account.id ? this.workspaces : [];
  }

  expireSessions(): void {
    for (const session of this.sessions.values()) session.expiresAt = new Date(0);
  }
}

test('login creates a server session, session read checks it, and logout requires origin and CSRF', async (t) => {
  const repository = new MemoryAuthRepository(await hashPassword(validPassword));
  const app = await buildApp({ auth: { repository, publicOrigin: origin } });
  t.after(() => app.close());

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.json().persistence, 'accounts-only');

  const noSession = await app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.equal(noSession.statusCode, 401);
  const publicSetup = await app.inject({ method: 'POST', url: '/api/auth/setup' });
  assert.equal(publicSetup.statusCode, 404);

  const badOrigin = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin: 'http://elsewhere.test' },
    payload: { loginName: 'owner', password: validPassword },
  });
  assert.equal(badOrigin.statusCode, 403);
  const badPassword = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin },
    payload: { loginName: 'owner', password: 'wrong password' },
  });
  assert.equal(badPassword.statusCode, 401);
  assert.equal(badPassword.json().error, 'AUTH_INVALID');

  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin },
    payload: { loginName: 'Owner', password: validPassword },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.headers['cache-control'], 'no-store');
  const cookie = login.headers['set-cookie'];
  assert.equal(typeof cookie, 'string');
  assert.match(cookie as string, /^nbase_session=/);
  assert.match(cookie as string, /HttpOnly; SameSite=Strict/);
  const cookiePair = (cookie as string).split(';', 1)[0]!;
  const csrfToken = login.json().csrfToken as string;
  assert.equal(login.json().workspaces[0].role, 'owner');

  const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: cookiePair } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().csrfToken, csrfToken);
  const missingCsrf = await app.inject({
    method: 'POST', url: '/api/auth/logout', headers: { origin, cookie: cookiePair }, payload: {},
  });
  assert.equal(missingCsrf.statusCode, 403);
  const crossOrigin = await app.inject({
    method: 'POST', url: '/api/auth/logout',
    headers: { origin: 'http://elsewhere.test', cookie: cookiePair, 'x-csrf-token': csrfToken }, payload: {},
  });
  assert.equal(crossOrigin.statusCode, 403);
  const logout = await app.inject({
    method: 'POST', url: '/api/auth/logout',
    headers: { origin, cookie: cookiePair, 'x-csrf-token': csrfToken }, payload: {},
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  const afterLogout = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: cookiePair } });
  assert.equal(afterLogout.statusCode, 401);
});

test('credentials invalidated during login do not issue a cookie', async (t) => {
  const repository = new MemoryAuthRepository(await hashPassword(validPassword));
  repository.createSession = async () => false;
  const app = await buildApp({ auth: { repository, publicOrigin: origin } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
    payload: { loginName: 'owner', password: validPassword } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('expired session is rejected and clears its cookie', async (t) => {
  const repository = new MemoryAuthRepository(await hashPassword(validPassword));
  const app = await buildApp({ auth: { repository, publicOrigin: origin } });
  t.after(() => app.close());
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin },
    payload: { loginName: 'owner', password: validPassword },
  });
  assert.equal(login.statusCode, 200);
  repository.expireSessions();
  const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
  const expired = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json().error, 'AUTH_EXPIRED');
  assert.match(String(expired.headers['set-cookie']), /Max-Age=0/);
});
