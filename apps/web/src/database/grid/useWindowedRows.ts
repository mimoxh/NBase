import { useLayoutEffect, useRef, useState } from 'react';

/** Cell height plus the bottom border. */
export const rowHeight = 35;
const overscan = 20;

/** Which rows of a long table are near the viewport. The page scrolls, not the table, so it measures against that scroller. */
export function useWindowedRows(count: number, enabled: boolean) {
  const anchor = useRef<HTMLTableSectionElement>(null);
  const [range, setRange] = useState({ start: 0, end: enabled ? Math.min(count, 60) : count });
  useLayoutEffect(() => {
    if (!enabled) { setRange({ start: 0, end: count }); return; }
    const element = anchor.current;
    if (!element) return;
    const scroller = element.closest<HTMLElement>('.nb-scroll');
    const target: HTMLElement | Window = scroller ?? window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = element.getBoundingClientRect().top;
      const viewportTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const height = scroller ? scroller.clientHeight : window.innerHeight;
      const first = Math.floor((viewportTop - top) / rowHeight);
      const start = Math.max(0, Math.min(count, first - overscan));
      const end = Math.max(start, Math.min(count, first + Math.ceil(height / rowHeight) + overscan));
      setRange(previous => previous.start === start && previous.end === end ? previous : { start, end });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    target.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [count, enabled]);
  return { anchor, ...range };
}
