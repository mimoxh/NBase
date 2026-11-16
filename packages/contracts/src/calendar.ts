import { isCalendarDay, isInstantValue, isTimeZoneName } from './dateCells.js';
import { isDatabaseId, optionColors, type OptionColor, type PropertyType } from './databases.js';

/**
 * Workspace calendar: shows date properties of several databases, daily notes and synced calendars.
 * All routes are under /api/workspaces/:id/calendar. Events are database rows; this API only reads them
 * across databases and manages sync sources. Writes to an event go through the page and database APIs.
 */

export const calendarSourceLimit = 50;
/** Rows one source returns at most for a range; more are reported in `truncated`. */
export const calendarSourceRowCap = 1000;
/** Longest span, in days, of one events request. */
export const calendarRangeDayLimit = 400;
export const calendarSyncIntervals = [15, 30, 60, 180, 360, 720, 1440] as const;
export const calendarImportByteLimit = 10 * 1024 * 1024;
/** Events one import or subscription may hold. */
export const calendarEventLimit = 10000;

export interface CalendarDateProperty { id: string; name: string; type: Extract<PropertyType, 'date' | 'created_time' | 'updated_time'> }

export interface CalendarDatabaseOption {
  databaseId: string;
  title: string;
  icon: string | null;
  dateProperties: CalendarDateProperty[];
  sync: CalendarSyncSource | null;
}

/** GET /calendar/sources: databases that have a date-like property, at most 200. */
export interface CalendarSourcesResponse { databases: CalendarDatabaseOption[] }

export interface CalendarSourceSetting {
  databaseId: string;
  propertyId: string;
  color: OptionColor;
  visible: boolean;
}

/** Per account and workspace. GET and PUT /calendar/settings; a preference, so the last write wins. */
export interface CalendarSettings {
  sources: CalendarSourceSetting[];
  showDailyNotes: boolean;
  /** Where events created on the workspace calendar go. */
  defaultDatabaseId: string | null;
}

export const defaultCalendarSettings: CalendarSettings = { sources: [], showDailyNotes: true, defaultDatabaseId: null };

export interface CalendarReaderContext { timeZone?: string; weekStart?: 0 | 1 }

/** POST /calendar/events: inclusive days in the reader's zone. */
export interface CalendarEventsRequest { from: string; to: string; context?: CalendarReaderContext }

export interface CalendarEventItem {
  databaseId: string;
  propertyId: string;
  rowId: string;
  title: string;
  icon: string | null;
  /** A date cell value, or an ISO time for created and updated time. Recurring values are expanded by the client. */
  value: string;
  revision: string;
  /** Created or updated time, or a field kept by a read-only subscription. */
  readOnly: boolean;
}

export interface CalendarDailyNote { date: string; pageId: string; title: string }

export interface CalendarEventsResponse {
  events: CalendarEventItem[];
  dailyNotes: CalendarDailyNote[];
  /** Database ids with more than `calendarSourceRowCap` matching rows in the range. */
  truncated: string[];
}

/** POST /calendar/reminders: moments in [from, to), at most two days apart. */
export interface CalendarRemindersRequest { from: string; to: string; context?: CalendarReaderContext }

export interface CalendarReminderItem {
  databaseId: string;
  rowId: string;
  title: string;
  occurrenceStart: string;
  /** ISO instant the reminder is due. */
  at: string;
  minutes: number;
}

export interface CalendarRemindersResponse { items: CalendarReminderItem[] }

// ---------------------------------------------------------------------------------------------------------
// Sync sources

/** `ics-file`: imported once, fields stay editable. `ics-url`: fetched on a schedule, synced fields are read-only. */
export const calendarSyncKinds = ['ics-file', 'ics-url'] as const;
export type CalendarSyncKind = typeof calendarSyncKinds[number];

export const calendarSyncErrors = ['URL_INVALID', 'URL_BLOCKED', 'FETCH_FAILED', 'NOT_CALENDAR', 'TOO_LARGE', 'PARSE_FAILED',
  'ROW_LIMIT', 'DISABLED'] as const;
export type CalendarSyncError = typeof calendarSyncErrors[number];

export interface CalendarSyncCounts { created: number; updated: number; unchanged: number; removed: number; conflicts: number; skipped: number }

export const calendarImportWarnings = ['RULE_UNSUPPORTED', 'TIMEZONE_UNKNOWN', 'EVENT_INVALID', 'TRUNCATED', 'VALUE_SHORTENED'] as const;
export type CalendarImportWarningCode = typeof calendarImportWarnings[number];
export interface CalendarImportWarning { code: CalendarImportWarningCode; count: number }

/** Fields a sync source keeps. The database is created with these; ids are stored with the source. */
export interface CalendarSyncFields {
  titleId: string;
  dateId: string;
  locationId: string;
  descriptionId: string;
  /** Hidden text property holding the event's UID, with `#<recurrence id>` for a changed occurrence. */
  uidId: string;
}

export interface CalendarSyncSource {
  id: string;
  databaseId: string;
  kind: CalendarSyncKind;
  name: string;
  /** Host of a subscription URL. The full URL may carry a secret token and is never returned. */
  urlHost: string | null;
  intervalMinutes: number | null;
  status: 'idle' | 'running' | 'error';
  lastSyncedAt: string | null;
  lastError: CalendarSyncError | null;
  lastCounts: CalendarSyncCounts | null;
  warnings: CalendarImportWarning[];
  eventCount: number;
  fields: CalendarSyncFields;
  /** Properties rows may not change by hand; empty for file imports. The title is read-only when it lists `titleId`. */
  readOnlyPropertyIds: string[];
}

