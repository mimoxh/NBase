import { instantText, parseDateCell, shiftCalendarDay, wallClock, type DateCell } from '@nbase/contracts';
import { IcsError, unfold } from './ics.js';

/**
 * Writes events back to iCalendar text. A changed event is patched into the text it came from: only the
 * synced properties are replaced, everything else (alarms, attendees, categories, X- properties, other
 * components) is kept as it was.
 */

export interface IcsLine { prop: string; line: string }
export interface IcsNode { name: string; children: (IcsLine | IcsNode)[] }

export interface WritableEvent { title: string; value: string; location: string; description: string }

const isNode = (item: IcsLine | IcsNode): item is IcsNode => 'children' in item;

function propName(line: string): string {
  const match = /^[^;:]*/.exec(line);
  return (match?.[0] ?? '').toUpperCase();
}

export function parseIcsTree(text: string): IcsNode {
  const stack: IcsNode[] = [];
  let root: IcsNode | null = null;
  for (const line of unfold(text.replace(/^\uFEFF/, ''))) {
    if (!line.trim()) continue;
    const prop = propName(line);
    const value = line.slice(line.indexOf(':') + 1).trim().toUpperCase();
    if (prop === 'BEGIN') {
      const node: IcsNode = { name: value, children: [] };
      if (stack.length) stack.at(-1)!.children.push(node);
      else if (root || value !== 'VCALENDAR') throw new IcsError('PARSE_FAILED');
      else root = node;
      stack.push(node);
    } else if (prop === 'END') {
      if (stack.at(-1)?.name !== value) throw new IcsError('PARSE_FAILED');
      stack.pop();
    } else if (stack.length) stack.at(-1)!.children.push({ prop, line });
  }
  if (!root || stack.length) throw new IcsError('PARSE_FAILED');
  return root;
}

/** Folds a content line at 75 octets, never inside a UTF-8 sequence. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > limit) {
      out.push(current);
      current = ' ';
      size = 1;
      limit = 75;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n');
}

export function serializeIcsTree(root: IcsNode): string {
  const lines: string[] = [];
  const walk = (node: IcsNode) => {
    lines.push(`BEGIN:${node.name}`);
    for (const item of node.children) {
      if (isNode(item)) walk(item); else lines.push(foldLine(item.line));
    }
    lines.push(`END:${node.name}`);
  };
  walk(root);
  return lines.join('\r\n') + '\r\n';
}

export function escapeIcsText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\\;,\n]/g, c => (c === '\n' ? '\\n' : `\\${c}`));
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');
const basicDay = (day: string) => day.replace(/-/g, '');
const basicInstant = (instant: string) => instant.replace(/[-:]/g, '');
export const icsStamp = (ms: number) => basicInstant(instantText(Math.floor(ms / 1000) * 1000));

function wallText(ms: number, zone: string): string {
  const [y, m, d, h, mi, s] = wallClock(ms, zone);
  return `${pad(y, 4)}${pad(m)}${pad(d)}T${pad(h)}${pad(mi)}${pad(s)}`;
}

const utcZones = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Etc/Zulu', 'Zulu', 'Universal', 'UCT', 'Etc/UCT']);

interface DateLines { lines: string[]; zone: string | null }

/**
 * DTSTART, DTEND, RRULE and EXDATE of a value. All-day values use VALUE=DATE with the exclusive end day;
 * timed values in their zone when they have one (series keep their wall time that way), otherwise in UTC.
 * `keep` leaves exdates out that the text keeps as changed occurrences.
 */
export function dateLines(cell: DateCell, series: boolean, keep: ReadonlySet<string> = new Set()): DateLines {
  const recurring = series && cell.rrule !== undefined;
  const exdates = recurring ? (cell.exdates ?? []).filter(point => !keep.has(point)) : [];
  if (cell.allDay) {
    const lines = [`DTSTART;VALUE=DATE:${basicDay(cell.start)}`, `DTEND;VALUE=DATE:${basicDay(shiftCalendarDay(cell.end ?? cell.start, 1))}`];
    if (recurring) lines.push(`RRULE:${cell.rrule}`);
    if (exdates.length) lines.push(`EXDATE;VALUE=DATE:${exdates.map(basicDay).join(',')}`);
    return { lines, zone: null };
  }
  const zone = cell.timeZone && !utcZones.has(cell.timeZone) ? cell.timeZone : null;
  const point = (instant: string) => zone ? wallText(Date.parse(instant), zone) : basicInstant(instant);
  const param = zone ? `;TZID=${zone}` : '';
  const lines = [`DTSTART${param}:${point(cell.start)}`];
  if (cell.end) lines.push(`DTEND${param}:${point(cell.end)}`);
  if (recurring) lines.push(`RRULE:${cell.rrule}`);
  if (exdates.length) lines.push(`EXDATE${param}:${exdates.map(point).join(',')}`);
  return { lines, zone };
}

