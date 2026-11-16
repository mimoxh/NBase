import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarReminderItem } from '@nbase/contracts';
import { claimFire, planReminders, pruneFired, reminderKey } from './scheduler';

const item = (rowId: string, occurrenceStart: string, minutes: number, at: string): CalendarReminderItem =>
  ({ databaseId: 'db', rowId, title: `事件 ${rowId}`, occurrenceStart, at, minutes });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T06:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const now = () => Date.now();
const horizon = 20 * 60_000;

describe('planReminders', () => {
  it('schedules reminders inside the window with their delay', () => {
    const items = [
      item('a', '2026-11-16T06:10:00Z', 0, '2026-11-16T06:10:00Z'),
      item('b', '2026-11-16T06:33:00Z', 15, '2026-11-16T06:18:00Z'),
      item('c', '2026-11-16T09:00:00Z', 0, '2026-11-16T09:00:00Z'),
    ];
    const plans = planReminders(items, now(), new Set(), horizon);
    expect(plans.map(plan => plan.item.rowId)).toEqual(['a', 'b']);
    expect(plans[0]!.delay).toBe(10 * 60_000);
    expect(plans[1]!.delay).toBe(18 * 60_000);
  });

  it('fires reminders that just became due, but drops long-missed ones', () => {
    const items = [
      item('a', '2026-11-16T06:00:00Z', 0, '2026-11-16T05:59:30Z'),
      item('b', '2026-11-16T06:00:00Z', 0, '2026-11-16T04:00:00Z'),
    ];
    expect(planReminders(items, now(), new Set(), horizon).map(plan => plan.item.rowId)).toEqual(['a']);
  });

  it('dedupes repeated items and skips keys that already fired', () => {
    const due = item('a', '2026-11-16T06:10:00Z', 0, '2026-11-16T06:10:00Z');
    const other = item('b', '2026-11-16T06:15:00Z', 0, '2026-11-16T06:15:00Z');
    const plans = planReminders([due, due, other], now(), new Set([reminderKey(other)]), horizon);
    expect(plans.map(plan => plan.item.rowId)).toEqual(['a']);
  });

  it('keeps different lead times of one occurrence as separate reminders', () => {
    const items = [
      item('a', '2026-11-16T06:30:00Z', 25, '2026-11-16T06:05:00Z'),
      item('a', '2026-11-16T06:30:00Z', 15, '2026-11-16T06:15:00Z'),
    ];
    expect(planReminders(items, now(), new Set(), horizon)).toHaveLength(2);
  });
});

describe('fired-record expiry', () => {
  it('prunes expired entries and keeps fresh ones', () => {
    const record = { old: now() - 1000, fresh: now() + 1000 };
    expect(pruneFired(record, now())).toEqual({ fresh: now() + 1000 });
  });
});

describe('claimFire', () => {
  const storage = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  };

  it('lets only the first tab claim a reminder', () => {
    const shared = storage();
    expect(claimFire(shared, 'k', 'r1|d|0', now() + 86_400_000, now())).toBe(true);
    expect(claimFire(shared, 'k', 'r1|d|0', now() + 86_400_000, now())).toBe(false);
    expect(claimFire(shared, 'k', 'r2|d|0', now() + 86_400_000, now())).toBe(true);
  });

  it('allows firing again after the record expired', () => {
    const shared = storage();
    expect(claimFire(shared, 'k', 'r1|d|0', now() + 1000, now())).toBe(true);
    vi.setSystemTime(new Date(now() + 2000));
    expect(claimFire(shared, 'k', 'r1|d|0', now() + 86_400_000, now())).toBe(true);
  });
});
