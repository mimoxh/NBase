import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const estimatedHeight = 320;
const gutter = 8;

/**
 * Floating panel that closes on outside click or Escape. By default it is positioned by the
 * caller's CSS class. With `portal`, it is placed next to its parent element with fixed
 * positioning, so a scrolling container (such as a wide table) cannot clip it.
 */
export function Popover({ label, children, onClose, className = 'nb-picker', portal = false, width = 260 }: {
  label: string; children: ReactNode; onClose: () => void; className?: string; portal?: boolean; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [placement, setPlacement] = useState<{ style: CSSProperties; host: Element } | null>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) closeRef.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key, true); };
  }, []);

  useLayoutEffect(() => {
    if (!portal) return;
    const update = () => {
      const anchor = marker.current?.parentElement;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter));
      const below = rect.bottom + estimatedHeight < window.innerHeight || rect.top < estimatedHeight;
      const style: CSSProperties = { position: 'fixed', left, right: 'auto', width,
        ...(below ? { top: rect.bottom + 4 } : { top: 'auto', bottom: window.innerHeight - rect.top + 4 }) };
      setPlacement({ style, host: anchor.closest('.nb-app') ?? document.body });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [portal, width]);

  if (!portal) return <div className={className} role="dialog" aria-label={label} ref={ref}>{children}</div>;
  return <>
    <span ref={marker} hidden />
    {placement && createPortal(<div className={className} role="dialog" aria-label={label} ref={ref} style={placement.style}>
      {children}</div>, placement.host)}
  </>;
}
