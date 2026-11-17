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
/** Colors sources get by default, by the database's position in GET /calendar/sources. */
export const calendarPalette: readonly OptionColor[] = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'brown', 'red', 'gray', 'default'];

export function calendarPaletteColor(index: number): OptionColor {
  return calendarPalette[((index % calendarPalette.length) + calendarPalette.length) % calendarPalette.length]!;
}

export interface CalendarDateProperty { id: string; name: string; type: Extract<PropertyType, 'date' | 'created_time' | 'updated_time'> }

export interface CalendarDatabaseOption {
  databaseId: string;
  title: string;
  icon: string | null;
  dateProperties: CalendarDateProperty[];
  sync: CalendarSyncSource | null;
  /**
   * Made by an import or a sync source and kept out of the page tree, also after syncing stopped.
   * POST /calendar/databases/:id/reveal makes it an ordinary database.
   */
  hidden: boolean;
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
  /**
   * Databases with a date property that `sources` does not list join with their defaults (absent means true).
   * GET /settings answers with them included; a database switched off keeps an entry with `visible: false`.
   */
  autoAdd?: boolean;
}

export const defaultCalendarSettings: CalendarSettings = { sources: [], showDailyNotes: true, defaultDatabaseId: null };

/** The entry a database gets when it joins: its first `date` property (else the first date-like one), the color of its position. */
export function defaultCalendarSource(databaseId: string, properties: readonly CalendarDateProperty[], index: number): CalendarSourceSetting | null {
  const property = properties.find(p => p.type === 'date') ?? properties[0];
  return property ? { databaseId, propertyId: property.id, color: calendarPaletteColor(index), visible: true } : null;
}

/**
 * The settings GET /calendar/settings answers with: unless `autoAdd` is false, `databases` (in the order of
 * GET /calendar/sources) that `sources` does not mention are added with their defaults. Returns `settings` itself when none is.
 */
export function withAutoAddedSources(settings: CalendarSettings,
  databases: readonly Pick<CalendarDatabaseOption, 'databaseId' | 'dateProperties'>[]): CalendarSettings {
  if (settings.autoAdd === false) return settings;
  const known = new Set(settings.sources.map(source => source.databaseId));
  const sources = [...settings.sources];
  databases.forEach((database, index) => {
    if (known.has(database.databaseId) || sources.length >= calendarSourceLimit) return;
    const added = defaultCalendarSource(database.databaseId, database.dateProperties, index);
    if (added) sources.push(added);
  });
  return sources.length === settings.sources.length ? settings : { ...settings, sources };
}

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

/**
 * `ics-file`: imported once, fields stay editable. `ics-url`: fetched on a schedule, synced fields are read-only.
 * `caldav`: one external calendar, synced both ways on a schedule; see CalendarCaldavInfo. `provider` there tells the
 * protocol: CalDAV with a password, Google (CalDAV with OAuth) or Microsoft (Graph with OAuth). All behave alike.
 */
export const calendarSyncKinds = ['ics-file', 'ics-url', 'caldav'] as const;
export type CalendarSyncKind = typeof calendarSyncKinds[number];

/**
 * OAUTH_APP_MISSING: the workspace's OAuth app for the source's provider was removed. AUTH_FAILED on an OAuth source
 * means re-authorize. API_DISABLED: the Google project has not enabled the CalDAV API or the Google Calendar API.
 */
export const calendarSyncErrors = ['URL_INVALID', 'URL_BLOCKED', 'FETCH_FAILED', 'NOT_CALENDAR', 'TOO_LARGE', 'PARSE_FAILED',
  'ROW_LIMIT', 'DISABLED', 'AUTH_FAILED', 'CREDENTIALS_UNAVAILABLE', 'CALENDAR_NOT_FOUND', 'NOT_CALDAV', 'OAUTH_APP_MISSING',
  'API_DISABLED'] as const;
export type CalendarSyncError = typeof calendarSyncErrors[number];

