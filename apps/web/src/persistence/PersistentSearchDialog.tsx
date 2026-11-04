import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PageSummary, SearchResult } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ApiError, pageClient } from './client';
import { PageIcon } from '../shell/PageTree';

export type PaletteCommand = 'new' | 'import' | 'trash' | 'theme';

const commands: { key: PaletteCommand; label: string; icon: 'plus' | 'upload' | 'trash' | 'moon' }[] = [
  { key: 'new', label: '新建页面', icon: 'plus' },
  { key: 'import', label: '导入 Markdown', icon: 'upload' },
  { key: 'trash', label: '打开回收站', icon: 'trash' },
  { key: 'theme', label: '切换深色模式', icon: 'moon' },
];

function marked(text: string, phrase: string): ReactNode {
  const at = text.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
  if (at < 0 || !phrase) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + phrase.length)}</mark>{text.slice(at + phrase.length)}</>;
}

export function PersistentSearchDialog({ workspaceId, pages, recentPages, onOpen, onCommand, onClose, onAuthError }: {
  workspaceId: string;
  pages: PageSummary[];
  recentPages: PageSummary[];
  onOpen: (result: SearchResult, phrase: string) => void;
  onCommand: (command: PaletteCommand) => void;
  onClose: () => void;
  onAuthError: () => void;
}) {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const generation = useRef(0);
  const authErrorRef = useRef(onAuthError);
  authErrorRef.current = onAuthError;
  const phrase = query.trim();

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
  const flat: ({ type: 'result'; result: SearchResult } | { type: 'recent'; page: PageSummary } | { type: 'command'; key: PaletteCommand })[] =
    phrase
      ? results.map(result => ({ type: 'result' as const, result }))
      : [...recentPages.map(page => ({ type: 'recent' as const, page })), ...commands.map(item => ({ type: 'command' as const, key: item.key }))];
  const active = Math.min(selected, Math.max(0, flat.length - 1));

  const activate = (index: number) => {
    const item = flat[index];
    if (!item) return;
    if ('result' in item) onOpen(item.result, phrase);
    else if ('page' in item) {
      const summary = item.page;
      onOpen({ pageId: summary.id, title: summary.title, icon: summary.icon, parentId: summary.parentId,
        revision: summary.revision, updatedAt: summary.updatedAt, snippet: '', matchField: 'title' }, '');
    } else onCommand(item.key);
  };

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const sequence = ++generation.current;
    if (!phrase || composing) {
      setPhase('idle'); setResults([]); setTruncated(false);
      return;
    }
    if (phrase.length > 100 || new TextEncoder().encode(phrase).length > 256 || /[\u0000-\u001f\u007f]/.test(phrase)) {
      setPhase('error'); setResults([]); setTruncated(false);
      setError('关键词过长或含控制字符，请缩短后重试。');
      return;
    }
    setPhase('loading'); setError(''); setResults([]); setTruncated(false);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void pageClient.search(workspaceId, phrase, controller.signal).then(response => {
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
  }, [workspaceId, phrase, composing, retry]);

  useEffect(() => {
    document.getElementById(`persistent-search-result-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, flat.length]);

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
    <div id="persistent-search-results" className="nb-pal-list" role="listbox" aria-label="搜索结果">
      {!phrase && <>
        {recentPages.length > 0 && <div className="nb-pal-group">最近访问</div>}
        {recentPages.map((page, index) => {
          const position = index;
          return <button role="option" aria-selected={position === active} id={`persistent-search-result-${position}`}
            className={`nb-pal-item ${position === active ? 'sel' : ''}`} key={page.id}
            onMouseEnter={() => setSelected(position)} onClick={() => activate(position)}>
            <PageIcon page={page} /><span className="nb-pal-main">
              <span className="nb-pal-title">{page.title || '未命名页面'}</span>
              <span className="nb-pal-path">{pathOf(page.id)}</span></span>
          </button>;
        })}
        <div className="nb-pal-group">命令</div>
        {commands.map((command, order) => {
          const position = recentPages.length + order;
          return <button role="option" aria-selected={position === active} id={`persistent-search-result-${position}`}
            className={`nb-pal-item ${position === active ? 'sel' : ''}`} key={command.key}
            onMouseEnter={() => setSelected(position)} onClick={() => activate(position)}>
            <Icon name={command.icon} size={15} /><span className="nb-pal-main"><span className="nb-pal-title">{command.label}</span></span>
          </button>;
        })}
      </>}
      {phrase && phase === 'loading' && <p className="nb-pal-msg" role="status">正在搜索…</p>}
      {phrase && phase === 'error' && <div className="nb-pal-msg" role="alert">{error}
        <button onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {phrase && phase === 'ready' && !results.length && <p className="nb-pal-msg" role="status">没有找到“{phrase}”，试试其他关键词</p>}
      {phrase && phase === 'ready' && <>
        {titleResults.length > 0 && <div className="nb-pal-group">标题</div>}
        {titleResults.map(result => {
          const position = flat.findIndex(item => 'result' in item && item.result === result);
          return <button role="option" aria-selected={position === active} id={`persistent-search-result-${position}`}
            className={`nb-pal-item ${position === active ? 'sel' : ''}`} key={result.pageId}
            onMouseEnter={() => setSelected(position)} onClick={() => activate(position)}>
            <PageIcon page={result} /><span className="nb-pal-main">
              <span className="nb-pal-title">{marked(result.title || '未命名页面', phrase)}</span>
              <span className="nb-pal-path">{pathOf(result.pageId)}</span>
              {result.snippet && result.snippet !== '仅标题匹配' && <span className="nb-pal-snip">{marked(result.snippet, phrase)}</span>}
            </span>
          </button>;
        })}
        {bodyResults.length > 0 && <div className="nb-pal-group">正文</div>}
        {bodyResults.map(result => {
          const position = flat.findIndex(item => 'result' in item && item.result === result);
          return <button role="option" aria-selected={position === active} id={`persistent-search-result-${position}`}
            className={`nb-pal-item ${position === active ? 'sel' : ''}`} key={result.pageId}
            onMouseEnter={() => setSelected(position)} onClick={() => activate(position)}>
            <PageIcon page={result} /><span className="nb-pal-main">
              <span className="nb-pal-title">{result.title || '未命名页面'}</span>
              <span className="nb-pal-path">{pathOf(result.pageId)}</span>
              <span className="nb-pal-snip">{marked(result.snippet, phrase)}</span>
            </span>
          </button>;
        })}
        {truncated && <p className="nb-pal-msg">仅显示前 30 条，请增加关键词缩小范围</p>}
      </>}
    </div>
    <div className="modal-footnote">↑↓ 选择 · ↵ 打开 · Esc 关闭 · 只搜索已保存的页面</div>
  </Modal>;
}
