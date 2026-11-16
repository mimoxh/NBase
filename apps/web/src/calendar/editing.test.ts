import { describe, expect, it } from 'vitest';
import { applyEventChange, applyEventDelete, dragSpan, movedSpan, newEventValue, resizedSpan, shiftedSpan } from './editing';
import { calendarTitle, formatDatePoint, formatDateValue, formatReminder, recurrenceSummary } from './format';
import { anchorForMode } from './layout';
import { buildEvents } from './model';
import { parseDateText } from './parse';

const tz = 'Asia/Shanghai';
const one = (value: string, from = '2026-11-01', to = '2026-11-30') => buildEvents([{ sourceId: 's', rowId: 'r', title: 't', value }], { from, to }, tz)[0]!;

describe('moving and resizing', () => {
  it('moves all-day and timed events by days and to new times', () => {
    expect(shiftedSpan(one('2026-11-16/2026-11-18'), 2, tz)).toEqual({ start: '2026-11-18', end: '2026-11-20', allDay: true });
    const timed = one('2026-11-16T01:00:00Z/2026-11-16T02:30:00Z|tz=Asia/Shanghai');
    expect(shiftedSpan(timed, 1, tz)).toEqual({ start: '2026-11-17T01:00:00Z', end: '2026-11-17T02:30:00Z', allDay: false });
    expect(movedSpan(timed, { allDay: false, ms: Date.parse('2026-11-18T06:00:00Z') }, tz))
      .toEqual({ start: '2026-11-18T06:00:00Z', end: '2026-11-18T07:30:00Z', allDay: false });
    expect(movedSpan(timed, { allDay: true, day: '2026-11-20' }, tz)).toEqual({ start: '2026-11-20', end: undefined, allDay: true });
    expect(movedSpan(one('2026-11-16'), { allDay: false, ms: Date.parse('2026-11-16T02:00:00Z') }, tz))
      .toEqual({ start: '2026-11-16T02:00:00Z', end: '2026-11-16T03:00:00Z', allDay: false });
  });

  it('keeps the wall clock when moving across a clock change', () => {
    const ny = buildEvents([{ sourceId: 's', rowId: 'r', title: 't', value: '2026-10-30T13:00:00Z|tz=America/New_York' }],
      { from: '2026-10-01', to: '2026-11-30' }, 'America/New_York')[0]!;
    expect(shiftedSpan(ny, 3, 'America/New_York').start).toBe('2026-11-02T14:00:00Z');
  });

  it('resizes ends without going before the start', () => {
    expect(resizedSpan(one('2026-11-16'), { allDay: true, day: '2026-11-19' }, tz)).toEqual({ start: '2026-11-16', end: '2026-11-19', allDay: true });
    expect(resizedSpan(one('2026-11-16/2026-11-18'), { allDay: true, day: '2026-11-10' }, tz)).toEqual({ start: '2026-11-16', end: undefined, allDay: true });
    const timed = one('2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai');
    expect(resizedSpan(timed, { allDay: false, ms: Date.parse('2026-11-16T00:00:00Z') }, tz)?.end).toBe('2026-11-16T01:15:00Z');
    expect(resizedSpan(timed, { allDay: true, day: '2026-11-18' }, tz)?.end).toBe('2026-11-18T02:00:00Z');
  });
});

describe('applying changes to stored values', () => {
  const series = '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=4;BYDAY=MO|remind=10';
  const second = buildEvents([{ sourceId: 's', rowId: 'r', title: 't', value: series }], { from: '2026-11-23', to: '2026-11-23' }, tz)[0]!;
  const next = { start: '2026-11-24T03:00:00Z', end: '2026-11-24T04:00:00Z', allDay: false };

  it('splits off one occurrence, the following ones, or moves the whole series', () => {
    expect(applyEventChange(second, next, 'this', tz)).toEqual({ series: `2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=4;BYDAY=MO|exdate=2026-11-23T01:00:00Z|remind=10`,
      detached: '2026-11-24T03:00:00Z/2026-11-24T04:00:00Z|tz=Asia/Shanghai|remind=10' });
    const following = applyEventChange(second, next, 'following', tz)!;
    expect(following.series).toContain('COUNT=1');
    expect(following.detached).toContain('COUNT=3;BYDAY=TU');
    expect(applyEventChange(second, next, 'all', tz)).toEqual({ series: '2026-11-17T03:00:00Z/2026-11-17T04:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=4;BYDAY=TU|remind=10' });
  });

  it('gives an all-day value moved onto the time grid the reader zone', () => {
    const write = applyEventChange(one('2026-11-16'), { start: '2026-11-16T02:00:00Z', end: '2026-11-16T03:00:00Z', allDay: false }, 'this', tz);
    expect(write).toEqual({ series: '2026-11-16T02:00:00Z/2026-11-16T03:00:00Z|tz=Asia/Shanghai' });
  });

  it('deletes by scope; deleting a whole series empties it', () => {
    expect(applyEventDelete(second, 'all')).toEqual({ series: null });
    expect(applyEventDelete(second, 'this')!.series).toContain('exdate=2026-11-23T01:00:00Z');
    expect(applyEventDelete(one('2026-11-16'), 'this')).toEqual({ series: null });
  });

  it('creates values with the reader zone', () => {
    expect(newEventValue({ start: '2026-11-16T01:00:00Z', end: '2026-11-16T02:00:00Z', allDay: false }, tz)).toBe('2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai');
    expect(newEventValue({ start: '2026-11-16', allDay: true }, tz)).toBe('2026-11-16');
  });
});

