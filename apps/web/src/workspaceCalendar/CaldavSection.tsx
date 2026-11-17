import { useRef, useState } from 'react';
import { calendarSyncIntervals, caldavPresets, isCalDavServerUrl, type CalDavCalendarOption, type CalendarSyncSource } from '@nbase/contracts';
import { ApiError } from '../persistence/client';
import type { CalendarSyncApi } from './source';
import { credentialsUnavailableText, intervalText, requestErrorText } from './syncText';

type PresetId = typeof caldavPresets[number]['id'] | 'custom';

export const caldavPresetHints: Record<PresetId, string> = {
  icloud: '在 Apple 账户网站（account.apple.com）生成 App 专用密码；账号是 Apple 账户的邮箱。',
  feishu: '在飞书：设置 → 日历 → CalDAV 同步 → 生成，填写生成的用户名和密码。',
  dingtalk: '在钉钉：日历设置 → CalDAV 同步 → 生成，填写生成的用户名和密码。',
  wecom: '在企业微信：日程 → 日程设置 → 同步至其他日历，填写生成的用户名和密码。',
  custom: '填写 CalDAV 服务器地址；只写主机名时按 https 连接。',
};

const colorOf = (color: string | null) => (color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined);

const isUnavailable = (error: unknown) => error instanceof ApiError && error.code === 'CREDENTIALS_UNAVAILABLE';

/**
 * Connects a CalDAV account: pick a server, sign in, choose one calendar, then create the synced database.
 * The password stays in this component's state only and is cleared after success; closing the dialog drops it.
 */
