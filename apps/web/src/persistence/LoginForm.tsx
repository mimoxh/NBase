import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';

export function LoginForm({ onLogin, error, busy, title = '登录 NBase' }: {
  onLogin: (name: string, password: string) => Promise<void>; error: string; busy: boolean; title?: string;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); void onLogin(name, password); };
  return <form className="nb-login" onSubmit={submit}>
    <span className="nb-logo">N</span><h1>{title}</h1>
    <label>账号名<input autoComplete="username" value={name} onChange={event => setName(event.target.value)} required /></label>
    <label>密码<span className="nb-pass-wrap"><input autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={password}
      onChange={event => setPassword(event.target.value)} required />
      <button type="button" className="icon-button nb-eye" aria-label={showPassword ? '隐藏密码' : '显示密码'}
        onClick={() => setShowPassword(!showPassword)}><Icon name={showPassword ? 'close' : 'search'} size={15} /></button></span></label>
    {error && <div className="nb-login-err" role="alert">{error}</div>}
    <button className="nb-btn nb-btn-primary" disabled={busy} type="submit">{busy ? '正在登录…' : '登录'}</button>
    <p className="nb-login-foot">自部署实例 · 仅限已初始化账号</p>
  </form>;
}
