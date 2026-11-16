import { calendarEventLimit, calendarImportWarnings, databaseTextValueLimit, dateCellLimits, daysBetween, formatDateCell,
  formatRecurrenceRule, instantText, isTimeZoneName, parseRecurrenceRule, shiftCalendarDay, wallClock, wallToInstant,
  type CalendarImportWarning, type CalendarImportWarningCode, type DateCell } from '@nbase/contracts';
import { createHash } from 'node:crypto';
import { windowsZones } from './windowsZones.js';

/**
 * Reads the events of an iCalendar (RFC 5545) text into date cells. Only VEVENT is read; alarms, attendees
 * and free/busy data are ignored. Problems with single events become warnings, never a failed import.
 */
export class IcsError extends Error {
  constructor(public readonly code: 'NOT_CALENDAR' | 'PARSE_FAILED') { super(code); }
}

export interface IcsEvent {
  /** UID, with `#<point>` for a changed occurrence of a series. */
  uid: string;
  title: string;
  /** A date cell value. */
  value: string;
  location: string;
  description: string;
}

export interface IcsParseResult {
  events: IcsEvent[];
  warnings: CalendarImportWarning[];
  /** Events left out: cancelled, or unusable. */
  skipped: number;
  /** X-WR-CALNAME, when present. */
  name: string | null;
}

export interface IcsOptions {
  /** Zone for floating times when the calendar names none. */
  timeZone: string;
  limit?: number;
}

interface Prop { name: string; params: Map<string, string[]>; value: string }
type Zone = { name: string } | { offset: number };
type Point = { allDay: true; day: string } | { allDay: false; ms: number; zone: Zone; tz: string | undefined };

const titleLimit = 255;
/** Longer UIDs are replaced by their digest, leaving room for `#<point>` in the 1000-character key. */
const uidLimit = 900;
const pointPattern = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/;
const windowsLookup = new Map(Object.entries(windowsZones).map(([key, value]) => [key.toLowerCase(), value]));

function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

/** name *(";" param) ":" value, with quoted parameter values that may hold ";", ":" and ",". */
export function parseContentLine(line: string): Prop | null {
  let i = 0;
  while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params = new Map<string, string[]>();
  while (line[i] === ';') {
    const eq = line.indexOf('=', i);
    if (eq < 0) return null;
    const key = line.slice(i + 1, eq).toUpperCase();
    i = eq + 1;
    const values: string[] = [];
    for (;;) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        values.push(line.slice(i + 1, close));
        i = close + 1;
      } else {
        let j = i;
        while (j < line.length && line[j] !== ',' && line[j] !== ';' && line[j] !== ':') j++;
        values.push(line.slice(i, j));
        i = j;
      }
      if (line[i] !== ',') break;
      i++;
    }
    params.set(key, values);
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function cutUnits(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const knownZone = (name: string): boolean => isTimeZoneName(name);

function ianaFor(tzid: string): string | null {
  const id = tzid.trim();
  if (knownZone(id)) return id;
  const windows = windowsLookup.get(id.toLowerCase());
  if (windows && knownZone(windows)) return windows;
  // Some writers prefix the zone with a vendor path, as in /mozilla.org/20050126_1/America/New_York.
  const parts = id.split('/').filter(Boolean);
  for (let n = Math.min(3, parts.length); n >= 1; n--) {
    const tail = parts.slice(-n).join('/');
    if (tail !== id && knownZone(tail)) return tail;
  }
  return null;
}

/** A fixed offset in minutes east of UTC as a zone; whole hours have an IANA name. */
function offsetZone(minutes: number): Zone {
  if (minutes === 0) return { name: 'UTC' };
  if (minutes % 60 === 0 && Math.abs(minutes) <= 14 * 60) return { name: `Etc/GMT${minutes > 0 ? '-' : '+'}${Math.abs(minutes) / 60}` };
  return { offset: minutes };
}

function parseOffset(value: string): number | null {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return minutes > 18 * 60 ? null : (match[1] === '-' ? -minutes : minutes);
}

function toMs(wall: [number, number, number, number, number, number], zone: Zone): number {
  const [y, m, d, h, mi, s] = wall;
  if ('offset' in zone) return Date.UTC(y, m - 1, d, h, mi, s) - zone.offset * 60000;
  return wallToInstant(y, m, d, h, mi, s, zone.name);
}

function wallOf(ms: number, zone: Zone): [number, number, number, number, number, number] {
  if ('offset' in zone) {
    const d = new Date(ms + zone.offset * 60000);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  }
  return wallClock(ms, zone.name);
}

function splitWall(text: string): { wall: [number, number, number, number, number, number]; hasTime: boolean; utc: boolean } | null {
  const match = pointPattern.exec(text.trim().toUpperCase());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 1000 || m < 1 || m > 12 || d < 1) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  if (match[4] === undefined) return { wall: [y, m, d, 0, 0, 0], hasTime: false, utc: false };
  const [h, mi, s] = [Number(match[4]), Number(match[5]), Math.min(59, Number(match[6]))];
  if (h > 23 || mi > 59) return null;
  return { wall: [y, m, d, h, mi, s], hasTime: true, utc: match[7] === 'Z' };
}

