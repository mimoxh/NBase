import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import type { CalDavAccount, CalDavCalendarOption, CalendarSyncError } from '@nbase/contracts';
import { anyPortTarget, GuardedFetchError, guardedRequest, guardedTarget, isBlockedAddress, sameSiteRedirect } from '../../net/guardedFetch.js';
import { APPLE, CALDAV, CALSERVER, child, childrenOf, DAV, deepText, escapeXml, parseXml, XmlError, type XmlElement } from './xml.js';

/** A CalDAV failure, with the code recorded on the source or returned by discovery. */
export class CalDavError extends Error {
  constructor(public readonly code: CalendarSyncError) { super(code); }
}

export interface DavRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  /** PROPFIND and REPORT follow redirects (well-known addresses); writes never do. */
  followRedirects: boolean;
}

export interface DavResponse { status: number; url: URL; headers: IncomingHttpHeaders; body: Buffer }

/** Does the network request. Tests may replace it; the default goes through the guarded fetch. */
export type DavTransport = (request: DavRequest) => Promise<DavResponse>;

export const davResponseLimit = 10 * 1024 * 1024;
const davTimeoutMs = 30000;

/**
 * The guarded transport: public addresses on default ports, or with `allowPrivate` (NBASE_CALDAV_PRIVATE=allow)
 * any address and port, with plain http only toward loopback and private addresses. Redirects keep the
 * Authorization header only within the same site (see `sameSiteRedirect`); others fail with FETCH_FAILED.
 */
export function guardedDavTransport(allowPrivate: boolean): DavTransport {
  return async request => {
    const response = await guardedRequest(request.url, {
      method: request.method, headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}),
      timeoutMs: davTimeoutMs, maxBytes: davResponseLimit, oversize: 'error', maxRedirects: request.followRedirects ? 5 : 0,
      acceptStatus: 'all', target: allowPrivate ? anyPortTarget : guardedTarget, addresses: allowPrivate ? 'private' : 'public',
      redirectAllowed: sameSiteRedirect,
    });
    return { status: response.status, url: response.url, headers: response.headers, body: response.body };
  };
}

/**
 * A server address as entered: a bare host name means https. Checked like every request: without private
 * mode only public names and literal addresses on default ports, and https only.
 */
export function caldavServerUrl(raw: string, allowPrivate: boolean): URL {
  const text = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  return caldavTarget(withScheme, allowPrivate);
}

export function caldavTarget(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try { url = (allowPrivate ? anyPortTarget : guardedTarget)(raw); } catch (error) {
    if (error instanceof GuardedFetchError && error.code === 'URL_BLOCKED') throw new CalDavError('URL_BLOCKED');
    throw new CalDavError('URL_INVALID');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && isBlockedAddress(host));
  if (!allowPrivate && (local || url.protocol !== 'https:')) throw new CalDavError('URL_BLOCKED');
  if (allowPrivate && url.protocol === 'http:' && isIP(host) !== 0 && !isBlockedAddress(host)) throw new CalDavError('URL_BLOCKED');
  return url;
}

/** Maps transport failures to sync errors. */
export function davErrorCode(error: unknown): CalendarSyncError {
  if (error instanceof CalDavError) return error.code;
  if (error instanceof GuardedFetchError) return error.code === 'REJECTED' ? 'FETCH_FAILED' : error.code;
  return 'FETCH_FAILED';
}

/** A key that matches the same resource however a server encodes its path. */
export function hrefKey(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname.split('/').map(segment => {
      try { return encodeURIComponent(decodeURIComponent(segment)); } catch { return segment; }
    }).join('/');
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch { return href; }
}

