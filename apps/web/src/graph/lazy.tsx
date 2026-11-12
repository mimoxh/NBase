import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from 'react';

/** The graph (layout, canvas, styles) is its own chunk and loads the first time it is shown. */
const GraphDialogModule = lazy(() => import('./GraphDialog').then(module => ({ default: module.GraphDialog })));
const LocalGraphModule = lazy(() => import('./GraphView').then(module => ({ default: module.LocalGraphView })));

export function LazyGraphDialog(props: ComponentProps<typeof GraphDialogModule>) {
  return <Suspense fallback={null}><GraphDialogModule {...props} /></Suspense>;
}

const localOpenKey = 'nbase.graph.local';

/** Collapsed by default like the backlinks; nothing is fetched or loaded until it is opened. */
export function LazyLocalGraph(props: ComponentProps<typeof LocalGraphModule>) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(localOpenKey) === 'open'; } catch { return false; } });
  return <details className="nbase-backlinks nb-graph-details" open={open} onToggle={event => {
    const next = event.currentTarget.open;
    setOpen(next);
    try { localStorage.setItem(localOpenKey, next ? 'open' : ''); } catch { /* View preference only. */ }
  }}>
    <summary>关系图</summary>
    {open && <Suspense fallback={<p role="status">正在加载关系图…</p>}><LocalGraphModule {...props} /></Suspense>}
  </details>;
}

/** Ctrl/⌘ + Shift + G. Ignored during IME composition and while `blocked` (another dialog is open). */
export function useGraphShortcut(open: () => void, blocked: boolean): void {
  const latest = useRef(open); latest.current = open;
  useEffect(() => {
    if (blocked) return;
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey
        || event.key.toLowerCase() !== 'g') return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [blocked]);
}
