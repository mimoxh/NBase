import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { DocumentEditor } from './DocumentEditor';
import { parseSourceEdit, prepareSourceEdit } from './sourceEditing';
import {
  SourceDraftQueue, sourceDraftKey, sourceDraftStore, sourceDraftVersion,
  type SourceDraft, type SourceDraftInput, type SourceDraftScope, type SourceDraftVersion,
} from './sourceDrafts';
import type { DocumentContent, EditorPageReferences } from './types';
import './sourceEditor.css';

export interface SourceEditorDialogProps {
  scope: SourceDraftScope & { baseRevision: string };
  initialContent: DocumentContent;
  readOnly?: boolean;
  attachmentWorkspaceId?: string;
  pageReferences?: EditorPageReferences;
  onApply: (content: DocumentContent, baseContent: DocumentContent, baseRevision: string) => Promise<void>;
  onSaveCopy?: (content: DocumentContent) => Promise<void>;
  onClose: () => void;
}

const message = (reason: unknown) => reason instanceof Error ? reason.message : '操作未完成，当前源码和原正文仍保留。';

function prepare(content: DocumentContent) {
  try { return prepareSourceEdit(content); }
  catch (reason) { return { source: '', diagnostics: [message(reason)], canApply: false }; }
}

/** The scope key remounts the session; later save responses never replace its original baseline. */
export function SourceEditorDialog(props: SourceEditorDialogProps) {
  return <SourceEditorSession key={sourceDraftKey(props.scope)} {...props} />;
}

