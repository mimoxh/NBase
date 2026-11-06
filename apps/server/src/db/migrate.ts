import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { migrations } from './migrations.js';
import { extractSearchText } from '../pages/search-text.js';
import { backfillPageLinks } from '../pages/page-links.js';
import type { StoredDocumentContent } from '@nbase/contracts';

const advisoryLockKey = '2026102501';

export async function runMigrations(pool: Pick<Pool, 'connect'>): Promise<number> {
  const client = await pool.connect();
  let transactionOpen = false;
  let appliedCount = 0;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockKey]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const knownVersions = new Set(migrations.map((migration) => migration.version));
    for (const row of applied.rows) {
      if (!knownVersions.has(row.version)) {
        throw new Error(`Database migration ${row.version} is newer than this server`);
      }
    }

    const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row.checksum]));
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existingChecksum = appliedByVersion.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new Error(`Database migration ${migration.version} checksum differs from this server`);
        }
        continue;
      }

      await client.query(migration.sql);
      if (migration.version === 3) {
        // Backfill old pages inside the same migration transaction before writes are exposed.
        let after = '00000000-0000-0000-0000-000000000000';
        for (;;) {
          const batch = await client.query<{ id: string; content_json: StoredDocumentContent }>(
            'SELECT id, content_json FROM pages WHERE id > $1::uuid ORDER BY id LIMIT 100', [after]);
          if (!batch.rows.length) break;
          for (const page of batch.rows) {
            await client.query('UPDATE pages SET search_text = $2 WHERE id = $1',
              [page.id, extractSearchText(page.content_json)]);
          }
          after = batch.rows.at(-1)!.id;
        }
      }
      if (migration.version === 10) await backfillPageLinks(client);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, checksum],
      );
      appliedCount += 1;
    }

    await client.query('COMMIT');
    transactionOpen = false;
    return appliedCount;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* Keep the original migration error. */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
