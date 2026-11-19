import { useEffect, useRef, useState, type ReactNode } from 'react';
import { historySearchLimit, isWhiteboardContent, pageVersionLabelLimit, pageVersionNoteLimit, type HistorySearchMatch, type PageSummary, type PageVersion, type PageVersionSummary, type StoredDocumentContent, type TrashedPageDocument,
  type TrashedPageSummary } from '@nbase/contracts';
import { LazyWhiteboard } from '../whiteboard/lazy';
import { attachmentContentUrl } from '../whiteboard/host';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { DocumentEditor } from '../editor/DocumentEditor';
import type { DocumentContent, EditorPageReferences } from '../editor/types';
import { ApiError, pageClient } from './client';
import { diffVersions, type DiffLine } from './versionDiff';
import { groupHistory } from './historyGroups';
import { PageIcon } from '../shell/PageTree';
import { relativeTime } from '../shell/Topbar';
import { invalidPhraseMessage, marked, pendingHistoryNotice, searchPhraseInvalid } from './searchText';

const operationNames: Record<PageVersionSummary['operation'], string> = {
  baseline: '迁移基线', create: '创建', update: '保存', trash: '移入回收站', restore: '从回收站恢复', 'restore-version': '恢复历史',
};

function Preview({ id, title, content, workspaceId, pageReferences }: { id: string; title: string; content: StoredDocumentContent;
  workspaceId: string; pageReferences?: EditorPageReferences | undefined }) {
  const downloadRaw = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nbase-original-content.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="nbase-history-preview"><h3 className="nb-preview-title" data-nbase-find-title>{title || '未命名页面'}</h3>
    {isWhiteboardContent(content) ? <div className="wb-preview"><LazyWhiteboard key={id} boardId={id} content={content} readOnly title={title}
      pages={pageReferences?.pages ?? []} onChange={() => {}} onOpenPage={() => {}} onNotice={() => {}}
      imageUrl={attachmentId => attachmentContentUrl(workspaceId, attachmentId)} /></div>
    : content.schemaVersion === 1 ? <DocumentEditor key={id} documentId={id} title={title} initialContent={content as DocumentContent}
      workspaceId={workspaceId} pageReferences={pageReferences} readOnly onChange={() => {}} />
      : <div role="alert"><p>暂不支持此版本的正文预览，原始数据仍保留。</p><button className="nb-btn" onClick={downloadRaw}>下载原始 JSON</button></div>}
  </div>;
}

function failure(error: unknown): string {
  return error instanceof ApiError && error.status === 401 ? '登录已失效，请关闭后重新登录。' : '读取失败，请重试。';
}

function diffLineView(line: DiffLine, index: number): ReactNode {
  if (line.type === 'change') {
    return <div className="nb-diff-keep" key={index}>
      {line.block.kind === 'todo' && <span className={line.block.checked ? 'nb-todo-done' : ''}>{line.block.checked ? '☑ ' : '☐ '}</span>}
      {line.spans.map((span, spanIndex) => span.tone === 'keep' ? <span key={spanIndex}>{span.text}</span>
        : <span key={spanIndex} className={span.tone === 'add' ? 'nb-diff-add' : 'nb-diff-del'}>{span.text}</span>)}
    </div>;
  }
  const prefix = line.block.kind === 'todo' ? (line.block.checked ? '☑ ' : '☐ ') : line.block.kind === 'ul' ? '• ' : '';
  const cls = line.type === 'add' ? 'nb-diff-block-add' : line.type === 'del' ? 'nb-diff-block-del' : 'nb-diff-keep';
  return <div className={cls} key={index}>{line.block.checked ? <span className="nb-todo-done">{prefix}</span> : prefix}{line.block.text || ' '}</div>;
}

type CompareBase = 'previous' | 'current' | `revision:${string}`;
type BaseState = { status: 'loading' } | { status: 'ready'; version: PageVersion } | { status: 'none' | 'same' | 'error' };

