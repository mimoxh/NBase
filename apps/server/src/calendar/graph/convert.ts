import { createHash } from 'node:crypto';
import { formatRecurrenceRule, instantText, isCalendarDay, isTimeZoneName, parseDateCell, parseRecurrenceRule, shiftCalendarDay,
  wallClock, wallToInstant, type DateCell, type RecurrenceRule } from '@nbase/contracts';
import { parseIcs, type IcsEvent } from '../ics.js';
import { dateLines, escapeIcsText, foldLine } from '../icsWrite.js';
import { windowsZones } from '../windowsZones.js';

/**
 * Translation between Microsoft Graph v1.0 events and the iCalendar texts the sync engine works on
 * (docs/architecture/calendar.md, 三期). A series with its changed occurrences, or a single event, is one
 * resource; its text is synthesized here and never stored by Graph.
 */

export interface GraphDateTime { dateTime?: string | null; timeZone?: string | null }
export interface GraphPattern {
  type?: string | null; interval?: number | null; month?: number | null; dayOfMonth?: number | null; daysOfWeek?: string[] | null;
  firstDayOfWeek?: string | null; index?: string | null;
}
export interface GraphRange {
  type?: string | null; startDate?: string | null; endDate?: string | null; numberOfOccurrences?: number | null; recurrenceTimeZone?: string | null;
}
export interface GraphRecurrence { pattern?: GraphPattern | null; range?: GraphRange | null }
interface GraphPerson { emailAddress?: { name?: string | null; address?: string | null } | null }

export interface GraphEvent {
  id: string;
  '@odata.etag'?: string;
  iCalUId?: string | null;
  changeKey?: string | null;
  type?: string | null;
  isCancelled?: boolean | null;
  subject?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  location?: { displayName?: string | null } | null;
  start?: GraphDateTime | null;
  end?: GraphDateTime | null;
  isAllDay?: boolean | null;
  originalStartTimeZone?: string | null;
  originalStart?: string | null;
  occurrenceId?: string | null;
  recurrence?: GraphRecurrence | null;
  attendees?: GraphPerson[] | null;
  organizer?: GraphPerson | null;
  exceptionOccurrences?: GraphEvent[] | null;
  cancelledOccurrences?: string[] | null;
}

export function isGraphEvent(value: unknown): value is GraphEvent {
  const id = typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.length > 0;
}

// ---------------------------------------------------------------------------------------------------------
// Time zones and times

const windowsLookup = new Map(Object.entries(windowsZones).map(([name, zone]) => [name.toLowerCase(), zone]));
const windowsNames = new Map<string, string>();
for (const [name, zone] of Object.entries(windowsZones)) if (!windowsNames.has(zone)) windowsNames.set(zone, name);
const utcZones = new Set(['utc', 'etc/utc', 'etc/gmt', 'gmt', 'etc/universal', 'etc/zulu', 'zulu', 'universal', 'uct', 'etc/uct']);

/** IANA zone of a Graph zone name (Windows or IANA); null for UTC and for names it does not know. */
export function ianaZone(name: string | null | undefined): string | null {
  const text = name?.trim();
  if (!text) return null;
  const zone = windowsLookup.get(text.toLowerCase()) ?? text;
  return isTimeZoneName(zone) && !utcZones.has(zone.toLowerCase()) ? zone : null;
}

/** The Windows name to write for an IANA zone, or null when there is none. */
export function windowsZone(zone: string): string | null {
  if (utcZones.has(zone.toLowerCase())) return 'UTC';
  return windowsNames.get(zone) ?? null;
}

type Wall = [number, number, number, number, number, number];
const graphTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const dayText = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const graphWall = (w: Wall) => `${dayText(w[0], w[1], w[2])}T${pad(w[3])}:${pad(w[4])}:${pad(w[5])}`;

