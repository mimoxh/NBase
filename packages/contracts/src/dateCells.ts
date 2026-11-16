/**
 * Date cells of database rows, and the recurrence rules they may carry.
 *
 * A stored date value is one string:
 *
 *   value   := span *( "|" param )
 *   span    := point [ "/" point ]          both points are the same kind; the end is later than the start
 *   point   := day | instant
 *   day     := YYYY-MM-DD                   all-day; the end day is part of the event
 *   instant := YYYY-MM-DDTHH:MM:SSZ         a UTC moment; the end moment is not
 *   param   := "tz=" zone                   IANA zone the event was written in; timed values only
 *            | "rrule=" rule                RFC 5545 RRULE subset in the canonical form of formatRecurrenceRule
 *            | "exdate=" point *("," point) starts of removed occurrences, ascending; needs a rule
 *            | "remind=" int *("," int)     minutes before the start, ascending; all-day values may use
 *                                           negative minutes for a time after midnight of the day
 *
 * Params appear at most once, in the order above. A plain `YYYY-MM-DD` is still a valid value, so values
 * written before times existed keep their meaning. Days of timed values are taken in the reader's zone,
 * like page creation times; recurrence is expanded in the zone of `tz` (UTC without one), so a weekly
 * 09:00 meeting stays at 09:00 across daylight saving changes.
 */

export const dateCellLimits = {
  length: 4000,
  exdates: 300,
  reminders: 5,
  /** Four weeks. */
  reminderMinutes: 40320,
  /** A recurring event may not last longer than this, which keeps range queries exact. */
  recurringSpanDays: 31,
  count: 5000,
  interval: 1000,
  /** Occurrences a single expansion returns at most. */
  occurrences: 2000,
} as const;

export interface DateCell {
  start: string;
  /** Absent for a single day or a moment without duration. */
  end?: string | undefined;
  allDay: boolean;
  timeZone?: string | undefined;
  /** Canonical RRULE text, without the `RRULE:` prefix. */
  rrule?: string | undefined;
  exdates?: string[] | undefined;
  reminders?: number[] | undefined;
}

export interface DayRange { from: string; to: string }

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const dayMs = 86400000;

export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !dayPattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isInstantValue(value: unknown): value is string {
  if (typeof value !== 'string' || !instantPattern.test(value)) return false;
  const time = new Date(value);
  return !Number.isNaN(time.getTime()) && time.toISOString() === `${value.slice(0, 19)}.000Z`;
}

const zoneChecks = new Map<string, boolean>();
export function isTimeZoneName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  let known = zoneChecks.get(value);
  if (known === undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); known = true; } catch { known = false; }
    if (zoneChecks.size < 1000) zoneChecks.set(value, known);
  }
  return known;
}

/** Milliseconds as a canonical instant point. */
export function instantText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function shiftCalendarDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
/** Wall clock of a moment in a zone: [year, month, day, hour, minute, second]. Without a zone, the runtime's. */
export function wallClock(ms: number, timeZone?: string): [number, number, number, number, number, number] {
  if (!timeZone) {
    const d = new Date(ms);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  }
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric' });
    wallFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return [parts.year!, parts.month!, parts.day!, parts.hour! % 24, parts.minute!, parts.second!];
}

/** The calendar day of a moment for a reader; without a zone, in the runtime's local time. */
export function zonedDay(ms: number, timeZone?: string): string {
  const [y, m, d] = wallClock(ms, timeZone);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** The moment a wall clock time names in a zone. Times skipped by a clock change move forward past the gap. */
export function wallToInstant(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone?: string): number {
  if (!timeZone) return new Date(year, month - 1, day, hour, minute, second).getTime();
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (ms: number) => { const w = wallClock(ms, timeZone); return Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4], w[5]) - Math.floor(ms / 1000) * 1000; };
  const first = wanted - offsetAt(wanted);
  const second2 = wanted - offsetAt(first);
  if (second2 === first) return first;
  const back = (ms: number) => { const w = wallClock(ms, timeZone); return Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4], w[5]) === wanted; };
  if (back(second2)) return second2;
  if (back(first)) return first;
  return Math.max(first, second2);
}

/** Midnight that starts a day in a zone. */
export function dayStartInstant(day: string, timeZone?: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return wallToInstant(y, m, d, 0, 0, 0, timeZone);
}

// ---------------------------------------------------------------------------------------------------------
// Recurrence rules

