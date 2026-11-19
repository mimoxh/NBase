import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AuthSessionResponse, InvitationLookupResponse } from '@nbase/contracts';
import { invitationTokenFromHash, loginNamePattern, memberPasswordMinCharacters } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { ApiError, pageClient } from './client';
import { invitationClient } from './memberClient';
import { roleLabels } from './MembersDialog';
import { isAuthError, message } from './workspaceErrors';
import './members.css';

type Closed = Exclude<InvitationLookupResponse['status'], 'pending'> | 'invalid';

const closedText: Record<Closed, { title: string; body: string }> = {
  invalid: { title: '邀请链接无效', body: '请检查链接是否完整复制，或请工作区所有者重新生成一个。' },
  expired: { title: '邀请链接已过期', body: '请联系工作区所有者重新生成邀请链接。' },
  accepted: { title: '邀请链接已被使用', body: '每个邀请链接只能使用一次。如果是你本人接受的，请直接用设置好的账号登录。' },
  revoked: { title: '邀请链接已被撤销', body: '工作区所有者已撤销这个链接。如仍需加入，请联系对方重新邀请。' },
};
const closedByCode: Record<string, Closed> = {
  INVITATION_NOT_FOUND: 'invalid', INVITATION_EXPIRED: 'expired', INVITATION_USED: 'accepted', INVITATION_REVOKED: 'revoked',
};

/** `#invite=…` in the address: a well-formed token, an empty string for a malformed one, or null when there is no invitation. */
export function invitationFromLocation(hash: string): string | null {
  if (!hash.startsWith('#invite=')) return null;
  return invitationTokenFromHash(hash) ?? '';
}

export function clearInvitationFromLocation(): void {
  history.replaceState(history.state, '', location.pathname + location.search);
}

export function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const [phase, setPhase] = useState<'checking' | 'signed-in' | 'ready' | 'closed' | 'error'>('checking');
  const [lookup, setLookup] = useState<Extract<InvitationLookupResponse, { status: 'pending' }> | null>(null);
  const [closed, setClosed] = useState<Closed>('invalid');
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [problem, setProblem] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const close = (state: Closed) => { setClosed(state); setPhase('closed'); };
  const checkInvitation = useCallback(async (signal?: AbortSignal) => {
    if (!token) { setClosed('invalid'); setPhase('closed'); return; }
    try {
      const found = await invitationClient.status(token, signal);
      if (signal?.aborted) return;
      if (found.status === 'pending') { setLookup(found); setPhase('ready'); }
      else { setClosed(found.status); setPhase('closed'); }
    } catch (error) {
      if (signal?.aborted) return;
      const state = error instanceof ApiError ? closedByCode[error.code] : undefined;
      if (state) { setClosed(state); setPhase('closed'); return; }
      setProblem(message(error)); setPhase('error');
    }
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('checking');
    pageClient.session(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setSession(value); setPhase('signed-in');
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (isAuthError(error)) void checkInvitation(controller.signal);
      else { setProblem(message(error)); setPhase('error'); }
    });
    return () => controller.abort();
  }, [checkInvitation, attempt]);

  const leave = () => { clearInvitationFromLocation(); onDone(); };
  const logout = async () => {
    if (!session) return;
    setBusy(true); setProblem('');
    try {
      await pageClient.logout(session.csrfToken);
      setSession(null); setPhase('checking');
      await checkInvitation();
    } catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = loginName.trim().toLowerCase();
    if (!loginNamePattern.test(name)) { setFormError(message(new ApiError(400, 'LOGIN_NAME_INVALID'))); return; }
    if (Array.from(password).length < memberPasswordMinCharacters) { setFormError(message(new ApiError(400, 'PASSWORD_TOO_SHORT'))); return; }
    if (password !== confirm) { setFormError('两次输入的密码不一致。'); return; }
    setBusy(true); setFormError('');
    try {
      await invitationClient.accept({ token, loginName: name, password });
      // The link is spent; take it out of the address bar and the history entry before showing the workspace.
      clearInvitationFromLocation();
      onDone();
    } catch (error) {
      const state = error instanceof ApiError ? closedByCode[error.code] : undefined;
      if (state) close(state);
      else setFormError(message(error));
    } finally { setBusy(false); }
  };

  const shell = (children: ReactNode) => <div className="nb-auth"><div className="nb-login nb-invite-page">
    <span className="nb-logo">N</span>{children}</div></div>;

  if (phase === 'checking') return shell(<><h1>正在检查邀请…</h1><p role="status">请稍候。</p></>);
  if (phase === 'error') return shell(<><h1>暂时无法检查邀请</h1><p role="alert">{problem}</p>
    <div className="nb-invite-actions"><button className="nb-btn nb-btn-primary" onClick={() => setAttempt(value => value + 1)}>重试</button>
      <button className="nb-btn" onClick={leave}>返回登录页</button></div></>);
  if (phase === 'signed-in' && session) return shell(<><h1>你已登录</h1>
    <p>当前登录的账号是 <strong>{session.user.loginName}</strong>。接受邀请会创建一个新账号，需要先退出当前账号。</p>
    {problem && <p role="alert" className="nb-login-err">{problem}</p>}
    <div className="nb-invite-actions">
      <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => void logout()}>{busy ? '正在退出…' : '退出当前账号并继续'}</button>
      <button className="nb-btn" disabled={busy} onClick={leave}>返回工作区</button></div></>);
  if (phase === 'closed') return shell(<><h1>{closedText[closed].title}</h1><p role="status">{closedText[closed].body}</p>
    <div className="nb-invite-actions"><button className="nb-btn nb-btn-primary" onClick={leave}>前往登录页</button></div></>);
  if (!lookup) return null;
  return <div className="nb-auth"><form className="nb-login nb-invite-page" onSubmit={event => void submit(event)}>
    <span className="nb-logo">N</span>
    <h1>加入「{lookup.workspaceName}」</h1>
    <p>你被邀请成为<strong>{roleLabels[lookup.role]}</strong>{lookup.role === 'viewer' ? '，可以阅读、搜索、导出和收藏，不能修改内容' : '，可以新建和修改内容'}。
      链接在 {new Date(lookup.expiresAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })} 前有效，只能使用一次。</p>
    <label>账号名<input autoComplete="username" value={loginName} onChange={event => setLoginName(event.target.value)} required
      autoCapitalize="none" spellCheck={false} maxLength={64} />
      <span className="nb-field-hint">3–64 位小写字母、数字、点、下划线或连字符</span></label>
    <label>密码<span className="nb-pass-wrap"><input autoComplete="new-password" type={showPassword ? 'text' : 'password'} value={password}
      onChange={event => setPassword(event.target.value)} required />
      <button type="button" className="icon-button nb-eye" aria-label={showPassword ? '隐藏密码' : '显示密码'}
        onClick={() => setShowPassword(!showPassword)}><Icon name={showPassword ? 'close' : 'search'} size={15} /></button></span>
      <span className="nb-field-hint">至少 {memberPasswordMinCharacters} 个字符，可以用一句话</span></label>
    <label>确认密码<input autoComplete="new-password" type={showPassword ? 'text' : 'password'} value={confirm}
      onChange={event => setConfirm(event.target.value)} required /></label>
    {formError && <div className="nb-login-err" role="alert">{formError}</div>}
    <button className="nb-btn nb-btn-primary" disabled={busy} type="submit">{busy ? '正在创建账号…' : '创建账号并加入'}</button>
    <p className="nb-login-foot">账号名和密码只用于这个自部署实例</p>
  </form></div>;
}