function splitTime(text: string | null | undefined): { wall: Wall; offset: number | null } | null {
  const match = graphTimePattern.exec((text ?? '').trim());
  if (!match) return null;
  const wall = [1, 2, 3, 4, 5, 6].map(i => Number(match[i] ?? 0)) as Wall;
  if (!isCalendarDay(dayText(wall[0], wall[1], wall[2])) || wall[3] > 23 || wall[4] > 59 || wall[5] > 59) return null;
  const zone = match[7]?.toUpperCase();
  const offset = !zone ? null : zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return { wall, offset };
}

/** The moment a Graph dateTimeTimeZone names; names it does not know count as UTC. */
function instantOf(value: GraphDateTime | null | undefined): number | null {
  const parsed = splitTime(value?.dateTime);
  if (!parsed) return null;
  const [y, m, d, h, mi, s] = parsed.wall;
  if (parsed.offset !== null) return Date.UTC(y, m - 1, d, h, mi, s) - parsed.offset * 60000;
  const zone = ianaZone(value?.timeZone);
  return zone ? wallToInstant(y, m, d, h, mi, s, zone) : Date.UTC(y, m - 1, d, h, mi, s);
}

/**
 * The day of an all-day boundary. Graph may answer all-day times unconverted (midnight) or converted to
 * the requested zone; a time other than midnight is taken back into the event's own zone.
 */
function dayOf(value: GraphDateTime | null | undefined, zone: string | null): string | null {
  const parsed = splitTime(value?.dateTime);
  if (!parsed) return null;
  const [y, m, d, h, mi, s] = parsed.wall;
  if (parsed.offset === null && h === 0 && mi === 0 && s === 0) return dayText(y, m, d);
  const w = wallClock(instantOf(value)!, zone ?? 'UTC');
  return dayText(w[0], w[1], w[2]);
}

/** The zone an event's times are written in: the recurrence zone of a series, else the zone it was created in. */
function eventZone(event: GraphEvent, series: boolean): string | null {
  const name = (series ? event.recurrence?.range?.recurrenceTimeZone : null) || event.originalStartTimeZone;
  return ianaZone(name);
}

/** Start and end of one event as a date cell, without recurrence. */
function timing(event: GraphEvent, zone: string | null): DateCell | null {
  if (event.isAllDay) {
    const start = dayOf(event.start, zone);
    if (!start) return null;
    const after = dayOf(event.end, zone);
    const last = after && after > start ? shiftCalendarDay(after, -1) : start;
    return { start, allDay: true, ...(last > start ? { end: last } : {}) };
  }
  const start = instantOf(event.start);
  if (start === null) return null;
  const end = instantOf(event.end);
  return { start: instantText(start), allDay: false, ...(end !== null && end > start + 999 ? { end: instantText(end) } : {}),
    ...(zone ? { timeZone: zone } : {}) };
}

// ---------------------------------------------------------------------------------------------------------
// Recurrence

/** Graph day names; index 0 is Monday, as in RecurrenceRule. */
const graphDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const weekIndexes: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };
const indexNames = new Map(Object.entries(weekIndexes).map(([name, n]) => [n, name]));

function startWall(cell: DateCell, zone: string | null): Wall {
  if (cell.allDay) { const [y, m, d] = cell.start.split('-').map(Number) as [number, number, number]; return [y, m, d, 0, 0, 0]; }
  return wallClock(Date.parse(cell.start), zone ?? 'UTC');
}