/** `pushed` counts events a CalDAV run created, changed or deleted on the external calendar. */
export interface CalendarSyncCounts { created: number; updated: number; unchanged: number; removed: number; conflicts: number; skipped: number;
  pushed?: number }

export const calendarImportWarnings = ['RULE_UNSUPPORTED', 'TIMEZONE_UNKNOWN', 'EVENT_INVALID', 'TRUNCATED', 'VALUE_SHORTENED',
  'WRITE_REJECTED'] as const;
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
  /** Present for `caldav` sources. */
  caldav: CalendarCaldavInfo | null;
  /**
   * Rows whose synced fields and title are read-only although the calendar is writable: events with
   * attendees, which NBase never writes back. Only in GET /databases/:id; absent elsewhere.
   */
  readOnlyRowIds?: string[];
}

/** What a two-way source shows. Passwords and tokens are stored encrypted and never returned. */
export interface CalendarCaldavInfo {
  provider: CalendarAccountProvider;
  /** Account e-mail of an OAuth source when the provider reports one; null for `caldav`. */
  account: string | null;
  serverHost: string;
  calendarName: string;
  /** False when the external calendar refuses writes: the source then behaves like a subscription. */
  writable: boolean;
  /**
   * False when the stored credentials cannot be decrypted (no key, or a different key): re-enter them with PATCH
   * for `caldav`, or authorize again (POST /calendar/oauth/start with `sourceId`) for OAuth providers.
   */
  credentialsOk: boolean;
  /** Open conflicts; see GET /calendar/sync/:id/conflicts. */
  conflictCount: number;
  /**
   * The workspace's aggregate calendar: ordinary databases shown on the workspace calendar of the user who turned it
   * on also sync here, both ways. At most one source per workspace; only writable calendars.
   */
  aggregate: boolean;
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

/**
 * PATCH /calendar/sync/:id. `url` is for subscriptions, `credentials` for `caldav`-provider sources (checked against the
 * server before they are stored). POST /calendar/sync/:id/run syncs now. DELETE stops syncing, unlocks the
 * fields and deletes stored credentials; the database stays and the external calendar is not touched.
 */
export interface UpdateCalendarSyncRequest { name?: string; intervalMinutes?: number; url?: string; credentials?: CalDavAccount;
  /** `caldav` sources with a writable calendar: makes this the aggregate calendar (for the caller's sources), or stops it. */
  aggregate?: boolean }

// ---------------------------------------------------------------------------------------------------------
// CalDAV

/** Server presets the interface offers; any other https address works the same way. */
export const caldavPresets = [
  { id: 'icloud', name: 'iCloud', serverUrl: 'https://caldav.icloud.com' },
  { id: 'feishu', name: '飞书', serverUrl: 'https://caldav.feishu.cn' },
  { id: 'dingtalk', name: '钉钉', serverUrl: 'https://calendar.dingtalk.com' },
  { id: 'wecom', name: '企业微信', serverUrl: 'https://caldav.wecom.work' },
] as const;

export interface CalDavAccount { username: string; password: string }

/**
 * POST /calendar/caldav/discover: signs in and lists the account's event calendars. `serverUrl` is an http(s)
 * address; a bare host name means https. Nothing is stored.
 */
export interface CalDavDiscoverRequest extends CalDavAccount { serverUrl: string }

export interface CalDavCalendarOption {
  /** Absolute URL of the calendar collection; pass it back unchanged as `calendarUrl`. */
  url: string;
  name: string;
  /** `#rrggbb` when the server reports a colour. */
  color: string | null;
  writable: boolean;
}

export interface CalDavDiscoverResponse { calendars: CalDavCalendarOption[] }

/** At most this many calendars are connected by one request. */
export const calendarConnectLimit = 20;

/** One calendar to connect and the name of the database it gets. */
export interface CalendarConnectChoice {
  /** One of the calendars discovery (or the OAuth flow) lists, passed back unchanged. */
  calendarUrl: string;
  name: string;
}

/**
 * POST /calendar/caldav: each chosen calendar gets its own database and source; all are created or none. The
 * credentials are stored encrypted, then the sources sync in the background.
 */
export interface CreateCalDavSourceRequest extends CalDavDiscoverRequest {
  clientMutationId: string;
  /** Distinct calendars, 1 to calendarConnectLimit. */
  calendars: CalendarConnectChoice[];
  parentId: string | null;
  intervalMinutes: number;
}

/** POST /calendar/caldav and POST /calendar/oauth/sources answer 201 with the new sources in request order. */
export interface CreateCalendarSourcesResponse { sources: CalendarSyncSource[] }

// ---------------------------------------------------------------------------------------------------------
// OAuth accounts (三期): Google through its CalDAV API, Microsoft through Microsoft Graph. Each workspace registers
// its own OAuth app with the provider; see docs/architecture/calendar.md.

export const oauthProviders = ['google', 'microsoft'] as const;
export type OAuthProvider = typeof oauthProviders[number];
export type CalendarAccountProvider = 'caldav' | OAuthProvider;

/** Path of the Google redirect URI under NBASE_PUBLIC_ORIGIN; not under a workspace. */
export const googleOAuthCallbackPath = '/api/calendar/oauth/google/callback';

/** GET /calendar/oauth/apps: the workspace's OAuth apps. Client secrets are never returned. */
export interface OAuthAppsResponse {
  /** The redirect URI to register for the Google client: NBASE_PUBLIC_ORIGIN + googleOAuthCallbackPath. */
  googleRedirectUri: string;
  /**
   * `secretUnavailable` when the saved client secret does not open with the current credential key (the key was
   * replaced): the app has to be saved again before it can be used, and starting a flow answers OAUTH_APP_MISSING.
   */
  google: { clientId: string; secretUnavailable?: true } | null;
  microsoft: { clientId: string; tenant: string } | null;
}

/** PUT /calendar/oauth/apps/google, from the client JSON Google offers for download (`web` or `installed`). */
export interface PutGoogleOAuthAppRequest { clientId: string; clientSecret: string }

/**
 * PUT /calendar/oauth/apps/microsoft: a public client that allows the device code flow. `tenant` is `common`,
 * `consumers`, `organizations`, a tenant GUID or a tenant domain name.
 */
export interface PutMicrosoftOAuthAppRequest { clientId: string; tenant: string }

/** Both PUTs answer with the new OAuthAppsResponse. DELETE /calendar/oauth/apps/:provider answers 204, or 409 OAUTH_APP_IN_USE. */

/**
 * POST /calendar/oauth/start. Without `sourceId` the flow ends with the account's calendars, for
 * POST /calendar/oauth/sources. With `sourceId` (an OAuth source of the same provider) it re-authorizes that
 * source: the new tokens replace the stored ones when the account is the same.
 */
export interface StartOAuthRequest { provider: OAuthProvider; sourceId?: string }

/** Google: open `authorizeUrl` in a new tab. Microsoft: show `userCode` and a link to `verificationUri`. Then poll the flow. */
export type StartOAuthResponse =
  | { flowId: string; provider: 'google'; authorizeUrl: string; expiresAt: string }
  | { flowId: string; provider: 'microsoft'; userCode: string; verificationUri: string; expiresAt: string; intervalSeconds: number };

/**
 * Why a flow failed. OAUTH_DENIED: the user declined. OAUTH_EXPIRED: not finished in time. ACCOUNT_MISMATCH:
 * re-authorization signed in to another account. OAUTH_FAILED: the provider refused the app or the code
 * (wrong client secret, redirect URI not registered, public client flows not allowed). OAUTH_DENIED also covers a
 * Google consent that left out the calendar permission. API_DISABLED: as for sources.
 */
export const oauthFlowErrors = ['OAUTH_DENIED', 'OAUTH_EXPIRED', 'OAUTH_FAILED', 'ACCOUNT_MISMATCH', 'FETCH_FAILED', 'API_DISABLED'] as const;
export type OAuthFlowError = typeof oauthFlowErrors[number];

/**
 * GET /calendar/oauth/flows/:flowId, by the user who started it. A pending Microsoft flow asks the token
 * endpoint at most once per interval when this is read. Flows last 15 minutes.
 */
export interface OAuthFlowResponse {
  status: 'pending' | 'ready' | 'failed';
  error: OAuthFlowError | null;
  account: string | null;
  /** Ready new-source flows: the account's event calendars, as discovery lists them for CalDAV. */
  calendars: CalDavCalendarOption[];
  /** Ready re-authorization flows: the updated source, which syncs right away. */
  source: CalendarSyncSource | null;
}

/**
 * POST /calendar/oauth/sources: from a ready new-source flow, which is used up, each chosen calendar gets its own
 * database and source, all or none; then they sync in the background. Answers like POST /calendar/caldav.
 */
export interface CreateOAuthSourceRequest {
  clientMutationId: string;
  flowId: string;
  /** Distinct calendars from the flow's `calendars`, 1 to calendarConnectLimit. */
  calendars: CalendarConnectChoice[];
  intervalMinutes: number;
}

export const calendarConflictKinds = ['both-changed', 'remote-deleted', 'local-deleted'] as const;
export type CalendarConflictKind = typeof calendarConflictKinds[number];

/** The synced fields of one side of a conflict. `value` is a date cell value without `remind=`. */
export interface CalendarEventSnapshot { title: string; value: string; location: string; description: string }

/**
 * One event changed on both sides since the last sync. Writing back pauses for it until it is resolved.
 * - both-changed: the row keeps the NBase version; `copyRowId` is a new row holding the external version.
 * - remote-deleted: the row was changed in NBase and the event was deleted outside; `remote` is null.
 * - local-deleted: the row was moved to the trash in NBase and the event was changed outside; `local` is null.
 */
export interface CalendarSyncConflict {
  rowId: string;
  copyRowId: string | null;
  kind: CalendarConflictKind;
  local: CalendarEventSnapshot | null;
  remote: CalendarEventSnapshot | null;
  detectedAt: string;
}

/** GET /calendar/sync/:id/conflicts */
export interface CalendarSyncConflictsResponse { conflicts: CalendarSyncConflict[] }

/**
 * POST /calendar/sync/:id/conflicts/:rowId resolves one conflict; the result is written back on the next run,
 * which starts right away.
 * - local: keep the NBase version (or the deletion) and write it to the external calendar; the copy goes to the trash.
 * - remote: take the external version (or deletion) into the row; the copy goes to the trash.
 * - both (both-changed only): the row keeps the NBase version and the copy becomes a new external event.
 */
export const calendarConflictChoices = ['local', 'remote', 'both'] as const;
export type CalendarConflictChoice = typeof calendarConflictChoices[number];
export interface ResolveCalendarConflictRequest { choice: CalendarConflictChoice }
export interface ResolveCalendarConflictResponse { source: CalendarSyncSource }

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
  if (!isRecord(value) || !hasOnly(value, ['sources', 'showDailyNotes', 'defaultDatabaseId', 'autoAdd'])) return false;
  if (value.autoAdd !== undefined && typeof value.autoAdd !== 'boolean') return false;
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
  if (!isRecord(value) || !hasOnly(value, ['name', 'intervalMinutes', 'url', 'credentials', 'aggregate']) || Object.keys(value).length === 0) return false;
  return (value.name === undefined || isName(value.name))
    && (value.aggregate === undefined || typeof value.aggregate === 'boolean')
    && (value.intervalMinutes === undefined || (calendarSyncIntervals as readonly unknown[]).includes(value.intervalMinutes))
    && (value.url === undefined || isSyncUrl(value.url))
    && (value.credentials === undefined || isCalDavAccount(value.credentials, true));
}

