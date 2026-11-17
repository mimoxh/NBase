import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small in-process CalDAV server for tests: one principal, a calendar home with calendars, HTTP Basic,
 * PROPFIND, sync-collection and calendar-multiget REPORTs, GET, conditional PUT and DELETE.
 */

interface Resource { etag: string; body: string }
interface MockCalendar {
  name: string;
  color: string | null;
  writable: boolean;
  components: string[];
  resources: Map<string, Resource>;
  version: number;
  log: { version: number; name: string }[];
}

export interface MockRequest { method: string; path: string; depth?: string; ifMatch?: string; ifNoneMatch?: string; body: string }

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const multistatus = (inner: string, extra = '') => `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" `
  + `xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">${inner}${extra}</d:multistatus>`;
const ok = (href: string, props: string) => `<d:response><d:href>${escape(href)}</d:href><d:propstat><d:prop>${props}</d:prop>`
  + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
const missing = (href: string) => `<d:response><d:href>${escape(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;

export class MockCalDav {
  readonly username = 'alice@example.test';
  password = 'app-password';
  readonly calendars = new Map<string, MockCalendar>();
  readonly requests: MockRequest[] = [];
  supportsSync = true;
  /** Leaves the ETag out of PUT answers, as some servers do. */
  omitPutEtag = false;
  /** Runs before the next PUT or DELETE is handled, once; to change a resource "meanwhile". */
  beforeWrite: ((path: string) => void) | null = null;
  private server: Server | null = null;
  private counter = 0;
  origin = '';

  readonly home: string = '/dav/calendars/alice/';
  readonly principal = '/dav/principals/alice/';
  /** Replaces the HTTP Basic check, for servers that take bearer tokens. */
  authorize: ((authorization: string | undefined) => boolean) | null = null;

  /** `home` moves the calendars, e.g. to Google's `/caldav/v2/`. */
  constructor(options: { home?: string } = {}) {
    if (options.home) this.home = options.home;
  }

  addCalendar(id: string, options: { name: string; writable: boolean; color?: string | null; components?: string[] }): string {
    this.calendars.set(`${this.home}${id}/`, { name: options.name, color: options.color ?? null, writable: options.writable,
      components: options.components ?? ['VEVENT'], resources: new Map(), version: 1, log: [] });
    return `${this.home}${id}/`;
  }

  url(path: string): string { return new URL(path, this.origin).toString(); }

  /** A change made outside NBase. */
  set(calendar: string, name: string, body: string): void {
    const cal = this.calendars.get(calendar)!;
    cal.resources.set(name, { etag: `"e${++this.counter}"`, body });
    cal.log.push({ version: ++cal.version, name });
  }

  remove(calendar: string, name: string): void {
    const cal = this.calendars.get(calendar)!;
    cal.resources.delete(name);
    cal.log.push({ version: ++cal.version, name });
  }

  body(calendar: string, name: string): string | undefined { return this.calendars.get(calendar)?.resources.get(name)?.body; }

  async start(): Promise<void> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => { if (this.server) this.server.close(() => resolve()); else resolve(); });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    const header = (name: string) => { const v = request.headers[name]; return typeof v === 'string' ? v : undefined; };
    this.requests.push({ method: request.method ?? '', path, body,
      ...(header('depth') !== undefined ? { depth: header('depth')! } : {}),
      ...(header('if-match') !== undefined ? { ifMatch: header('if-match')! } : {}),
      ...(header('if-none-match') !== undefined ? { ifNoneMatch: header('if-none-match')! } : {}) });
    const send = (status: number, text = '', headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': text.startsWith('<?xml') ? 'application/xml; charset=utf-8' : 'text/plain', ...headers });
      response.end(text);
    };
    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    if (this.authorize ? !this.authorize(header('authorization')) : header('authorization') !== expected) return send(401, 'no', { 'www-authenticate': 'Basic realm="mock"' });
    const method = request.method ?? 'GET';
    const depth = header('depth') ?? '0';

    if (path === '/.well-known/caldav') return send(301, '', { location: this.principal });
    if (method === 'PROPFIND' && path === this.principal) {
      return send(207, multistatus(ok(this.principal, `<d:current-user-principal><d:href>${this.principal}</d:href></d:current-user-principal>`
        + `<c:calendar-home-set><d:href>${this.home}</d:href></c:calendar-home-set><d:resourcetype><d:principal/></d:resourcetype>`)));
    }
    if (method === 'PROPFIND' && path === this.home) {
      let inner = ok(this.home, '<d:resourcetype><d:collection/></d:resourcetype>');
      if (depth === '1') {
        for (const [href, cal] of this.calendars) {
          inner += ok(href, `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${escape(cal.name)}</d:displayname>`
            + (cal.color ? `<a:calendar-color>${cal.color}</a:calendar-color>` : '')
            + `<c:supported-calendar-component-set>${cal.components.map(c => `<c:comp name="${c}"/>`).join('')}</c:supported-calendar-component-set>`
            + `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${cal.writable ? '<d:privilege><d:write/></d:privilege>' : ''}`
            + '</d:current-user-privilege-set>');
        }
      }
      return send(207, multistatus(inner));
    }
    const calendarPath = [...this.calendars.keys()].find(href => path === href || path === href.slice(0, -1) || path.startsWith(href));
    if (!calendarPath) return send(404);
    const cal = this.calendars.get(calendarPath)!;
    const token = () => `http://mock.test/sync/${cal.version}`;
    if (path === calendarPath || path === calendarPath.slice(0, -1)) {
      if (method === 'PROPFIND' && depth === '0') {
        return send(207, multistatus(ok(calendarPath, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
          + `<cs:getctag>ctag-${cal.version}</cs:getctag>${this.supportsSync ? `<d:sync-token>${token()}</d:sync-token>` : ''}`
          + `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${cal.writable ? '<d:privilege><d:write-content/></d:privilege>' : ''}`
          + '</d:current-user-privilege-set>')));
      }
      if (method === 'PROPFIND' && depth === '1') {
        let inner = ok(calendarPath, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>');
        for (const [name, resource] of cal.resources) inner += ok(`${calendarPath}${name}`, `<d:resourcetype/><d:getetag>${escape(resource.etag)}</d:getetag>`);
        return send(207, multistatus(inner));
      }
      if (method === 'REPORT' && body.includes('sync-collection')) {
        const asked = /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(body)?.[1] ?? '';
        const since = /\/sync\/(\d+)$/.exec(asked);
        if (!this.supportsSync || !since) return send(403, multistatus('', '<d:error><d:valid-sync-token/></d:error>'));
        const names = new Set(cal.log.filter(entry => entry.version > Number(since[1])).map(entry => entry.name));
        let inner = '';
        for (const name of names) {
          const resource = cal.resources.get(name);
          inner += resource ? ok(`${calendarPath}${name}`, `<d:getetag>${escape(resource.etag)}</d:getetag>`) : missing(`${calendarPath}${name}`);
        }
        return send(207, multistatus(inner, `<d:sync-token>${token()}</d:sync-token>`));
      }
      if (method === 'REPORT' && body.includes('calendar-multiget')) {
        let inner = '';
        for (const match of body.matchAll(/<d:href>([^<]*)<\/d:href>/g)) {
          const href = decodeURIComponent(match[1]!);
          const resource = cal.resources.get(href.slice(calendarPath.length));
          inner += resource ? ok(href, `<d:getetag>${escape(resource.etag)}</d:getetag><c:calendar-data>${escape(resource.body)}</c:calendar-data>`)
            : missing(href);
        }
        return send(207, multistatus(inner));
      }
      return send(405);
    }
    const name = path.slice(calendarPath.length);
    const resource = cal.resources.get(name);
    if (method === 'GET') return resource ? send(200, resource.body, { etag: resource.etag, 'content-type': 'text/calendar' }) : send(404);
    if (method === 'PUT' || method === 'DELETE') {
      const hook = this.beforeWrite;
      this.beforeWrite = null;
      hook?.(path);
      const current = cal.resources.get(name);
      if (!cal.writable) return send(403);
      const ifMatch = header('if-match');
      if (ifMatch !== undefined && ifMatch !== current?.etag) return send(412);
      if (header('if-none-match') === '*' && current) return send(412);
      if (method === 'DELETE') {
        if (!current) return send(404);
        this.remove(calendarPath, name);
        return send(204);
      }
      this.set(calendarPath, name, body);
      const etag = cal.resources.get(name)!.etag;
      return send(current ? 204 : 201, '', this.omitPutEtag ? {} : { etag });
    }
    return send(405);
  }
}

export const icsText = (events: string[][], extra: string[] = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mock//EN', ...extra,
  ...events.flatMap(lines => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n') + '\r\n';
