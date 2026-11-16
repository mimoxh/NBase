import type { CalendarDatabaseOption, CalendarEventsResponse, CalendarImportRequest, CalendarImportResponse,
  CalendarSettings, CalendarSyncListResponse, CalendarSyncSource, CreateCalendarSubscriptionRequest,
  UpdateCalendarSyncRequest } from '@nbase/contracts';

export interface RowDateWrite { rowId: string; propertyId: string; value: string; expectedRevision: string }

/** Subscription and import endpoints; only a persistent workspace has them. */
export interface CalendarSyncApi {
  list(signal?: AbortSignal): Promise<CalendarSyncListResponse>;
  importIcs(body: CalendarImportRequest): Promise<CalendarImportResponse>;
  subscribe(body: CreateCalendarSubscriptionRequest): Promise<CalendarSyncSource>;
  update(id: string, body: UpdateCalendarSyncRequest): Promise<CalendarSyncSource>;
  run(id: string): Promise<CalendarSyncSource>;
  remove(id: string): Promise<void>;
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
  /** Opens the day's daily note; without a page id the host runs its open-or-create flow. */
  openDailyNote(date: string, pageId?: string): void;
  notice(text: string): void;
  /** Present only when `persistent`. */
  sync?: CalendarSyncApi;
}
