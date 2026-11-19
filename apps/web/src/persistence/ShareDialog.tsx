import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreatePageShareResponse, PageShare, ShareLifetimeDays, ShareStatus } from '@nbase/contracts';
import { activeSharesPerPageLimit, defaultShareLifetimeDays, shareLifetimeDays } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import { shareClient } from './collabClient';
import { isAuthError, message } from './workspaceErrors';
import './members.css';

const statusLabels: Record<ShareStatus, string> = { active: '有效', expired: '已过期', revoked: '已撤销' };

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function ShareDialog({ workspaceId, pageId, title, csrfToken, onAuthError, onClose }: {
  workspaceId: string; pageId: string; title: string; csrfToken: string; onAuthError: () => void; onClose: () => void;
}) {
  const [shares, setShares] = useState<PageShare[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [days, setDays] = useState<ShareLifetimeDays>(defaultShareLifetimeDays);
  const [created, setCreated] = useState<CreatePageShareResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError('');
    try {
      const response = await shareClient.list(workspaceId, pageId, signal);
      if (signal?.aborted) return;
      setShares(response.shares); setEnabled(response.enabled);
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
  }, [load]);

  const run = async <T,>(key: string, action: () => Promise<T>, done: (value: T) => void) => {
    if (busy) return;
    setBusy(key); setError(''); setStatus('');
    try { done(await action()); }
    catch (failure) {
      if (isAuthError(failure)) authRef.current();
      setError(message(failure));
    } finally { setBusy(null); }
  };
  const create = () => void run('create', () => shareClient.create(workspaceId, pageId, { includeChildren, expiresInDays: days }, csrfToken),
    response => {
      setCreated(response); setCopied(false);
      setShares(list => [response.share, ...(list ?? []).filter(item => item.id !== response.share.id)]);
    });
  const revoke = (share: PageShare) => void run(`revoke:${share.id}`, () => shareClient.revoke(workspaceId, share.id, csrfToken), updated => {
    setShares(list => list?.map(item => item.id === updated.id ? updated : item) ?? list);
    if (created?.share.id === updated.id) setCreated(null);
    setStatus('链接已撤销，打开它的人会看到「分享已结束」。');
  });
  const copy = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); setCopied(true); }
    catch { linkRef.current?.select(); setStatus('无法写入剪贴板，链接已选中，请手动复制。'); }
  };

  const activeCount = shares?.filter(item => item.status === 'active').length ?? 0;
  return <Modal title={`分享「${title || '未命名页面'}」`} wide onClose={onClose}>
    <div className="nb-members">
      <p className="dialog-description">拿到链接的人不用登录就能阅读页面，不能修改，看不到评论、历史版本和工作区的其他页面。
        链接只能在本机和局域网中打开。</p>
      {!enabled && <p className="dialog-description nb-members-error" role="status">服务端已关闭分享链接（NBASE_SHARE_LINKS=off）：不能新建，已有链接也无法打开，只能查看和撤销。</p>}
      {loadError && <p className="dialog-description" role="alert">{loadError}
        <button className="nb-btn nb-btn-quiet" onClick={() => void load()}>重试</button></p>}
      {!shares && !loadError && <p className="dialog-description" role="status">正在读取分享链接…</p>}
      {shares && <section className="nb-members-section" aria-labelledby="nb-share-heading">
        <h3 id="nb-share-heading">新建只读链接</h3>
        <div className="nb-invite-form">
          <label><span className="field-label">范围</span>
            <select className="select-field" value={includeChildren ? 'tree' : 'page'} disabled={!enabled}
              onChange={event => setIncludeChildren(event.target.value === 'tree')}>
              <option value="page">只有这个页面</option><option value="tree">这个页面和全部子页面</option></select></label>
          <label><span className="field-label">有效期</span>
            <select className="select-field" value={days} disabled={!enabled} onChange={event => setDays(Number(event.target.value) as ShareLifetimeDays)}>
              {shareLifetimeDays.map(item => <option key={item} value={item}>{item} 天</option>)}</select></label>
          <button className="nb-btn nb-btn-primary" disabled={!enabled || Boolean(busy) || activeCount >= activeSharesPerPageLimit} onClick={create}>
            {busy === 'create' ? '正在生成…' : '生成链接'}</button>
        </div>
        {includeChildren && <p className="dialog-description">子页面包括以后新建的子页面；多维表格和行页面不会分享，白板只显示标题。</p>}
        {activeCount >= activeSharesPerPageLimit && <p className="dialog-description" role="status">有效链接已达 {activeSharesPerPageLimit} 个，请先撤销不用的链接。</p>}
        {created && <div className="nb-invite-created">
          <label className="field-label" htmlFor="nb-share-link">新的只读链接 · {created.share.includeChildren ? '含子页面' : '仅本页'} · {time(created.share.expiresAt)} 前有效</label>
          <div className="nb-invite-link">
            <input id="nb-share-link" ref={linkRef} type="text" readOnly value={created.url} onFocus={event => event.currentTarget.select()} />
            <button className="nb-btn" onClick={() => void copy()}>{copied ? '已复制' : '复制链接'}</button>
          </div>
          <p className="nb-invite-warning">链接只显示这一次，关闭对话框后无法再次查看。拿到链接的人都能阅读，请只发给需要的人；不用时随时撤销。</p>
        </div>}
      </section>}
      {shares && <section className="nb-members-section" aria-labelledby="nb-share-list-heading">
        <h3 id="nb-share-list-heading">已有链接</h3>
        {shares.length ? <ul className="nb-invite-list">
          {shares.map(share => <li key={share.id} className={`nb-invite nb-invite-${share.status}`}>
            <div className="nb-member-main">
              <strong>{share.includeChildren ? '含子页面' : '仅本页'} · {statusLabels[share.status]}</strong>
              <span className="nb-member-meta">{share.createdBy.loginName || '已删除的账号'} {time(share.createdAt)} 创建 · {
                share.status === 'revoked' && share.revokedAt ? `${time(share.revokedAt)} 撤销`
                  : share.status === 'expired' ? `${time(share.expiresAt)} 过期` : `${time(share.expiresAt)} 前有效`}</span>
              <span className="nb-member-meta">{share.viewCount ? `打开 ${share.viewCount} 次${share.lastViewedAt ? `，最近 ${time(share.lastViewedAt)}` : ''}` : '还没有人打开'}</span>
            </div>
            {share.status === 'active' && <button className="nb-btn" disabled={Boolean(busy)} onClick={() => revoke(share)}>
              {busy === `revoke:${share.id}` ? '正在撤销…' : '撤销'}</button>}
          </li>)}
        </ul> : <p className="dialog-description">还没有分享过这个页面。</p>}
      </section>}
      {status && <p className="dialog-description" role="status">{status}</p>}
      {error && <p className="dialog-description nb-members-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="nb-btn" onClick={onClose}>关闭</button></div>
    </div>
  </Modal>;
}
