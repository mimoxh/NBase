import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateInvitationResponse, InvitableRole, InvitationLifetimeDays, InvitationStatus, MemberRole, WorkspaceInvitation, WorkspaceMember,
} from '@nbase/contracts';
import { defaultInvitationLifetimeDays, invitableRoles, invitationLifetimeDays, pendingInvitationLimit } from '@nbase/contracts';
import { memberClient } from './memberClient';
import { isAuthError, message } from './workspaceErrors';
import './members.css';

export const roleLabels: Record<MemberRole, string> = { owner: '所有者', editor: '编辑者', viewer: '只读成员' };
const statusLabels: Record<InvitationStatus, string> = { pending: '待接受', expired: '已过期', accepted: '已接受', revoked: '已撤销' };
const roleHints: Record<InvitableRole, string> = {
  editor: '编辑者可以新建、修改、移动和删除内容。',
  viewer: '只读成员可以阅读、搜索、导出和收藏，不能修改内容。',
};

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Owner-only member and invitation management, shown as a settings section. */
export function MembersPanel({ workspaceId, csrfToken, onAuthError }: {
  workspaceId: string; csrfToken: string; onAuthError: () => void;
}) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [role, setRole] = useState<InvitableRole>('editor');
  const [days, setDays] = useState<InvitationLifetimeDays>(defaultInvitationLifetimeDays);
  const [created, setCreated] = useState<CreateInvitationResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError('');
    try {
      const [memberList, invitationList] = await Promise.all([
        memberClient.members(workspaceId, signal), memberClient.invitations(workspaceId, signal)]);
      if (signal?.aborted) return;
      setMembers(memberList.members); setInvitations(invitationList.invitations);
    } catch (failure) {
      if (signal?.aborted) return;
      if (isAuthError(failure)) authRef.current();
      setLoadError(message(failure));
    }
  }, [workspaceId]);
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
  const replaceMember = (member: WorkspaceMember) =>
    setMembers(list => list?.map(item => item.userId === member.userId ? member : item) ?? list);
  const replaceInvitation = (invitation: WorkspaceInvitation) =>
    setInvitations(list => list?.map(item => item.id === invitation.id ? invitation : item) ?? list);

  const changeRole = (member: WorkspaceMember, next: InvitableRole) => void run(`role:${member.userId}`,
    () => memberClient.setRole(workspaceId, member.userId, next, csrfToken), updated => {
      replaceMember(updated);
      setStatus(`${updated.loginName} 已改为${roleLabels[updated.role]}。对方需要重新登录。`);
    });
  const remove = (member: WorkspaceMember) => void run(`remove:${member.userId}`,
    () => memberClient.remove(workspaceId, member.userId, csrfToken), updated => {
      replaceMember(updated); setConfirmRemove(null);
      setStatus(`已移除 ${updated.loginName}，对方已退出登录。个人数据保留，可以随时恢复。`);
    });
  const restore = (member: WorkspaceMember) => void run(`restore:${member.userId}`,
    () => memberClient.restore(workspaceId, member.userId, csrfToken), updated => {
      replaceMember(updated);
      setStatus(`已恢复 ${updated.loginName}，对方可以重新登录。`);
    });
  const create = () => void run('create', () => memberClient.createInvitation(workspaceId, { role, expiresInDays: days }, csrfToken), response => {
    setCreated(response); setCopied(false);
    setInvitations(list => [response.invitation, ...(list ?? []).filter(item => item.id !== response.invitation.id)]);
  });
  const revoke = (invitation: WorkspaceInvitation) => void run(`revoke:${invitation.id}`,
    () => memberClient.revokeInvitation(workspaceId, invitation.id, csrfToken), updated => {
      replaceInvitation(updated);
      if (created?.invitation.id === updated.id) setCreated(null);
      setStatus('邀请已撤销，这个链接不能再使用。');
    });
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      linkRef.current?.select();
      setStatus('无法写入剪贴板，链接已选中，请手动复制。');
    }
  };

  const pendingCount = invitations?.filter(item => item.status === 'pending').length ?? 0;
  const activeCount = members?.filter(item => !item.removedAt).length ?? 0;
  return <div className="nb-members">
    {loadError && <p className="dialog-description" role="alert">{loadError}
      <button className="nb-btn nb-btn-quiet" onClick={() => void load()}>重试</button></p>}
    {!members && !loadError && <p className="dialog-description" role="status">正在读取成员…</p>}
    {members && <section className="nb-members-section" aria-labelledby="nb-members-heading">
      <h3 id="nb-members-heading">成员 · {activeCount} 人</h3>
      <ul className="nb-member-list">
        {members.map(member => <li key={member.userId} className={`nb-member ${member.removedAt ? 'nb-member-removed' : ''}`}>
          <div className="nb-member-row">
            <div className="nb-member-main">
              <strong>{member.loginName}</strong>
              <span className="nb-member-meta">{member.removedAt ? `${time(member.removedAt)} 已移除`
                : `${time(member.joinedAt)} 加入 · ${member.lastLoginAt ? `最近登录 ${time(member.lastLoginAt)}` : '尚未登录'}`}</span>
            </div>
            <div className="nb-member-actions">
              {member.role === 'owner' ? <span className="nb-member-role">{roleLabels.owner}</span>
                : member.removedAt ? <>
                  <span className="nb-member-role">{roleLabels[member.role]} · 已移除</span>
                  <button className="nb-btn" disabled={Boolean(busy)} onClick={() => restore(member)}>
                    {busy === `restore:${member.userId}` ? '正在恢复…' : '恢复'}</button>
                </> : <>
                  <select className="select-field nb-member-select" aria-label={`${member.loginName} 的角色`} value={member.role}
                    disabled={Boolean(busy)} onChange={event => changeRole(member, event.target.value as InvitableRole)}>
                    {invitableRoles.map(item => <option key={item} value={item}>{roleLabels[item]}</option>)}
                  </select>
                  <button className="nb-btn nb-member-remove" disabled={Boolean(busy)}
                    onClick={() => { setConfirmRemove(member.userId); setError(''); setStatus(''); }}>移除</button>
                </>}
            </div>
          </div>
          {confirmRemove === member.userId && !member.removedAt && <div className="nb-member-confirm" role="group" aria-label={`确认移除 ${member.loginName}`}>
            <p>移除后，{member.loginName} 会立即退出登录，不能再访问这个工作区。收藏、日历设置等个人数据保留，恢复后可以继续使用；TA 写过的页面不受影响。</p>
            <div className="nb-member-confirm-actions">
              <button className="nb-btn" disabled={Boolean(busy)} onClick={() => setConfirmRemove(null)}>取消</button>
              <button className="nb-btn nb-btn-primary nb-btn-danger" disabled={Boolean(busy)} onClick={() => remove(member)}>
                {busy === `remove:${member.userId}` ? '正在移除…' : '确认移除'}</button>
            </div>
          </div>}
        </li>)}
      </ul>
      <p className="dialog-description">修改角色或移除成员后，对方当前的登录会立即失效。</p>
    </section>}
    {invitations && <section className="nb-members-section" aria-labelledby="nb-invite-heading">
      <h3 id="nb-invite-heading">邀请链接</h3>
      <div className="nb-invite-form">
        <label><span className="field-label">角色</span>
          <select className="select-field" value={role} onChange={event => setRole(event.target.value as InvitableRole)}>
            {invitableRoles.map(item => <option key={item} value={item}>{roleLabels[item]}</option>)}</select></label>
        <label><span className="field-label">有效期</span>
          <select className="select-field" value={days} onChange={event => setDays(Number(event.target.value) as InvitationLifetimeDays)}>
            {invitationLifetimeDays.map(item => <option key={item} value={item}>{item} 天</option>)}</select></label>
        <button className="nb-btn nb-btn-primary" disabled={Boolean(busy) || pendingCount >= pendingInvitationLimit} onClick={create}>
          {busy === 'create' ? '正在生成…' : '生成邀请链接'}</button>
      </div>
      <p className="dialog-description">{roleHints[role]}每个链接只能使用一次，对方打开后自己设置账号名和密码。</p>
      {pendingCount >= pendingInvitationLimit && <p className="dialog-description" role="status">待接受的邀请已达 {pendingInvitationLimit} 个，请先撤销不用的链接。</p>}
      {created && <div className="nb-invite-created">
        <label className="field-label" htmlFor="nb-invite-link">新的邀请链接 · {roleLabels[created.invitation.role]} · {time(created.invitation.expiresAt)} 前有效</label>
        <div className="nb-invite-link">
          <input id="nb-invite-link" ref={linkRef} type="text" readOnly value={created.url} onFocus={event => event.currentTarget.select()} />
          <button className="nb-btn" onClick={() => void copy()}>{copied ? '已复制' : '复制链接'}</button>
        </div>
        <p className="nb-invite-warning">链接只显示这一次，关闭设置后无法再次查看。请通过可信的渠道发给对方；拿到链接的人都能用它加入。</p>
      </div>}
      {invitations.length ? <ul className="nb-invite-list">
        {invitations.map(invitation => <li key={invitation.id} className={`nb-invite nb-invite-${invitation.status}`}>
          <div className="nb-member-main">
            <strong>{roleLabels[invitation.role]} · {statusLabels[invitation.status]}</strong>
            <span className="nb-member-meta">{time(invitation.createdAt)} 创建 · {invitation.status === 'accepted'
              ? `${invitation.acceptedAt ? time(invitation.acceptedAt) : ''} 由 ${invitation.acceptedLoginName ?? '已删除的账号'} 接受`
              : invitation.status === 'revoked' && invitation.revokedAt ? `${time(invitation.revokedAt)} 撤销`
              : invitation.status === 'expired' ? `${time(invitation.expiresAt)} 过期` : `${time(invitation.expiresAt)} 前有效`}</span>
          </div>
          {invitation.status === 'pending' && <button className="nb-btn" disabled={Boolean(busy)} onClick={() => revoke(invitation)}>
            {busy === `revoke:${invitation.id}` ? '正在撤销…' : '撤销'}</button>}
        </li>)}
      </ul> : <p className="dialog-description">还没有邀请过成员。</p>}
    </section>}
    {status && <p className="dialog-description" role="status">{status}</p>}
    {error && <p className="dialog-description nb-members-error" role="alert">{error}</p>}
  </div>;
}
