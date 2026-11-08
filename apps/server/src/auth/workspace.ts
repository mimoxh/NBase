import type { FastifyRequest } from 'fastify';
import type { AuthRepository } from './repository.js';
import {
  csrfTokenForSession, readSessionToken, sessionTokenHash, verifyCsrf,
} from './session.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkspaceRouteError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string,
    public readonly clearCookie = false) { super(code); }
}

/** `post-read` is a read carried by POST: it gets the write checks on origin and CSRF, but viewers may use it. */
export async function authorizeWorkspace(request: FastifyRequest, auth: AuthRepository,
  origin: string, secure: boolean, workspaceId: string, write: boolean | 'post-read',
  contentType?: string): Promise<string> {
  if (!uuidPattern.test(workspaceId)) throw new WorkspaceRouteError(404, 'NOT_FOUND');
  if (write && request.headers.origin !== origin) throw new WorkspaceRouteError(403, 'ORIGIN_INVALID');
  if (write && contentType && request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== contentType) {
    throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
  }
  const token = readSessionToken(request.headers.cookie, secure);
  if (!token) throw new WorkspaceRouteError(401, 'AUTH_REQUIRED');
  const session = await auth.loadSession(sessionTokenHash(token));
  if (!session || session.revoked || session.disabled) throw new WorkspaceRouteError(401, 'AUTH_REQUIRED', true);
  if (session.expiresAt.getTime() <= Date.now()) throw new WorkspaceRouteError(401, 'AUTH_EXPIRED', true);
  if (!verifyCsrf(session.csrfHash, csrfTokenForSession(token))) throw new WorkspaceRouteError(401, 'AUTH_REQUIRED', true);
  const membership = (await auth.workspacesForUser(session.userId)).find((item) => item.id === workspaceId);
  if (!membership) throw new WorkspaceRouteError(404, 'NOT_FOUND');
  if (write) {
    if (write === true && membership.role === 'viewer') throw new WorkspaceRouteError(403, 'FORBIDDEN');
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !verifyCsrf(session.csrfHash, csrf)) {
      throw new WorkspaceRouteError(403, 'CSRF_INVALID');
    }
  }
  return session.userId;
}
