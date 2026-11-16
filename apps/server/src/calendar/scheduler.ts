import type { CalendarSyncCounts } from '@nbase/contracts';
import type { Pool } from 'pg';
import type { PgPageRepository } from '../pages/repository.js';
import { fetchCalendar, fetchErrorCode, guardedCalendarFetcher, type CalendarFetcher } from './fetch.js';
import { IcsError, parseIcs } from './ics.js';
import { finishSource, sourceColumns, staleClaim, urlHost, type SourceRow } from './sources.js';
import { applyEvents, SyncFailure } from './sync.js';

const idleMs = 60000;
const failureMs = 5 * 60000;
/** Sources one tick syncs before yielding, so a backlog cannot starve the event loop. */
const perTick = 20;

export interface CalendarSyncOptions {
  /** False when NBASE_CALENDAR_FETCH=off: subscriptions are kept but report DISABLED. */
  fetchEnabled: boolean;
  fetcher?: CalendarFetcher;
  log?: (message: string, details: Record<string, unknown>) => void;
}

async function workspaceZone(pool: Pool, workspaceId: string): Promise<string> {
  const result = await pool.query<{ zone: string }>('SELECT note_time_zone AS zone FROM workspaces WHERE id = $1', [workspaceId]);
  return result.rows[0]?.zone ?? 'UTC';
}

/** Syncs one subscription that the caller has claimed, and records the outcome. Never throws for feed problems. */
export async function runSubscription(pool: Pool, pages: PgPageRepository, source: SourceRow, options: CalendarSyncOptions): Promise<SourceRow | null> {
  if (!options.fetchEnabled) return finishSource(pool, source.id, { error: 'DISABLED' });
  try {
    const alive = await pool.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [source.workspace_id, source.database_id]);
    // A trashed database is left as it is; syncing resumes if it is restored.
    if (!alive.rows[0]) return finishSource(pool, source.id, {});
    const fetched = await fetchCalendar(source.url!, { etag: source.http_etag, lastModified: source.http_last_modified },
      options.fetcher ?? guardedCalendarFetcher);
    if (fetched.notModified) {
      const counts: CalendarSyncCounts = { created: 0, updated: 0, unchanged: source.event_count, removed: 0, conflicts: 0, skipped: 0 };
      return finishSource(pool, source.id, { counts });
    }
    const parsed = parseIcs(fetched.text, { timeZone: await workspaceZone(pool, source.workspace_id) });
    const counts = await applyEvents(pool, { sourceId: source.id, workspaceId: source.workspace_id, databaseId: source.database_id,
      fields: source.fields_json, mode: 'url', actorId: source.created_by }, parsed.events, pages.snapshot.bind(pages), parsed.skipped);
    return finishSource(pool, source.id, { counts, warnings: parsed.warnings, http: { etag: fetched.etag, lastModified: fetched.lastModified } });
  } catch (error) {
    if (error instanceof SyncFailure && error.code === 'GONE') return finishSource(pool, source.id, {});
    const code = error instanceof SyncFailure ? 'ROW_LIMIT' : fetchErrorCode(error);
    // Only the host is logged: the full address may carry a secret token.
    if (!(error instanceof IcsError) && code === 'FETCH_FAILED') options.log?.('calendar sync failed', { host: urlHost(source.url), err: error });
    return finishSource(pool, source.id, { error: code });
  }
}

/** Takes the most overdue subscription that no other process is syncing. */
export async function claimDueSource(pool: Pool): Promise<SourceRow | null> {
  const result = await pool.query<SourceRow>(`UPDATE calendar_sync_sources s SET status = 'running', running_since = now(), updated_at = now()
    WHERE s.id = (SELECT id FROM calendar_sync_sources WHERE kind = 'ics-url' AND next_run_at <= now()
      AND (status <> 'running' OR running_since < now() - ${staleClaim}) ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING ${sourceColumns}`);
  return result.rows[0] ?? null;
}

/** In-process loop for due subscriptions, one at a time. The claim lives in PostgreSQL, so several processes can share it. */
export class CalendarScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private again = false;

  constructor(private readonly pool: Pool, private readonly pages: PgPageRepository, private readonly options: CalendarSyncOptions,
    private readonly onError: (error: unknown) => void = () => undefined) {}

  start(): void { this.schedule(5000); }

  nudge(): void {
    if (this.running) { this.again = true; return; }
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Runs due work now and resolves when it is done; for tests. */
  async runNow(): Promise<void> {
    await this.running;
    this.running = this.tick(false).finally(() => { this.running = null; });
    await this.running;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.running = this.tick(true).finally(() => { this.running = null; }); }, ms);
    this.timer.unref();
  }

  private async tick(reschedule: boolean): Promise<void> {
    let delay = idleMs;
    try {
      for (let n = 0; n < perTick && !this.stopped; n++) {
        const source = await claimDueSource(this.pool);
        if (!source) break;
        await runSubscription(this.pool, this.pages, source, this.options);
        if (n === perTick - 1) delay = 10;
      }
    } catch (error) {
      this.onError(error);
      delay = failureMs;
    }
    if (this.again) { this.again = false; delay = 0; }
    if (reschedule) this.schedule(delay);
  }
}
