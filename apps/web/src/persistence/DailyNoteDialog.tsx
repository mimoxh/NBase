import { quickCaptureLimit, type DailyNoteSettings, type DailyNoteSettingsRequest, type DailyNoteStatus,
  type NoteTemplate, type OpenDailyNoteRequest, type PageSummary, type QuickCaptureRequest } from '@nbase/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../components/Modal';
import { ApiError, request, workspacePath } from './client';

export const dailyClient = {
  status: (workspaceId: string, date?: string, signal?: AbortSignal) =>
    request<DailyNoteStatus>(workspacePath(workspaceId) + '/daily-note' + (date ? '?date=' + encodeURIComponent(date) : ''),
      'GET', undefined, undefined, signal),
  updateSettings: (workspaceId: string, body: DailyNoteSettingsRequest, csrfToken: string) =>
    request<DailyNoteSettings>(workspacePath(workspaceId) + '/daily-note/settings', 'PUT', body, csrfToken),
};

type DailyMode = 'today' | 'quick-capture' | 'settings';

interface Props {
  workspaceId: string;
  mode: DailyMode;
  templates: readonly Pick<NoteTemplate, 'id' | 'name'>[];
  parents: readonly Pick<PageSummary, 'id' | 'title'>[];
  readOnly?: boolean;
  onClose: () => void;
  onOpenPage: (id: string) => void | Promise<void>;
  onRestorePage: (id: string) => void;
  onCreate: (input: Omit<OpenDailyNoteRequest, 'clientMutationId'>) => Promise<void>;
  onCapture: (input: Omit<QuickCaptureRequest, 'clientMutationId'>, page: DailyNoteStatus['page']) => Promise<void>;
  onSaveSettings: (input: DailyNoteSettings) => Promise<void>;
}

const descriptions: Record<string, string> = {
  DAILY_NOTE_TRASHED: '该日期的笔记在回收站，请先恢复。',
  DAILY_PARENT_UNAVAILABLE: '默认父页不可用，请恢复父页或在每日笔记设置中重新选择。',
  DAILY_TEMPLATE_ATTACHMENTS_MISSING: '所选模板包含缺失的附件，请检查模板或选择空白笔记。',
  REVISION_CONFLICT: '每日笔记已有新修订。记录文字已保留，请重试。',
  INVALID_REQUEST: '日期、时区或记录内容无效，请检查输入。',
  TIMEOUT: '请求超时，可重试。',
  NETWORK_UNAVAILABLE: '网络暂不可用，可重试。',
  FORBIDDEN: '当前账号没有执行此操作的权限。',
  NOT_FOUND: '所选页面或模板不可用，请重新选择。',
};

function describe(error: unknown): string {
  if (error instanceof ApiError) return descriptions[error.code] ?? '操作失败，请重试。';
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

function dateInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory', numberingSystem: 'latn',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  return [part('year').padStart(4, '0'), part('month'), part('day')].join('-');
}

