import { lazy, Suspense, type ComponentProps } from 'react';

/** The whiteboard engine is its own chunk; documents and databases never load it. */
const WhiteboardModule = lazy(() => import('./WhiteboardView'));

export function LazyWhiteboard(props: ComponentProps<typeof WhiteboardModule>) {
  return <Suspense fallback={<div className="nb-db-loading" role="status">正在加载白板…</div>}><WhiteboardModule {...props} /></Suspense>;
}
