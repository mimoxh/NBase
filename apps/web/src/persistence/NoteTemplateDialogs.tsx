import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NoteTemplate, PageSummary, StoredDocumentContent, TemplatePreview } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { DocumentEditor } from '../editor/DocumentEditor';
import { createContentFromMarkdown } from '../editor/markdown';
import type { DocumentContent, DocumentEditorHandle } from '../editor/types';
import { ApiError } from './client';
import { noteTemplateClient } from './noteTemplateClient';
import { newTemplateWrite, sameTemplateWrite, templateWriteStore, type TemplateMutation, type TemplateWrite } from './templateWrites';

const untitled = '未命名页面';
const ignoreChange = () => {};

function templateError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已过期，请重新登录。';
    if (error.code === 'REVISION_CONFLICT') return '模板已在其他地方更新。你可以保留当前编辑并另存为新模板。';
    if (error.code === 'ATTACHMENT_INVALID') return '正文中有不可用的附件。请处理后再保存。';
    if (error.code === 'TEMPLATE_LIMIT') return '个人模板已达 30 个，请先删除不再使用的模板。';
    if (error.code === 'NOT_FOUND') return '该模板已删除或当前账号无权使用。';
  }
  return '模板操作失败，请重试。';
}

function useTemplates(workspaceId: string) {
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void noteTemplateClient.list(workspaceId, controller.signal).then(list => {
      if (!controller.signal.aborted) setTemplates(list);
    }, error => {
      if (!controller.signal.aborted) setLoadError(templateError(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [workspaceId, attempt]);
  return { templates, setTemplates, loading, loadError, retry: () => setAttempt(current => current + 1) };
}

interface TemplateDialogProps { workspaceId: string; csrfToken: string; onClose: () => void }

export function NewNoteDialog({ workspaceId, csrfToken, busy, error, onCreate, onClose }: TemplateDialogProps & {
  busy: boolean; error?: string; onCreate: (title: string, content: StoredDocumentContent) => void;
}) {
  const { templates, loading, loadError, retry } = useTemplates(workspaceId);
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const id = useId();
  const titleValue = title.trim() || untitled;
  const previewKey = templateId + ':' + titleValue;
  const [previewFor, setPreviewFor] = useState('');
  const confirmedPreview = previewFor === previewKey ? preview : null;
  const titleInput = useRef<HTMLInputElement>(null);
  // Modal's showModal() runs after this child's effects and focuses the close button; take focus back on the next frame.
  useEffect(() => { const frame = requestAnimationFrame(() => titleInput.current?.focus()); return () => cancelAnimationFrame(frame); }, []);

  useEffect(() => {
    if (!templateId) return;
    const controller = new AbortController();
    setPreviewError('');
    const timer = setTimeout(() => {
      void noteTemplateClient.preview(workspaceId, { templateId, title: titleValue }, csrfToken, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        setPreview(result);
        setPreviewFor(previewKey);
      }, failure => {
        if (!controller.signal.aborted) setPreviewError(templateError(failure));
      });
    }, 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspaceId, csrfToken, templateId, titleValue, previewKey, attempt]);

  function create() {
    if (busy) return;
    if (!templateId) onCreate(titleValue, createContentFromMarkdown(''));
    else if (confirmedPreview) onCreate(titleValue, confirmedPreview.content);
  }

  const builtinTemplates = templates.filter(template => template.builtin);
  const personalTemplates = templates.filter(template => !template.builtin);
  const choose = (next: string) => {
    if (busy || next === templateId) return;
    setPreviewFor(''); setPreviewError(''); setTemplateId(next);
  };
  const option = (value: string, name: string) => <button key={value || 'blank'} type="button" role="radio"
    aria-checked={templateId === value} disabled={busy} onClick={() => choose(value)}
    className={'nb-newnote-option' + (templateId === value ? ' selected' : '')}>
    <span className="nb-newnote-option-icon"><Icon name="page" size={16} /></span>
    <span className="nb-newnote-option-name">{name}</span>
    {templateId === value && <span className="nb-newnote-check"><Icon name="check" size={15} /></span>}
  </button>;

  return <Modal title="新建笔记" wide onClose={() => { if (!busy) onClose(); }}>
    <div className="nb-newnote">
      <label className="field-label" htmlFor={id + '-title'}>页面标题</label>
      <input ref={titleInput} id={id + '-title'} type="text" value={title} maxLength={255} placeholder={untitled}
        disabled={busy} onChange={event => {
          const next = event.currentTarget.value;
          if ((next.trim() || untitled) !== titleValue) { setPreviewFor(''); setPreviewError(''); }
          setTitle(next);
        }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) create(); }} />
      <div className="nb-newnote-body">
        <div className="nb-newnote-side" role="radiogroup" aria-label="笔记模板">
          <div className="nb-newnote-group">基础</div>
          {option('', '空白页')}
          {builtinTemplates.length > 0 && <div className="nb-newnote-group">内置模板</div>}
          {builtinTemplates.map(template => option(template.id, template.name))}
          {personalTemplates.length > 0 && <div className="nb-newnote-group">个人模板</div>}
          {personalTemplates.map(template => option(template.id, template.name))}
          {loading && <p className="nb-newnote-msg" role="status">正在读取模板…</p>}
          {loadError && <p className="nb-newnote-msg nb-newnote-error" role="alert">{loadError}
            <button type="button" className="nb-newnote-link" onClick={retry}>重新读取</button></p>}
        </div>
        <section className="nb-newnote-preview" aria-label="模板预览">
          <div className="nb-newnote-preview-label">预览</div>
          <div className="nb-newnote-preview-scroll">
            <h3 className="nb-newnote-preview-title">{titleValue}</h3>
            {!templateId && <p className="nb-newnote-msg">空白页面，从这里开始写作。</p>}
            {templateId && !confirmedPreview && !previewError && <p className="nb-newnote-msg" role="status">正在生成预览…</p>}
            {templateId && previewError && <p className="nb-newnote-msg nb-newnote-error" role="alert">{previewError}
              <button type="button" className="nb-newnote-link" onClick={() => setAttempt(current => current + 1)}>重试预览</button></p>}
            {confirmedPreview && <>
              {confirmedPreview.missingAttachments.length > 0 && <p className="nb-newnote-warn" role="status">
                以下附件不可用，将保留文字说明：{confirmedPreview.missingAttachments.join('、')}
              </p>}
              <div className="nbase-history-preview">
                <DocumentEditor key={previewKey} documentId={'template-preview:' + previewKey} initialContent={confirmedPreview.content as DocumentContent}
                  workspaceId={workspaceId} readOnly onChange={ignoreChange} />
              </div>
            </>}
          </div>
        </section>
      </div>
      {error && <p className="nb-newnote-alert" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions nb-newnote-actions">
      <button type="button" className="nb-btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="nb-btn nb-btn-primary" disabled={busy || Boolean(templateId && !confirmedPreview)} onClick={create}>
        {busy ? '正在创建…' : '创建笔记'}
      </button>
    </div>
  </Modal>;
}

interface TemplateEdit {
  key: string;
  id: string | null;
  revision: string | null;
  content: StoredDocumentContent;
}
const preventTemplateUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
/** Authorization runs before receipt lookup, so these failures never resolve an earlier unknown write. */
function confirmedTemplateRejection(failure: unknown): failure is ApiError {
  return failure instanceof ApiError && ['REVISION_CONFLICT', 'ATTACHMENT_INVALID', 'TEMPLATE_LIMIT',
    'INVALID_REQUEST', 'CONTENT_INVALID', 'CONTENT_VERSION_UNSUPPORTED'].includes(failure.code);
}

export function TemplateManagerDialog({ userId, workspaceId, csrfToken, source, onClose }: TemplateDialogProps & {
  userId: string;
  source?: { title: string; content: StoredDocumentContent } | undefined;
}) {
  const { templates, setTemplates, loading, loadError, retry } = useTemplates(workspaceId);
  const [edit, setEdit] = useState<TemplateEdit | null>(() => source ? { key: crypto.randomUUID(), id: null, revision: null, content: source.content } : null);
  const [name, setName] = useState(() => source?.title.trim().slice(0, 80) ?? '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<TemplateWrite | null>(null);
  const [records, setRecords] = useState<TemplateWrite[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localLoadError, setLocalLoadError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [unsaved, setUnsaved] = useState(false);
  const [editingNotice, setEditingNotice] = useState('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  const listSequence = useRef(0);
  const unsavedWrite = useRef<{ record: TemplateWrite; previous: TemplateWrite | null } | null>(null);
  const guarded = useRef(false);
  const beforeUnload = useRef((event: BeforeUnloadEvent) => preventTemplateUnload(event)).current;
  const editor = useRef<DocumentEditorHandle>(null);
  const nameId = useId();
  const scope = useMemo(() => ({ userId, workspaceId }), [userId, workspaceId]);

  function guard(needed: boolean) {
    if (needed && !guarded.current) window.addEventListener('beforeunload', beforeUnload);
    if (!needed && guarded.current) window.removeEventListener('beforeunload', beforeUnload);
    guarded.current = needed;
  }

  async function refreshRecords() {
    const sequence = ++listSequence.current;
    try {
      const list = await templateWriteStore.list(scope);
      if (alive.current && sequence === listSequence.current) {
        setRecords(list); setLocalLoadError(''); setLocalLoading(false);
      }
    } catch (reason) {
      if (alive.current && sequence === listSequence.current) {
        setLocalLoadError(reason instanceof Error ? reason.message : '无法读取本机模板记录。'); setLocalLoading(false);
      }
    }
  }

  useEffect(() => {
    alive.current = true;
    void refreshRecords();
    return () => { alive.current = false; listSequence.current++; guard(false); };
  }, [scope]);

  function choose(template: NoteTemplate | null, content?: StoredDocumentContent) {
    setEdit({
      key: crypto.randomUUID(), id: template?.id ?? null, revision: template?.revision ?? null,
      content: content ?? template?.content ?? createContentFromMarkdown(''),
    });
    setName(template?.name ?? '');
    setDeleteConfirm(false);
    setConflict(false);
    setError('');
    setNotice('');
    setEditingNotice('');
    setPending(null);
    setStorageError('');
  }

  function restore(record: TemplateWrite) {
    if (inFlight.current || unsavedWrite.current) return;
    const operation = record.operation;
    choose(null, record.snapshot.content);
    setEdit({ key: crypto.randomUUID(), id: operation.id,
      revision: operation.body.expectedRevision ?? null, content: record.snapshot.content });
    setName(record.snapshot.name);
    setPending(record);
    setConflict(record.failure === 'REVISION_CONFLICT');
    setError(record.state === 'rejected' ? templateError(new ApiError(422, record.failure ?? 'INVALID_REQUEST')) : '');
    setNotice(record.state === 'pending' ? '已恢复待确认操作，重试会继续使用原操作标识。' : '原操作已被拒绝，正文仍保留，可修改后保存或另存。');
  }

  async function replay(record: TemplateWrite) {
    if (!alive.current) return;
    const operation = record.operation;
    const stored = await templateWriteStore.get(scope, operation.body.clientMutationId);
    if (!alive.current) return;
    if (!sameTemplateWrite(stored, record)) {
      if (alive.current) {
        setPending(null); setEdit(null); setName('');
        setNotice('该记录已由其他位置处理或更新，请重新读取并恢复当前记录。'); retry();
      }
      await refreshRecords(); return;
    }
    // Keep the original endpoint and body. Template receipts cannot be read through the page receipt API.
    try {
      if (operation.kind === 'delete') {
        await noteTemplateClient.remove(workspaceId, operation.id, operation.body, csrfToken);
        if (alive.current) {
          setTemplates(list => list.filter(item => item.id !== operation.id)); setEdit(null); setDeleteConfirm(false);
          setNotice('已删除个人模板。');
        }
      } else {
        const saved = await (operation.id
          ? noteTemplateClient.update(workspaceId, operation.id, operation.body, csrfToken)
          : noteTemplateClient.create(workspaceId, operation.body, csrfToken));
        if (alive.current) {
          setTemplates(list => list.some(item => item.id === saved.id)
            ? list.map(item => item.id === saved.id ? saved : item) : [...list, saved]);
          setEdit(previous => previous && ({ ...previous, id: saved.id, revision: saved.revision, content: saved.content }));
          setNotice('已保存个人模板。');
        }
      }
    } catch (failure) {
      if (confirmedTemplateRejection(failure)) {
        const rejected: TemplateWrite = { ...record, version: crypto.randomUUID(), state: 'rejected', failure: failure.code };
        try {
          await templateWriteStore.put(rejected, record);
          if (alive.current) { setPending(rejected); setConflict(failure.code === 'REVISION_CONFLICT'); }
        } catch (reason) {
          if (alive.current) setStorageError('原操作仍保留在本机，但拒绝状态未能更新：' + (reason instanceof Error ? reason.message : '请重试。'));
        }
      }
      if (alive.current) setError(confirmedTemplateRejection(failure) ? templateError(failure)
        : (failure instanceof ApiError && failure.status === 401 ? '登录已过期，请重新登录。原操作仍保留。'
          : '保存结果尚未确认。重试将继续使用同一个操作标识。'));
      await refreshRecords(); return;
    }
    // Even after unmount, clean only this confirmed version; a newer record must survive.
    try {
      const removed = await templateWriteStore.removeIfVersion(record);
      if (alive.current) {
        setPending(null);
        if (!removed) setNotice('服务端已确认，其他位置更新过的本机记录仍保留。');
      }
    } catch (reason) {
      if (alive.current) setStorageError('服务端已确认，本机记录未能清理。仍可使用原操作重试：' + (reason instanceof Error ? reason.message : '本机存储不可用。'));
    }
    await refreshRecords();
  }

  async function run(record: TemplateWrite, previous: TemplateWrite | null, needsPersistence: boolean) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice(''); setStorageError('');
    setPending(record);
    try {
      if (needsPersistence) {
        unsavedWrite.current = { record, previous }; setUnsaved(true); guard(true);
        try { await templateWriteStore.put(record, previous); }
        catch (reason) {
          if (alive.current) setStorageError(reason instanceof Error ? reason.message : '本机模板记录未能保存。');
          return;
        }
        unsavedWrite.current = null; guard(false);
        if (alive.current) setUnsaved(false);
      }
      if (!alive.current) return;
      await refreshRecords();
      if (!alive.current) return;
      await replay(record);
    } catch (reason) {
      if (alive.current) setStorageError(reason instanceof Error ? reason.message : '无法核对本机模板记录，网络操作已暂停。');
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const mutate = (operation: TemplateMutation) => {
    const content = editor.current?.getSnapshot().content ?? edit?.content;
    if (!content) return;
    const record = newTemplateWrite(scope, operation, operation.kind === 'save'
      ? { name: operation.body.name, content: operation.body.content } : { name, content });
    void run(record, pending?.state === 'rejected' ? pending : null, true);
  };
  const retryWrite = () => {
    const local = unsavedWrite.current;
    if (local) void run(local.record, local.previous, true);
    else if (pending) void run(pending, null, false);
  };
  const close = () => {
    if (inFlight.current) return;
    if (unsavedWrite.current) { setStorageError('待提交内容尚未写入本机。请重试本机保存，或先复制/下载保留内容。'); return; }
    onClose();
  };
  const payload = () => {
    const content = editor.current?.getSnapshot().content ?? edit?.content ?? pending?.snapshot.content;
    return JSON.stringify({ name, content }, null, 2);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(payload()); if (alive.current) setNotice('模板正文与名称已复制。'); }
    catch { if (alive.current) setError('复制失败，请下载模板 JSON 保留内容。'); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([payload()], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nbase-template.json'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const locked = busy || localLoading || Boolean(localLoadError) || unsaved || pending?.state === 'pending'
    || (!pending && records.some(record => record.state === 'pending'));
  const save = () => {
    if (!edit || locked || !name.trim()) return;
    const content = editor.current?.getSnapshot().content ?? edit.content;
    void mutate({ kind: 'save', id: edit.id, body: {
      clientMutationId: crypto.randomUUID(), name: name.trim(), content,
      ...(edit.revision ? { expectedRevision: edit.revision } : {}),
    } });
  };
  const saveAsNew = () => {
    if (!edit) return;
    const content = editor.current?.getSnapshot().content ?? edit.content;
    const previousName = name;
    setEdit({ key: crypto.randomUUID(), id: null, revision: null, content });
    setName(previousName); setConflict(false); setError('');
  };

  return <Modal title="个人模板" wide onClose={close}>
    <p className="dialog-description">使用 {'{{title}}'} 和 {'{{date}}'} 在应用模板时填入新页面标题和日期。</p>
    <button type="button" className="nb-btn" disabled={locked} onClick={() => choose(null)}>新建个人模板</button>
    {loading && <p role="status">正在读取模板…</p>}
    {loadError && <p role="alert">{loadError} <button type="button" className="nb-btn" onClick={retry}>重新读取</button></p>}
    {localLoading && <p role="status">正在读取本机模板记录…</p>}
    {localLoadError && <p role="alert">本机模板记录：{localLoadError} 网络操作已暂停。
      <button type="button" className="nb-btn" onClick={() => void refreshRecords()}>重试读取本机记录</button></p>}
    {records.length > 0 && <section aria-label="本机模板记录">
      <h3>本机待处理模板</h3>
      <p className="dialog-description">仅列出此账号和工作区的记录。恢复后可查看正文并继续原操作。</p>
      <ul>{records.map(record => <li key={record.key}>
        <strong>{record.snapshot.name || '未命名模板'}</strong> · {record.operation.kind === 'delete' ? '删除' : '保存'} · {record.state === 'pending' ? '待确认' : '已拒绝，正文保留'}
        <button type="button" className="nb-btn" disabled={busy || unsaved}
          onClick={() => restore(record)}>恢复此模板记录</button>
      </li>)}</ul>
    </section>}
    <ul aria-label="已保存的个人模板">
      {templates.filter(template => !template.builtin).map(template => <li key={template.id}>
        <button type="button" className="nb-btn" aria-pressed={template.id === edit?.id} disabled={locked}
          onClick={() => choose(template)}>{template.name}</button>
      </li>)}
    </ul>
    {edit && <>
      <label className="field-label" htmlFor={nameId}>模板名称</label>
      <input id={nameId} type="text" value={name} maxLength={80} disabled={locked}
        onChange={event => setName(event.currentTarget.value)} />
      <DocumentEditor key={edit.key} ref={editor} documentId={'template-edit:' + edit.key}
        initialContent={edit.content as DocumentContent} workspaceId={workspaceId} readOnly={locked}
        onChange={ignoreChange} onNotice={setEditingNotice} />
    </>}
    {editingNotice && <p role="status">{editingNotice}</p>}
    {pending && !unsaved && <p role="status" className="dialog-description">模板操作与正文已保留在本机，关闭或刷新后可恢复。</p>}
    {storageError && <p role="alert">本机存储：{storageError}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {deleteConfirm && <p role="status">删除此模板后，已经创建的页面仍可继续编辑。</p>}
    <div className="dialog-actions">
      {(edit || pending) && <>
        <button type="button" className="nb-btn" onClick={() => void copy()}>复制模板 JSON</button>
        <button type="button" className="nb-btn" onClick={download}>下载模板 JSON</button>
      </>}
      <button type="button" className="nb-btn" disabled={busy} onClick={close}>关闭</button>
      {pending?.state === 'pending'
        ? <button type="button" className="nb-btn nb-btn-primary" disabled={busy} onClick={retryWrite}>{busy ? '处理中…' : unsaved ? '重试本机保存' : '重试'}</button>
        : <>
          {conflict && <button type="button" className="nb-btn" onClick={saveAsNew}>保留编辑并另存</button>}
          {edit?.id && edit.revision && <button type="button" className="nb-btn" disabled={locked} onClick={() => {
            if (!deleteConfirm) { setDeleteConfirm(true); return; }
            if (edit.revision && edit.id) void mutate({ kind: 'delete', id: edit.id, body: {
              clientMutationId: crypto.randomUUID(), expectedRevision: edit.revision,
            } });
          }}>{deleteConfirm ? '确认删除模板' : '删除模板'}</button>}
          {edit && <button type="button" className="nb-btn nb-btn-primary" disabled={locked || !name.trim() || loading} onClick={save}>保存模板</button>}
        </>}
    </div>
  </Modal>;
}

function copyTitle(title: string): string {
  return (title.trim() || untitled).slice(0, 251).replace(/[\ud800-\udbff]$/u, '') + '（副本）';
}

export function CopyNoteDialog({ source, pages, busy, error, onCopy, onClose }: {
  source: PageSummary; pages: PageSummary[]; busy: boolean; error?: string;
  onCopy: (title: string, parentId: string | null) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(() => copyTitle(source.title));
  const [parent, setParent] = useState(() => source.parentId ?? '');
  const id = useId();
  const parentOptions = useMemo(() => {
    const byId = new Map(pages.map(page => [page.id, page]));
    return pages.map(page => {
      const path = [page.title || untitled];
      const visited = new Set([page.id]);
      let ancestorId = page.parentId;
      while (ancestorId && !visited.has(ancestorId)) {
        const ancestor = byId.get(ancestorId);
        if (!ancestor) break;
        path.push(ancestor.title || untitled);
        visited.add(ancestorId);
        ancestorId = ancestor.parentId;
      }
      return { id: page.id, label: path.reverse().join(' / ') };
    });
  }, [pages]);
  return <Modal title="复制页面" onClose={() => { if (!busy) onClose(); }}>
    <p className="dialog-description">复制使用已保存的正文。如果有未保存的编辑，会先完成原页保存。</p>
    <label className="field-label" htmlFor={id + '-title'}>副本标题</label>
    <input id={id + '-title'} type="text" maxLength={255} value={title} disabled={busy}
      onChange={event => setTitle(event.currentTarget.value)} />
    <label className="field-label" htmlFor={id + '-parent'}>副本位置</label>
    <select id={id + '-parent'} className="select-field" value={parent} disabled={busy}
      onChange={event => setParent(event.currentTarget.value)}>
      <option value="">工作区（根目录）</option>
      {parentOptions.map(page => <option key={page.id} value={page.id}>{page.label}</option>)}
    </select>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="nb-btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="nb-btn nb-btn-primary" disabled={busy || !title.trim()}
        onClick={() => onCopy(title.trim(), parent || null)}>{busy ? '正在复制…' : '复制页面'}</button>
    </div>
  </Modal>;
}