/** `#rrggbb`, from the `#rgb`, `#rrggbb` or `#rrggbbaa` that servers report. */
export function normalizeColor(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map(c => c + c).join('')}`;
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(text)) return text.slice(0, 7);
  return null;
}

interface Propstat { status: number; prop: XmlElement }
export interface MultistatusItem { href: string; url: URL; status: number | null; propstats: Propstat[] }
export interface Multistatus { items: MultistatusItem[]; syncToken: string | null }

function statusCode(text: string): number | null {
  const match = /^\s*HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(text);
  return match ? Number(match[1]) : null;
}

export function parseMultistatus(body: Buffer | string, base: URL): Multistatus {
  let root: XmlElement;
  try { root = parseXml(typeof body === 'string' ? body : body.toString('utf8')); } catch (error) {
    if (error instanceof XmlError) throw new CalDavError('NOT_CALDAV');
    throw error;
  }
  if (root.ns !== DAV || root.name !== 'multistatus') throw new CalDavError('NOT_CALDAV');
  const items: MultistatusItem[] = [];
  for (const response of childrenOf(root, DAV, 'response')) {
    const href = deepText(child(response, DAV, 'href')).trim();
    if (!href) continue;
    let url: URL;
    try { url = new URL(href, base); } catch { continue; }
    const direct = child(response, DAV, 'status');
    const propstats: Propstat[] = [];
    for (const propstat of childrenOf(response, DAV, 'propstat')) {
      const prop = child(propstat, DAV, 'prop');
      if (prop) propstats.push({ status: statusCode(deepText(child(propstat, DAV, 'status'))) ?? 200, prop });
    }
    items.push({ href, url, status: direct ? statusCode(deepText(direct)) : null, propstats });
  }
  const token = deepText(child(root, DAV, 'sync-token')).trim();
  return { items, syncToken: token || null };
}

/** A property reported with status 200. */
export function okProp(item: MultistatusItem, ns: string, name: string): XmlElement | undefined {
  for (const propstat of item.propstats) {
    if (propstat.status < 200 || propstat.status >= 300) continue;
    const found = child(propstat.prop, ns, name);
    if (found) return found;
  }
  return undefined;
}

function sameCollection(a: URL, b: URL): boolean {
  const strip = (url: URL) => hrefKey(url.toString()).replace(/\/+$/, '');
  return strip(a) === strip(b);
}

const xmlHead = '<?xml version="1.0" encoding="utf-8"?>';
const principalBody = `${xmlHead}<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:current-user-principal/><c:calendar-home-set/>`
  + '<d:resourcetype/></d:prop></d:propfind>';
const homeBody = `${xmlHead}<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const listBody = `${xmlHead}<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:a="${APPLE}"><d:prop><d:resourcetype/><d:displayname/>`
  + '<a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>';
const stateBody = `${xmlHead}<d:propfind xmlns:d="DAV:" xmlns:cs="${CALSERVER}"><d:prop><d:resourcetype/><cs:getctag/><d:sync-token/>`
  + '<d:current-user-privilege-set/></d:prop></d:propfind>';
const etagBody = `${xmlHead}<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>`;

export interface CalendarState { ctag: string | null; syncToken: string | null; writable: boolean | null }
export interface RemoteEtag { href: string; etag: string | null }
export interface RemoteResource { href: string; etag: string | null; body: string }
export type SyncChanges = { changed: RemoteEtag[]; removed: string[]; syncToken: string | null };
export interface WriteResult { status: number; etag: string | null }

function writableOf(item: MultistatusItem): boolean | null {
  const set = okProp(item, DAV, 'current-user-privilege-set');
  if (!set) return null;
  const names = childrenOf(set, DAV, 'privilege').flatMap(privilege => privilege.children)
    .filter(element => element.ns === DAV).map(element => element.name);
  return names.some(name => name === 'write' || name === 'write-content' || name === 'all');
}

function etagOf(item: MultistatusItem): string | null {
  const text = deepText(okProp(item, DAV, 'getetag')).trim();
  return text || null;
}

function headerText(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' && value.length ? value : null;
}

/**
 * One account on one server. Requests use HTTP Basic. 401 always becomes AUTH_FAILED; reads that cannot
 * reach the calendar become CALENDAR_NOT_FOUND; other reading failures FETCH_FAILED.
 */
export class CalDavClient {
  private readonly authorization: string;

  constructor(private readonly transport: DavTransport, account: CalDavAccount, private readonly allowPrivate: boolean) {
    this.authorization = `Basic ${Buffer.from(`${account.username}:${account.password}`, 'utf8').toString('base64')}`;
  }

  private async send(method: string, url: URL, options: { body?: string; depth?: '0' | '1'; headers?: Record<string, string>;
    follow?: boolean; type?: string } = {}): Promise<DavResponse> {
    const target = caldavTarget(url.toString(), this.allowPrivate);
    const headers: Record<string, string> = { Authorization: this.authorization, 'User-Agent': 'NBase-CalDAV/1.0', ...options.headers };
    if (options.depth !== undefined) headers.Depth = options.depth;
    if (options.body !== undefined) headers['Content-Type'] = options.type ?? 'application/xml; charset=utf-8';
    let response: DavResponse;
    try {
      response = await this.transport({ method, url: target, headers, ...(options.body !== undefined ? { body: options.body } : {}),
        followRedirects: options.follow ?? (method === 'PROPFIND' || method === 'REPORT') });
    } catch (error) { throw new CalDavError(davErrorCode(error)); }
    if (response.status === 401) throw new CalDavError('AUTH_FAILED');
    return response;
  }

  private async propfind(url: URL, body: string, depth: '0' | '1'): Promise<{ response: DavResponse; status: Multistatus | null }> {
    const response = await this.send('PROPFIND', url, { body, depth });
    return { response, status: response.status === 207 ? parseMultistatus(response.body, response.url) : null };
  }

