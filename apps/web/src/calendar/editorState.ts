import { daysBetween, dayStartInstant, formatDateCell, formatRecurrenceRule, instantText, isCalendarDay, parseDateCell, parseRecurrenceRule,
  shiftCalendarDay, wallClock, wallToInstant, zonedDay, dateCellLimits, type DateCell, type RecurrenceFrequency, type RecurrenceRule } from '@nbase/contracts';
import { allDayReminderOptions, timedReminderOptions } from './format';

/** What the repeat menu offers. `kept` is a rule from elsewhere the editor cannot show; it stays as it is. */
export const repeatChoices = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'custom'] as const;
export type RepeatChoice = typeof repeatChoices[number] | 'kept';

export interface CustomRepeat {
  freq: RecurrenceFrequency;
  interval: number;
  /** Weekly only; 0 is Monday. */
  weekdays: number[];
  end: 'never' | 'until' | 'count';
  /** Last day a repetition may start, in the reader's zone. */
  until: string;
  count: number;
}

export interface DateEditorState {
  startDay: string;
  /** `HH:MM` on the reader's clock. */
  startTime: string;
  hasEnd: boolean;
  endDay: string;
  endTime: string;
  includeTime: boolean;
  repeat: RepeatChoice;
  custom: CustomRepeat;
  /** The repeat menu or custom fields were touched; until then the stored rule is kept word for word. */
  ruleDirty: boolean;
  reminders: number[];
  /** The value being edited, for what the editor does not show (zone, removed occurrences, unusual rules). */
  original: DateCell | null;
  /** The reader's zone, which the editor shows times in. */
  timeZone: string;
}

export type EditorResult = { ok: true; value: string } | { ok: false; error: string };

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number, timeZone: string) => { const w = wallClock(ms, timeZone); return `${pad(w[3])}:${pad(w[4])}`; };
/** 0 is Monday, as in recurrence rules. */
export const ruleWeekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

function defaultCustom(startDay: string): CustomRepeat {
  return { freq: 'WEEKLY', interval: 1, weekdays: [ruleWeekday(startDay)], end: 'never', until: shiftCalendarDay(startDay, 30), count: 10 };
}

function classify(cell: DateCell, startDay: string, timeZone: string): { repeat: RepeatChoice; custom: CustomRepeat } {
  const custom = defaultCustom(startDay);
  if (!cell.rrule) return { repeat: 'none', custom };
  const rule = parseRecurrenceRule(cell.rrule, cell.allDay);
  if (!rule) return { repeat: 'kept', custom };
  const plainDays = rule.byDay?.every(w => w.nth === undefined) ?? true;
  const days = rule.byDay?.map(w => w.day) ?? [];
  const plain = rule.interval === 1 && rule.count === undefined && rule.until === undefined && !rule.byMonth && !rule.byMonthDay
    && !rule.bySetPos && rule.weekStart === 0;
  if (plain && plainDays) {
    if (rule.freq === 'DAILY' && !rule.byDay) return { repeat: 'daily', custom };
    if (rule.freq === 'WEEKLY' && days.join() === '0,1,2,3,4') return { repeat: 'weekdays', custom };
    if (rule.freq === 'WEEKLY' && (!rule.byDay || (days.length === 1 && days[0] === ruleWeekday(startDay)))) return { repeat: 'weekly', custom };
    if (rule.freq === 'MONTHLY' && !rule.byDay) return { repeat: 'monthly', custom };
    if (rule.freq === 'YEARLY' && !rule.byDay) return { repeat: 'yearly', custom };
  }
  const editable = !rule.byMonth && !rule.byMonthDay && !rule.bySetPos && rule.weekStart === 0
    && (!rule.byDay || (rule.freq === 'WEEKLY' && plainDays));
  if (!editable) return { repeat: 'kept', custom };
  return { repeat: 'custom', custom: {
    freq: rule.freq, interval: rule.interval, weekdays: rule.freq === 'WEEKLY' && days.length ? days : custom.weekdays,
    end: rule.count !== undefined ? 'count' : rule.until !== undefined ? 'until' : 'never',
    until: rule.until === undefined ? custom.until : cell.allDay ? rule.until : zonedDay(Date.parse(rule.until), timeZone),
    count: rule.count ?? custom.count,
  } };
}

