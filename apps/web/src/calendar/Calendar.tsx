import type { ReactNode } from 'react';
import { AgendaList } from './AgendaList';
import { CalendarHeader } from './CalendarHeader';
import type { EventSpan } from './editing';
import { calendarTitle } from './format';
import { agendaMaxDays, agendaPageDays, shiftAnchor, visibleRange, weekDays, type CalendarMode, type WeekStart } from './layout';
import type { CalendarEvent } from './model';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';
import type { EventChangeHandler } from './useEventDrag';
import './calendar.css';

export interface CalendarProps {
  mode: CalendarMode;
  /** A day inside the page shown; the first day for the agenda. */
  anchor: string;
  weekStart: WeekStart;
  timeZone: string;
  today: string;
  /** Occurrences of `visibleRange(mode, anchor, weekStart, agendaDays)`. */
  events: readonly CalendarEvent[];
  agendaDays?: number;
  onMode: (mode: CalendarMode) => void;
  onAnchor: (day: string) => void;
  /** Extends the agenda; the button shows until the longest range is reached. */
  onAgendaMore?: (() => void) | undefined;
  onOpen: (event: CalendarEvent) => void;
  onCreate?: ((span: EventSpan) => void) | undefined;
  onChange?: EventChangeHandler | undefined;
  /** Clicking a day number, e.g. to open that day's daily note. */
  onDayClick?: ((day: string) => void) | undefined;
  /** Shown in the header, e.g. loading or row-limit notices. */
  status?: ReactNode;
  label?: string;
}

/** Header and body of a calendar in any mode. It only reports what the reader does; the owner writes. */
export function Calendar({ mode, anchor, weekStart, timeZone, today, events, agendaDays = agendaPageDays, onMode, onAnchor, onAgendaMore,
  onOpen, onCreate, onChange, onDayClick, status, label = '日历' }: CalendarProps) {
  const range = visibleRange(mode, anchor, weekStart, agendaDays);
  return <section className="nb-cal" aria-label={label}>
    <CalendarHeader mode={mode} title={calendarTitle(mode, anchor, range)} onMode={onMode} onToday={() => onAnchor(today)}
      onStep={by => onAnchor(shiftAnchor(mode, anchor, by))}>{status}</CalendarHeader>
    {mode === 'month' && <MonthGrid month={anchor.slice(0, 7)} weekStart={weekStart} today={today} timeZone={timeZone} events={events}
      onOpen={onOpen} onCreate={onCreate} onChange={onChange} onDayClick={onDayClick} />}
    {(mode === 'week' || mode === 'day') && <TimeGrid key={mode} days={mode === 'week' ? weekDays(anchor, weekStart) : [anchor]} today={today}
      timeZone={timeZone} events={events} onOpen={onOpen} onCreate={onCreate} onChange={onChange} onDayClick={onDayClick} />}
    {mode === 'agenda' && <AgendaList range={range} today={today} timeZone={timeZone} events={events} onOpen={onOpen}
      onMore={onAgendaMore && agendaDays < agendaMaxDays ? onAgendaMore : undefined} />}
  </section>;
}

