import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { databaseColumnWidth, type DatabaseView as View, type PropertyDefinition } from '@nbase/contracts';

export const titleColumnWidth = 280;

/** Column widths for a view, with a live preview while a column edge is dragged. */
export function useColumnResize(view: View, canWrite: boolean, onCommit: (widths: Record<string, number>) => void) {
  const [dragWidth, setDragWidth] = useState<{ id: string; width: number } | null>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const widthOf = (def: PropertyDefinition) => dragWidth?.id === def.id ? dragWidth.width
    : view.widths[def.id] ?? (def.type === 'title' ? titleColumnWidth : databaseColumnWidth.default);
  const startResize = (event: ReactPointerEvent<HTMLSpanElement>, def: PropertyDefinition) => {
    if (!canWrite) return;
    event.preventDefault(); event.stopPropagation();
    resizeStart.current = { x: event.clientX, width: widthOf(def) };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let latest = widthOf(def);
    const move = (moveEvent: PointerEvent) => {
      if (!resizeStart.current) return;
      latest = Math.round(Math.max(databaseColumnWidth.min, Math.min(databaseColumnWidth.max,
        resizeStart.current.width + moveEvent.clientX - resizeStart.current.x)));
      setDragWidth({ id: def.id, width: latest });
    };
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up);
      resizeStart.current = null; setDragWidth(null);
      if (latest !== widthOf(def)) onCommit({ ...view.widths, [def.id]: latest });
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
  };
  return { widthOf, startResize };
}
