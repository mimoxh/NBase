import { daysBetween, shiftCalendarDay, wallClock, wallToInstant, type DayRange } from '@nbase/contracts';
import { compareEvents, isSpanning, type CalendarEvent } from './model';

export const calendarModes = ['month', 'week', 'day', 'agenda'] as const;
export type CalendarMode = typeof calendarModes[number];
/** 0 is Sunday, 1 is Monday, as in the query context. */
export type WeekStart = 0 | 1;
export const agendaPageDays = 30;
/** Ranges must stay under the query's 400-day limit. */
export const agendaMaxDays = 399;
export const minutesPerDay = 1440;

export function isCalendarMode(value: unknown): value is CalendarMode {
  return typeof value === 'string' && (calendarModes as readonly string[]).includes(value);
}

/** 0 is Sunday. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function startOfWeek(day: string, weekStart: WeekStart): string {
  return shiftCalendarDay(day, -((weekdayOf(day) - weekStart + 7) % 7));
}

export function weekDays(day: string, weekStart: WeekStart): string[] {
  const first = startOfWeek(day, weekStart);
  return Array.from({ length: 7 }, (_, i) => shiftCalendarDay(first, i));
}

export function shiftMonth(month: string, by: number): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, value - 1 + by, 1)).toISOString().slice(0, 7);
}

export function lastDayOfMonth(month: string): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
}

/** Whole weeks covering a month. */
export function monthWeeks(month: string, weekStart: WeekStart): string[][] {
  const last = lastDayOfMonth(month);
  const weeks: string[][] = [];
  for (let first = startOfWeek(`${month}-01`, weekStart); first <= last; first = shiftCalendarDay(first, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => shiftCalendarDay(first, i)));
  }
  return weeks;
}

/** Inclusive days a mode shows around the anchor day. */
export function visibleRange(mode: CalendarMode, anchor: string, weekStart: WeekStart, agendaDays = agendaPageDays): DayRange {
  switch (mode) {
    case 'month': { const weeks = monthWeeks(anchor.slice(0, 7), weekStart); return { from: weeks[0]![0]!, to: weeks.at(-1)![6]! }; }
    case 'week': { const days = weekDays(anchor, weekStart); return { from: days[0]!, to: days[6]! }; }
    case 'day': return { from: anchor, to: anchor };
    case 'agenda': return { from: anchor, to: shiftCalendarDay(anchor, Math.min(agendaMaxDays, Math.max(1, agendaDays)) - 1) };
  }
}

/** The anchor one page earlier or later. */
export function shiftAnchor(mode: CalendarMode, anchor: string, by: number): string {
  switch (mode) {
    case 'month': return `${shiftMonth(anchor.slice(0, 7), by)}-01`;
    case 'week': return shiftCalendarDay(anchor, 7 * by);
    case 'day': return shiftCalendarDay(anchor, by);
    case 'agenda': return shiftCalendarDay(anchor, agendaPageDays * by);
  }
}

/** The anchor after switching away from a mode: today when it is on screen, so a week or day opens where the reader is. */
export function anchorForMode(mode: CalendarMode, anchor: string, weekStart: WeekStart, today: string, agendaDays = agendaPageDays): string {
  const range = visibleRange(mode, anchor, weekStart, agendaDays);
  if (today >= range.from && today <= range.to) return today;
  return mode === 'month' ? `${anchor.slice(0, 7)}-01` : anchor;
}
// ---------------------------------------------------------------------------------------------------------
// Lanes for bars (month rows and the all-day lane)

export interface LaneBar {
  event: CalendarEvent;
  /** Column index of the first covered day in this row. */
  start: number;
  span: number;
  lane: number;
  /** The event starts before this row or ends after it. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface LaneLayout {
  /** Bars that fit. */
  bars: LaneBar[];
  /** Per column: how many events there are not shown. */
  more: number[];
  /** Per column: every event touching that day, in display order. */
  byColumn: CalendarEvent[][];
  /** Lanes in use, at most `maxLanes`. */
  lanes: number;
}

/**
 * Packs events into lanes over consecutive days. With a limit, a day that overflows gives its last lane to a
 * "+N" marker, so a bar on that lane is hidden for its whole length rather than cut in two.
 */
