import { useCallback, useEffect, useRef, useState } from 'react';
import { calendarImportByteLimit, calendarSyncIntervals, type CalendarImportRequest, type CalendarImportResponse,
  type CalendarSyncSource } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import { ApiError } from '../persistence/client';
import { databaseName } from './CalendarChoices';
import { CaldavSection, CredentialsForm } from './CaldavSection';
import { ConflictDialog } from './ConflictDialog';
import { beginImportMutation, clearPendingImport, type PendingImportMutation } from './importMutation';
import { OAuthFlowStatus, OAuthSections, useOAuthFlow } from './OAuthSection';
import type { WorkspaceCalendarSource } from './source';
import { countsText, intervalText, needsCredentials, needsReauthorization, oauthProviderOf, requestErrorText, sourceErrorText, statusText,
  syncSourceLabel, timeText, warningText } from './syncText';

const describe = (error: unknown) => requestErrorText(error, '网络不可用，响应可能未到达；请用原文件重试。');

function sourceHost(url: string): string {
  try { return new URL(url.replace(/^webcal:\/\//i, 'https://')).host; } catch { return ''; }
}

const scheduled = (item: CalendarSyncSource) => item.kind === 'ics-url' || item.kind === 'caldav';
/** How long the list keeps polling after “立即同步” queued a source. */
const runWaitMs = 30_000;

function stopText(item: CalendarSyncSource): string {
  const kept = '停止后数据库会保留，仍不显示在页面树中，可在全局日历的“来源”里选择“显示到页面树”';
  if (item.kind === 'caldav') {
    const secret = oauthProviderOf(item) ? '授权' : '密码';
    const aggregate = item.caldav?.aggregate ? '汇总到这个日历的其他数据库日程也停止同步，外部已有的事件保留。' : '';
    return `${kept}；同步字段变为可编辑，但不再与外部日历同步。外部日历不会被修改，保存的${secret}会被删除。${aggregate}`;
  }
  if (item.kind === 'ics-file') return `${kept}；之后不能再向它追加导入 .ics 文件。`;
  return `${kept}；同步字段变为可编辑，但不再随订阅更新。`;
}

function aggregateText(item: CalendarSyncSource, on: boolean, others: readonly CalendarSyncSource[]): string {
  const calendar = `「${item.caldav?.calendarName || item.name}」`;
  if (!on) return `已推送到${calendar}的其他数据库日程会从外部日历删除；NBase 里的行不变。`;
  const previous = others.find(other => other.id !== item.id && other.caldav?.aggregate);
  return `全局日历上显示的其他数据库日程（跟随“来源”里的开关）会全部写到${calendar}，之后双向同步：外部的修改写回行，外部删除的移入回收站。`
    + (previous ? `「${previous.name}」将不再是汇总日历，推送到那里的事件会被删除。` : '');
}

type Target = CalendarImportRequest['target'];

/** Import of .ics files, subscriptions and calendar accounts, and management of their sources. Demo workspaces get an explanation instead. */
export function SyncDialog({ source, timeZone, onChanged, onClose }: {
  source: WorkspaceCalendarSource;
  timeZone?: string | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const api = source.sync;
  const [list, setList] = useState<CalendarSyncSource[] | null>(null);
  const [listError, setListError] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState('');
  const [choice, setChoice] = useState('new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CalendarImportResponse | null>(null);
  const [lost, setLost] = useState<{ mutation: PendingImportMutation; target: Target } | null>(null);
  const [subUrl, setSubUrl] = useState('');
  const [subName, setSubName] = useState('');
  const [subInterval, setSubInterval] = useState<number>(60);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editInterval, setEditInterval] = useState<number>(60);
  const [editUrl, setEditUrl] = useState('');
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [confirmAggregate, setConfirmAggregate] = useState<{ id: string; on: boolean } | null>(null);
  const [credentialsFor, setCredentialsFor] = useState<string | null>(null);
  const [conflictsFor, setConflictsFor] = useState<CalendarSyncSource | null>(null);
  const [reauthorized, setReauthorized] = useState<string | null>(null);
  const [awaitingRunUntil, setAwaitingRunUntil] = useState(0);
  const busyRef = useRef(false);
  const reauth = useOAuthFlow(api);
  const reauthState = reauth.state;
  const resetReauth = reauth.reset;

  const reload = useCallback(async () => {
    if (!api) return;
    try { setList((await api.list()).sources); setListError(''); }
    catch { setListError('暂时无法读取同步来源。'); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    // A queued run is not 'running' until the scheduler claims it, and a quick run can start and finish between two
    // reloads, so neither the status nor a changed row tells whether this run is done; keep polling for a while.
    const running = list?.some(item => item.status === 'running') ?? false;
    const waitLeft = awaitingRunUntil - Date.now();
    if (!running && waitLeft <= 0) return;
    const timer = setInterval(() => void reload(), 3000);
    const stop = running ? undefined : setTimeout(() => clearInterval(timer), waitLeft);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [list, reload, awaitingRunUntil]);
  useEffect(() => {
    if (reauthState.step !== 'ready' || !reauthState.sourceId) return;
    const updated = reauthState.result.source;
    if (updated) setList(current => current?.map(item => (item.id === updated.id ? updated : item)) ?? current);
    setReauthorized(reauthState.sourceId);
    resetReauth();
    onChanged();
    void reload();
  }, [reauthState, resetReauth, onChanged, reload]);

  if (!source.persistent || !api) {
    return <Modal title="导入与同步" onClose={onClose}>
      <p className="dialog-description">演示模式没有服务端，无法导入 .ics 文件、订阅日历或连接 CalDAV 账号和 Google、Microsoft 日历。这些功能在配置数据库后的正式工作台可用。</p>
      <div className="dialog-actions"><button className="nb-btn" onClick={onClose}>关闭</button></div>
    </Modal>;
  }

  const storage = (() => { try { return localStorage; } catch { return null; } })();
  const importTargets = (list ?? []).filter(item => item.kind === 'ics-file');

  const pickFile = async (chosen: File | undefined) => {
    setFileError(''); setResult(null); setLost(null);
    if (!chosen) { setFile(null); return; }
    if (chosen.size > calendarImportByteLimit) { setFile(null); setFileError('文件超过 10 MB 上限。'); return; }
    try {
      const text = await chosen.text();
      setFile({ name: chosen.name, text });
      setName(current => current || databaseName(chosen.name.replace(/\.ics$/i, '')) || '导入的日历');
      // 只有一个导入库时默认追加，再次导入同一文件才能按 UID 去重。
      if (importTargets.length === 1) setChoice(importTargets[0]!.databaseId);
    } catch { setFile(null); setFileError('无法读取这个文件，请重新选择。'); }
  };

  const targetOf = (): Target => choice === 'new' ? { parentId: null, name: databaseName(name) } : { databaseId: choice };

  const sendImport = async (clientMutationId: string, target: Target, ics: string) => {
    setBusy(true); setError(''); setResult(null);
    busyRef.current = true;
    try {
      const response = await api.importIcs({ clientMutationId, target, ics });
      if (storage) clearPendingImport(storage);
      setLost(null);
      setResult(response);
      onChanged();
      void reload();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 0) {
        // The response may have been lost after the import ran; the retry reuses the same mutation id.
        setError(describe(failure));
      } else {
        if (storage) clearPendingImport(storage);
        setLost(null);
        setError(describe(failure));
      }
    } finally { busyRef.current = false; setBusy(false); }
  };

  const submitImport = () => {
    if (!file || busyRef.current) return;
    const target = targetOf();
    if ('name' in target && !target.name) { setError('请填写新数据库的名称。'); return; }
    const mutation = storage ? beginImportMutation(storage, target, file.name)
      : { clientMutationId: crypto.randomUUID(), target, fileName: file.name, createdAt: new Date().toISOString() };
    setLost({ mutation, target });
    void sendImport(mutation.clientMutationId, target, file.text);
  };

  const addSubscription = async () => {
    const url = subUrl.trim();
    if (!/^(https?|webcal):\/\//i.test(url)) { setError('请输入 https 或 webcal 开头的订阅网址。'); return; }
    const finalName = databaseName(subName) || sourceHost(url) || '订阅日历';
    setBusy(true); setError('');
    busyRef.current = true;
    try {
      await api.subscribe({ clientMutationId: crypto.randomUUID(), url, name: finalName, parentId: null, intervalMinutes: subInterval });
      setSubUrl(''); setSubName('');
      onChanged();
      void reload();
    } catch (failure) { setError(describe(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const saveEdit = async (item: CalendarSyncSource) => {
    setBusy(true); setError('');
    busyRef.current = true;
    try {
      await api.update(item.id, { name: databaseName(editName) || item.name, intervalMinutes: editInterval,
        ...(item.kind === 'ics-url' && editUrl.trim() ? { url: editUrl.trim() } : {}) });
      setEditing(null);
      void reload();
    } catch (failure) { setError(describe(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const runNow = async (item: CalendarSyncSource) => {
    setError('');
    try {
      await api.run(item.id);
      setAwaitingRunUntil(Date.now() + runWaitMs);
      void reload();
    }
    catch (failure) { setError(describe(failure)); }
  };

  const stopSync = async (item: CalendarSyncSource) => {
    setBusy(true); setError('');
    busyRef.current = true;
    try {
      await api.remove(item.id);
      setConfirmStop(null);
      onChanged();
      void reload();
    } catch (failure) { setError(describe(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const setAggregate = async (item: CalendarSyncSource, on: boolean) => {
    setBusy(true); setError('');
    busyRef.current = true;
    try {
      await api.update(item.id, { aggregate: on });
      setConfirmAggregate(null);
      void reload();
    } catch (failure) { setError(describe(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const sourceItem = (item: CalendarSyncSource) => {
    const caldav = item.kind === 'caldav' ? item.caldav : null;
    const oauth = oauthProviderOf(item);
    const conflictCount = caldav?.conflictCount ?? 0;
    const passwordNeeded = needsCredentials(item);
    const reauthNeeded = needsReauthorization(item);
    const host = oauth ? caldav?.account : caldav?.serverHost ?? item.urlHost;
    const reauthActive = reauthState.step !== 'idle';
    const reauthHere = reauthState.step !== 'idle' && reauthState.step !== 'ready' && reauthState.sourceId === item.id ? reauthState : null;
    if (editing === item.id) return <>
      <div className="nb-wcal-sub-row">
        <input aria-label="名称" type="text" value={editName} disabled={busy} maxLength={100}
          onChange={event => setEditName(event.target.value)} />
        <select aria-label="同步间隔" className="select-field" value={editInterval} disabled={busy}
          onChange={event => setEditInterval(Number(event.target.value))}>
          {calendarSyncIntervals.map(minutes => <option key={minutes} value={minutes}>{intervalText(minutes)}</option>)}
        </select>
      </div>
      {item.kind === 'ics-url' && <input aria-label="新的订阅网址（留空保持不变）" type="url" value={editUrl} disabled={busy} maxLength={2000}
        placeholder="新的订阅网址（留空保持不变）" onChange={event => setEditUrl(event.target.value)} />}
      <div className="dialog-actions">
        <button className="nb-btn" disabled={busy} onClick={() => setEditing(null)}>取消</button>
        <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => void saveEdit(item)}>保存</button>
      </div>
    </>;
    return <>
      <div className="nb-wcal-sync-head">
        <strong>{item.name}</strong>
        <span className="nb-wcal-sync-badge idle">{syncSourceLabel(item)}</span>
        {caldav && <span className={`nb-wcal-sync-badge ${caldav.writable ? 'running' : 'idle'}`}>{caldav.writable ? '双向' : '只读'}</span>}
        {caldav?.aggregate && <span className="nb-wcal-sync-badge running">汇总日历</span>}
        {host && <span className="nb-wcal-sync-host">{host}</span>}
      </div>
      {caldav && <p className="dialog-description">日历：{caldav.calendarName || '未命名日历'}
        {!caldav.writable && '（外部日历只读，只把外部的变化同步到 NBase）'}
        {caldav.aggregate && '；全局日历上显示的其他数据库日程也同步到这个日历'}</p>}
      <p className="dialog-description">
        {scheduled(item) && item.intervalMinutes ? `${intervalText(item.intervalMinutes)} · ` : ''}
        {statusText(item)} · 上次同步：{timeText(item.lastSyncedAt, timeZone)} · 事件 {item.eventCount}
        {item.lastCounts ? `（${countsText(item.lastCounts)}）` : ''}
      </p>
      {item.lastError && <p className="dialog-description" role="alert">{sourceErrorText(item)}</p>}
      {caldav && !caldav.credentialsOk && item.lastError !== 'CREDENTIALS_UNAVAILABLE' && <p className="dialog-description" role="alert">
        {oauth ? '保存的授权无法读取（服务端密钥已更换），请重新授权。' : '保存的密码无法读取（服务端密钥已更换），请重新输入密码。'}</p>}
      {reauthorized === item.id && <p className="dialog-description" role="status">已重新授权，正在同步。</p>}
      {conflictCount > 0 && <p className="dialog-description" role="alert">有 {conflictCount} 个冲突待处理，处理前这些日程不会写回外部日历。</p>}
      {item.warnings.map(warning => <p key={warning.code} className="dialog-description">
        {warningText[warning.code]}（{warning.count} 项）</p>)}
      {reauthHere ? <OAuthFlowStatus state={reauthHere} onRetry={reauth.retry} onCancel={reauth.reset} />
        : credentialsFor === item.id ? <CredentialsForm api={api} source={item} onCancel={() => setCredentialsFor(null)}
        onSaved={() => { setCredentialsFor(null); void reload(); }} />
        : confirmAggregate?.id === item.id ? <div className="nb-wcal-stop">
          <p className="dialog-description">{aggregateText(item, confirmAggregate.on, list ?? [])}</p>
          <div className="dialog-actions">
            <button className="nb-btn" disabled={busy} onClick={() => setConfirmAggregate(null)}>取消</button>
            <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => void setAggregate(item, confirmAggregate.on)}>
              {confirmAggregate.on ? '确认设为汇总日历' : '确认取消汇总'}</button>
          </div>
        </div>
        : confirmStop === item.id ? <div className="nb-wcal-stop">
          <p className="dialog-description">{stopText(item)}</p>
          <div className="dialog-actions">
            <button className="nb-btn" disabled={busy} onClick={() => setConfirmStop(null)}>取消</button>
            <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => void stopSync(item)}>确认停止同步</button>
          </div>
        </div> : <div className="nb-wcal-sync-actions">
          <button className="nb-btn nb-btn-quiet" onClick={() => { onClose(); source.openDatabase(item.databaseId); }}>打开数据库</button>
          {caldav && passwordNeeded && <button className="nb-btn nb-btn-primary" disabled={busy}
            onClick={() => setCredentialsFor(item.id)}>更新密码</button>}
          {oauth && reauthNeeded && <button className="nb-btn nb-btn-primary" disabled={busy || reauthActive}
            onClick={() => { setReauthorized(null); reauth.start(oauth, item.id); }}>重新授权</button>}
          {caldav && conflictCount > 0 && <button className="nb-btn nb-btn-primary" disabled={busy}
            onClick={() => setConflictsFor(item)}>处理冲突（{conflictCount}）</button>}
          {scheduled(item) && <>
            <button className="nb-btn nb-btn-quiet" disabled={busy || item.status === 'running'} onClick={() => void runNow(item)}>立即同步</button>
            <button className="nb-btn nb-btn-quiet" disabled={busy} onClick={() => {
              setEditing(item.id); setEditName(item.name); setEditInterval(item.intervalMinutes ?? 60); setEditUrl('');
            }}>编辑</button>
            {caldav && !oauth && !passwordNeeded && <button className="nb-btn nb-btn-quiet" disabled={busy}
              onClick={() => setCredentialsFor(item.id)}>更新密码</button>}
            {caldav && (caldav.writable || caldav.aggregate) && <button className="nb-btn nb-btn-quiet" disabled={busy}
              onClick={() => { setConfirmStop(null); setConfirmAggregate({ id: item.id, on: !caldav.aggregate }); }}>
              {caldav.aggregate ? '取消汇总' : '设为汇总日历'}</button>}
          </>}
          <button className="nb-btn nb-btn-quiet" disabled={busy} onClick={() => { setConfirmAggregate(null); setConfirmStop(item.id); }}>停止同步</button>
        </div>}
    </>;
  };

  return <>
    <Modal title="导入与同步" variant="large" onClose={onClose}>
      <div className="modal-scroll">
        <section className="nb-wcal-sync-section">
          <h3>导入 .ics 文件</h3>
          <p className="dialog-description">事件会写入一个数据库，按 UID 去重；再次导入同一文件不会产生重复行。</p>
          <input type="file" accept=".ics,text/calendar" aria-label="选择 .ics 文件" disabled={busy}
            onChange={event => { void pickFile(event.target.files?.[0]); event.target.value = ''; }} />
          {fileError && <p className="dialog-description" role="alert">{fileError}</p>}
          {file && <>
            <label className="field-label" htmlFor="nb-wcal-import-target">导入到</label>
            <select id="nb-wcal-import-target" className="select-field" value={choice} disabled={busy}
              onChange={event => setChoice(event.target.value)}>
              <option value="new">新建数据库</option>
              {importTargets.map(item => <option key={item.id} value={item.databaseId}>追加到「{item.name}」</option>)}
            </select>
            {choice === 'new' && <>
              <label className="field-label" htmlFor="nb-wcal-import-name">数据库名称</label>
              <input id="nb-wcal-import-name" type="text" value={name} disabled={busy} maxLength={100}
                onChange={event => setName(event.target.value)} />
            </>}
            <div className="dialog-actions">
              {lost && <button className="nb-btn" disabled={busy}
                onClick={() => void sendImport(lost.mutation.clientMutationId, lost.target, file.text)}>重试（使用同一导入标识）</button>}
              <button className="nb-btn nb-btn-primary" disabled={busy || (choice === 'new' && !name.trim())} onClick={submitImport}>
                {busy ? '正在导入…' : `导入 ${file.name}`}</button>
            </div>
          </>}
          {result && <div className="nb-wcal-import-result" role="status">
            <p>{countsText(result.counts)}</p>
            {result.warnings.map(warning => <p key={warning.code} className="dialog-description">
              {warningText[warning.code]}（{warning.count} 项）</p>)}
          </div>}
        </section>
        <section className="nb-wcal-sync-section">
          <h3>订阅日历</h3>
          <p className="dialog-description">服务端按间隔抓取订阅地址；同步来的字段只读。支持 https 和 webcal 地址。</p>
          <label className="field-label" htmlFor="nb-wcal-sub-url">订阅网址</label>
          <input id="nb-wcal-sub-url" type="url" value={subUrl} disabled={busy} placeholder="https://… 或 webcal://…" maxLength={2000}
            onChange={event => setSubUrl(event.target.value)} />
          <div className="nb-wcal-sub-row">
            <input aria-label="订阅名称" type="text" value={subName} disabled={busy} placeholder="名称（默认取主机名）" maxLength={100}
              onChange={event => setSubName(event.target.value)} />
            <select aria-label="订阅同步间隔" className="select-field" value={subInterval} disabled={busy}
              onChange={event => setSubInterval(Number(event.target.value))}>
              {calendarSyncIntervals.map(minutes => <option key={minutes} value={minutes}>{intervalText(minutes)}</option>)}
            </select>
            <button className="nb-btn nb-btn-primary" disabled={busy || !subUrl.trim()} onClick={() => void addSubscription()}>添加订阅</button>
          </div>
        </section>
        <CaldavSection api={api} onCreated={() => { onChanged(); void reload(); }} />
        <OAuthSections api={api} onCreated={() => { onChanged(); void reload(); }} />
        <section className="nb-wcal-sync-section">
          <h3>同步来源</h3>
          <p className="dialog-description">导入、订阅和日历账号的数据库不显示在页面树、搜索和关系图中，从这里或日历中的日程打开；停止同步后仍然隐藏，可在“来源”里选择“显示到页面树”。可写的日历账号可以设为汇总日历，把其他数据库的日程同步过去。</p>
          {listError && <p className="dialog-description" role="alert">{listError}</p>}
          {list && !list.length && <p className="dialog-description">还没有导入、订阅或日历账号。</p>}
          {(list ?? []).map(item => <div key={item.id} className="nb-wcal-sync-item" data-source-id={item.id}>{sourceItem(item)}</div>)}
          {error && <p className="dialog-description" role="alert">{error}</p>}
        </section>
      </div>
    </Modal>
    {conflictsFor && <ConflictDialog api={api} source={conflictsFor} timeZone={timeZone}
      onOpenRow={rowId => { setConflictsFor(null); onClose(); source.openRow(rowId); }}
      onResolved={() => { onChanged(); void reload(); }} onClose={() => setConflictsFor(null)} />}
  </>;
}
