import { dateCellDays, dateOccurrences, dayStartInstant, formatDateCell, instantText, parseDateCell, shiftCalendarDay, zonedDay, type DateCell,
  type DayRange, type OptionColor } from '@nbase/contracts';

/** The zone the reader's browser is in; days of timed values are taken in it. */
export function readerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function todayIn(timeZone?: string, now = Date.now()): string {
  return zonedDay(now, timeZone);
}

/** `date` is a date cell value; `moment` is an ISO time such as a page's creation time, shown without duration. */
export type CalendarEventKind = 'date' | 'moment';

export interface CalendarEventInput {
  /** Who the value belongs to, e.g. a database and property; part of each occurrence's key. */
  sourceId: string;
  rowId: string;
  title: string;
  icon?: string | null | undefined;
  color?: OptionColor | undefined;
  value: string;
  kind?: CalendarEventKind | undefined;
  readOnly?: boolean | undefined;
}

/** One occurrence of a value on the calendar. */
export interface CalendarEvent {
  /** Stable across renders: source, row and occurrence start. */
  key: string;
  sourceId: string;
  rowId: string;
  title: string;
  icon: string | null;
  color: OptionColor | null;
  allDay: boolean;
  /** All-day: the first day. Timed: a canonical instant. */
  start: string;
  /** All-day: the last day, included. Timed: the end instant, not included; equal to `start` without duration. */
  end: string;
  hasEnd: boolean;
  startMs: number;
  /** For all-day events, midnight after the last day in the reader's zone. */
  endMs: number;
  /** Days the occurrence covers for the reader. */
  days: DayRange;
  recurring: boolean;
  occurrenceStart: string;
  occurrenceIndex: number;
  hasReminders: boolean;
  /** The stored value the occurrence came from. */
  value: string;
  /** Null for moments. */
  cell: DateCell | null;
  readOnly: boolean;
}

/** Events that sit in the all-day lane of the time grid, and as bars in month rows. */
export function isSpanning(event: CalendarEvent): boolean {
  return event.allDay || event.days.from !== event.days.to;
}

export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.days.from !== b.days.from) return a.days.from < b.days.from ? -1 : 1;
  const spanA = isSpanning(a), spanB = isSpanning(b);
  if (spanA !== spanB) return spanA ? -1 : 1;
  if (a.days.to !== b.days.to) return a.days.to > b.days.to ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.endMs !== b.endMs) return b.endMs - a.endMs;
  const title = a.title.localeCompare(b.title, 'zh-Hans-CN');
  return title || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Expands values into the occurrences that touch the inclusive days, in the reader's zone. Values that are
 * not valid date cells (or ISO times for moments) are skipped. `perValue` bounds a single series.
 */
export function buildEvents(inputs: readonly CalendarEventInput[], range: DayRange, timeZone?: string, perValue = 400): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const input of inputs) {
    const base = { sourceId: input.sourceId, rowId: input.rowId, title: input.title, icon: input.icon ?? null, color: input.color ?? null, value: input.value };
    if (input.kind === 'moment') {
      const ms = Date.parse(input.value);
      if (Number.isNaN(ms)) continue;
      const day = zonedDay(ms, timeZone);
      if (day < range.from || day > range.to) continue;
      const start = instantText(ms);
      out.push({ ...base, key: `${input.sourceId}|${input.rowId}|${start}`, allDay: false, start, end: start, hasEnd: false, startMs: ms, endMs: ms,
        days: { from: day, to: day }, recurring: false, occurrenceStart: start, occurrenceIndex: 0, hasReminders: false, cell: null, readOnly: true });
      continue;
    }
    const cell = parseDateCell(input.value);
    if (!cell) continue;
    for (const occurrence of dateOccurrences(cell, range, timeZone, perValue)) {
      const hasEnd = occurrence.end !== occurrence.start;
      const days = dateCellDays({ start: occurrence.start, end: hasEnd ? occurrence.end : undefined, allDay: cell.allDay }, timeZone);
      const startMs = cell.allDay ? dayStartInstant(occurrence.start, timeZone) : Date.parse(occurrence.start);
      const endMs = cell.allDay ? dayStartInstant(shiftCalendarDay(occurrence.end, 1), timeZone) : Date.parse(occurrence.end);
      out.push({ ...base, key: `${input.sourceId}|${input.rowId}|${occurrence.start}`, allDay: cell.allDay, start: occurrence.start, end: occurrence.end,
        hasEnd, startMs, endMs, days, recurring: Boolean(cell.rrule), occurrenceStart: occurrence.start, occurrenceIndex: occurrence.index,
        hasReminders: Boolean(cell.reminders?.length), cell, readOnly: Boolean(input.readOnly) });
    }
  }
  return out.sort(compareEvents);
}

/** The occurrence shown at a new span while it is dragged; keeps its key so it stays the same element. */
export function withSpan(event: CalendarEvent, span: Pick<DateCell, 'start' | 'end' | 'allDay'>, range: DayRange, timeZone?: string): CalendarEvent | null {
  const value = formatDateCell({ start: span.start, end: span.end, allDay: span.allDay });
  if (!value) return null;
  const [moved] = buildEvents([{ sourceId: event.sourceId, rowId: event.rowId, title: event.title, icon: event.icon, color: event.color ?? undefined, value }],
    range, timeZone, 1);
  return moved ? { ...moved, key: event.key, recurring: event.recurring, hasReminders: event.hasReminders, value: event.value, cell: event.cell,
    occurrenceStart: event.occurrenceStart, occurrenceIndex: event.occurrenceIndex, readOnly: event.readOnly } : null;
}
