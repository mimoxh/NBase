import type { FastifyInstance } from 'fastify';
import type { AuthRepository } from '../auth/repository.js';
import { clearSessionCookie, publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { fetchLinkPreview, LinkPreviewError } from './fetchPreview.js';

const windowMs = 60_000;
const perWindow = 30;

/**
 * Bookmark cards ask the server to read a public page's title. Only members who may write can ask,
 * a few times a minute, and NBASE_LINK_PREVIEW=off turns outbound requests off entirely.
 */
export function registerLinkPreviewRoutes(app: FastifyInstance, auth: AuthRepository, publicOrigin: string,
  fetchPreview = fetchLinkPreview): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const recent = new Map<string, number[]>();
  app.post<{ Params: { workspaceId: string }; Body: { url?: unknown } }>('/api/workspaces/:workspaceId/link-preview',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const actor = await authorizeWorkspace(request, auth, origin, secure, request.params.workspaceId, true, 'application/json');
        if (process.env.NBASE_LINK_PREVIEW === 'off') return reply.code(403).send({ error: 'LINK_PREVIEW_DISABLED' });
        const now = Date.now();
        const times = (recent.get(actor) ?? []).filter(time => now - time < windowMs);
        if (times.length >= perWindow) return reply.code(429).send({ error: 'RATE_LIMITED' });
        recent.set(actor, [...times, now]);
        return reply.send(await fetchPreview(request.body?.url));
      } catch (error) {
        if (error instanceof WorkspaceRouteError) {
          if (error.clearCookie) reply.header('Set-Cookie', clearSessionCookie(secure));
          return reply.code(error.statusCode).send({ error: error.code });
        }
        if (error instanceof LinkPreviewError) {
          return reply.code(error.code === 'URL_INVALID' || error.code === 'URL_BLOCKED' ? 400 : 502).send({ error: error.code });
        }
        request.log.error({ err: error }, 'Link preview unavailable');
        return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
      }
    });
}