describe('formatting', () => {
  it('describes values for a reader', () => {
    expect(formatDateValue('2026-11-16', tz, '2026-11-01')).toBe('11月16日');
    expect(formatDateValue('2027-01-02', tz, '2026-11-01')).toBe('2027年1月2日');
    expect(formatDateValue('2026-11-16/2026-11-18', tz, '2026-11-01')).toBe('11月16日 → 11月18日');
    expect(formatDateValue('2026-12-30/2027-01-02', tz, '2026-11-01')).toBe('2026年12月30日 → 2027年1月2日');
    expect(formatDateValue('2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai', tz, '2026-11-01')).toBe('11月16日 09:00–10:00');
    expect(formatDateValue('2026-11-16T15:00:00Z/2026-11-16T17:00:00Z', tz, '2026-11-01')).toBe('11月16日 23:00 → 11月17日 01:00');
    expect(formatDateValue('其他', tz)).toBe('其他');
  });

  it('summarises recurrence rules', () => {
    expect(recurrenceSummary('FREQ=DAILY', true)).toBe('每天');
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=MO,WE', true)).toBe('每周一、三');
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', true)).toBe('工作日');
    expect(recurrenceSummary('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', true)).toBe('每 2 周的周五');
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=2MO', true)).toBe('每月第二个周一');
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=-1FR', true)).toBe('每月最后一个周五');
    expect(recurrenceSummary('FREQ=MONTHLY;BYMONTHDAY=1,15', true)).toBe('每月 1 日、15 日');
    expect(recurrenceSummary('FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=16', true)).toBe('每年 11月16日');
    expect(recurrenceSummary('FREQ=DAILY;COUNT=10', true)).toBe('每天，共 10 次');
    expect(recurrenceSummary('FREQ=DAILY;UNTIL=20261231', true, tz, '2026-01-01')).toBe('每天，至 12月31日');
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', true)).toBe('按月重复（自定义规则）');
  });

  it('names reminders and headings', () => {
    expect([0, 10, 60, 1440, 90].map(m => formatReminder(m, false))).toEqual(['准时', '10 分钟前', '1 小时前', '1 天前', '90 分钟前']);
    expect([-540, 900, 2340].map(m => formatReminder(m, true))).toEqual(['当天 9:00', '前一天 9:00', '2 天前 9:00']);
    expect(calendarTitle('month', '2026-11-16', { from: '2026-10-26', to: '2026-12-06' })).toBe('2026年11月');
    expect(calendarTitle('week', '2026-11-16', { from: '2026-11-16', to: '2026-11-22' })).toBe('2026年11月16日–22日');
    expect(calendarTitle('week', '2026-11-30', { from: '2026-11-30', to: '2026-12-06' })).toBe('2026年11月30日–12月6日');
    expect(calendarTitle('day', '2026-11-16', { from: '2026-11-16', to: '2026-11-16' })).toBe('2026年11月16日 周一');
  });
});

