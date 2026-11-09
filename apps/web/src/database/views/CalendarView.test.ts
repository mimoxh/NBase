import { describe, expect, it } from 'vitest';
import { monthGrid, shiftMonth } from './CalendarView';

describe('calendar month grid', () => {
  it('fills whole weeks starting on Monday', () => {
    const days = monthGrid('2026-11');
    expect(days[0]).toBe('2026-10-26');
    expect(days.at(-1)).toBe('2026-12-06');
    expect(days.length % 7).toBe(0);
    expect(days).toContain('2026-11-30');
  });

  it('handles a month starting on Monday and February of a leap year', () => {
    expect(monthGrid('2026-06')[0]).toBe('2026-06-01');
    expect(monthGrid('2028-02')).toContain('2028-02-29');
  });

  it('moves across years', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});
