import { useEffect, useState } from 'react';
import { getHealth } from './api';
import { PersistentWorkspace } from './persistence/PersistentWorkspace';
import { WorkspaceApp } from './workspace/Workspace';
import './shell/shell.css';

export function App() {
  const [mode, setMode] = useState<'loading' | 'demo' | 'persistent' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal).then(health => {
      if (!controller.signal.aborted) setMode(health.persistence === 'page-api' ? 'persistent' : 'demo');
    }).catch(() => { if (!controller.signal.aborted) setMode('unavailable'); });
    return () => controller.abort();
  }, [attempt]);
  if (mode === 'persistent') return <PersistentWorkspace />;
  if (mode === 'demo') return <WorkspaceApp />;
  return <div className="nb-gate"><main role="status">
    <span className="nb-logo">N</span>
    <h1>{mode === 'loading' ? '正在连接 NBase…' : '无法确认服务状态'}</h1>
    <p>{mode === 'loading' ? '请稍候。' : '请检查本机服务后重试；页面不会切换到演示数据。'}</p>
    {mode === 'unavailable' && <button className="nb-btn nb-btn-primary" onClick={() => { setMode('loading'); setAttempt(value => value + 1); }}>重新连接</button>}
  </main></div>;
}