/** Editor fields for a stored value, or for a new one starting today. */
export function editorStateFrom(value: string | null | undefined, timeZone: string, today: string): DateEditorState {
  const cell = value ? parseDateCell(value) : null;
  if (!cell) {
    return { startDay: today, startTime: '09:00', hasEnd: false, endDay: today, endTime: '10:00', includeTime: false, repeat: 'none',
      custom: defaultCustom(today), ruleDirty: false, reminders: [], original: null, timeZone };
  }
  let startDay: string, startTime = '09:00', endDay: string, endTime = '10:00';
  if (cell.allDay) { startDay = cell.start; endDay = cell.end ?? cell.start; }
  else {
    const start = Date.parse(cell.start);
    const end = cell.end ? Date.parse(cell.end) : start + 3600000;
    startDay = zonedDay(start, timeZone); startTime = clock(start, timeZone);
    endDay = zonedDay(end, timeZone); endTime = clock(end, timeZone);
  }
  return { startDay, startTime, hasEnd: cell.end !== undefined, endDay, endTime, includeTime: !cell.allDay, ...classify(cell, startDay, timeZone),
    ruleDirty: false, reminders: cell.reminders ?? [], original: cell, timeZone };
}

export function reminderOptions(allDay: boolean): readonly number[] {
  return allDay ? allDayReminderOptions : timedReminderOptions;
}

/** Switching between all-day and timed keeps only reminders that mean the same in the other kind. */
export function withIncludeTime(state: DateEditorState, includeTime: boolean): DateEditorState {
  const options = reminderOptions(!includeTime);
  return { ...state, includeTime, reminders: state.reminders.filter(m => options.includes(m)) };
}

/** A new start day keeps the event's length. */
export function withStartDay(state: DateEditorState, startDay: string): DateEditorState {
  if (!isCalendarDay(startDay) || !isCalendarDay(state.startDay)) return { ...state, startDay };
  const shift = daysBetween(state.startDay, startDay);
  return { ...state, startDay, endDay: isCalendarDay(state.endDay) ? shiftCalendarDay(state.endDay, shift) : startDay };
}

export function withRepeat(state: DateEditorState, repeat: RepeatChoice): DateEditorState {
  const custom = repeat === 'custom' && state.repeat !== 'custom' ? { ...defaultCustom(state.startDay), ...pickCustomBase(state) } : state.custom;
  return { ...state, repeat, custom, ruleDirty: true };
}

function pickCustomBase(state: DateEditorState): Partial<CustomRepeat> {
  const freq: Partial<Record<RepeatChoice, RecurrenceFrequency>> = { daily: 'DAILY', weekdays: 'WEEKLY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
  const from = freq[state.repeat];
  if (!from) return {};
  return { freq: from, weekdays: state.repeat === 'weekdays' ? [0, 1, 2, 3, 4] : [ruleWeekday(state.startDay)] };
}

export function withCustom(state: DateEditorState, patch: Partial<CustomRepeat>): DateEditorState {
  return { ...state, custom: { ...state.custom, ...patch }, ruleDirty: true };
}

export function toggleWeekday(state: DateEditorState, day: number): DateEditorState {
  const has = state.custom.weekdays.includes(day);
  const weekdays = has ? state.custom.weekdays.filter(d => d !== day) : [...state.custom.weekdays, day].sort((a, b) => a - b);
  return withCustom(state, { weekdays });
}

function timeOf(day: string, time: string, timeZone: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || !isCalendarDay(day)) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return wallToInstant(y, m, d, hour, minute, 0, timeZone);
}

type RuleResult = { ok: true; rrule: string | undefined } | { ok: false; error: string };

