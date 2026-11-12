import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { stat } from 'node:fs/promises';
import type { HealthResponse } from '@nbase/contracts';
import type { Pool } from 'pg';
import type { AuthRepository } from './auth/repository.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerPageRoutes } from './pages/routes.js';
import type { PgPageRepository } from './pages/repository.js';
import { registerAttachmentRoutes } from './attachments/routes.js';
import type { PgAttachmentRepository } from './attachments/repository.js';
import { registerTemplateRoutes, renderNoteTemplate } from './notes/templates.js';
import { registerTagRoutes } from './notes/tags.js';
import { registerDailyRoutes } from './notes/daily.js';
import { registerDatabaseRoutes } from './databases/routes.js';
import { registerGraphRoutes } from './graph/routes.js';
import { registerLinkPreviewRoutes } from './linkPreview/routes.js';
import { registerPinyinIndexWorker } from './search/worker.js';

interface AuthOptions {
  repository: AuthRepository;
  publicOrigin: string;
}

interface AppOptions {
  logger?: boolean;
  staticRoot?: string;
  auth?: AuthOptions;
  pages?: PgPageRepository;
  attachments?: PgAttachmentRepository;
  notesPool?: Pool;
  readyCheck?: () => Promise<void>;
}

export async function buildApp(options: AppOptions = {}) {
  if (options.pages && !options.auth) throw new Error('Page routes require authentication');
  if (options.attachments && !options.auth) throw new Error('Attachment routes require authentication');
  if (options.notesPool && (!options.auth || !options.pages)) throw new Error('Note routes require authentication and pages');
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  app.get('/api/health', async (): Promise<HealthResponse> => ({
    service: 'nbase',
    status: 'ok',
    stage: 'foundation',
    persistence: options.pages ? 'page-api' : options.auth ? 'accounts-only' : 'not-configured',
  }));

  // Storage availability only; this does not certify backups or product readiness.
  app.get('/api/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.pages && options.attachments && options.readyCheck) {
      try {
        await options.readyCheck();
        return { service: 'nbase', status: 'ready' };
      } catch { /* Do not expose configuration or database errors publicly. */ }
    }
    return reply.code(503).send({ service: 'nbase', status: 'unavailable' });
  });

  if (options.auth) {
    registerAuthRoutes(app, options.auth.repository, options.auth.publicOrigin);
    if (options.pages) registerPageRoutes(app, options.pages, options.auth.repository, options.auth.publicOrigin);
    if (options.pages) registerLinkPreviewRoutes(app, options.auth.repository, options.auth.publicOrigin);
    if (options.pages && options.notesPool) {
      registerTagRoutes(app, options.notesPool, options.pages, options.auth.repository, options.auth.publicOrigin);
      registerTemplateRoutes(app, options.notesPool, options.pages, options.auth.repository, options.auth.publicOrigin);
      registerDailyRoutes(app, options.notesPool, options.pages, options.auth.repository, options.auth.publicOrigin, renderNoteTemplate);
      registerDatabaseRoutes(app, options.notesPool, options.pages, options.auth.repository, options.auth.publicOrigin);
      registerGraphRoutes(app, options.notesPool, options.auth.repository, options.auth.publicOrigin);
      registerPinyinIndexWorker(app, options.notesPool);
    }
    if (options.attachments) registerAttachmentRoutes(app, options.attachments,
      options.auth.repository, options.auth.publicOrigin);
  }

  const staticRoot = options.staticRoot;
  const hasWeb = staticRoot !== undefined && await stat(staticRoot)
    .then((info) => info.isDirectory()).catch(() => false);

  if (hasWeb && staticRoot) {
    await app.register(fastifyStatic, { root: staticRoot });
  }

  // Do not return an HTML success page for missing API routes or missing assets.
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: 'NOT_FOUND' });
  });

  return app;
}
