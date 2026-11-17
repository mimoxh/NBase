import { randomUUID } from 'node:crypto';
import { calendarImportByteLimit, calendarSourceRowCap, defaultCalendarSettings, isCalendarEventsRequest, isCalendarImportRequest,
  isCalendarRemindersRequest, isCalendarSettings, isCreateCalendarSubscriptionRequest, isUpdateCalendarSyncRequest, parseDateCell,
  isCalDavDiscoverRequest, isCreateCalDavSourceRequest, isResolveCalendarConflictRequest,
  type CalDavAccount, type CalDavCalendarOption, type CalDavDiscoverResponse, type CalendarSyncConflictsResponse,
  type ResolveCalendarConflictResponse,
  dateCellLimits, dateCellReminders, shiftCalendarDay, activeProperties, isCalendarProperty,
  type CalendarDatabaseOption, type CalendarDateProperty, type CalendarEventItem, type CalendarEventsResponse, type CalendarImportRequest,
  type CalendarImportResponse, type CalendarReminderItem, type CalendarRemindersResponse, type CalendarSettings, type CalendarSourcesResponse,
  type CalendarSyncListResponse, type CalendarSyncSource, type PropertyDefinition } from '@nbase/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { calendarRead, readCalendarRanges, resolveZone } from '../databases/query.js';
import { isUuid, PageError, type PgPageRepository } from '../pages/repository.js';
import { sendError } from '../pages/routes.js';
import { sealCredentials, type CredentialKey } from '../secrets/credentials.js';
import { CalDavClient, CalDavError, caldavServerUrl, guardedDavTransport, hrefKey, type DavTransport } from './caldav/client.js';
import { listConflicts, resolveConflict } from './caldav/sync.js';
import { CalendarFetchError, subscriptionUrl, type CalendarFetcher } from './fetch.js';
import { IcsError, parseIcs } from './ics.js';
import { CalendarScheduler } from './scheduler.js';
import { attendeeRowIds, CalendarRouteError, claimSource, createSyncDatabase, finishSource, insertSource, readOnlyPropertyIds, sourceColumns,
  sourceForDatabase, staleClaim, toSyncSource, withWorkspaceLock, type CaldavConfig, type SourceRow } from './sources.js';
import { applyEvents, SyncFailure } from './sync.js';

interface WorkspaceParams { workspaceId: string }
interface SourceParams extends WorkspaceParams { sourceId: string }

export interface CalendarOptions {
  /** False when NBASE_CALENDAR_FETCH=off. */
  fetchEnabled: boolean;
  fetcher?: CalendarFetcher;
  /** Off in tests that drive the scheduler themselves. */
  scheduler?: boolean;
  /** NBASE_CREDENTIAL_KEY_FILE; without it the CalDAV routes answer 503 CREDENTIALS_UNAVAILABLE. */
  credentialKey?: CredentialKey | null;
  /** NBASE_CALDAV_PRIVATE=allow. */
  caldavPrivate?: boolean;
  /** Replaces the guarded CalDAV transport; for tests. */
  caldavTransport?: DavTransport;
}

/** Calendar collection addresses compare equal however the server encodes them, with or without the final slash. */
function sameCalendar(a: string, b: string): boolean {
  return hrefKey(a).replace(/\/+$/, '') === hrefKey(b).replace(/\/+$/, '');
}

const sourceListLimit = 200;
const reminderItemLimit = 500;
/** Rows a reminder scan reads at most; the window is two days, so this is far above any real calendar. */
const reminderRowLimit = 5000;

function requestError(): never { throw new WorkspaceRouteError(400, 'INVALID_REQUEST'); }

