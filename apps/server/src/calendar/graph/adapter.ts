import { calendarEventLimit, type CalDavCalendarOption } from '@nbase/contracts';
import { CalDavError, davErrorCode, normalizeColor, type CalendarState, type DavResponse, type RemoteEtag, type RemoteResource } from '../caldav/client.js';
import { bearerTransport, type BearerAuth, type HttpTransport, type RemoteCalendar, type RemoteWriteResult } from '../remote.js';
import { isGraphEvent, isOccurrenceAt, planCreate, planUpdate, synthesize, windowsZone, type GraphEvent, type GraphResource } from './convert.js';

/** Microsoft Graph v1.0 behind the RemoteCalendar interface; see docs/architecture/calendar.md (三期). */
export interface GraphOptions {
  transport: HttpTransport;
  auth: BearerAuth;
  /** IANA zone for new all-day events (the workspace zone); UTC without one. */
  timeZone?: string;
}

export const graphBase = 'https://graph.microsoft.com/v1.0/';

/** Absolute URL of a Graph calendar, as stored in caldav_json.calendarUrl. */
export function graphCalendarUrl(id: string): string {
  return `${graphBase}me/calendars/${encodeURIComponent(id)}/`;
}

/** Address of the resource of a series or single event. */
export function graphEventUrl(id: string): string {
  return `${graphBase}me/events/${encodeURIComponent(id)}`;
}

