import type { CalDavAccount, CalDavDiscoverRequest, CalDavDiscoverResponse, CalendarConflictChoice, CalendarDatabaseOption,
  CalendarEventsResponse, CalendarImportRequest, CalendarImportResponse, CalendarSettings, CalendarSyncConflictsResponse,
  CalendarSyncListResponse, CalendarSyncSource, CreateCalDavSourceRequest, CreateCalendarSubscriptionRequest,
  ResolveCalendarConflictResponse, UpdateCalendarSyncRequest } from '@nbase/contracts';

export interface RowDateWrite { rowId: string; propertyId: string; value: string; expectedRevision: string }

/** Import, subscription and CalDAV endpoints; only a persistent workspace has them. */
export interface CalendarSyncApi {
  list(signal?: AbortSignal): Promise<CalendarSyncListResponse>;
  importIcs(body: CalendarImportRequest): Promise<CalendarImportResponse>;
  subscribe(body: CreateCalendarSubscriptionRequest): Promise<CalendarSyncSource>;
  update(id: string, body: UpdateCalendarSyncRequest): Promise<CalendarSyncSource>;
  run(id: string): Promise<CalendarSyncSource>;
  remove(id: string): Promise<void>;
  /** Signs in and lists the account's calendars; nothing is stored. */
  discoverCaldav(body: CalDavDiscoverRequest): Promise<CalDavDiscoverResponse>;
  /** Creates the database and the CalDAV source; a retry with the same `clientMutationId` returns the first result. */
  createCaldav(body: CreateCalDavSourceRequest): Promise<CalendarSyncSource>;
  /** Replaces the stored account name and password of a CalDAV source; the server checks them first. */
  updateCredentials(id: string, credentials: CalDavAccount): Promise<CalendarSyncSource>;
  conflicts(id: string, signal?: AbortSignal): Promise<CalendarSyncConflictsResponse>;
  resolveConflict(id: string, rowId: string, choice: CalendarConflictChoice): Promise<ResolveCalendarConflictResponse>;
}

/**
 * Storage behind the workspace calendar page. The persistent workspace talks to the calendar API and the
 * page API; the demo derives everything from its in-memory databases. The page itself never fetches.
 */
export interface WorkspaceCalendarSource {
  /** False in the session demo: sync actions are unavailable and settings live in memory. */
  readonly persistent: boolean;
  readonly canWrite: boolean;
  listDatabases(signal?: AbortSignal): Promise<{ databases: CalendarDatabaseOption[] }>;
  loadSettings(signal?: AbortSignal): Promise<CalendarSettings>;
  saveSettings(settings: CalendarSettings): Promise<void>;
  /** Inclusive days in the reader's zone. */
  loadEvents(from: string, to: string, signal?: AbortSignal): Promise<CalendarEventsResponse>;
  /** Writes one row's date value. Resolves false on a revision conflict; the caller then refetches. */
  writeRowDate(write: RowDateWrite): Promise<boolean>;
  /** Creates the row of a new event; the id lets the host open it so the title can be typed. */
  createEvent(input: { databaseId: string; propertyId: string; value: string }): Promise<string | null>;
  /** New row for a detached occurrence: copies the series row's title and user properties. */
  createDetachedRow(input: { databaseId: string; rowId: string; propertyId: string; value: string }): Promise<string | null>;
  /** Opens a row page through the host's page-switch flow. */
  openRow(rowId: string): void;
  /** Opens a database page; synced databases are not in the page tree, so the calendar is their way in. */
  openDatabase(databaseId: string): void;
  /** Opens the day's daily note; without a page id the host runs its open-or-create flow. */
  openDailyNote(date: string, pageId?: string): void;
  notice(text: string): void;
  /** Present only when `persistent`. */
  sync?: CalendarSyncApi;
}
