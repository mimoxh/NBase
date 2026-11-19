import { loginNamePattern, type AuthSessionResponse, type LoginRequest } from '@nbase/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from './password.js';
import { FailureLimiter } from './limiter.js';
import type { AuthRepository, StoredSession } from './repository.js';
import {
  clearSessionCookie,
  createSessionTokens,
  csrfTokenForSession,
  publicOriginConfig,
  readSessionToken,
  sessionCookie,
  sessionTokenHash,
  verifyCsrf,
} from './session.js';

const maxLoginPasswordBytes = 1024;
const loginWindowMs = 15 * 60 * 1000;
const maxFailedLogins = 5;

function isLoginRequest(value: unknown): value is LoginRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body.loginName === 'string' && loginNamePattern.test(body.loginName.toLowerCase())
    && typeof body.password === 'string' && Buffer.byteLength(body.password, 'utf8') <= maxLoginPasswordBytes;
}

export function isJsonRequest(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function identityStatus(session: StoredSession | null): 'valid' | 'missing' | 'expired' {
  if (!session || session.revoked || session.disabled) return 'missing';
  if (session.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'valid';
}

export function registerAuthRoutes(app: FastifyInstance, repository: AuthRepository, publicOrigin: string): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const limiter = new FailureLimiter(maxFailedLogins, loginWindowMs);
  let dummyHashPromise: Promise<string> | undefined;
  const dummyHash = () => dummyHashPromise ??= hashPassword('nbase invalid user timing placeholder');

  app.post('/api/auth/login', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin !== origin) return reply.code(403).send({ error: 'ORIGIN_INVALID' });
    if (!isJsonRequest(request) || !isLoginRequest(request.body)) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    if (limiter.blocked(request.ip)) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const loginName = request.body.loginName.toLowerCase();
    try {
      const account = await repository.findAccount(loginName);
      const passwordOk = await verifyPassword(request.body.password, account?.passwordHash ?? await dummyHash());
      if (!account || account.disabled || !passwordOk) {
        limiter.fail(request.ip);
        return reply.code(401).send({ error: 'AUTH_INVALID' });
      }

      const workspaces = await repository.workspacesForUser(account.id);
      // A removed member looks exactly like a wrong password, so the response does not reveal the account.
      if (workspaces.length === 0) {
        limiter.fail(request.ip);
        return reply.code(401).send({ error: 'AUTH_INVALID' });
      }
      const tokens = createSessionTokens();
      if (!await repository.createSession(account, tokens)) {
        return reply.code(401).send({ error: 'AUTH_INVALID' });
      }
      limiter.succeed(request.ip);
      const response: AuthSessionResponse = {
        user: { id: account.id, loginName: account.loginName },
        workspaces,
        csrfToken: tokens.csrfToken,
        expiresAt: tokens.expiresAt.toISOString(),
      };
      return reply.header('Set-Cookie', sessionCookie(tokens.token, secure)).send(response);
    } catch (error) {
      request.log.error({ err: error }, 'Login unavailable');
      return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
    }
  });

  app.get('/api/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = readSessionToken(request.headers.cookie, secure);
    if (!token) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try {
      const session = await repository.loadSession(sessionTokenHash(token));
      const status = identityStatus(session);
      if (status !== 'valid' || !session) {
        return reply.header('Set-Cookie', clearSessionCookie(secure)).code(401)
          .send({ error: status === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED' });
      }
      const csrfToken = csrfTokenForSession(token);
      if (!verifyCsrf(session.csrfHash, csrfToken)) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      const workspaces = await repository.workspacesForUser(session.userId);
      if (workspaces.length === 0) return reply.header('Set-Cookie', clearSessionCookie(secure)).code(401).send({ error: 'AUTH_REQUIRED' });
      const response: AuthSessionResponse = {
        user: { id: session.userId, loginName: session.loginName },
        workspaces,
        csrfToken,
        expiresAt: session.expiresAt.toISOString(),
      };
      return reply.send(response);
    } catch (error) {
      request.log.error({ err: error }, 'Session unavailable');
      return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin !== origin) return reply.code(403).send({ error: 'ORIGIN_INVALID' });
    if (!isJsonRequest(request)) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const token = readSessionToken(request.headers.cookie, secure);
    if (!token) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try {
      const tokenHash = sessionTokenHash(token);
      const session = await repository.loadSession(tokenHash);
      const status = identityStatus(session);
      if (status !== 'valid' || !session) {
        return reply.header('Set-Cookie', clearSessionCookie(secure)).code(401)
          .send({ error: status === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED' });
      }
      const header = request.headers['x-csrf-token'];
      if (typeof header !== 'string' || !verifyCsrf(session.csrfHash, header)) {
        return reply.code(403).send({ error: 'CSRF_INVALID' });
      }
      await repository.revokeSession(tokenHash);
      return reply.header('Set-Cookie', clearSessionCookie(secure)).code(204).send();
    } catch (error) {
      request.log.error({ err: error }, 'Logout unavailable');
      return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
    }
  });
}
