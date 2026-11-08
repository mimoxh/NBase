import { lazy, Suspense, type ComponentProps } from 'react';

/** The table UI loads on first use, so documents that never show a database stay light. */
const DatabaseViewModule = lazy(() => import('./DatabaseView').then(module => ({ default: module.DatabaseView })));
const RowPanelModule = lazy(() => import('./RowPanel').then(module => ({ default: module.RowPanel })));

export function LazyDatabaseView(props: ComponentProps<typeof DatabaseViewModule>) {
  return <Suspense fallback={<div className="nb-db-loading" role="status">正在加载数据库…</div>}>
    <DatabaseViewModule {...props} /></Suspense>;
}

export function LazyRowPanel(props: ComponentProps<typeof RowPanelModule>) {
  return <Suspense fallback={null}><RowPanelModule {...props} /></Suspense>;
}