  /** Signs in and lists the event calendars of the account. */
  async discover(server: URL): Promise<CalDavCalendarOption[]> {
    const candidates = [new URL('/.well-known/caldav', server), server];
    let principal: URL | null = null;
    let homes: URL[] = [];
    let reached = false;
    let failure: CalendarSyncError | null = null;
    for (const candidate of candidates) {
      let result;
      try { result = await this.propfind(candidate, principalBody, '0'); } catch (error) {
        if (error instanceof CalDavError && error.code === 'AUTH_FAILED') throw error;
        failure ??= error instanceof CalDavError ? error.code : 'FETCH_FAILED';
        continue;
      }
      reached = true;
      if (!result.status) continue;
      for (const item of result.status.items) {
        const principalHref = deepText(child(okProp(item, DAV, 'current-user-principal'), DAV, 'href')).trim();
        if (principalHref && !principal) principal = new URL(principalHref, result.response.url);
        homes.push(...childrenOf(okProp(item, CALDAV, 'calendar-home-set'), DAV, 'href')
          .map(href => deepText(href).trim()).filter(Boolean).map(href => new URL(href, result.response.url)));
      }
      if (principal || homes.length) break;
    }
    if (!reached) throw new CalDavError(failure ?? 'FETCH_FAILED');
    if (!homes.length && principal) {
      const result = await this.propfind(principal, homeBody, '0');
      for (const item of result.status?.items ?? []) {
        homes.push(...childrenOf(okProp(item, CALDAV, 'calendar-home-set'), DAV, 'href')
          .map(href => deepText(href).trim()).filter(Boolean).map(href => new URL(href, result.response.url)));
      }
    }
    homes = homes.filter((home, index) => homes.findIndex(other => sameCollection(home, other)) === index);
    if (!homes.length) throw new CalDavError('NOT_CALDAV');
    const calendars: CalDavCalendarOption[] = [];
    for (const home of homes) {
      const result = await this.propfind(home, listBody, '1');
      if (!result.status) {
        if (result.response.status === 404) continue;
        throw new CalDavError('FETCH_FAILED');
      }
      for (const item of result.status.items) {
        const type = okProp(item, DAV, 'resourcetype');
        if (!child(type, CALDAV, 'calendar')) continue;
        const components = okProp(item, CALDAV, 'supported-calendar-component-set');
        const names = childrenOf(components, CALDAV, 'comp').map(comp => (comp.attrs.get('name') ?? '').toUpperCase());
        if (components && names.length && !names.includes('VEVENT')) continue;
        if (calendars.some(known => sameCollection(new URL(known.url), item.url))) continue;
        const display = deepText(okProp(item, DAV, 'displayname')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
        const segment = item.url.pathname.split('/').filter(Boolean).at(-1) ?? item.url.hostname;
        let fallback = segment;
        try { fallback = decodeURIComponent(segment); } catch { /* keep the raw segment */ }
        const name = [...(display || fallback)].slice(0, 100).join('');
        const url = new URL(item.url);
        if (!url.pathname.endsWith('/')) url.pathname += '/';
        calendars.push({ url: url.toString(), name, color: normalizeColor(deepText(okProp(item, APPLE, 'calendar-color'))),
          writable: writableOf(item) ?? false });
      }
    }
    return calendars;
  }

  /** ctag, sync token and write permission of a calendar collection. */
  async calendarState(calendar: URL): Promise<CalendarState> {
    const result = await this.propfind(calendar, stateBody, '0');
    if (result.response.status === 404 || result.response.status === 410) throw new CalDavError('CALENDAR_NOT_FOUND');
    if (!result.status) throw new CalDavError('FETCH_FAILED');
    const self = result.status.items.find(item => sameCollection(item.url, calendar)) ?? result.status.items[0];
    if (!self || (self.status !== null && self.status >= 400) || !child(okProp(self, DAV, 'resourcetype'), CALDAV, 'calendar')) {
      throw new CalDavError('CALENDAR_NOT_FOUND');
    }
    const ctag = deepText(okProp(self, CALSERVER, 'getctag')).trim();
    const token = deepText(okProp(self, DAV, 'sync-token')).trim();
    return { ctag: ctag || null, syncToken: token || null, writable: writableOf(self) };
  }

  /** Changes since a sync token (RFC 6578), or null when the server refuses the token. */
  async syncChanges(calendar: URL, token: string): Promise<SyncChanges | null> {
    const changed = new Map<string, RemoteEtag>();
    const removed = new Map<string, string>();
    let current = token;
    for (let round = 0; round < 50; round++) {
      const body = `${xmlHead}<d:sync-collection xmlns:d="DAV:"><d:sync-token>${escapeXml(current)}</d:sync-token>`
        + '<d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>';
      const response = await this.send('REPORT', calendar, { body, depth: '0' });
      if (response.status === 404 || response.status === 410) throw new CalDavError('CALENDAR_NOT_FOUND');
      if (response.status !== 207) return null;
      const status = parseMultistatus(response.body, response.url);
      let truncated = false;
      for (const item of status.items) {
        if (sameCollection(item.url, calendar)) { if (item.status === 507) truncated = true; continue; }
        const key = hrefKey(item.url.toString());
        if (item.status === 404 || item.status === 410) { changed.delete(key); removed.set(key, item.url.toString()); continue; }
        if (okProp(item, DAV, 'resourcetype') && child(okProp(item, DAV, 'resourcetype'), DAV, 'collection')) continue;
        removed.delete(key);
        changed.set(key, { href: item.url.toString(), etag: etagOf(item) });
      }
      if (!status.syncToken) return null;
      current = status.syncToken;
      if (!truncated) return { changed: [...changed.values()], removed: [...removed.values()], syncToken: current };
    }
    return null;
  }

  /** Every resource of the calendar with its ETag. */
  async listEtags(calendar: URL): Promise<RemoteEtag[]> {
    const result = await this.propfind(calendar, etagBody, '1');
    if (result.response.status === 404 || result.response.status === 410) throw new CalDavError('CALENDAR_NOT_FOUND');
    if (!result.status) throw new CalDavError('FETCH_FAILED');
    return result.status.items.filter(item => !sameCollection(item.url, calendar) && (item.status === null || item.status < 400)
      && !child(okProp(item, DAV, 'resourcetype'), DAV, 'collection'))
      .map(item => ({ href: item.url.toString(), etag: etagOf(item) }));
  }

  /**
   * Texts of resources, by calendar-multiget in batches of 100. Resources the server reports missing are
   * left out; ones it skips are read with GET.
   */
  async fetchResources(calendar: URL, hrefs: string[]): Promise<{ found: RemoteResource[]; missing: string[] }> {
    const found: RemoteResource[] = [];
    const missing: string[] = [];
    for (let i = 0; i < hrefs.length; i += 100) {
      const batch = hrefs.slice(i, i + 100);
      const body = `${xmlHead}<c:calendar-multiget xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop>`
        + batch.map(href => `<d:href>${escapeXml(new URL(href).pathname)}</d:href>`).join('') + '</c:calendar-multiget>';
      const response = await this.send('REPORT', calendar, { body, depth: '1' });
      if (response.status === 404 || response.status === 410) throw new CalDavError('CALENDAR_NOT_FOUND');
      const answered = new Set<string>();
      if (response.status === 207) {
        const status = parseMultistatus(response.body, response.url);
        for (const item of status.items) {
          const key = hrefKey(item.url.toString());
          const wanted = batch.find(href => hrefKey(href) === key);
          if (!wanted) continue;
          if (item.status === 404 || item.status === 410) { answered.add(key); missing.push(wanted); continue; }
          const data = okProp(item, CALDAV, 'calendar-data');
          if (!data) continue;
          answered.add(key);
          found.push({ href: wanted, etag: etagOf(item), body: deepText(data) });
        }
      }
      for (const href of batch) {
        if (answered.has(hrefKey(href))) continue;
        const resource = await this.get(href);
        if (resource) found.push(resource); else missing.push(href);
      }
    }
    return { found, missing };
  }

  async get(href: string): Promise<RemoteResource | null> {
    const response = await this.send('GET', new URL(href), { headers: { Accept: 'text/calendar' }, follow: false });
    if (response.status === 404 || response.status === 410) return null;
    if (response.status < 200 || response.status >= 300) throw new CalDavError('FETCH_FAILED');
    return { href, etag: headerText(response.headers, 'etag'), body: response.body.toString('utf8') };
  }

  async put(href: string, text: string, condition: { ifMatch: string } | { ifNoneMatch: '*' }): Promise<WriteResult> {
    const headers = 'ifMatch' in condition ? { 'If-Match': condition.ifMatch } : { 'If-None-Match': '*' };
    const response = await this.send('PUT', new URL(href), { body: text, headers, type: 'text/calendar; charset=utf-8', follow: false });
    return { status: response.status, etag: headerText(response.headers, 'etag') };
  }

  async delete(href: string, etag: string | null): Promise<WriteResult> {
    const response = await this.send('DELETE', new URL(href), { headers: etag ? { 'If-Match': etag } : {}, follow: false });
    return { status: response.status, etag: null };
  }
}