const dayText = (wall: number[]) => `${String(wall[0]).padStart(4, '0')}-${String(wall[1]).padStart(2, '0')}-${String(wall[2]).padStart(2, '0')}`;

interface Context {
  defaultZone: string;
  calendarZone: string | null;
  vtimezones: Map<string, number>;
  /** Warnings of the event being read; each counts once per event. */
  flags: Set<CalendarImportWarningCode>;
}

/** The zone a DATE-TIME property is written in, or null for UTC and floating times, which the caller decides. */
function zoneOfProp(prop: Prop, ctx: Context): Zone | null {
  const tzid = prop.params.get('TZID')?.[0];
  if (!tzid) return null;
  const iana = ianaFor(tzid);
  if (iana) return { name: iana };
  ctx.flags.add('TIMEZONE_UNKNOWN');
  const offset = ctx.vtimezones.get(tzid);
  return offset !== undefined ? offsetZone(offset) : { name: 'UTC' };
}

function floatingZone(ctx: Context): Zone {
  return { name: ctx.calendarZone ?? ctx.defaultZone };
}

/** Reads one value of a DATE or DATE-TIME property. */
function readPoint(text: string, prop: Prop, ctx: Context): Point | null {
  const parsed = splitWall(text);
  if (!parsed) return null;
  const isDate = prop.params.get('VALUE')?.[0]?.toUpperCase() === 'DATE' || !parsed.hasTime;
  if (isDate) return { allDay: true, day: dayText(parsed.wall) };
  if (parsed.utc) return { allDay: false, ms: Date.UTC(parsed.wall[0], parsed.wall[1] - 1, parsed.wall[2], parsed.wall[3], parsed.wall[4], parsed.wall[5]), zone: { name: 'UTC' }, tz: undefined };
  const declared = zoneOfProp(prop, ctx);
  const zone = declared ?? floatingZone(ctx);
  return { allDay: false, ms: toMs(parsed.wall, zone), zone, tz: 'name' in zone ? zone.name : undefined };
}

/** A point of the same kind as the series start: dates of timed series take the start's wall time. */
function alignPoint(point: Point, start: Point): string | null {
  if (start.allDay) return point.allDay ? point.day : dayText(wallOf(point.ms, point.zone));
  if (!point.allDay) return instantText(Math.floor(point.ms / 1000) * 1000);
  const [y, m, d] = point.day.split('-').map(Number) as [number, number, number];
  const wall = wallOf(start.ms, start.zone);
  return instantText(toMs([y, m, d, wall[3], wall[4], wall[5]], start.zone));
}

function durationOf(text: string): { days: number; ms: number } | null {
  const match = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(text.trim());
  if (!match || text.trim().length <= 1) return null;
  const [w, d, h, m, s] = match.slice(1).map(part => Number(part ?? 0)) as [number, number, number, number, number];
  const days = w * 7 + d;
  return { days, ms: ((days * 24 + h) * 60 + m) * 60000 + s * 1000 };
}