describe('lenient date text', () => {
  it('keeps stored values and reads common forms', () => {
    expect(parseDateText('2026-11-16|rrule=FREQ=DAILY', tz)).toBe('2026-11-16|rrule=FREQ=DAILY');
    expect(parseDateText('2026/1/5', tz)).toBe('2026-01-05');
    expect(parseDateText('2026年1月5日', tz)).toBe('2026-01-05');
    expect(parseDateText('2026-01-05 09:30', tz)).toBe('2026-01-05T01:30:00Z|tz=Asia/Shanghai');
    expect(parseDateText('2026-01-05T09:30:00+08:00', tz)).toBe('2026-01-05T01:30:00Z|tz=Asia/Shanghai');
  });

  it('reads ranges with several separators', () => {
    expect(parseDateText('2026-01-05 → 2026-01-07', tz)).toBe('2026-01-05/2026-01-07');
    expect(parseDateText('2026-01-05 - 2026-01-07', tz)).toBe('2026-01-05/2026-01-07');
    expect(parseDateText('2026/1/5~2026/1/7', tz)).toBe('2026-01-05/2026-01-07');
    expect(parseDateText('2026/1/5/2026/1/7', tz)).toBe('2026-01-05/2026-01-07');
    expect(parseDateText('2026-01-05 09:00 - 10:30', tz)).toBe('2026-01-05T01:00:00Z/2026-01-05T02:30:00Z|tz=Asia/Shanghai');
    expect(parseDateText('2026-01-05 09:00 → 2026-01-06 10:00', tz)).toBe('2026-01-05T01:00:00Z/2026-01-06T02:00:00Z|tz=Asia/Shanghai');
    expect(parseDateText('2026-01-05 → 2026-01-05', tz)).toBe('2026-01-05');
  });

  it('refuses what is not a date', () => {
    for (const bad of ['', '明天', '2026-02-31', '2026-01-07 → 2026-01-05', '2026-01-05 → 2026-01-06 10:00', '2026-01-05 10:00 - 09:00', '2026-01-05 25:00']) {
      expect(parseDateText(bad, tz), bad).toBeNull();
    }
  });
});

describe('drag targets', () => {
  const session = (value: string, kind: 'move' | 'resize', origin: 'month' | 'lane' | 'grid', grabDay: string, grabOffset = 0) =>
    ({ event: one(value), kind, origin, grabDay, grabOffset });

  it('moves by days in month rows and keeps the time of timed events', () => {
    expect(dragSpan(session('2026-11-16/2026-11-17', 'move', 'month', '2026-11-17'), { area: 'day', day: '2026-11-20' }, tz))
      .toEqual({ start: '2026-11-19', end: '2026-11-20', allDay: true });
    expect(dragSpan(session('2026-11-16T01:00:00Z|tz=Asia/Shanghai', 'move', 'month', '2026-11-16'), { area: 'day', day: '2026-11-18' }, tz))
      .toEqual({ start: '2026-11-18T01:00:00Z', end: undefined, allDay: false });
  });

  it('snaps time grid moves to 15 minutes, keeping where the event was grabbed', () => {
    // Grabbed 30 minutes below the 09:00 start (Shanghai) and dropped at 14:20: 13:50 snaps to 13:45.
    const grabbed = session('2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai', 'move', 'grid', '2026-11-16', 30);
    expect(dragSpan(grabbed, { area: 'time', day: '2026-11-17', minutes: 14 * 60 + 20 }, tz))
      .toEqual({ start: '2026-11-17T05:45:00Z', end: '2026-11-17T06:45:00Z', allDay: false });
    expect(dragSpan(grabbed, { area: 'day', day: '2026-11-18' }, tz)).toEqual({ start: '2026-11-18', end: undefined, allDay: true });
  });

  it('turns an all-day event dropped on the grid into an hour', () => {
    expect(dragSpan(session('2026-11-16', 'move', 'lane', '2026-11-16'), { area: 'time', day: '2026-11-16', minutes: 10 * 60 + 7 }, tz))
      .toEqual({ start: '2026-11-16T02:00:00Z', end: '2026-11-16T03:00:00Z', allDay: false });
  });

  it('resizes by day in month rows and by time on the grid', () => {
    expect(dragSpan(session('2026-11-16', 'resize', 'month', '2026-11-16'), { area: 'day', day: '2026-11-19' }, tz))
      .toEqual({ start: '2026-11-16', end: '2026-11-19', allDay: true });
    const timed = session('2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai', 'resize', 'grid', '2026-11-16');
    expect(dragSpan(timed, { area: 'time', day: '2026-11-16', minutes: 11 * 60 + 8 }, tz)?.end).toBe('2026-11-16T03:15:00Z');
    expect(dragSpan(timed, { area: 'day', day: '2026-11-18' }, tz)).toBeNull();
  });
});

describe('switching modes', () => {
  it('opens on today when it is on screen and keeps the page otherwise', () => {
    expect(anchorForMode('month', '2026-11-01', 1, '2026-11-18')).toBe('2026-11-18');
    expect(anchorForMode('month', '2026-12-01', 1, '2026-11-18')).toBe('2026-12-01');
    expect(anchorForMode('week', '2026-12-09', 1, '2026-11-18')).toBe('2026-12-09');
  });

  it('formats date statistics as their start', () => {
    expect(formatDatePoint('2026-11-16', tz, '2026-01-01')).toBe('11月16日');
    expect(formatDatePoint('2026-11-16T01:00:00Z', tz, '2026-01-01')).toBe('11月16日 09:00');
    expect(formatDatePoint('其他', tz)).toBe('其他');
  });
});
