import type { CalendarSyncCounts } from '@nbase/contracts';
import type { Pool } from 'pg';
import type { PgPageRepository } from '../pages/repository.js';
import { openCredentials, type CredentialKey } from '../secrets/credentials.js';
import { CalDavClient, CalDavError, guardedDavTransport, type DavTransport } from './caldav/client.js';
import { syncCaldav } from './caldav/sync.js';
import { fetchCalendar, fetchErrorCode, guardedCalendarFetcher, type CalendarFetcher } from './fetch.js';
import { IcsError, parseIcs } from './ics.js';
import { finishSource, sourceColumns, staleClaim, urlHost, type SourceRow } from './sources.js';
import { applyEvents, SyncFailure } from './sync.js';

const idleMs = 60000;
const failureMs = 5 * 60000;
/** Sources one tick syncs before yielding, so a backlog cannot starve the event loop. */
const perTick = 20;

export interface CalendarSyncOptions {
  /** False when NBASE_CALENDAR_FETCH=off: subscriptions and CalDAV sources are kept but report DISABLED. */
  fetchEnabled: boolean;
  fetcher?: CalendarFetcher;
  /** Key for stored CalDAV credentials (NBASE_CREDENTIAL_KEY_FILE); without one CalDAV runs report CREDENTIALS_UNAVAILABLE. */
  credentialKey?: CredentialKey | null;
  /** Replaces the guarded network transport of CalDAV requests; for tests. */
  caldavTransport?: DavTransport;
  /** NBASE_CALDAV_PRIVATE=allow: CalDAV may reach loopback and private addresses on any port. */
  caldavPrivate?: boolean;
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

/** Syncs one claimed CalDAV source and records the outcome. Never throws for server or credential problems. */
export async function runCaldav(pool: Pool, pages: PgPageRepository, source: SourceRow, options: CalendarSyncOptions): Promise<SourceRow | null> {
  if (!options.fetchEnabled) return finishSource(pool, source.id, { error: 'DISABLED' });
  const host = urlHost(source.caldav_json?.serverUrl ?? null);
  try {
    const alive = await pool.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [source.workspace_id, source.database_id]);
    if (!alive.rows[0]) return finishSource(pool, source.id, {});
    const key = options.credentialKey ?? null;
    const stored = await pool.query<{ credential_cipher: Buffer | null }>('SELECT credential_cipher FROM calendar_sync_sources WHERE id = $1', [source.id]);
    const cipher = stored.rows[0]?.credential_cipher;
    const account = key && cipher ? openCredentials(key, source.id, cipher, source.credential_key_id) : null;
    if (!account || !source.caldav_json) return finishSource(pool, source.id, { error: 'CREDENTIALS_UNAVAILABLE' });
    const allowPrivate = options.caldavPrivate ?? false;
    const client = new CalDavClient(options.caldavTransport ?? guardedDavTransport(allowPrivate), account, allowPrivate);
    const result = await syncCaldav(pool, pages.snapshot.bind(pages), source, client, { timeZone: await workspaceZone(pool, source.workspace_id) });
    return finishSource(pool, source.id, { counts: result.counts, warnings: result.warnings,
      caldav: { syncToken: result.syncToken, ctag: result.ctag, writable: result.writable } });
  } catch (error) {
    if (error instanceof SyncFailure && error.code === 'GONE') return finishSource(pool, source.id, {});
    if (error instanceof SyncFailure) return finishSource(pool, source.id, { error: 'ROW_LIMIT' });
    if (error instanceof CalDavError) {
      // Only the host is logged: never paths, accounts or response bodies.
      if (error.code === 'FETCH_FAILED') options.log?.('caldav sync failed', { host });
      return finishSource(pool, source.id, { error: error.code });
    }
    options.log?.('caldav sync failed', { host, err: error });
    return finishSource(pool, source.id, { error: 'FETCH_FAILED' });
  }
}

/** Runs a claimed source of either scheduled kind. */
export function runSource(pool: Pool, pages: PgPageRepository, source: SourceRow, options: CalendarSyncOptions): Promise<SourceRow | null> {
  return source.kind === 'caldav' ? runCaldav(pool, pages, source, options) : runSubscription(pool, pages, source, options);
}

/** Takes the most overdue scheduled source (subscription or CalDAV) that no other process is syncing. */
export async function claimDueSource(pool: Pool): Promise<SourceRow | null> {
  const result = await pool.query<SourceRow>(`UPDATE calendar_sync_sources s SET status = 'running', running_since = now(), updated_at = now()
    WHERE s.id = (SELECT id FROM calendar_sync_sources WHERE kind IN ('ics-url', 'caldav') AND next_run_at <= now()
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
        await runSource(this.pool, this.pages, source, this.options);
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