function isSecretText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCalDavAccount(value: unknown, exact: boolean): value is CalDavAccount {
  return isRecord(value) && (!exact || hasOnly(value, ['username', 'password']))
    && isSecretText(value.username, 256) && isSecretText(value.password, 1024);
}

/** An http(s) URL or a bare host name, at most 2000 characters. */
export function isCalDavServerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2000 || /\s/.test(value.trim())) return false;
  const text = value.trim();
  return /^https?:\/\//i.test(text) || !/^[a-z][a-z0-9+.-]*:/i.test(text);
}

export function isCalDavDiscoverRequest(value: unknown): value is CalDavDiscoverRequest {
  return isRecord(value) && hasOnly(value, ['serverUrl', 'username', 'password']) && isCalDavServerUrl(value.serverUrl)
    && isCalDavAccount(value, false);
}

function isConnectChoices(value: unknown, scheme: RegExp): value is CalendarConnectChoice[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > calendarConnectLimit) return false;
  const urls = new Set<string>();
  for (const choice of value) {
    if (!isRecord(choice) || !hasOnly(choice, ['calendarUrl', 'name']) || !isName(choice.name)) return false;
    const url = choice.calendarUrl;
    if (typeof url !== 'string' || !scheme.test(url) || url.length > 2000 || urls.has(url)) return false;
    urls.add(url);
  }
  return true;
}

