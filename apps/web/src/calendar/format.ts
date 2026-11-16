import { isCalendarDay, parseDateCell, parseRecurrenceRule, wallClock, zonedDay, type DateCell, type DayRange, type RecurrenceRule } from '@nbase/contracts';
import type { CalendarMode } from './layout';
import type { CalendarEvent } from './model';

/** By `Date#getUTCDay`, 0 is Sunday. */
const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
/** By recurrence weekday, 0 is Monday. */
const ruleWeekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
const ordinals = ['一', '二', '三', '四', '五'];
const pad = (n: number) => String(n).padStart(2, '0');

export const timedReminderOptions = [0, 5, 10, 15, 30, 60, 1440] as const;
/** Minutes before midnight of the day: on the day at 09:00, the day before at 09:00, two days and a week before. */
export const allDayReminderOptions = [-540, 900, 2340, 9540] as const;

export function weekdayLabel(day: string): string {
  return `周${weekdayNames[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;
}

export function ruleWeekdayLabel(index: number): string {
  return ruleWeekdayNames[index] ?? '';
}

/** `11月16日`; the year is added when it differs from `today`'s, or always with `year: true`. */
export function formatDay(day: string, options: { today?: string | undefined; year?: boolean | undefined; weekday?: boolean | undefined } = {}): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const year = options.year ?? (options.today !== undefined && options.today.slice(0, 4) !== day.slice(0, 4));
  const text = `${year ? `${y}年` : ''}${m}月${d}日`;
  return options.weekday ? `${text} ${weekdayLabel(day)}` : text;
}

export function formatClock(ms: number, timeZone?: string): string {
  const [, , , h, min] = wallClock(ms, timeZone);
  return `${pad(h)}:${pad(min)}`;
}

/** Display text of a date cell for a reader, e.g. `11月16日 09:00–10:00` or `11月16日 → 11月18日`. */
export function formatDateCellText(cell: Pick<DateCell, 'start' | 'end' | 'allDay'>, timeZone?: string, today?: string): string {
  if (cell.allDay) {
    const head = formatDay(cell.start, { today });
    if (!cell.end) return head;
    const crossYear = cell.start.slice(0, 4) !== cell.end.slice(0, 4);
    return `${crossYear ? formatDay(cell.start, { year: true }) : head} → ${formatDay(cell.end, { year: crossYear })}`;
  }
  const startMs = Date.parse(cell.start);
  const startDay = zonedDay(startMs, timeZone);
  const head = `${formatDay(startDay, { today })} ${formatClock(startMs, timeZone)}`;
  if (!cell.end) return head;
  const endMs = Date.parse(cell.end);
  const endDay = zonedDay(endMs, timeZone);
  if (endDay === startDay) return `${head}–${formatClock(endMs, timeZone)}`;
  const crossYear = startDay.slice(0, 4) !== endDay.slice(0, 4);
  return `${crossYear ? `${formatDay(startDay, { year: true })} ${formatClock(startMs, timeZone)}` : head} → ${formatDay(endDay, { year: crossYear })} ${formatClock(endMs, timeZone)}`;
}

/** Display text of a stored value; values that are not date cells come back as they are. */
export function formatDateValue(value: string, timeZone?: string, today?: string): string {
  const cell = parseDateCell(value);
  return cell ? formatDateCellText(cell, timeZone, today) : value;
}

/** Time part for chips and lists: `全天`, `09:00–10:00`, or both days for a timed event spanning days. */
export function formatEventTime(event: CalendarEvent, timeZone?: string): string {
  if (event.allDay) return '全天';
  const start = formatClock(event.startMs, timeZone);
  if (event.days.from !== event.days.to) {
    return `${formatDay(event.days.from)} ${start} → ${formatDay(event.days.to)} ${formatClock(event.endMs, timeZone)}`;
  }
  return event.hasEnd ? `${start}–${formatClock(event.endMs, timeZone)}` : start;
}

export function eventLabel(event: CalendarEvent, timeZone?: string): string {
  const day = event.allDay && event.days.from !== event.days.to
    ? `${formatDay(event.days.from)} → ${formatDay(event.days.to)}` : formatDay(event.days.from);
  return `${event.title || '未命名'}，${day} ${formatEventTime(event, timeZone)}${event.recurring ? '，重复' : ''}${event.readOnly ? '，只读' : ''}`;
}

function ordinal(n: number): string {
  if (n === -1) return '最后一个';
  if (n < 0) return `倒数第${ordinals[-n - 1] ?? -n}个`;
  return `第${ordinals[n - 1] ?? n}个`;
}

function monthDayText(d: number): string {
  if (d === -1) return '最后一天';
  return d < 0 ? `倒数第 ${-d} 天` : `${d} 日`;
}

function ruleBody(rule: RecurrenceRule): string | null {
  const n = rule.interval;
  if (rule.bySetPos) return null;
  const plainDays = rule.byDay?.every(w => w.nth === undefined) ?? true;
  switch (rule.freq) {
    case 'DAILY':
      if (rule.byDay || rule.byMonthDay || rule.byMonth) return null;
      return n === 1 ? '每天' : `每 ${n} 天`;
    case 'WEEKLY': {
      if (rule.byMonth || !plainDays) return null;
      if (!rule.byDay) return n === 1 ? '每周' : `每 ${n} 周`;
      const days = rule.byDay.map(w => w.day);
      if (n === 1 && days.join() === '0,1,2,3,4') return '工作日';
      const list = days.map(ruleWeekdayLabel).join('、');
      return n === 1 ? `每周${list}` : `每 ${n} 周的周${list}`;
    }
    case 'MONTHLY': {
      if (rule.byMonth) return null;
      const lead = n === 1 ? '每月' : `每 ${n} 个月的`;
      if (rule.byMonthDay && !rule.byDay) return `${lead}${n === 1 ? ' ' : ''}${rule.byMonthDay.map(monthDayText).join('、')}`;
      if (rule.byDay && !rule.byMonthDay) {
        if (rule.byDay.some(w => w.nth === undefined)) return null;
        return `${lead}${rule.byDay.map(w => `${ordinal(w.nth!)}周${ruleWeekdayLabel(w.day)}`).join('、')}`;
      }
      return rule.byDay || rule.byMonthDay ? null : n === 1 ? '每月' : `每 ${n} 个月`;
    }
    case 'YEARLY': {
      const lead = n === 1 ? '每年' : `每 ${n} 年的`;
      if (!rule.byMonth && !rule.byDay && !rule.byMonthDay) return n === 1 ? '每年' : `每 ${n} 年`;
      if (rule.byMonth?.length === 1 && rule.byMonthDay?.length === 1 && !rule.byDay && rule.byMonthDay[0]! > 0) {
        return `${lead} ${rule.byMonth[0]}月${rule.byMonthDay[0]}日`;
      }
      if (rule.byMonth?.length === 1 && rule.byDay?.length === 1 && rule.byDay[0]!.nth !== undefined && !rule.byMonthDay) {
        return `${lead} ${rule.byMonth[0]}月${ordinal(rule.byDay[0]!.nth)}周${ruleWeekdayLabel(rule.byDay[0]!.day)}`;
      }
      return null;
    }
  }
}

/** Short description of a rule, e.g. `每周一、三`, `每月第二个周一，共 10 次`. Unusual rules say so instead of guessing. */
export function recurrenceSummary(rrule: string, allDay: boolean, timeZone?: string, today?: string): string {
  const rule = parseRecurrenceRule(rrule, allDay);
  if (!rule) return '重复';
  const fallback = { DAILY: '按天', WEEKLY: '按周', MONTHLY: '按月', YEARLY: '按年' }[rule.freq];
  let text = ruleBody(rule) ?? `${fallback}重复（自定义规则）`;
  if (rule.count !== undefined) text += `，共 ${rule.count} 次`;
  if (rule.until !== undefined) {
    const day = allDay ? rule.until : zonedDay(Date.parse(rule.until), timeZone);
    text += `，至 ${formatDay(day, { today })}`;
  }
  return text;
}

/** `准时`, `10 分钟前`, `前一天 9:00`… */
export function formatReminder(minutes: number, allDay: boolean): string {
  const clock = (m: number) => `${Math.floor(m / 60)}:${pad(m % 60)}`;
  if (!allDay) {
    if (minutes === 0) return '准时';
    if (minutes % 1440 === 0) return `${minutes / 1440} 天前`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时前`;
    return `${minutes} 分钟前`;
  }
  if (minutes <= 0) return `当天 ${clock(-minutes)}`;
  const days = Math.ceil(minutes / 1440);
  const time = days * 1440 - minutes;
  return days === 1 ? `前一天 ${clock(time)}` : `${days} 天前 ${clock(time)}`;
}