/** Rewrites UNTIL into the kind the value grammar wants: a day for all-day series, a UTC instant otherwise. */
function normalizeRule(text: string, start: Point): string | null {
  const parts: string[] = [];
  for (const part of text.trim().split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    const key = part.slice(0, eq).toUpperCase();
    let value = part.slice(eq + 1).toUpperCase();
    if (key === 'UNTIL') {
      const until = splitWall(value);
      if (!until) return null;
      if (start.allDay) value = dayText(until.wall).replace(/-/g, '');
      else {
        let ms: number;
        if (until.utc) ms = Date.UTC(until.wall[0], until.wall[1] - 1, until.wall[2], until.wall[3], until.wall[4], until.wall[5]);
        else if (!until.hasTime) ms = toMs([until.wall[0], until.wall[1], until.wall[2], 23, 59, 59], start.zone);
        else ms = toMs(until.wall, start.zone);
        value = instantText(ms).replace(/[-:]/g, '');
      }
    }
    parts.push(`${key}=${value}`);
  }
  const rule = parseRecurrenceRule(parts.join(';'), start.allDay);
  return rule ? formatRecurrenceRule(rule) : null;
}

function cleanTitle(value: string | undefined, ctx: Context): string {
  const text = unescapeText(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  if (text.length > titleLimit) ctx.flags.add('VALUE_SHORTENED');
  return cutUnits(text, titleLimit).trim();
}

function cleanText(value: string | undefined, ctx: Context): string {
  const text = unescapeText(value ?? '').replace(/\r\n?/g, '\n').replace(/\u0000|\p{Cs}/gu, '').trim();
  if (text.length > databaseTextValueLimit) ctx.flags.add('VALUE_SHORTENED');
  return cutUnits(text, databaseTextValueLimit).trimEnd();
}

function cleanUid(value: string | undefined): string | null {
  const uid = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!uid) return null;
  return uid.length > uidLimit ? `sha256:${createHash('sha256').update(uid).digest('hex')}` : uid;
}

interface RawEvent { props: Map<string, Prop[]>; order: number }

const first = (event: RawEvent, name: string) => event.props.get(name)?.[0];

interface Timing { start: Point; end?: Point; days?: number; ms?: number }

function readTiming(event: RawEvent, ctx: Context): Timing | null {
  const dtstart = first(event, 'DTSTART');
  const start = dtstart ? readPoint(dtstart.value, dtstart, ctx) : null;
  if (!start) return null;
  const dtend = first(event, 'DTEND');
  const end = dtend ? readPoint(dtend.value, dtend, ctx) : null;
  if (end && end.allDay === start.allDay) return { start, end };
  const duration = first(event, 'DURATION');
  const length = duration ? durationOf(duration.value) : null;
  return length ? { start, days: length.days, ms: length.ms } : { start };
}

function cellOf(timing: Timing): DateCell {
  const { start } = timing;
  if (start.allDay) {
    let endDay: string | undefined;
    // All-day DTEND is the day after the last one.
    if (timing.end?.allDay) endDay = shiftCalendarDay(timing.end.day, -1);
    else if (timing.days !== undefined && timing.days > 1) endDay = shiftCalendarDay(start.day, timing.days - 1);
    return { start: start.day, allDay: true, ...(endDay && endDay > start.day ? { end: endDay } : {}) };
  }
  const startMs = Math.floor(start.ms / 1000) * 1000;
  const endMs = timing.end && !timing.end.allDay ? Math.floor(timing.end.ms / 1000) * 1000
    : timing.ms !== undefined ? startMs + timing.ms : undefined;
  return { start: instantText(startMs), allDay: false, ...(endMs !== undefined && endMs > startMs ? { end: instantText(endMs) } : {}),
    ...(start.tz ? { timeZone: start.tz } : {}) };
}

function spanDays(cell: DateCell): number {
  if (!cell.end) return 0;
  return cell.allDay ? daysBetween(cell.start, cell.end) : (Date.parse(cell.end) - Date.parse(cell.start)) / 86400000;
}

function exdatePoints(event: RawEvent, start: Point, ctx: Context): string[] {
  const out: string[] = [];
  for (const prop of event.props.get('EXDATE') ?? []) {
    for (const text of prop.value.split(',')) {
      const point = readPoint(text, prop, ctx);
      const aligned = point ? alignPoint(point, start) : null;
      if (aligned) out.push(aligned);
    }
  }
  return out;
}

