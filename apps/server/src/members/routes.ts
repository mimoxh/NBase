import type { AcceptInvitationRequest, CreateInvitationResponse, InvitationListResponse, MemberListResponse } from '@nbase/contracts';
import {
  defaultInvitationLifetimeDays, invitationTokenHeader, invitationUrl, isInvitableRole, isInvitationLifetime, loginNamePattern,
  memberPasswordMinCharacters,
} from '@nbase/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { FailureLimiter } from '../auth/limiter.js';
import { hashPassword } from '../auth/password.js';
import type { AuthRepository } from '../auth/repository.js';
import { isJsonRequest } from '../auth/routes.js';
import { createSessionTokens, publicOriginConfig, sessionCookie } from '../auth/session.js';
import { authorizeWorkspaceMember, WorkspaceRouteError } from '../auth/workspace.js';
import { sendError } from '../pages/routes.js';
import { invitationTokenHash, PgMemberRepository } from './repository.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxPasswordBytes = 1024;
const publicWindowMs = 15 * 60 * 1000;
const maxPublicFailures = 10;

type WorkspaceParams = { workspaceId: string };
type MemberParams = WorkspaceParams & { userId: string };
type InvitationParams = WorkspaceParams & { invitationId: string };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

function id(value: string): string {
  if (!uuidPattern.test(value)) throw new WorkspaceRouteError(404, 'NOT_FOUND');
  return value.toLowerCase();
}

export function registerMemberRoutes(app: FastifyInstance, pool: Pool, auth: AuthRepository, publicOrigin: string): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const members = new PgMemberRepository(pool);
  const limiter = new FailureLimiter(maxPublicFailures, publicWindowMs);

  /** Every member route is the instance owner's; writes also need origin, JSON and CSRF. */
  const owner = async (request: FastifyRequest<{ Params: WorkspaceParams }>, write: boolean): Promise<string> => {
    const member = await authorizeWorkspaceMember(request, auth, origin, secure, request.params.workspaceId, write,
      write ? 'application/json' : undefined);
    if (member.role !== 'owner') throw new WorkspaceRouteError(403, 'FORBIDDEN');
    return member.userId;
  };
  const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown) => sendError(request, reply, error, secure);
  const base = '/api/workspaces/:workspaceId';

  app.get<{ Params: WorkspaceParams }>(`${base}/members`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await owner(request, false);
      return reply.send({ members: await members.members(request.params.workspaceId) } satisfies MemberListResponse);
    } catch (error) { return fail(request, reply, error); }
  });

  app.patch<{ Params: MemberParams }>(`${base}/members/:userId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await owner(request, true);
      const body = record(request.body);
      if (!isInvitableRole(body.role)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
      return reply.send(await members.setRole(request.params.workspaceId, actorId, id(request.params.userId), body.role));
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: MemberParams }>(`${base}/members/:userId/remove`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await owner(request, true);
      record(request.body);
      return reply.send(await members.remove(request.params.workspaceId, actorId, id(request.params.userId)));
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: MemberParams }>(`${base}/members/:userId/restore`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await owner(request, true);
      record(request.body);
      return reply.send(await members.restore(request.params.workspaceId, actorId, id(request.params.userId)));
    } catch (error) { return fail(request, reply, error); }
  });

  app.get<{ Params: WorkspaceParams }>(`${base}/invitations`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await owner(request, false);
      return reply.send({ invitations: await members.invitations(request.params.workspaceId) } satisfies InvitationListResponse);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/invitations`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await owner(request, true);
      const body = record(request.body);
      const days = body.expiresInDays === undefined ? defaultInvitationLifetimeDays : body.expiresInDays;
      if (!isInvitableRole(body.role) || !isInvitationLifetime(days)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
      const created = await members.createInvitation(request.params.workspaceId, actorId, body.role, days);
      return reply.code(201).send({ ...created, url: invitationUrl(origin, created.token) } satisfies CreateInvitationResponse);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: InvitationParams }>(`${base}/invitations/:invitationId/revoke`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await owner(request, true);
      record(request.body);
      return reply.send(await members.revokeInvitation(request.params.workspaceId, actorId, id(request.params.invitationId)));
    } catch (error) { return fail(request, reply, error); }
  });

  // Public. The token comes in a header, never in the URL, so it stays out of request logs.
  app.get('/api/invitations/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Same-origin GET requests carry no Origin header; a cross-site page cannot add the token header without CORS.
    if (request.headers.origin !== undefined && request.headers.origin !== origin) return reply.code(403).send({ error: 'ORIGIN_INVALID' });
    if (limiter.blocked(request.ip)) return reply.code(429).send({ error: 'RATE_LIMITED' });
    const tokenHash = invitationTokenHash(request.headers[invitationTokenHeader]);
    try {
      const found = tokenHash ? await members.lookup(tokenHash) : null;
      if (!found) {
        limiter.fail(request.ip);
        return reply.code(404).send({ error: 'INVITATION_NOT_FOUND' });
      }
      return reply.send(found);
    } catch (error) {
      request.log.error({ err: error }, 'Invitation lookup unavailable');
      return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
    }
  });

  app.post('/api/invitations/accept', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin !== origin) return reply.code(403).send({ error: 'ORIGIN_INVALID' });
    if (!isJsonRequest(request)) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    if (limiter.blocked(request.ip)) return reply.code(429).send({ error: 'RATE_LIMITED' });
    const refuse = (status: number, code: string) => { limiter.fail(request.ip); return reply.code(status).send({ error: code }); };
    const body = request.body as Partial<Record<keyof AcceptInvitationRequest, unknown>> | null;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse(400, 'INVALID_REQUEST');
    const tokenHash = invitationTokenHash(body.token);
    if (!tokenHash) return refuse(404, 'INVITATION_NOT_FOUND');
    const loginName = typeof body.loginName === 'string' ? body.loginName.trim().toLowerCase() : '';
    if (!loginNamePattern.test(loginName)) return refuse(400, 'LOGIN_NAME_INVALID');
    const password = body.password;
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > maxPasswordBytes) return refuse(400, 'INVALID_REQUEST');
    if (Array.from(password).length < memberPasswordMinCharacters) return refuse(400, 'PASSWORD_TOO_SHORT');
    try {
      // Cheap checks first: scrypt is slow and memory-hungry, so it runs only for a usable invitation and a free name.
      const found = await members.lookup(tokenHash);
      if (!found) return refuse(404, 'INVITATION_NOT_FOUND');
      if (found.status !== 'pending') {
        return refuse(409, { expired: 'INVITATION_EXPIRED', accepted: 'INVITATION_USED', revoked: 'INVITATION_REVOKED' }[found.status]);
      }
      if (await members.loginTaken(loginName)) return refuse(409, 'LOGIN_TAKEN');
      const passwordHash = await hashPassword(password);
      const tokens = createSessionTokens();
      const session = await members.accept(tokenHash, loginName, passwordHash, tokens);
      return reply.code(201).header('Set-Cookie', sessionCookie(tokens.token, secure)).send(session);
    } catch (error) {
      if (error instanceof WorkspaceRouteError) return refuse(error.statusCode, error.code);
      request.log.error({ err: error }, 'Invitation acceptance unavailable');
      return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
    }
  });
}
