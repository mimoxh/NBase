import { useEffect, useState } from 'react';
import type { PageBacklink, PageBacklinksResponse } from '@nbase/contracts';
import { ApiError, pageClient } from './client';

export function PageBacklinks({ workspaceId, pageId, revision, onOpen }: {
  workspaceId: string;
  pageId: string;
  revision: string;
  onOpen: (link: PageBacklink) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PageBacklinksResponse | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null); setError('');
    void pageClient.backlinks(workspaceId, pageId, controller.signal).then(response => {
      if (!controller.signal.aborted) setData(response);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof ApiError && reason.status === 401
        ? '登录已失效，请重新登录。' : '暂时无法读取反向链接。');
    });
    return () => controller.abort();
  }, [open, pageId, workspaceId, revision, refresh]);

  return <details className="nbase-backlinks" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>反向链接</summary>
    {open && <div>
      {!error && !data && <p role="status">正在读取反向链接…</p>}
      {error && <p role="alert">{error}</p>}
      {data && (data.links.length ? <ul>{data.links.map(link => <li key={`${link.sourcePageId}:${link.occurrence}`}>
        <button type="button" className="nb-btn nb-btn-quiet" onClick={() => onOpen(link)}>
          <strong>{link.sourceTitle || '未命名页面'}</strong>
          {link.snippet && <small>{link.snippet}</small>}
        </button>
      </li>)}</ul> : <p>暂无已保存的页面引用。</p>)}
      {data?.truncated && <p>仅显示最近更新的引用。</p>}
      {(error || data) && <button type="button" className="nb-btn nb-btn-quiet" onClick={() => setRefresh(value => value + 1)}>刷新反向链接</button>}
    </div>}
  </details>;
}