function SourceEditorSession({ scope, initialContent, readOnly = false, attachmentWorkspaceId, pageReferences,
  onApply, onSaveCopy, onClose }: SourceEditorDialogProps) {
  const [opening] = useState(() => {
    const content = structuredClone(initialContent);
    return { content, revision: scope.baseRevision, prepared: prepare(content) };
  });
  const [source, setSource] = useState(opening.prepared.source);
  const [baseContent, setBaseContent] = useState(opening.content);
  const [baseRevision, setBaseRevision] = useState(opening.revision);
  const [preparation, setPreparation] = useState(opening.prepared);
  const [records, setRecords] = useState<SourceDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(0);
  const [savedSequence, setSavedSequence] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(opening.prepared.diagnostics);
  const [preview, setPreview] = useState<{ content: DocumentContent; version: number } | null>(null);
  const [storageError, setStorageError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [applyFailed, setApplyFailed] = useState(false);
  const [applied, setApplied] = useState(false);
  const [composing, setComposing] = useState(false);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const composingRef = useRef(false);
  const queue = useRef(new SourceDraftQueue(scope));
  const adopted = useRef<SourceDraftVersion[]>([]);
  const previewVersion = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const ownKey = sourceDraftKey(scope);
  const inScope = (version: SourceDraftVersion) => version.userId === scope.userId
    && version.workspaceId === scope.workspaceId && version.pageId === scope.pageId
    && version.key === sourceDraftKey(version);
  const unresolvedOwn = !dirty && records.some(record => record.key === ownKey);

  const refresh = async () => {
    const drafts = await sourceDraftStore.list(scope);
    if (alive.current) setRecords(drafts);
  };

  useEffect(() => {
    alive.current = true;
    void sourceDraftStore.list(scope).then(drafts => {
      if (alive.current) { setRecords(drafts); setStorageError(''); }
    }).catch(reason => { if (alive.current) setStorageError(message(reason)); })
      .finally(() => { if (alive.current) setLoading(false); });
    // Writes already queued by input deliberately continue after a page change or logout.
    return () => { alive.current = false; };
  }, []);

  const draftInput = (text = source): SourceDraftInput => ({ source: text, baseContent, baseRevision,
    ...(adopted.current.length ? { recoveredFrom: adopted.current } : {}) });

  const persist = (value: SourceDraftInput) => {
    const activeQueue = queue.current;
    setSaving(count => count + 1);
    try {
      void activeQueue.enqueue(value).then(draft => {
        if (alive.current && queue.current === activeQueue) {
          setStorageError(''); setSavedSequence(draft.sequence);
          setRecords(current => [draft, ...current.filter(record => record.key !== draft.key)]);
        }
      }).catch(reason => {
        if (alive.current && queue.current === activeQueue) setStorageError(message(reason));
      }).finally(() => { if (alive.current && queue.current === activeQueue) setSaving(count => count - 1); });
    } catch (reason) { setSaving(count => count - 1); setStorageError(message(reason)); }
  };

  const changeSource = (text: string) => {
    if (readOnly || busyRef.current || applied || unresolvedOwn || loading) return;
    setSource(text); setDirty(true); setError(''); setNotice(''); setApplyFailed(false); setPreview(null);
    persist(draftInput(text));
  };

  const convert = () => {
    try {
      const converted = parseSourceEdit(source, baseContent);
      setDiagnostics(converted.diagnostics);
      return converted.content;
    } catch (reason) { setDiagnostics([message(reason)]); return null; }
  };

  const showPreview = () => {
    if (busyRef.current || composingRef.current) return;
    const content = convert();
    if (content) setPreview({ content, version: ++previewVersion.current });
    else setPreview(null);
  };

  const close = async () => {
    if (busyRef.current) return;
    if (dirty && !readOnly && !applied) {
      try { await queue.current.flush(); }
      catch (reason) {
        if (alive.current) {
          setStorageError(message(reason));
          setError('本机保存未完成，当前源码仍在此处。请先复制或重试保存，也可明确放弃草稿。');
        }
        return;
      }
    }
    onClose();
  };

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source);
      else {
        input.current?.focus(); input.current?.select();
        if (!document.execCommand?.('copy')) throw new Error('请选中源码后使用复制快捷键。');
      }
      if (alive.current) setNotice('已复制源码。');
    } catch (reason) { if (alive.current) setError(message(reason)); }
  };

  const cleanVersion = async (draft: SourceDraft) => {
    let allRemoved = await queue.current.clear(sourceDraftVersion(draft));
    for (const version of draft.recoveredFrom ?? []) {
      // Recovered records are scoped to this page; never accept a stored pointer to another account.
      if (!inScope(version)) continue;
      if (!await sourceDraftStore.removeIfVersion(version)) allRemoved = false;
    }
    return allRemoved;
  };

  const apply = async (asCopy = false) => {
    if (busyRef.current || readOnly || applied || loading || !dirty || unresolvedOwn || composingRef.current || !preparation.canApply) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    let succeeded = false;
    try {
      const content = convert();
      if (!content) return;
      const version = await queue.current.flush();
      if (!version) throw new Error('源码尚未写入本机，请重试保存后再应用。');
      if (asCopy) {
        if (!onSaveCopy) return;
        await onSaveCopy(content);
      } else await onApply(content, baseContent, baseRevision);
      succeeded = true;
      if (!alive.current) return;
      setApplied(true);
      const removed = await cleanVersion(version);
      if (!alive.current) return;
      if (removed) onClose();
      else { setNotice('已' + (asCopy ? '另存副本' : '应用') + '。其他位置更新过的源码草稿仍保留，可关闭后重新查看。'); await refresh(); }
    } catch (reason) {
      if (alive.current) {
        if (succeeded) {
          setApplied(true); setNotice('正文已' + (asCopy ? '另存副本' : '应用') + '，本机草稿未能清理，仍可找回。');
        } else {
          setApplyFailed(true); setError(message(reason));
        }
      }
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  const restore = async (draft: SourceDraft) => {
    if (busyRef.current || (!readOnly && (dirty || (unresolvedOwn && draft.key !== ownKey)))) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const baseline = structuredClone(draft.baseContent);
      const prepared = prepare(baseline);
      setSource(draft.source); setBaseContent(baseline); setBaseRevision(draft.baseRevision); setPreparation(prepared);
      setDiagnostics(prepared.diagnostics); setPreview(null); setApplyFailed(false); setApplied(false);
      if (readOnly) { setNotice('正在查看本机草稿；只读模式可复制和预览。'); return; }
      setDirty(true);
      const inherited = draft.recoveredFrom ?? [];
      adopted.current = draft.key === ownKey ? inherited : [...inherited, sourceDraftVersion(draft)];
      queue.current = new SourceDraftQueue(scope, draft.key === ownKey ? draft : null);
      if (draft.key === ownKey) { setSavedSequence(draft.sequence); setStorageError(''); }
      else {
        const saved = await queue.current.enqueue({ source: draft.source, baseContent: baseline, baseRevision: draft.baseRevision,
          recoveredFrom: adopted.current });
        if (alive.current) { setSavedSequence(saved.sequence); setStorageError(''); await refresh(); }
      }
      if (alive.current) setNotice('已恢复源码，应用时仍核对草稿的原始正文与基准修订。');
    } catch (reason) { if (alive.current) setStorageError(message(reason)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  const discardRecord = async (draft: SourceDraft) => {
    if (readOnly || busyRef.current || dirty) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const removed = await sourceDraftStore.removeIfVersion(sourceDraftVersion(draft));
      if (alive.current) { setNotice(removed ? '已放弃该版本的源码草稿。' : '草稿已有更新，较新版本仍保留。'); await refresh(); }
    } catch (reason) { if (alive.current) setStorageError(message(reason)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  const discardCurrent = async () => {
    if (readOnly || busyRef.current || !dirty) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      // A failed queued write has no stored version to delete; only the last confirmed version may be removed.
      await queue.current.flush().catch(() => {});
      const version = queue.current.latest;
      if (version) await cleanVersion(version);
      else for (const original of adopted.current) if (inScope(original)) await sourceDraftStore.removeIfVersion(original);
      if (!alive.current) return;
      queue.current.abandonUnsavedInput();
      queue.current = new SourceDraftQueue(scope); adopted.current = [];
      setSource(opening.prepared.source); setBaseContent(opening.content); setBaseRevision(opening.revision); setPreparation(opening.prepared);
      setDiagnostics(opening.prepared.diagnostics); setDirty(false); setSavedSequence(null); setSaving(0); setStorageError('');
      setPreview(null); setApplyFailed(false); setApplied(false); setNotice('已放弃当前源码草稿。');
      await refresh();
    } catch (reason) { if (alive.current) setStorageError(message(reason)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  const retryStorage = async () => {
    if (busyRef.current || readOnly) return;
    try {
      await refresh();
      if (dirty) persist(draftInput());
      else setStorageError('');
    } catch (reason) { if (alive.current) setStorageError(message(reason)); }
  };

  return <Modal title={readOnly ? '查看 Markdown 源码' : '编辑 Markdown 源码'} variant="large" onClose={() => void close()}>
    <div className="nbase-source-editor">
      <p className="dialog-description">源码只编辑正文。应用后可撤销，并沿用页面保存与冲突处理。</p>
      {readOnly && <p className="dialog-description">当前为只读模式，可预览和复制。</p>}
      {loading && <p role="status">正在读取本机源码草稿…</p>}
      {records.length > 0 && <details className="nbase-source-recovery" open={unresolvedOwn || undefined}>
        <summary>此账号、工作区与页面的本机源码草稿（{records.length}）</summary>
        <ul>{records.map(draft => <li key={draft.key}>
          <span>{draft.instanceId === scope.instanceId ? '当前编辑实例' : '其他编辑实例'} · {new Date(draft.updatedAt).toLocaleString()} · 基准修订 {draft.baseRevision} · 版本 {draft.sequence}</span>
          <div><button className="nb-btn" disabled={busy || (!readOnly && (dirty || (unresolvedOwn && draft.key !== ownKey)))}
            onClick={() => void restore(draft)}>{readOnly ? '查看此草稿' : '恢复此草稿'}</button>
            {!readOnly && <button className="nb-btn" disabled={busy || dirty} onClick={() => void discardRecord(draft)}>放弃此草稿</button>}</div>
        </li>)}</ul>
        {!readOnly && dirty && <p className="dialog-description">先应用或明确放弃当前输入，再恢复其他草稿。</p>}
      </details>}
      {unresolvedOwn && !readOnly && <p role="status">此编辑实例有未恢复的草稿。请先恢复或明确放弃该草稿。</p>}
      <label className="field-label" htmlFor="nbase-source-text">Markdown 正文源码</label>
      <textarea ref={input} id="nbase-source-text" value={source} readOnly={readOnly || busy || applied || unresolvedOwn || loading}
        spellCheck={false} rows={14} onChange={event => changeSource(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
        onCompositionEnd={() => { composingRef.current = false; setComposing(false); }} />
      {!readOnly && dirty && <p role="status" className="dialog-description">{saving ? '正在保存本机源码草稿…' : storageError ? '本机源码草稿保存未完成。' : savedSequence !== null ? '本机源码草稿已保存（版本 ' + savedSequence + '）。' : '源码草稿待保存。'}</p>}
      {diagnostics.length > 0 && <ul className="nbase-source-diagnostics" role="status">{diagnostics.map((text, index) => <li key={index}>{text}</li>)}</ul>}
      {!preparation.canApply && <details><summary>查看保留的原始正文</summary><pre className="nbase-source-original">{JSON.stringify(baseContent, null, 2)}</pre></details>}
      {storageError && <div role="alert"><p>本机存储：{storageError} 当前输入仍可复制。</p>
        {!readOnly && <button className="nb-btn" disabled={busy} onClick={() => void retryStorage()}>重试本机保存</button>}</div>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="dialog-actions">
        <button className="nb-btn" disabled={busy || composing} onClick={showPreview}>预览</button>
        <button className="nb-btn" onClick={() => void copy()}>复制源码</button>
        {!readOnly && dirty && <button className="nb-btn" disabled={busy} onClick={() => void discardCurrent()}>放弃当前草稿</button>}
        <button className="nb-btn" disabled={busy} onClick={() => void close()}>{readOnly ? '关闭' : '取消'}</button>
        {!readOnly && applyFailed && onSaveCopy && <button className="nb-btn" disabled={busy || applied || Boolean(storageError) || !preparation.canApply || composing}
          onClick={() => void apply(true)}>另存为副本</button>}
        {!readOnly && <button className="nb-btn nb-btn-primary" disabled={busy || applied || loading || !dirty || unresolvedOwn || Boolean(storageError) || !preparation.canApply || composing}
          onClick={() => void apply()}>应用</button>}
      </div>
      {preview && <section className="nbase-source-preview" aria-label="Markdown 源码预览">
        <h3>正文预览</h3>
        <DocumentEditor key={preview.version} documentId={ownKey + ':source-preview:' + preview.version}
          initialContent={preview.content} readOnly workspaceId={attachmentWorkspaceId} pageReferences={pageReferences}
          onChange={() => {}} />
      </section>}
    </div>
  </Modal>;
}