/** RRULE text of a patterned recurrence for a series starting at `cell`, or null when it has no such form. */
export function recurrenceRule(recurrence: GraphRecurrence, cell: DateCell, zone: string | null): string | null {
  const pattern = recurrence.pattern;
  const range = recurrence.range;
  if (!pattern || !range) return null;
  const interval = Number.isInteger(pattern.interval) && pattern.interval! >= 1 ? pattern.interval! : 1;
  const days = [...new Set((pattern.daysOfWeek ?? []).map(day => graphDays.indexOf(String(day).toLowerCase())).filter(day => day >= 0))];
  const rule: RecurrenceRule = { freq: 'DAILY', interval, weekStart: 0 };
  const dayOfMonth = () => Number.isInteger(pattern.dayOfMonth) && pattern.dayOfMonth! >= 1 && pattern.dayOfMonth! <= 31 ? pattern.dayOfMonth! : null;
  const month = () => Number.isInteger(pattern.month) && pattern.month! >= 1 && pattern.month! <= 12 ? pattern.month! : null;
  const relative = (): boolean => {
    const nth = weekIndexes[(pattern.index ?? 'first').toLowerCase()];
    if (nth === undefined || !days.length) return false;
    // Several days with an index mean the nth of all those days in the month, which is BYSETPOS.
    if (days.length === 1) rule.byDay = [{ day: days[0]!, nth }];
    else { rule.byDay = days.map(day => ({ day })); rule.bySetPos = [nth]; }
    return true;
  };
  switch (pattern.type) {
    case 'daily': break;
    case 'weekly': {
      if (!days.length) return null;
      rule.freq = 'WEEKLY';
      rule.byDay = days.map(day => ({ day }));
      const first = graphDays.indexOf((pattern.firstDayOfWeek ?? 'sunday').toLowerCase());
      rule.weekStart = first >= 0 ? first : 6;
      break;
    }
    case 'absoluteMonthly': {
      const day = dayOfMonth();
      if (day === null) return null;
      Object.assign(rule, { freq: 'MONTHLY', byMonthDay: [day] });
      break;
    }
    case 'relativeMonthly':
      rule.freq = 'MONTHLY';
      if (!relative()) return null;
      break;
    case 'absoluteYearly': {
      const day = dayOfMonth();
      const m = month();
      if (day === null || m === null) return null;
      Object.assign(rule, { freq: 'YEARLY', byMonth: [m], byMonthDay: [day] });
      break;
    }
    case 'relativeYearly': {
      const m = month();
      if (m === null) return null;
      Object.assign(rule, { freq: 'YEARLY', byMonth: [m] });
      if (!relative()) return null;
      break;
    }
    default: return null;
  }
  if (range.type === 'numbered') {
    const count = range.numberOfOccurrences;
    if (!Number.isInteger(count) || count! < 1) return null;
    rule.count = count!;
  } else if (range.type === 'endDate') {
    const end = range.endDate ?? '';
    if (!isCalendarDay(end)) return null;
    if (cell.allDay) rule.until = end;
    else {
      const [y, m, d] = end.split('-').map(Number) as [number, number, number];
      rule.until = instantText(wallToInstant(y, m, d, 23, 59, 59, zone ?? 'UTC'));
    }
  }
  const text = formatRecurrenceRule(rule);
  return parseRecurrenceRule(text, cell.allDay) ? text : null;
}

interface Placement { start: GraphDateTime; end: GraphDateTime; isAllDay: boolean; zone: string | null; zoneName: string }

/**
 * Graph times for a cell. Timed values go in the Windows zone of their IANA zone, or in UTC when it has
 * none; all-day values at midnight in `allDayZone`, with the end day exclusive.
 */
function place(cell: DateCell, allDayZone: string): Placement {
  if (cell.allDay) {
    return { start: { dateTime: `${cell.start}T00:00:00`, timeZone: allDayZone },
      end: { dateTime: `${shiftCalendarDay(cell.end ?? cell.start, 1)}T00:00:00`, timeZone: allDayZone }, isAllDay: true, zone: null,
      zoneName: allDayZone };
  }
  const iana = ianaZone(cell.timeZone);
  const name = iana ? windowsZone(iana) : null;
  const zone = name ? iana : null;
  const at = (instant: string) => ({ dateTime: graphWall(wallClock(Date.parse(instant), zone ?? 'UTC')), timeZone: name ?? 'UTC' });
  return { start: at(cell.start), end: at(cell.end ?? cell.start), isAllDay: false, zone, zoneName: name ?? 'UTC' };
}

/**
 * Patterned recurrence of a series value: the RRULE subset Graph can express. Null for anything else
 * (several month days, BYSETPOS beyond -1..4, BYMONTH on a monthly rule, ...).
 */
