import { useEffect, useState } from 'react';
import type { PageVersion, PageVersionSummary, StoredDocumentContent, TrashedPageDocument, TrashedPageSummary } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import { DocumentEditor } from '../editor/DocumentEditor';
import type { DocumentContent } from '../editor/types';
import { ApiError, pageClient } from './client';

const operationNames: Record<PageVersionSummary['operation'], string> = {
  baseline: '迁移基线', create: '创建', update: '保存', trash: '移入回收站', restore: '从回收站恢复', 'restore-version': '恢复历史',
};

function Preview({ id, title, content, workspaceId }: { id: string; title: string; content: StoredDocumentContent; workspaceId: string }) {
  const downloadRaw = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nbase-original-content.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="nbase-history-preview"><h3>{title || '未命名页面'}</h3>
    {content.schemaVersion === 1 ? <DocumentEditor key={id} documentId={id} initialContent={content as DocumentContent}
      workspaceId={workspaceId} readOnly onChange={() => {}} />
      : <div role="alert"><p>暂不支持此版本的正文预览，原始数据仍保留。</p><button className="quiet-button" onClick={downloadRaw}>下载原始 JSON</button></div>}
  </div>;
}

function failure(error: unknown): string {
  return error instanceof ApiError && error.status === 401 ? '登录已失效，请关闭后重新登录。' : '读取失败，请重试。';
}

export function PageHistoryDialog({ workspaceId, pageId, currentRevision, busy, onRestore, onClose }: {
  workspaceId: string; pageId: string; currentRevision: string; busy: boolean;
  onRestore: (version: PageVersion) => void; onClose: () => void;
}) {
  const [versions, setVersions] = useState<PageVersionSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PageVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [retry, setRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void pageClient.history(workspaceId, pageId, cursor, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      setVersions(previous => cursor ? [...new Map([...previous, ...response.versions].map(item => [item.revision, item])).values()] : response.versions);
      setNext(response.nextBeforeRevision);
      if (!cursor) setSelected(response.versions[0]?.revision ?? null);
    }).catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, pageId, cursor, retry]);
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (!selected) return;
    const controller = new AbortController(); setPreviewLoading(true);
    void pageClient.version(workspaceId, pageId, selected, controller.signal).then(value => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch(cause => { if (!controller.signal.aborted) setPreviewError(failure(cause)); })
      .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    return () => controller.abort();
  }, [workspaceId, pageId, selected, previewRetry]);
  return <Modal title="历史版本" wide onClose={onClose}>
    <p className="dialog-description">每次成功保存保留一版，暂不自动清理。恢复选中版本的标题与正文，当前位置保留；当前已保存内容仍可从历史找回。</p>
    <div className="nbase-recovery-grid"><div className="nbase-version-list" aria-label="版本列表">
      {versions.map(version => <button key={version.revision} className={selected === version.revision ? 'selected' : ''}
        onClick={() => setSelected(version.revision)} disabled={busy}>
        <strong>修订 {version.revision}{version.revision === currentRevision ? ' · 当前' : ''}</strong>
        <span>{operationNames[version.operation]} · {new Date(version.savedAt).toLocaleString()}</span>
      </button>)}
      {loading && <p role="status">正在读取历史…</p>}
      {error && <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      {!loading && !error && !versions.length && <p>还没有可读取的历史。</p>}
      {next && !loading && <button onClick={() => setCursor(next)}>加载更早版本</button>}
    </div><div className="nbase-recovery-body">
      {previewLoading && <p role="status">正在读取预览…</p>}
      {previewError && <p role="alert">{previewError}<button onClick={() => setPreviewRetry(value => value + 1)}>重试预览</button></p>}
      {preview && <Preview id={`history:${pageId}:${preview.revision}`} title={preview.title} content={preview.content} workspaceId={workspaceId} />}
    </div></div>
    <div className="dialog-actions"><button className="quiet-button" onClick={onClose}>关闭</button>
      <button className="primary-button" disabled={busy || !preview || preview.revision === currentRevision || preview.content.schemaVersion !== 1}
        onClick={() => { if (preview) onRestore(preview); }}>{busy ? '正在处理…' : '恢复此版本'}</button></div>
  </Modal>;
}

export function TrashDialog({ workspaceId, busy, onRestore, onClose }: {
  workspaceId: string; busy: boolean; onRestore: (page: TrashedPageDocument) => void; onClose: () => void;
}) {
  const [pages, setPages] = useState<TrashedPageSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<TrashedPageDocument | null>(null);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void pageClient.trashList(workspaceId, cursor, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      setPages(previous => cursor ? [...new Map([...previous, ...response.pages].map(item => [item.id, item])).values()] : response.pages);
      setNext(response.nextCursor);
      if (!cursor) setSelected(response.pages[0]?.id ?? null);
    }).catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, cursor, retry]);
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (!selected) return;
    const controller = new AbortController();
    void pageClient.trashed(workspaceId, selected, controller.signal).then(value => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch(cause => { if (!controller.signal.aborted) setPreviewError(failure(cause)); });
    return () => controller.abort();
  }, [workspaceId, selected, retry]);
  return <Modal title="回收站" wide onClose={onClose}>
    <p className="dialog-description">页面与附件暂不自动清理。恢复选中页面及同一次删除的后代；原父页面不可用时，选中页面恢复到个人空间根目录。</p>
    <div className="nbase-recovery-grid"><div className="nbase-version-list" aria-label="回收站页面">
      {pages.map(page => <button key={page.id} className={selected === page.id ? 'selected' : ''} disabled={busy}
        onClick={() => setSelected(page.id)}><strong>{page.title || '未命名页面'}</strong><span>{new Date(page.deletedAt).toLocaleString()}</span></button>)}
      {loading && <p role="status">正在读取回收站…</p>}
      {error && <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      {!loading && !error && !pages.length && <p>回收站是空的。</p>}
      {next && !loading && <button onClick={() => setCursor(next)}>加载更多</button>}
    </div><div className="nbase-recovery-body">
      {selected && !preview && !previewError && <p role="status">正在读取预览…</p>}
      {previewError && <p role="alert">{previewError}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      {preview && <Preview id={`trash:${preview.id}:${preview.revision}`} title={preview.title} content={preview.content} workspaceId={workspaceId} />}
    </div></div>
    <div className="dialog-actions"><button className="quiet-button" onClick={onClose}>关闭</button>
      <button className="primary-button" disabled={busy || !preview} onClick={() => { if (preview) onRestore(preview); }}>{busy ? '正在处理…' : '恢复页面'}</button></div>
  </Modal>;
}
