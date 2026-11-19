import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommentAnchor, CommentThread, MemberRole, PageComment } from '@nbase/contracts';
import { commentBodyLimit, normalizeCommentBody } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { commentClient } from './collabClient';
import { isAuthError, message } from './workspaceErrors';
import './comments.css';

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

export interface CommentLocator {
  anchor: () => CommentAnchor | null;
  /** Whether the block still exists; with `reveal`, scrolls to it. */
  locate: (anchor: CommentAnchor, reveal: boolean) => boolean;
}

interface Props {
  workspaceId: string;
  pageId: string;
  csrfToken: string;
  userId: string;
  role: MemberRole;
  /** Bumped when the live channel reports a change by someone else. */
  refreshKey: number;
  /** Changes whenever the page body may have moved, so anchors are looked up again. */
  contentKey: unknown;
  locator: CommentLocator;
  onCount: (open: number) => void;
  onAuthError: () => void;
  onClose: () => void;
}

function BodyField({ value, onChange, label, autoFocus = false, onSubmit }: {
  value: string; onChange: (value: string) => void; label: string; autoFocus?: boolean; onSubmit: () => void;
}) {
  const length = [...value].length;
  return <div className="nb-comment-field">
    <textarea aria-label={label} value={value} autoFocus={autoFocus} rows={3} placeholder="写下你的评论…"
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); }
      }} />
    <span className={`nb-comment-length ${length > commentBodyLimit ? 'is-over' : ''}`}>{length > commentBodyLimit * 0.8 ? `${length}/${commentBodyLimit}` : 'Ctrl+Enter 发布'}</span>
  </div>;
}

