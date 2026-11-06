import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ChangeEvent } from 'react';
import type { PageCoverId, PageSummary } from '@nbase/contracts';
import { DocumentEditor } from '../editor/DocumentEditor';
import { SourceEditorDialog } from '../editor/SourceEditorDialog';
import { createContentFromMarkdown, parseMarkdownImport } from '../editor/markdown';
import type { DocumentContent, DocumentEditorHandle, EditorSnapshot } from '../editor/types';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { initialWorkspace } from './fixtures';
import { ancestors, canMove, descendants, workspaceReducer, type Page } from './model';
import { useTheme } from '../shell/theme';
import { Sidebar } from '../shell/Sidebar';
import { Topbar } from '../shell/Topbar';
import { PageHeader } from '../shell/PageHeader';
import { Toc } from '../shell/Toc';
import { Toast } from '../shell/Toast';
import { NoticeBar } from '../shell/NoticeBar';
import type { MenuItem } from '../shell/Menu';
import type { TreeRowActions } from '../shell/PageTree';
import '../shell/shell.css';

const toSummary = (page: Page): PageSummary => ({
  id: page.id, workspaceId: 'demo', parentId: page.parentId, title: page.title,
  icon: page.icon, cover: page.cover, revision: '1', createdAt: '', updatedAt: '',
});

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '未命名页面'}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function Mark({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(query)})`, 'gi'));
  return <>{parts.map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part)}</>;
}
const snippet = (text: string, query: string) => {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text.slice(0, 90);
  const start = Math.max(0, index - 20), end = Math.min(text.length, index + query.length + 20);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
};

type PalItem =
  | { kind: 'recent' | 'title' | 'body'; page: Page; snippet?: string }
  | { kind: 'command'; key: string; icon: string; label: string };

function DemoSearch({ pages, recentIds, onOpen, onCommand, onClose }: {
  pages: Page[]; recentIds: string[]; onOpen: (id: string) => void;
  onCommand: (key: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(''); const [index, setIndex] = useState(0); const composing = useRef(false);
  const pathOf = (page: Page) => ancestors(pages, page.id).map(p => p.title || '未命名页面').join(' / ') || '个人空间';
  const q = query.trim();
  const titleItems: PalItem[] = []; const bodyItems: PalItem[] = [];
  if (q) for (const page of pages.filter(p => !p.deleted)) {
    const body = page.snapshot?.plainText ?? page.markdown;
    const titleHit = (page.title || '未命名页面').toLocaleLowerCase().includes(q.toLocaleLowerCase());
    const bodyHit = body.toLocaleLowerCase().includes(q.toLocaleLowerCase());
    if (titleHit) titleItems.push(bodyHit ? { kind: 'title', page, snippet: snippet(body, q) } : { kind: 'title', page });
    else if (bodyHit) bodyItems.push({ kind: 'body', page, snippet: snippet(body, q) });
  }
  const commands: PalItem[] = [
    { kind: 'command', key: 'new', icon: 'plus', label: '新建页面' },
    { kind: 'command', key: 'import', icon: 'upload', label: '导入 Markdown' },
    { kind: 'command', key: 'trash', icon: 'trash', label: '打开回收站' },
    { kind: 'command', key: 'theme', icon: 'moon', label: '切换深色模式' },
  ];
  const flat: PalItem[] = q ? [...titleItems, ...bodyItems]
    : [...recentIds.flatMap(id => pages.filter(p => p.id === id && !p.deleted).map(p => ({ kind: 'recent' as const, page: p }))), ...commands];
  const active = Math.min(index, Math.max(0, flat.length - 1));
  const row = (item: PalItem, i: number) => {
    if (item.kind === 'command') return <button key={`c-${item.key}`} className={`nb-pal-item ${i === active ? 'sel' : ''}`}
      onClick={() => onCommand(item.key)} onMouseEnter={() => setIndex(i)}>
      <Icon name={item.icon as never} size={15} /><span className="nb-pal-main"><span className="nb-pal-title">{item.label}</span></span></button>;
    const page = item.page;
    return <button key={page.id} className={`nb-pal-item ${i === active ? 'sel' : ''}`}
      onClick={() => onOpen(page.id)} onMouseEnter={() => setIndex(i)}>
      <span className="nb-page-icon">{page.icon ?? '📄'}</span>
      <span className="nb-pal-main"><span className="nb-pal-title"><Mark text={page.title || '未命名页面'} query={q} /></span>
        <span className="nb-pal-path">{pathOf(page)}</span>
        {item.snippet && <span className="nb-pal-snip"><Mark text={item.snippet} query={q} /></span>}</span></button>;
  };
  let i = -1;
  return <Modal title="搜索" variant="palette" hideHeader onClose={onClose}>
    <div className="nb-pal-input"><Icon name="search" size={15} />
      <input autoFocus aria-label="搜索标题或正文" placeholder="搜索标题或正文…" value={query}
        onChange={event => { setQuery(event.target.value); setIndex(0); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(Math.min(active + 1, flat.length - 1)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(Math.max(0, active - 1)); }
          if (event.key === 'Enter' && flat[active]) {
            event.preventDefault();
            const item = flat[active];
            if (item.kind === 'command') onCommand(item.key); else onOpen(item.page.id);
          }
        }} /></div>
    <div className="nb-pal-list">
      {q && !flat.length && <p className="nb-pal-msg">没有找到相关页面，试试其他关键词。</p>}
      {!q && flat.filter(f => f.kind === 'recent').length > 0 && <div className="nb-pal-group">最近访问</div>}
      {!q && flat.filter(f => f.kind === 'recent').map(item => row(item, ++i))}
      {titleItems.length > 0 && <div className="nb-pal-group">标题</div>}
      {titleItems.map(item => row(item, ++i))}
      {bodyItems.length > 0 && <div className="nb-pal-group">正文</div>}
      {bodyItems.map(item => row(item, ++i))}
      {!q && <div className="nb-pal-group">命令</div>}
      {!q && commands.map(item => row(item, ++i))}
    </div>
    <div className="modal-footnote">↑ ↓ 选择 · Enter 打开 · Esc 关闭 · 仅搜索本次会话内容</div>
  </Modal>;
}

function DemoTrash({ pages, onRestore, onClose }: { pages: Page[]; onRestore: (id: string) => void; onClose: () => void }) {
  const trashed = pages.filter(p => p.deleted);
  const [filter, setFilter] = useState(''); const [selected, setSelected] = useState<string | null>(trashed[0]?.id ?? null);
  const visible = trashed.filter(p => (p.title || '未命名页面').toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const page = trashed.find(p => p.id === selected) ?? null;
  const pathOf = (p: Page) => {
    const parent = pages.find(item => item.id === p.parentId);
    return parent && !parent.deleted ? `原位置：${[...ancestors(pages, parent.id), parent].map(a => a.title || '未命名页面').join(' / ')}` : '原位置：已不在 · 将恢复到根目录';
  };
  return <Modal title="回收站" variant="large" onClose={onClose}>
    <div className="nb-trash-head"><h2>回收站</h2><p>页面不会自动清理；演示数据在刷新后重置。</p></div>
    <div className="nb-trash-filter"><input type="text" aria-label="在回收站中搜索" placeholder="在回收站中搜索" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <div className="nb-trash-grid">
      <div className="nb-trash-list" aria-label="回收站页面">
        {visible.map(p => <button key={p.id} className={`nb-trash-row ${selected === p.id ? 'selected' : ''}`} onClick={() => setSelected(p.id)}>
          <span className="nb-page-icon">{p.icon ?? '📄'}</span>
          <span className="nb-trash-main"><strong>{p.title || '未命名页面'}</strong><small>{pathOf(p)}</small></span>
          {trashed.filter(o => o.id !== p.id && o.deletionRoot === p.deletionRoot).length > 0
            && <span className="nb-trash-badge">含 {trashed.filter(o => o.id !== p.id && o.deletionRoot === p.deletionRoot).length} 个子页面</span>}
          <span className="nb-trash-restore" role="button" tabIndex={0}
            onClick={event => { event.stopPropagation(); onRestore(p.id); }}
            onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); event.preventDefault(); onRestore(p.id); } }}>恢复</span>
        </button>)}
        {!trashed.length && <p className="nb-pal-msg">回收站是空的</p>}
        {trashed.length > 0 && !visible.length && <p className="nb-pal-msg">没有匹配的页面</p>}
      </div>
      <div className="nb-trash-body">
        {page ? <>
          <div className="nb-trash-body-head"><h3 data-nbase-find-title style={{ margin: 0 }}>{page.title || '未命名页面'}</h3>
            <button className="nb-btn nb-btn-primary" onClick={() => onRestore(page.id)}>恢复</button></div>
          <p className="dialog-description">{pathOf(page)} · 会话内删除</p>
          <DocumentEditor documentId={`demo-trash:${page.id}`} title={page.title} initialContent={page.snapshot?.content}
            initialMarkdown={page.markdown} readOnly onChange={() => {}} />
        </> : <p className="nb-pal-msg">选择左侧页面查看内容</p>}
      </div>
    </div>
  </Modal>;
}

type Dialog = 'search' | 'source' | 'move' | 'delete' | 'import' | 'trash' | null;

export function WorkspaceApp() {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspace);
  const [theme, setTheme] = useTheme();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [readOnly, setReadOnly] = useState(false); const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => { try { return localStorage.getItem('nbase.sidebar') === 'collapsed'; } catch { return false; } });
  const [toast, setToast] = useState('');
  const [sourceSession, setSourceSession] = useState<{ pageId: string; instanceId: string; content: DocumentContent } | null>(null);
  const [moveTarget, setMoveTarget] = useState(''); const [dialogFor, setDialogFor] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ title: string; text: string; warnings: string[] } | null>(null);
  const [importAccepted, setImportAccepted] = useState(false);
  const editorRef = useRef<DocumentEditorHandle>(null); const fileRef = useRef<HTMLInputElement>(null); const mainRef = useRef<HTMLElement>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const current = state.pages.find(page => page.id === state.currentId && !page.deleted);
  const isDocument = state.view === 'document' && !!current;
  const notice = useCallback((message: string) => setToast(message), []);
  const onChange = useCallback((id: string, snapshot: EditorSnapshot) => dispatch({ type: 'snapshot', id, snapshot, dirty: true }), []);
  const onReady = useCallback((id: string, snapshot: EditorSnapshot) => dispatch({ type: 'snapshot', id, snapshot, dirty: false }), []);
  const flush = useCallback(() => {
    const workspace = stateRef.current; const page = workspace.pages.find(p => p.id === workspace.currentId);
    if (workspace.view !== 'document' || !page || !editorRef.current) return page?.snapshot;
    const snapshot = editorRef.current.getSnapshot();
    dispatch({ type: 'snapshot', id: page.id, snapshot, dirty: !!page.snapshot && JSON.stringify(snapshot.content) !== JSON.stringify(page.snapshot.content) });
    return snapshot;
  }, []);
  const openPage = useCallback((id: string) => { flush(); dispatch({ type: 'open', id }); setDialog(null); setMobileOpen(false); mainRef.current?.scrollTo({ top: 0 }); }, [flush]);
  const newPage = (parentId: string | null = null) => {
    flush(); dispatch({ type: 'create', page: { id: crypto.randomUUID(), title: '未命名页面', parentId, markdown: '', starred: false, deleted: false, dirty: true, icon: null, cover: null } });
    setDialog(null); setReadOnly(false); setMobileOpen(false); notice('已在当前会话中新建页面，请下载以保留内容。');
    requestAnimationFrame(() => { const title = document.querySelector<HTMLInputElement>('[aria-label="页面标题"]'); title?.focus(); title?.select(); });
  };
  const toggleSidebar = () => {
    if (window.innerWidth <= 720) { setMobileOpen(value => !value); return; }
    setSidebarHidden(previous => { try { localStorage.setItem('nbase.sidebar', previous ? '' : 'collapsed'); } catch { /* best effort */ } return !previous; });
  };
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && (!dialog || dialog === 'search')) { event.preventDefault(); flush(); setDialog('search'); }
      if ((event.ctrlKey || event.metaKey) && event.key === '\\') { event.preventDefault(); toggleSidebar(); }
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [flush, dialog]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (stateRef.current.pages.some(page => page.dirty)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, []);
  const currentMarkdown = () => current ? `# ${current.title || '未命名页面'}\n\n${flush()?.markdown ?? current.markdown}` : '';
  const exportCurrent = () => { if (current) { download(current.title, currentMarkdown()); notice('已发起 Markdown 下载，请检查浏览器下载记录。'); } };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    if (!/\.md$/i.test(file.name)) { notice('请选择 .md 格式的文件。'); return; }
    if (file.size > 2 * 1024 * 1024) { notice('演示版单次支持不超过 2 MB 的 Markdown 文件。'); return; }
    try { const text = await file.text(); const parsed = parseMarkdownImport(text);
      setPendingImport({ title: parsed.title ?? file.name.replace(/\.md$/i, ''), text,
        warnings: [...parsed.warnings, ...(parsed.tagNames.length ? ['演示空间没有持久化标签；标签仅在正式工作台导入时关联。'] : [])] });
      setImportAccepted(false); setDialog('import'); } catch { notice('无法读取这个文件，请重新选择。'); }
  };
  const completeImport = () => {
    if (!pendingImport || !importAccepted) return;
    try {
      const content = createContentFromMarkdown(pendingImport.text); flush();
      dispatch({ type: 'create', page: { id: crypto.randomUUID(), title: pendingImport.title, markdown: pendingImport.text, originalMarkdown: pendingImport.text, snapshot: { content, markdown: pendingImport.text, plainText: pendingImport.text, outline: [] }, parentId: null, starred: false, deleted: false, dirty: true, icon: null, cover: null } });
      setDialog(null); setReadOnly(false); setPendingImport(null); notice('已转换为会话内页面，原始 Markdown 可在页面菜单下载。');
    } catch { notice('转换失败，原始文件未被修改。'); }
  };
  const onCommand = (key: string) => {
    setDialog(null);
    if (key === 'new') newPage();
    else if (key === 'import') fileRef.current?.click();
    else if (key === 'trash') setDialog('trash');
    else if (key === 'theme') setTheme(theme === 'dark' ? 'light' : 'dark');
  };
  const summaries = useMemo(() => state.pages.filter(p => !p.deleted).map(toSummary), [state.pages]);
  const favoriteSet = useMemo(() => new Set(state.pages.filter(p => p.starred && !p.deleted).map(p => p.id)), [state.pages]);
  const favoritePages = useMemo(() => state.pages.filter(p => p.starred && !p.deleted).map(toSummary), [state.pages]);
  const recentPages = useMemo(() => state.recent.slice(0, 5).flatMap(id => state.pages.filter(p => p.id === id && !p.deleted).map(toSummary)), [state.pages, state.recent]);
  const breadcrumbs = useMemo(() => (current ? ancestors(state.pages, current.id).map(toSummary) : []), [state.pages, current]);
  const treeActions: TreeRowActions = useMemo(() => ({
    onOpen: openPage,
    onAddChild: (id: string) => newPage(id),
    onFavorite: (id: string) => dispatch({ type: 'star', id }),
    onMove: (id: string) => { const page = state.pages.find(p => p.id === id); setMoveTarget(page?.parentId ?? ''); setDialogFor(id); setDialog('move'); },
    onTrash: (id: string) => { setDialogFor(id); setDialog('delete'); },
  }), [openPage, state.pages]);
  const target = dialogFor ? state.pages.find(p => p.id === dialogFor) : undefined;
  const pageMenuItems: (MenuItem | 'divider')[] = current ? [
    { key: 'mode', label: readOnly ? '切换到编辑' : '切换到阅读', icon: 'page', onSelect: () => { flush(); setReadOnly(!readOnly); } },
    { key: 'source', label: 'Markdown 源码', icon: 'code', onSelect: () => {
      const snapshot = flush();
      if (snapshot) { setSourceSession({ pageId: current.id, instanceId: crypto.randomUUID(), content: snapshot.content }); setDialog('source'); }
    } },
    { key: 'download', label: '下载页面', icon: 'download', onSelect: exportCurrent },
    ...(current.originalMarkdown !== undefined ? [{ key: 'raw', label: '下载导入原文', icon: 'download' as const, onSelect: () => download(`${current.title}-原始文件`, current.originalMarkdown ?? '') }] : []),
    'divider',
    { key: 'child', label: '添加子页面', icon: 'plus', onSelect: () => newPage(current.id) },
    { key: 'move', label: '移动到…', icon: 'folder', onSelect: () => { setMoveTarget(current.parentId ?? ''); setDialogFor(current.id); setDialog('move'); } },
    'divider',
    { key: 'trash', label: '移入回收站', icon: 'trash', danger: true, onSelect: () => { setDialogFor(current.id); setDialog('delete'); } },
  ] : [];
  const subtreeCount = target ? state.pages.filter(p => !p.deleted && p.id !== target.id && descendants(state.pages, target.id).has(p.id)).length : 0;

  return <div className={`nb-app demo-workspace ${sidebarHidden ? 'nb-sidebar-collapsed' : ''}`}>
    <Sidebar workspaceName="演示空间" loginName="演示会话" accountLabel="演示模式 · 未登录" theme={theme} onTheme={setTheme}
      onLogout={() => notice('演示模式没有账号；刷新页面即可重置。')}
      onSearch={() => { flush(); setDialog('search'); }} onTrash={() => setDialog('trash')}
      onNewPage={() => newPage()} onImport={() => fileRef.current?.click()}
      createBusy={false} pages={summaries} activeId={isDocument ? current.id : null}
      favorites={favoriteSet} favoritePages={favoritePages} recentPages={recentPages}
      treeLoading={false} treeError="" onTreeRetry={() => undefined}
      treeActions={treeActions} open={mobileOpen} onClose={() => setMobileOpen(false)} />
    <section className="nb-main">
      {isDocument && <Topbar status={{ tone: 'idle', text: '' }} hasDraft={false} demo
        onRetrySave={() => undefined} onDownload={exportCurrent}
        breadcrumbs={breadcrumbs} currentTitle={current.title} updatedAt={null}
        favorite={current.starred} onFavorite={() => dispatch({ type: 'star', id: current.id })}
        onSidebarToggle={toggleSidebar}
        onOpenBreadcrumb={id => { if (id) openPage(id); else { flush(); dispatch({ type: 'view', view: 'overview' }); } }}
        readOnly={readOnly} onToggleReadOnly={() => { flush(); setReadOnly(!readOnly); }}
        onHistory={() => undefined} hideHistory disabled={false} pageMenuItems={pageMenuItems} />}
      {!isDocument && <header className="nb-topbar">
        <button className="icon-button nb-sidebar-toggle" aria-label="切换导航" onClick={toggleSidebar}><Icon name="sidebar" size={17} /></button>
        <nav className="nb-crumbs" aria-label="页面位置"><strong>工作台</strong></nav></header>}
      <NoticeBar tone="info">演示模式 · 内容仅保留在当前会话，刷新后重置
        <button onClick={isDocument ? exportCurrent : () => notice('打开需要保留的页面，再从页面菜单下载 Markdown。')}>{isDocument ? '下载此页' : '如何保留内容'}</button></NoticeBar>
      <main ref={mainRef} className="nb-scroll" tabIndex={-1}>
        {isDocument ? <>
          <PageHeader icon={current.icon} cover={current.cover} editable={!readOnly}
            onIcon={icon => dispatch({ type: 'icon', id: current.id, icon })}
            onCover={(cover: PageCoverId | null) => dispatch({ type: 'cover', id: current.id, cover })}
            title={readOnly ? <div className="nb-doc-title-static" data-nbase-find-title>{current.title || '未命名页面'}</div>
              : <input className="nb-doc-title page-title" data-nbase-find-title aria-label="页面标题" value={current.title} placeholder="未命名页面"
                onChange={event => dispatch({ type: 'rename', id: current.id, title: event.target.value })} />} />
          <div className="nb-doc-body">
            <DocumentEditor key={current.id} ref={editorRef} documentId={current.id}
              title={current.title} onReplaceTitle={value => dispatch({ type: 'rename', id: current.id, title: value })}
              initialContent={current.snapshot?.content} initialMarkdown={current.markdown}
              readOnly={readOnly} onChange={onChange} onReady={onReady} onNotice={notice} />
          </div>
          <Toc outline={current.snapshot?.outline ?? []} onJump={id => editorRef.current?.jumpToHeading(id)} />
        </> : <section className="nb-home">
          {summaries.length ? <>
            <div className="nb-home-eyebrow">演示空间</div><h1>最近编辑</h1>
            <div className="nb-home-list">{recentPages.map(page => <button key={page.id} className="nb-home-row" onClick={() => openPage(page.id)}>
              <span className="nb-page-icon">{page.icon ?? '📄'}</span><span>
                <strong>{page.title || '未命名页面'}</strong>
                <small>{ancestors(state.pages, page.id).map(p => p.title || '未命名页面').join(' / ') || '个人空间'}</small></span>
            </button>)}</div>
            <div style={{ marginTop: 22 }}><button className="nb-btn nb-btn-primary" onClick={() => newPage()}><Icon name="plus" size={15} /> 新建页面</button></div>
          </> : <div className="nb-empty"><div>
            <div className="nb-empty-emoji">📝</div>
            <h1>开始写第一篇页面</h1>
            <p>页面可以层层嵌套，组织你的笔记、计划和资料。</p>
            <div className="nb-empty-actions">
              <button className="nb-btn nb-btn-primary" onClick={() => newPage()}>新建页面</button>
              <button className="nb-btn" onClick={() => fileRef.current?.click()}>导入 Markdown</button></div></div></div>}
        </section>}
      </main>
    </section>
    <input ref={fileRef} type="file" accept=".md,text/markdown" className="visually-hidden" aria-label="选择 Markdown 文件" onChange={event => { void importFile(event); }} />
    {toast && <Toast text={toast} onClose={() => setToast('')} />}
    {dialog === 'search' && <DemoSearch pages={state.pages} recentIds={state.recent} onOpen={openPage} onCommand={onCommand} onClose={() => setDialog(null)} />}
    {dialog === 'trash' && <DemoTrash pages={state.pages} onRestore={id => { dispatch({ type: 'restore', id }); notice('已在当前会话恢复页面及本次删除的子页面。'); }} onClose={() => setDialog(null)} />}
    {dialog === 'source' && sourceSession && <SourceEditorDialog key={sourceSession.instanceId}
      scope={{ userId: 'demo', workspaceId: 'demo', pageId: sourceSession.pageId, instanceId: sourceSession.instanceId, baseRevision: 'session' }}
      initialContent={sourceSession.content} readOnly={readOnly} onClose={() => setDialog(null)}
      onApply={async (content, baseContent) => {
        if (stateRef.current.currentId !== sourceSession.pageId || !editorRef.current || readOnly
          || JSON.stringify(editorRef.current.getSnapshot().content) !== JSON.stringify(baseContent)) {
          throw new Error('当前正文已与源码基准不同，请复制输入后重新打开。');
        }
        editorRef.current.replaceContent(content);
        notice('源码已应用到当前演示会话，可撤销。请下载以保留正文。');
      }} />}
    {dialog === 'move' && target && <Modal title="移动页面" onClose={() => setDialog(null)}><p className="dialog-description">选择「{target.title || '未命名页面'}」的新位置。子页面会一起移动。</p><label className="field-label" htmlFor="move-parent">移动到</label><select id="move-parent" className="select-field" value={moveTarget} onChange={event => setMoveTarget(event.target.value)}><option value="">个人空间（根目录）</option>{state.pages.filter(page => canMove(state.pages, target.id, page.id)).map(page => <option key={page.id} value={page.id}>{[...ancestors(state.pages, page.id), page].map(p => p.title || '未命名页面').join(' / ')}</option>)}</select><div className="dialog-actions"><button className="nb-btn" onClick={() => setDialog(null)}>取消</button><button className="nb-btn nb-btn-primary" onClick={() => { dispatch({ type: 'move', id: target.id, parentId: moveTarget || null }); setDialog(null); setDialogFor(null); notice('已在当前会话移动页面。'); }}>移动</button></div></Modal>}
    {dialog === 'delete' && target && <Modal title="移入回收站" onClose={() => setDialog(null)}><p className="dialog-description">「{target.title || '未命名页面'}」{subtreeCount ? `及 ${subtreeCount} 篇子页面` : ''}将移到回收站，你可以在当前会话内恢复。</p><div className="dialog-actions"><button className="nb-btn" onClick={() => setDialog(null)}>取消</button><button className="nb-btn nb-btn-primary" onClick={() => { flush(); dispatch({ type: 'delete', id: target.id }); setDialog(null); setDialogFor(null); }}>确认移入回收站</button></div></Modal>}
    {dialog === 'import' && pendingImport && <Modal title="导入 Markdown" onClose={() => setDialog(null)}><p className="dialog-description">将「{pendingImport.title}.md」转换为新的会话内页面。原始文本会保留，可从页面菜单下载。</p><div className="import-warning"><strong>导入是格式转换，不保证无损</strong>{pendingImport.warnings.length ? <ul>{pendingImport.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <p>未发现明显的扩展语法，但复杂排版或自定义样式仍可能变化。</p>}</div><details className="import-preview"><summary>查看原始文本</summary><pre>{pendingImport.text}</pre></details><label className="confirmation-check"><input type="checkbox" checked={importAccepted} onChange={event => setImportAccepted(event.target.checked)} />我理解转换可能改变格式，继续创建页面</label><div className="dialog-actions"><button className="nb-btn" onClick={() => setDialog(null)}>取消</button><button className="nb-btn nb-btn-primary" disabled={!importAccepted} onClick={completeImport}>转换并创建</button></div></Modal>}
  </div>;
}