export function graphRecurrence(cell: DateCell, placement: Pick<Placement, 'zone' | 'zoneName'>): GraphRecurrence | null {
  if (!cell.rrule) return null;
  const rule = parseRecurrenceRule(cell.rrule, cell.allDay);
  if (!rule) return null;
  const wall = startWall(cell, placement.zone);
  const startDate = dayText(wall[0], wall[1], wall[2]);
  const weekday = (new Date(Date.UTC(wall[0], wall[1] - 1, wall[2])).getUTCDay() + 6) % 7;
  const plainDays = rule.byDay?.every(w => w.nth === undefined) ?? true;
  const pattern: GraphPattern = { interval: rule.interval };
  const relative = (): boolean => {
    const days = rule.byDay ?? [];
    if (days.length === 1 && days[0]!.nth !== undefined && !rule.bySetPos) {
      const index = indexNames.get(days[0]!.nth);
      if (!index) return false;
      Object.assign(pattern, { daysOfWeek: [graphDays[days[0]!.day]], index });
      return true;
    }
    if (days.length && plainDays && rule.bySetPos?.length === 1) {
      const index = indexNames.get(rule.bySetPos[0]!);
      if (!index) return false;
      Object.assign(pattern, { daysOfWeek: days.map(w => graphDays[w.day]), index });
      return true;
    }
    return false;
  };
  const monthly = (absolute: string, relativeType: string): boolean => {
    if (rule.byMonthDay) {
      if (rule.byDay || rule.bySetPos || rule.byMonthDay.length !== 1 || rule.byMonthDay[0]! < 1) return false;
      Object.assign(pattern, { type: absolute, dayOfMonth: rule.byMonthDay[0] });
      return true;
    }
    if (rule.byDay) { pattern.type = relativeType; return relative(); }
    if (rule.bySetPos) return false;
    Object.assign(pattern, { type: absolute, dayOfMonth: wall[2] });
    return true;
  };
  switch (rule.freq) {
    case 'DAILY':
      if (rule.byMonth || rule.byMonthDay || rule.bySetPos) return null;
      if (rule.byDay) {
        // Every day on some weekdays is a weekly rule, but only without an interval.
        if (rule.interval !== 1 || !plainDays) return null;
        Object.assign(pattern, { type: 'weekly', daysOfWeek: rule.byDay.map(w => graphDays[w.day]), firstDayOfWeek: graphDays[rule.weekStart] });
      } else pattern.type = 'daily';
      break;
    case 'WEEKLY':
      if (rule.byMonth || rule.byMonthDay || rule.bySetPos || !plainDays) return null;
      Object.assign(pattern, { type: 'weekly', daysOfWeek: (rule.byDay ?? [{ day: weekday }]).map(w => graphDays[w.day]),
        firstDayOfWeek: graphDays[rule.weekStart] });
      break;
    case 'MONTHLY':
      if (rule.byMonth || !monthly('absoluteMonthly', 'relativeMonthly')) return null;
      break;
    case 'YEARLY': {
      const months = rule.byMonth ?? [wall[1]];
      if (months.length !== 1 || !monthly('absoluteYearly', 'relativeYearly')) return null;
      pattern.month = months[0]!;
      break;
    }
  }
  const range: GraphRange = { type: 'noEnd', startDate, recurrenceTimeZone: placement.zoneName };
  if (rule.count !== undefined) Object.assign(range, { type: 'numbered', numberOfOccurrences: rule.count });
  else if (rule.until !== undefined) {
    let end: string;
    if (cell.allDay) end = rule.until;
    else {
      // UNTIL is a moment; Graph's end is the last day an occurrence may start on, at the series' wall time.
      const until = wallClock(Date.parse(rule.until), placement.zone ?? 'UTC');
      const day = dayText(until[0], until[1], until[2]);
      const reaches = until[3] * 3600 + until[4] * 60 + until[5] >= wall[3] * 3600 + wall[4] * 60 + wall[5];
      end = reaches ? day : shiftCalendarDay(day, -1);
    }
    Object.assign(range, { type: 'endDate', endDate: end < startDate ? startDate : end });
  }
  return { pattern, range };
}

