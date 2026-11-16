import { useMemo, useState, type CSSProperties } from 'react';
import { Popover } from '../components/Popover';
import type { EventSpan } from './editing';
import { EventItem, EventText } from './EventItem';
import { formatDay, weekdayLabel } from './format';
import { monthWeeks, packLanes, type WeekStart } from './layout';
import { isSpanning, type CalendarEvent } from './model';
import { displayEvents, useEventDrag, type EventChangeHandler } from './useEventDrag';

export interface MonthGridProps {
  /** `YYYY-MM`. */
  month: string;
  weekStart: WeekStart;
  today: string;
  timeZone: string;
  events: readonly CalendarEvent[];
  onOpen: (event: CalendarEvent) => void;
  /** Gives each day a "+" that creates an all-day event. */
  onCreate?: ((span: EventSpan) => void) | undefined;
  /** Lets events be moved by day and lengthened by their end. */
  onChange?: EventChangeHandler | undefined;
  /** Makes each day number a button, e.g. for the day's daily note. */
  onDayClick?: ((day: string) => void) | undefined;
  /** Rows of events per week; on a full day the last one gives way to "还有 N 项". */
  maxLanes?: number;
}

const barClass = (event: CalendarEvent) => `nb-cal-bar ${isSpanning(event) ? 'nb-cal-bar-fill' : 'nb-cal-bar-dot'}`;

export function MonthGrid({ month, weekStart, today, timeZone, events, onOpen, onCreate, onChange, onDayClick, maxLanes = 3 }: MonthGridProps) {
  const weeks = useMemo(() => monthWeeks(month, weekStart), [month, weekStart]);
  const drag = useEventDrag(timeZone, onChange);
  const [more, setMore] = useState<string | null>(null);
  const range = { from: weeks[0]![0]!, to: weeks.at(-1)![6]! };
  const shown = displayEvents(events, drag, range, timeZone);
  return <div className={`nb-cal-month ${drag.session ? 'nb-cal-dragging-on' : ''}`} role="grid" aria-label={`${month.slice(0, 4)}年${Number(month.slice(5))}月`}
    style={{ '--nb-cal-lanes': maxLanes } as CSSProperties}>
    <div className="nb-cal-weekdays" role="row">
      {weeks[0]!.map(day => <div key={day} role="columnheader" className="nb-cal-weekday">{weekdayLabel(day).slice(1)}</div>)}
    </div>
    {weeks.map(week => {
      const layout = packLanes(shown, week, maxLanes);
      return <div key={week[0]} className="nb-cal-week" role="row">
        {week.map((day, column) => {
          const label = formatDay(day, { year: true, weekday: true });
          return <div key={day} role="gridcell" aria-label={label} data-cal-day={day} style={{ gridColumn: column + 1 }}
            className={`nb-cal-day ${day.startsWith(month) ? '' : 'nb-cal-day-out'} ${day === today ? 'nb-cal-today' : ''}`}>
            <div className="nb-cal-day-head">
              {(() => {
                const number = day.endsWith('-01')
                  ? <><span className="nb-cal-day-month">{Number(day.slice(5, 7))}月</span>1<span className="nb-cal-day-month">日</span></>
                  : Number(day.slice(8));
                return onDayClick
                  ? <button className="nb-cal-day-number nb-cal-day-open" aria-label={label} title={label} onClick={() => onDayClick(day)}>{number}</button>
                  : <span className="nb-cal-day-number">{number}</span>;
              })()}
              {onCreate && <button className="nb-cal-add" aria-label={`在${label}新建`} title="新建"
                onClick={() => onCreate({ start: day, allDay: true })}>+</button>}
            </div>
          </div>;
        })}
        {layout.bars.map(bar => <EventItem key={bar.event.key} event={bar.event} timeZone={timeZone} drag={drag} origin="month" onOpen={onOpen}
          resize={bar.clippedEnd ? undefined : 'x'} style={{ gridColumn: `${bar.start + 1} / span ${bar.span}`, gridRow: bar.lane + 2 }}
          className={`${barClass(bar.event)} ${bar.clippedStart ? 'nb-cal-clip-start' : ''} ${bar.clippedEnd ? 'nb-cal-clip-end' : ''}`}>
          <EventText event={bar.event} timeZone={timeZone} time="start" />
        </EventItem>)}
        {layout.more.map((count, column) => count > 0 && <span key={`more-${column}`} className="nb-cal-more" style={{ gridColumn: column + 1, gridRow: maxLanes + 1 }}>
          <button className="nb-cal-more-button" onClick={() => setMore(week[column]!)}>还有 {count} 项</button>
          {more === week[column] && <Popover label={`${formatDay(week[column]!)}的全部日程`} className="nb-cal-pop" portal width={260} onClose={() => setMore(null)}>
            <div className="nb-cal-pop-title">{formatDay(week[column]!, { weekday: true })}</div>
            <div className="nb-cal-day-list">{layout.byColumn[column]!.map(event => <EventItem key={event.key} event={event} timeZone={timeZone}
              className={barClass(event)} onOpen={next => { setMore(null); onOpen(next); }}>
              <EventText event={event} timeZone={timeZone} time="start" />
            </EventItem>)}</div>
          </Popover>}
        </span>)}
      </div>;
    })}
  </div>;
}