export function CaldavSection({ api, onCreated }: {
  api: CalendarSyncApi;
  onCreated: (source: CalendarSyncSource) => void;
}) {
  const [preset, setPreset] = useState<PresetId>('icloud');
  const [customUrl, setCustomUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [calendars, setCalendars] = useState<CalDavCalendarOption[] | null>(null);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [interval, setIntervalMinutes] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [lost, setLost] = useState(false);
  const busyRef = useRef(false);
  /** One id per intended source: a retry after a lost response reuses it, so the server answers from its receipt. */
  const mutation = useRef<{ id: string; key: string } | null>(null);

  const serverUrl = preset === 'custom' ? customUrl.trim() : caldavPresets.find(item => item.id === preset)!.serverUrl;
  const chosen = calendars?.find(item => item.url === selected) ?? null;
  const disabled = busy || unavailable;

  const resetDiscovery = () => { setCalendars(null); setSelected(''); setLost(false); mutation.current = null; };
  const fail = (failure: unknown) => {
    if (isUnavailable(failure)) setUnavailable(true);
    setError(requestErrorText(failure));
  };

  const connect = async () => {
    if (busyRef.current) return;
    setError(''); setDone('');
    if (!isCalDavServerUrl(serverUrl)) { setError('请填写 http(s) 开头的服务器地址或主机名。'); return; }
    if (!username.trim() || !password) { setError('请填写账号和密码。'); return; }
    busyRef.current = true; setBusy(true);
    try {
      const response = await api.discoverCaldav({ serverUrl, username: username.trim(), password });
      setCalendars(response.calendars);
      const first = response.calendars[0];
      setSelected(first?.url ?? '');
      if (!nameTouched) setName(first?.name ?? '');
      mutation.current = null;
    } catch (failure) { resetDiscovery(); fail(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const choose = (option: CalDavCalendarOption) => {
    setSelected(option.url);
    if (!nameTouched) setName(option.name);
  };

  const create = async () => {
    if (busyRef.current || !chosen) return;
    const finalName = name.trim() || chosen.name.trim() || 'CalDAV 日历';
    const body = { serverUrl, username: username.trim(), password, calendarUrl: chosen.url, name: finalName.slice(0, 100),
      parentId: null, intervalMinutes: interval };
    const key = JSON.stringify({ ...body, password: undefined });
    const attempt = mutation.current?.key === key ? mutation.current : { id: crypto.randomUUID(), key };
    mutation.current = attempt;
    setError(''); setDone('');
    busyRef.current = true; setBusy(true);
    try {
      const source = await api.createCaldav({ clientMutationId: attempt.id, ...body });
      mutation.current = null;
      setLost(false);
      setPassword(''); setUsername(''); setCalendars(null); setSelected(''); setName(''); setNameTouched(false);
      setDone(`已连接「${source.name}」，首次同步在后台进行。`);
      onCreated(source);
    } catch (failure) {
      const network = failure instanceof ApiError && failure.status === 0;
      setLost(network);
      if (!network) mutation.current = null;
      if (failure instanceof ApiError && (failure.code === 'AUTH_FAILED' || failure.code === 'CALENDAR_NOT_FOUND')) resetDiscovery();
      if (isUnavailable(failure)) setUnavailable(true);
      setError(requestErrorText(failure, '网络不可用，响应可能未到达。可以重试，不会重复创建。'));
    } finally { busyRef.current = false; setBusy(false); }
  };

  return <section className="nb-wcal-sync-section" aria-label="CalDAV 账号">
    <h3>CalDAV 账号</h3>
    <p className="dialog-description">与 iCloud、飞书、钉钉、企业微信等日历双向同步：外部的变化同步到 NBase，NBase 中的修改写回外部日历。</p>
    {unavailable && <p className="dialog-description" role="alert">{credentialsUnavailableText}</p>}
    <label className="field-label" htmlFor="nb-wcal-caldav-preset">服务器</label>
    <select id="nb-wcal-caldav-preset" className="select-field" value={preset} disabled={disabled}
      onChange={event => { setPreset(event.target.value as PresetId); resetDiscovery(); setError(''); }}>
      {caldavPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      <option value="custom">自定义</option>
    </select>
    {preset === 'custom' && <input aria-label="服务器地址" type="text" value={customUrl} disabled={disabled} maxLength={2000}
      placeholder="https://… 或主机名" autoComplete="off" spellCheck={false}
      onChange={event => { setCustomUrl(event.target.value); resetDiscovery(); }} />}
    <p className="dialog-description nb-wcal-caldav-hint">{caldavPresetHints[preset]}</p>
    <div className="nb-wcal-sub-row">
      <input aria-label="账号" type="text" value={username} disabled={disabled} maxLength={256} placeholder="账号"
        autoComplete="off" spellCheck={false} onChange={event => { setUsername(event.target.value); resetDiscovery(); }} />
      {/* Browsers ignore "off" on password fields and could fill in the NBase login password. */}
      <input aria-label="密码" type="password" value={password} disabled={disabled} maxLength={1024} placeholder="专用密码"
        autoComplete="new-password" onChange={event => { setPassword(event.target.value); resetDiscovery(); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void connect(); }} />
      <button className="nb-btn" disabled={disabled || !username.trim() || !password || (preset === 'custom' && !customUrl.trim())}
        onClick={() => void connect()}>{busy && !calendars ? '正在连接…' : '连接'}</button>
    </div>
    {calendars && !calendars.length && <p className="dialog-description" role="status">这个账号没有可同步的日历。</p>}
    {calendars && calendars.length > 0 && <>
      <fieldset className="nb-wcal-caldav-list" disabled={disabled}>
        <legend className="field-label">选择日历</legend>
        {calendars.map(option => <label key={option.url} className="nb-wcal-caldav-option">
          <input type="radio" name="nb-wcal-caldav-calendar" value={option.url} checked={selected === option.url}
            onChange={() => choose(option)} />
          <span className="nb-wcal-swatch" aria-hidden="true" style={{ background: colorOf(option.color) }} />
          <span className="nb-wcal-source-title">{option.name || '未命名日历'}</span>
          {!option.writable && <span className="nb-wcal-sync-badge">只读</span>}
        </label>)}
      </fieldset>
      {chosen && !chosen.writable && <p className="dialog-description">这个日历只读：只会把外部的变化同步到 NBase，NBase 中不能修改同步来的内容。</p>}
      <label className="field-label" htmlFor="nb-wcal-caldav-name">数据库名称</label>
      <input id="nb-wcal-caldav-name" type="text" value={name} disabled={disabled} maxLength={100}
        onChange={event => { setName(event.target.value); setNameTouched(true); }} />
      <div className="nb-wcal-sub-row">
        <select aria-label="同步间隔" className="select-field" value={interval} disabled={disabled}
          onChange={event => setIntervalMinutes(Number(event.target.value))}>
          {calendarSyncIntervals.map(minutes => <option key={minutes} value={minutes}>{intervalText(minutes)}</option>)}
        </select>
        <button className="nb-btn nb-btn-primary" disabled={disabled || !chosen} onClick={() => void create()}>
          {busy ? '正在创建…' : lost ? '重试' : '开始同步'}</button>
      </div>
    </>}
    {error && <p className="dialog-description" role="alert">{error}</p>}
    {done && <p className="dialog-description" role="status">{done}</p>}
  </section>;
}

/** Re-entering the account name and password of a CalDAV source. Nothing is kept after it closes. */
export function CredentialsForm({ api, source, onSaved, onCancel }: {
  api: CalendarSyncApi;
  source: CalendarSyncSource;
  onSaved: (source: CalendarSyncSource) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (busy || !username.trim() || !password) return;
    setBusy(true); setError('');
    try {
      const updated = await api.updateCredentials(source.id, { username: username.trim(), password });
      setPassword(''); setUsername('');
      onSaved(updated);
    } catch (failure) { setError(requestErrorText(failure)); setBusy(false); }
  };
  return <div className="nb-wcal-caldav-credentials">
    <p className="dialog-description">重新输入 {source.caldav?.serverHost ?? '服务器'} 的账号和专用密码；验证通过后才会保存，数据和对应关系不变。</p>
    <div className="nb-wcal-sub-row">
      <input aria-label="账号" type="text" value={username} disabled={busy} maxLength={256} placeholder="账号"
        autoComplete="off" spellCheck={false} onChange={event => setUsername(event.target.value)} />
      <input aria-label="密码" type="password" value={password} disabled={busy} maxLength={1024} placeholder="专用密码"
        autoComplete="new-password" onChange={event => setPassword(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save(); }} />
    </div>
    {error && <p className="dialog-description" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="nb-btn" disabled={busy} onClick={onCancel}>取消</button>
      <button className="nb-btn nb-btn-primary" disabled={busy || !username.trim() || !password} onClick={() => void save()}>
        {busy ? '正在验证…' : '保存密码'}</button>
    </div>
  </div>;
}
