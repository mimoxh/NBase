import { parseDateCell } from '@nbase/contracts';
import { formatDateCellText, formatReminder, recurrenceSummary } from './format';
import { readerTimeZone, todayIn } from './model';
import './calendar.css';

/** A stored date value for reading, with marks for repetition and reminders. Text that is not a date value shows as it is. */
export function DateText({ value, timeZone = readerTimeZone() }: { value: string; timeZone?: string }) {
  const cell = parseDateCell(value);
  if (!cell) return <span className="nb-cal-date-text">{value}</span>;
  const today = todayIn(timeZone);
  const repeat = cell.rrule ? recurrenceSummary(cell.rrule, cell.allDay, timeZone, today) : '';
  const reminders = (cell.reminders ?? []).map(minutes => formatReminder(minutes, cell.allDay)).join('、');
  return <span className="nb-cal-date-text">
    <span>{formatDateCellText(cell, timeZone, today)}</span>
    {repeat && <span className="nb-cal-date-flag" role="img" title={repeat} aria-label={`重复：${repeat}`}>🔁</span>}
    {reminders && <span className="nb-cal-date-flag" role="img" title={`提醒：${reminders}`} aria-label={`提醒：${reminders}`}>⏰</span>}
  </span>;
}