// ---------------------------------------------------------------------------------------------------------
// Reading: one resource per series or single event

export interface GraphResource {
  uid: string;
  etag: string;
  text: string;
  /** Graph events by VEVENT position in `text`: the series or single event first, then its changed occurrences. */
  members: GraphEvent[];
  /** The series has a recurrence that has no RRULE form here; its times are not written back. */
  unsupported: boolean;
}

/** Day of an occurrence id (`OID.<series id>.<YYYY-MM-DD>`). */
function occurrenceDay(id: string | null | undefined): string | null {
  const match = /\.(\d{4}-\d{2}-\d{2})$/.exec(id ?? '');
  return match && isCalendarDay(match[1]) ? match[1]! : null;
}

/** Start of the occurrence of a series on a day: the series' wall time in its zone. */
function occurrenceOn(day: string, series: DateCell, zone: string | null): string {
  if (series.allDay) return day;
  const wall = startWall(series, zone);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return instantText(wallToInstant(y, m, d, wall[3], wall[4], wall[5], zone ?? 'UTC'));
}

function exceptionPoint(exception: GraphEvent, series: DateCell, zone: string | null): string | null {
  const original = exception.originalStart ? instantOf({ dateTime: exception.originalStart, timeZone: 'UTC' }) : null;
  const day = occurrenceDay(exception.occurrenceId);
  if (series.allDay) return day ?? (exception.originalStart ? dayOf({ dateTime: exception.originalStart, timeZone: 'UTC' }, zone) : null);
  if (original !== null) return instantText(original);
  return day ? occurrenceOn(day, series, zone) : null;
}

