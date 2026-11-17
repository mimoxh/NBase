import { instantText, isTimeZoneName, shiftCalendarDay, wallClock, wallToInstant } from '@nbase/contracts';
import type { DavRequest, DavResponse } from '../src/calendar/caldav/client.js';
import { graphBase } from '../src/calendar/graph/adapter.js';
import { windowsZones } from '../src/calendar/windowsZones.js';

/**
 * In-memory Microsoft Graph v1.0 calendar for tests: calendars, events, series masters with changed and
 * cancelled occurrences, the instances endpoint, conditional writes, paging and JSON batching. Times are
 * answered in UTC, as with `Prefer: outlook.timezone="UTC"`, all-day ones included.
 */

export interface GraphTimeInput { dateTime: string; timeZone: string }
interface Time { ms: number; zone: string }
type Json = Record<string, unknown>;

export interface MockException {
  id: string; iCalUId: string; changeKey: string; etag: string; date: string; originalStart: number;
  subject: string; body: string; location: string; start: Time; end: Time; isAllDay: boolean;
}

export interface MockEvent {
  id: string; calendarId: string; iCalUId: string; changeKey: string; etag: string; type: 'singleInstance' | 'seriesMaster';
  subject: string; body: string; location: string; start: Time; end: Time; isAllDay: boolean; isCancelled: boolean;
  recurrence: Json | null; attendees: Json[]; exceptions: Map<string, MockException>; cancelled: Set<string>;
}

export interface EventInput {
  subject: string; start: GraphTimeInput; end: GraphTimeInput; isAllDay?: boolean; location?: string; body?: string;
  recurrence?: Json | null; attendees?: Json[]; isCancelled?: boolean;
}

export interface MockRequest { method: string; path: string; query: URLSearchParams; body: unknown; ifMatch: string | undefined;
  prefer: string | undefined; batched: boolean }