export function isCreateCalDavSourceRequest(value: unknown): value is CreateCalDavSourceRequest {
  return isRecord(value) && hasOnly(value, ['clientMutationId', 'serverUrl', 'username', 'password', 'calendars', 'parentId',
    'intervalMinutes']) && isDatabaseId(value.clientMutationId) && isCalDavServerUrl(value.serverUrl) && isCalDavAccount(value, false)
    && isConnectChoices(value.calendars, /^https?:\/\//i) && (value.parentId === null || isDatabaseId(value.parentId))
    && (calendarSyncIntervals as readonly unknown[]).includes(value.intervalMinutes);
}

/** Google client IDs end in .apps.googleusercontent.com; checked loosely so other client forms still pass. */
function isClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{8,256}$/.test(value);
}

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMicrosoftTenant(value: unknown): value is string {
  return typeof value === 'string' && (['common', 'consumers', 'organizations'].includes(value) || guidPattern.test(value)
    || (/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)));
}

export function isPutGoogleOAuthAppRequest(value: unknown): value is PutGoogleOAuthAppRequest {
  return isRecord(value) && hasOnly(value, ['clientId', 'clientSecret']) && isClientId(value.clientId) && isSecretText(value.clientSecret, 256);
}

export function isPutMicrosoftOAuthAppRequest(value: unknown): value is PutMicrosoftOAuthAppRequest {
  return isRecord(value) && hasOnly(value, ['clientId', 'tenant']) && typeof value.clientId === 'string' && guidPattern.test(value.clientId)
    && isMicrosoftTenant(value.tenant);
}

export function isStartOAuthRequest(value: unknown): value is StartOAuthRequest {
  return isRecord(value) && hasOnly(value, ['provider', 'sourceId']) && (oauthProviders as readonly unknown[]).includes(value.provider)
    && (value.sourceId === undefined || isDatabaseId(value.sourceId));
}

export function isCreateOAuthSourceRequest(value: unknown): value is CreateOAuthSourceRequest {
  return isRecord(value) && hasOnly(value, ['clientMutationId', 'flowId', 'calendars', 'intervalMinutes'])
    && isDatabaseId(value.clientMutationId) && isDatabaseId(value.flowId) && isConnectChoices(value.calendars, /^https:\/\//i)
    && (calendarSyncIntervals as readonly unknown[]).includes(value.intervalMinutes);
}

export function isResolveCalendarConflictRequest(value: unknown): value is ResolveCalendarConflictRequest {
  return isRecord(value) && hasOnly(value, ['choice']) && (calendarConflictChoices as readonly unknown[]).includes(value.choice);
}
