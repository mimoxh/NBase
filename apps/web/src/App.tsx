import { lazy, Suspense, useEffect, useState } from 'react';
import { shareFromHash } from '@nbase/contracts';
import { getHealth } from './api';
import { InvitePage, invitationFromLocation } from './persistence/InvitePage';
import { PersistentWorkspace } from './persistence/PersistentWorkspace';
import { WorkspaceApp } from './workspace/Workspace';
import './shell/shell.css';

const SharedPage = lazy(() => import('./persistence/SharedPage').then(module => ({ default: module.SharedPage })));

/** `#share=…`: the parsed link, `'invalid'` for a malformed one, or null when the address holds no share. */
function shareFromLocation(hash: string): { shareId: string; token: string } | 'invalid' | null {
  if (!hash.startsWith('#share=')) return null;
  return shareFromHash(hash) ?? 'invalid';
}

export function App() {
  const [mode, setMode] = useState<'loading' | 'demo' | 'persistent' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [invitation, setInvitation] = useState(() => invitationFromLocation(location.hash));
  const [share, setShare] = useState(() => shareFromLocation(location.hash));
  useEffect(() => {
    const read = () => { setInvitation(invitationFromLocation(location.hash)); setShare(shareFromLocation(location.hash)); };
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal).then(health => {
      if (!controller.signal.aborted) setMode(health.persistence === 'page-api' ? 'persistent' : 'demo');
    }).catch(() => { if (!controller.signal.aborted) setMode('unavailable'); });
    return () => controller.abort();
  }, [attempt]);
  if (mode === 'persistent' && share !== null) {
    const waiting = <div className="nb-gate"><main role="status">正在打开分享…</main></div>;
    if (share === 'invalid') return <div className="nb-gate"><main role="alert"><span className="nb-logo">N</span>
      <h1>分享链接无效</h1><p>请检查链接是否完整复制。</p></main></div>;
    return <Suspense fallback={waiting}><SharedPage key={`${share.shareId}.${share.token}`} shareId={share.shareId} token={share.token} /></Suspense>;
  }
  if (mode === 'persistent' && invitation !== null) return <InvitePage token={invitation} onDone={() => setInvitation(null)} />;
  if (mode === 'persistent') return <PersistentWorkspace />;
  if (mode === 'demo') return <WorkspaceApp />;
  return <div className="nb-gate"><main role="status">
    <span className="nb-logo">N</span>
    <h1>{mode === 'loading' ? '正在连接 NBase…' : '无法确认服务状态'}</h1>
    <p>{mode === 'loading' ? '请稍候。' : '请检查本机服务后重试；页面不会切换到演示数据。'}</p>
    {mode === 'unavailable' && <button className="nb-btn nb-btn-primary" onClick={() => { setMode('loading'); setAttempt(value => value + 1); }}>重新连接</button>}
  </main></div>;
}