export function CommentsPanel({ workspaceId, pageId, csrfToken, userId, role, refreshKey, contentKey, locator, onCount, onAuthError, onClose }: Props) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState<{ anchor: CommentAnchor; body: string; id: string; commentId: string } | null>(null);
  const [reply, setReply] = useState<{ threadId: string; body: string; id: string } | null>(null);
  const [editing, setEditing] = useState<{ commentId: string; body: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;
  const countRef = useRef(onCount);
  countRef.current = onCount;
  const canResolve = role !== 'viewer';

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await commentClient.list(workspaceId, pageId, signal);
      if (signal?.aborted) return;
      setThreads(response.threads); setLoadError('');
    } catch (failure) {
      if (signal?.aborted) return;
      if (isAuthError(failure)) authRef.current();
      setLoadError(message(failure));
    }
  }, [workspaceId, pageId]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  useEffect(() => { countRef.current(threads?.filter(thread => !thread.resolvedAt).length ?? 0); }, [threads]);

  const found = useMemo(() => {
    void contentKey;
    return new Map((threads ?? []).map(thread => [thread.id, locator.locate(thread.anchor, false)]));
  }, [threads, contentKey, locator]);

  const replace = (thread: CommentThread) => setThreads(list => {
    const rest = (list ?? []).filter(item => item.id !== thread.id);
    if (!thread.comments.length) return rest;
    return (list ?? []).some(item => item.id === thread.id) ? (list ?? []).map(item => item.id === thread.id ? thread : item) : [...rest, thread];
  });
  const run = async (key: string, action: () => Promise<CommentThread>, done?: () => void) => {
    if (busy) return;
    setBusy(key); setError('');
    try { replace(await action()); done?.(); }
    catch (failure) {
      if (isAuthError(failure)) authRef.current();
      setError(message(failure));
      // Someone else may have deleted the thread or comment meanwhile.
      if (failure && typeof failure === 'object' && 'status' in failure && failure.status === 404) void load();
    } finally { setBusy(null); }
  };
  const body = (value: string) => {
    const normalized = normalizeCommentBody(value);
    if (normalized === null) setError(value.trim() ? `评论最多 ${commentBodyLimit} 个字符，不能包含控制字符。` : '评论不能为空。');
    return normalized;
  };

  const start = () => {
    setError('');
    const anchor = locator.anchor();
    if (!anchor) { setError('先在正文中点一下要评论的段落，或选中其中的文字，再点「评论选中段落」。'); return; }
    setDraft({ anchor, body: '', id: crypto.randomUUID(), commentId: crypto.randomUUID() });
  };
  const publish = () => {
    if (!draft) return;
    const text = body(draft.body);
    if (text === null) return;
    void run('create', () => commentClient.create(workspaceId, pageId, draft.anchor, text, { id: draft.id, commentId: draft.commentId }, csrfToken),
      () => setDraft(null));
  };
  const sendReply = () => {
    if (!reply) return;
    const text = body(reply.body);
    if (text === null) return;
    void run(`reply:${reply.threadId}`, () => commentClient.reply(workspaceId, reply.threadId, reply.id, text, csrfToken), () => setReply(null));
  };
  const saveEdit = () => {
    if (!editing) return;
    const text = body(editing.body);
    if (text === null) return;
    void run(`edit:${editing.commentId}`, () => commentClient.edit(workspaceId, editing.commentId, text, csrfToken), () => setEditing(null));
  };

  const visible = (threads ?? []).filter(thread => showResolved || !thread.resolvedAt);
  const resolvedCount = (threads ?? []).filter(thread => thread.resolvedAt).length;

  const comment = (thread: CommentThread, item: PageComment) => {
    const own = item.author.userId === userId;
    const canDelete = own || role === 'owner';
    if (editing?.commentId === item.id) return <li key={item.id} className="nb-comment">
      <BodyField label="修改评论" value={editing.body} autoFocus onChange={value => setEditing({ ...editing, body: value })} onSubmit={saveEdit} />
      <div className="nb-comment-actions">
        <button className="nb-btn" disabled={Boolean(busy)} onClick={() => setEditing(null)}>取消</button>
        <button className="nb-btn nb-btn-primary" disabled={Boolean(busy)} onClick={saveEdit}>{busy === `edit:${item.id}` ? '正在保存…' : '保存'}</button>
      </div>
    </li>;
    return <li key={item.id} className="nb-comment">
      <div className="nb-comment-meta"><strong>{item.author.loginName || '已删除的账号'}</strong>
        <span>{time(item.createdAt)}{item.editedAt ? ' · 已编辑' : ''}</span></div>
      <p className="nb-comment-body">{item.body}</p>
      {confirmDelete === item.id ? <div className="nb-comment-confirm" role="group" aria-label="确认删除评论">
        <span>删除这条评论？</span>
        <button className="nb-btn" disabled={Boolean(busy)} onClick={() => setConfirmDelete(null)}>取消</button>
        <button className="nb-btn nb-btn-primary nb-btn-danger" disabled={Boolean(busy)}
          onClick={() => void run(`delete:${item.id}`, () => commentClient.remove(workspaceId, item.id, csrfToken), () => setConfirmDelete(null))}>
          {busy === `delete:${item.id}` ? '正在删除…' : '删除'}</button>
      </div> : (own || canDelete) && <div className="nb-comment-tools">
        {own && !thread.resolvedAt && <button className="nb-btn nb-btn-quiet" disabled={Boolean(busy)}
          onClick={() => { setError(''); setEditing({ commentId: item.id, body: item.body }); }}>编辑</button>}
        {canDelete && <button className="nb-btn nb-btn-quiet" disabled={Boolean(busy)}
          onClick={() => { setError(''); setConfirmDelete(item.id); }}>删除</button>}
      </div>}
    </li>;
  };

  return <aside className="nb-comments" aria-label="评论">
    <div className="nb-comments-head">
      <h2>评论</h2>
      <button className="icon-button" aria-label="关闭评论" onClick={onClose}><Icon name="close" size={16} /></button>
    </div>
    <div className="nb-comments-new">
      {draft ? <div className="nb-comment-draft">
        <blockquote className="nb-comment-quote">{draft.anchor.quote || '（空段落）'}</blockquote>
        <BodyField label="新评论" value={draft.body} autoFocus onChange={value => setDraft({ ...draft, body: value })} onSubmit={publish} />
        <div className="nb-comment-actions">
          <button className="nb-btn" disabled={busy === 'create'} onClick={() => setDraft(null)}>取消</button>
          <button className="nb-btn nb-btn-primary" disabled={Boolean(busy)} onClick={publish}>{busy === 'create' ? '正在发布…' : '发布'}</button>
        </div>
      </div> : <button className="nb-btn nb-comment-start" onMouseDown={event => event.preventDefault()} onClick={start}>
        <Icon name="comment" size={15} />评论选中段落</button>}
      <p className="nb-comments-hint">评论单独保存，不会改动正文，也不会进入历史版本、导出和分享页。</p>
    </div>
    {error && <p className="nb-comments-error" role="alert">{error}</p>}
    {loadError && <p className="nb-comments-error" role="alert">{loadError}
      <button className="nb-btn nb-btn-quiet" onClick={() => void load()}>重试</button></p>}
    {!threads && !loadError && <p className="nb-comments-empty" role="status">正在读取评论…</p>}
    {threads && <>
      {resolvedCount > 0 && <label className="nb-comments-filter"><input type="checkbox" checked={showResolved}
        onChange={event => setShowResolved(event.target.checked)} />显示已解决（{resolvedCount}）</label>}
      {!visible.length && <p className="nb-comments-empty">{threads.length ? '没有未解决的评论。' : '还没有评论。'}</p>}
      <ol className="nb-comment-threads">
        {visible.map(thread => <li key={thread.id} className={`nb-comment-thread ${thread.resolvedAt ? 'is-resolved' : ''}`}>
          {found.get(thread.id)
            ? <button className="nb-comment-quote nb-comment-locate" title="定位到正文" onClick={() => locator.locate(thread.anchor, true)}>
              {thread.anchor.quote || '（空段落）'}</button>
            : <div className="nb-comment-quote is-missing"><span className="nb-comment-missing">原文已更改</span>{thread.anchor.quote}</div>}
          <ol className="nb-comment-list">{thread.comments.map(item => comment(thread, item))}</ol>
          {thread.resolvedAt && <p className="nb-comment-resolved">{thread.resolvedBy?.loginName ?? '成员'} 于 {time(thread.resolvedAt)} 标记为已解决</p>}
          {reply?.threadId === thread.id ? <div className="nb-comment-reply">
            <BodyField label="回复" value={reply.body} autoFocus onChange={value => setReply({ ...reply, body: value })} onSubmit={sendReply} />
            <div className="nb-comment-actions">
              <button className="nb-btn" disabled={Boolean(busy)} onClick={() => setReply(null)}>取消</button>
              <button className="nb-btn nb-btn-primary" disabled={Boolean(busy)} onClick={sendReply}>{busy === `reply:${thread.id}` ? '正在发布…' : '回复'}</button>
            </div>
          </div> : <div className="nb-comment-thread-actions">
            {!thread.resolvedAt && <button className="nb-btn nb-btn-quiet" disabled={Boolean(busy)}
              onClick={() => { setError(''); setReply({ threadId: thread.id, body: '', id: crypto.randomUUID() }); }}>回复</button>}
            {canResolve && <button className="nb-btn nb-btn-quiet" disabled={Boolean(busy)}
              onClick={() => void run(`resolve:${thread.id}`, () => commentClient.resolve(workspaceId, thread.id, !thread.resolvedAt, csrfToken))}>
              {busy === `resolve:${thread.id}` ? '正在保存…' : thread.resolvedAt ? '重新打开' : '标记为已解决'}</button>}
          </div>}
        </li>)}
      </ol>
    </>}
  </aside>;
}
