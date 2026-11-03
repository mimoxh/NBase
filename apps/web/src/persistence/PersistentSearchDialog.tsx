import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ApiError, pageClient } from './client';

interface Props {
  workspaceId: string;
  onClose: () => void;
  onOpen: (result: SearchResult, phrase: string) => void;
  onAuthError: () => void;
}

export function PersistentSearchDialog({ workspaceId, onClose, onOpen, onAuthError }: Props) {
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const authErrorRef = useRef(onAuthError);
  authErrorRef.current = onAuthError;
  const phrase = query.trim();
  const active = Math.min(selected, Math.max(0, results.length - 1));

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
  }, [active, results]);

  return <Modal title="搜索文档" onClose={onClose}>
    <div className="search-field"><Icon name="search" />
      <input ref={inputRef} aria-label="搜索标题或正文" aria-controls="persistent-search-results"
        placeholder="搜索标题或正文…" value={query}
        onChange={event => { setQuery(event.target.value); setSelected(0); }}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
        onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current) return;
          if (event.key === 'ArrowDown' && results.length) {
            event.preventDefault(); setSelected(Math.min(active + 1, results.length - 1));
          }
          if (event.key === 'ArrowUp' && results.length) {
            event.preventDefault(); setSelected(Math.max(0, active - 1));
          }
          if (event.key === 'Enter' && phase === 'ready' && results[active]) {
            event.preventDefault(); onOpen(results[active], phrase);
          }
        }} />
    </div>
    <div id="persistent-search-results" className="search-results" role="listbox" aria-label="搜索结果">
      {!phrase && <p className="persistent-search-message" role="status">输入标题或正文中的词语开始搜索。</p>}
      {phase === 'loading' && <p className="persistent-search-message" role="status">正在搜索…</p>}
      {phase === 'error' && <div className="persistent-search-message" role="alert">{error}
        <button className="quiet-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {phase === 'ready' && !results.length && <p className="persistent-search-message" role="status">没有找到相关页面，试试其他关键词。</p>}
      {phase === 'ready' && results.map((result, index) => <button role="option"
        aria-selected={index === active} id={`persistent-search-result-${index}`}
        className={`search-result ${index === active ? 'highlighted' : ''}`} key={result.pageId}
        onMouseEnter={() => setSelected(index)} onClick={() => onOpen(result, phrase)}>
        <Icon name="page" /><span><strong>{result.title || '未命名页面'}</strong>
          <small>{result.snippet}</small></span><Icon name="arrow" size={15} />
      </button>)}
      {phase === 'ready' && truncated && <p className="persistent-search-message">仅显示前 30 条，请增加关键词缩小范围。</p>}
    </div>
    <div className="modal-footnote">↑ ↓ 选择 · Enter 打开 · Esc 关闭 · 搜索已保存到服务端的页面</div>
  </Modal>;
}
