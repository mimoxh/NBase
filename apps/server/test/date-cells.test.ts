import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dateCellMayTouch, dateCellReminders, dateOccurrences, deleteOccurrence, editOccurrence, evaluateView, formatDateCell,
  isDateCellValue, iterateOccurrences, parseDateCell, parseRecurrenceRule, formatRecurrenceRule, wallToInstant, zonedDay,
  type DatabaseRow, type DatabaseView, type PropertyDefinition } from '@nbase/contracts';

const starts = (value: string, n = 50) => {
  const cell = parseDateCell(value);
  assert.ok(cell, value);
  const out: string[] = [];
  for (const o of iterateOccurrences(cell)) { out.push(o.start); if (out.length >= n) break; }
  return out;
};

test('date cells follow the grammar exactly', () => {
  for (const ok of ['2026-11-16', '2026-11-16/2026-11-18', '2026-11-16T01:00:00Z', '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai',
    '2026-11-16|rrule=FREQ=WEEKLY;BYDAY=MO|exdate=2026-11-23|remind=-540,0', '2026-11-16T01:00:00Z|tz=Asia/Shanghai|rrule=FREQ=DAILY;COUNT=3|remind=10,60']) {
    assert.equal(isDateCellValue(ok), true, ok);
  }
  for (const bad of ['', '2026-02-30', '2026-11-16/2026-11-16', '2026-11-18/2026-11-16', '2026-11-16/2026-11-16T01:00:00Z',
    '2026-11-16T01:00:00.000Z', '2026-11-16T25:00:00Z', '2026-11-16|tz=Asia/Shanghai', '2026-11-16|exdate=2026-11-23',
    '2026-11-16|rrule=FREQ=HOURLY', '2026-11-16|rrule=BYDAY=MO;FREQ=WEEKLY', '2026-11-16|remind=0,-540',
    '2026-11-16T01:00:00Z|remind=-5', '2026-11-16|remind=1|rrule=FREQ=DAILY', '2026-11-16T01:00:00Z|tz=Not/AZone',
    '2026-11-01/2026-12-15|rrule=FREQ=YEARLY', '2026-11-16|rrule=FREQ=DAILY;COUNT=2;UNTIL=20261130']) {
    assert.equal(isDateCellValue(bad), false, bad);
  }
  assert.equal(formatDateCell({ start: '2026-11-16', end: '2026-11-16', allDay: true, reminders: [0, -540, 0] }), '2026-11-16|remind=-540,0');
  const rule = parseRecurrenceRule('byday=we,mo;freq=weekly;wkst=su;interval=2', false)!;
  assert.equal(formatRecurrenceRule(rule), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU');
});

test('recurrence expands the supported subset', () => {
  assert.deepEqual(starts('2026-11-16|rrule=FREQ=WEEKLY;COUNT=5;BYDAY=MO,WE'),
    ['2026-11-16', '2026-11-18', '2026-11-23', '2026-11-25', '2026-11-30']);
  assert.deepEqual(starts('2026-01-30|rrule=FREQ=MONTHLY;BYDAY=-1FR', 4), ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
  assert.deepEqual(starts('2026-01-31|rrule=FREQ=MONTHLY;COUNT=4'), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  assert.deepEqual(starts('2024-02-29|rrule=FREQ=YEARLY;COUNT=3'), ['2024-02-29', '2028-02-29', '2032-02-29']);
  assert.deepEqual(starts('2026-11-02|rrule=FREQ=MONTHLY;COUNT=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'), ['2026-11-02', '2026-11-30', '2026-12-31']);
  assert.deepEqual(starts('2026-11-16|rrule=FREQ=DAILY;INTERVAL=3;UNTIL=20261125|exdate=2026-11-19'), ['2026-11-16', '2026-11-22', '2026-11-25']);
  assert.deepEqual(starts('2026-11-16|rrule=FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'), ['2026-11-16']);
});

test('timed recurrence keeps its wall clock across daylight saving changes', () => {
  // 09:00 in New York on Monday 2026-10-26 (EDT, UTC-4); clocks go back on 2026-11-01.
  const start = new Date(wallToInstant(2026, 10, 26, 9, 0, 0, 'America/New_York')).toISOString();
  assert.equal(start, '2026-10-26T13:00:00.000Z');
  assert.deepEqual(starts('2026-10-26T13:00:00Z|tz=America/New_York|rrule=FREQ=WEEKLY;COUNT=2'), ['2026-10-26T13:00:00Z', '2026-11-02T14:00:00Z']);
  // 02:30 does not exist on 2026-03-08 in New York and moves past the gap.
  assert.equal(new Date(wallToInstant(2026, 3, 8, 2, 30, 0, 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(zonedDay(Date.parse('2026-11-15T17:00:00Z'), 'Asia/Shanghai'), '2026-11-16');
});

test('occurrences and range tests use reader days', () => {
  const cell = parseDateCell('2026-11-15T23:00:00Z/2026-11-16T01:00:00Z|tz=UTC|rrule=FREQ=DAILY')!;
  const got = dateOccurrences(cell, { from: '2026-11-20', to: '2026-11-21' }, 'Asia/Shanghai');
  assert.deepEqual(got.map(o => o.start), ['2026-11-19T23:00:00Z', '2026-11-20T23:00:00Z']);
  assert.equal(dateCellMayTouch(parseDateCell('2026-10-01/2026-10-03')!, { from: '2026-10-03', to: '2026-10-31' }), true);
  assert.equal(dateCellMayTouch(parseDateCell('2026-10-01/2026-10-03')!, { from: '2026-10-04', to: '2026-10-31' }), false);
  assert.equal(dateCellMayTouch(parseDateCell('2026-01-01|rrule=FREQ=WEEKLY;UNTIL=20260301')!, { from: '2026-04-02', to: '2026-04-30' }), false);
  assert.equal(dateCellMayTouch(parseDateCell('2026-01-01|rrule=FREQ=WEEKLY;COUNT=3')!, { from: '2027-04-01', to: '2027-04-30' }), true);
});

test('reminders fire before each occurrence', () => {
  const cell = parseDateCell('2026-11-16T01:00:00Z|tz=Asia/Shanghai|rrule=FREQ=DAILY;COUNT=3|remind=10')!;
  const got = dateCellReminders(cell, Date.parse('2026-11-16T12:00:00Z'), Date.parse('2026-11-18T12:00:00Z'));
  assert.deepEqual(got.map(r => new Date(r.at).toISOString()), ['2026-11-17T00:50:00.000Z', '2026-11-18T00:50:00.000Z']);
  const allDay = parseDateCell('2026-11-16|remind=-540')!;
  assert.deepEqual(dateCellReminders(allDay, Date.parse('2026-11-15T00:00:00Z'), Date.parse('2026-11-17T00:00:00Z'), 'Asia/Shanghai')
    .map(r => new Date(r.at).toISOString()), ['2026-11-16T01:00:00.000Z']);
});

test('editing a series by scope', () => {
  const series = '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=4;BYDAY=MO';
  const move = { start: '2026-11-24T03:00:00Z', end: '2026-11-24T04:00:00Z', allDay: false };
  const one = editOccurrence(series, '2026-11-23T01:00:00Z', move, 'this')!;
  assert.equal(one.series, `${series}|exdate=2026-11-23T01:00:00Z`);
  assert.equal(one.detached, '2026-11-24T03:00:00Z/2026-11-24T04:00:00Z|tz=Asia/Shanghai');
  const following = editOccurrence(series, '2026-11-23T01:00:00Z', move, 'following')!;
  assert.equal(following.series, '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=1;BYDAY=MO');
  assert.equal(following.detached, '2026-11-24T03:00:00Z/2026-11-24T04:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=3;BYDAY=TU');
  const all = editOccurrence(series, '2026-11-23T01:00:00Z', move, 'all')!;
  assert.equal(all.series, '2026-11-17T03:00:00Z/2026-11-17T04:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY;COUNT=4;BYDAY=TU');
  assert.equal(all.detached, undefined);
  const untilSeries = '2026-11-16|rrule=FREQ=DAILY;UNTIL=20261130';
  assert.equal(deleteOccurrence(untilSeries, '2026-11-20', 'following')!.series, '2026-11-16|rrule=FREQ=DAILY;UNTIL=20261119');
  assert.equal(deleteOccurrence(untilSeries, '2026-11-20', 'this')!.series, `${untilSeries}|exdate=2026-11-20`);
  assert.equal(deleteOccurrence(untilSeries, '2026-11-20', 'all')!.series, null);
  assert.equal(editOccurrence('2026-11-16', '2026-11-16', { start: '2026-11-18', end: '2026-11-19', allDay: true }, 'this')!.series, '2026-11-18/2026-11-19');
});

test('date filters, sorting and ranges work on spans', () => {
  const date: PropertyDefinition = { id: randomUUID(), name: '日期', type: 'date' };
  const title: PropertyDefinition = { id: randomUUID(), name: '名称', type: 'title' };
  const row = (name: string, value: string): DatabaseRow => ({ id: randomUUID(), title: name, icon: null, properties: { [date.id]: value },
    revision: '1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const rows = [row('a', '2026-11-10/2026-11-20'), row('b', '2026-11-16'), row('c', '2026-11-15T17:00:00Z'), row('d', '2026-11-01|rrule=FREQ=WEEKLY')];
  const view: DatabaseView = { id: randomUUID(), name: 'v', type: 'table', filters: [{ propertyId: date.id, operator: 'equals', value: '2026-11-16' }],
    sorts: [{ propertyId: date.id, direction: 'asc' }], hiddenPropertyIds: [], propertyOrder: [], widths: {} };
  const names = (v: DatabaseView, range?: { from: string; to: string }) =>
    evaluateView(rows, [title, date], v, { timeZone: 'Asia/Shanghai' }, range ? { propertyId: date.id, ...range } : undefined).rows.map(r => r.title);
  assert.deepEqual(names(view), ['a', 'c', 'b']);
  assert.deepEqual(names({ ...view, filters: [{ propertyId: date.id, operator: 'gt', value: '2026-11-16' }] }), ['a']);
  assert.deepEqual(names({ ...view, filters: [] }, { from: '2026-11-21', to: '2026-11-30' }), ['d']);
});
