import { useCallback, useEffect, useRef, useState } from 'react';
import { calendarImportByteLimit, calendarSyncIntervals, type CalendarImportRequest, type CalendarImportResponse,
  type CalendarSyncSource } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import { ApiError } from '../persistence/client';
import { CaldavSection, CredentialsForm } from './CaldavSection';
import { ConflictDialog } from './ConflictDialog';
import { beginImportMutation, clearPendingImport, type PendingImportMutation } from './importMutation';
import type { WorkspaceCalendarSource } from './source';
import { countsText, intervalText, needsCredentials, requestErrorText, sourceErrorText, statusText, syncKindLabels, timeText,
  warningText } from './syncText';

const describe = (error: unknown) => requestErrorText(error, '网络不可用，响应可能未到达；请用原文件重试。');

function sourceHost(url: string): string {
  try { return new URL(url.replace(/^webcal:\/\//i, 'https://')).host; } catch { return ''; }
}

const scheduled = (item: CalendarSyncSource) => item.kind === 'ics-url' || item.kind === 'caldav';

function stopText(item: CalendarSyncSource): string {
  const kept = '停止后数据库会保留，变为普通数据库并出现在页面树中';
  if (item.kind === 'caldav') return `${kept}；同步字段变为可编辑，但不再与外部日历同步。外部日历不会被修改，保存的密码会被删除。`;
  if (item.kind === 'ics-file') return `${kept}；之后不能再向它追加导入 .ics 文件。`;
  return `${kept}；同步字段变为可编辑，但不再随订阅更新。`;
}

type Target = CalendarImportRequest['target'];

/** Import of .ics files, subscriptions and CalDAV accounts, and management of their sources. Demo workspaces get an explanation instead. */
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
  const [credentialsFor, setCredentialsFor] = useState<string | null>(null);
  const [conflictsFor, setConflictsFor] = useState<CalendarSyncSource | null>(null);
  const busyRef = useRef(false);

  const reload = useCallback(async () => {
    if (!api) return;
    try { setList((await api.list()).sources); setListError(''); }
    catch { setListError('暂时无法读取同步来源。'); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!list?.some(item => item.status === 'running')) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [list, reload]);

  if (!source.persistent || !api) {
    return <Modal title="导入与同步" onClose={onClose}>
      <p className="dialog-description">演示模式没有服务端，无法导入 .ics 文件、订阅日历或连接 CalDAV 账号。这些功能在配置数据库后的正式工作台可用。</p>
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
      setName(current => current || chosen.name.replace(/\.ics$/i, '').trim() || '导入的日历');
      // 只有一个导入库时默认追加，再次导入同一文件才能按 UID 去重。
      if (importTargets.length === 1) setChoice(importTargets[0]!.databaseId);
    } catch { setFile(null); setFileError('无法读取这个文件，请重新选择。'); }
  };

  const targetOf = (): Target => choice === 'new' ? { parentId: null, name: name.trim() } : { databaseId: choice };

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
    const finalName = subName.trim() || sourceHost(url) || '订阅日历';
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
      await api.update(item.id, { name: editName.trim() || item.name, intervalMinutes: editInterval,
        ...(item.kind === 'ics-url' && editUrl.trim() ? { url: editUrl.trim() } : {}) });
      setEditing(null);
      void reload();
    } catch (failure) { setError(describe(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const runNow = async (item: CalendarSyncSource) => {
    setError('');
    try { await api.run(item.id); void reload(); }
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

  const sourceItem = (item: CalendarSyncSource) => {
    const caldav = item.kind === 'caldav' ? item.caldav : null;
    const conflictCount = caldav?.conflictCount ?? 0;
    const passwordNeeded = needsCredentials(item);
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
        <span className="nb-wcal-sync-badge idle">{syncKindLabels[item.kind]}</span>
        {caldav && <span className={`nb-wcal-sync-badge ${caldav.writable ? 'running' : 'idle'}`}>{caldav.writable ? '双向' : '只读'}</span>}
        {(caldav?.serverHost ?? item.urlHost) && <span className="nb-wcal-sync-host">{caldav?.serverHost ?? item.urlHost}</span>}
      </div>
      {caldav && <p className="dialog-description">日历：{caldav.calendarName || '未命名日历'}
        {!caldav.writable && '（外部日历只读，只把外部的变化同步到 NBase）'}</p>}
      <p className="dialog-description">
        {scheduled(item) && item.intervalMinutes ? `${intervalText(item.intervalMinutes)} · ` : ''}
        {statusText(item)} · 上次同步：{timeText(item.lastSyncedAt, timeZone)} · 事件 {item.eventCount}
        {item.lastCounts ? `（${countsText(item.lastCounts)}）` : ''}
      </p>
      {item.lastError && <p className="dialog-description" role="alert">{sourceErrorText(item)}</p>}
      {caldav && !caldav.credentialsOk && item.lastError !== 'CREDENTIALS_UNAVAILABLE' && <p className="dialog-description" role="alert">
        保存的密码无法读取（服务端密钥已更换），请重新输入密码。</p>}
      {conflictCount > 0 && <p className="dialog-description" role="alert">有 {conflictCount} 个冲突待处理，处理前这些日程不会写回外部日历。</p>}
      {item.warnings.map(warning => <p key={warning.code} className="dialog-description">
        {warningText[warning.code]}（{warning.count} 项）</p>)}
      {credentialsFor === item.id ? <CredentialsForm api={api} source={item} onCancel={() => setCredentialsFor(null)}
        onSaved={() => { setCredentialsFor(null); void reload(); }} />
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
          {caldav && conflictCount > 0 && <button className="nb-btn nb-btn-primary" disabled={busy}
            onClick={() => setConflictsFor(item)}>处理冲突（{conflictCount}）</button>}
          {scheduled(item) && <>
            <button className="nb-btn nb-btn-quiet" disabled={busy || item.status === 'running'} onClick={() => void runNow(item)}>立即同步</button>
            <button className="nb-btn nb-btn-quiet" disabled={busy} onClick={() => {
              setEditing(item.id); setEditName(item.name); setEditInterval(item.intervalMinutes ?? 60); setEditUrl('');
            }}>编辑</button>
            {caldav && !passwordNeeded && <button className="nb-btn nb-btn-quiet" disabled={busy}
              onClick={() => setCredentialsFor(item.id)}>更新密码</button>}
          </>}
          <button className="nb-btn nb-btn-quiet" disabled={busy} onClick={() => setConfirmStop(item.id)}>停止同步</button>
        </div>}
    </>;
  };

  return <>
    <Modal title="导入与同步" variant="large" onClose={onClose}>
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
      <section className="nb-wcal-sync-section">
        <h3>同步来源</h3>
        <p className="dialog-description">导入、订阅和 CalDAV 的数据库不显示在页面树、搜索和关系图中，从这里或日历中的日程打开；停止同步后恢复为普通数据库。</p>
        {listError && <p className="dialog-description" role="alert">{listError}</p>}
        {list && !list.length && <p className="dialog-description">还没有导入、订阅或 CalDAV 账号。</p>}
        {(list ?? []).map(item => <div key={item.id} className="nb-wcal-sync-item" data-source-id={item.id}>{sourceItem(item)}</div>)}
        {error && <p className="dialog-description" role="alert">{error}</p>}
      </section>
    </Modal>
    {conflictsFor && <ConflictDialog api={api} source={conflictsFor} timeZone={timeZone}
      onOpenRow={rowId => { setConflictsFor(null); onClose(); source.openRow(rowId); }}
      onResolved={() => { onChanged(); void reload(); }} onClose={() => setConflictsFor(null)} />}
  </>;
}