const labelControls = /[\u0000-\u001f\u007f]/g;
const noteControls = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const loneSurrogates = /\p{Cs}/gu;
const codePoints = (value: string) => [...value].length;
const cleanLabel = (value: string) => value.replace(loneSurrogates, '').replace(labelControls, ' ').trim();
const cleanNote = (value: string) => value.replace(loneSurrogates, '').replace(/\r\n?/g, '\n').replace(noteControls, ' ').trim();

function labelFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return '名称未保存，请重试。';
  if (error.status === 401) return '登录已失效，名称未保存。请重新登录后再试。';
  if (error.status === 403) return '没有修改此工作区的权限。';
  if (error.status === 404) return '这个版本已不存在。';
  if (error.status === 0) return '网络不可用，名称未保存，请重试。';
  return '名称未保存，请重试。';
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayTimeOf = (iso: string) => new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type HistorySearchState = { phase: 'idle' | 'loading' | 'ready' | 'error'; hits: HistorySearchMatch[]; truncated: boolean;
  pending: number; error: string };
const idleSearch: HistorySearchState = { phase: 'idle', hits: [], truncated: false, pending: 0, error: '' };

/** Time of the version, led by its revision when a name takes the revision's place as the heading. */
function versionCaption(version: PageVersionSummary): string {
  const time = new Date(version.savedAt).toLocaleString();
  return version.label ? `修订 ${version.revision} · ${time}` : time;
}