export function packLanes(events: readonly CalendarEvent[], days: readonly string[], maxLanes = Infinity): LaneLayout {
  const first = days[0], last = days.at(-1);
  const byColumn: CalendarEvent[][] = days.map(() => []);
  if (!first || !last) return { bars: [], more: [], byColumn, lanes: 0 };
  const placed: LaneBar[] = [];
  const items = events.filter(event => event.days.to >= first && event.days.from <= last).map(event => {
    const start = Math.max(0, daysBetween(first, event.days.from));
    const end = Math.min(days.length - 1, daysBetween(first, event.days.to));
    return { event, start, span: end - start + 1, clippedStart: event.days.from < first, clippedEnd: event.days.to > last };
  }).sort((a, b) => a.start - b.start || b.span - a.span || compareEvents(a.event, b.event));
  const occupied: boolean[][] = [];
  for (const item of items) {
    let lane = 0;
    for (; ; lane++) {
      const row = occupied[lane] ?? (occupied[lane] = []);
      let free = true;
      for (let c = item.start; c < item.start + item.span; c++) if (row[c]) { free = false; break; }
      if (free) { for (let c = item.start; c < item.start + item.span; c++) row[c] = true; break; }
    }
    placed.push({ ...item, lane });
    for (let c = item.start; c < item.start + item.span; c++) byColumn[c]!.push(item.event);
  }
  const totals = byColumn.map(list => list.length);
  const visible = (bar: LaneBar) => {
    if (bar.lane < maxLanes - 1) return true;
    if (bar.lane > maxLanes - 1) return false;
    for (let c = bar.start; c < bar.start + bar.span; c++) if (totals[c]! > maxLanes) return false;
    return true;
  };
  const bars = placed.filter(visible);
  const shown = days.map(() => 0);
  for (const bar of bars) for (let c = bar.start; c < bar.start + bar.span; c++) shown[c]! += 1;
  const more = totals.map((total, c) => total - shown[c]!);
  const used = placed.reduce((max, bar) => Math.max(max, bar.lane + 1), 0);
  return { bars, more, byColumn: byColumn.map(list => [...list].sort(compareEvents)), lanes: Math.min(used, maxLanes) };
}

// ---------------------------------------------------------------------------------------------------------
// Time grid

/** Wall-clock minutes since midnight of `day` for a moment in a zone; 0 before the day, 1440 after it. */
export function minutesInDay(ms: number, day: string, timeZone?: string): number {
  const [y, m, d, h, min] = wallClock(ms, timeZone);
  const wallDay = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (wallDay < day) return 0;
  if (wallDay > day) return minutesPerDay;
  return h * 60 + min;
}

/** The moment at wall-clock minutes of a day in a zone; 1440 is midnight of the next day. */
export function instantAt(day: string, minutes: number, timeZone?: string): number {
  const whole = Math.max(0, Math.min(minutesPerDay, Math.round(minutes)));
  const target = whole === minutesPerDay ? shiftCalendarDay(day, 1) : day;
  const [y, m, d] = target.split('-').map(Number) as [number, number, number];
  const rest = whole % minutesPerDay;
  return wallToInstant(y, m, d, Math.floor(rest / 60), rest % 60, 0, timeZone);
}

export function snapMinutes(minutes: number, step = 15, mode: 'round' | 'floor' = 'round'): number {
  const snapped = (mode === 'floor' ? Math.floor(minutes / step) : Math.round(minutes / step)) * step;
  return Math.max(0, Math.min(minutesPerDay, snapped));
}

export interface TimedBlock {
  event: CalendarEvent;
  /** Minutes since midnight. */
  top: number;
  bottom: number;
  column: number;
  columns: number;
}

/**
 * Timed events of one day placed side by side where they overlap. Short or zero-length events take
 * `minLength` minutes, so they stay clickable and do not hide under neighbours.
 */
export function layoutTimed(events: readonly CalendarEvent[], day: string, timeZone?: string, minLength = 30): TimedBlock[] {
  const items = events.filter(event => !isSpanning(event) && event.days.from === day).map(event => {
    const top = Math.min(minutesPerDay - minLength, minutesInDay(event.startMs, day, timeZone));
    const bottom = Math.min(minutesPerDay, Math.max(top + minLength, minutesInDay(event.endMs, day, timeZone)));
    return { event, top, bottom };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom || compareEvents(a.event, b.event));
  const out: TimedBlock[] = [];
  let cluster: TimedBlock[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => { for (const block of cluster) block.columns = columnEnds.length; cluster = []; columnEnds = []; };
  for (const item of items) {
    if (item.top >= clusterEnd) close();
    let column = columnEnds.findIndex(end => end <= item.top);
    if (column < 0) { column = columnEnds.length; columnEnds.push(item.bottom); } else columnEnds[column] = item.bottom;
    const block: TimedBlock = { ...item, column, columns: 1 };
    cluster.push(block);
    out.push(block);
    clusterEnd = Math.max(clusterEnd, item.bottom);
  }
  close();
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Agenda

export interface AgendaDay { day: string; events: CalendarEvent[] }

/** Days with events; an event spanning several days appears on each of them. */
export function groupByDay(events: readonly CalendarEvent[], range: DayRange): AgendaDay[] {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const from = event.days.from > range.from ? event.days.from : range.from;
    const to = event.days.to < range.to ? event.days.to : range.to;
    for (let day = from; day <= to; day = shiftCalendarDay(day, 1)) map.set(day, [...(map.get(day) ?? []), event]);
  }
  return [...map.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([day, list]) => ({ day, events: list.sort((a, b) => {
    const spanA = isSpanning(a), spanB = isSpanning(b);
    if (spanA !== spanB) return spanA ? -1 : 1;
    return a.startMs - b.startMs || compareEvents(a, b);
  }) }));
}
