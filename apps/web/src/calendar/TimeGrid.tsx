import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { instantText } from '@nbase/contracts';
import { defaultEventMinutes, minimumEventMinutes, type EventSpan } from './editing';
import { EventItem, EventText } from './EventItem';
import { formatDay, formatEventTime, weekdayLabel } from './format';
import { instantAt, layoutTimed, minutesInDay, minutesPerDay, packLanes, snapMinutes } from './layout';
import { isSpanning, type CalendarEvent } from './model';
import { displayEvents, useEventDrag, type EventChangeHandler } from './useEventDrag';

export interface TimeGridProps {
  /** One column per day: seven for a week, one for a day. */
  days: readonly string[];
  today: string;
  timeZone: string;
  events: readonly CalendarEvent[];
  onOpen: (event: CalendarEvent) => void;
  /** Clicking or dragging on empty time creates a timed event. */
  onCreate?: ((span: EventSpan) => void) | undefined;
  /** Lets events move in 15-minute steps, across days and to or from the all-day lane, and be resized. */
  onChange?: EventChangeHandler | undefined;
  /** Makes each column's day number a button, e.g. for the day's daily note. */
  onDayClick?: ((day: string) => void) | undefined;
  /** Hour height in pixels. */
  hourHeight?: number;
  /** Hour shown at the top when the grid opens. */
  scrollHour?: number;
}

const laneLimit = 3;
const percent = (minutes: number) => `${(minutes / minutesPerDay) * 100}%`;