export const recurrenceFrequencies = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFrequency = typeof recurrenceFrequencies[number];
/** Index 0 is Monday. */
export const weekdayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

export interface RecurrenceWeekday { day: number; nth?: number }

export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval: number;
  count?: number;
  /** A day for all-day values, an instant for timed ones; occurrences starting after it do not happen. */
  until?: string;
  byMonth?: number[];
  byMonthDay?: number[];
  byDay?: RecurrenceWeekday[];
  bySetPos?: number[];
  /** 0 is Monday. */
  weekStart: number;
}

function intList(text: string, min: number, max: number, allowNegative: boolean): number[] | null {
  const out: number[] = [];
  for (const item of text.split(',')) {
    if (!/^[+-]?\d{1,3}$/.test(item)) return null;
    const n = Number(item);
    if (n === 0 || Math.abs(n) < min || Math.abs(n) > max || (!allowNegative && n < 0)) return null;
    out.push(n);
  }
  return out.length && out.length <= 366 ? [...new Set(out)].sort((a, b) => a - b) : null;
}

/**
 * Reads a rule. Order of parts does not matter here; `formatRecurrenceRule` gives the canonical text that
 * stored values must use. `until` accepts `YYYYMMDD` for all-day values and `YYYYMMDDTHHMMSSZ` for timed ones.
 * Parts outside the supported subset (BYWEEKNO, BYYEARDAY, BYHOUR, …, and HOURLY or finer) return null.
 */