function ruleText(state: DateEditorState, allDay: boolean): RuleResult {
  if (state.repeat === 'none') return { ok: true, rrule: undefined };
  if (state.repeat === 'kept' || (!state.ruleDirty && state.original?.rrule)) {
    const kept = state.original?.rrule ? parseRecurrenceRule(state.original.rrule, allDay) : null;
    return kept ? { ok: true, rrule: formatRecurrenceRule(kept) } : { ok: false, error: '原有的重复规则不适用于这种日期，请重新选择重复方式。' };
  }
  const base: RecurrenceRule = { freq: 'DAILY', interval: 1, weekStart: 0 };
  switch (state.repeat) {
    case 'daily': return { ok: true, rrule: formatRecurrenceRule(base) };
    case 'weekdays': return { ok: true, rrule: formatRecurrenceRule({ ...base, freq: 'WEEKLY', byDay: [0, 1, 2, 3, 4].map(day => ({ day })) }) };
    case 'weekly': return { ok: true, rrule: formatRecurrenceRule({ ...base, freq: 'WEEKLY' }) };
    case 'monthly': return { ok: true, rrule: formatRecurrenceRule({ ...base, freq: 'MONTHLY' }) };
    case 'yearly': return { ok: true, rrule: formatRecurrenceRule({ ...base, freq: 'YEARLY' }) };
  }
  const custom = state.custom;
  if (!Number.isInteger(custom.interval) || custom.interval < 1 || custom.interval > dateCellLimits.interval) {
    return { ok: false, error: `间隔需为 1 到 ${dateCellLimits.interval} 的整数。` };
  }
  const rule: RecurrenceRule = { ...base, freq: custom.freq, interval: custom.interval };
  if (custom.freq === 'WEEKLY' && custom.weekdays.length) rule.byDay = [...new Set(custom.weekdays)].sort((a, b) => a - b).map(day => ({ day }));
  if (custom.end === 'count') {
    if (!Number.isInteger(custom.count) || custom.count < 1 || custom.count > dateCellLimits.count) {
      return { ok: false, error: `次数需为 1 到 ${dateCellLimits.count} 的整数。` };
    }
    rule.count = custom.count;
  }
  if (custom.end === 'until') {
    if (!isCalendarDay(custom.until)) return { ok: false, error: '请填写重复的结束日期。' };
    if (custom.until < state.startDay) return { ok: false, error: '重复的结束日期早于开始日期。' };
    rule.until = allDay ? custom.until : instantText(dayStartInstant(shiftCalendarDay(custom.until, 1), state.timeZone) - 1000);
  }
  return { ok: true, rrule: formatRecurrenceRule(rule) };
}

/** The stored value the fields describe, in canonical form. */
export function editorValue(state: DateEditorState): EditorResult {
  const allDay = !state.includeTime;
  if (!isCalendarDay(state.startDay)) return { ok: false, error: '请填写开始日期。' };
  if (state.hasEnd && !isCalendarDay(state.endDay)) return { ok: false, error: '请填写结束日期。' };
  let start: string, end: string | undefined;
  if (allDay) {
    start = state.startDay;
    end = state.hasEnd ? state.endDay : undefined;
    if (end !== undefined && end < start) return { ok: false, error: '结束日期早于开始日期。' };
  } else {
    const startMs = timeOf(state.startDay, state.startTime, state.timeZone);
    if (startMs === null) return { ok: false, error: '请填写开始时间。' };
    start = instantText(startMs);
    if (state.hasEnd) {
      const endMs = timeOf(state.endDay, state.endTime, state.timeZone);
      if (endMs === null) return { ok: false, error: '请填写结束时间。' };
      if (endMs <= startMs) return { ok: false, error: '结束时间需晚于开始时间。' };
      end = instantText(endMs);
    }
  }
  const rule = ruleText(state, allDay);
  if (!rule.ok) return rule;
  if (rule.rrule && end !== undefined) {
    const days = allDay ? daysBetween(start, end) : (Date.parse(end) - Date.parse(start)) / 86400000;
    if (days > dateCellLimits.recurringSpanDays) return { ok: false, error: `重复日程每次最长 ${dateCellLimits.recurringSpanDays} 天。` };
  }
  const original = state.original;
  // Removed occurrences only still mean the same while the series starts where it did, with the same rule.
  const sameSeries = original !== null && original.rrule === rule.rrule && original.start === start && original.allDay === allDay;
  const timeZone = allDay ? undefined : (original && !original.allDay && original.timeZone) || state.timeZone;
  const options = reminderOptions(allDay);
  const reminders = state.reminders.filter(m => (allDay ? m >= -1439 : m >= 0) && (options.includes(m) || original?.reminders?.includes(m)));
  const value = formatDateCell({ start, end, allDay, timeZone, rrule: rule.rrule, exdates: sameSeries ? original.exdates : undefined, reminders });
  return value ? { ok: true, value } : { ok: false, error: '这个日期无法保存。' };
}
