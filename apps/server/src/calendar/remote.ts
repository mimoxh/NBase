import type { CalendarState, DavTransport, RemoteEtag, RemoteResource, SyncChanges } from './caldav/client.js';

/** Result of a write. A server that names new events itself (Microsoft Graph) returns the address and UID it chose. */
export interface RemoteWriteResult { status: number; etag: string | null; href?: string; uid?: string }

/**
 * One external calendar as the two-way sync engine (caldav/sync.ts) sees it: resources are iCalendar texts
 * addressed by absolute URLs, compared by ETag. CalDavClient implements it directly; the Microsoft Graph
 * adapter (graph/adapter.ts) translates. Errors are CalDavError with a CalendarSyncError code.
 */
export interface RemoteCalendar {
  calendarState(calendar: URL): Promise<CalendarState>;
  /** Changes since a sync token, or null when the server has none or refuses the token. */
  syncChanges(calendar: URL, token: string): Promise<SyncChanges | null>;
  listEtags(calendar: URL): Promise<RemoteEtag[]>;
  fetchResources(calendar: URL, hrefs: string[]): Promise<{ found: RemoteResource[]; missing: string[] }>;
  get(href: string): Promise<RemoteResource | null>;
  /** `ifNoneMatch` creates at `href` (a server may choose another address, see RemoteWriteResult); `ifMatch` replaces. */
  put(href: string, text: string, condition: { ifMatch: string } | { ifNoneMatch: '*' }): Promise<RemoteWriteResult>;
  delete(href: string, etag: string | null): Promise<RemoteWriteResult>;
}

/**
 * Access tokens of one OAuth source. `renew` is called once after a 401. Both throw CalDavError('AUTH_FAILED')
 * when the grant is revoked or expired, and CalDavError('OAUTH_APP_MISSING') when the app was removed.
 */
export interface BearerAuth { token(): Promise<string>; renew(): Promise<string> }

/** HTTP transport for provider APIs; the same shape as the CalDAV transport. */
export type HttpTransport = DavTransport;

/**
 * Sends each request with the current access token. A 401 renews the token once and repeats the request;
 * a second 401 is returned to the caller, which reports AUTH_FAILED.
 */
export function bearerTransport(transport: HttpTransport, auth: BearerAuth): HttpTransport {
  return async request => {
    const send = async (token: string) => transport({ ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } });
    const first = await send(await auth.token());
    if (first.status !== 401) return first;
    return send(await auth.renew());
  };
}
