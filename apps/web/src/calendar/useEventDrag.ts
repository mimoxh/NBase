import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DayRange } from '@nbase/contracts';
import { dragSpan, eventSpan, sameSpan, type DragHit, type DragOrigin, type DragSession, type EventSpan } from './editing';
import { minutesInDay, minutesPerDay } from './layout';
import { compareEvents, withSpan, type CalendarEvent } from './model';

export type EventChangeHandler = (event: CalendarEvent, next: EventSpan) => void;

/** Days carry `data-cal-day`; time grid columns carry `data-cal-col` and span the whole day top to bottom. */
export function hitAt(x: number, y: number): DragHit | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (!(element instanceof HTMLElement)) continue;
    const day = element.dataset.calDay;
    if (day) return { area: 'day', day };
    const column = element.dataset.calCol;
    if (column) {
      const rect = element.getBoundingClientRect();
      return { area: 'time', day: column, minutes: Math.max(0, Math.min(minutesPerDay, (y - rect.top) / rect.height * minutesPerDay)) };
    }
  }
  return null;
}

export interface EventDrag {
  /** False without a change handler; events then only open. */
  enabled: boolean;
  session: DragSession | null;
  preview: EventSpan | null;
  start: (pointer: ReactPointerEvent<HTMLElement>, event: CalendarEvent, kind: DragSession['kind'], origin: DragOrigin) => void;
  /** True for the click that ends a drag, so it does not also open the event. */
  justDragged: () => boolean;
}

const touchDelay = 400;
const threshold = 5;
const edge = 28;

/**
 * Pointer dragging of occurrences. A mouse or pen drags after a few pixels; a finger has to rest on the event
 * first, so swiping still scrolls. Escape cancels.
 */
export function useEventDrag(timeZone: string, onChange?: EventChangeHandler): EventDrag {
  const [state, setState] = useState<{ session: DragSession; preview: EventSpan | null } | null>(null);
  const dragged = useRef(false);
  const stopRef = useRef<(() => void) | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => () => stopRef.current?.(), []);

  const start = useCallback((pointer: ReactPointerEvent<HTMLElement>, event: CalendarEvent, kind: DragSession['kind'], origin: DragOrigin) => {
    if (!changeRef.current || event.readOnly || pointer.button !== 0 || !pointer.isPrimary) return;
    pointer.stopPropagation();
    const hit = hitAt(pointer.clientX, pointer.clientY);
    if (!hit) return;
    const session: DragSession = { event, kind, origin, grabDay: hit.day,
      grabOffset: hit.area === 'time' ? hit.minutes - minutesInDay(event.startMs, hit.day, timeZone) : 0 };
    const { pointerId, clientX: x0, clientY: y0 } = pointer;
    const touch = pointer.pointerType === 'touch';
    const scroller = pointer.currentTarget.closest('.nb-cal-time')?.querySelector<HTMLElement>('.nb-cal-scroll') ?? null;
    let active = false;
    let latest: EventSpan | null = null;
    const activate = () => { active = true; setState({ session, preview: null }); };
    const update = (x: number, y: number) => {
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (y < rect.top + edge && y > rect.top - edge) scroller.scrollTop -= 16;
        else if (y > rect.bottom - edge && y < rect.bottom + edge) scroller.scrollTop += 16;
      }
      const target = hitAt(x, y);
      latest = target ? dragSpan(session, target, timeZone) : null;
      setState({ session, preview: latest });
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(next.clientX - x0, next.clientY - y0) < threshold) return;
        if (touch) { stop(); return; }
        activate();
      }
      update(next.clientX, next.clientY);
    };
    const markDragged = () => { dragged.current = true; setTimeout(() => { dragged.current = false; }, 0); };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const wasActive = active;
      stop();
      if (!wasActive) return;
      markDragged();
      if (latest && !sameSpan(latest, eventSpan(event))) changeRef.current?.(event, latest);
    };
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) stop(); };
    const key = (next: KeyboardEvent) => {
      if (next.key !== 'Escape' || !active) return;
      next.preventDefault(); next.stopPropagation();
      markDragged();
      stop();
    };
    const holdTouch = (next: TouchEvent) => { if (active) next.preventDefault(); };
    const timer = touch ? setTimeout(activate, touchDelay) : undefined;
    function stop() {
      clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('touchmove', holdTouch);
      if (stopRef.current === stop) stopRef.current = null;
      setState(null);
    }
    stopRef.current?.();
    stopRef.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    document.addEventListener('touchmove', holdTouch, { passive: false });
  }, [timeZone]);

  return { enabled: Boolean(onChange), session: state?.session ?? null, preview: state?.preview ?? null, start, justDragged: () => dragged.current };
}

/** Events with the dragged one drawn at its preview span. */
export function displayEvents(events: readonly CalendarEvent[], drag: EventDrag, range: DayRange, timeZone: string): readonly CalendarEvent[] {
  const session = drag.session;
  if (!session || !drag.preview) return events;
  const moved = withSpan(session.event, drag.preview, range, timeZone);
  const rest = events.filter(event => event.key !== session.event.key);
  return moved ? [...rest, moved].sort(compareEvents) : rest;
}