const cancelled = (event: RawEvent) => first(event, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED';
const sequenceOf = (event: RawEvent) => { const n = Number(first(event, 'SEQUENCE')?.value.trim()); return Number.isInteger(n) ? n : 0; };

/** Removes the leading BOM and checks that the text is a calendar at all. */
export function looksLikeCalendar(text: string): boolean {
  return /^\uFEFF?[\s]*BEGIN:VCALENDAR/i.test(text.slice(0, 1024));
}

export function parseIcs(text: string, options: IcsOptions): IcsParseResult {
  if (!looksLikeCalendar(text)) throw new IcsError('NOT_CALENDAR');
  const lines = unfold(text.replace(/^\uFEFF/, ''));
  const stack: string[] = [];
  const raw: RawEvent[] = [];
  const vtimezones = new Map<string, number>();
  let calendarZone: string | null = null;
  let name: string | null = null;
  let closed = false;
  let current: RawEvent | null = null;
  let zoneId: string | null = null;
  let standardOffset: number | null = null;
  let anyOffset: number | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseContentLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const component = prop.value.trim().toUpperCase();
      if (!stack.length && component !== 'VCALENDAR') throw new IcsError('PARSE_FAILED');
      if (closed) throw new IcsError('PARSE_FAILED');
      stack.push(component);
      if (component === 'VEVENT' && stack.length === 2) current = { props: new Map(), order: raw.length };
      if (component === 'VTIMEZONE' && stack.length === 2) { zoneId = null; standardOffset = null; anyOffset = null; }
      continue;
    }
    if (prop.name === 'END') {
      const component = prop.value.trim().toUpperCase();
      if (stack.at(-1) !== component) throw new IcsError('PARSE_FAILED');
      stack.pop();
      if (component === 'VEVENT' && current && stack.length === 1) { raw.push(current); current = null; }
      if (component === 'VTIMEZONE' && stack.length === 1 && zoneId !== null) {
        const offset = standardOffset ?? anyOffset;
        if (offset !== null) vtimezones.set(zoneId, offset);
      }
      if (component === 'VCALENDAR' && !stack.length) closed = true;
      continue;
    }
    if (stack.length === 1 && stack[0] === 'VCALENDAR') {
      if (prop.name === 'X-WR-TIMEZONE') calendarZone = ianaFor(unescapeText(prop.value)) ?? calendarZone;
      if (prop.name === 'X-WR-CALNAME') name = cutUnits(unescapeText(prop.value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), 100) || null;
    } else if (stack.length === 2 && stack[1] === 'VEVENT' && current) {
      const list = current.props.get(prop.name);
      if (list) list.push(prop); else current.props.set(prop.name, [prop]);
    } else if (stack[1] === 'VTIMEZONE') {
      if (stack.length === 2 && prop.name === 'TZID') zoneId = prop.value.trim();
      if (stack.length === 3 && prop.name === 'TZOFFSETTO') {
        const offset = parseOffset(prop.value);
        if (offset !== null) {
          if (stack[2] === 'STANDARD') standardOffset ??= offset;
          anyOffset ??= offset;
        }
      }
    }
  }
  if (!closed) throw new IcsError('PARSE_FAILED');

  const totals = new Map<CalendarImportWarningCode, number>();
  const count = (code: CalendarImportWarningCode, n = 1) => totals.set(code, (totals.get(code) ?? 0) + n);
  const ctx: Context = { defaultZone: options.timeZone, calendarZone, vtimezones, flags: new Set() };
  const done = () => { for (const code of ctx.flags) count(code); ctx.flags = new Set(); };
  let skipped = 0;

  // Group by UID: the series, then its changed occurrences. A repeated UID keeps the highest SEQUENCE.
  const masters = new Map<string, RawEvent>();
  const overrides = new Map<string, Map<string, RawEvent>>();
  for (const event of raw) {
    const dtstart = first(event, 'DTSTART');
    const uid = cleanUid(first(event, 'UID')?.value)
      ?? (dtstart ? `nouid:${createHash('sha256').update(`${dtstart.value}\n${first(event, 'SUMMARY')?.value ?? ''}`).digest('hex').slice(0, 32)}` : null);
    if (!uid) { skipped++; count('EVENT_INVALID'); continue; }
    const recurrence = first(event, 'RECURRENCE-ID');
    if (recurrence) {
      const byPoint = overrides.get(uid) ?? new Map<string, RawEvent>();
      overrides.set(uid, byPoint);
      const key = recurrence.value.trim().toUpperCase() + (recurrence.params.get('TZID')?.[0] ?? '');
      const known = byPoint.get(key);
      if (!known || sequenceOf(event) > sequenceOf(known)) byPoint.set(key, event);
      continue;
    }
    const known = masters.get(uid);
    if (!known || sequenceOf(event) > sequenceOf(known)) masters.set(uid, event);
  }

  const events: (IcsEvent & { order: number })[] = [];
  const textOf = (event: RawEvent) => ({
    title: cleanTitle(first(event, 'SUMMARY')?.value, ctx),
    location: cleanText(first(event, 'LOCATION')?.value, ctx),
    description: cleanText(first(event, 'DESCRIPTION')?.value, ctx),
  });

  for (const uid of new Set([...masters.keys(), ...overrides.keys()])) {
    const master = masters.get(uid);
    const masterTiming = master ? readTiming(master, ctx) : null;
    const removed: string[] = [];
    for (const event of overrides.get(uid)?.values() ?? []) {
      const recurrence = first(event, 'RECURRENCE-ID')!;
      const timing = readTiming(event, ctx);
      const recurrencePoint = readPoint(recurrence.value, recurrence, ctx);
      const anchor = masterTiming?.start ?? timing?.start;
      const point = recurrencePoint && anchor ? alignPoint(recurrencePoint, anchor) : null;
      if (!point) { skipped++; ctx.flags.add('EVENT_INVALID'); done(); continue; }
      removed.push(point);
      if (cancelled(event)) { skipped++; done(); continue; }
      const cell = timing ? cellOf(timing) : null;
      if (cell && !cell.allDay && !cell.timeZone && ctx.calendarZone) cell.timeZone = ctx.calendarZone;
      const value = cell ? formatDateCell(cell) : null;
      if (!value) { skipped++; ctx.flags.add('EVENT_INVALID'); done(); continue; }
      events.push({ uid: `${uid}#${point}`, value, ...textOf(event), order: event.order });
      done();
    }
    if (!master) continue;
    if (cancelled(master)) { skipped++; done(); continue; }
    if (!masterTiming) { skipped++; ctx.flags.add('EVENT_INVALID'); done(); continue; }
    const cell = cellOf(masterTiming);
    const ruleText = first(master, 'RRULE')?.value;
    if (ruleText) {
      const rule = (master.props.get('RRULE')?.length ?? 0) === 1 ? normalizeRule(ruleText, masterTiming.start) : null;
      if (!rule || spanDays(cell) > dateCellLimits.recurringSpanDays) ctx.flags.add('RULE_UNSUPPORTED');
      else {
        cell.rrule = rule;
        // RFC 5545 expands UTC and fixed-offset series in UTC.
        if (!cell.allDay && !cell.timeZone) cell.timeZone = 'UTC';
        const exdates = [...new Set([...exdatePoints(master, masterTiming.start, ctx), ...removed])]
          .filter(point => point >= cell.start).sort();
        if (exdates.length > dateCellLimits.exdates) ctx.flags.add('VALUE_SHORTENED');
        if (exdates.length) cell.exdates = exdates.slice(0, dateCellLimits.exdates);
      }
    }
    // A UTC time says nothing about where an event was planned; the calendar's own zone is the best guess.
    if (!cell.allDay && !cell.timeZone && ctx.calendarZone) cell.timeZone = ctx.calendarZone;
    let value = formatDateCell(cell);
    if (!value && cell.rrule) {
      ctx.flags.add('RULE_UNSUPPORTED');
      value = formatDateCell({ ...cell, rrule: undefined, exdates: undefined });
    }
    if (!value) { skipped++; ctx.flags.add('EVENT_INVALID'); done(); continue; }
    events.push({ uid, value, ...textOf(master), order: master.order });
    done();
  }

  events.sort((a, b) => a.order - b.order);
  const limit = options.limit ?? calendarEventLimit;
  if (events.length > limit) count('TRUNCATED', events.length - limit);
  return {
    events: events.slice(0, limit).map(({ order: _order, ...event }) => event),
    warnings: calendarImportWarnings.filter(code => totals.has(code)).map(code => ({ code, count: totals.get(code)! })),
    skipped,
    name,
  };
}
