import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SharedPageResponse, SharedPageSummary, SharedRootResponse } from '@nbase/contracts';
import { ApiError } from './client';
import { sharedClient } from './collabClient';
import { message } from './workspaceErrors';
import './share.css';

type Failure = { title: string; body: string; retry: boolean };

function failureOf(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 410) return { title: '分享已结束', body: '这个链接已过期或被撤销，或者页面已被删除。如仍需阅读，请联系分享者重新生成链接。', retry: false };
    if (error.status === 404) return { title: '分享链接无效', body: '请检查链接是否完整复制。分享链接只能在分享者所在的本机或局域网中打开。', retry: false };
    if (error.status === 429) return { title: '访问过于频繁', body: '请稍等几分钟后再试。', retry: true };
  }
  return { title: '暂时无法打开分享', body: message(error), retry: true };
}

function useDocumentMeta(title: string) {
  useEffect(() => {
    const added = [['robots', 'noindex, nofollow'], ['referrer', 'no-referrer']].map(([name, content]) => {
      const meta = document.createElement('meta');
      meta.name = name!; meta.content = content!;
      document.head.append(meta);
      return meta;
    });
    return () => added.forEach(meta => meta.remove());
  }, []);
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · NBase 只读分享` : 'NBase 只读分享';
    return () => { document.title = previous; };
  }, [title]);
}

function PageList({ pages, parentId, current, onOpen }: {
  pages: SharedPageSummary[]; parentId: string | null; current: string; onOpen: (id: string) => void;
}) {
  const children = pages.filter(page => page.parentId === parentId);
  if (!children.length) return null;
  return <ul>{children.map(page => <li key={page.id}>
    <button className={page.id === current ? 'is-current' : ''} aria-current={page.id === current ? 'page' : undefined}
      onClick={() => onOpen(page.id)}>{page.kind === 'whiteboard' ? '🎨 ' : ''}{page.title || '未命名页面'}</button>
    <PageList pages={pages} parentId={page.id} current={current} onOpen={onOpen} />
  </li>)}</ul>;
}

/** Read-only view behind `#share=<id>.<token>`; never touches the workspace session or local drafts. */
export function SharedPage({ shareId, token }: { shareId: string; token: string }) {
  const [root, setRoot] = useState<SharedRootResponse | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [page, setPage] = useState<SharedPageResponse | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pageError, setPageError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  useDocumentMeta(page?.title ?? root?.title ?? '');

  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    sharedClient.root(shareId, token, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRoot(value);
      setCurrentId(previous => previous && value.pages.some(item => item.id === previous) ? previous : value.rootPageId);
    }).catch(error => { if (!controller.signal.aborted) setFailure(failureOf(error)); });
    return () => controller.abort();
  }, [shareId, token, attempt]);

  useEffect(() => {
    if (!root || !currentId) return;
    const controller = new AbortController();
    setPage(null); setHtml(null); setPageError('');
    void (async () => {
      try {
        const value = await sharedClient.page(shareId, token, currentId, controller.signal);
        if (controller.signal.aborted) return;
        setPage(value);
        if (!value.content) return;
        const { renderSharedPage } = await import('../export/browser');
        const titles = new Map(root.pages.map(item => [item.id, item.title]));
        const rendered = await renderSharedPage({ title: value.title, content: value.content, signal: controller.signal,
          assetUrl: id => sharedClient.attachmentUrl(shareId, id), pageTitle: id => titles.get(id) });
        if (!controller.signal.aborted) setHtml(rendered);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 410) { setFailure(failureOf(error)); return; }
        setPageError(error instanceof ApiError && error.status === 404 ? '这个页面已不在分享范围中，可能已被移动或删除。' : message(error));
      }
    })();
    return () => controller.abort();
  }, [shareId, token, root, currentId]);

  const open = useCallback((id: string) => { setCurrentId(id); setListOpen(false); }, []);

  /** The frame runs no scripts; links and page references are handled from here. */
  const wire = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc) return;
    const inScope = new Set(rootRef.current?.pages.map(item => item.id) ?? []);
    for (const element of doc.querySelectorAll<HTMLElement>('[data-nbase-page]')) {
      if (inScope.has(element.dataset.nbasePage ?? '')) { element.classList.add('nb-share-link'); element.title = '打开此页'; }
    }
    const style = doc.createElement('style');
    style.textContent = '.nb-share-link{cursor:pointer;text-decoration:underline;text-underline-offset:3px}';
    doc.head.append(style);
    doc.addEventListener('click', event => {
      const target = event.target instanceof doc.defaultView!.Element ? event.target : null;
      const reference = target?.closest<HTMLElement>('[data-nbase-page]');
      if (reference && inScope.has(reference.dataset.nbasePage ?? '')) { event.preventDefault(); open(reference.dataset.nbasePage!); return; }
      const link = target?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.getAttribute('href')!.startsWith('#')) return;
      event.preventDefault();
      if (/^https?:/i.test(link.href)) window.open(link.href, '_blank', 'noopener,noreferrer');
    });
  };

  const shell = (body: ReactNode) => <div className="nb-auth"><div className="nb-login nb-invite-page">
    <span className="nb-logo">N</span>{body}</div></div>;
  if (failure) return shell(<><h1>{failure.title}</h1><p role="status">{failure.body}</p>
    {failure.retry && <button className="nb-btn nb-btn-primary" onClick={() => setAttempt(value => value + 1)}>重试</button>}</>);
  if (!root) return shell(<><h1>正在打开分享…</h1><p role="status">请稍候。</p></>);

  const expires = new Date(root.expiresAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  const many = root.pages.length > 1;
  return <div className={`nb-share ${many ? 'nb-share-with-list' : ''}`}>
    <header className="nb-share-head">
      <span className="nb-logo" aria-hidden="true">N</span>
      <div className="nb-share-title"><strong>{root.title || '未命名页面'}</strong>
        <span>只读分享 · {expires} 前有效</span></div>
      {many && <button className="nb-btn nb-share-list-toggle" aria-expanded={listOpen} onClick={() => setListOpen(value => !value)}>页面目录</button>}
    </header>
    {many && <nav className={`nb-share-list ${listOpen ? 'is-open' : ''}`} aria-label="分享的页面">
      <PageList pages={root.pages} parentId={null} current={currentId ?? ''} onOpen={open} /></nav>}
    <main className="nb-share-main">
      {pageError ? <div className="nb-share-note" role="alert"><p>{pageError}</p>
        <button className="nb-btn" onClick={() => open(root.rootPageId)}>回到首页</button></div>
        : page && !page.content ? <div className="nb-share-note" role="status"><h1>{page.title || '未命名白板'}</h1>
          <p>白板不在分享页中显示，请在 NBase 工作台中查看。</p></div>
        : html ? <iframe ref={frameRef} key={page?.id} className="nb-share-frame" title={page?.title || '分享的页面'}
          sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={html} onLoad={wire} />
        : <div className="nb-share-note" role="status">正在读取页面…</div>}
    </main>
  </div>;
}