export function PageHistoryDialog({ workspaceId, pageId, currentRevision, busy, canWrite, csrfToken, nameRevision, initialRevision,
  initialQuery, pageReferences, onRestore, onAuthError, onClose }: {
  workspaceId: string; pageId: string; currentRevision: string; busy: boolean;
  canWrite: boolean; csrfToken: string;
  /** Opens with this version selected and its name form shown. */
  nameRevision?: string | undefined;
  /** Opens with this version selected, such as a history search hit. */
  initialRevision?: string | undefined;
  /** Opens with the history search already filled in. */
  initialQuery?: string | undefined;
  pageReferences?: EditorPageReferences | undefined;
  onRestore: (version: PageVersion) => void; onAuthError?: () => void; onClose: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'named'>('all');
  const [versions, setVersions] = useState<PageVersionSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(nameRevision ?? initialRevision ?? null);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState<HistorySearchState>(idleSearch);
  const [searchRetry, setSearchRetry] = useState(0);
  const [preview, setPreview] = useState<PageVersion | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [compareTo, setCompareTo] = useState<CompareBase>('previous');
  const [base, setBase] = useState<BaseState>({ status: 'loading' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [retry, setRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [labelSaving, setLabelSaving] = useState(false);
  const [labelError, setLabelError] = useState('');
  const cache = useRef(new Map<string, PageVersion>());
  const pendingName = useRef(nameRevision);
  const authErrorRef = useRef(onAuthError);
  authErrorRef.current = onAuthError;

  const loadVersion = async (revision: string, signal: AbortSignal) => {
    const cached = cache.current.get(revision);
    if (cached) return cached;
    const value = await pageClient.version(workspaceId, pageId, revision, signal);
    cache.current.set(revision, value);
    return value;
  };
  const startEditing = (version: PageVersionSummary) => {
    setEditing(version.revision); setDraftLabel(version.label ?? ''); setDraftNote(version.note ?? ''); setLabelError('');
  };

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void pageClient.history(workspaceId, pageId, { before: cursor, named: filter === 'named' }, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      setVersions(previous => cursor ? [...new Map([...previous, ...response.versions].map(item => [item.revision, item])).values()] : response.versions);
      setNext(response.nextBeforeRevision);
      if (!cursor) setSelected(previous => previous ?? response.versions[0]?.revision ?? null);
      const naming = pendingName.current && response.versions.find(item => item.revision === pendingName.current);
      if (naming) { pendingName.current = undefined; startEditing(naming); }
    }).catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, pageId, cursor, retry, filter]);
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (!selected) return;
    const controller = new AbortController(); setPreviewLoading(true);
    void loadVersion(selected, controller.signal).then(value => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch(cause => { if (!controller.signal.aborted) setPreviewError(failure(cause)); })
      .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    return () => controller.abort();
  }, [workspaceId, pageId, selected, previewRetry]);
  useEffect(() => {
    if (!showDiff || !selected) return;
    const controller = new AbortController();
    setBase({ status: 'loading' });
    void (async () => {
      let revision: string | null;
      if (compareTo === 'current') revision = currentRevision;
      else if (compareTo !== 'previous') revision = compareTo.slice('revision:'.length);
      else {
        const index = versions.findIndex(item => item.revision === selected);
        const listed = filter === 'all' && index >= 0 ? versions[index + 1] : undefined;
        revision = listed?.revision ?? (await pageClient.history(workspaceId, pageId, { before: selected, limit: 1 },
          controller.signal)).versions[0]?.revision ?? null;
      }
      if (controller.signal.aborted) return;
      if (revision === null) { setBase({ status: 'none' }); return; }
      if (revision === selected) { setBase({ status: 'same' }); return; }
      const version = await loadVersion(revision, controller.signal);
      if (!controller.signal.aborted) setBase({ status: 'ready', version });
    })().catch(() => { if (!controller.signal.aborted) setBase({ status: 'error' }); });
    return () => controller.abort();
    // `versions` only shortcuts the previous-version lookup; loading more of the list must not refetch the same base.
  }, [workspaceId, pageId, selected, showDiff, compareTo, currentRevision, filter, previewRetry]);

  const phrase = query.trim();
  const searching = Boolean(phrase);
  useEffect(() => {
    if (!phrase || composing) { setSearch(idleSearch); return; }
    if (searchPhraseInvalid(phrase)) { setSearch({ ...idleSearch, phase: 'error', error: invalidPhraseMessage }); return; }
    setSearch({ ...idleSearch, phase: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void pageClient.pageHistorySearch(workspaceId, pageId, phrase, controller.signal).then(response => {
        if (controller.signal.aborted) return;
        setSearch({ phase: 'ready', hits: response.versions, truncated: response.truncated, pending: response.pendingVersions, error: '' });
        // Keep the preview on a version the filtered list shows.
        setSelected(previous => response.versions.some(hit => hit.revision === previous) ? previous : response.versions[0]?.revision ?? previous);
      }).catch(cause => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) authErrorRef.current?.();
        setSearch({ ...idleSearch, phase: 'error', error: failure(cause) });
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspaceId, pageId, phrase, composing, searchRetry]);

  const changeFilter = (value: 'all' | 'named') => {
    if (value === filter) return;
    setFilter(value); setCursor(undefined); setVersions([]); setNext(null);
  };
  const saveLabel = async (revision: string, label: string | null, note: string | null) => {
    setLabelSaving(true); setLabelError('');
    try {
      const updated = await pageClient.labelVersion(workspaceId, pageId, revision, { label, note }, csrfToken);
      setVersions(list => filter === 'named' && updated.label === null ? list.filter(item => item.revision !== revision)
        : list.map(item => item.revision === revision ? updated : item));
      setSearch(value => ({ ...value, hits: value.hits.map(hit => hit.revision === revision ? { ...hit, label: updated.label, note: updated.note } : hit) }));
      const cached = cache.current.get(revision);
      if (cached) cache.current.set(revision, { ...cached, label: updated.label, note: updated.note });
      setPreview(value => value && value.revision === revision ? { ...value, label: updated.label, note: updated.note } : value);
      setBase(value => value.status === 'ready' && value.version.revision === revision
        ? { status: 'ready', version: { ...value.version, label: updated.label, note: updated.note } } : value);
      setEditing(null);
    } catch (cause) {
      setLabelError(labelFailure(cause));
      if (cause instanceof ApiError && cause.status === 401) authErrorRef.current?.();
    } finally { setLabelSaving(false); }
  };

  const days = groupHistory(versions, new Date());
  const summary = versions.find(item => item.revision === selected) ?? search.hits.find(item => item.revision === selected)
    ?? (preview && preview.revision === selected ? preview : null);
  const hits = filter === 'named' ? search.hits.filter(hit => hit.label) : search.hits;
  const firstHit = searching && search.phase === 'ready' && !hits.some(hit => hit.revision === selected) ? hits[0]?.revision : undefined;
  useEffect(() => { if (firstHit) setSelected(firstHit); }, [firstHit]);
  const pair = showDiff && preview && base.status === 'ready'
    ? (BigInt(base.version.revision) < BigInt(preview.revision) ? [base.version, preview] as const : [preview, base.version] as const)
    : null;
  const diffable = (content: StoredDocumentContent) => content.schemaVersion === 1 && !isWhiteboardContent(content);
  const diff = pair && diffable(pair[0].content) && diffable(pair[1].content)
    ? diffVersions(pair[0].content as DocumentContent, pair[1].content as DocumentContent) : null;
  const label = cleanLabel(draftLabel);
  const note = cleanNote(draftNote);
  const labelTooLong = codePoints(label) > pageVersionLabelLimit;
  const noteTooLong = codePoints(note) > pageVersionNoteLimit;
  const compareOptions = versions.filter(item => item.revision !== selected);
  const pinned = compareTo.startsWith('revision:') ? compareTo.slice('revision:'.length) : null;

  const item = (version: PageVersionSummary, nested = false) => <button key={version.revision}
    className={`nb-hist-item ${selected === version.revision ? 'selected' : ''} ${nested ? 'nb-hist-nested' : ''}`}
    aria-current={selected === version.revision ? 'true' : undefined}
    onClick={() => { setSelected(version.revision); if (editing !== version.revision) setEditing(null); }} disabled={busy}>
    <strong>{timeOf(version.savedAt)} · 修订 {version.revision}
      {version.revision === currentRevision && <span className="nb-hist-cur">当前</span>}</strong>
    {version.label && <span className="nb-hist-label">{version.label}</span>}
    <span>{operationNames[version.operation]}{version.deleted ? ' · 已删除' : ''}</span>
  </button>;

  const hitItem = (hit: HistorySearchMatch) => {
    const mark = hit.highlight ?? phrase;
    return <button key={hit.revision} className={`nb-hist-item nb-hist-hit ${selected === hit.revision ? 'selected' : ''}`}
      aria-current={selected === hit.revision ? 'true' : undefined}
      onClick={() => { setSelected(hit.revision); if (editing !== hit.revision) setEditing(null); }} disabled={busy}>
      <strong>{dayTimeOf(hit.savedAt)} · 修订 {hit.revision}
        {hit.revision === currentRevision && <span className="nb-hist-cur">当前</span>}</strong>
      {hit.label && <span className="nb-hist-label">{hit.label}</span>}
      <span>{operationNames[hit.operation]}{hit.deleted ? ' · 已删除' : ''}{hit.actor ? ` · ${hit.actor.loginName}` : ''}</span>
      <span className="nb-hist-snip">{hit.matchField === 'title' || hit.snippet === '仅标题匹配'
        ? marked(`标题：${hit.title || '未命名页面'}`, mark) : marked(hit.snippet, mark)}</span>
    </button>;
  };

  return <Modal title="历史" variant="large" onClose={onClose}>
    <div className="nb-hist">
      <div className="nb-hist-preview">
        <div className="nb-hist-bar">
          <label className="nb-hist-toggle"><input type="checkbox" checked={showDiff} onChange={event => setShowDiff(event.target.checked)} />显示变更</label>
          {showDiff && <label className="nb-hist-compare">对比
            <select className="select-field" aria-label="对比版本" value={compareTo} onChange={event => setCompareTo(event.target.value as CompareBase)}>
              <option value="previous">上一版本</option>
              <option value="current">当前版本（修订 {currentRevision}）</option>
              {pinned && !compareOptions.some(option => option.revision === pinned) && <option value={compareTo}>修订 {pinned}</option>}
              {compareOptions.map(option => <option key={option.revision} value={`revision:${option.revision}`}>
                修订 {option.revision} · {option.label ?? new Date(option.savedAt).toLocaleString()}</option>)}
            </select></label>}
        </div>
        {summary && <div className="nb-hist-meta">
          {editing === summary.revision ? <form className="nb-hist-label-form" onSubmit={event => {
            event.preventDefault();
            if (label && !labelTooLong && !noteTooLong) void saveLabel(summary.revision, label, note || null);
          }}>
            <input type="text" aria-label="版本名称" placeholder="版本名称，例如：评审稿" value={draftLabel} autoFocus
              onChange={event => setDraftLabel(event.target.value)} disabled={labelSaving} />
            <textarea aria-label="版本备注" placeholder="备注（可选）" rows={2} value={draftNote}
              onChange={event => setDraftNote(event.target.value)} disabled={labelSaving} />
            <div className="nb-hist-label-actions">
              <span className={`nb-hist-count ${labelTooLong || noteTooLong ? 'over' : ''}`}>
                名称 {codePoints(label)}/{pageVersionLabelLimit} · 备注 {codePoints(note)}/{pageVersionNoteLimit}</span>
              {labelError && <span role="alert" className="nb-hist-label-error">{labelError}</span>}
              {summary.label && <button type="button" className="nb-btn nb-btn-quiet" disabled={labelSaving}
                onClick={() => void saveLabel(summary.revision, null, null)}>移除名称</button>}
              <button type="button" className="nb-btn" disabled={labelSaving} onClick={() => setEditing(null)}>取消</button>
              <button type="submit" className="nb-btn nb-btn-primary" disabled={labelSaving || !label || labelTooLong || noteTooLong}>
                {labelSaving ? '正在保存…' : '保存名称'}</button>
            </div>
          </form> : <>
            <div className="nb-hist-meta-main">
              <strong>{summary.label ?? `修订 ${summary.revision}`}</strong>
              <span>{versionCaption(summary)} · {operationNames[summary.operation]}</span>
              {summary.note && <p className="nb-hist-note">{summary.note}</p>}
            </div>
            {canWrite && <button className="nb-btn nb-btn-quiet" disabled={busy} onClick={() => startEditing(summary)}>
              {summary.label ? '编辑名称' : '命名此版本'}</button>}
          </>}
        </div>}
        <div className="nb-hist-preview-scroll">
          {previewLoading && <p role="status">正在读取预览…</p>}
          {previewError && <p role="alert">{previewError}<button onClick={() => setPreviewRetry(value => value + 1)}>重试预览</button></p>}
          {preview && !showDiff && <Preview id={`history:${pageId}:${preview.revision}`} title={preview.title} content={preview.content}
            workspaceId={workspaceId} pageReferences={pageReferences} />}
          {preview && showDiff && <div className="nbase-history-preview">
            {base.status === 'loading' && <p role="status">正在读取对比版本…</p>}
            {base.status === 'error' && <p role="alert">对比版本读取失败。<button onClick={() => setPreviewRetry(value => value + 1)}>重试</button></p>}
            {base.status === 'none' && <p className="nb-pal-msg">这是最早的版本，没有可对比的上一版本</p>}
            {base.status === 'same' && <p className="nb-pal-msg">对比的是同一个版本，请选择另一个版本</p>}
            {pair && <p className="nb-hist-range">
              <span className="nb-diff-del-tag">{pair[0].label ?? `修订 ${pair[0].revision}`}</span>
              <span> {versionCaption(pair[0])} → </span>
              <span className="nb-diff-add-tag">{pair[1].label ?? `修订 ${pair[1].revision}`}</span>
              <span> {versionCaption(pair[1])}</span></p>}
            {pair && !diff && <p className="nb-pal-msg">这种页面暂不支持显示变更</p>}
            {diff?.tooLarge && <p className="nb-pal-msg">内容过大，暂不显示变更</p>}
            {pair && diff && !diff.tooLarge && <div className="nb-diff">
              {pair[0].title !== pair[1].title ? <>
                <div className="nb-diff-block-del nb-diff-title">{pair[0].title || '未命名页面'}</div>
                <div className="nb-diff-block-add nb-diff-title">{pair[1].title || '未命名页面'}</div>
              </> : <h3>{pair[1].title || '未命名页面'}</h3>}
              {diff.lines.some(line => line.type !== 'keep') ? diff.lines.map(diffLineView)
                : <><p className="nb-pal-msg">正文文字没有变化</p>{diff.lines.map(diffLineView)}</>}
            </div>}
          </div>}
        </div>
      </div>
      <div className="nb-hist-side">
        <div className="nb-hist-search">
          <input type="text" aria-label="在历史中搜索" placeholder="在历史中搜索标题或正文" value={query}
            onChange={event => setQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
        </div>
        <div className="nb-hist-filter" role="group" aria-label="版本筛选">
          <button className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => changeFilter('all')}>全部</button>
          <button className={filter === 'named' ? 'active' : ''} aria-pressed={filter === 'named'} onClick={() => changeFilter('named')}>已命名</button>
        </div>
        {searching ? <div className="nb-hist-side-list" aria-label="搜索到的版本">
          {search.phase === 'loading' && <p className="nb-pal-msg" role="status">正在搜索历史…</p>}
          {search.phase === 'error' && <p className="nb-pal-msg" role="alert">{search.error}
            <button onClick={() => setSearchRetry(value => value + 1)}>重试</button></p>}
          {search.phase === 'ready' && search.pending > 0 && <p className="nb-hist-notice" role="note">{pendingHistoryNotice(search.pending)}</p>}
          {search.phase === 'ready' && hits.map(hitItem)}
          {search.phase === 'ready' && !hits.length && <p className="nb-pal-msg">{filter === 'named'
            ? '没有包含这些文字的命名版本' : '没有包含这些文字的版本'}</p>}
          {search.phase === 'ready' && search.truncated && <p className="nb-hist-notice">仅显示最近 {historySearchLimit} 个匹配的版本，请换用更具体的词。</p>}
        </div> : <div className="nb-hist-side-list" aria-label="版本列表">
          {days.map(day => <div key={day.key}>
            <div className="nb-hist-group">{day.label}</div>
            {day.entries.map(entry => {
              const open = expanded.has(entry.version.revision) || entry.hidden.some(version => version.revision === selected);
              const oldest = entry.hidden.at(-1);
              return <div key={entry.version.revision} className="nb-hist-run">
                {item(entry.version)}
                {oldest && <button className="nb-hist-fold" aria-expanded={open} onClick={() => setExpanded(previous => {
                  const value = new Set(previous);
                  if (open) value.delete(entry.version.revision); else value.add(entry.version.revision);
                  return value;
                })}>{open ? '收起' : '展开'}另外 {entry.hidden.length} 次连续保存 · {timeOf(oldest.savedAt)} 起</button>}
                {open && entry.hidden.map(version => item(version, true))}
              </div>;
            })}
          </div>)}
          {loading && <p role="status">正在读取历史…</p>}
          {error && <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
          {!loading && !error && !versions.length && <p className="nb-pal-msg">{filter === 'named'
            ? '还没有命名版本。选中一个版本后点“命名此版本”，或在页面菜单里选“保存为命名版本”。' : '还没有可读取的历史'}</p>}
          {next && !loading && <button className="nb-btn nb-btn-quiet" onClick={() => setCursor(next)}>加载更早版本</button>}
        </div>}
      </div>
    </div>
    <div className="dialog-actions"><span className="dialog-description" style={{ marginRight: 'auto' }}>恢复会生成新版本，当前内容仍保留在历史中，页面位置和图标不变。</span>
      <button className="nb-btn" onClick={onClose}>关闭</button>
      <button className="nb-btn nb-btn-primary" disabled={busy || !canWrite || !preview || preview.revision === currentRevision || preview.content.schemaVersion !== 1}
        onClick={() => { if (preview) onRestore(preview); }}>{busy ? '正在处理…' : '恢复此版本'}</button></div>
  </Modal>;
}

export function TrashDialog({ workspaceId, busy, canWrite = true, pages: activePages, initialPageId, pageReferences, onRestore, onClose }: {
  workspaceId: string; busy: boolean; canWrite?: boolean; pages: PageSummary[]; initialPageId?: string | undefined;
  pageReferences?: EditorPageReferences | undefined;
  onRestore: (page: TrashedPageDocument) => void; onClose: () => void;
}) {
  const [pages, setPages] = useState<TrashedPageSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(initialPageId ?? null);
  const [preview, setPreview] = useState<TrashedPageDocument | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void pageClient.trashList(workspaceId, cursor, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      setPages(previous => cursor ? [...new Map([...previous, ...response.pages].map(item => [item.id, item])).values()] : response.pages);
      setNext(response.nextCursor);
      if (!cursor) setSelected(previous => previous ?? response.pages[0]?.id ?? null);
    }).catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, cursor, retry]);
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (!selected) return;
    const controller = new AbortController();
    void pageClient.trashed(workspaceId, selected, controller.signal).then(value => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch(cause => { if (!controller.signal.aborted) setPreviewError(failure(cause)); });
    return () => controller.abort();
  }, [workspaceId, selected, retry]);

  const pathOf = (page: TrashedPageSummary): string => {
    if (!page.parentId) return '原位置：个人空间';
    const names: string[] = [];
    let cursor: string | null = page.parentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = activePages.find(item => item.id === cursor)
        ?? pages.find(item => item.id === cursor);
      if (!parent || !activePages.some(item => item.id === parent.id)) {
        return '原位置：已不在 · 将恢复到根目录';
      }
      names.unshift(parent.title || '未命名页面');
      cursor = parent.parentId;
    }
    return `原位置：${names.join(' / ')}`;
  };
  const siblings = (page: TrashedPageSummary) => pages.filter(item => item.deletionGroupId === page.deletionGroupId && item.id !== page.id).length;
  const needle = filter.trim().toLocaleLowerCase();
  const visible = needle ? pages.filter(page => (page.title || '未命名页面').toLocaleLowerCase().includes(needle)) : pages;

  return <Modal title="回收站" variant="large" hideHeader onClose={onClose}>
    <div className="nb-trash-head"><h2>回收站</h2><p>页面与附件不会自动清理</p></div>
    <div className="nb-trash-filter">
      <input type="text" aria-label="在回收站中搜索" placeholder="在回收站中搜索" value={filter}
        onChange={event => setFilter(event.target.value)} />
    </div>
    <div className="nb-hist">
      <div className="nb-trash-list" aria-label="回收站页面">
        {visible.map(page => <button key={page.id} className={`nb-trash-row ${selected === page.id ? 'selected' : ''}`} disabled={busy}
          onClick={() => setSelected(page.id)}>
          <PageIcon page={page} />
          <span className="nb-trash-main"><strong>{page.title || '未命名页面'}</strong>
            <small>{pathOf(page)} · {relativeTime(page.deletedAt).replace('编辑', '删除')}</small></span>
          {siblings(page) > 0 && <span className="nb-trash-badge">含 {siblings(page)} 个子页面</span>}
          {canWrite && <span className="nb-trash-restore" role="button" tabIndex={0}
            onClick={event => {
              event.stopPropagation();
              if (busy) return;
              if (preview?.id === page.id) { onRestore(preview); return; }
              void pageClient.trashed(workspaceId, page.id).then(doc => onRestore(doc)).catch(() => undefined);
            }}
            onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); event.preventDefault(); (event.currentTarget as HTMLElement).click(); } }}>恢复</span>}
        </button>)}
        {loading && <p className="nb-pal-msg" role="status">正在读取回收站…</p>}
        {error && <p className="nb-pal-msg" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {!loading && !error && !pages.length && <p className="nb-pal-msg">回收站是空的</p>}
        {!loading && !error && pages.length > 0 && !visible.length && <p className="nb-pal-msg">没有匹配的页面</p>}
        {next && !loading && <button className="nb-btn nb-btn-quiet" onClick={() => setCursor(next)}>加载更多</button>}
      </div>
      <div className="nb-trash-body">
        {selected && !preview && !previewError && <p role="status">正在读取预览…</p>}
        {previewError && <p role="alert">{previewError}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {preview && <>
          <div className="nb-trash-body-head"><h3 style={{ margin: 0 }}>{preview.title || '未命名页面'}</h3>
            {canWrite && <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => onRestore(preview)}>
              {busy ? '正在处理…' : '恢复'}</button>}</div>
          <Preview id={`trash:${preview.id}:${preview.revision}`} title={preview.title} content={preview.content}
            workspaceId={workspaceId} pageReferences={pageReferences} />
        </>}
      </div>
    </div>
  </Modal>;
}
