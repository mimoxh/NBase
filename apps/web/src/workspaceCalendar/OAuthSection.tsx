import { useCallback, useEffect, useRef, useState } from 'react';
import { calendarSyncIntervals, isMicrosoftTenant, isPutGoogleOAuthAppRequest, isPutMicrosoftOAuthAppRequest, oauthFlowErrors,
  type CalendarSyncSource, type OAuthAppsResponse, type OAuthFlowError, type OAuthFlowResponse,
  type OAuthProvider, type StartOAuthResponse } from '@nbase/contracts';
import { ApiError } from '../persistence/client';
import { CalendarChoiceList, startText, useCalendarChoices } from './CalendarChoices';
import type { CalendarSyncApi } from './source';
import { connectedText, credentialsUnavailableText, flowGoneText, intervalText, oauthFlowErrorText, providerLabels,
  requestErrorText } from './syncText';

export const googlePollMs = 2000;
const clientFileByteLimit = 64 * 1024;

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : null);

/** Request errors of the OAuth endpoints; provider failures read like the flow's own errors. */
export function oauthRequestText(error: unknown): string {
  const code = codeOf(error);
  if (code && (oauthFlowErrors as readonly string[]).includes(code)) return oauthFlowErrorText[code as OAuthFlowError];
  return requestErrorText(error);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface GoogleClientFile { kind: 'web' | 'installed'; clientId: string; clientSecret: string; redirectUris: string[] }

/** Reads the client JSON Google offers for download; null when it is not one. */
export function parseGoogleClientJson(text: string): GoogleClientFile | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isRecord(data)) return null;
  for (const kind of ['web', 'installed'] as const) {
    const entry = data[kind];
    if (!isRecord(entry)) continue;
    const clientId = typeof entry.client_id === 'string' ? entry.client_id.trim() : '';
    const clientSecret = typeof entry.client_secret === 'string' ? entry.client_secret.trim() : '';
    if (!isPutGoogleOAuthAppRequest({ clientId, clientSecret })) return null;
    const redirectUris = Array.isArray(entry.redirect_uris) ? entry.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
    return { kind, clientId, clientSecret, redirectUris };
  }
  return null;
}

/** Google refuses plain-http redirect URIs except on the loopback host. */
export function redirectUriAccepted(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setState('done'); } catch { setState('failed'); }
  };
  return <button type="button" className="nb-btn nb-btn-quiet" onClick={() => void copy()}>
    {state === 'done' ? '已复制' : state === 'failed' ? '复制失败，请手动复制' : label}</button>;
}

const ExternalLink = ({ href, children, className }: { href: string; children: string; className?: string }) =>
  <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;

// ---------------------------------------------------------------------------------------------------------
// Flow

interface FlowBase { provider: OAuthProvider; sourceId: string | null }
export type OAuthFlowState =
  | { step: 'idle' }
  | FlowBase & { step: 'starting' }
  | FlowBase & { step: 'pending'; started: StartOAuthResponse; tabBlocked: boolean }
  | FlowBase & { step: 'ready'; flowId: string; result: OAuthFlowResponse }
  | FlowBase & { step: 'failed'; message: string; code: string | null };

function openBlankTab(): Window | null {
  try { return window.open('', '_blank') ?? null; } catch { return null; }
}

function sendTab(tab: Window | null, url: string): boolean {
  if (!tab || tab.closed) return false;
  try {
    // The provider page must not reach back into NBase through window.opener.
    tab.opener = null;
    tab.location.replace(url);
    return true;
  } catch { return false; }
}

const transient = (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status >= 500);

/**
 * Starts an authorization and polls it until it is ready, fails or is cancelled. `start` must run inside the click
 * handler: for Google it opens the tab before any await, so popup blockers let it through.
 */