export function TimeGrid({ days, today, timeZone, events, onOpen, onCreate, onChange, onDayClick, hourHeight = 44, scrollHour = 8 }: TimeGridProps) {
  const drag = useEventDrag(timeZone, onChange);
  const range = { from: days[0]!, to: days.at(-1)! };
  const shown = displayEvents(events, drag, range, timeZone);
  const [expanded, setExpanded] = useState(false);
  const lanes = packLanes(shown.filter(isSpanning), days, expanded ? Infinity : laneLimit);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [creating, setCreating] = useState<{ day: string; from: number; to: number } | null>(null);
  const stopCreate = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, scrollHour * hourHeight - 8);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => { clearInterval(timer); stopCreate.current?.(); };
  }, []);

  const createDown = (pointer: ReactPointerEvent<HTMLDivElement>, day: string) => {
    if (!onCreate || pointer.button !== 0 || !pointer.isPrimary || (pointer.target as HTMLElement).closest('.nb-cal-event')) return;
    const column = pointer.currentTarget;
    const minutesAt = (y: number) => { const rect = column.getBoundingClientRect(); return (y - rect.top) / rect.height * minutesPerDay; };
    const anchor = Math.min(minutesPerDay - minimumEventMinutes, snapMinutes(minutesAt(pointer.clientY), 15, 'floor'));
    const { pointerId, clientY: y0 } = pointer;
    const touch = pointer.pointerType === 'touch';
    let span: { day: string; from: number; to: number } | null = null;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (Math.abs(next.clientY - y0) < 5 && !span) return;
      if (touch) { stop(); return; }
      const at = snapMinutes(minutesAt(next.clientY));
      span = at >= anchor ? { day, from: anchor, to: Math.max(anchor + minimumEventMinutes, at) } : { day, from: at, to: anchor + minimumEventMinutes };
      setCreating(span);
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const chosen = span ?? { day, from: anchor, to: Math.min(minutesPerDay, anchor + defaultEventMinutes) };
      stop();
      onCreate({ start: instantText(instantAt(day, chosen.from, timeZone)), end: instantText(instantAt(day, chosen.to, timeZone)), allDay: false });
    };
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) stop(); };
    const key = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.stopPropagation(); stop(); } };
    function stop() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (stopCreate.current === stop) stopCreate.current = null;
      setCreating(null);
    }
    stopCreate.current?.();
    stopCreate.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  };

  const style = { '--nb-cal-cols': days.length, '--nb-cal-hour': `${hourHeight}px` } as CSSProperties;
  return <div className={`nb-cal-time ${drag.session ? 'nb-cal-dragging-on' : ''}`} style={style}>
    <div className="nb-cal-time-head">
      <div className="nb-cal-gutter" />
      {days.map(day => <div key={day} className={`nb-cal-col-head ${day === today ? 'nb-cal-today' : ''}`} aria-label={formatDay(day, { year: true, weekday: true })}>
        <span className="nb-cal-col-weekday">{weekdayLabel(day)}</span>
        {onDayClick
          ? <button className="nb-cal-col-day nb-cal-day-open" aria-label={formatDay(day, { year: true })} title={formatDay(day, { year: true })}
            onClick={() => onDayClick(day)}>{Number(day.slice(8))}</button>
          : <span className="nb-cal-col-day">{Number(day.slice(8))}</span>}
      </div>)}
    </div>
    <div className="nb-cal-allday">
      <div className="nb-cal-gutter nb-cal-allday-label">
        全天
        {expanded && lanes.lanes > laneLimit && <button className="nb-cal-more-button" onClick={() => setExpanded(false)}>收起</button>}
      </div>
      <div className="nb-cal-allday-lanes" style={{ gridTemplateRows: `repeat(${Math.max(1, lanes.lanes)}, 22px)` }}>
        {days.map((day, column) => <div key={day} className="nb-cal-allday-cell" data-cal-day={day} style={{ gridColumn: column + 1 }} />)}
        {lanes.bars.map(bar => <EventItem key={bar.event.key} event={bar.event} timeZone={timeZone} drag={drag} origin="lane" onOpen={onOpen}
          resize={bar.clippedEnd ? undefined : 'x'} style={{ gridColumn: `${bar.start + 1} / span ${bar.span}`, gridRow: bar.lane + 1 }}
          className={`nb-cal-bar nb-cal-bar-fill ${bar.clippedStart ? 'nb-cal-clip-start' : ''} ${bar.clippedEnd ? 'nb-cal-clip-end' : ''}`}>
          <EventText event={bar.event} timeZone={timeZone} time="start" />
        </EventItem>)}
        {lanes.more.map((count, column) => count > 0 && <button key={`more-${column}`} className="nb-cal-more-button"
          style={{ gridColumn: column + 1, gridRow: lanes.lanes }} onClick={() => setExpanded(true)}>还有 {count} 项</button>)}
      </div>
    </div>
    <div className="nb-cal-scroll" ref={scrollRef}>
      <div className="nb-cal-time-body" style={{ height: 24 * hourHeight }}>
        <div className="nb-cal-gutter nb-cal-hours" aria-hidden="true">
          {Array.from({ length: 23 }, (_, index) => <span key={index} style={{ top: (index + 1) * hourHeight }}>{`${String(index + 1).padStart(2, '0')}:00`}</span>)}
        </div>
        {days.map(day => <div key={day} data-cal-col={day} className={`nb-cal-col ${day === today ? 'nb-cal-today' : ''} ${onCreate ? 'nb-cal-col-create' : ''}`}
          onPointerDown={pointer => createDown(pointer, day)}>
          {layoutTimed(shown, day, timeZone).map(block => {
            const short = block.bottom - block.top < 45;
            return <EventItem key={block.event.key} event={block.event} timeZone={timeZone} drag={drag} origin="grid" onOpen={onOpen} resize="y"
              className={`nb-cal-block ${short ? 'nb-cal-block-short' : ''}`}
              style={{ top: percent(block.top), height: percent(block.bottom - block.top),
                left: `calc(${(block.column / block.columns) * 100}% + 1px)`, width: `calc(${100 / block.columns}% - 3px)` }}>
              <span className="nb-cal-block-title"><EventText event={block.event} timeZone={timeZone} time={short ? 'start' : 'none'} /></span>
              {!short && <span className="nb-cal-block-time">{formatEventTime(block.event, timeZone)}</span>}
            </EventItem>;
          })}
          {creating?.day === day && <div className="nb-cal-creating" style={{ top: percent(creating.from), height: percent(creating.to - creating.from) }} />}
          {day === today && <div className="nb-cal-now" style={{ top: percent(minutesInDay(now, day, timeZone)) }} aria-hidden="true" />}
        </div>)}
      </div>
    </div>
  </div>;
}

