import { lazy, Suspense, type ComponentProps } from 'react';

/** The workspace calendar (grids, panels, sync UI) is its own chunk and loads the first time it opens. */
const WorkspaceCalendarModule = lazy(() => import('./WorkspaceCalendarPage').then(module => ({ default: module.WorkspaceCalendarPage })));

export function LazyWorkspaceCalendar(props: ComponentProps<typeof WorkspaceCalendarModule>) {
  return <Suspense fallback={<div className="nb-db-status" role="status">正在加载日历…</div>}>
    <WorkspaceCalendarModule {...props} /></Suspense>;
}
