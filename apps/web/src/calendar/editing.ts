import { daysBetween, deleteOccurrence, editOccurrence, formatDateCell, instantText, parseDateCell, shiftCalendarDay, wallClock, wallToInstant,
  type DateCell, type RecurrenceEditScope } from '@nbase/contracts';
import { instantAt, minutesPerDay, snapMinutes } from './layout';
import type { CalendarEvent } from './model';

/** The new span of an occurrence, the shape `editOccurrence` takes. */
export type EventSpan = Pick<DateCell, 'start' | 'end' | 'allDay'>;
/** Where a drag ends: a day of an all-day area, or a moment on the time grid. */
export type DropTarget = { allDay: true; day: string } | { allDay: false; ms: number };

export const defaultEventMinutes = 60;
export const minimumEventMinutes = 15;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Moves a moment by whole days on the wall clock of a zone, so it keeps its time of day across clock changes. */
export function shiftInstantDays(ms: number, days: number, timeZone?: string): number {
  const [y, m, d, h, min, s] = wallClock(ms, timeZone);
  const [ny, nm, nd] = shiftCalendarDay(`${pad(y, 4)}-${pad(m)}-${pad(d)}`, days).split('-').map(Number) as [number, number, number];
  return wallToInstant(ny, nm, nd, h, min, s, timeZone);
}

export function eventSpan(event: CalendarEvent): EventSpan {
  return { start: event.start, end: event.hasEnd ? event.end : undefined, allDay: event.allDay };
}

export function sameSpan(a: EventSpan, b: EventSpan): boolean {
  return a.start === b.start && (a.end ?? '') === (b.end ?? '') && a.allDay === b.allDay;
}

/** The occurrence moved by whole days, as in month rows. */
export function shiftedSpan(event: CalendarEvent, days: number, timeZone?: string): EventSpan {
  if (event.allDay) {
    return { start: shiftCalendarDay(event.start, days), end: event.hasEnd ? shiftCalendarDay(event.end, days) : undefined, allDay: true };
  }
  return { start: instantText(shiftInstantDays(event.startMs, days, timeZone)),
    end: event.hasEnd ? instantText(shiftInstantDays(event.endMs, days, timeZone)) : undefined, allDay: false };
}

/**
 * The occurrence dropped on a target. Timed events keep their duration; an all-day event dropped on the time
 * grid becomes `defaultMinutes` long; a timed event dropped on an all-day area keeps how many days it covers.
 */
export function movedSpan(event: CalendarEvent, target: DropTarget, timeZone?: string, defaultMinutes = defaultEventMinutes): EventSpan {
  if (target.allDay) {
    if (event.allDay) return shiftedSpan(event, daysBetween(event.start, target.day), timeZone);
    const length = daysBetween(event.days.from, event.days.to);
    return { start: target.day, end: length > 0 ? shiftCalendarDay(target.day, length) : undefined, allDay: true };
  }
  if (!event.allDay) {
    const length = event.endMs - event.startMs;
    return { start: instantText(target.ms), end: event.hasEnd ? instantText(target.ms + length) : undefined, allDay: false };
  }
  return { start: instantText(target.ms), end: instantText(target.ms + defaultMinutes * 60000), allDay: false };
}

/**
 * The occurrence with its end dragged to a target: a day for all-day events and month rows, a moment on the time
 * grid. Returns null when the target does not fit the event.
 */
export function resizedSpan(event: CalendarEvent, target: DropTarget, timeZone?: string): EventSpan | null {
  if (event.allDay) {
    if (!target.allDay) return null;
    const end = target.day < event.start ? event.start : target.day;
    return { start: event.start, end: end === event.start ? undefined : end, allDay: true };
  }
  if (target.allDay) {
    const end = shiftInstantDays(event.hasEnd ? event.endMs : event.startMs, daysBetween(event.days.to, target.day), timeZone);
    return end > event.startMs ? { start: event.start, end: instantText(end), allDay: false } : null;
  }
  const end = Math.max(target.ms, event.startMs + minimumEventMinutes * 60000);
  return { start: event.start, end: instantText(end), allDay: false };
}

/** Values to write: the series row (null sends it to the trash) and, when set, a new row for detached occurrences. */
export interface EventWrite { series: string | null; detached?: string | undefined }

/**
 * Applies a new span to one occurrence with `editOccurrence`; single events ignore the scope. An all-day value that
 * becomes timed gets the reader's zone, which `editOccurrence` cannot know.
 */
export function applyEventChange(event: CalendarEvent, next: EventSpan, scope: RecurrenceEditScope, readerZone: string): EventWrite | null {
  if (!event.cell) return null;
  const change = editOccurrence(event.value, event.occurrenceStart, next, event.recurring ? scope : 'this');
  if (!change) return null;
  const zoned = (value: string) => {
    if (!event.allDay || next.allDay) return value;
    const cell = parseDateCell(value);
    return cell && !cell.allDay && !cell.timeZone ? formatDateCell({ ...cell, timeZone: readerZone }) ?? value : value;
  };
  return { series: change.series === null ? null : zoned(change.series), ...(change.detached ? { detached: zoned(change.detached) } : {}) };
}

export function applyEventDelete(event: CalendarEvent, scope: RecurrenceEditScope): EventWrite | null {
  if (!event.cell) return null;
  return deleteOccurrence(event.value, event.occurrenceStart, event.recurring ? scope : 'all');
}

/** Value for an event created on the calendar; timed ones carry the reader's zone. */
export function newEventValue(span: EventSpan, readerZone: string): string | null {
  return formatDateCell({ start: span.start, end: span.end, allDay: span.allDay, ...(span.allDay ? {} : { timeZone: readerZone }) });
}

/** Where the pointer is during a drag: a day of the month grid or all-day lane, or a moment of a time grid column. */
export type DragHit = { area: 'day'; day: string } | { area: 'time'; day: string; minutes: number };
/** Where the dragged occurrence is drawn: month rows, the all-day lane of a time grid, or a time grid column. */
export type DragOrigin = 'month' | 'lane' | 'grid';

export interface DragSession {
  event: CalendarEvent;
  kind: 'move' | 'resize';
  origin: DragOrigin;
  /** Day under the pointer when the drag began. */
  grabDay: string;
  /** Time grid moves: minutes between the pointer and the occurrence's start, so the event does not jump. */
  grabOffset: number;
}

/** The span a drag leads to with the pointer over a target, or null when the target does not fit. */
export function dragSpan(session: DragSession, hit: DragHit, timeZone?: string, step = 15): EventSpan | null {
  const { event } = session;
  if (session.kind === 'resize') {
    if (hit.area === 'day') return session.origin === 'grid' ? null : resizedSpan(event, { allDay: true, day: hit.day }, timeZone);
    if (session.origin !== 'grid') return null;
    return resizedSpan(event, { allDay: false, ms: instantAt(hit.day, snapMinutes(hit.minutes, step), timeZone) }, timeZone);
  }
  if (hit.area === 'day') {
    if (session.origin === 'grid') return movedSpan(event, { allDay: true, day: hit.day }, timeZone);
    return shiftedSpan(event, daysBetween(session.grabDay, hit.day), timeZone);
  }
  const offset = session.origin === 'grid' ? session.grabOffset : 0;
  const minutes = Math.min(minutesPerDay - step, snapMinutes(hit.minutes - offset, step));
  return movedSpan(event, { allDay: false, ms: instantAt(hit.day, minutes, timeZone) }, timeZone);
}