const zones = new Map(Object.entries(windowsZones).map(([name, zone]) => [name.toLowerCase(), zone]));
const zoneOf = (name: string | null | undefined) => {
  const zone = zones.get((name ?? '').toLowerCase()) ?? name ?? 'UTC';
  return isTimeZoneName(zone) ? zone : 'UTC';
};
const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (ms: number, zone: string) => { const w = wallClock(ms, zone); return `${w[0]}-${pad(w[1])}-${pad(w[2])}`; };
const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function parseTime(input: GraphTimeInput): Time {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(input.dateTime);
  if (!match) throw new Error(`bad time ${input.dateTime}`);
  const [y, m, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map(i => Number(match[i] ?? 0)) as [number, number, number, number, number, number];
  return { ms: wallToInstant(y, m, d, h, mi, s, zoneOf(input.timeZone)), zone: input.timeZone };
}

const utcOut = (time: Time) => ({ dateTime: `${instantText(time.ms).slice(0, 19)}.0000000`, timeZone: 'UTC' });

export class MockGraph {
  token = 'token-1';
  pageSize = 100;
  readonly calendars = new Map<string, { name: string; canEdit: boolean }>();
  readonly events = new Map<string, MockEvent>();
  readonly requests: MockRequest[] = [];
  /** Runs once, just before the next PATCH, DELETE or event POST is applied. */
  beforeWrite: (() => void) | undefined;
  private counter = 0;

  addCalendar(id: string, name: string, canEdit = true): void { this.calendars.set(id, { name, canEdit }); }

  private next(prefix: string): string { return `${prefix}${++this.counter}`; }

  touch(item: { changeKey: string; etag: string }): void {
    item.changeKey = this.next('ck');
    item.etag = `W/"${item.changeKey}"`;
  }

  add(calendarId: string, input: EventInput): MockEvent {
    const id = this.next('AAMk-evt-');
    const event: MockEvent = { id, calendarId, iCalUId: `040000008200E00074C5B7101A82E008${this.counter}`, changeKey: '', etag: '',
      type: input.recurrence ? 'seriesMaster' : 'singleInstance', subject: input.subject, body: input.body ?? '', location: input.location ?? '',
      start: parseTime(input.start), end: parseTime(input.end), isAllDay: input.isAllDay ?? false, isCancelled: input.isCancelled ?? false,
      recurrence: input.recurrence ?? null, attendees: input.attendees ?? [], exceptions: new Map(), cancelled: new Set() };
    this.touch(event);
    this.events.set(id, event);
    return event;
  }

  update(event: MockEvent | MockException, fields: Partial<Pick<MockEvent, 'subject' | 'body' | 'location'>>): void {
    Object.assign(event, fields);
    this.touch(event);
  }

  private zoneOfSeries(event: MockEvent): string {
    return zoneOf((event.recurrence?.range as Json | undefined)?.recurrenceTimeZone as string | undefined || event.start.zone);
  }

  /** Start of the occurrence of a series on a day. */
  occurrenceStart(event: MockEvent, day: string): number {
    const zone = this.zoneOfSeries(event);
    const w = wallClock(event.start.ms, zone);
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return wallToInstant(y, m, d, w[3], w[4], w[5], zone);
  }

  addException(event: MockEvent, day: string, fields: Partial<EventInput>): MockException {
    const originalStart = this.occurrenceStart(event, day);
    const length = event.end.ms - event.start.ms;
    const exception: MockException = { id: this.next('AAMk-exc-'), iCalUId: `${event.iCalUId}-${day}`, changeKey: '', etag: '', date: day,
      originalStart, subject: fields.subject ?? event.subject, body: fields.body ?? event.body, location: fields.location ?? event.location,
      start: fields.start ? parseTime(fields.start) : { ms: originalStart, zone: event.start.zone },
      end: fields.end ? parseTime(fields.end) : { ms: originalStart + length, zone: event.start.zone }, isAllDay: event.isAllDay };
    this.touch(exception);
    event.exceptions.set(day, exception);
    this.touch(event);
    return exception;
  }

  cancelOccurrence(event: MockEvent, day: string): void {
    event.exceptions.delete(day);
    event.cancelled.add(day);
    this.touch(event);
  }

  /** Days of the occurrences of a series (daily, and weekly every week), cancelled ones included. */
  occurrenceDays(event: MockEvent): string[] {
    const pattern = (event.recurrence?.pattern ?? {}) as Json;
    const range = (event.recurrence?.range ?? {}) as Json;
    const zone = this.zoneOfSeries(event);
    const first = dayOf(event.start.ms, zone);
    const out: string[] = [];
    for (let k = 0; k < 800; k++) {
      const day = shiftCalendarDay(first, k);
      if (range.type === 'endDate' && day > String(range.endDate)) break;
      const weekday = days[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;
      const matches = pattern.type === 'daily' ? k % Number(pattern.interval ?? 1) === 0
        : pattern.type === 'weekly' ? (pattern.daysOfWeek as string[]).includes(weekday) : k === 0;
      if (!matches) continue;
      out.push(day);
      if (range.type === 'numbered' && out.length >= Number(range.numberOfOccurrences)) break;
    }
    return out;
  }

  private find(id: string): { event: MockEvent; exception?: MockException; day?: string } | null {
    const event = this.events.get(id);
    if (event) return { event };
    for (const master of this.events.values()) {
      for (const exception of master.exceptions.values()) if (exception.id === id) return { event: master, exception };
    }
    const match = /^occ\.(.+)\.(\d{4}-\d{2}-\d{2})$/.exec(id);
    const master = match ? this.events.get(match[1]!) : undefined;
    if (master && match && this.occurrenceDays(master).includes(match[2]!) && !master.cancelled.has(match[2]!) && !master.exceptions.has(match[2]!)) {
      return { event: master, day: match[2]! };
    }
    return null;
  }

  private view(event: MockEvent, expand: boolean): Json {
    return { '@odata.etag': event.etag, id: event.id, iCalUId: event.iCalUId, changeKey: event.changeKey, type: event.type,
      isCancelled: event.isCancelled, subject: event.subject, body: { contentType: 'text', content: event.body },
      location: { displayName: event.location }, start: utcOut(event.start), end: utcOut(event.end), isAllDay: event.isAllDay,
      originalStartTimeZone: event.start.zone, originalStart: null, occurrenceId: null, recurrence: event.recurrence,
      attendees: event.attendees, organizer: { emailAddress: { name: 'Alice', address: 'alice@example.test' } },
      ...(expand && event.type === 'seriesMaster' ? {
        exceptionOccurrences: [...event.exceptions.values()].map(exception => this.exceptionView(event, exception)),
        cancelledOccurrences: [...event.cancelled].map(day => `OID.${event.id}.${day}`),
      } : {}) };
  }

  private exceptionView(master: MockEvent, exception: MockException): Json {
    return { '@odata.etag': exception.etag, id: exception.id, iCalUId: exception.iCalUId, changeKey: exception.changeKey, type: 'exception',
      isCancelled: false, subject: exception.subject, body: { contentType: 'text', content: exception.body },
      location: { displayName: exception.location }, start: utcOut(exception.start), end: utcOut(exception.end), isAllDay: exception.isAllDay,
      originalStartTimeZone: exception.start.zone, originalStart: `${instantText(exception.originalStart)}`,
      occurrenceId: `OID.${master.id}.${exception.date}`, recurrence: null, attendees: [], organizer: null };
  }

  private occurrenceView(master: MockEvent, day: string): Json {
    const start = this.occurrenceStart(master, day);
    const length = master.end.ms - master.start.ms;
    return { id: `occ.${master.id}.${day}`, type: 'occurrence', isAllDay: master.isAllDay, start: utcOut({ ms: start, zone: 'UTC' }),
      end: utcOut({ ms: start + length, zone: 'UTC' }), originalStart: instantText(start), originalStartTimeZone: master.start.zone,
      occurrenceId: `OID.${master.id}.${day}` };
  }

  private apply(target: MockEvent | MockException, body: Json): void {
    if (typeof body.subject === 'string') target.subject = body.subject;
    if (body.body && typeof body.body === 'object') target.body = String((body.body as Json).content ?? '');
    if (body.location && typeof body.location === 'object') target.location = String((body.location as Json).displayName ?? '');
    if (body.start) target.start = parseTime(body.start as GraphTimeInput);
    if (body.end) target.end = parseTime(body.end as GraphTimeInput);
    if (typeof body.isAllDay === 'boolean') target.isAllDay = body.isAllDay;
    if ('recurrence' in body && 'recurrence' in target) {
      target.recurrence = (body.recurrence as Json | null) ?? null;
      target.type = target.recurrence ? 'seriesMaster' : 'singleInstance';
    }
  }

  readonly transport = async (request: DavRequest): Promise<DavResponse> => this.handle(request, false);

  private reply(request: DavRequest, status: number, body?: unknown): DavResponse {
    return { status, url: request.url, headers: { 'content-type': 'application/json' },
      body: Buffer.from(body === undefined ? '' : JSON.stringify(body)) };
  }

  private async handle(request: DavRequest, batched: boolean): Promise<DavResponse> {
    const header = (name: string) => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (header('Authorization') !== `Bearer ${this.token}`) return this.reply(request, 401, { error: { code: 'InvalidAuthenticationToken' } });
    const text = request.url.toString();
    if (!text.startsWith(graphBase)) return this.reply(request, 404);
    const path = request.url.pathname.slice(new URL(graphBase).pathname.length);
    const body = request.body ? JSON.parse(request.body) as Json : undefined;
    this.requests.push({ method: request.method, path, query: request.url.searchParams, body, ifMatch: header('If-Match'), prefer: header('Prefer'), batched });
    const parts = path.split('/').map(decodeURIComponent);
    const method = request.method;

    if (method === 'POST' && path === '$batch') {
      const responses = [];
      for (const inner of (body?.requests ?? []) as { id: string; method: string; url: string; headers?: Record<string, string> }[]) {
        const answer = await this.handle({ method: inner.method, url: new URL(inner.url.replace(/^\//, ''), graphBase), followRedirects: false,
          headers: { ...request.headers, ...(inner.headers ?? {}) } }, true);
        const raw = answer.body.toString('utf8');
        responses.push({ id: inner.id, status: answer.status, headers: {}, body: raw ? JSON.parse(raw) : undefined });
      }
      return this.reply(request, 200, { responses });
    }
    if (parts[0] !== 'me') return this.reply(request, 404);

    if (parts[1] === 'calendars') {
      if (parts.length === 2 && method === 'GET') {
        return this.reply(request, 200, { value: [...this.calendars].map(([id, c]) => ({ id, name: c.name, canEdit: c.canEdit, hexColor: '' })) });
      }
      const calendar = this.calendars.get(parts[2] ?? '');
      if (!calendar) return this.reply(request, 404, { error: { code: 'ErrorItemNotFound' } });
      if (parts.length === 3 && method === 'GET') return this.reply(request, 200, { id: parts[2], name: calendar.name, canEdit: calendar.canEdit });
      if (parts[3] === 'events' && parts.length === 4 && method === 'GET') {
        const top = Math.min(Number(request.url.searchParams.get('$top') ?? 10), this.pageSize);
        const skip = Number(request.url.searchParams.get('$skiptoken') ?? 0);
        const all = [...this.events.values()].filter(e => e.calendarId === parts[2]);
        const page = all.slice(skip, skip + top);
        const nextUrl = new URL(request.url);
        nextUrl.searchParams.set('$skiptoken', String(skip + top));
        return this.reply(request, 200, { value: page.map(e => this.view(e, false)),
          ...(skip + top < all.length ? { '@odata.nextLink': nextUrl.toString() } : {}) });
      }
      if (parts[3] === 'events' && parts.length === 4 && method === 'POST') {
        if (!calendar.canEdit) return this.reply(request, 403, { error: { code: 'ErrorAccessDenied' } });
        this.beforeWrite?.(); this.beforeWrite = undefined;
        const input = body as unknown as EventInput & { body?: { content?: string }; location?: { displayName?: string } };
        const created = this.add(parts[2]!, { subject: String(input.subject ?? ''), start: input.start, end: input.end, isAllDay: input.isAllDay === true,
          body: input.body?.content ?? '', location: input.location?.displayName ?? '', recurrence: (input.recurrence as Json | undefined) ?? null });
        return this.reply(request, 201, this.view(created, false));
      }
      return this.reply(request, 405);
    }

    if (parts[1] === 'events' && parts[2]) {
      const found = this.find(parts[2]);
      if (!found) return this.reply(request, 404, { error: { code: 'ErrorItemNotFound' } });
      const { event, exception, day } = found;
      if (parts[3] === 'instances' && method === 'GET') {
        if (exception || day || event.type !== 'seriesMaster') return this.reply(request, 400);
        const from = Date.parse(request.url.searchParams.get('startDateTime') ?? '');
        const to = Date.parse(request.url.searchParams.get('endDateTime') ?? '');
        const value: Json[] = [];
        for (const d of this.occurrenceDays(event)) {
          if (event.cancelled.has(d)) continue;
          const changed = event.exceptions.get(d);
          const start = changed ? changed.start.ms : this.occurrenceStart(event, d);
          const end = changed ? changed.end.ms : start + (event.end.ms - event.start.ms);
          if (start < to && end > from) value.push(changed ? this.exceptionView(event, changed) : this.occurrenceView(event, d));
        }
        return this.reply(request, 200, { value });
      }
      if (parts.length !== 3) return this.reply(request, 400);
      const current = exception ?? (day ? null : event);
      if (method === 'GET') {
        if (day) return this.reply(request, 200, this.occurrenceView(event, day));
        if (exception) return this.reply(request, 200, this.exceptionView(event, exception));
        const expand = (request.url.searchParams.get('$expand') ?? '').includes('exceptionOccurrences');
        return this.reply(request, 200, this.view(event, expand));
      }
      if (method === 'PATCH' || method === 'DELETE') {
        this.beforeWrite?.(); this.beforeWrite = undefined;
        const ifMatch = header('If-Match');
        if (ifMatch && current && ifMatch !== current.etag) return this.reply(request, 412, { error: { code: 'ErrorIrresolvableConflict' } });
        if (method === 'DELETE') {
          if (exception) this.cancelOccurrence(event, exception.date);
          else if (day) this.cancelOccurrence(event, day);
          else this.events.delete(event.id);
          return this.reply(request, 204);
        }
        if (!current) return this.reply(request, 400);
        this.apply(current, body ?? {});
        this.touch(current);
        return this.reply(request, 200, exception ? this.exceptionView(event, exception) : this.view(event, false));
      }
    }
    return this.reply(request, 405);
  }

  /** Writes recorded since `from`. */
  writes(from = 0): MockRequest[] {
    return this.requests.slice(from).filter(r => r.method === 'PATCH' || r.method === 'DELETE' || (r.method === 'POST' && r.path !== '$batch'));
  }
}
