import type { CreatePageShareResponse, PageShareListResponse, SharedRootResponse } from '@nbase/contracts';
import { defaultShareLifetimeDays, isShareLifetime, shareTokenHeader, shareUrl } from '@nbase/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BlockList, isIP } from 'node:net';
import type { Pool } from 'pg';
import type { PgAttachmentRepository } from '../attachments/repository.js';
import { sendAttachmentContent } from '../attachments/routes.js';
import { FailureLimiter } from '../auth/limiter.js';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspaceMember, WorkspaceRouteError } from '../auth/workspace.js';
import { invitationTokenHash } from '../members/repository.js';
import { sendError } from '../pages/routes.js';
import { PgShareRepository, type ShareAccess } from './repository.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cookieName = 'nbase_share';

/** Loopback, private (RFC 1918, IPv6 ULA) and link-local addresses: the only ones that may open a share link. */
const localNetworks = new BlockList();
for (const [network, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['169.254.0.0', 16]] as const) localNetworks.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) localNetworks.addSubnet(network, prefix, 'ipv6');

export function isLocalNetworkAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isLocalNetworkAddress(mapped);
  const family = isIP(address);
  return family !== 0 && localNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

type WorkspaceParams = { workspaceId: string };
type PageParams = WorkspaceParams & { pageId: string };
type ShareParams = WorkspaceParams & { shareId: string };
type PublicParams = { shareId: string };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

function pathId(value: string): string {
  if (!uuidPattern.test(value)) throw new WorkspaceRouteError(404, 'NOT_FOUND');
  return value.toLowerCase();
}

function cookieToken(header: string | undefined): string | undefined {
  const matches = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  return matches.length === 1 ? matches[0]!.slice(cookieName.length + 1) : undefined;
}

/**
 * Read-only share links (docs/architecture/collaboration.md). Editors and owners manage them inside the workspace;
 * the public reads are GET only, answer only loopback and private addresses, and can be switched off.
 */