async function loadSettings(db: Pick<Pool, 'query'>, workspaceId: string, userId: string): Promise<CalendarSettings> {
  const result = await db.query<{ settings_json: unknown }>('SELECT settings_json FROM calendar_settings WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId]);
  const stored = result.rows[0]?.settings_json;
  return isCalendarSettings(stored) ? stored : defaultCalendarSettings;
}

function dateProperties(properties: PropertyDefinition[]): CalendarDateProperty[] {
  return activeProperties(properties).filter(isCalendarProperty)
    .map(p => ({ id: p.id, name: p.name, type: p.type as CalendarDateProperty['type'] }));
}

async function releaseSource(pool: Pool, sourceId: string): Promise<void> {
  await pool.query(`UPDATE calendar_sync_sources SET status = CASE WHEN last_error IS NULL THEN 'idle' ELSE 'error' END,
    running_since = NULL, updated_at = now() WHERE id = $1 AND status = 'running'`, [sourceId]);
}

export function registerCalendarRoutes(app: FastifyInstance, pool: Pool, pages: PgPageRepository, auth: AuthRepository,
  publicOrigin: string, options: CalendarOptions): CalendarScheduler {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  const credentialKey = options.credentialKey ?? null;
  const caldavPrivate = options.caldavPrivate ?? false;
  const view = { keyId: credentialKey?.id ?? null };
  const scheduler = new CalendarScheduler(pool, pages, { fetchEnabled: options.fetchEnabled, ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    credentialKey, caldavPrivate, ...(options.caldavTransport ? { caldavTransport: options.caldavTransport } : {}),
    log: (message, details) => app.log.warn(details, message) }, error => app.log.error({ err: error }, 'calendar scheduler failed'));
  const autoRun = options.scheduler ?? true;
  if (autoRun) scheduler.start();
  app.addHook('onClose', () => scheduler.close());
  const nudge = () => { if (autoRun) scheduler.nudge(); };
  const authorize = (request: FastifyRequest, workspaceId: string, write: boolean | 'post-read') =>
    authorizeWorkspace(request, auth, origin, secure, workspaceId, write, write ? 'application/json' : undefined);
  const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    reply.header('Cache-Control', 'no-store');
    if (error instanceof CalendarRouteError) return reply.code(error.statusCode).send({ error: error.code });
    if (error instanceof CalendarFetchError) return reply.code(422).send({ error: error.code });
    if (error instanceof CalDavError) return reply.code(error.code === 'CREDENTIALS_UNAVAILABLE' ? 503 : 422).send({ error: error.code });
    return sendError(request, reply, error, secure);
  };
  const requireKey = (): CredentialKey => {
    if (!credentialKey) throw new CalendarRouteError(503, 'CREDENTIALS_UNAVAILABLE');
    if (!options.fetchEnabled) throw new CalendarRouteError(422, 'DISABLED');
    return credentialKey;
  };
  /** Signs in and lists the account's calendars. Nothing about the account is logged. */
  const discover = async (serverUrl: string, account: CalDavAccount): Promise<{ server: URL; calendars: CalDavCalendarOption[] }> => {
    const server = caldavServerUrl(serverUrl, caldavPrivate);
    const client = new CalDavClient(options.caldavTransport ?? guardedDavTransport(caldavPrivate), account, caldavPrivate);
    return { server, calendars: await client.discover(server) };
  };
  const base = '/api/workspaces/:workspaceId/calendar';
  const sourceId = (raw: string) => { if (!isUuid(raw)) throw new PageError(404, 'NOT_FOUND'); return raw.toLowerCase(); };

  app.get<{ Params: WorkspaceParams }>(`${base}/sources`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      await authorize(request, workspaceId, false);
      const databases = await pool.query<{ page_id: string; title: string; icon: string | null; properties_json: PropertyDefinition[] }>(`
        SELECT d.page_id, p.title, p.icon, d.properties_json FROM databases d
        JOIN pages p ON p.workspace_id = d.workspace_id AND p.id = d.page_id AND p.deleted_at IS NULL AND p.kind = 'database'
        WHERE d.workspace_id = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.properties_json) e
          WHERE e->>'type' IN ('date', 'created_time', 'updated_time') AND COALESCE(e->>'deletedAt', '') = '')
        ORDER BY p.title COLLATE nbase_zh, p.id LIMIT $2`, [workspaceId, sourceListLimit]);
      const sources = await pool.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s
        WHERE s.workspace_id = $1 AND s.database_id = ANY($2::uuid[])`, [workspaceId, databases.rows.map(row => row.page_id)]);
      const byDatabase = new Map(sources.rows.map(row => [row.database_id, toSyncSource(row, view)]));
      const body: CalendarSourcesResponse = { databases: databases.rows.map((row): CalendarDatabaseOption => ({
        databaseId: row.page_id, title: row.title, icon: row.icon ?? null, dateProperties: dateProperties(row.properties_json),
        sync: byDatabase.get(row.page_id) ?? null })) };
      return reply.send(body);
    } catch (error) { return fail(request, reply, error); }
  });

  app.get<{ Params: WorkspaceParams }>(`${base}/settings`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, false);
      return reply.send(await loadSettings(pool, workspaceId, actorId));
    } catch (error) { return fail(request, reply, error); }
  });

  // A personal preference, so viewers may keep one too.
  app.put<{ Params: WorkspaceParams }>(`${base}/settings`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, 'post-read');
      const body = request.body;
      if (!isCalendarSettings(body)) requestError();
      const settings: CalendarSettings = {
        sources: body.sources.map(source => ({ databaseId: source.databaseId.toLowerCase(), propertyId: source.propertyId,
          color: source.color, visible: source.visible })),
        showDailyNotes: body.showDailyNotes,
        defaultDatabaseId: body.defaultDatabaseId?.toLowerCase() ?? null,
      };
      if (!isCalendarSettings(settings)) requestError();
      await pool.query(`INSERT INTO calendar_settings (workspace_id, user_id, settings_json) VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = now()`,
      [workspaceId, actorId, JSON.stringify(settings)]);
      return reply.send(settings);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/events`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, 'post-read');
      const body = request.body;
      if (!isCalendarEventsRequest(body)) requestError();
      const settings = await loadSettings(pool, workspaceId, actorId);
      const visible = settings.sources.filter(source => source.visible)
        .map(source => ({ databaseId: source.databaseId, propertyId: source.propertyId }));
      const read = await calendarRead(pool, async client => {
        const timeZone = await resolveZone(client, workspaceId, body.context?.timeZone);
        const ranges = await readCalendarRanges(client, workspaceId, visible, { from: body.from, to: body.to }, timeZone, calendarSourceRowCap + 1);
        const synced = await client.query<Pick<SourceRow, 'id' | 'database_id' | 'kind' | 'fields_json' | 'caldav_json'>>(`SELECT id, database_id,
            kind, fields_json, caldav_json
          FROM calendar_sync_sources WHERE workspace_id = $1 AND database_id = ANY($2::uuid[])`,
        [workspaceId, [...new Set(ranges.map(range => range.source.databaseId))]]);
        // Events with attendees in a writable CalDAV calendar keep their synced fields, row by row.
        const lockedRows = new Set<string>();
        for (const source of synced.rows.filter(row => row.kind === 'caldav' && row.caldav_json?.writable)) {
          const rowIds = ranges.filter(range => range.source.databaseId === source.database_id).flatMap(range => range.rows.map(row => row.id));
          if (rowIds.length) for (const id of await attendeeRowIds(client, workspaceId, source.id, rowIds)) lockedRows.add(id);
        }
        const notes = settings.showDailyNotes ? await client.query<{ id: string; title: string; date: string }>(`
          SELECT id, title, to_char(daily_note_date, 'YYYY-MM-DD') AS date FROM pages
          WHERE workspace_id = $1 AND daily_note_date BETWEEN $2::date AND $3::date AND deleted_at IS NULL
          ORDER BY daily_note_date, id`, [workspaceId, body.from, body.to]) : { rows: [] };
        return { ranges, synced: synced.rows, notes: notes.rows, lockedRows };
      });
      const locked = new Map(read.synced.map(row => [row.database_id, new Set(readOnlyPropertyIds(row))]));
      const rowLocked = new Map(read.synced.map(row => [row.database_id, row.fields_json.dateId]));
      const events: CalendarEventItem[] = [];
      const truncated = new Set<string>();
      for (const range of read.ranges) {
        if (range.rows.length > calendarSourceRowCap) truncated.add(range.source.databaseId);
        const readOnly = range.def.type !== 'date' || (locked.get(range.source.databaseId)?.has(range.def.id) ?? false);
        const syncedDate = rowLocked.get(range.source.databaseId) === range.def.id;
        for (const row of range.rows.slice(0, calendarSourceRowCap)) {
          events.push({ databaseId: range.source.databaseId, propertyId: range.def.id, rowId: row.id, title: row.title,
            icon: row.icon ?? null, value: row.value, revision: row.revision, readOnly: readOnly || (syncedDate && read.lockedRows.has(row.id)) });
        }
      }
      const response: CalendarEventsResponse = { events, truncated: [...truncated],
        dailyNotes: read.notes.map(note => ({ date: note.date, pageId: note.id, title: note.title })) };
      return reply.send(response);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/reminders`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      await authorize(request, workspaceId, 'post-read');
      const body = request.body;
      if (!isCalendarRemindersRequest(body)) requestError();
      const from = Date.parse(body.from);
      const to = Date.parse(body.to);
      // Starts that can have a reminder in the window: up to four weeks after it, or a day before for all-day values.
      const reach = Math.ceil(dateCellLimits.reminderMinutes / 1440);
      const minDay = shiftCalendarDay(body.from.slice(0, 10), -2);
      const maxDay = shiftCalendarDay(body.to.slice(0, 10), reach + 2);
      const read = await calendarRead(pool, async client => {
        const timeZone = await resolveZone(client, workspaceId, body.context?.timeZone);
        const rows = await client.query<{ database_id: string; row_id: string; title: string; value: string }>(`
          SELECT p.parent_id AS database_id, p.id AS row_id, p.title, v.value FROM databases d
          JOIN pages dp ON dp.workspace_id = d.workspace_id AND dp.id = d.page_id AND dp.deleted_at IS NULL AND dp.kind = 'database'
          CROSS JOIN LATERAL (SELECT e->>'id' AS id FROM jsonb_array_elements(d.properties_json) e
            WHERE e->>'type' = 'date' AND COALESCE(e->>'deletedAt', '') = '') prop
          JOIN pages p ON p.workspace_id = d.workspace_id AND p.parent_id = d.page_id AND p.kind = 'row' AND p.deleted_at IS NULL
          CROSS JOIN LATERAL (SELECT p.row_properties ->> prop.id AS value) v
          WHERE d.workspace_id = $1 AND position('|remind=' in v.value) > 0 AND (left(v.value, 10) COLLATE "C") <= $3
            AND (position('|rrule=' in v.value) > 0 OR (left(v.value, 10) COLLATE "C") >= $2)
          LIMIT $4`, [workspaceId, minDay, maxDay, reminderRowLimit]);
        return { timeZone, rows: rows.rows };
      });
      const items: CalendarReminderItem[] = [];
      for (const row of read.rows) {
        const cell = parseDateCell(row.value);
        if (!cell?.reminders) continue;
        for (const reminder of dateCellReminders(cell, from, to, read.timeZone)) {
          items.push({ databaseId: row.database_id, rowId: row.row_id, title: row.title, occurrenceStart: reminder.occurrenceStart,
            at: new Date(reminder.at).toISOString(), minutes: reminder.minutes });
        }
      }
      items.sort((a, b) => a.at.localeCompare(b.at) || a.rowId.localeCompare(b.rowId));
      const response: CalendarRemindersResponse = { items: items.slice(0, reminderItemLimit) };
      return reply.send(response);
    } catch (error) { return fail(request, reply, error); }
  });

  app.get<{ Params: WorkspaceParams }>(`${base}/sync`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      await authorize(request, workspaceId, false);
      const rows = await pool.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s
        JOIN pages p ON p.workspace_id = s.workspace_id AND p.id = s.database_id AND p.deleted_at IS NULL
        WHERE s.workspace_id = $1 ORDER BY s.created_at, s.id`, [workspaceId]);
      const response: CalendarSyncListResponse = { sources: rows.rows.map(row => toSyncSource(row, view)) };
      return reply.send(response);
    } catch (error) { return fail(request, reply, error); }
  });

  /**
   * Parsing and the row writes happen outside the workspace lock, in chunks; the receipt is written last,
   * so a retry with the same clientMutationId after a lost response replays it, and a retry after a
   * failure part way resumes: unchanged events are recognised by their digest and not written again.
   */
  async function importCalendar(workspaceId: string, actorId: string, body: CalendarImportRequest) {
    const receiptFor = (statusCode: number, response: CalendarImportResponse | null) => pages.mutate<CalendarImportResponse>(workspaceId, actorId,
      body.clientMutationId, 'calendar-import', null, body, async () => {
        if (!response) throw new PageError(409, 'MUTATION_CONFLICT');
        return { statusCode, body: response };
      }, response => response.source.databaseId);
    const prior = await pool.query('SELECT 1 FROM page_mutation_receipts WHERE workspace_id = $1 AND actor_user_id = $2 AND client_mutation_id = $3',
      [workspaceId, actorId, body.clientMutationId]);
    if (prior.rows[0]) return receiptFor(200, null);
    if (Buffer.byteLength(body.ics, 'utf8') > calendarImportByteLimit) throw new CalendarRouteError(422, 'TOO_LARGE');
    const zone = await pool.query<{ zone: string }>('SELECT note_time_zone AS zone FROM workspaces WHERE id = $1', [workspaceId]);
    let parsed: ReturnType<typeof parseIcs>;
    try { parsed = parseIcs(body.ics, { timeZone: zone.rows[0]?.zone ?? 'UTC' }); } catch (error) {
      if (error instanceof IcsError) throw new CalendarRouteError(422, error.code);
      throw error;
    }
    const setup = await withWorkspaceLock(pool, workspaceId, actorId, async client => {
      let source: SourceRow | null;
      let created = false;
      if ('databaseId' in body.target) {
        const databaseId = body.target.databaseId.toLowerCase();
        const alive = await client.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND kind = 'database'`,
          [workspaceId, databaseId]);
        if (!alive.rows[0]) throw new PageError(404, 'NOT_FOUND');
        source = await sourceForDatabase(client, workspaceId, databaseId);
        if (!source || source.kind !== 'ics-file') throw new CalendarRouteError(422, 'IMPORT_TARGET_INVALID');
      } else {
        const earlier = await client.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s
          WHERE s.workspace_id = $1 AND s.created_by = $2 AND s.client_mutation_id = $3`, [workspaceId, actorId, body.clientMutationId]);
        source = earlier.rows[0] ?? null;
        if (!source) {
          const name = body.target.name.trim();
          const database = await createSyncDatabase(client, pages, workspaceId, actorId, body.target.parentId?.toLowerCase() ?? null,
            name, body.clientMutationId);
          source = await insertSource(client, { workspaceId, databaseId: database.databaseId, kind: 'ics-file', name, url: null,
            intervalMinutes: null, fields: database.fields, actorId, clientMutationId: body.clientMutationId });
          created = true;
        }
      }
      const claimed = await claimSource(client, source.id);
      if (!claimed) throw new CalendarRouteError(409, 'SYNC_RUNNING');
      return { source: claimed, created };
    });
    const { source } = setup;
    let counts;
    try {
      counts = await applyEvents(pool, { sourceId: source.id, workspaceId, databaseId: source.database_id, fields: source.fields_json,
        mode: 'file', actorId }, parsed.events, pages.snapshot.bind(pages), parsed.skipped);
    } catch (error) {
      if (error instanceof SyncFailure && error.code === 'ROW_LIMIT') {
        await finishSource(pool, source.id, { error: 'ROW_LIMIT' });
        throw new CalendarRouteError(422, 'ROW_LIMIT');
      }
      await releaseSource(pool, source.id).catch(() => undefined);
      if (error instanceof SyncFailure) throw new PageError(404, 'NOT_FOUND');
      throw error;
    }
    const finished = await finishSource(pool, source.id, { counts, warnings: parsed.warnings });
    if (!finished) throw new PageError(404, 'NOT_FOUND');
    return receiptFor(setup.created ? 201 : 200, { source: toSyncSource(finished, view), counts, warnings: parsed.warnings });
  }

  // JSON escaping makes the body somewhat larger than the text it carries; the text itself is checked against the limit.
  app.post<{ Params: WorkspaceParams }>(`${base}/import`, { bodyLimit: Math.ceil(calendarImportByteLimit * 1.2) + 65536 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const body = request.body;
      if (!isCalendarImportRequest(body)) requestError();
      const result = await importCalendar(workspaceId, actorId, body);
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/subscriptions`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const body = request.body;
      if (!isCreateCalendarSubscriptionRequest(body)) requestError();
      const url = subscriptionUrl(body.url);
      const result = await pages.mutate<CalendarSyncSource>(workspaceId, actorId, body.clientMutationId, 'calendar-subscribe', null, body,
        async client => {
          const name = body.name.trim();
          const database = await createSyncDatabase(client, pages, workspaceId, actorId, body.parentId?.toLowerCase() ?? null, name,
            body.clientMutationId);
          const source = await insertSource(client, { workspaceId, databaseId: database.databaseId, kind: 'ics-url', name, url,
            intervalMinutes: body.intervalMinutes, fields: database.fields, actorId, clientMutationId: body.clientMutationId });
          return { statusCode: 201, body: toSyncSource(source, view) };
        }, response => response.databaseId);
      nudge();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return fail(request, reply, error); }
  });

  app.patch<{ Params: SourceParams }>(`${base}/sync/:sourceId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const id = sourceId(request.params.sourceId);
      const body = request.body;
      if (!isUpdateCalendarSyncRequest(body)) requestError();
      const url = body.url === undefined ? null : subscriptionUrl(body.url);
      let sealed: { cipher: Buffer; keyId: string; writable: boolean } | null = null;
      if (body.credentials !== undefined) {
        // New credentials are checked against the server before they replace the stored ones.
        const found = await pool.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s WHERE s.workspace_id = $1 AND s.id = $2`,
          [workspaceId, id]);
        const current = found.rows[0];
        if (!current) throw new PageError(404, 'NOT_FOUND');
        if (current.kind !== 'caldav' || !current.caldav_json) throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
        const key = requireKey();
        const { calendars } = await discover(current.caldav_json.serverUrl, body.credentials);
        const chosen = calendars.find(calendar => sameCalendar(calendar.url, current.caldav_json!.calendarUrl));
        if (!chosen) throw new CalendarRouteError(422, 'CALENDAR_NOT_FOUND');
        sealed = { cipher: sealCredentials(key, id, body.credentials), keyId: key.id, writable: chosen.writable };
      }
      const result = await withWorkspaceLock(pool, workspaceId, actorId, async client => {
        const current = await client.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s
          WHERE s.workspace_id = $1 AND s.id = $2 FOR UPDATE`, [workspaceId, id]);
        const row = current.rows[0];
        if (!row) throw new PageError(404, 'NOT_FOUND');
        if (url !== null && row.kind !== 'ics-url') throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
        if (body.intervalMinutes !== undefined && row.kind === 'ics-file') throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
        if (sealed && row.kind !== 'caldav') throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
        const updated = await client.query<SourceRow>(`UPDATE calendar_sync_sources s SET name = COALESCE($3, s.name),
            interval_minutes = COALESCE($4, s.interval_minutes), url = COALESCE($5, s.url),
            http_etag = CASE WHEN $5::text IS DISTINCT FROM s.url AND $5::text IS NOT NULL THEN NULL ELSE s.http_etag END,
            http_last_modified = CASE WHEN $5::text IS DISTINCT FROM s.url AND $5::text IS NOT NULL THEN NULL ELSE s.http_last_modified END,
            credential_cipher = COALESCE($6, s.credential_cipher), credential_key_id = COALESCE($7, s.credential_key_id),
            caldav_json = CASE WHEN $8::boolean IS NULL THEN s.caldav_json ELSE jsonb_set(s.caldav_json, '{writable}', to_jsonb($8::boolean)) END,
            next_run_at = CASE WHEN s.kind NOT IN ('ics-url', 'caldav') THEN NULL
              WHEN $5::text IS DISTINCT FROM s.url AND $5::text IS NOT NULL THEN now()
              WHEN $6::bytea IS NOT NULL THEN now()
              WHEN $4::int IS NOT NULL THEN COALESCE(s.last_synced_at, now()) + $4::int * interval '1 minute'
              ELSE s.next_run_at END,
            updated_at = now()
          WHERE s.workspace_id = $1 AND s.id = $2 RETURNING ${sourceColumns}`,
        [workspaceId, id, body.name?.trim() ?? null, body.intervalMinutes ?? null, url, sealed?.cipher ?? null, sealed?.keyId ?? null,
          sealed?.writable ?? null]);
        return { row: updated.rows[0]!, moved: (url !== null && url !== row.url) || sealed !== null };
      });
      if (result.moved) nudge();
      return reply.send(toSyncSource(result.row, view));
    } catch (error) { return fail(request, reply, error); }
  });
  app.post<{ Params: SourceParams }>(`${base}/sync/:sourceId/run`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const id = sourceId(request.params.sourceId);
      const row = await withWorkspaceLock(pool, workspaceId, actorId, async client => {
        const current = await client.query<{ kind: string }>('SELECT kind FROM calendar_sync_sources WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
          [workspaceId, id]);
        if (!current.rows[0]) throw new PageError(404, 'NOT_FOUND');
        if (current.rows[0].kind === 'ics-file') throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
        const updated = await client.query<SourceRow>(`UPDATE calendar_sync_sources s SET next_run_at = now(), updated_at = now()
          WHERE s.workspace_id = $1 AND s.id = $2 RETURNING ${sourceColumns}`, [workspaceId, id]);
        return updated.rows[0]!;
      });
      nudge();
      return reply.code(202).send(toSyncSource(row, view));
    } catch (error) { return fail(request, reply, error); }
  });

  app.delete<{ Params: SourceParams }>(`${base}/sync/:sourceId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const id = sourceId(request.params.sourceId);
      await withWorkspaceLock(pool, workspaceId, actorId, async client => {
        // The database and its rows stay; only the link to the source, and with it the field lock, goes.
        const deleted = await client.query('DELETE FROM calendar_sync_sources WHERE workspace_id = $1 AND id = $2 RETURNING id', [workspaceId, id]);
        if (!deleted.rows[0]) throw new PageError(404, 'NOT_FOUND');
      });
      return reply.code(204).send();
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/caldav/discover`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      await authorize(request, workspaceId, true);
      const body = request.body;
      if (!isCalDavDiscoverRequest(body)) requestError();
      requireKey();
      const { calendars } = await discover(body.serverUrl, { username: body.username, password: body.password });
      const response: CalDavDiscoverResponse = { calendars };
      return reply.send(response);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/caldav`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const body = request.body;
      if (!isCreateCalDavSourceRequest(body)) requestError();
      const key = requireKey();
      // The receipt keeps a digest of the request; the password stays out of it.
      const { password: _password, ...receiptBody } = body;
      const create = (action: (client: PoolClient) => Promise<{ statusCode: number; body: CalendarSyncSource }>) =>
        pages.mutate<CalendarSyncSource>(workspaceId, actorId, body.clientMutationId, 'calendar-caldav', null, receiptBody, action,
          response => response.databaseId);
      const prior = await pool.query('SELECT 1 FROM page_mutation_receipts WHERE workspace_id = $1 AND actor_user_id = $2 AND client_mutation_id = $3',
        [workspaceId, actorId, body.clientMutationId]);
      if (prior.rows[0]) {
        const replay = await create(async () => { throw new PageError(409, 'MUTATION_CONFLICT'); });
        return reply.code(replay.statusCode).send(replay.body);
      }
      const { server, calendars } = await discover(body.serverUrl, { username: body.username, password: body.password });
      const chosen = calendars.find(calendar => sameCalendar(calendar.url, body.calendarUrl));
      if (!chosen) throw new CalendarRouteError(422, 'CALENDAR_NOT_FOUND');
      const id = randomUUID();
      const config: CaldavConfig = { serverUrl: server.toString(), calendarUrl: chosen.url, calendarName: chosen.name, writable: chosen.writable,
        color: chosen.color };
      const cipher = sealCredentials(key, id, { username: body.username, password: body.password });
      const result = await create(async client => {
        const name = body.name.trim();
        const database = await createSyncDatabase(client, pages, workspaceId, actorId, body.parentId?.toLowerCase() ?? null, name,
          body.clientMutationId);
        const source = await insertSource(client, { id, workspaceId, databaseId: database.databaseId, kind: 'caldav', name, url: null,
          intervalMinutes: body.intervalMinutes, fields: database.fields, actorId, clientMutationId: body.clientMutationId,
          caldav: { config, cipher, keyId: key.id } });
        return { statusCode: 201, body: toSyncSource(source, view) };
      });
      nudge();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return fail(request, reply, error); }
  });

  app.get<{ Params: SourceParams }>(`${base}/sync/:sourceId/conflicts`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      await authorize(request, workspaceId, false);
      const id = sourceId(request.params.sourceId);
      const found = await pool.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s WHERE s.workspace_id = $1 AND s.id = $2`,
        [workspaceId, id]);
      const row = found.rows[0];
      if (!row) throw new PageError(404, 'NOT_FOUND');
      if (row.kind !== 'caldav') throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
      const response: CalendarSyncConflictsResponse = { conflicts: await listConflicts(pool, row) };
      return reply.send(response);
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: SourceParams & { rowId: string } }>(`${base}/sync/:sourceId/conflicts/:rowId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await authorize(request, workspaceId, true);
      const id = sourceId(request.params.sourceId);
      const rowId = sourceId(request.params.rowId);
      const body = request.body;
      if (!isResolveCalendarConflictRequest(body)) requestError();
      const row = await withWorkspaceLock(pool, workspaceId, actorId, async client => {
        const current = await client.query<SourceRow & { busy: boolean }>(`SELECT ${sourceColumns},
            (s.status = 'running' AND s.running_since >= now() - ${staleClaim}) AS busy
          FROM calendar_sync_sources s WHERE s.workspace_id = $1 AND s.id = $2 FOR UPDATE OF s`, [workspaceId, id]);
        const source = current.rows[0];
        if (!source) throw new PageError(404, 'NOT_FOUND');
        if (source.kind !== 'caldav') throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
        if (source.busy) throw new CalendarRouteError(409, 'SYNC_RUNNING');
        await resolveConflict(client, pages.snapshot.bind(pages), source, rowId, body.choice, actorId);
        const updated = await client.query<SourceRow>(`UPDATE calendar_sync_sources s SET next_run_at = now(), updated_at = now()
          WHERE s.id = $1 RETURNING ${sourceColumns}`, [id]);
        return updated.rows[0]!;
      });
      nudge();
      const response: ResolveCalendarConflictResponse = { source: toSyncSource(row, view) };
      return reply.send(response);
    } catch (error) { return fail(request, reply, error); }
  });

  return scheduler;
}
