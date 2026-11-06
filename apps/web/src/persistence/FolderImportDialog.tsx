import type { PageSummary } from '@nbase/contracts';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Modal } from '../components/Modal';
import { runFolderBatch } from './folderBatchRunner';
import { folderBatchStore, newFolderBatch, type FolderImportBatch } from './folderBatchStore';
import { scanMarkdownFolder, type FolderMarkdownParser, type FolderSourceFile, type FolderImportPlan } from './folderPlan';
import { folderBatchCounts, folderImportReport } from './folderReport';
import './folderImport.css';

interface Props {
  userId: string;
  workspaceId: string;
  csrfToken: string;
  pages: readonly PageSummary[];
  defaultParentId?: string | null;
  parseMarkdown: FolderMarkdownParser;
  resolveTagIds?: ((names: readonly string[]) => Promise<string[]>) | undefined;
  onOpenPage: (id: string) => void | Promise<void>;
  onImported: () => void | Promise<void>;
  onClose: () => void;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : '导入未完成，请重试。';
const statusText = { pending: '待处理', success: '已完成', failed: '失败', cancelled: '已取消' };

function downloadReport(batch: FolderImportBatch) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(folderImportReport(batch), null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'nbase-import-' + batch.id + '.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FolderImportDialog({ userId, workspaceId, csrfToken, pages, defaultParentId, parseMarkdown,
  resolveTagIds, onOpenPage, onImported, onClose }: Props) {
  const scope = useMemo(() => ({ userId, workspaceId }), [userId, workspaceId]);
  const [parentId, setParentId] = useState(defaultParentId ?? '');
  const [preview, setPreview] = useState<{ plan: FolderImportPlan; sources: FolderSourceFile[] } | null>(null);
  const [batches, setBatches] = useState<FolderImportBatch[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const pause = useRef(false);
  const cancel = useRef(false);
  const busyRef = useRef(false);
  const session = useRef(0);

  useEffect(() => {
    const current = ++session.current;
    pause.current = false;
    cancel.current = false;
    busyRef.current = false;
    setBusy(false); setLoading(true); setPreview(null); setBatches([]); setSelectedId(''); setError(''); setNotice('');
    picker.current?.setAttribute('webkitdirectory', '');
    void folderBatchStore.list(scope).then(records => {
      if (session.current === current) { setBatches(records); setSelectedId(records[0]?.id ?? ''); }
    }).catch(reason => {
      if (session.current === current) setError(errorText(reason));
    }).finally(() => { if (session.current === current) setLoading(false); });
    return () => { ++session.current; pause.current = true; };
  }, [scope]);

  const record = batches.find(batch => batch.id === selectedId);
  const counts = record ? folderBatchCounts(record) : null;
  const close = () => { pause.current = true; onClose(); };
  const updateRecord = (batch: FolderImportBatch) => {
    setBatches(current => [batch, ...current.filter(item => item.id !== batch.id)]);
    setSelectedId(batch.id);
  };

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!files.length || busyRef.current) return;
    const current = session.current;
    busyRef.current = true; setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      const result = await scanMarkdownFolder(files, { pages, parentId: parentId || null, parseMarkdown });
      if (session.current === current) { setPreview(result); setSelectedId(''); }
    } catch (reason) {
      if (session.current === current) setError(errorText(reason));
    } finally {
      if (session.current === current) { busyRef.current = false; setBusy(false); }
    }
  };

  const start = async (existing?: FolderImportBatch, cancelUnstarted = false) => {
    if (busyRef.current || (!existing && !preview)) return;
    const current = session.current;
    busyRef.current = true; pause.current = false; cancel.current = cancelUnstarted; setBusy(true); setError(''); setNotice('');
    let batch = existing;
    try {
      if (!batch && preview) {
        batch = newFolderBatch(scope, preview.plan);
        // Persist originals and every operation ID before the first network request.
        await folderBatchStore.create(batch, preview.sources);
        if (session.current === current) { updateRecord(batch); setPreview(null); }
      }
      if (!batch) return;
      const result = await runFolderBatch(scope, batch.id, csrfToken, {
        parseMarkdown, resolveTagIds, shouldPause: () => pause.current || session.current !== current,
        shouldCancel: () => cancel.current,
        onProgress: progress => { if (session.current === current) updateRecord(progress); },
      });
      if (session.current === current) {
        updateRecord(result);
        const resultCounts = folderBatchCounts(result);
        setNotice(result.paused ?? (resultCounts.failed || resultCounts.pending
          ? '本批次仍有未完成的项目，可重试并导出报告。' : '本批次已完成。'));
      }
    } catch (reason) {
      if (session.current === current) setError(errorText(reason));
    } finally {
      if (batch) {
        // Refresh the tree even when a later operation failed after creating some skeletons.
        try { await onImported(); }
        catch { if (session.current === current) setNotice('本地记录已保留，请刷新页面目录查看已创建的页面。'); }
      }
      if (session.current === current) { busyRef.current = false; setBusy(false); }
    }
  };

  const forget = async (batch: FolderImportBatch) => {
    if (busyRef.current) return;
    const current = session.current;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await folderBatchStore.remove(scope, batch.id);
      if (session.current === current) {
        setBatches(items => items.filter(item => item.id !== batch.id)); setSelectedId('');
        setNotice('已清除本机批次记录，已创建的页面仍保留。');
      }
    } catch (reason) { if (session.current === current) setError(errorText(reason)); }
    finally { if (session.current === current) { busyRef.current = false; setBusy(false); } }
  };

  const openPage = async (id: string) => {
    try { await onOpenPage(id); close(); }
    catch (reason) { setError(errorText(reason)); }
  };

  return <Modal title="导入 Markdown 目录" wide onClose={close}>
    <div className="nbase-folder-import">
      <p className="dialog-description">选择目录或已解压的 NBase ZIP。最多 200 篇 Markdown、1,000 个文件、190 MiB。原文件和批次保存在当前浏览器，刷新后可恢复。</p>
      <label className="field-label" htmlFor="folder-import-parent">新批次的目标父页</label>
      <select className="select-field" id="folder-import-parent" value={parentId} disabled={busy}
        onChange={event => { setParentId(event.target.value); setPreview(null); }}>
        <option value="">工作区根目录</option>
        {pages.map(page => <option key={page.id} value={page.id}>{page.title || '未命名页面'}</option>)}
      </select>
      <label className="field-label" htmlFor="folder-import-picker">选择目录</label>
      <input ref={picker} id="folder-import-picker" type="file" multiple disabled={busy || loading} onChange={event => void choose(event)} />
      {preview && <section aria-label="导入预览">
        <h3>{preview.plan.rootName} · 导入预览</h3>
        <p className="dialog-description">将创建 {preview.plan.pages.length} 个页面（含目录），上传 {preview.plan.attachments.length} 个附件；{preview.plan.inputFileCount} 个输入文件。</p>
        <div className="nbase-folder-table"><table><thead><tr><th>源路径</th><th>类型</th><th>新页面标题</th></tr></thead>
          <tbody>{preview.plan.pages.map(page => <tr key={page.key}><td>{page.path}</td><td>{page.sourcePath ? 'Markdown' : '目录'}</td><td>{page.title}</td></tr>)}</tbody></table></div>
        {preview.plan.issues.length > 0 && <details open><summary>{preview.plan.issues.length} 项提示</summary>
          <ul className="nbase-folder-issues">{preview.plan.issues.map((issue, index) => <li key={index}>{issue.path}：{issue.message}</li>)}</ul></details>}
        <div className="dialog-actions"><button className="nb-btn" disabled={busy} onClick={() => setPreview(null)}>取消此预览</button>
          <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => void start()}>保存批次并导入</button></div>
      </section>}
      <section aria-label="本机导入批次">
        <h3>此账号与工作区的本机批次</h3>
        {loading && <p role="status">正在读取批次…</p>}
        {!loading && !batches.length && <p className="dialog-description">暂无导入记录。</p>}
        {batches.length > 0 && <><label className="field-label" htmlFor="folder-import-batch">选择批次</label>
          <select id="folder-import-batch" className="select-field" disabled={busy} value={selectedId}
            onChange={event => { setSelectedId(event.target.value); setPreview(null); setNotice(''); setError(''); }}>
            <option value="">请选择批次</option>
            {batches.map(batch => <option key={batch.id} value={batch.id}>{batch.plan.rootName} · {new Date(batch.createdAt).toLocaleString()} · {folderBatchCounts(batch).completed}/{folderBatchCounts(batch).total}</option>)}
          </select></>}
        {record && counts && <>
          <p role="status">已完成 {counts.completed}，待处理 {counts.pending}，失败 {counts.failed}，已取消 {counts.cancelled}。</p>
          {record.paused && <p className="dialog-description">{record.paused}</p>}
          <div className="nbase-folder-table"><table><thead><tr><th>页面 / 附件</th><th>状态</th><th>结果</th></tr></thead><tbody>
            {record.plan.pages.map(page => {
              const item = record.pages.find(entry => entry.key === page.key)!;
              return <tr key={page.key}><td>{page.path}</td><td>{statusText[item.status]}</td><td>{item.error && <span>{item.error} </span>}
                {item.skeleton && <button className="nb-btn" disabled={busy} onClick={() => void openPage(item.skeleton!.id)}>打开 {page.title}</button>}</td></tr>;
            })}
            {record.attachments.map(item => <tr key={item.path}><td>{item.path}</td><td>{statusText[item.status]}</td><td>{item.error}{item.invalidFile && ' 原始引用已保留。'}</td></tr>)}
          </tbody></table></div>
          {record.plan.issues.length > 0 && <details><summary>导入提示（{record.plan.issues.length}）</summary><ul className="nbase-folder-issues">
            {record.plan.issues.map((issue, index) => <li key={index}>{issue.path}：{issue.message}</li>)}</ul></details>}
          <div className="dialog-actions">
            <button className="nb-btn" disabled={busy} onClick={() => downloadReport(record)}>导出报告</button>
            <button className="nb-btn" disabled={busy} onClick={() => void forget(record)}>清除本机记录</button>
            <button className="nb-btn" disabled={busy || counts.completed + counts.cancelled === counts.total}
              onClick={() => void start(record, true)}>取消未开始项</button>
            <button className="nb-btn nb-btn-primary" disabled={busy || counts.completed + counts.cancelled === counts.total}
              onClick={() => void start(record)}>恢复 / 重试未完成项</button>
          </div>
        </>}
      </section>
      {notice && <p role="status" className="dialog-description">{notice}</p>}
      {error && <p role="alert" className="dialog-description">{error}</p>}
      <div className="dialog-actions">{busy && <><button className="nb-btn" onClick={() => { pause.current = true; setNotice('当前请求结束后暂停，其余项目保持待处理。'); }}>暂停未执行项</button>
        <button className="nb-btn" onClick={() => { cancel.current = true; setNotice('当前请求结束后取消未开始项，已创建的页面保留。'); }}>取消未开始项</button></>}
        <button className="nb-btn" onClick={close}>{busy ? '暂停并关闭' : '关闭'}</button></div>
    </div>
  </Modal>;
}