export function registerShareRoutes(app: FastifyInstance, pool: Pool, auth: AuthRepository, publicOrigin: string,
  attachments: PgAttachmentRepository | undefined, enabled: boolean): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const shares = new PgShareRepository(pool);
  const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown) => sendError(request, reply, error, secure);
  const editor = async (request: FastifyRequest<{ Params: WorkspaceParams }>, write: boolean) => {
    const member = await authorizeWorkspaceMember(request, auth, origin, secure, request.params.workspaceId, write,
      write ? 'application/json' : undefined);
    if (member.role === 'viewer') throw new WorkspaceRouteError(403, 'FORBIDDEN');
    return member.userId;
  };
  const base = '/api/workspaces/:workspaceId';

  app.get<{ Params: PageParams }>(`${base}/pages/:pageId/shares`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await editor(request, false);
      return reply.send({ shares: await shares.list(request.params.workspaceId, pathId(request.params.pageId)), enabled } satisfies PageShareListResponse);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: PageParams }>(`${base}/pages/:pageId/shares`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const actorId = await editor(request, true);
      const body = record(request.body);
      const days = body.expiresInDays === undefined ? defaultShareLifetimeDays : body.expiresInDays;
      if (typeof body.includeChildren !== 'boolean' || !isShareLifetime(days)) throw new WorkspaceRouteError(400, 'INVALID_REQUEST');
      if (!enabled) throw new WorkspaceRouteError(403, 'SHARE_DISABLED');
      const created = await shares.create(request.params.workspaceId, actorId, pathId(request.params.pageId), body.includeChildren, days);
      return reply.code(201).send({ ...created, url: shareUrl(origin, created.share.id, created.token) } satisfies CreatePageShareResponse);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: ShareParams }>(`${base}/shares/:shareId/revoke`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await editor(request, true);
      record(request.body);
      return reply.send(await shares.revoke(request.params.workspaceId, pathId(request.params.shareId)));
    } catch (error) { return fail(request, reply, error); }
  });

  if (!enabled) return;

  const tokenFailures = new FailureLimiter(10, 15 * 60 * 1000);
  const linkRequests = new FailureLimiter(300, 60 * 1000);
  const publicHeaders = (reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Vary', 'Cookie');
  };

  /** The share behind the request, or the reply already sent. */
  const access = async (request: FastifyRequest<{ Params: PublicParams }>, reply: FastifyReply,
    allowCookie: boolean): Promise<ShareAccess | FastifyReply> => {
    publicHeaders(reply);
    if (!isLocalNetworkAddress(request.ip)) return reply.code(404).send({ error: 'NOT_FOUND' });
    // Same-origin GET requests carry no Origin header; a cross-site page cannot add the token header without CORS.
    if (request.headers.origin !== undefined && request.headers.origin !== origin) return reply.code(403).send({ error: 'ORIGIN_INVALID' });
    if (tokenFailures.blocked(request.ip)) return reply.code(429).send({ error: 'RATE_LIMITED' });
    const shareId = request.params.shareId.toLowerCase();
    const header = request.headers[shareTokenHeader];
    const fromHeader = typeof header === 'string';
    const tokenHash = invitationTokenHash(fromHeader ? header : allowCookie ? cookieToken(request.headers.cookie) : undefined);
    const refuse = () => { tokenFailures.fail(request.ip); return reply.code(404).send({ error: 'SHARE_NOT_FOUND' }); };
    if (!uuidPattern.test(shareId) || !tokenHash) return refuse();
    if (linkRequests.blocked(shareId)) return reply.code(429).send({ error: 'RATE_LIMITED' });
    linkRequests.fail(shareId);
    const found = await shares.open(shareId, tokenHash);
    if (!found) return refuse();
    if (found === 'ended') return reply.code(410).send({ error: 'SHARE_ENDED' });
    if (fromHeader) {
      const maxAge = Math.max(0, Math.floor((found.expiresAt.getTime() - Date.now()) / 1000));
      reply.header('Set-Cookie', `${cookieName}=${header}; Path=/api/shared/${shareId}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
    }
    return found;
  };
  const publicFailure = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    publicHeaders(reply);
    reply.removeHeader('Content-Type');
    if (error instanceof WorkspaceRouteError) return reply.code(error.statusCode).send({ error: error.code });
    if (typeof error === 'object' && error !== null && 'statusCode' in error && 'code' in error
      && typeof error.statusCode === 'number' && error.statusCode < 600) return reply.code(error.statusCode).send({ error: error.code });
    request.log.error({ err: error }, 'Shared page unavailable');
    return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
  };

  app.get<{ Params: PublicParams }>('/api/shared/:shareId', async (request, reply) => {
    try {
      const share = await access(request, reply, false);
      if (!('workspaceId' in share)) return share;
      const scope = await shares.scope(share);
      const root = scope.pages[0];
      if (!root) return reply.code(410).send({ error: 'SHARE_ENDED' });
      await shares.recordView(share.id);
      return reply.send({ rootPageId: root.id, title: root.title, expiresAt: share.expiresAt.toISOString(), pages: scope.pages } satisfies SharedRootResponse);
    } catch (error) { return publicFailure(request, reply, error); }
  });

  app.get<{ Params: PublicParams & { pageId: string } }>('/api/shared/:shareId/pages/:pageId', async (request, reply) => {
    try {
      const share = await access(request, reply, false);
      if (!('workspaceId' in share)) return share;
      const page = uuidPattern.test(request.params.pageId) ? await shares.page(share, request.params.pageId.toLowerCase()) : null;
      return page ? reply.send(page) : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return publicFailure(request, reply, error); }
  });

  app.get<{ Params: PublicParams & { attachmentId: string }; Querystring: { download?: string } }>(
    '/api/shared/:shareId/attachments/:attachmentId', async (request, reply) => {
      try {
        // Images and media load through the path cookie, since an <img> cannot send the token header.
        const share = await access(request, reply, true);
        if (!('workspaceId' in share)) return share;
        const attachmentId = request.params.attachmentId.toLowerCase();
        if (!attachments || !uuidPattern.test(attachmentId) || !await shares.referencesAttachment(share, attachmentId)) {
          return reply.code(404).send({ error: 'NOT_FOUND' });
        }
        const attachment = await attachments.get(share.workspaceId, attachmentId);
        if (!attachment) return reply.code(404).send({ error: 'NOT_FOUND' });
        return await sendAttachmentContent(request, reply, attachments, share.workspaceId, attachment, request.query.download === '1');
      } catch (error) { return publicFailure(request, reply, error); }
    });
}
