import type { IncomingHttpHeaders } from 'node:http';
import type { CalendarSyncError } from '@nbase/contracts';
import { calendarImportByteLimit } from '@nbase/contracts';
import { isIP } from 'node:net';
import { charsetOf, decodeText, GuardedFetchError, guardedGet, guardedTarget, isBlockedAddress } from '../net/guardedFetch.js';
import { IcsError, looksLikeCalendar } from './ics.js';

/** A failure of a subscription fetch, with the code recorded on the source. */
export class CalendarFetchError extends Error {
  constructor(public readonly code: CalendarSyncError) { super(code); }
}

export interface FetchedResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

/** Does the network request. Tests replace it; the default is the guarded fetcher shared with link previews. */
export type CalendarFetcher = (url: URL, headers: Record<string, string>) => Promise<FetchedResponse>;

const calendarTypes = /^(?:text\/calendar|text\/plain|application\/octet-stream)\b/i;

export const guardedCalendarFetcher: CalendarFetcher = (url, headers) => guardedGet(url, {
  headers: { 'User-Agent': 'NBase-Calendar/1.0', Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1', ...headers },
  timeoutMs: 30000, maxBytes: calendarImportByteLimit, maxRedirects: 5, oversize: 'error', acceptStatus: [304],
  inspect: (status, responseHeaders) => {
    const type = responseHeaders['content-type'];
    if (status !== 304 && type && !calendarTypes.test(type)) throw new GuardedFetchError('REJECTED');
  },
});

/** A subscription URL as stored: `webcal://` becomes `https://`, and it must pass the address checks. */
export function subscriptionUrl(raw: string): string {
  const text = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try { url = guardedTarget(text); } catch (error) {
    if (error instanceof GuardedFetchError && error.code === 'URL_BLOCKED') throw new CalendarFetchError('URL_BLOCKED');
    throw new CalendarFetchError('URL_INVALID');
  }
  // Names are checked again at every fetch; literal private addresses can be refused right away.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isBlockedAddress(host))) throw new CalendarFetchError('URL_BLOCKED');
  return url.toString();
}

export function fetchErrorCode(error: unknown): CalendarSyncError {
  if (error instanceof CalendarFetchError) return error.code;
  if (error instanceof IcsError) return error.code;
  if (error instanceof GuardedFetchError) {
    if (error.code === 'REJECTED') return 'NOT_CALENDAR';
    return error.code;
  }
  return 'FETCH_FAILED';
}

export type FetchResult = { notModified: true } | { notModified: false; text: string; etag: string | null; lastModified: string | null };

/** Fetches a feed with a conditional GET and checks that what came back is a calendar. */
export async function fetchCalendar(url: string, cache: { etag: string | null; lastModified: string | null },
  fetcher: CalendarFetcher = guardedCalendarFetcher): Promise<FetchResult> {
  const headers: Record<string, string> = {};
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
  const response = await fetcher(new URL(url), headers);
  if (response.status === 304) return { notModified: true };
  if (response.status < 200 || response.status >= 300) throw new CalendarFetchError('FETCH_FAILED');
  if (response.body.length > calendarImportByteLimit) throw new CalendarFetchError('TOO_LARGE');
  const type = response.headers['content-type'];
  if (type && !calendarTypes.test(type)) throw new CalendarFetchError('NOT_CALENDAR');
  const text = decodeText(response.body, charsetOf(type));
  if (!looksLikeCalendar(text)) throw new CalendarFetchError('NOT_CALENDAR');
  const header = (name: string) => { const value = response.headers[name]; return typeof value === 'string' && value.length ? value : null; };
  return { notModified: false, text, etag: header('etag'), lastModified: header('last-modified') };
}