/** GET /calendar/sync */
export interface CalendarSyncListResponse { sources: CalendarSyncSource[] }

/**
 * POST /calendar/import. A new target creates a database under `parentId` (a document, or null for the
 * top level). An existing target must be the database of an earlier file import. Events are matched by
 * UID; a row changed by hand since the last import keeps its values and the import adds a second row.
 */
export interface CalendarImportRequest {
  clientMutationId: string;
  target: { databaseId: string } | { parentId: string | null; name: string };
  ics: string;
}

export interface CalendarImportResponse { source: CalendarSyncSource; counts: CalendarSyncCounts; warnings: CalendarImportWarning[] }

/** POST /calendar/subscriptions: creates the database and its source, then syncs in the background. */
export interface CreateCalendarSubscriptionRequest {
  clientMutationId: string;
  url: string;
  name: string;
  parentId: string | null;
  intervalMinutes: number;
}

/** PATCH /calendar/sync/:id. POST /calendar/sync/:id/run syncs now. DELETE stops syncing and unlocks the fields; the database stays. */
export interface UpdateCalendarSyncRequest { name?: string; intervalMinutes?: number; url?: string }

// ---------------------------------------------------------------------------------------------------------
// Validators

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= 100 && !/[\u0000-\u001f\u007f\p{Cs}]/u.test(value);
}

export function isCalendarReaderContext(value: unknown): value is CalendarReaderContext {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnly(value, ['timeZone', 'weekStart'])) return false;
  return (value.timeZone === undefined || isTimeZoneName(value.timeZone)) && (value.weekStart === undefined || value.weekStart === 0 || value.weekStart === 1);
}

export function isCalendarSettings(value: unknown): value is CalendarSettings {
  if (!isRecord(value) || !hasOnly(value, ['sources', 'showDailyNotes', 'defaultDatabaseId'])) return false;
  if (!Array.isArray(value.sources) || value.sources.length > calendarSourceLimit || typeof value.showDailyNotes !== 'boolean') return false;
  if (value.defaultDatabaseId !== null && !isDatabaseId(value.defaultDatabaseId)) return false;
  const keys = new Set<string>();
  for (const source of value.sources) {
    if (!isRecord(source) || !hasOnly(source, ['databaseId', 'propertyId', 'color', 'visible'])) return false;
    if (!isDatabaseId(source.databaseId) || !isDatabaseId(source.propertyId) || typeof source.visible !== 'boolean') return false;
    if (!(optionColors as readonly unknown[]).includes(source.color)) return false;
    const key = `${source.databaseId}:${source.propertyId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function dayRangeOk(from: unknown, to: unknown): boolean {
  if (!isCalendarDay(from) || !isCalendarDay(to) || to < from) return false;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 < calendarRangeDayLimit;
}

export function isCalendarEventsRequest(value: unknown): value is CalendarEventsRequest {
  return isRecord(value) && hasOnly(value, ['from', 'to', 'context']) && dayRangeOk(value.from, value.to) && isCalendarReaderContext(value.context);
}

export function isCalendarRemindersRequest(value: unknown): value is CalendarRemindersRequest {
  if (!isRecord(value) || !hasOnly(value, ['from', 'to', 'context']) || !isCalendarReaderContext(value.context)) return false;
  if (!isInstantValue(value.from) || !isInstantValue(value.to)) return false;
  const span = Date.parse(value.to) - Date.parse(value.from);
  return span > 0 && span <= 2 * 86400000;
}

export function isCalendarImportRequest(value: unknown): value is CalendarImportRequest {
  if (!isRecord(value) || !hasOnly(value, ['clientMutationId', 'target', 'ics']) || !isDatabaseId(value.clientMutationId)) return false;
  if (typeof value.ics !== 'string' || value.ics.length === 0 || value.ics.length > calendarImportByteLimit) return false;
  const target = value.target;
  if (!isRecord(target)) return false;
  if ('databaseId' in target) return hasOnly(target, ['databaseId']) && isDatabaseId(target.databaseId);
  return hasOnly(target, ['parentId', 'name']) && (target.parentId === null || isDatabaseId(target.parentId)) && isName(target.name);
}

function isSyncUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2000 && /^(https?|webcal):\/\//i.test(value.trim());
}

export function isCreateCalendarSubscriptionRequest(value: unknown): value is CreateCalendarSubscriptionRequest {
  return isRecord(value) && hasOnly(value, ['clientMutationId', 'url', 'name', 'parentId', 'intervalMinutes'])
    && isDatabaseId(value.clientMutationId) && isSyncUrl(value.url) && isName(value.name)
    && (value.parentId === null || isDatabaseId(value.parentId))
    && (calendarSyncIntervals as readonly unknown[]).includes(value.intervalMinutes);
}

export function isUpdateCalendarSyncRequest(value: unknown): value is UpdateCalendarSyncRequest {
  if (!isRecord(value) || !hasOnly(value, ['name', 'intervalMinutes', 'url']) || Object.keys(value).length === 0) return false;
  return (value.name === undefined || isName(value.name))
    && (value.intervalMinutes === undefined || (calendarSyncIntervals as readonly unknown[]).includes(value.intervalMinutes))
    && (value.url === undefined || isSyncUrl(value.url));
}
