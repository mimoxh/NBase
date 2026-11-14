import { useEffect, useState } from 'react';
import type { PageListResponse, PageSummary } from '@nbase/contracts';
import { request, workspacePath } from './client';

/**
 * Pages kept under a database row. The sidebar tree stops at databases, so a row page lists its
 * own child pages here; otherwise the children of a page moved into a database could not be reached.
 */
export function RowChildPages({ workspaceId, rowId, revision, onOpen }: {
  workspaceId: string; rowId: string;
  /** Re-reads when the row page changes, for instance after a child was created from its body. */
  revision: string;
  onOpen: (pageId: string) => void;
}) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void request<PageListResponse>(`${workspacePath(workspaceId)}/pages?parentId=${encodeURIComponent(rowId)}&limit=100`,
      'GET', undefined, undefined, controller.signal)
      .then(response => { if (!controller.signal.aborted) setPages(response.pages); })
      .catch(() => { if (!controller.signal.aborted) setPages([]); });
    return () => controller.abort();
  }, [workspaceId, rowId, revision]);
  if (!pages.length) return null;
  return <section className="nb-row-children" aria-label="子页面">
    <h2>子页面</h2>
    <ul>{pages.map(page => <li key={page.id}><button type="button" className="nb-btn nb-btn-quiet" onClick={() => onOpen(page.id)}>
      <span aria-hidden="true">{page.icon ?? (page.kind === 'database' ? '🗃️' : page.kind === 'whiteboard' ? '🎨' : '📄')}</span>
      {page.title || '未命名页面'}</button></li>)}</ul>
  </section>;
}