export function useOAuthFlow(api: CalendarSyncApi | undefined) {
  const [state, setState] = useState<OAuthFlowState>({ step: 'idle' });
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const last = useRef<FlowBase | null>(null);

  const stop = useCallback(() => {
    run.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback((provider: OAuthProvider, sourceId: string | null = null) => {
    if (!api) return;
    stop();
    const id = run.current;
    const base: FlowBase = { provider, sourceId };
    last.current = base;
    const tab = provider === 'google' ? openBlankTab() : null;
    const current = () => id === run.current;
    const fail = (message: string, code: string | null) => { if (current()) setState({ ...base, step: 'failed', message, code }); };
    setState({ ...base, step: 'starting' });
    void (async () => {
      let started: StartOAuthResponse;
      try { started = await api.startOAuth(sourceId ? { provider, sourceId } : { provider }); }
      catch (failure) {
        tab?.close();
        fail(oauthRequestText(failure), codeOf(failure));
        return;
      }
      if (!current()) { tab?.close(); return; }
      const tabBlocked = started.provider === 'google' ? !sendTab(tab, started.authorizeUrl) : false;
      setState({ ...base, step: 'pending', started, tabBlocked });
      const delay = started.provider === 'microsoft' ? Math.max(1, started.intervalSeconds) * 1000 : googlePollMs;
      const expires = Date.parse(started.expiresAt);
      const poll = async () => {
        timer.current = null;
        if (!current()) return;
        if (Date.now() >= expires) { fail(oauthFlowErrorText.OAUTH_EXPIRED, 'OAUTH_EXPIRED'); return; }
        const controller = new AbortController();
        inFlight.current = controller;
        try {
          const result = await api.oauthFlow(started.flowId, controller.signal);
          if (!current()) return;
          if (result.status === 'ready') { setState({ ...base, step: 'ready', flowId: started.flowId, result }); return; }
          if (result.status === 'failed') {
            const code = result.error ?? 'OAUTH_FAILED';
            fail(oauthFlowErrorText[code], code);
            return;
          }
        } catch (failure) {
          if (!current()) return;
          if (failure instanceof ApiError && failure.status === 404) { fail(flowGoneText, 'NOT_FOUND'); return; }
          if (!transient(failure)) { fail(requestErrorText(failure), codeOf(failure)); return; }
        } finally { if (inFlight.current === controller) inFlight.current = null; }
        if (current()) timer.current = setTimeout(() => void poll(), delay);
      };
      timer.current = setTimeout(() => void poll(), delay);
    })();
  }, [api, stop]);

  const reset = useCallback(() => { stop(); setState({ step: 'idle' }); }, [stop]);
  const retry = useCallback(() => { if (last.current) start(last.current.provider, last.current.sourceId); }, [start]);
  return { state, start, reset, retry };
}

/** Waiting and failure states of a flow; the ready state is shown by the caller. */
export function OAuthFlowStatus({ state, onRetry, onCancel }: {
  state: Exclude<OAuthFlowState, { step: 'idle' } | { step: 'ready' }>;
  onRetry: () => void;
  onCancel: () => void;
}) {
  if (state.step === 'starting') return <div className="nb-wcal-oauth-flow">
    <p className="dialog-description" role="status">正在连接…</p>
    <div className="nb-wcal-sync-actions"><button className="nb-btn" onClick={onCancel}>取消</button></div>
  </div>;
  if (state.step === 'failed') return <div className="nb-wcal-oauth-flow">
    <p className="dialog-description" role="alert">{state.message}</p>
    <div className="nb-wcal-sync-actions">
      <button className="nb-btn" onClick={onCancel}>取消</button>
      <button className="nb-btn nb-btn-primary" onClick={onRetry}>重试</button>
    </div>
  </div>;
  const { started } = state;
  if (started.provider === 'microsoft') return <div className="nb-wcal-oauth-flow">
    <div className="nb-wcal-oauth-code-row">
      <code className="nb-wcal-oauth-code" aria-label="登录代码">{started.userCode}</code>
      <CopyButton value={started.userCode} label="复制代码" />
    </div>
    <p className="dialog-description">打开微软登录页，输入上面的代码并登录。</p>
    <p className="dialog-description" role="status">正在等待登录…</p>
    <div className="nb-wcal-sync-actions">
      <ExternalLink className="nb-btn nb-btn-primary" href={started.verificationUri}>打开微软登录页</ExternalLink>
      <button className="nb-btn" onClick={onCancel}>取消</button>
    </div>
  </div>;
  return <div className="nb-wcal-oauth-flow">
    {state.tabBlocked
      ? <p className="dialog-description" role="status">浏览器拦截了新标签页，请点“打开授权页”完成授权。</p>
      : <p className="dialog-description" role="status">请在新标签页里完成授权…</p>}
    <div className="nb-wcal-sync-actions">
      <ExternalLink className={`nb-btn${state.tabBlocked ? ' nb-btn-primary' : ' nb-btn-quiet'}`} href={started.authorizeUrl}>
        {state.tabBlocked ? '打开授权页' : '重新打开授权页'}</ExternalLink>
      <button className="nb-btn" onClick={onCancel}>取消</button>
    </div>
  </div>;
}

/** Ready new-source flow: pick calendars, name their databases and start syncing. */
function OAuthCalendarPicker({ api, provider, flowId, result, onCreated, onCancel, onUnavailable }: {
  api: CalendarSyncApi;
  provider: OAuthProvider;
  flowId: string;
  result: OAuthFlowResponse;
  onCreated: (sources: CalendarSyncSource[]) => void;
  onCancel: () => void;
  onUnavailable: () => void;
}) {
  const calendars = result.calendars;
  const choices = useCalendarChoices(`${providerLabels[provider]} 日历`, calendars);
  const [interval, setIntervalMinutes] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lost, setLost] = useState(false);
  const busyRef = useRef(false);
  const mutation = useRef<{ id: string; key: string } | null>(null);
  const ready = choices.chosen.length > 0 && !choices.tooMany;

  const create = async () => {
    if (busyRef.current || !ready) return;
    const body = { flowId, calendars: choices.choices, intervalMinutes: interval };
    const key = JSON.stringify(body);
    const attempt = mutation.current?.key === key ? mutation.current : { id: crypto.randomUUID(), key };
    mutation.current = attempt;
    setError('');
    busyRef.current = true; setBusy(true);
    try {
      const { sources } = await api.createOAuthSource({ clientMutationId: attempt.id, ...body });
      mutation.current = null;
      onCreated(sources);
    } catch (failure) {
      const network = failure instanceof ApiError && failure.status === 0;
      setLost(network);
      if (!network) mutation.current = null;
      if (codeOf(failure) === 'CREDENTIALS_UNAVAILABLE') onUnavailable();
      setError(failure instanceof ApiError && failure.status === 404 ? flowGoneText
        : requestErrorText(failure, '网络不可用，响应可能未到达。可以重试，不会重复创建。'));
    } finally { busyRef.current = false; setBusy(false); }
  };

  return <div className="nb-wcal-oauth-flow">
    {result.account && <p className="dialog-description nb-wcal-oauth-account">已登录：{result.account}</p>}
    {!calendars.length ? <p className="dialog-description" role="status">这个账号没有可同步的日历。</p> : <>
      <CalendarChoiceList choices={choices} disabled={busy} />
      <div className="nb-wcal-sub-row">
        <select aria-label="同步间隔" className="select-field" value={interval} disabled={busy}
          onChange={event => setIntervalMinutes(Number(event.target.value))}>
          {calendarSyncIntervals.map(minutes => <option key={minutes} value={minutes}>{intervalText(minutes)}</option>)}
        </select>
        <button className="nb-btn" disabled={busy} onClick={onCancel}>取消</button>
        <button className="nb-btn nb-btn-primary" disabled={busy || !ready} onClick={() => void create()}>
          {busy ? '正在创建…' : lost ? '重试' : startText(choices.chosen.length)}</button>
      </div>
    </>}
    {!calendars.length && <div className="nb-wcal-sync-actions"><button className="nb-btn" onClick={onCancel}>返回</button></div>}
    {error && <p className="dialog-description" role="alert">{error}</p>}
  </div>;
}

// ---------------------------------------------------------------------------------------------------------
// App setup

type AppsChange = (apps: OAuthAppsResponse) => void;

function GoogleAppForm({ api, redirectUri, initialClientId, disabled, onSaved, onCancel, onUnavailable }: {
  api: CalendarSyncApi;
  redirectUri: string;
  initialClientId: string;
  disabled: boolean;
  onSaved: AppsChange;
  onCancel?: (() => void) | undefined;
  onUnavailable: () => void;
}) {
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState('');
  const [fileNote, setFileNote] = useState('');
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const off = disabled || busy;

  const readFile = async (file: File | undefined) => {
    setError(''); setFileNote(''); setWarning('');
    if (!file) return;
    let parsed: GoogleClientFile | null = null;
    if (file.size <= clientFileByteLimit) {
      try { parsed = parseGoogleClientJson(await file.text()); } catch { parsed = null; }
    }
    if (!parsed) { setError('这不是 Google 的客户端 JSON 文件。请在“客户端”页面下载 OAuth 客户端的 JSON 后重新上传，或手动填写。'); return; }
    setClientId(parsed.clientId);
    setClientSecret(parsed.clientSecret);
    setFileNote(`已读取 ${file.name}，确认后点“保存应用”。`);
    if (parsed.kind === 'web' && !parsed.redirectUris.includes(redirectUri)) {
      setWarning(`这个客户端的“已获授权的重定向 URI”里没有 ${redirectUri}，授权会失败。请在 Google Cloud 控制台添加后再连接。`);
    }
  };

  const save = async () => {
    if (off) return;
    const body = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
    if (!body.clientId || !body.clientSecret) { setError('请填写客户端 ID 和客户端密钥。'); return; }
    if (!isPutGoogleOAuthAppRequest(body)) { setError('客户端 ID 或客户端密钥格式不对，请检查是否完整复制。'); return; }
    setBusy(true); setError('');
    try {
      const apps = await api.putGoogleApp(body);
      setClientSecret('');
      onSaved(apps);
    } catch (failure) {
      if (codeOf(failure) === 'CREDENTIALS_UNAVAILABLE') onUnavailable();
      setError(requestErrorText(failure));
    } finally { setBusy(false); }
  };

  return <div className="nb-wcal-oauth-setup">
    <ol className="nb-wcal-oauth-steps">
      <li>打开 Google Cloud 控制台（<ExternalLink href="https://console.cloud.google.com/">console.cloud.google.com</ExternalLink>），新建项目。</li>
      <li>在“API 和服务 → 库”里启用“CalDAV API”和“Google Calendar API”。</li>
      <li>在“Google Auth Platform”（OAuth 同意屏幕）里选“外部”，填应用名称和邮箱，然后在“目标对象”里点“发布应用”（测试状态下授权 7 天后失效）。</li>
      <li>在“客户端”里创建“Web 应用”类型的客户端，“已获授权的重定向 URI”填下面的回调地址：
        <div className="nb-wcal-oauth-uri">
          <code>{redirectUri}</code>
          <CopyButton value={redirectUri} label="复制回调地址" />
        </div>
      </li>
      <li>下载客户端 JSON 上传，或手动填写客户端 ID 和客户端密钥。</li>
    </ol>
    {!redirectUriAccepted(redirectUri) && <p className="dialog-description" role="alert">
      这个回调地址既不是 https，也不是 localhost / 127.0.0.1，Google 不会接受。请把服务端的 NBASE_PUBLIC_ORIGIN 设为 https 地址。</p>}
    <p className="dialog-description">授权时 Google 会提示“Google 尚未验证此应用”，这是你自己注册的应用，点“高级”后继续即可。回调地址必须是 https，或者 localhost / 127.0.0.1（局域网 IP 的 http 地址 Google 不接受）。</p>
    <label className="field-label" htmlFor="nb-wcal-google-file">上传客户端 JSON</label>
    <input id="nb-wcal-google-file" type="file" accept=".json,application/json" aria-label="上传客户端 JSON" disabled={off}
      onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
    {fileNote && <p className="dialog-description" role="status">{fileNote}</p>}
    {warning && <p className="dialog-description nb-wcal-oauth-warning" role="status">{warning}</p>}
    <div className="nb-wcal-sub-row">
      <input aria-label="客户端 ID" type="text" value={clientId} disabled={off} maxLength={256} placeholder="客户端 ID"
        autoComplete="off" spellCheck={false} onChange={event => setClientId(event.target.value)} />
      <input aria-label="客户端密钥" type="password" value={clientSecret} disabled={off} maxLength={256} placeholder="客户端密钥"
        autoComplete="new-password" onChange={event => setClientSecret(event.target.value)} />
    </div>
    {error && <p className="dialog-description" role="alert">{error}</p>}
    <div className="nb-wcal-sync-actions">
      {onCancel && <button className="nb-btn" disabled={busy} onClick={onCancel}>取消</button>}
      <button className="nb-btn nb-btn-primary" disabled={off || !clientId.trim() || !clientSecret.trim()} onClick={() => void save()}>
        {busy ? '正在保存…' : '保存应用'}</button>
    </div>
  </div>;
}

function MicrosoftAppForm({ api, initial, disabled, onSaved, onCancel, onUnavailable }: {
  api: CalendarSyncApi;
  initial: { clientId: string; tenant: string };
  disabled: boolean;
  onSaved: AppsChange;
  onCancel?: (() => void) | undefined;
  onUnavailable: () => void;
}) {
  const [clientId, setClientId] = useState(initial.clientId);
  const [tenant, setTenant] = useState(initial.tenant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const off = disabled || busy;

  const save = async () => {
    if (off) return;
    const body = { clientId: clientId.trim(), tenant: tenant.trim() || 'common' };
    if (!isPutMicrosoftOAuthAppRequest({ clientId: body.clientId, tenant: 'common' })) {
      setError('客户端 ID 格式不对，应为 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx。'); return;
    }
    if (!isMicrosoftTenant(body.tenant)) { setError('租户格式不对：填 common、consumers、organizations、租户 ID 或域名。'); return; }
    setBusy(true); setError('');
    try { onSaved(await api.putMicrosoftApp(body)); }
    catch (failure) {
      if (codeOf(failure) === 'CREDENTIALS_UNAVAILABLE') onUnavailable();
      setError(requestErrorText(failure));
    } finally { setBusy(false); }
  };

  return <div className="nb-wcal-oauth-setup">
    <ol className="nb-wcal-oauth-steps">
      <li>打开 Microsoft Entra 管理中心（<ExternalLink href="https://entra.microsoft.com/">entra.microsoft.com</ExternalLink>）→“应用注册”→“新注册”，账户类型选“任何组织目录中的帐户和个人 Microsoft 帐户”，重定向 URI 留空。</li>
      <li>在“身份验证”里把“允许公共客户端流”设为“是”。</li>
      <li>在“API 权限”里添加 Microsoft Graph 委托权限 Calendars.ReadWrite。</li>
      <li>复制“应用程序(客户端) ID”填到下面。</li>
    </ol>
    <p className="dialog-description">注册应用需要一个 Azure 账户，可以免费申请。</p>
    <label className="field-label" htmlFor="nb-wcal-microsoft-client">客户端 ID</label>
    <input id="nb-wcal-microsoft-client" type="text" value={clientId} disabled={off} maxLength={36}
      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autoComplete="off" spellCheck={false}
      onChange={event => setClientId(event.target.value)} />
    <label className="field-label" htmlFor="nb-wcal-microsoft-tenant">租户</label>
    <input id="nb-wcal-microsoft-tenant" type="text" value={tenant} disabled={off} maxLength={253} placeholder="common"
      autoComplete="off" spellCheck={false} onChange={event => setTenant(event.target.value)} />
    <p className="dialog-description nb-wcal-caldav-hint">默认 common。只用个人账号可填 consumers；单位账号可填租户 ID 或域名。</p>
    {error && <p className="dialog-description" role="alert">{error}</p>}
    <div className="nb-wcal-sync-actions">
      {onCancel && <button className="nb-btn" disabled={busy} onClick={onCancel}>取消</button>}
      <button className="nb-btn nb-btn-primary" disabled={off || !clientId.trim()} onClick={() => void save()}>
        {busy ? '正在保存…' : '保存应用'}</button>
    </div>
  </div>;
}

// ---------------------------------------------------------------------------------------------------------
// Sections

const staleSecretText = '保存的客户端密钥无法读取（服务端凭据密钥已更换），请重新上传客户端 JSON 或填写客户端密钥。';

const intros: Record<OAuthProvider, string> = {
  google: '用你自己在 Google Cloud 注册的应用授权，与 Google 日历双向同步。',
  microsoft: '用你自己在 Microsoft Entra 注册的应用授权，与 Outlook / Microsoft 365 日历双向同步。',
};

function ProviderSection({ api, provider, apps, loadError, unavailable, onApps, onRemoved, onReload, onUnavailable, onCreated }: {
  api: CalendarSyncApi;
  provider: OAuthProvider;
  apps: OAuthAppsResponse | null;
  loadError: string;
  unavailable: boolean;
  onApps: AppsChange;
  onRemoved: (provider: OAuthProvider) => void;
  onReload: () => void;
  onUnavailable: () => void;
  onCreated: (sources: CalendarSyncSource[]) => void;
}) {
  const flow = useOAuthFlow(api);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const label = providerLabels[provider];
  const app = apps?.[provider] ?? null;
  const stale = provider === 'google' && !!apps?.google?.secretUnavailable;
  const flowState = flow.state;
  const active = flowState.step !== 'idle';

  useEffect(() => {
    if (flowState.step !== 'failed') return;
    if (flowState.code === 'CREDENTIALS_UNAVAILABLE') onUnavailable();
    if (flowState.code === 'OAUTH_APP_MISSING') onReload();
  }, [flowState, onReload, onUnavailable]);

  const saved: AppsChange = next => { setEditing(false); setError(''); onApps(next); };

  const removeApp = async () => {
    if (!apps || busy) return;
    setBusy(true); setError(''); setDone('');
    try {
      await api.deleteOAuthApp(provider);
      flow.reset();
      onRemoved(provider);
    } catch (failure) { setError(requestErrorText(failure)); }
    finally { setBusy(false); }
  };

  const connect = () => {
    setError(''); setDone('');
    flow.start(provider);
  };

  const created = (sources: CalendarSyncSource[]) => {
    flow.reset();
    setDone(connectedText(sources));
    onCreated(sources);
  };

  const body = () => {
    if (!apps) return unavailable ? null : loadError
      ? <><p className="dialog-description" role="alert">{loadError}</p>
        <div className="nb-wcal-sync-actions"><button className="nb-btn" onClick={onReload}>重试</button></div></>
      : <p className="dialog-description" role="status">正在读取应用设置…</p>;
    if (!app || editing || stale) {
      const cancel = app && !stale ? () => setEditing(false) : undefined;
      return provider === 'google'
        ? <>{stale && <p className="dialog-description" role="alert">{staleSecretText}</p>}<GoogleAppForm api={api} redirectUri={apps.googleRedirectUri} initialClientId={apps.google?.clientId ?? ''}
          disabled={unavailable} onSaved={saved} onCancel={cancel} onUnavailable={onUnavailable} /></>
        : <MicrosoftAppForm api={api} initial={apps.microsoft ?? { clientId: '', tenant: 'common' }} disabled={unavailable}
          onSaved={saved} onCancel={cancel} onUnavailable={onUnavailable} />;
    }
    return <>
      <div className="nb-wcal-oauth-app">
        <span className="nb-wcal-oauth-app-id">客户端 ID：<code>{app.clientId}</code></span>
        {apps.microsoft && provider === 'microsoft' && <span>租户：<code>{apps.microsoft.tenant}</code></span>}
        <button className="nb-btn nb-btn-quiet" disabled={busy || active} onClick={() => { setDone(''); setEditing(true); }}>更换应用</button>
        <button className="nb-btn nb-btn-quiet" disabled={busy || active} onClick={() => void removeApp()}>删除应用</button>
      </div>
      {flowState.step === 'idle'
        ? <div className="nb-wcal-sync-actions">
          <button className="nb-btn nb-btn-primary" disabled={busy || unavailable} onClick={connect}>连接 {label} 账号</button>
        </div>
        : flowState.step === 'ready'
          ? <OAuthCalendarPicker api={api} provider={provider} flowId={flowState.flowId} result={flowState.result}
            onCreated={created} onCancel={flow.reset} onUnavailable={onUnavailable} />
          : <OAuthFlowStatus state={flowState} onRetry={flow.retry} onCancel={flow.reset} />}
    </>;
  };

  return <section className="nb-wcal-sync-section" aria-label={`${label} 日历`}>
    <h3>{label} 日历</h3>
    <p className="dialog-description">{intros[provider]}</p>
    {unavailable && <p className="dialog-description" role="alert">{credentialsUnavailableText}</p>}
    {body()}
    {error && <p className="dialog-description" role="alert">{error}</p>}
    {done && <p className="dialog-description" role="status">{done}</p>}
  </section>;
}

/**
 * Google and Microsoft accounts through the workspace's own OAuth apps. The apps are read once for both
 * sections; tokens never reach the browser.
 */
export function OAuthSections({ api, onCreated }: {
  api: CalendarSyncApi;
  onCreated: (sources: CalendarSyncSource[]) => void;
}) {
  const [apps, setApps] = useState<OAuthAppsResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError('');
    try {
      const next = await api.oauthApps(signal);
      if (!signal?.aborted) setApps(next);
    } catch (failure) {
      if (signal?.aborted) return;
      if (codeOf(failure) === 'CREDENTIALS_UNAVAILABLE') { setUnavailable(true); return; }
      setLoadError(`暂时无法读取应用设置：${requestErrorText(failure)}`);
    }
  }, [api]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const reload = useCallback(() => { void load(); }, [load]);
  const markUnavailable = useCallback(() => setUnavailable(true), []);
  const removed = useCallback((provider: OAuthProvider) => setApps(current => current && { ...current, [provider]: null }), []);

  return <>
    {(['google', 'microsoft'] as const).map(provider => <ProviderSection key={provider} api={api} provider={provider} apps={apps}
      loadError={loadError} unavailable={unavailable} onApps={setApps} onRemoved={removed} onReload={reload} onUnavailable={markUnavailable}
      onCreated={onCreated} />)}
  </>;
}
