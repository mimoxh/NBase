import type { DayRange } from '@nbase/contracts';
import { EventItem, EventText } from './EventItem';
import { formatDay, formatEventTime } from './format';
import { groupByDay } from './layout';
import type { CalendarEvent } from './model';

export interface AgendaListProps {
  range: DayRange;
  today: string;
  timeZone: string;
  events: readonly CalendarEvent[];
  onOpen: (event: CalendarEvent) => void;
  /** Shows a button that extends the range. */
  onMore?: (() => void) | undefined;
  moreLabel?: string;
}

/** Days that have events, in order; an event spanning days is listed on each. */
export function AgendaList({ range, today, timeZone, events, onOpen, onMore, moreLabel = '再显示 30 天' }: AgendaListProps) {
  const days = groupByDay(events, range);
  return <div className="nb-cal-agenda">
    {!days.length && <p className="nb-cal-empty">{formatDay(range.from, { today })} 至 {formatDay(range.to, { today })}没有日程。</p>}
    {days.map(group => <section key={group.day} className={`nb-cal-agenda-day ${group.day === today ? 'nb-cal-today' : ''}`}
      aria-label={formatDay(group.day, { year: true, weekday: true })}>
      <h3 className="nb-cal-agenda-head">
        <span>{formatDay(group.day, { today, weekday: true })}</span>
        {group.day === today && <span className="nb-cal-agenda-badge">今天</span>}
      </h3>
      <ul className="nb-cal-agenda-items">
        {group.events.map(event => <li key={event.key}>
          <EventItem event={event} timeZone={timeZone} onOpen={onOpen} className="nb-cal-agenda-item">
            <span className="nb-cal-agenda-time">{formatEventTime(event, timeZone)}</span>
            <span className="nb-cal-dot" aria-hidden="true" />
            <EventText event={event} timeZone={timeZone} />
          </EventItem>
        </li>)}
      </ul>
    </section>)}
    {onMore && <button className="nb-btn nb-btn-quiet nb-cal-agenda-more" onClick={onMore}>{moreLabel}</button>}
  </div>;
}
