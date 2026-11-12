import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { pinyinBodyUnitLimit, pinyinTitleUnitLimit, pinyinVector } from './pinyin-index.js';

const batchSize = 25;
const idleMs = 5000;
const failureMs = 30000;

/**
 * Fills one batch of missing pinyin keys. Progress is the NULL columns themselves, so a restart resumes.
 * Only the picked page rows are locked (SKIP LOCKED), never the workspace; at most `batchSize` bounded
 * prefixes are read. Returns false when nothing is waiting.
 */
export async function runPinyinBatch(pool: Pool, limit = batchSize): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const picked = await client.query<{ id: string; title: string | null; body: string | null }>(`
      SELECT id, CASE WHEN search_title_pinyin IS NULL THEN title END AS title,
        CASE WHEN search_body_pinyin IS NULL THEN left(search_text, $2) END AS body
      FROM pages WHERE search_title_pinyin IS NULL OR search_body_pinyin IS NULL
      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit, pinyinBodyUnitLimit]);
    if (picked.rows.length) {
      const rows = picked.rows;
      await client.query(`UPDATE pages p SET search_title_pinyin = COALESCE(v.title::tsvector, p.search_title_pinyin),
        search_body_pinyin = COALESCE(v.body::tsvector, p.search_body_pinyin)
        FROM unnest($1::uuid[], $2::text[], $3::text[]) AS v(id, title, body) WHERE p.id = v.id`, [
        rows.map(row => row.id),
        rows.map(row => row.title === null ? null : pinyinVector(row.title, pinyinTitleUnitLimit)),
        rows.map(row => row.body === null ? null : pinyinVector(row.body, pinyinBodyUnitLimit)),
      ]);
    }
    await client.query('COMMIT');
    return picked.rows.length > 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** In-process loop for the pinyin backfill and for pages written by paths that do not compute keys. */
export class PinyinIndexWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly pool: Pool, private readonly onError: (error: unknown) => void = () => undefined) {}

  start(delay = 0): void { this.schedule(delay); }

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
      if (await runPinyinBatch(this.pool)) delay = 10;
    } catch (error) {
      this.onError(error);
      delay = failureMs;
    }
    this.schedule(delay);
  }
}

export function registerPinyinIndexWorker(app: FastifyInstance, pool: Pool): void {
  const worker = new PinyinIndexWorker(pool, error => app.log.error({ err: error }, 'pinyin index worker failed'));
  worker.start(idleMs);
  app.addHook('onClose', () => worker.close());
}