/** Version of a resource: the series' changeKey with those of its changed occurrences and the cancelled ones. */
export function graphEtag(event: GraphEvent): string {
  const key = (item: GraphEvent) => item.changeKey ?? item['@odata.etag'] ?? '';
  const parts: unknown[] = ['g1', key(event)];
  if (event.type === 'seriesMaster') {
    parts.push((event.exceptionOccurrences ?? []).filter(isGraphEvent).map(item => [item.id, key(item)])
      .sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
    parts.push([...(event.cancelledOccurrences ?? [])].filter(item => typeof item === 'string').sort());
  }
  return `"${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}"`;
}

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function plainBody(body: GraphEvent['body']): string {
  const content = body?.content ?? '';
  if ((body?.contentType ?? 'text').toLowerCase() !== 'html') return content;
  return content.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function personLine(name: string, person: GraphPerson | null | undefined): string {
  const display = (person?.emailAddress?.name ?? '').replace(/["\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  const address = (person?.emailAddress?.address ?? '').replace(/[\s;:,"<>\u0000-\u001f\u007f]/g, '').slice(0, 320) || 'unknown';
  return `${name}${display ? `;CN="${display}"` : ''}:mailto:${address}`;
}

function veventLines(uid: string, event: GraphEvent, cell: DateCell, recurrenceId: string | null, unsupported: boolean): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${uid}`];
  if (recurrenceId) lines.push(recurrenceId);
  lines.push(`SUMMARY:${escapeIcsText((event.subject ?? '').replace(controls, ''))}`, ...dateLines(cell, recurrenceId === null).lines);
  // Makes the reader report the rule as unsupported instead of silently reading a single event.
  if (unsupported) lines.push('RRULE:X-NBASE-UNSUPPORTED=1');
  const location = (event.location?.displayName ?? '').replace(controls, '');
  if (location.trim()) lines.push(`LOCATION:${escapeIcsText(location)}`);
  const description = plainBody(event.body).replace(controls, '');
  if (description.trim()) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  const attendees = (event.attendees ?? []).filter(item => item && typeof item === 'object');
  if (attendees.length) {
    if (event.organizer?.emailAddress?.address) lines.push(personLine('ORGANIZER', event.organizer));
    for (const attendee of attendees) lines.push(personLine('ATTENDEE', attendee));
  }
  lines.push('END:VEVENT');
  return lines;
}

const recurrenceLine = (point: string, allDay: boolean) => allDay ? `RECURRENCE-ID;VALUE=DATE:${point.replace(/-/g, '')}`
  : `RECURRENCE-ID:${point.replace(/[-:]/g, '')}`;

/**
 * The iCalendar resource of a series master (with `exceptionOccurrences` and `cancelledOccurrences`) or
 * a single event. Null for cancelled events, occurrences, and events without usable times.
 */
export function synthesize(event: GraphEvent): GraphResource | null {
  if (event.isCancelled || (event.type && event.type !== 'singleInstance' && event.type !== 'seriesMaster')) return null;
  const series = event.type === 'seriesMaster';
  const zone = eventZone(event, series);
  const cell = timing(event, zone);
  if (!cell) return null;
  const uid = (event.iCalUId ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim() || `graph-${event.id}`;
  let unsupported = false;
  const exceptions: { event: GraphEvent; cell: DateCell; point: string }[] = [];
  if (series) {
    const rule = event.recurrence ? recurrenceRule(event.recurrence, cell, zone) : null;
    if (rule) {
      cell.rrule = rule;
      const cancelled = (event.cancelledOccurrences ?? []).map(occurrenceDay).filter((day): day is string => day !== null)
        .map(day => occurrenceOn(day, cell, zone));
      if (cancelled.length) cell.exdates = [...new Set(cancelled)].sort();
      for (const item of event.exceptionOccurrences ?? []) {
        if (!isGraphEvent(item) || item.isCancelled) continue;
        const point = exceptionPoint(item, cell, zone);
        const own = timing(item, ianaZone(item.originalStartTimeZone));
        if (point && own) exceptions.push({ event: item, cell: own, point });
      }
      exceptions.sort((a, b) => a.point < b.point ? -1 : a.point > b.point ? 1 : 0);
    } else unsupported = true;
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NBase//Microsoft Graph//ZH', 'CALSCALE:GREGORIAN',
    ...veventLines(uid, event, cell, null, unsupported),
    ...exceptions.flatMap(item => veventLines(uid, item.event, item.cell, recurrenceLine(item.point, cell.allDay), false)),
    'END:VCALENDAR'];
  return { uid, etag: graphEtag(event), text: lines.map(foldLine).join('\r\n') + '\r\n',
    members: [event, ...exceptions.map(item => item.event)], unsupported };
}

// ---------------------------------------------------------------------------------------------------------
// Writing

export type GraphWrite =
  | { kind: 'patch'; id: string; etag: string | null; body: Record<string, unknown>; series: boolean }
  | { kind: 'delete'; id: string; etag: string | null }
  /** Removes the occurrence of the series that starts at `point`. */
  | { kind: 'cancel'; point: string; allDay: boolean };

const zoneKey = (cell: DateCell) => cell.allDay ? '' : ianaZone(cell.timeZone) ?? 'UTC';

/** The zone an all-day event keeps: its own when Graph named one we know, else the fallback. */
function allDayZoneOf(event: GraphEvent | null, fallback: string): string {
  const name = event?.originalStartTimeZone?.trim();
  if (name && (windowsLookup.has(name.toLowerCase()) || isTimeZoneName(name))) return name;
  return fallback;
}

function readEvents(text: string): IcsEvent[] | null {
  try { return parseIcs(text, { timeZone: 'UTC', details: true }).events; } catch { return null; }
}

/** Fields of `next` that differ from `current`, as a Graph PATCH body; null when they cannot be written. */
function changedFields(current: IcsEvent, next: IcsEvent, member: GraphEvent, series: boolean, unsupported: boolean,
  allDayZone: string): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (current.title !== next.title) body.subject = next.title;
  if (current.location !== next.location) body.location = { displayName: next.location };
  if (current.description !== next.description) body.body = { contentType: 'text', content: next.description };
  const before = parseDateCell(current.value);
  const after = parseDateCell(next.value);
  if (!before || !after) return null;
  const timesDiffer = before.start !== after.start || before.end !== after.end || before.allDay !== after.allDay || zoneKey(before) !== zoneKey(after);
  const ruleDiffers = series && (before.rrule ?? '') !== (after.rrule ?? '');
  if (!timesDiffer && !ruleDiffers) return body;
  if (series && unsupported) return null;
  const placement = place(after, allDayZoneOf(member, allDayZone));
  if (timesDiffer) Object.assign(body, { start: placement.start, end: placement.end, isAllDay: placement.isAllDay });
  if (series && after.rrule) {
    const recurrence = graphRecurrence(after, placement);
    if (!recurrence) return null;
    body.recurrence = recurrence;
  } else if (series && before.rrule) body.recurrence = null;
  return body;
}

/**
 * The Graph writes that turn `resource` into `text`, the engine's edit of the resource's own text: PATCH
 * of changed fields, DELETE of changed occurrences whose VEVENT was dropped, and cancellation of
 * occurrences newly listed as EXDATE. Null when the change cannot be expressed (answered with 422).
 */
export function planUpdate(resource: GraphResource, text: string, allDayZone: string): GraphWrite[] | null {
  const next = readEvents(text);
  const current = readEvents(resource.text);
  if (!next || !current) return null;
  const wanted = new Map(next.map(event => [event.uid, event]));
  const patches: GraphWrite[] = [];
  const deletes: GraphWrite[] = [];
  const cancels: GraphWrite[] = [];
  for (const event of current) {
    const member = event.component !== undefined ? resource.members[event.component] : undefined;
    if (!member) continue;
    const series = event.component === 0;
    const target = wanted.get(event.uid);
    if (!target) {
      if (!series) deletes.push({ kind: 'delete', id: member.id, etag: member['@odata.etag'] ?? null });
      continue;
    }
    const body = changedFields(event, target, member, series, resource.unsupported, allDayZone);
    if (body === null) return null;
    if (Object.keys(body).length) {
      // Writing to an event with attendees could notify all of them; the engine never asks, this makes sure.
      if ((member.attendees ?? []).length) return null;
      patches.push({ kind: 'patch', id: member.id, etag: member['@odata.etag'] ?? null, body, series });
    }
    if (series) {
      const after = parseDateCell(target.value);
      const known = new Set(parseDateCell(event.value)?.exdates ?? []);
      if (after?.rrule) for (const point of after.exdates ?? []) if (!known.has(point)) cancels.push({ kind: 'cancel', point, allDay: after.allDay });
    }
  }
  return [...patches, ...deletes, ...cancels];
}

export interface GraphCreate { body: Record<string, unknown>; cancels: { point: string; allDay: boolean }[] }

/** A new Graph event from a resource text with one event; null when it cannot be expressed. */
export function planCreate(text: string, allDayZone: string): GraphCreate | null {
  const events = readEvents(text);
  const event = events?.find(item => !item.uid.includes('#')) ?? events?.[0];
  const cell = event ? parseDateCell(event.value) : null;
  if (!event || !cell) return null;
  const placement = place(cell, allDayZone);
  const body: Record<string, unknown> = { subject: event.title, body: { contentType: 'text', content: event.description },
    location: { displayName: event.location }, start: placement.start, end: placement.end, isAllDay: placement.isAllDay };
  if (cell.rrule) {
    const recurrence = graphRecurrence(cell, placement);
    if (!recurrence) return null;
    body.recurrence = recurrence;
  }
  return { body, cancels: cell.rrule ? (cell.exdates ?? []).map(point => ({ point, allDay: cell.allDay })) : [] };
}

/** Whether an instance returned by Graph is the occurrence starting at `point`. */
export function isOccurrenceAt(instance: GraphEvent, point: string, allDay: boolean): boolean {
  if (allDay) {
    if (occurrenceDay(instance.occurrenceId) === point) return true;
    return dayOf(instance.start, ianaZone(instance.originalStartTimeZone)) === point;
  }
  const target = Date.parse(point);
  const original = instance.originalStart ? instantOf({ dateTime: instance.originalStart, timeZone: 'UTC' }) : null;
  return original === target || (original === null && instantOf(instance.start) === target);
}
