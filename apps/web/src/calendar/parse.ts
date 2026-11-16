import { formatDateCell, isCalendarDay, isDateCellValue, wallClock, wallToInstant } from '@nbase/contracts';
import { readerTimeZone } from './model';

type Point = { allDay: true; day: string } | { allDay: false; ms: number };

const dayPattern = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/;
const dayTimePattern = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+|T)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const timePattern = /^(\d{1,2})[:：](\d{2})$/;
const separators = ['→', '->', '~', '～', ' - ', ' – ', ' — ', '至', ' to '];

const pad = (n: number) => String(n).padStart(2, '0');

function dayOf(y: string, m: string, d: string): string | null {
  const day = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isCalendarDay(day) ? day : null;
}

function wallTime(day: string, hour: number, minute: number, second: number, timeZone: string): number | null {
  if (hour > 23 || minute > 59 || second > 59) return null;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return wallToInstant(y, m, d, hour, minute, second, timeZone);
}

function parsePoint(text: string, timeZone: string): Point | null {
  let match = dayPattern.exec(text);
  if (match) { const day = dayOf(match[1]!, match[2]!, match[3]!); return day ? { allDay: true, day } : null; }
  match = dayTimePattern.exec(text);
  if (match) {
    const day = dayOf(match[1]!, match[2]!, match[3]!);
    const ms = day && wallTime(day, Number(match[4]), Number(match[5]), Number(match[6] ?? 0), timeZone);
    return typeof ms === 'number' ? { allDay: false, ms } : null;
  }
  if (isoPattern.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : { allDay: false, ms: Math.floor(ms / 1000) * 1000 };
  }
  return null;
}

function parseEnd(text: string, start: Point, timeZone: string): Point | null {
  const time = timePattern.exec(text);
  if (time && !start.allDay) {
    const [y, m, d] = wallClock(start.ms, timeZone);
    const ms = wallTime(`${y}-${pad(m)}-${pad(d)}`, Number(time[1]), Number(time[2]), 0, timeZone);
    return ms === null ? null : { allDay: false, ms };
  }
  return parsePoint(text, timeZone);
}

function build(start: Point, end: Point | null, timeZone: string): string | null {
  if (end && end.allDay !== start.allDay) return null;
  if (start.allDay) {
    const last = end?.allDay ? end.day : undefined;
    if (last !== undefined && last < start.day) return null;
    return formatDateCell({ start: start.day, end: last, allDay: true });
  }
  const until = end && !end.allDay ? end.ms : undefined;
  if (until !== undefined && until <= start.ms) return null;
  const text = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
  return formatDateCell({ start: text(start.ms), end: until === undefined ? undefined : text(until), allDay: false, timeZone });
}

/**
 * Reads typed or pasted text as a date value: stored values as they are, and lenient forms such as `2026/1/5`,
 * `2026-01-05 09:30` (the reader's local time) or two of them joined by `→`, ` - `, `~` or `/`. Returns the
 * canonical value, or null when the text is not a date.
 */
export function parseDateText(raw: string, timeZone: string = readerTimeZone()): string | null {
  const text = raw.trim();
  if (!text) return null;
  // The guard would narrow `text` to never below, since every string that is not a value is still a string.
  const stored: unknown = text;
  if (isDateCellValue(stored)) return text;
  const single = parsePoint(text, timeZone);
  if (single) return build(single, null, timeZone);
  for (const mark of separators) {
    const at = text.indexOf(mark);
    if (at <= 0) continue;
    const start = parsePoint(text.slice(0, at).trim(), timeZone);
    const end = start && parseEnd(text.slice(at + mark.length).trim(), start, timeZone);
    if (start && end) return build(start, end, timeZone);
  }
  // A slash also separates parts of a day, so try each one as the boundary.
  for (let at = text.indexOf('/'); at > 0; at = text.indexOf('/', at + 1)) {
    const start = parsePoint(text.slice(0, at).trim(), timeZone);
    const end = start && parseEnd(text.slice(at + 1).trim(), start, timeZone);
    if (start && end) return build(start, end, timeZone);
  }
  return null;
}