function spanTitle(range: DayRange): string {
  const [fy, fm] = range.from.split('-').map(Number) as [number, number];
  const [ty, tm, td] = range.to.split('-').map(Number) as [number, number, number];
  const head = formatDay(range.from, { year: true });
  if (range.from === range.to) return head;
  if (fy !== ty) return `${head}–${formatDay(range.to, { year: true })}`;
  return fm === tm ? `${head}–${td}日` : `${head}–${formatDay(range.to)}`;
}

/** Heading of the calendar for the days on screen. */
export function calendarTitle(mode: CalendarMode, anchor: string, range: DayRange): string {
  if (mode === 'month') { const [y, m] = anchor.split('-').map(Number) as [number, number]; return `${y}年${m}月`; }
  if (mode === 'day') return formatDay(anchor, { year: true, weekday: true });
  return spanTitle(range);
}

/** A start point, a day or an instant, as date statistics return it; other text comes back as it is. */
export function formatDatePoint(value: string, timeZone?: string, today?: string): string {
  if (isCalendarDay(value)) return formatDay(value, { today });
  const ms = Date.parse(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(ms)) return `${formatDay(zonedDay(ms, timeZone), { today })} ${formatClock(ms, timeZone)}`;
  const cell = parseDateCell(value);
  return cell ? formatDateCellText({ start: cell.start, allDay: cell.allDay }, timeZone, today) : value;
}