export function DailyNoteDialog({
  workspaceId, mode, templates, parents, readOnly, onClose, onOpenPage, onRestorePage, onCreate, onCapture, onSaveSettings,
}: Props) {
  const [date, setDate] = useState('');
  const [template, setTemplate] = useState('');
  const [status, setStatus] = useState<DailyNoteStatus | null>(null);
  const [settings, setSettings] = useState<DailyNoteSettings | null>(null);
  const [text, setText] = useState('');
  const [pinnedDate, setPinnedDate] = useState<string>();
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadFailed(false);
    setError('');
    void dailyClient.status(workspaceId, mode === 'today' && date ? date : undefined, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setStatus(result);
        setSettings(result.settings);
      }).catch(reason => {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
          setError(describe(reason));
        }
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, mode, date, reload]);

  const length = [...text].length;
  const selectedPage = mode !== 'settings' && !loading && !loadFailed && status
    && (mode !== 'today' || !date || status.date === date) ? status.page : null;
  const targetDate = pinnedDate ?? status?.date;
  const close = () => { if (!busyRef.current) onClose(); };
  const disabled = busy || loading || loadFailed || !status
    || (mode === 'today' && (Boolean(date && status.date !== date) || Boolean(readOnly && !selectedPage) || Boolean(selectedPage?.deleted)))
    || (mode === 'quick-capture' && (readOnly || !text.trim() || length > quickCaptureLimit || Boolean(selectedPage?.deleted)))
    || (mode === 'settings' && (readOnly || !settings?.timeZone.trim()));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || busyRef.current || !status) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      if (mode === 'settings' && settings) {
        await onSaveSettings({ ...settings, timeZone: settings.timeZone.trim() });
        onClose();
      } else if (mode === 'today') {
        if (selectedPage) await onOpenPage(selectedPage.id);
        else await onCreate({ date: status.date, ...(template ? { templateId: template === 'blank' ? null : template } : {}) });
        onClose();
      } else if (mode === 'quick-capture') {
        const requestedDate = pinnedDate ?? dateInZone(status.settings.timeZone);
        const current = await dailyClient.status(workspaceId, pinnedDate).catch(reason => {
          if (reason instanceof ApiError && (reason.status === 0 || reason.status >= 500)) {
            return { ...status, date: requestedDate, page: status.date === requestedDate ? status.page : null };
          }
          throw reason;
        });
        setStatus(current);
        setPinnedDate(current.date);
        if (current.page?.deleted) throw new ApiError(409, 'DAILY_NOTE_TRASHED');
        await onCapture({ date: current.date, text,
          ...(current.page ? { expectedRevision: current.page.revision } : {}) }, current.page);
        setText('');
        setPinnedDate(undefined);
        setSuccess('已记录到 ' + current.date + '。');
      }
    } catch (reason) {
      setError(describe(reason));
      if (reason instanceof ApiError && reason.code === 'DAILY_NOTE_TRASHED' && mode === 'today') {
        void dailyClient.status(workspaceId, status.date).then(setStatus).catch(() => {});
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const heading = mode === 'today' ? '每日笔记' : mode === 'quick-capture' ? '快速记录' : '每日笔记设置';
  const action = mode === 'today' ? (selectedPage ? '打开笔记' : '创建笔记') : mode === 'settings' ? '保存设置' : '记录';
  return <Modal title={heading} onClose={close}>
    <form onSubmit={event => void submit(event)}>
      {mode === 'today' && <>
        <label className="field-label" htmlFor="daily-note-date">日期</label>
        <input className="select-field" id="daily-note-date" type="date" value={date || status?.date || ''}
          onChange={event => setDate(event.target.value)} disabled={busy} />
        {status && <p className="dialog-description">工作区时区 {status.settings.timeZone} · 今天 {status.today}</p>}
        {status && !selectedPage && !readOnly && <>
          <label className="field-label" htmlFor="daily-note-template">创建模板</label>
          <select className="select-field" id="daily-note-template" value={template} onChange={event => setTemplate(event.target.value)} disabled={busy}>
            <option value="">工作区默认模板</option>
            <option value="blank">空白页</option>
            {templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </>}
        {readOnly && !selectedPage && status && <p className="dialog-description">该日期没有可打开的笔记。</p>}
      </>}
      {mode === 'quick-capture' && <>
        {targetDate && <p className="dialog-description">记录日期 {targetDate} · 随手记</p>}
        <label className="field-label" htmlFor="daily-quick-text">纯文本记录</label>
        <textarea id="daily-quick-text" rows={5} value={text} disabled={busy || readOnly} onChange={event => setText(event.target.value)} />
        <p className="dialog-description">{length} / {quickCaptureLimit} 字</p>
      </>}
      {mode === 'settings' && settings && <>
        <label className="field-label" htmlFor="daily-note-zone">时区（IANA）</label>
        <input id="daily-note-zone" type="text" value={settings.timeZone} placeholder="Asia/Shanghai" maxLength={100}
          disabled={busy || readOnly} onChange={event => setSettings({ ...settings, timeZone: event.target.value })} />
        <label className="field-label" htmlFor="daily-note-parent">默认父页</label>
        <select className="select-field" id="daily-note-parent" value={settings.parentId ?? ''} disabled={busy || readOnly}
          onChange={event => setSettings({ ...settings, parentId: event.target.value || null })}>
          <option value="">工作区根目录</option>
          {settings.parentId && !parents.some(page => page.id === settings.parentId) &&
            <option value={settings.parentId}>当前父页不可用</option>}
          {parents.map(page => <option key={page.id} value={page.id}>{page.title || '未命名页面'}</option>)}
        </select>
        <label className="field-label" htmlFor="daily-note-default-template">默认模板</label>
        <select className="select-field" id="daily-note-default-template" value={settings.templateId ?? ''} disabled={busy || readOnly}
          onChange={event => setSettings({ ...settings, templateId: event.target.value || null })}>
          <option value="">空白页</option>
          {settings.templateId && !templates.some(item => item.id === settings.templateId) &&
            <option value={settings.templateId}>当前模板不可用</option>}
          {templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </>}
      {loading && <p role="status" className="dialog-description">正在查找每日笔记…</p>}
      {busy && <p role="status" className="dialog-description">正在处理…</p>}
      {success && <p role="status" className="dialog-description">{success}</p>}
      {error && <p role="alert" className="dialog-description">{error}</p>}
      {selectedPage?.deleted && <p className="dialog-description">该日期的笔记在回收站。</p>}
      <div className="dialog-actions">
        <button type="button" className="nb-btn" disabled={busy} onClick={close}>关闭</button>
        {loadFailed && !loading && <button type="button" className="nb-btn" onClick={() => setReload(value => value + 1)}>重新查询</button>}
        {selectedPage?.deleted && !readOnly
          ? <button type="button" className="nb-btn nb-btn-primary" disabled={busy} onClick={() => onRestorePage(selectedPage.id)}>前往回收站</button>
          : <button type="submit" className="nb-btn nb-btn-primary" disabled={disabled}>{action}</button>}
      </div>
    </form>
  </Modal>;
}
