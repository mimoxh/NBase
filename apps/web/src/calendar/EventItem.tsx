import type { CSSProperties, ReactNode } from 'react';
import type { DragOrigin } from './editing';
import { eventLabel, formatClock, formatEventTime } from './format';
import type { CalendarEvent } from './model';
import type { EventDrag } from './useEventDrag';

/** Icon, time, title and the repeat and reminder marks of an occurrence. */
export function EventText({ event, timeZone, time = 'none' }: { event: CalendarEvent; timeZone: string; time?: 'none' | 'start' | 'range' }) {
  return <>
    {event.icon && <span className="nb-cal-event-icon" aria-hidden="true">{event.icon}</span>}
    {time !== 'none' && !event.allDay && <span className="nb-cal-event-time">{time === 'start' ? formatClock(event.startMs, timeZone) : formatEventTime(event, timeZone)}</span>}
    <span className="nb-cal-event-title">{event.title || '未命名'}</span>
    {event.recurring && <span className="nb-cal-event-flag" aria-hidden="true" title="重复">🔁</span>}
    {event.hasReminders && <span className="nb-cal-event-flag" aria-hidden="true" title="有提醒">⏰</span>}
  </>;
}

/**
 * One occurrence. It opens on click, Enter or Space; with a drag it moves, and with `resize` its end (`x`) or
 * bottom edge (`y`) can be pulled. Read-only events only open.
 */
export function EventItem({ event, timeZone, drag, origin, resize, className = '', style, onOpen, children }: {
  event: CalendarEvent; timeZone: string; drag?: EventDrag | undefined; origin?: DragOrigin | undefined; resize?: 'x' | 'y' | undefined;
  className?: string; style?: CSSProperties | undefined; onOpen: (event: CalendarEvent) => void; children?: ReactNode;
}) {
  const movable = Boolean(drag?.enabled && origin && !event.readOnly);
  const dragging = drag?.session?.event.key === event.key;
  return <div role="button" tabIndex={0} aria-label={eventLabel(event, timeZone)} title={eventLabel(event, timeZone)} style={style}
    className={`nb-cal-event nb-cal-color-${event.color ?? 'default'} ${movable ? 'nb-cal-movable' : ''} ${dragging ? 'nb-cal-dragging' : ''} ${event.readOnly ? 'nb-cal-readonly' : ''} ${className}`}
    onPointerDown={movable ? pointer => drag!.start(pointer, event, 'move', origin!) : undefined}
    onClick={() => { if (!drag?.justDragged()) onOpen(event); }}
    onKeyDown={key => { if (key.key === 'Enter' || key.key === ' ') { key.preventDefault(); onOpen(event); } }}>
    {children ?? <EventText event={event} timeZone={timeZone} />}
    {movable && resize && <span className={`nb-cal-resize nb-cal-resize-${resize}`} aria-hidden="true"
      onPointerDown={pointer => drag!.start(pointer, event, 'resize', origin!)} />}
  </div>;
}
