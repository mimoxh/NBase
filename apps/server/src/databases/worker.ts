import type { PropertyDefinition, RowProperties } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { extractDocumentIndex } from '../pages/search-text.js';
import { rowIndexText } from './schema.js';

const batchSize = 200;
const idleMs = 5000;
const failureMs = 30000;

interface SearchRow {
  id: string;
  content_json: Parameters<typeof extractDocumentIndex>[0];
  row_properties: RowProperties | null;
  revision: string;
}

/** Writes recomputed search text. A row saved meanwhile has a newer revision and already has current text. */
export async function writeRowSearchText(client: Pick<PoolClient, 'query'>, workspaceId: string, rows: SearchRow[],
  properties: PropertyDefinition[]): Promise<void> {
  if (!rows.length) return;
  const texts = rows.map(row => rowIndexText(extractDocumentIndex(row.content_json).searchText, properties, row.row_properties ?? {}));
  await client.query(`UPDATE pages p SET search_text = v.text
    FROM unnest($2::uuid[], $3::text[], $4::bigint[]) AS v(id, text, revision)
    WHERE p.workspace_id = $1 AND p.id = v.id AND p.revision = v.revision`,
  [workspaceId, rows.map(row => row.id), texts, rows.map(row => row.revision)]);
}

/** Rows of a database in id order, including trashed ones so a restored row is already current. */
export async function selectRowsForIndex(client: Pick<PoolClient, 'query'>, workspaceId: string, databaseId: string,
  cursor: string | null, limit: number): Promise<SearchRow[]> {
  const result = await client.query<SearchRow>(`SELECT p.id, p.content_json, p.row_properties, p.revision::text AS revision
    FROM pages p JOIN (SELECT id FROM pages WHERE workspace_id = $1 AND parent_id = $2 AND kind = 'row'
      AND ($3::uuid IS NULL OR id > $3::uuid) ORDER BY id LIMIT $4) picked ON picked.id = p.id
    WHERE p.workspace_id = $1 ORDER BY p.id`, [workspaceId, databaseId, cursor, limit]);
  return result.rows;
}

/** Reindexes one batch of the first database that needs it. Returns false when nothing is waiting. */
export async function runSearchBatch(pool: Pool, limit = batchSize): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only this database row is held, never the workspace, so document saves keep running between and during batches.
    const head = await client.query<{ workspace_id: string; page_id: string; properties_json: PropertyDefinition[];
      search_generation: string; search_cursor: string | null }>(`SELECT workspace_id, page_id, properties_json,
      search_generation::text AS search_generation, search_cursor FROM databases
      WHERE search_indexed_generation < search_generation LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const job = head.rows[0];
    if (!job) { await client.query('COMMIT'); return false; }
    const rows = await selectRowsForIndex(client, job.workspace_id, job.page_id, job.search_cursor, limit);
    await writeRowSearchText(client, job.workspace_id, rows, job.properties_json);
    if (rows.length < limit) {
      await client.query(`UPDATE databases SET search_indexed_generation = search_generation, search_cursor = NULL
        WHERE workspace_id = $1 AND page_id = $2`, [job.workspace_id, job.page_id]);
    } else {
      await client.query('UPDATE databases SET search_cursor = $3 WHERE workspace_id = $1 AND page_id = $2',
        [job.workspace_id, job.page_id, rows.at(-1)!.id]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** In-process loop for derived database work. Progress lives in PostgreSQL, so a restart resumes it. */
export class DatabaseWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly pool: Pool, private readonly onError: (error: unknown) => void = () => undefined) {}

  start(): void { this.schedule(idleMs); }

  /** Runs soon, for work a request has just committed. */
  nudge(): void { if (!this.running) this.schedule(0); }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.running = this.tick().finally(() => { this.running = null; }); }, ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let delay = idleMs;
    try {
      // Yields between batches so request handlers get the pool and the event loop.
      if (await runSearchBatch(this.pool)) delay = 10;
    } catch (error) {
      this.onError(error);
      delay = failureMs;
    }
    this.schedule(delay);
  }
}
