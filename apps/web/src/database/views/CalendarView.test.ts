import { describe, expect, it } from 'vitest';
import { evaluateView, type DatabaseDocument, type DatabaseRow, type PropertyDefinition } from '@nbase/contracts';
import { monthWeeks, shiftMonth, visibleRange } from '../../calendar/layout';
import { buildEvents } from '../../calendar/model';
import { lockedPropertyIds } from '../sync';
import { calendarInputs, copiedProperties } from './CalendarView';

const ids = { title: '11111111-1111-4111-8111-111111111111', date: '22222222-2222-4222-8222-222222222222', note: '33333333-3333-4333-8333-333333333333',
  uid: '44444444-4444-4444-8444-444444444444', formula: '55555555-5555-4555-8555-555555555555' };
const properties: PropertyDefinition[] = [
  { id: ids.title, name: '名称', type: 'title' }, { id: ids.date, name: '日期', type: 'date' }, { id: ids.note, name: '备注', type: 'text' },
  { id: ids.uid, name: 'UID', type: 'text' }, { id: ids.formula, name: '公式', type: 'formula', formula: { expression: '1', resultType: 'number' } },
];
const row = (id: string, title: string, values: DatabaseRow['properties']): DatabaseRow =>
  ({ id, title, icon: null, properties: values, revision: '1', createdAt: '2026-11-02T03:00:00Z', updatedAt: '2026-11-02T03:00:00Z' });

describe('calendar month weeks', () => {
  it('fills whole weeks starting on Monday or Sunday', () => {
    const weeks = monthWeeks('2026-11', 1);
    expect(weeks[0]![0]).toBe('2026-10-26');
    expect(weeks.at(-1)![6]).toBe('2026-12-06');
    expect(weeks.flat()).toContain('2026-11-30');
    expect(monthWeeks('2026-11', 0)[0]![0]).toBe('2026-11-01');
  });

  it('handles a month starting on Monday and February of a leap year', () => {
    expect(monthWeeks('2026-06', 1)[0]![0]).toBe('2026-06-01');
    expect(monthWeeks('2028-02', 1).flat()).toContain('2028-02-29');
  });

  it('moves across years', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});

describe('database calendar rows', () => {
  it('turns rows into events, page times into moments, and skips empty values', () => {
    const rows = [row('a', '周会', { [ids.date]: '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai|rrule=FREQ=WEEKLY' }), row('b', '空', {})];
    const inputs = calendarInputs(rows, properties[1]!, false);
    expect(inputs).toHaveLength(1);
    const events = buildEvents(inputs, { from: '2026-11-01', to: '2026-11-30' }, 'Asia/Shanghai');
    expect(events.map(event => event.days.from)).toEqual(['2026-11-16', '2026-11-23', '2026-11-30']);
    expect(events.every(event => event.recurring && !event.readOnly)).toBe(true);
    const created: PropertyDefinition = { id: ids.note, name: '创建时间', type: 'created_time' };
    const moments = buildEvents(calendarInputs(rows, created, true), { from: '2026-11-01', to: '2026-11-30' }, 'Asia/Shanghai');
    // Same moment, so they are ordered by title in pinyin: 空 (kong) before 周会 (zhou).
    expect(moments.map(event => [event.rowId, event.allDay, event.readOnly])).toEqual([['b', false, true], ['a', false, true]]);
  });

  it('copies stored fields to a detached occurrence but not computed or skipped ones', () => {
    const source = row('a', '周会', { [ids.date]: '2026-11-16', [ids.note]: '带电脑', [ids.uid]: 'uid-1', [ids.formula]: 5 });
    expect(copiedProperties(source, properties, new Set([ids.uid]))).toEqual({ [ids.date]: '2026-11-16', [ids.note]: '带电脑' });
  });

  it('asks the query for rows touching the visible days', () => {
    const rows = [row('in', '内', { [ids.date]: '2026-11-20' }), row('out', '外', { [ids.date]: '2027-02-01' }),
      row('series', '系列', { [ids.date]: '2026-01-05|rrule=FREQ=MONTHLY' })];
    const range = visibleRange('month', '2026-11-16', 1);
    const view = { id: 'v', name: '日历', type: 'calendar' as const, filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} };
    const matched = evaluateView(rows, properties, view, { timeZone: 'Asia/Shanghai' }, { propertyId: ids.date, ...range }).rows.map(item => item.id);
    expect(matched).toEqual(['in', 'series']);
  });
});

describe('subscribed fields', () => {
  it('locks listed properties and the title when its field is listed', () => {
    const sync = { readOnlyPropertyIds: [ids.date, ids.title], fields: { titleId: ids.title, dateId: ids.date, locationId: '', descriptionId: '', uidId: ids.uid } };
    const doc = { properties, calendarSync: sync } as unknown as DatabaseDocument;
    expect([...lockedPropertyIds(doc)].sort()).toEqual([ids.title, ids.date].sort());
    expect(lockedPropertyIds({ properties }).size).toBe(0);
  });
});