/** One authenticated Graph request. 401 (after one renewal) is AUTH_FAILED; transport failures keep their code. */
async function graphSend(options: GraphOptions, method: string, url: URL, body?: unknown, headers: Record<string, string> = {}): Promise<DavResponse> {
  const send = bearerTransport(options.transport, options.auth);
  let response: DavResponse;
  try {
    response = await send({ method, url, followRedirects: false,
      headers: { Accept: 'application/json', 'User-Agent': 'NBase-Calendar/1.0', ...headers,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    if (error instanceof CalDavError) throw error;
    throw new CalDavError(davErrorCode(error));
  }
  if (response.status === 401) throw new CalDavError('AUTH_FAILED');
  return response;
}

function jsonOf(response: DavResponse): unknown {
  try { return JSON.parse(response.body.toString('utf8')); } catch { throw new CalDavError('FETCH_FAILED'); }
}

const success = (status: number) => status >= 200 && status < 300;
const gone = (status: number) => status === 404 || status === 410;

/** Failure of a read: 403 is a missing permission, everything else not 2xx a failed fetch. */
function checkRead(response: DavResponse): void {
  if (response.status === 403) throw new CalDavError('AUTH_FAILED');
  if (!success(response.status)) throw new CalDavError('FETCH_FAILED');
}

/** Exchange answers a changed item with 409 (ErrorIrresolvableConflict) as well as 412. */
const writeStatus = (status: number) => status === 409 ? 412 : status;

interface GraphCalendar { id?: unknown; name?: unknown; hexColor?: unknown; canEdit?: unknown }

const prefer = 'outlook.timezone="UTC", outlook.body-content-type="text"';
const eventFields = 'id,iCalUId,changeKey,type,isCancelled,subject,body,location,start,end,isAllDay,originalStartTimeZone,originalStart,'
  + 'occurrenceId,recurrence,attendees,organizer';
const masterQuery = `$select=${eventFields},exceptionOccurrences,cancelledOccurrences&$expand=exceptionOccurrences`;
const pageSize = 100;
/** JSON batching takes at most 20 requests. */
const batchSize = 20;
const instanceWindowMs = 2 * 86400000;

function calendarIdOf(calendar: URL | string): string | null {
  const text = calendar.toString();
  const prefix = `${graphBase}me/calendars/`;
  if (!text.startsWith(prefix)) return null;
  const segment = text.slice(prefix.length).split('/')[0] ?? '';
  try { return decodeURIComponent(segment) || null; } catch { return null; }
}

function calendarId(calendar: URL): string {
  const id = calendarIdOf(calendar);
  if (!id) throw new CalDavError('CALENDAR_NOT_FOUND');
  return id;
}

function eventIdOf(href: string): string | null {
  const prefix = `${graphBase}me/events/`;
  if (!href.startsWith(prefix)) return null;
  const segment = href.slice(prefix.length);
  if (!segment || segment.includes('/') || segment.includes('?')) return null;
  try { return decodeURIComponent(segment); } catch { return null; }
}

const listed = (event: GraphEvent) => !event.isCancelled && (event.type === 'singleInstance' || event.type === 'seriesMaster');

/**
 * One run's view of a Graph calendar. Events read while listing are kept for `fetchResources` of the same
 * run; `get`, `put` and `delete` always read again. There is no delta query in v1.0 without a time window,
 * so every run lists the calendar and reads each series with its changed and cancelled occurrences.
 */
class GraphCalendarClient implements RemoteCalendar {
  private readonly loaded = new Map<string, GraphEvent>();

  constructor(private readonly options: GraphOptions) {}

  private send(method: string, url: string | URL, body?: unknown, headers: Record<string, string> = {}): Promise<DavResponse> {
    return graphSend(this.options, method, typeof url === 'string' ? new URL(url) : url, body, { Prefer: prefer, ...headers });
  }

  private allDayZone(): string {
    return (this.options.timeZone && windowsZone(this.options.timeZone)) || 'UTC';
  }

  async calendarState(calendar: URL): Promise<CalendarState> {
    const response = await this.send('GET', `${graphBase}me/calendars/${encodeURIComponent(calendarId(calendar))}?$select=id,canEdit`);
    if (gone(response.status)) throw new CalDavError('CALENDAR_NOT_FOUND');
    checkRead(response);
    const data = jsonOf(response) as GraphCalendar;
    return { ctag: null, syncToken: null, writable: data.canEdit === true };
  }

  async syncChanges(): Promise<null> {
    return null;
  }

  private async getOne(path: string): Promise<GraphEvent | null> {
    const response = await this.send('GET', `${graphBase}${path}`);
    if (gone(response.status)) return null;
    checkRead(response);
    const data = jsonOf(response);
    if (!isGraphEvent(data)) throw new CalDavError('FETCH_FAILED');
    return data;
  }

  /** GETs of relative paths, batched; answers a batch does not give are asked one by one. Null for gone events. */
  private async getMany(paths: string[]): Promise<(GraphEvent | null)[]> {
    const out: (GraphEvent | null | undefined)[] = paths.map(() => undefined);
    for (let i = 0; i < paths.length; i += batchSize) {
      const chunk = paths.slice(i, i + batchSize);
      if (chunk.length > 1) {
        const response = await this.send('POST', `${graphBase}$batch`,
          { requests: chunk.map((path, n) => ({ id: String(n), method: 'GET', url: `/${path}`, headers: { Prefer: prefer } })) });
        let answers: unknown = null;
        if (success(response.status)) { try { answers = (JSON.parse(response.body.toString('utf8')) as { responses?: unknown }).responses; } catch { answers = null; } }
        for (const answer of Array.isArray(answers) ? answers : []) {
          const { id, status, body } = (answer ?? {}) as { id?: unknown; status?: unknown; body?: unknown };
          const n = Number(id);
          if (!Number.isInteger(n) || n < 0 || n >= chunk.length || typeof status !== 'number') continue;
          if (gone(status)) out[i + n] = null;
          else if (success(status) && isGraphEvent(body)) out[i + n] = body;
        }
      }
      for (let n = 0; n < chunk.length; n++) if (out[i + n] === undefined) out[i + n] = await this.getOne(chunk[n]!);
    }
    return out as (GraphEvent | null)[];
  }

  /** The current state of a series or single event, with a series' changed and cancelled occurrences. */
  private async fresh(id: string): Promise<GraphEvent | null> {
    const path = `me/events/${encodeURIComponent(id)}`;
    const plain = await this.getOne(`${path}?$select=${eventFields}`);
    // Changed and cancelled occurrences are only returned when a series master is read by its ID.
    const event = plain?.type === 'seriesMaster' ? await this.getOne(`${path}?${masterQuery}`) : plain;
    if (!event || !listed(event)) { this.loaded.delete(id); return null; }
    this.loaded.set(id, event);
    return event;
  }

  async listEtags(calendar: URL): Promise<RemoteEtag[]> {
    const items: GraphEvent[] = [];
    let next: URL | null = new URL(`${graphBase}me/calendars/${encodeURIComponent(calendarId(calendar))}/events?$select=${eventFields}&$top=${pageSize}`);
    while (next && items.length <= calendarEventLimit) {
      const response = await this.send('GET', next);
      if (gone(response.status)) throw new CalDavError('CALENDAR_NOT_FOUND');
      checkRead(response);
      const data = jsonOf(response) as { value?: unknown; '@odata.nextLink'?: unknown };
      for (const item of Array.isArray(data.value) ? data.value : []) if (isGraphEvent(item) && listed(item)) items.push(item);
      const link = data['@odata.nextLink'];
      if (link !== undefined && (typeof link !== 'string' || !link.startsWith(graphBase))) throw new CalDavError('FETCH_FAILED');
      next = typeof link === 'string' ? new URL(link) : null;
    }
    // More events than a calendar may have: the engine stops with ROW_LIMIT, without reading each series.
    if (items.length > calendarEventLimit) return items.map(item => ({ href: graphEventUrl(item.id), etag: null }));
    const masters = items.filter(item => item.type === 'seriesMaster');
    const expanded = await this.getMany(masters.map(item => `me/events/${encodeURIComponent(item.id)}?${masterQuery}`));
    const series = new Map(masters.map((item, n) => [item.id, expanded[n] ?? null]));
    const out: RemoteEtag[] = [];
    for (const item of items) {
      const event = item.type === 'seriesMaster' ? series.get(item.id) : item;
      if (!event || !listed(event)) continue;
      const resource = synthesize(event);
      if (!resource) continue;
      this.loaded.set(item.id, event);
      out.push({ href: graphEventUrl(item.id), etag: resource.etag });
    }
    return out;
  }

  async fetchResources(_calendar: URL, hrefs: string[]): Promise<{ found: RemoteResource[]; missing: string[] }> {
    const found: RemoteResource[] = [];
    const missing: string[] = [];
    for (const href of hrefs) {
      const id = eventIdOf(href);
      const known = id ? this.loaded.get(id) : undefined;
      const resource = known ? synthesize(known) : null;
      if (resource) { found.push({ href, etag: resource.etag, body: resource.text }); continue; }
      const read = id ? await this.get(href) : null;
      if (read) found.push(read); else missing.push(href);
    }
    return { found, missing };
  }

  async get(href: string): Promise<RemoteResource | null> {
    const id = eventIdOf(href);
    const event = id ? await this.fresh(id) : null;
    const resource = event ? synthesize(event) : null;
    return resource ? { href, etag: resource.etag, body: resource.text } : null;
  }

  /** Cancels the occurrence of a series that starts at `point`; an occurrence that is not there counts as done. */
  private async cancel(seriesId: string, point: string, allDay: boolean): Promise<number> {
    const at = allDay ? Date.parse(`${point}T00:00:00Z`) : Date.parse(point);
    const from = new Date(at - instanceWindowMs).toISOString();
    const to = new Date(at + instanceWindowMs + (allDay ? 86400000 : 0)).toISOString();
    const response = await this.send('GET', `${graphBase}me/events/${encodeURIComponent(seriesId)}/instances?startDateTime=${from}&endDateTime=${to}`
      + '&$select=id,type,start,end,isAllDay,originalStart,originalStartTimeZone,occurrenceId&$top=50');
    if (!success(response.status)) return writeStatus(response.status);
    const data = jsonOf(response) as { value?: unknown };
    const match = (Array.isArray(data.value) ? data.value : []).find(item => isGraphEvent(item) && isOccurrenceAt(item, point, allDay)) as GraphEvent | undefined;
    if (!match) return 200;
    const removed = await this.send('DELETE', graphEventUrl(match.id));
    return success(removed.status) || gone(removed.status) ? 200 : writeStatus(removed.status);
  }

  async put(href: string, text: string, condition: { ifMatch: string } | { ifNoneMatch: '*' }): Promise<RemoteWriteResult> {
    if ('ifNoneMatch' in condition) return this.create(href, text);
    const id = eventIdOf(href);
    const event = id ? await this.fresh(id) : null;
    if (!id || !event) return { status: 404, etag: null };
    const resource = synthesize(event);
    if (!resource || resource.etag !== condition.ifMatch) return { status: 412, etag: null };
    const writes = planUpdate(resource, text, this.allDayZone());
    if (!writes) return { status: 422, etag: null };
    const status = await this.apply(id, resource, writes);
    this.loaded.delete(id);
    // Graph changes its version on every write; without an ETag the engine reads the resource again next run.
    return { status, etag: null };
  }

  private async apply(id: string, resource: GraphResource, writes: NonNullable<ReturnType<typeof planUpdate>>): Promise<number> {
    let seriesPatched = false;
    for (const write of writes) {
      if (write.kind === 'patch') {
        // A series write may touch its changed occurrences too; their versions were checked with the resource's ETag.
        const condition = write.etag && !seriesPatched ? { 'If-Match': write.etag } : {};
        const response = await this.send('PATCH', graphEventUrl(write.id), write.body, condition);
        if (write.series) seriesPatched = true;
        if (gone(response.status) && !write.series) continue;
        if (!success(response.status)) return writeStatus(response.status);
      } else if (write.kind === 'delete') {
        const response = await this.send('DELETE', graphEventUrl(write.id), undefined, write.etag && !seriesPatched ? { 'If-Match': write.etag } : {});
        if (!success(response.status) && !gone(response.status)) return writeStatus(response.status);
      } else {
        const status = await this.cancel(resource.members[0]!.id, write.point, write.allDay);
        if (!success(status)) return status;
      }
    }
    return 200;
  }

  private async create(href: string, text: string): Promise<RemoteWriteResult> {
    const calendar = calendarIdOf(href);
    if (!calendar) return { status: 404, etag: null };
    const plan = planCreate(text, this.allDayZone());
    if (!plan) return { status: 422, etag: null };
    const response = await this.send('POST', `${graphBase}me/calendars/${encodeURIComponent(calendar)}/events`, plan.body);
    if (!success(response.status)) return { status: response.status, etag: null };
    const created = jsonOf(response);
    if (!isGraphEvent(created)) throw new CalDavError('FETCH_FAILED');
    // Cancelled occurrences of a new series are best effort: the next run reads the series as Graph keeps it.
    for (const item of plan.cancels) await this.cancel(created.id, item.point, item.allDay);
    return { status: 201, etag: null, href: graphEventUrl(created.id),
      ...(typeof created.iCalUId === 'string' && created.iCalUId ? { uid: created.iCalUId } : {}) };
  }

  async delete(href: string, etag: string | null): Promise<RemoteWriteResult> {
    const id = eventIdOf(href);
    const event = id ? await this.fresh(id) : null;
    if (!id || !event) return { status: 404, etag: null };
    if (etag !== null && synthesize(event)?.etag !== etag) return { status: 412, etag: null };
    const tag = event['@odata.etag'];
    const response = await this.send('DELETE', graphEventUrl(id), undefined, tag ? { 'If-Match': tag } : {});
    this.loaded.delete(id);
    return { status: writeStatus(response.status), etag: null };
  }
}

export function createGraphCalendar(options: GraphOptions): RemoteCalendar {
  return new GraphCalendarClient(options);
}

/** The signed-in account's calendars; `writable` is Graph's canEdit. */
export async function listGraphCalendars(options: GraphOptions): Promise<CalDavCalendarOption[]> {
  const calendars: CalDavCalendarOption[] = [];
  let next: URL | null = new URL(`${graphBase}me/calendars?$select=id,name,hexColor,canEdit&$top=100`);
  for (let page = 0; next && page < 20; page++) {
    const response = await graphSend(options, 'GET', next);
    if (response.status === 403) throw new CalDavError('AUTH_FAILED');
    if (response.status < 200 || response.status >= 300) throw new CalDavError('FETCH_FAILED');
    const data = jsonOf(response) as { value?: GraphCalendar[]; '@odata.nextLink'?: unknown };
    for (const item of Array.isArray(data.value) ? data.value : []) {
      if (typeof item.id !== 'string' || !item.id) continue;
      const name = typeof item.name === 'string' ? [...item.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()].slice(0, 100).join('') : '';
      calendars.push({ url: graphCalendarUrl(item.id), name: name || '日历',
        color: typeof item.hexColor === 'string' ? normalizeColor(item.hexColor) : null, writable: item.canEdit === true });
    }
    const link = data['@odata.nextLink'];
    next = typeof link === 'string' && link.startsWith(graphBase) ? new URL(link) : null;
  }
  return calendars;
}
