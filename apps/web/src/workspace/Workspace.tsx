import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { getHealth } from '../api';
import { DocumentEditor } from '../editor/DocumentEditor';
import { assessMarkdown, createContentFromMarkdown } from '../editor/markdown';
import type { DocumentEditorHandle, EditorSnapshot } from '../editor/types';
import { Icon, type IconName } from '../components/Icon';
import { Modal } from '../components/Modal';
import { initialWorkspace } from './fixtures';
import { ancestors, canMove, descendants, workspaceReducer, type Collection, type Page } from './model';

const collectionLabels: Record<Collection, string> = { overview: '工作台', recent: '最近访问', favorites: '我的收藏', trash: '回收站' };
type Dialog = 'search' | 'settings' | 'source' | 'move' | 'more' | 'delete' | 'import' | null;
function ActionButton({ label, icon, onClick, active = false }: { label: string; icon: IconName; onClick: () => void; active?: boolean }) {
  return <button className={`icon-button ${active ? 'active' : ''}`} title={label} aria-label={label} onClick={onClick}><Icon name={icon} /></button>;
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '未命名页面'}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PageTree({ pages, currentId, onOpen }: { pages: Page[]; currentId: string | null; onOpen: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const branch = (parentId: string | null, depth: number): ReactNode => pages.filter(p => !p.deleted && p.parentId === parentId).map(page => {
    const children = pages.some(p => !p.deleted && p.parentId === page.id);
    return <div key={page.id}><div className={`tree-row ${currentId === page.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 15 }}>
      {children ? <button className={`tree-toggle ${collapsed.has(page.id) ? '' : 'expanded'}`} aria-label={`${collapsed.has(page.id) ? '展开' : '收起'} ${page.title || '未命名页面'}`} aria-expanded={!collapsed.has(page.id)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next; })}><Icon name="chevron" size={13} /></button> : <span className="tree-spacer" />}
      <button className="tree-page" onClick={() => onOpen(page.id)} aria-current={currentId === page.id ? 'page' : undefined}><Icon name="page" size={16} /><span>{page.title || '未命名页面'}</span>{page.starred && <span className="tree-star">✧</span>}</button>
    </div>{children && !collapsed.has(page.id) && branch(page.id, depth + 1)}</div>;
  });
  return <div className="page-tree">{branch(null, 0)}</div>;
}

function SearchDialog({ pages, onOpen, onClose }: { pages: Page[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''); const [index, setIndex] = useState(0); const composing = useRef(false);
  const result = pages.filter(page => !page.deleted && `${page.title}\n${page.snapshot?.plainText ?? page.markdown}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const active = Math.min(index, Math.max(0, result.length - 1));
  useEffect(() => { document.getElementById(`search-result-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return <Modal title="搜索文档" onClose={onClose}><div className="search-field"><Icon name="search" /><input autoFocus aria-label="搜索标题或正文" placeholder="搜索标题或正文…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return; if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(Math.min(active + 1, result.length - 1)); } if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(Math.max(0, active - 1)); } if (event.key === 'Enter' && result[active]) { event.preventDefault(); onOpen(result[active].id); } }} /></div>
    <div className="search-results">{result.length ? result.map((page, i) => <button id={`search-result-${i}`} key={page.id} className={`search-result ${i === active ? 'highlighted' : ''}`} onClick={() => onOpen(page.id)} onMouseEnter={() => setIndex(i)}><Icon name="page" /><span><strong>{page.title || '未命名页面'}</strong><small>{(page.snapshot?.plainText ?? page.markdown).replace(/[#*>`]/g, '').slice(0, 95)}</small></span><Icon name="arrow" size={15} /></button>) : <div className="empty-state">没有找到相关页面，试试其他关键词。</div>}</div><div className="modal-footnote">↑ ↓ 选择 · Enter 打开 · Esc 关闭 · 仅搜索本次会话内容</div>
  </Modal>;
}

export function WorkspaceApp() {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspace);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [readOnly, setReadOnly] = useState(false); const [focusMode, setFocusMode] = useState(false); const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'paper' | 'dark'>('light'); const [toast, setToast] = useState(''); const [source, setSource] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  const [health, setHealth] = useState('正在检查本机服务…'); const [healthVersion, setHealthVersion] = useState(0);
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
  const openCollection = (view: Collection) => { flush(); dispatch({ type: 'view', view }); setFocusMode(false); setMobileOpen(false); mainRef.current?.scrollTo({ top: 0 }); };
  const newPage = (parentId: string | null = null) => {
    flush(); dispatch({ type: 'create', page: { id: crypto.randomUUID(), title: '未命名页面', parentId, markdown: '', starred: false, deleted: false, dirty: true } });
    setDialog(null); setReadOnly(false); setMobileOpen(false); notice('已在当前会话中新建页面，请下载以保留内容。');
    requestAnimationFrame(() => { const title = document.querySelector<HTMLInputElement>('[aria-label="页面标题"]'); title?.focus(); title?.select(); });
  };
  useEffect(() => { const controller = new AbortController(); setHealth('正在检查本机服务…'); getHealth(controller.signal).then(result => setHealth(result.persistence === 'page-api' ? '服务进程已连接 · 页面 API 已配置，当前界面仍为会话演示' : result.persistence === 'accounts-only' ? '服务进程已连接 · 账号存储已配置，文档仍为会话演示' : '服务进程已连接 · 文档持久化尚未配置')).catch(error => { if (!controller.signal.aborted) setHealth(error instanceof Error ? error.message : '服务暂时无法连接'); }); return () => controller.abort(); }, [healthVersion]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.isComposing || event.keyCode === 229) return; if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); flush(); setDialog('search'); } if (event.key === 'Escape') { setMobileOpen(false); setFocusMode(false); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [flush]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (stateRef.current.pages.some(page => page.dirty)) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, []);
  const currentMarkdown = () => current ? `# ${current.title || '未命名页面'}\n\n${flush()?.markdown ?? current.markdown}` : '';
  const exportCurrent = () => { if (current) { download(current.title, currentMarkdown()); notice('已发起 Markdown 下载，请检查浏览器下载记录。'); } };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    if (!/\.md$/i.test(file.name)) { notice('请选择 .md 格式的文件。'); return; }
    if (file.size > 2 * 1024 * 1024) { notice('演示版单次支持不超过 2 MB 的 Markdown 文件。'); return; }
    try { const text = await file.text(); setPendingImport({ title: file.name.replace(/\.md$/i, ''), text, warnings: assessMarkdown(text).warnings }); setImportAccepted(false); setDialog('import'); } catch { notice('无法读取这个文件，请重新选择。'); }
  };
  const completeImport = () => {
    if (!pendingImport || !importAccepted) return;
    try { const content = createContentFromMarkdown(pendingImport.text); flush(); dispatch({ type: 'create', page: { id: crypto.randomUUID(), title: pendingImport.title, markdown: pendingImport.text, originalMarkdown: pendingImport.text, snapshot: { content, markdown: pendingImport.text, plainText: pendingImport.text, outline: [] }, parentId: null, starred: false, deleted: false, dirty: true } }); setDialog(null); setReadOnly(false); setPendingImport(null); notice('已转换为会话内页面，原始 Markdown 可在页面菜单下载。'); } catch { notice('转换失败，原始文件未被修改。'); }
  };
  const collectionPages = useMemo(() => {
    if (state.view === 'trash') return state.pages.filter(p => p.deleted);
    if (state.view === 'favorites') return state.pages.filter(p => !p.deleted && p.starred);
    if (state.view === 'recent') return state.recent.flatMap(id => state.pages.filter(p => p.id === id && !p.deleted));
    return state.pages.filter(p => !p.deleted);
  }, [state.pages, state.recent, state.view]);

  return <div className={`workspace theme-${theme} ${focusMode ? 'focus-mode' : ''}`}>
    {mobileOpen && <button className="mobile-backdrop" aria-label="收起导航" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`} aria-label="工作台导航">
      <div className="brand-row"><span className="brand-mark">N</span><span><strong>NBase</strong><small>我的个人空间</small></span><ActionButton label="关闭导航" icon="close" onClick={() => setMobileOpen(false)} /></div>
      <div className="sidebar-search"><button onClick={() => { flush(); setDialog('search'); }}><Icon name="search" /><span>搜索</span><kbd>Ctrl K</kbd></button><ActionButton label="新建页面" icon="plus" onClick={() => newPage()} /></div>
      <nav className="main-nav">{([['overview', 'home'], ['recent', 'clock'], ['favorites', 'star']] as const).map(([view, icon]) => <button key={view} className={state.view === view ? 'selected' : ''} onClick={() => openCollection(view)}><Icon name={icon} /><span>{collectionLabels[view]}</span>{view === 'favorites' && <small>{state.pages.filter(p => p.starred && !p.deleted).length}</small>}</button>)}</nav>
      <div className="tree-heading"><span>个人页面</span><ActionButton label="添加根页面" icon="plus" onClick={() => newPage()} /></div>
      <div className="tree-scroll"><PageTree pages={state.pages} currentId={isDocument ? state.currentId : null} onOpen={openPage} /></div>
      <div className="sidebar-footer"><button className={state.view === 'trash' ? 'selected' : ''} onClick={() => openCollection('trash')}><Icon name="trash" /><span>回收站</span><small>{state.pages.filter(p => p.deleted).length}</small></button><button onClick={() => setDialog('settings')}><Icon name="settings" /><span>设置与外观</span></button><div className="session-label"><span />演示模式 · 仅当前会话</div></div>
    </aside>
    <section className="main-panel">
      <header className="topbar"><div className="breadcrumb"><span className="mobile-menu"><ActionButton label="打开导航" icon="menu" onClick={() => setMobileOpen(true)} /></span>{focusMode && <ActionButton label="退出专注模式" icon="focus" onClick={() => setFocusMode(false)} />}<button onClick={() => openCollection('overview')}>个人空间</button><span>/</span>{isDocument ? <>{ancestors(state.pages, current.id).map(page => <span className="ancestor" key={page.id}><button onClick={() => openPage(page.id)}>{page.title || '未命名页面'}</button><span>/</span></span>)}<strong>{current.title || '未命名页面'}</strong></> : <strong>{collectionLabels[state.view as Collection]}</strong>}</div>
        {isDocument && <div className="page-actions"><span className="draft-status">{current.dirty ? '本页会话草稿' : '示例文档'}</span><div className="mode-toggle" aria-label="页面模式"><button aria-pressed={!readOnly} className={!readOnly ? 'active' : ''} onClick={() => { flush(); setReadOnly(false); }}>编辑</button><button aria-pressed={readOnly} className={readOnly ? 'active' : ''} onClick={() => { flush(); setReadOnly(true); }}>阅读</button></div><ActionButton label="查看 Markdown" icon="code" onClick={() => { setSource(currentMarkdown()); setDialog('source'); }} /><ActionButton label={current.starred ? '取消收藏' : '收藏页面'} icon="star" active={current.starred} onClick={() => dispatch({ type: 'star', id: current.id })} /><ActionButton label={focusMode ? '退出专注模式' : '专注模式'} icon="focus" active={focusMode} onClick={() => setFocusMode(!focusMode)} /><ActionButton label="页面菜单" icon="more" onClick={() => setDialog('more')} /></div>}
      </header>
      <div className="session-banner"><span className="status-dot" />演示模式 · 内容仅保留在当前会话，刷新后重置。<button onClick={isDocument ? exportCurrent : () => notice('打开需要保留的页面，再从页面菜单下载 Markdown。')}>{isDocument ? '下载此页' : '如何保留内容'}<Icon name="download" size={13} /></button></div>
      <main ref={mainRef} className="main-scroll" tabIndex={-1}>
        {isDocument ? <div className="document-layout"><article className="document-paper"><div className="document-heading"><span className="document-eyebrow"><Icon name="page" size={15} />{readOnly ? '阅读模式' : '个人文档'}</span>{readOnly ? <h1>{current.title || '未命名页面'}</h1> : <input className="page-title" aria-label="页面标题" value={current.title} placeholder="未命名页面" onChange={event => dispatch({ type: 'rename', id: current.id, title: event.target.value })} />}<div className="document-meta"><span className="avatar">我</span><span>我的空间</span><span>·</span><span>{current.snapshot?.plainText.length ?? current.markdown.length} 字符</span><span>·</span><span>会话内示例</span></div></div>
          <DocumentEditor key={current.id} ref={editorRef} documentId={current.id} initialContent={current.snapshot?.content} initialMarkdown={current.markdown} readOnly={readOnly} onChange={onChange} onReady={onReady} onNotice={notice} />
          <div className="document-end"><span />写下值得留下的想法<span /></div>
        </article><aside className="outline" aria-label="页面目录"><div>本页目录</div>{current.snapshot?.outline.length ? current.snapshot.outline.map(item => <button key={item.id} style={{ paddingLeft: (item.level - 1) * 10 }} onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{item.text}</button>) : <small>添加标题后显示目录</small>}</aside></div> : <section className="collection"><div className="collection-eyebrow">我的个人空间</div><div className="collection-heading"><div><h1>{collectionLabels[state.view as Collection]}</h1><p>{state.view === 'overview' ? '给想法一个位置，让知识慢慢生长。' : state.view === 'recent' ? '继续上一次的思考。按本次会话访问顺序排列。' : state.view === 'favorites' ? '把经常回看的内容放在手边。' : '删除的页面暂时留在这里，可以恢复。刷新后演示数据会重置。'}</p></div>{state.view !== 'trash' && <button className="primary-button" onClick={() => newPage()}><Icon name="plus" size={16} />新建页面</button>}</div>
          {state.view === 'overview' && <div className="overview-note"><Icon name="folder" size={25} /><div><strong>从一页开始，建立自己的知识库</strong><p>在侧边栏整理页面，使用搜索找到内容。此阶段的修改仅保留在当前会话。</p></div><button className="quiet-button" onClick={() => fileRef.current?.click()}><Icon name="upload" size={16} />导入 Markdown</button></div>}
          <div className="list-heading"><span>{state.view === 'trash' ? '已删除页面' : '页面'}</span><span>{collectionPages.length} 篇</span></div>
          {collectionPages.length ? <div className="document-list">{collectionPages.map(page => <div key={page.id} className="document-row"><Icon name="page" size={20} /><button className="document-row-main" disabled={page.deleted} onClick={() => openPage(page.id)}><strong>{page.title || '未命名页面'}</strong><small>{ancestors(state.pages, page.id).map(p => p.title || '未命名页面').join(' / ') || '个人空间'}{page.dirty ? ' · 会话内修改' : ' · 示例'}</small></button>{page.deleted ? <button className="quiet-button" onClick={() => { dispatch({ type: 'restore', id: page.id }); notice('已在当前会话恢复页面及本次删除的子页面。'); }}><Icon name="restore" size={16} />恢复</button> : <ActionButton label={`${page.starred ? '取消收藏' : '收藏'} ${page.title}`} icon="star" active={page.starred} onClick={() => dispatch({ type: 'star', id: page.id })} />}</div>)}</div> : <div className="empty-state"><Icon name={state.view === 'trash' ? 'trash' : 'page'} size={32} /><h3>{state.view === 'trash' ? '回收站是空的' : '这里还没有页面'}</h3><p>{state.view === 'favorites' ? '点击页面右上角的星标，将它加入收藏。' : '你的页面会出现在这里。'}</p></div>}
        </section>}
      </main>
    </section>
    <input ref={fileRef} type="file" accept=".md,text/markdown" className="visually-hidden" aria-label="选择 Markdown 文件" onChange={event => { void importFile(event); }} />
    {toast && <div className="toast" role="status"><Icon name="check" size={16} /><span>{toast}</span><ActionButton label="关闭提示" icon="close" onClick={() => setToast('')} /></div>}
    {dialog === 'search' && <SearchDialog pages={state.pages} onOpen={openPage} onClose={() => setDialog(null)} />}
    {dialog === 'source' && <Modal title="Markdown 源码" wide onClose={() => setDialog(null)}><p className="dialog-description">只读视图，来自当前编辑器内容。转换可能不保留所有扩展语法。</p><textarea className="source-view" aria-label="Markdown 源码，只读" readOnly value={source} spellCheck={false} /><div className="dialog-actions"><button className="quiet-button" onClick={() => { void navigator.clipboard.writeText(source).then(() => notice('已复制 Markdown。')).catch(() => notice('剪贴板不可用，请在源码框中手动选择并复制。')); }}>复制源码</button><button className="primary-button" onClick={() => current && download(current.title, source)}><Icon name="download" size={16} />下载 Markdown</button></div></Modal>}
    {dialog === 'more' && current && <Modal title="页面操作" onClose={() => setDialog(null)}><div className="action-list"><button onClick={() => newPage(current.id)}><Icon name="plus" />添加子页面</button><button onClick={() => { setMoveTarget(current.parentId ?? ''); setDialog('move'); }}><Icon name="folder" />移动页面</button><button onClick={() => { exportCurrent(); setDialog(null); }}><Icon name="download" />下载 Markdown</button>{current.originalMarkdown !== undefined && <button onClick={() => download(`${current.title}-原始文件`, current.originalMarkdown ?? '')}><Icon name="download" />下载导入原文</button>}<button onClick={() => { setDialog(null); fileRef.current?.click(); }}><Icon name="upload" />导入 Markdown 为新页面</button><button className="danger" onClick={() => setDialog('delete')}><Icon name="trash" />移到回收站</button></div></Modal>}
    {dialog === 'move' && current && <Modal title="移动页面" onClose={() => setDialog(null)}><p className="dialog-description">选择「{current.title || '未命名页面'}」的新位置。子页面会一起移动。</p><label className="field-label" htmlFor="move-parent">移动到</label><select id="move-parent" className="select-field" value={moveTarget} onChange={event => setMoveTarget(event.target.value)}><option value="">个人空间（根目录）</option>{state.pages.filter(page => canMove(state.pages, current.id, page.id)).map(page => <option key={page.id} value={page.id}>{[...ancestors(state.pages, page.id), page].map(p => p.title || '未命名页面').join(' / ')}</option>)}</select><div className="dialog-actions"><button className="quiet-button" onClick={() => setDialog(null)}>取消</button><button className="primary-button" onClick={() => { dispatch({ type: 'move', id: current.id, parentId: moveTarget || null }); setDialog(null); notice('已在当前会话移动页面。'); }}>移动</button></div></Modal>}
    {dialog === 'delete' && current && <Modal title="移到回收站" onClose={() => setDialog(null)}><p className="dialog-description">「{current.title || '未命名页面'}」及其 {state.pages.filter(p => !p.deleted && p.id !== current.id && descendants(state.pages, current.id).has(p.id)).length} 个子页面将移到回收站，你可以在当前会话内恢复。</p><div className="dialog-actions"><button className="quiet-button" onClick={() => setDialog(null)}>取消</button><button className="danger-button" onClick={() => { flush(); dispatch({ type: 'delete', id: current.id }); setFocusMode(false); setDialog(null); }}>移到回收站</button></div></Modal>}
    {dialog === 'settings' && <Modal title="设置与外观" onClose={() => setDialog(null)}><div className="settings-section"><h3>让工作台更合心意</h3><p>外观设置仅在本次会话生效。</p><div className="theme-options">{(['light', 'paper', 'dark'] as const).map(value => <button key={value} aria-pressed={theme === value} className={theme === value ? 'chosen' : ''} onClick={() => setTheme(value)}><span className={`theme-preview preview-${value}`}><i /><i /><i /></span>{value === 'light' ? '浅色' : value === 'paper' ? '纸张' : '深色'}{theme === value && <Icon name="check" size={15} />}</button>)}</div></div><div className="settings-section"><h3>个人空间</h3><p>当前为个人使用的界面演示。账号、权限、协作和持久化尚未接入。</p></div><div className="settings-section"><h3>服务连接</h3><p role="status">{health}</p><button className="quiet-button" onClick={() => setHealthVersion(value => value + 1)}>重新检查</button><small>这里只检查服务进程，不代表文档已写入存储。</small></div><div className="settings-section"><h3>快捷键</h3><p><kbd>Ctrl / ⌘ K</kbd> 搜索页面　<kbd>Esc</kbd> 关闭窗口或退出专注</p></div></Modal>}
    {dialog === 'import' && pendingImport && <Modal title="导入 Markdown" onClose={() => setDialog(null)}><p className="dialog-description">将「{pendingImport.title}.md」转换为新的会话内页面。原始文本会保留，可从页面菜单下载。</p><div className="import-warning"><strong>导入是格式转换，不保证无损</strong>{pendingImport.warnings.length ? <ul>{pendingImport.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <p>未发现明显的扩展语法，但复杂排版或自定义样式仍可能变化。</p>}</div><details className="import-preview"><summary>查看原始文本</summary><pre>{pendingImport.text}</pre></details><label className="confirmation-check"><input type="checkbox" checked={importAccepted} onChange={event => setImportAccepted(event.target.checked)} />我理解转换可能改变格式，继续创建页面</label><div className="dialog-actions"><button className="quiet-button" onClick={() => setDialog(null)}>取消</button><button className="primary-button" disabled={!importAccepted} onClick={completeImport}>转换并创建</button></div></Modal>}
  </div>;
}