export function parseRecurrenceRule(text: string, allDay: boolean): RecurrenceRule | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1000) return null;
  const parts = new Map<string, string>();
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    const key = part.slice(0, eq).toUpperCase();
    if (parts.has(key)) return null;
    parts.set(key, part.slice(eq + 1).toUpperCase());
  }
  const allowed = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'BYSETPOS', 'WKST'];
  if ([...parts.keys()].some(key => !allowed.includes(key))) return null;
  const freq = parts.get('FREQ') as RecurrenceFrequency | undefined;
  if (!freq || !recurrenceFrequencies.includes(freq)) return null;
  const rule: RecurrenceRule = { freq, interval: 1, weekStart: 0 };
  const interval = parts.get('INTERVAL');
  if (interval !== undefined) {
    if (!/^\d{1,4}$/.test(interval) || Number(interval) < 1 || Number(interval) > dateCellLimits.interval) return null;
    rule.interval = Number(interval);
  }
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count !== undefined && until !== undefined) return null;
  if (count !== undefined) {
    if (!/^\d{1,4}$/.test(count) || Number(count) < 1 || Number(count) > dateCellLimits.count) return null;
    rule.count = Number(count);
  }
  if (until !== undefined) {
    const match = allDay ? /^(\d{4})(\d{2})(\d{2})$/.exec(until) : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(until);
    if (!match) return null;
    const value = allDay ? `${match[1]}-${match[2]}-${match[3]}` : `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    if (allDay ? !isCalendarDay(value) : !isInstantValue(value)) return null;
    rule.until = value;
  }
  const byMonth = parts.get('BYMONTH');
  if (byMonth !== undefined) { const list = intList(byMonth, 1, 12, false); if (!list) return null; rule.byMonth = list; }
  const byMonthDay = parts.get('BYMONTHDAY');
  if (byMonthDay !== undefined) {
    if (freq === 'WEEKLY') return null;
    const list = intList(byMonthDay, 1, 31, true); if (!list) return null; rule.byMonthDay = list;
  }
  const byDay = parts.get('BYDAY');
  if (byDay !== undefined) {
    const list: RecurrenceWeekday[] = [];
    for (const item of byDay.split(',')) {
      const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
      if (!match) return null;
      const day = weekdayCodes.indexOf(match[2] as typeof weekdayCodes[number]);
      if (match[1] === undefined) { list.push({ day }); continue; }
      const nth = Number(match[1]);
      const max = freq === 'MONTHLY' ? 5 : 53;
      if ((freq !== 'MONTHLY' && freq !== 'YEARLY') || nth === 0 || Math.abs(nth) > max) return null;
      list.push({ day, nth });
    }
    const key = (w: RecurrenceWeekday) => `${w.nth ?? 0}:${w.day}`;
    const unique = [...new Map(list.map(w => [key(w), w])).values()];
    unique.sort((a, b) => a.day - b.day || (a.nth ?? 0) - (b.nth ?? 0));
    if (!unique.length) return null;
    rule.byDay = unique;
  }
  const bySetPos = parts.get('BYSETPOS');
  if (bySetPos !== undefined) {
    if (!rule.byDay && !rule.byMonthDay) return null;
    const list = intList(bySetPos, 1, 366, true); if (!list) return null; rule.bySetPos = list;
  }
  const wkst = parts.get('WKST');
  if (wkst !== undefined) {
    const day = weekdayCodes.indexOf(wkst as typeof weekdayCodes[number]);
    if (day < 0) return null;
    rule.weekStart = day;
  }
  return rule;
}

export function formatRecurrenceRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until.replace(/[-:]/g, '')}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${[...rule.byMonth].sort((a, b) => a - b).join(',')}`);
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${[...rule.byMonthDay].sort((a, b) => a - b).join(',')}`);
  if (rule.byDay?.length) {
    const days = [...rule.byDay].sort((a, b) => a.day - b.day || (a.nth ?? 0) - (b.nth ?? 0));
    parts.push(`BYDAY=${days.map(w => `${w.nth ?? ''}${weekdayCodes[w.day]}`).join(',')}`);
  }
  if (rule.bySetPos?.length) parts.push(`BYSETPOS=${[...rule.bySetPos].sort((a, b) => a - b).join(',')}`);
  if (rule.weekStart !== 0) parts.push(`WKST=${weekdayCodes[rule.weekStart]}`);
  return parts.join(';');
}

// ---------------------------------------------------------------------------------------------------------
// Parsing and formatting cells

function spanDays(cell: Pick<DateCell, 'start' | 'end' | 'allDay'>): number {
  if (!cell.end) return 0;
  if (cell.allDay) return daysBetween(cell.start, cell.end);
  return (Date.parse(cell.end) - Date.parse(cell.start)) / dayMs;
}

/** Reads a stored date value; null when it does not follow the grammar exactly. */
export function parseDateCell(value: unknown): DateCell | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > dateCellLimits.length) return null;
  const [span, ...params] = value.split('|');
  const points = span!.split('/');
  if (points.length > 2) return null;
  const [start, end] = points as [string, string | undefined];
  const allDay = isCalendarDay(start);
  if (!allDay && !isInstantValue(start)) return null;
  const isPoint = allDay ? isCalendarDay : isInstantValue;
  if (end !== undefined && (!isPoint(end) || end <= start)) return null;
  const cell: DateCell = { start, allDay, ...(end !== undefined ? { end } : {}) };
  const order = ['tz', 'rrule', 'exdate', 'remind'];
  let last = -1;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq < 1) return null;
    const key = param.slice(0, eq);
    const text = param.slice(eq + 1);
    const index = order.indexOf(key);
    if (index <= last) return null;
    last = index;
    if (key === 'tz') {
      if (allDay || !isTimeZoneName(text)) return null;
      cell.timeZone = text;
    } else if (key === 'rrule') {
      const rule = parseRecurrenceRule(text, allDay);
      if (!rule || formatRecurrenceRule(rule) !== text) return null;
      cell.rrule = text;
    } else if (key === 'exdate') {
      const list = text.split(',');
      if (list.length > dateCellLimits.exdates || !list.every(isPoint)) return null;
      for (let i = 1; i < list.length; i++) if (list[i]! <= list[i - 1]!) return null;
      cell.exdates = list;
    } else {
      const list = text.split(',');
      if (list.length > dateCellLimits.reminders || !list.every(item => /^-?\d{1,5}$/.test(item) && item !== '-0')) return null;
      const minutes = list.map(Number);
      const min = allDay ? -1439 : 0;
      if (minutes.some(n => n < min || n > dateCellLimits.reminderMinutes)) return null;
      for (let i = 1; i < minutes.length; i++) if (minutes[i]! <= minutes[i - 1]!) return null;
      cell.reminders = minutes;
    }
  }
  if (cell.exdates && !cell.rrule) return null;
  if (cell.rrule && spanDays(cell) > dateCellLimits.recurringSpanDays) return null;
  return cell;
}

export function isDateCellValue(value: unknown): value is string {
  return parseDateCell(value) !== null;
}

/**
 * Canonical text of a cell: drops an end equal to the start, sorts and dedupes lists, drops removed
 * occurrences of the other kind. Returns null when the result still is not a valid value.
 */
export function formatDateCell(cell: DateCell): string | null {
  const isPoint = cell.allDay ? isCalendarDay : isInstantValue;
  let text = cell.start;
  if (cell.end !== undefined && cell.end !== cell.start) text += `/${cell.end}`;
  if (!cell.allDay && cell.timeZone) text += `|tz=${cell.timeZone}`;
  if (cell.rrule) {
    const rule = parseRecurrenceRule(cell.rrule, cell.allDay);
    if (!rule) return null;
    text += `|rrule=${formatRecurrenceRule(rule)}`;
    const exdates = [...new Set((cell.exdates ?? []).filter(isPoint))].sort();
    if (exdates.length) text += `|exdate=${exdates.join(',')}`;
  }
  const reminders = [...new Set(cell.reminders ?? [])].sort((a, b) => a - b);
  if (reminders.length) text += `|remind=${reminders.join(',')}`;
  return parseDateCell(text) ? text : null;
}

/** The start point of a stored value, used for sorting; undefined when the value is not a date cell. */
export function dateCellStart(value: unknown): string | undefined {
  return parseDateCell(value)?.start;
}

/** First and last day the first occurrence covers for a reader. A timed end moment itself is not covered. */
export function dateCellDays(cell: DateCell, timeZone?: string): DayRange {
  if (cell.allDay) return { from: cell.start, to: cell.end ?? cell.start };
  const start = Date.parse(cell.start);
  const end = cell.end ? Math.max(start, Date.parse(cell.end) - 1000) : start;
  return { from: zonedDay(start, timeZone), to: zonedDay(end, timeZone) };
}

/** Last day a recurring series may start on for a reader, or null when it is open-ended or limited by count. */
export function dateCellUntilDay(cell: DateCell, timeZone?: string): string | null {
  if (!cell.rrule) return null;
  const until = /UNTIL=(\d{8}(?:T\d{6}Z)?)/.exec(cell.rrule)?.[1];
  if (!until) return null;
  const day = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  if (until.length === 8) return day;
  return zonedDay(Date.parse(`${day}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`), timeZone);
}

/**
 * Whether a value may have an occurrence touching the inclusive days. Exact for single events; for
 * recurring ones a coarse test the server can run in SQL: the series starts no later than `to` and,
 * when it has an UNTIL, that day is no earlier than `from` minus the longest recurring span.
 */
export function dateCellMayTouch(cell: DateCell, range: DayRange, timeZone?: string): boolean {
  const days = dateCellDays(cell, timeZone);
  if (days.from > range.to) return false;
  if (!cell.rrule) return days.to >= range.from;
  const until = dateCellUntilDay(cell, timeZone);
  return until === null || until >= shiftCalendarDay(range.from, -dateCellLimits.recurringSpanDays);
}

// ---------------------------------------------------------------------------------------------------------
// Expansion

const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / dayMs;
const fromDayNumber = (n: number): [number, number, number] => { const d = new Date(n * dayMs); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
const weekdayOf = (n: number) => (new Date(n * dayMs).getUTCDay() + 6) % 7;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayText = (n: number) => { const [y, m, d] = fromDayNumber(n); return `${pad(y, 4)}-${pad(m)}-${pad(d)}`; };

function pick(sorted: number[], positions: number[] | undefined): number[] {
  if (!positions) return sorted;
  const out = positions.map(p => p > 0 ? sorted[p - 1] : sorted[sorted.length + p]).filter((n): n is number => n !== undefined);
  return [...new Set(out)].sort((a, b) => a - b);
}

function weekdayMatches(n: number, byDay: RecurrenceWeekday[]): boolean {
  const wd = weekdayOf(n);
  return byDay.some(w => w.day === wd);
}

function monthDayMatches(n: number, byMonthDay: number[]): boolean {
  const [y, m, d] = fromDayNumber(n);
  const dim = daysInMonth(y, m);
  return byMonthDay.some(x => (x > 0 ? x : dim + 1 + x) === d);
}

/** Days of one month a MONTHLY or YEARLY rule expands to, before BYSETPOS. */
function monthCandidates(rule: RecurrenceRule, y: number, m: number, startDay: number): number[] {
  const dim = daysInMonth(y, m);
  const first = dayNumber(y, m, 1);
  let days: number[] | null = null;
  if (rule.byMonthDay) {
    days = rule.byMonthDay.map(x => x > 0 ? x : dim + 1 + x).filter(d => d >= 1 && d <= dim).map(d => first + d - 1);
  }
  if (rule.byDay) {
    const set = new Set<number>();
    for (const w of rule.byDay) {
      const matching: number[] = [];
      for (let d = 0; d < dim; d++) if (weekdayOf(first + d) === w.day) matching.push(first + d);
      if (w.nth === undefined) matching.forEach(n => set.add(n));
      else { const n = w.nth > 0 ? matching[w.nth - 1] : matching[matching.length + w.nth]; if (n !== undefined) set.add(n); }
    }
    const byDay = [...set];
    days = days ? days.filter(n => set.has(n)) : byDay;
  }
  if (!days) days = startDay <= dim ? [first + startDay - 1] : [];
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Days of the period with index `k`, ascending, after BYMONTH and BYSETPOS. */
function periodDays(rule: RecurrenceRule, start: number, k: number): number[] {
  const [y0, m0, d0] = fromDayNumber(start);
  switch (rule.freq) {
    case 'DAILY': {
      const n = start + k * rule.interval;
      const [, m] = fromDayNumber(n);
      if (rule.byMonth && !rule.byMonth.includes(m)) return [];
      if (rule.byMonthDay && !monthDayMatches(n, rule.byMonthDay)) return [];
      if (rule.byDay && !weekdayMatches(n, rule.byDay)) return [];
      return [n];
    }
    case 'WEEKLY': {
      const weekStart = start - ((weekdayOf(start) - rule.weekStart + 7) % 7) + k * 7 * rule.interval;
      const wanted = rule.byDay ? rule.byDay.map(w => w.day) : [weekdayOf(start)];
      const days = [...new Set(wanted.map(day => weekStart + ((day - rule.weekStart + 7) % 7)))].sort((a, b) => a - b)
        .filter(n => !rule.byMonth || rule.byMonth.includes(fromDayNumber(n)[1]));
      return pick(days, rule.bySetPos);
    }
    case 'MONTHLY': {
      const total = m0 - 1 + k * rule.interval;
      const y = y0 + Math.floor(total / 12);
      const m = (total % 12) + 1;
      if (rule.byMonth && !rule.byMonth.includes(m)) return [];
      return pick(monthCandidates(rule, y, m, d0), rule.bySetPos);
    }
    case 'YEARLY': {
      const y = y0 + k * rule.interval;
      let days: number[];
      if (!rule.byMonth && rule.byDay && !rule.byMonthDay) {
        // Weekdays across the whole year; ordinals count within the year.
        const first = dayNumber(y, 1, 1);
        const length = dayNumber(y + 1, 1, 1) - first;
        const set = new Set<number>();
        for (const w of rule.byDay) {
          const matching: number[] = [];
          for (let d = 0; d < length; d++) if (weekdayOf(first + d) === w.day) matching.push(first + d);
          if (w.nth === undefined) matching.forEach(n => set.add(n));
          else { const n = w.nth > 0 ? matching[w.nth - 1] : matching[matching.length + w.nth]; if (n !== undefined) set.add(n); }
        }
        days = [...set].sort((a, b) => a - b);
      } else {
        const months = rule.byMonth ?? (rule.byMonthDay && !rule.byDay ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [m0]);
        days = months.flatMap(m => monthCandidates(rule, y, m, d0));
      }
      return pick([...new Set(days)].sort((a, b) => a - b), rule.bySetPos);
    }
  }
}

export interface DateOccurrence {
  /** Start point, in the cell's kind. Removing it means adding this to `exdate`. */
  start: string;
  /** Equal to the start when the cell has no end. */
  end: string;
  allDay: boolean;
  /** 0 for the first occurrence of a series. */
  index: number;
}

/**
 * Occurrences in order, starting with the first, which is always the cell's own start (as in RFC 5545).
 * Removed occurrences are skipped but still count toward COUNT. Stops at the rule's end, or after 2000
 * periods in a row without an occurrence, so a rule that can never match ends.
 */
export function* iterateOccurrences(cell: DateCell): Generator<DateOccurrence> {
  const span = cell.allDay ? (cell.end ? daysBetween(cell.start, cell.end) : 0)
    : (cell.end ? Date.parse(cell.end) - Date.parse(cell.start) : 0);
  const make = (start: string, index: number): DateOccurrence => ({ start, allDay: cell.allDay, index,
    end: cell.allDay ? shiftCalendarDay(start, span) : instantText(Date.parse(start) + span) });
  const rule = cell.rrule ? parseRecurrenceRule(cell.rrule, cell.allDay) : null;
  if (!rule) { yield make(cell.start, 0); return; }
  const exdates = new Set(cell.exdates ?? []);
  const zone = cell.allDay ? undefined : cell.timeZone ?? 'UTC';
  const wall = cell.allDay ? null : wallClock(Date.parse(cell.start), zone);
  const startDay = cell.allDay ? Date.parse(`${cell.start}T00:00:00Z`) / dayMs : dayNumber(wall![0], wall![1], wall![2]);
  const pointOf = (n: number) => {
    if (cell.allDay) return dayText(n);
    const [y, m, d] = fromDayNumber(n);
    return instantText(wallToInstant(y, m, d, wall![3], wall![4], wall![5], zone));
  };
  let index = 0;
  if (!exdates.has(cell.start)) yield make(cell.start, index);
  index++;
  let empty = 0;
  for (let k = 0; empty < 2000; k++) {
    const days = periodDays(rule, startDay, k).filter(n => n > startDay);
    if (!days.length) { empty++; continue; }
    empty = 0;
    for (const n of days) {
      if (rule.count !== undefined && index >= rule.count) return;
      const start = pointOf(n);
      if (rule.until !== undefined && start > rule.until) return;
      if (!exdates.has(start)) yield make(start, index);
      index++;
    }
  }
}

/** Occurrences touching the inclusive days for a reader, at most `limit`. */
export function dateOccurrences(cell: DateCell, range: DayRange, timeZone?: string, limit: number = dateCellLimits.occurrences): DateOccurrence[] {
  const out: DateOccurrence[] = [];
  let scanned = 0;
  for (const occurrence of iterateOccurrences(cell)) {
    if (++scanned > 200000) break;
    const days = dateCellDays({ start: occurrence.start, end: occurrence.end === occurrence.start ? undefined : occurrence.end, allDay: cell.allDay }, timeZone);
    if (days.from > range.to) break;
    if (days.to >= range.from) { out.push(occurrence); if (out.length >= limit) break; }
  }
  return out;
}

export interface DateReminder { occurrenceStart: string; at: number; minutes: number }

/** Reminder moments in [from, to). All-day reminders count from midnight of the day in the reader's zone. */
export function dateCellReminders(cell: DateCell, from: number, to: number, timeZone?: string): DateReminder[] {
  if (!cell.reminders?.length) return [];
  const before = Math.max(...cell.reminders) * 60000;
  const after = Math.max(0, -Math.min(...cell.reminders)) * 60000;
  const range = { from: zonedDay(from - after - dayMs, timeZone), to: zonedDay(to + before + dayMs, timeZone) };
  const out: DateReminder[] = [];
  for (const occurrence of dateOccurrences(cell, range, timeZone)) {
    const base = cell.allDay ? dayStartInstant(occurrence.start, timeZone) : Date.parse(occurrence.start);
    for (const minutes of cell.reminders) {
      const at = base - minutes * 60000;
      if (at >= from && at < to) out.push({ occurrenceStart: occurrence.start, at, minutes });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------------------------------------
// Editing a recurring series

export type RecurrenceEditScope = 'this' | 'following' | 'all';

export interface SeriesChange {
  /** New value of the series row; null means the row goes to the trash. */
  series: string | null;
  /** Value for a new row that takes the edited occurrences, copying the series row's title and fields. */
  detached?: string;
}

function shiftPoint(point: string, allDay: boolean, delta: number): string {
  return allDay ? shiftCalendarDay(point, delta) : instantText(Date.parse(point) + delta);
}

function delta(from: string, to: string, allDay: boolean): number {
  return allDay ? daysBetween(from, to) : Date.parse(to) - Date.parse(from);
}

/** Occurrences of a series that start before `start`, counting removed ones, as COUNT does. */
function countBefore(cell: DateCell, start: string): number {
  let n = 0;
  for (const occurrence of iterateOccurrences({ ...cell, exdates: undefined })) {
    if (occurrence.start >= start || n > dateCellLimits.count) break;
    n++;
  }
  return n;
}

function ended(rule: RecurrenceRule, before: string, allDay: boolean, count: number | undefined): RecurrenceRule {
  const { count: _c, until: _u, ...rest } = rule;
  if (count !== undefined) return { ...rest, count };
  return { ...rest, until: allDay ? shiftCalendarDay(before, -1) : instantText(Date.parse(before) - 1000) };
}

/**
 * Applies a move or resize of one occurrence. `next` is the occurrence's new span; for 'all' the whole
 * series moves by the same amount and takes the new duration. Changing between all-day and timed is
 * allowed: the series then restarts at the edited occurrence and removed occurrences are dropped,
 * because their kind no longer fits.
 */
export function editOccurrence(value: string, occurrenceStart: string, next: Pick<DateCell, 'start' | 'end' | 'allDay'>,
  scope: RecurrenceEditScope): SeriesChange | null {
  const cell = parseDateCell(value);
  if (!cell) return null;
  const zone = next.allDay ? {} : { timeZone: cell.timeZone };
  const length = next.end === undefined ? 0 : delta(next.start, next.end, next.allDay);
  const endFor = (start: string) => length > 0 ? shiftPoint(start, next.allDay, length) : undefined;
  if (!cell.rrule || scope === 'this') {
    const detached = formatDateCell({ start: next.start, end: endFor(next.start), allDay: next.allDay, ...zone, reminders: cell.reminders });
    if (!cell.rrule) return detached ? { series: detached } : null;
    const series = formatDateCell({ ...cell, exdates: [...(cell.exdates ?? []), occurrenceStart] });
    return series && detached ? { series, detached } : null;
  }
  const rule = parseRecurrenceRule(cell.rrule, cell.allDay)!;
  const sameKind = next.allDay === cell.allDay;
  const moved = (seriesStart: string, base: RecurrenceRule, exdates: string[]): string | null => {
    const shift = sameKind ? delta(occurrenceStart, next.start, cell.allDay) : 0;
    const start = sameKind ? shiftPoint(seriesStart, cell.allDay, shift) : next.start;
    const r: RecurrenceRule = { ...base };
    if (r.until !== undefined) { if (sameKind) r.until = shiftPoint(r.until, cell.allDay, shift); else delete r.until; }
    // A weekly rule on one weekday follows the event to its new weekday.
    if (sameKind && r.freq === 'WEEKLY' && r.byDay?.length === 1) {
      const dayOf = (point: string) => cell.allDay ? point : zonedDay(Date.parse(point), cell.timeZone ?? 'UTC');
      const wd = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
      if (wd(dayOf(occurrenceStart)) !== wd(dayOf(next.start))) r.byDay = [{ day: wd(dayOf(next.start)) }];
    }
    return formatDateCell({ start, end: endFor(start), allDay: next.allDay, ...zone, rrule: formatRecurrenceRule(r),
      exdates: sameKind ? exdates.map(point => shiftPoint(point, cell.allDay, shift)) : [], reminders: cell.reminders });
  };
  if (scope === 'all' || occurrenceStart <= cell.start) {
    const series = moved(cell.start, rule, cell.exdates ?? []);
    return series ? { series } : null;
  }
  const before = countBefore(cell, occurrenceStart);
  const head = formatDateCell({ ...cell, rrule: formatRecurrenceRule(ended(rule, occurrenceStart, cell.allDay, rule.count !== undefined ? before : undefined)),
    exdates: (cell.exdates ?? []).filter(point => point < occurrenceStart) });
  const tailRule: RecurrenceRule = rule.count !== undefined ? { ...rule, count: Math.max(1, rule.count - before) } : rule;
  const detached = moved(occurrenceStart, tailRule, (cell.exdates ?? []).filter(point => point > occurrenceStart));
  return head && detached ? { series: head, detached } : null;
}
/** Removes one occurrence, it and the ones after it, or the whole series (series becomes null). */
export function deleteOccurrence(value: string, occurrenceStart: string, scope: RecurrenceEditScope): SeriesChange | null {
  const cell = parseDateCell(value);
  if (!cell) return null;
  if (!cell.rrule || scope === 'all' || (scope === 'following' && occurrenceStart <= cell.start)) return { series: null };
  if (scope === 'this') {
    const series = formatDateCell({ ...cell, exdates: [...(cell.exdates ?? []), occurrenceStart] });
    return series ? { series } : null;
  }
  const rule = parseRecurrenceRule(cell.rrule, cell.allDay)!;
  const series = formatDateCell({ ...cell, rrule: formatRecurrenceRule(ended(rule, occurrenceStart, cell.allDay,
    rule.count !== undefined ? countBefore(cell, occurrenceStart) : undefined)), exdates: (cell.exdates ?? []).filter(point => point < occurrenceStart) });
  return series ? { series } : null;
}
