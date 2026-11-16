import { describe, expect, it } from 'vitest';
import { editorStateFrom, editorValue, toggleWeekday, withCustom, withIncludeTime, withRepeat, withStartDay, type DateEditorState } from './editorState';

const tz = 'Asia/Shanghai';
const today = '2026-11-16';
const value = (state: DateEditorState) => { const result = editorValue(state); return result.ok ? result.value : `! ${result.error}`; };
const from = (stored?: string) => editorStateFrom(stored, tz, today);

describe('date editor state', () => {
  it('starts today and builds all-day and timed values', () => {
    const blank = from();
    expect(value(blank)).toBe('2026-11-16');
    expect(value({ ...blank, hasEnd: true, endDay: '2026-11-18' })).toBe('2026-11-16/2026-11-18');
    const timed = withIncludeTime({ ...blank, hasEnd: true }, true);
    expect(value(timed)).toBe('2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai');
    expect(value({ ...timed, endTime: '08:00' })).toBe('! 结束时间需晚于开始时间。');
    expect(value({ ...blank, hasEnd: true, endDay: '2026-11-10' })).toBe('! 结束日期早于开始日期。');
  });

  it('reads stored values back and keeps their zone', () => {
    const stored = '2026-11-16T01:00:00Z/2026-11-16T02:30:00Z|tz=Europe/Paris|remind=10';
    const state = from(stored);
    expect(state).toMatchObject({ startDay: '2026-11-16', startTime: '09:00', endTime: '10:30', includeTime: true, hasEnd: true, reminders: [10] });
    expect(value(state)).toBe(stored);
    expect(value({ ...state, startTime: '10:00' })).toBe('2026-11-16T02:00:00Z/2026-11-16T02:30:00Z|tz=Europe/Paris|remind=10');
  });

  it('moves the end with the start day', () => {
    expect(value(withStartDay(from('2026-11-16/2026-11-18'), '2026-11-20'))).toBe('2026-11-20/2026-11-22');
  });

  it('maps presets both ways', () => {
    const cases: [string, DateEditorState['repeat']][] = [
      ['2026-11-16|rrule=FREQ=DAILY', 'daily'], ['2026-11-16|rrule=FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'weekdays'],
      ['2026-11-16|rrule=FREQ=WEEKLY', 'weekly'], ['2026-11-16|rrule=FREQ=WEEKLY;BYDAY=MO', 'weekly'],
      ['2026-11-16|rrule=FREQ=MONTHLY', 'monthly'], ['2026-11-16|rrule=FREQ=YEARLY', 'yearly'],
      ['2026-11-16|rrule=FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', 'custom'], ['2026-11-16|rrule=FREQ=DAILY;COUNT=5', 'custom'],
      ['2026-11-16|rrule=FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'kept'], ['2026-11-16|rrule=FREQ=MONTHLY;BYDAY=3MO', 'kept'],
    ];
    for (const [stored, repeat] of cases) {
      const state = from(stored);
      expect(state.repeat, stored).toBe(repeat);
      expect(value(state), stored).toBe(stored);
    }
    expect(value(withRepeat(from(), 'weekdays'))).toBe('2026-11-16|rrule=FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(value(withRepeat(from('2026-11-16|rrule=FREQ=DAILY'), 'none'))).toBe('2026-11-16');
  });

  it('keeps an unsupported rule and its removed occurrences until another option is picked', () => {
    const stored = '2026-11-02|rrule=FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1|exdate=2026-11-30';
    const state = from(stored);
    expect(value({ ...state, hasEnd: true, endDay: '2026-11-03' })).toBe('2026-11-02/2026-11-03|rrule=FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1|exdate=2026-11-30');
    expect(value(withRepeat(state, 'monthly'))).toBe('2026-11-02|rrule=FREQ=MONTHLY');
    expect(value(withStartDay(state, '2026-11-03'))).toBe('2026-11-03|rrule=FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1');
  });

  it('builds custom rules with an end', () => {
    let state = withRepeat(from(), 'custom');
    expect(state.custom).toMatchObject({ freq: 'WEEKLY', weekdays: [0] });
    state = toggleWeekday(state, 2);
    expect(value(state)).toBe('2026-11-16|rrule=FREQ=WEEKLY;BYDAY=MO,WE');
    expect(value(withCustom(state, { interval: 2, end: 'count', count: 6 }))).toBe('2026-11-16|rrule=FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=MO,WE');
    expect(value(withCustom(state, { end: 'until', until: '2026-12-31' }))).toBe('2026-11-16|rrule=FREQ=WEEKLY;UNTIL=20261231;BYDAY=MO,WE');
    const timed = withIncludeTime(withCustom(state, { freq: 'DAILY', end: 'until', until: '2026-11-20' }), true);
    expect(value(timed)).toBe('2026-11-16T01:00:00Z|tz=Asia/Shanghai|rrule=FREQ=DAILY;UNTIL=20261120T155959Z');
    expect(value(withCustom(state, { interval: 0 }))).toMatch(/^! 间隔/);
    expect(value(withCustom(state, { end: 'until', until: '2026-11-01' }))).toBe('! 重复的结束日期早于开始日期。');
    const reread = from('2026-11-16T01:00:00Z|tz=Asia/Shanghai|rrule=FREQ=DAILY;UNTIL=20261120T155959Z');
    expect(reread.custom).toMatchObject({ freq: 'DAILY', end: 'until', until: '2026-11-20' });
  });

  it('refuses long recurring spans and filters reminders by kind', () => {
    expect(value({ ...withRepeat(from(), 'yearly'), hasEnd: true, endDay: '2026-12-31' })).toBe('! 重复日程每次最长 31 天。');
    const allDay = { ...from(), reminders: [-540, 900] };
    expect(value(allDay)).toBe('2026-11-16|remind=-540,900');
    expect(withIncludeTime(allDay, true).reminders).toEqual([]);
    expect(value({ ...withIncludeTime(from(), true), reminders: [60, 0] })).toBe('2026-11-16T01:00:00Z|tz=Asia/Shanghai|remind=0,60');
  });

  it('drops removed occurrences once the series changes', () => {
    const state = from('2026-11-16|rrule=FREQ=DAILY|exdate=2026-11-18');
    expect(value(state)).toBe('2026-11-16|rrule=FREQ=DAILY|exdate=2026-11-18');
    expect(value(withRepeat(state, 'weekly'))).toBe('2026-11-16|rrule=FREQ=WEEKLY');
  });
});
