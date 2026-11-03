import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './app.js';
import { PgAuthRepository } from './auth/repository.js';
import { runMigrations } from './db/migrate.js';
import { PgPageRepository } from './pages/repository.js';
import { PgAttachmentRepository, prepareAttachmentDirectory } from './attachments/repository.js';
import { serverConfig } from './config.js';

let pool: pg.Pool | undefined;
try {
  const { host, port, database, publicOrigin, attachmentDir } = await serverConfig();
  pool = database ? new pg.Pool({ ...database, max: 10 }) : undefined;
  // A dropped idle connection must not crash the process; readiness reports the outage.
  pool?.on('error', () => console.error('NBase idle database connection lost'));
  const staticRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const attachmentRoot = pool && attachmentDir ? await prepareAttachmentDirectory(attachmentDir, staticRoot) : undefined;
  // Fail before opening a listener if the schema is unavailable or differs from this build.
  if (pool) await runMigrations(pool);
  const app = await buildApp({
    logger: true,
    staticRoot,
    ...(pool && publicOrigin ? { auth: { repository: new PgAuthRepository(pool), publicOrigin } } : {}),
    ...(pool ? { pages: new PgPageRepository(pool) } : {}),
    ...(pool && attachmentRoot ? { attachments: new PgAttachmentRepository(pool, attachmentRoot) } : {}),
    ...(pool && attachmentRoot ? { readyCheck: async () => {
      // pool.query owns this one-shot connection and discards it on timeout.
      const probe: pg.QueryConfig & { query_timeout: number } = { text: 'SELECT 1', query_timeout: 2000 };
      await pool!.query(probe);
      await prepareAttachmentDirectory(attachmentRoot, staticRoot);
    } } : {}),
  });
  if (pool) app.addHook('onClose', async () => { await pool!.end(); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch((error: unknown) => {
        app.log.error(error);
        process.exitCode = 1;
      });
    });
  }
  await app.listen({ host, port });
} catch (error) {
  console.error('NBase failed to start:', error);
  await pool?.end();
  process.exitCode = 1;
}