function offsetText(minutes: number): string {
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;
}

function offsetAt(ms: number, zone: string): number {
  const [y, m, d, h, mi, s] = wallClock(ms, zone);
  return Math.round((Date.UTC(y, m - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000) / 60000);
}

const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The day in `year` that "the nth (or last when nth < 0) weekday of month" names. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  const last = new Date(Date.UTC(year, month - 1, days)).getUTCDay();
  return days - ((last - weekday + 7) % 7);
}

/**
 * A VTIMEZONE for `zone`, derived with Intl from the offsets and clock changes of `year`. Zones that change
 * by the same weekday rule every year come out exact; others follow that year's changes.
 */
export function vtimezoneLines(zone: string, year: number): string[] {
  const start = Date.UTC(year, 0, 1, 12);
  const transitions: { at: number; from: number; to: number }[] = [];
  let previous = offsetAt(start, zone);
  for (let day = 1; day <= 366 && transitions.length < 4; day++) {
    const ms = start + day * 86400000;
    const offset = offsetAt(ms, zone);
    if (offset === previous) continue;
    let lo = ms - 86400000;
    let hi = ms;
    while (hi - lo > 60000) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(mid, zone) === previous) lo = mid; else hi = mid;
    }
    const minute = Math.floor(hi / 60000) * 60000;
    transitions.push({ at: offsetAt(minute, zone) === offset ? minute : minute + 60000, from: previous, to: offset });
    previous = offset;
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  const observance = (kind: 'STANDARD' | 'DAYLIGHT', from: number, to: number, dtstart: string, rule?: string) => {
    lines.push(`BEGIN:${kind}`, `TZOFFSETFROM:${offsetText(from)}`, `TZOFFSETTO:${offsetText(to)}`, `DTSTART:${dtstart}`);
    if (rule) lines.push(`RRULE:${rule}`);
    lines.push(`END:${kind}`);
  };
  const first = offsetAt(start, zone);
  if (transitions.length === 0) {
    observance('STANDARD', first, first, '19700101T000000');
  } else if (transitions.length === 2 && transitions[0]!.from === transitions[1]!.to) {
    for (const change of transitions) {
      const local = new Date(change.at + change.from * 60000);
      const month = local.getUTCMonth() + 1;
      const day = local.getUTCDate();
      const weekday = local.getUTCDay();
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
      const time = `T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`;
      const anchor = nthWeekday(1970, month, weekday, nth);
      observance(change.to > change.from ? 'DAYLIGHT' : 'STANDARD', change.from, change.to, `1970${pad(month)}${pad(anchor)}${time}`,
        `FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${weekdays[weekday]}`);
    }
  } else {
    observance('STANDARD', first, first, '19700101T000000');
    for (const change of transitions) {
      const local = new Date(change.at + change.from * 60000);
      const stamp = `${pad(local.getUTCFullYear(), 4)}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}T`
        + `${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`;
      observance(change.to > change.from ? 'DAYLIGHT' : 'STANDARD', change.from, change.to, stamp);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

function linesToNode(lines: string[]): IcsNode {
  return parseIcsTree(['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'].join('\r\n')).children[0] as IcsNode;
}

function cellOf(value: string): DateCell | null {
  const cell = parseDateCell(value);
  if (!cell) return null;
  return { ...cell, reminders: undefined };
}

function eventLines(event: WritableEvent, cell: DateCell, series: boolean, keep: ReadonlySet<string>): DateLines {
  const dates = dateLines(cell, series, keep);
  const lines = [`SUMMARY:${escapeIcsText(event.title)}`, ...dates.lines];
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  return { lines, zone: dates.zone };
}

const yearOf = (cell: DateCell) => Number(cell.start.slice(0, 4));

/** A new resource holding one event. Throws IcsError when the value is not a date. */
export function buildIcsResource(uid: string, event: WritableEvent, now: number): string {
  const cell = cellOf(event.value);
  if (!cell) throw new IcsError('PARSE_FAILED');
  const body = eventLines(event, cell, true, new Set());
  const stamp = icsStamp(now);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NBase//Calendar//ZH', 'CALSCALE:GREGORIAN',
    ...(body.zone ? vtimezoneLines(body.zone, yearOf(cell)) : []),
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `CREATED:${stamp}`, `LAST-MODIFIED:${stamp}`, 'SEQUENCE:0', ...body.lines,
    'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export interface ResourceEdit {
  /** Position of the VEVENT among the top-level VEVENTs. */
  component: number;
  event: WritableEvent;
  /** Exdates of a series value that the text keeps as changed occurrences; they are not written as EXDATE. */
  keep?: string[];
}

export interface ResourcePatch {
  edits: ResourceEdit[];
  /** VEVENTs to remove: changed occurrences whose rows went to the trash. */
  drop: number[];
  /** Occurrence starts to add as EXDATE to a series that is not edited otherwise. */
  exclude?: { component: number; points: string[] }[];
}

const replaced = new Set(['SUMMARY', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'EXDATE', 'LOCATION', 'DESCRIPTION']);

function bump(event: IcsNode, stamp: string): void {
  const sequence = event.children.findIndex(item => !isNode(item) && item.prop === 'SEQUENCE');
  if (sequence >= 0) {
    const line = event.children[sequence] as IcsLine;
    const n = Number(line.line.slice(line.line.indexOf(':') + 1).trim());
    event.children[sequence] = { prop: 'SEQUENCE', line: `SEQUENCE:${Number.isInteger(n) && n >= 0 ? n + 1 : 1}` };
  } else event.children.splice(firstPropIndex(event), 0, { prop: 'SEQUENCE', line: 'SEQUENCE:1' });
  for (const prop of ['DTSTAMP', 'LAST-MODIFIED']) {
    const index = event.children.findIndex(item => !isNode(item) && item.prop === prop);
    const line = { prop, line: `${prop}:${stamp}` };
    if (index >= 0) event.children[index] = line; else event.children.splice(firstPropIndex(event), 0, line);
  }
}

function firstPropIndex(event: IcsNode): number {
  const uid = event.children.findIndex(item => !isNode(item) && item.prop === 'UID');
  return uid >= 0 ? uid + 1 : 0;
}

/** Applies edits to a resource text and returns the new text. Throws IcsError when a value is not a date. */
export function patchIcsResource(text: string, patch: ResourcePatch, now: number): string {
  const root = parseIcsTree(text);
  const events = root.children.filter((item): item is IcsNode => isNode(item) && item.name === 'VEVENT');
  const stamp = icsStamp(now);
  const zones = new Map<string, number>();
  for (const edit of patch.edits) {
    const event = events[edit.component];
    if (!event) throw new IcsError('PARSE_FAILED');
    const cell = cellOf(edit.event.value);
    if (!cell) throw new IcsError('PARSE_FAILED');
    const series = !event.children.some(item => !isNode(item) && item.prop === 'RECURRENCE-ID');
    const lines = eventLines(edit.event, cell, series, new Set(edit.keep ?? []));
    if (lines.zone && !zones.has(lines.zone)) zones.set(lines.zone, yearOf(cell));
    let at = -1;
    event.children = event.children.filter((item, index) => {
      if (isNode(item) || !replaced.has(item.prop)) return true;
      if (at < 0) at = index;
      return false;
    });
    const position = at >= 0 ? Math.min(at, event.children.length) : firstPropIndex(event);
    event.children.splice(position, 0, ...lines.lines.map(line => ({ prop: propName(line), line })));
    bump(event, stamp);
  }
  for (const exclusion of patch.exclude ?? []) {
    const event = events[exclusion.component];
    if (!event || !exclusion.points.length) continue;
    const start = event.children.find((item): item is IcsLine => !isNode(item) && item.prop === 'DTSTART');
    const allDay = start ? /;VALUE=DATE[;:]/i.test(start.line) || /:\d{8}$/.test(start.line.trim()) : false;
    const values = exclusion.points.map(point => allDay ? basicDay(point.slice(0, 10)) : basicInstant(point));
    const line = allDay ? `EXDATE;VALUE=DATE:${values.join(',')}` : `EXDATE:${values.join(',')}`;
    const after = event.children.findIndex(item => !isNode(item) && (item.prop === 'RRULE' || item.prop === 'DTSTART'));
    event.children.splice(after >= 0 ? after + 1 : firstPropIndex(event), 0, { prop: 'EXDATE', line });
    bump(event, stamp);
  }
  const doomed = new Set(patch.drop.map(index => events[index]).filter((event): event is IcsNode => event !== undefined));
  root.children = root.children.filter(item => !(isNode(item) && doomed.has(item)));
  if (zones.size) {
    const known = new Set(root.children.filter((item): item is IcsNode => isNode(item) && item.name === 'VTIMEZONE')
      .map(node => node.children.find((item): item is IcsLine => !isNode(item) && item.prop === 'TZID'))
      .map(line => line ? line.line.slice(line.line.indexOf(':') + 1).trim() : ''));
    const firstEvent = root.children.findIndex(item => isNode(item) && item.name === 'VEVENT');
    const added = [...zones].filter(([zone]) => !known.has(zone)).map(([zone, year]) => linesToNode(vtimezoneLines(zone, year)));
    root.children.splice(firstEvent >= 0 ? firstEvent : root.children.length, 0, ...added);
  }
  return serializeIcsTree(root);
}
