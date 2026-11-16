import { describe, expect, it } from 'vitest';
import { buildEvents, type CalendarEvent, type CalendarEventInput } from './model';
import { groupByDay, instantAt, layoutTimed, minutesInDay, monthWeeks, packLanes, shiftAnchor, shiftMonth, snapMinutes, visibleRange, weekDays } from './layout';

const tz = 'Asia/Shanghai';
const input = (rowId: string, value: string, extra: Partial<CalendarEventInput> = {}): CalendarEventInput => ({ sourceId: 's', rowId, title: rowId, value, ...extra });
const events = (inputs: CalendarEventInput[], from = '2026-11-01', to = '2026-11-30') => buildEvents(inputs, { from, to }, tz);
const days = (first: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

describe('calendar ranges', () => {
  it('fills whole weeks for a month, Monday or Sunday first', () => {
    const weeks = monthWeeks('2026-11', 1);
    expect(weeks[0]![0]).toBe('2026-10-26');
    expect(weeks.at(-1)![6]).toBe('2026-12-06');
    expect(monthWeeks('2026-06', 1)[0]![0]).toBe('2026-06-01');
    expect(monthWeeks('2028-02', 1).flat()).toContain('2028-02-29');
    expect(monthWeeks('2026-11', 0)[0]![0]).toBe('2026-11-01');
  });

  it('gives each mode its days and pages', () => {
    expect(visibleRange('month', '2026-11-16', 1)).toEqual({ from: '2026-10-26', to: '2026-12-06' });
    expect(visibleRange('week', '2026-11-18', 1)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(weekDays('2026-11-18', 0)[0]).toBe('2026-11-15');
    expect(visibleRange('day', '2026-11-18', 1)).toEqual({ from: '2026-11-18', to: '2026-11-18' });
    expect(visibleRange('agenda', '2026-11-18', 1, 30)).toEqual({ from: '2026-11-18', to: '2026-12-17' });
    expect(visibleRange('agenda', '2026-01-01', 1, 1000).to).toBe('2027-02-03');
    expect(shiftAnchor('month', '2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftAnchor('week', '2026-11-18', -1)).toBe('2026-11-11');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});

describe('building events', () => {
  it('expands recurring values in the reader zone and keeps keys stable', () => {
    const list = events([input('a', '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=DAILY;COUNT=3|remind=10')], '2026-11-17', '2026-11-30');
    expect(list.map(e => e.start)).toEqual(['2026-11-17T01:00:00Z', '2026-11-18T01:00:00Z']);
    expect(list[0]).toMatchObject({ key: 's|a|2026-11-17T01:00:00Z', recurring: true, hasReminders: true, allDay: false, hasEnd: true,
      days: { from: '2026-11-17', to: '2026-11-17' }, occurrenceIndex: 1 });
  });

  it('reads created times as moments and skips values that are not dates', () => {
    const list = events([input('m', '2026-11-15T17:30:00.000Z', { kind: 'moment' }), input('x', 'not a date'), input('y', '2026-12-01')]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ readOnly: true, days: { from: '2026-11-16', to: '2026-11-16' }, start: '2026-11-15T17:30:00Z', hasEnd: false });
  });

  it('orders spanning events before single ones of the same day', () => {
    const list = events([input('t', '2026-11-16T01:00:00Z|tz=Asia/Shanghai'), input('d', '2026-11-16'), input('r', '2026-11-16/2026-11-18')]);
    expect(list.map(e => e.rowId)).toEqual(['r', 'd', 't']);
  });
});

describe('lanes', () => {
  const week = days('2026-11-16', 7);
  it('packs bars into the lowest free lane and clips at the row edges', () => {
    const list = events([input('long', '2026-11-14/2026-11-18'), input('a', '2026-11-16'), input('b', '2026-11-19/2026-11-25'), input('c', '2026-11-17')]);
    const layout = packLanes(list, week);
    const bar = (id: string) => layout.bars.find(b => b.event.rowId === id)!;
    expect(bar('long')).toMatchObject({ start: 0, span: 3, lane: 0, clippedStart: true, clippedEnd: false });
    expect(bar('b')).toMatchObject({ start: 3, span: 4, lane: 0, clippedEnd: true });
    expect(bar('a').lane).toBe(1);
    expect(bar('c').lane).toBe(1);
    expect(layout.lanes).toBe(2);
  });

  it('gives the last lane of a full day to the more marker', () => {
    const list = events(['a', 'b', 'c', 'd'].map(id => input(id, '2026-11-16')).concat(input('e', '2026-11-17')));
    const layout = packLanes(list, week, 3);
    expect(layout.bars.filter(b => b.start === 0).map(b => b.event.rowId)).toEqual(['a', 'b']);
    expect(layout.more[0]).toBe(2);
    expect(layout.more[1]).toBe(0);
    expect(layout.byColumn[0]).toHaveLength(4);
    const exact = packLanes(events(['a', 'b', 'c'].map(id => input(id, '2026-11-16'))), week, 3);
    expect(exact.bars).toHaveLength(3);
    expect(exact.more[0]).toBe(0);
  });
});

describe('time grid', () => {
  const at = (day: string, h: number, m = 0) => new Date(instantAt(day, h * 60 + m, tz)).toISOString().replace('.000Z', 'Z');
  it('maps wall-clock minutes both ways', () => {
    expect(at('2026-11-16', 9)).toBe('2026-11-16T01:00:00Z');
    expect(minutesInDay(Date.parse('2026-11-16T01:30:00Z'), '2026-11-16', tz)).toBe(570);
    expect(minutesInDay(Date.parse('2026-11-16T16:00:00Z'), '2026-11-16', tz)).toBe(1440);
    expect(instantAt('2026-11-16', 1440, tz)).toBe(Date.parse('2026-11-16T16:00:00Z'));
    expect(snapMinutes(52)).toBe(45);
    expect(snapMinutes(53)).toBe(60);
    expect(snapMinutes(59, 30, 'floor')).toBe(30);
  });

  it('places overlapping events side by side', () => {
    const list = events([
      input('a', `${at('2026-11-16', 9)}/${at('2026-11-16', 11)}|tz=${tz}`),
      input('b', `${at('2026-11-16', 10)}/${at('2026-11-16', 12)}|tz=${tz}`),
      input('c', `${at('2026-11-16', 11)}/${at('2026-11-16', 12)}|tz=${tz}`),
      input('d', `${at('2026-11-16', 14)}|tz=${tz}`),
      input('all', '2026-11-16'),
    ]);
    const blocks = layoutTimed(list, '2026-11-16', tz);
    const block = (id: string) => blocks.find(b => b.event.rowId === id)!;
    expect(blocks.map(b => b.event.rowId).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(block('a')).toMatchObject({ top: 540, bottom: 660, column: 0, columns: 2 });
    expect(block('b')).toMatchObject({ column: 1, columns: 2 });
    expect(block('c')).toMatchObject({ column: 0, columns: 2 });
    expect(block('d')).toMatchObject({ top: 840, bottom: 870, column: 0, columns: 1 });
  });

  it('keeps timed events that cross midnight in the all-day lane', () => {
    const list = events([input('late', `${at('2026-11-16', 23)}/${at('2026-11-17', 1)}|tz=${tz}`)]);
    expect(layoutTimed(list, '2026-11-16', tz)).toEqual([]);
    expect(packLanes(list, days('2026-11-16', 7)).bars[0]).toMatchObject({ start: 0, span: 2 });
  });
});

describe('agenda', () => {
  it('groups by day and repeats spanning events on each day in range', () => {
    const list = events([input('span', '2026-11-15/2026-11-17'), input('t', '2026-11-16T01:00:00Z|tz=Asia/Shanghai'), input('later', '2026-11-20')]);
    const groups = groupByDay(list, { from: '2026-11-16', to: '2026-11-30' });
    expect(groups.map(g => [g.day, g.events.map((e: CalendarEvent) => e.rowId)])).toEqual([
      ['2026-11-16', ['span', 't']], ['2026-11-17', ['span']], ['2026-11-20', ['later']]]);
  });
});
