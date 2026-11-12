import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace } from '../auth/workspace.js';
import { sendError } from '../pages/routes.js';
import { loadWorkspaceGraph } from './graph.js';

interface GraphRouteOptions { nodeLimit?: number; edgeLimit?: number }

/** `limits` exists for tests; production always uses the contract limits. */
export function registerGraphRoutes(app: FastifyInstance, pool: Pool, auth: AuthRepository,
  publicOrigin: string, limits: GraphRouteOptions = {}): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  app.get<{ Params: { workspaceId: string } }>('/api/workspaces/:workspaceId/graph', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorizeWorkspace(request, auth, origin, secure, workspaceId, false);
      return reply.send(await loadWorkspaceGraph(pool, workspaceId, actorId, limits.nodeLimit, limits.edgeLimit));
    } catch (error) { return sendError(request, reply, error, secure); }
  });
}
