import { useEffect, useRef, useState } from 'react';
import type { PageSummary, SearchResult, WorkspaceHistorySearchResult, WorkspaceTag } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ApiError, pageClient } from './client';
import { PageIcon } from '../shell/PageTree';
import { TagFilter } from './PageTags';
import { invalidPhraseMessage, marked, pendingHistoryNotice, searchPhraseInvalid } from './searchText';

export type PaletteCommand = 'new' | 'import' | 'trash' | 'theme' | 'settings';

const commands: { key: PaletteCommand; label: string; icon: 'plus' | 'upload' | 'trash' | 'moon' | 'settings' }[] = [
  { key: 'new', label: '新建页面', icon: 'plus' },
  { key: 'import', label: '导入 Markdown', icon: 'upload' },
  { key: 'trash', label: '打开回收站', icon: 'trash' },
  { key: 'theme', label: '切换深色模式', icon: 'moon' },
  { key: 'settings', label: '打开设置', icon: 'settings' },
];

type HistoryState = { phase: 'idle' | 'loading' | 'ready' | 'error'; results: WorkspaceHistorySearchResult[]; truncated: boolean;
  pending: number; error: string };
const idleHistory: HistoryState = { phase: 'idle', results: [], truncated: false, pending: 0, error: '' };

const savedAt = (iso: string) => new Date(iso).toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function PersistentSearchDialog({ workspaceId, pages, recentPages, tags = [], onOpen, onOpenHistory, onCommand, onClose, onAuthError }: {
  workspaceId: string;
  pages: PageSummary[];
  recentPages: PageSummary[];
  tags?: WorkspaceTag[] | undefined;
  onOpen: (result: SearchResult, phrase: string) => void;
  /** Offers the history search; a result opens the page's history at the matching version. */
  onOpenHistory?: ((result: WorkspaceHistorySearchResult, phrase: string) => void) | undefined;
  onCommand: (command: PaletteCommand) => void;
  onClose: () => void;
  onAuthError: () => void;
}) {
  const [query, setQuery] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [withHistory, setWithHistory] = useState(false);
  const [history, setHistory] = useState<HistoryState>(idleHistory);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const generation = useRef(0);
  const authErrorRef = useRef(onAuthError);
  authErrorRef.current = onAuthError;
  const phrase = query.trim();
  const searching = Boolean(phrase || tagIds.length);
  const historyOn = Boolean(onOpenHistory) && withHistory && Boolean(phrase);

  const pathOf = (pageId: string): string => {
    const names: string[] = [];
    let cursor = pages.find(page => page.id === pageId)?.parentId ?? null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = pages.find(page => page.id === cursor);
      if (!parent) break;
      names.unshift(parent.title || '未命名页面');
      cursor = parent.parentId;
    }
    return names.join(' / ') || '个人空间';
  };

  const titleResults = results.filter(item => item.matchField === 'title');
  const bodyResults = results.filter(item => item.matchField !== 'title');
  const historyResults = historyOn && history.phase === 'ready' ? history.results : [];
  const flat: ({ type: 'result'; result: SearchResult } | { type: 'history'; history: WorkspaceHistorySearchResult }
    | { type: 'recent'; page: PageSummary } | { type: 'command'; key: PaletteCommand })[] =
    searching
      ? [...(phase === 'ready' ? results : []).map(result => ({ type: 'result' as const, result })),
        ...historyResults.map(item => ({ type: 'history' as const, history: item }))]
      : [...recentPages.map(page => ({ type: 'recent' as const, page })), ...commands.map(item => ({ type: 'command' as const, key: item.key }))];
  const active = Math.min(selected, Math.max(0, flat.length - 1));

  const activate = (index: number) => {
    const item = flat[index];
    if (!item) return;
    if (item.type === 'history') onOpenHistory?.(item.history, item.history.version.highlight ?? phrase);
    else if (item.type === 'result') onOpen(item.result, item.result.highlight ?? phrase);
    else if (item.type === 'recent') {
      const summary = item.page;
      onOpen({ pageId: summary.id, title: summary.title, icon: summary.icon, parentId: summary.parentId,
        revision: summary.revision, updatedAt: summary.updatedAt, snippet: '', matchField: 'title' }, '');
    } else onCommand(item.key);
  };

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const sequence = ++generation.current;
    if (!searching || composing) {
      setPhase('idle'); setResults([]); setTruncated(false);
      return;
    }
    if (searchPhraseInvalid(phrase)) {
      setPhase('error'); setResults([]); setTruncated(false);
      setError(invalidPhraseMessage);
      return;
    }
    setPhase('loading'); setError(''); setResults([]); setTruncated(false);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void pageClient.search(workspaceId, phrase, controller.signal, tagIds).then(response => {
        if (generation.current !== sequence || controller.signal.aborted) return;
        setResults(response.results); setTruncated(response.truncated); setSelected(0); setPhase('ready');
      }).catch(cause => {
        if (generation.current !== sequence || controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) authErrorRef.current();
        setError(cause instanceof ApiError && cause.status === 401
          ? '登录已失效，请重新登录。' : '搜索暂时不可用，请重试。');
        setPhase('error');
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspaceId, phrase, searching, tagIds, composing, retry]);

  useEffect(() => {
    if (!historyOn || composing || searchPhraseInvalid(phrase)) { setHistory(idleHistory); return; }
    setHistory({ ...idleHistory, phase: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void pageClient.historySearch(workspaceId, phrase, controller.signal, tagIds).then(response => {
        if (controller.signal.aborted) return;
        setHistory({ phase: 'ready', results: response.results, truncated: response.truncated, pending: response.pendingVersions, error: '' });
      }).catch(cause => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) authErrorRef.current();
        setHistory({ ...idleHistory, phase: 'error', error: cause instanceof ApiError && cause.status === 401
          ? '登录已失效，请重新登录。' : '历史版本搜索暂时不可用，请重试。' });
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspaceId, phrase, historyOn, tagIds, composing, historyRetry]);

  useEffect(() => {
    document.getElementById(`persistent-search-result-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, flat.length]);

  const option = (position: number) => ({ role: 'option' as const, 'aria-selected': position === active,
    id: `persistent-search-result-${position}`, className: `nb-pal-item ${position === active ? 'sel' : ''}`,
    onMouseEnter: () => setSelected(position), onClick: () => activate(position) });

  return <Modal title="搜索" variant="palette" hideHeader onClose={onClose}>
    <div className="nb-pal-input"><Icon name="search" />
      <input ref={inputRef} aria-label="搜索标题或正文" aria-controls="persistent-search-results"
        placeholder="搜索标题或正文" value={query}
        onChange={event => { setQuery(event.target.value); setSelected(0); }}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
        onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current) return;
          if (event.key === 'ArrowDown' && flat.length) {
            event.preventDefault(); setSelected(Math.min(active + 1, flat.length - 1));
          }
          if (event.key === 'ArrowUp' && flat.length) {
            event.preventDefault(); setSelected(Math.max(0, active - 1));
          }
          if (event.key === 'Enter' && flat[active]) {
            event.preventDefault(); activate(active);
          }
        }} />
    </div>
    <TagFilter tags={tags} value={tagIds} onChange={setTagIds} />
    {onOpenHistory && <label className="nb-pal-option"><input type="checkbox" checked={withHistory}
      onChange={event => setWithHistory(event.target.checked)} />同时搜索历史版本</label>}
    <div id="persistent-search-results" className="nb-pal-list" role="listbox" aria-label="搜索结果">
      {!searching && <>
        {recentPages.length > 0 && <div className="nb-pal-group">最近访问</div>}
        {recentPages.map((page, index) => <button key={page.id} {...option(index)}>
          <PageIcon page={page} /><span className="nb-pal-main">
            <span className="nb-pal-title">{page.title || '未命名页面'}</span>
            <span className="nb-pal-path">{pathOf(page.id)}</span></span>
        </button>)}
        <div className="nb-pal-group">命令</div>
        {commands.map((command, order) => <button key={command.key} {...option(recentPages.length + order)}>
          <Icon name={command.icon} size={15} /><span className="nb-pal-main"><span className="nb-pal-title">{command.label}</span></span>
        </button>)}
      </>}
      {searching && phase === 'loading' && <p className="nb-pal-msg" role="status">正在搜索…</p>}
      {searching && phase === 'error' && <div className="nb-pal-msg" role="alert">{error}
        <button onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {searching && phase === 'ready' && !results.length && <p className="nb-pal-msg" role="status">{historyOn
        ? '当前页面中没有匹配的内容。' : '没有符合当前筛选的页面。'}</p>}
      {searching && phase === 'ready' && <>
        {titleResults.length > 0 && <div className="nb-pal-group">{phrase ? '标题' : '符合标签'}</div>}
        {titleResults.map(result => {
          const position = flat.findIndex(item => item.type === 'result' && item.result === result);
          return <button key={result.pageId} {...option(position)}>
            <PageIcon page={result} /><span className="nb-pal-main">
              <span className="nb-pal-title">{marked(result.title || '未命名页面', result.highlight ?? phrase)}</span>
              <span className="nb-pal-path">{pathOf(result.pageId)}</span>
              {result.snippet && result.snippet !== '仅标题匹配' && <span className="nb-pal-snip">{marked(result.snippet, result.highlight ?? phrase)}</span>}
            </span>
          </button>;
        })}
        {bodyResults.length > 0 && <div className="nb-pal-group">正文</div>}
        {bodyResults.map(result => {
          const position = flat.findIndex(item => item.type === 'result' && item.result === result);
          return <button key={result.pageId} {...option(position)}>
            <PageIcon page={result} /><span className="nb-pal-main">
              <span className="nb-pal-title">{result.title || '未命名页面'}</span>
              <span className="nb-pal-path">{pathOf(result.pageId)}</span>
              <span className="nb-pal-snip">{marked(result.snippet, result.highlight ?? phrase)}</span>
            </span>
          </button>;
        })}
        {truncated && <p className="nb-pal-msg">仅显示前 30 条，请缩小搜索范围。</p>}
      </>}
      {historyOn && <>
        <div className="nb-pal-group">历史版本</div>
        {history.phase === 'loading' && <p className="nb-pal-msg" role="status">正在搜索历史版本…</p>}
        {history.phase === 'error' && <div className="nb-pal-msg" role="alert">{history.error}
          <button onClick={() => setHistoryRetry(value => value + 1)}>重试</button></div>}
        {history.phase === 'ready' && history.pending > 0 && <p className="nb-pal-note" role="note">{pendingHistoryNotice(history.pending)}</p>}
        {history.phase === 'ready' && !history.results.length && <p className="nb-pal-msg" role="status">历史版本中没有匹配的内容。</p>}
        {historyResults.map(item => {
          const position = flat.findIndex(entry => entry.type === 'history' && entry.history === item);
          const { version } = item;
          const mark = version.highlight ?? phrase;
          return <button key={item.pageId} {...option(position)}>
            <PageIcon page={item} /><span className="nb-pal-main">
              <span className="nb-pal-title">{item.title || '未命名页面'}</span>
              <span className="nb-pal-path">修订 {version.revision} · {savedAt(version.savedAt)}{version.actor ? ` · ${version.actor.loginName}` : ''}
                {' · '}{item.currentMatches ? '当前版本仍包含' : '仅在历史版本中'}{item.matchingVersions > 1 ? ` · ${item.matchingVersions} 个版本匹配` : ''}</span>
              <span className="nb-pal-snip">{version.matchField === 'title' || version.snippet === '仅标题匹配'
                ? marked(`标题：${version.title || '未命名页面'}`, mark) : marked(version.snippet, mark)}</span>
            </span>
          </button>;
        })}
        {history.phase === 'ready' && history.truncated && <p className="nb-pal-msg">历史版本仅显示前 20 个页面，请缩小搜索范围。</p>}
      </>}
    </div>
    <div className="modal-footnote">↑↓ 选择 · ↵ 打开 · Esc 关闭 · 只搜索已保存的页面{historyOn ? '与历史版本' : ''}</div>
  </Modal>;
}
