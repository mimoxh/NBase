import { useEffect, useState, type ReactNode } from 'react';
import { isWhiteboardContent, type PageSummary, type PageVersion, type PageVersionSummary, type StoredDocumentContent, type TrashedPageDocument,
  type TrashedPageSummary } from '@nbase/contracts';
import { LazyWhiteboard } from '../whiteboard/lazy';
import { attachmentContentUrl } from '../whiteboard/host';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { DocumentEditor } from '../editor/DocumentEditor';
import type { DocumentContent, EditorPageReferences } from '../editor/types';
import { ApiError, pageClient } from './client';
import { diffVersions, type DiffLine } from './versionDiff';
import { PageIcon } from '../shell/PageTree';
import { relativeTime } from '../shell/Topbar';

const operationNames: Record<PageVersionSummary['operation'], string> = {
  baseline: '迁移基线', create: '创建', update: '保存', trash: '移入回收站', restore: '从回收站恢复', 'restore-version': '恢复历史',
};

function Preview({ id, title, content, workspaceId, pageReferences }: { id: string; title: string; content: StoredDocumentContent;
  workspaceId: string; pageReferences?: EditorPageReferences | undefined }) {
  const downloadRaw = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nbase-original-content.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="nbase-history-preview"><h3 className="nb-preview-title" data-nbase-find-title>{title || '未命名页面'}</h3>
    {isWhiteboardContent(content) ? <div className="wb-preview"><LazyWhiteboard key={id} boardId={id} content={content} readOnly title={title}
      pages={pageReferences?.pages ?? []} onChange={() => {}} onOpenPage={() => {}} onNotice={() => {}}
      imageUrl={attachmentId => attachmentContentUrl(workspaceId, attachmentId)} /></div>
    : content.schemaVersion === 1 ? <DocumentEditor key={id} documentId={id} title={title} initialContent={content as DocumentContent}
      workspaceId={workspaceId} pageReferences={pageReferences} readOnly onChange={() => {}} />
      : <div role="alert"><p>暂不支持此版本的正文预览，原始数据仍保留。</p><button className="nb-btn" onClick={downloadRaw}>下载原始 JSON</button></div>}
  </div>;
}

function failure(error: unknown): string {
  return error instanceof ApiError && error.status === 401 ? '登录已失效，请关闭后重新登录。' : '读取失败，请重试。';
}

function diffLineView(line: DiffLine, index: number): ReactNode {
  if (line.type === 'change') {
    return <div className="nb-diff-keep" key={index}>
      {line.block.kind === 'todo' && <span className={line.block.checked ? 'nb-todo-done' : ''}>{line.block.checked ? '☑ ' : '☐ '}</span>}
      {line.spans.map((span, spanIndex) => span.tone === 'keep' ? <span key={spanIndex}>{span.text}</span>
        : <span key={spanIndex} className={span.tone === 'add' ? 'nb-diff-add' : 'nb-diff-del'}>{span.text}</span>)}
    </div>;
  }
  const prefix = line.block.kind === 'todo' ? (line.block.checked ? '☑ ' : '☐ ') : line.block.kind === 'ul' ? '• ' : '';
  const cls = line.type === 'add' ? 'nb-diff-block-add' : line.type === 'del' ? 'nb-diff-block-del' : 'nb-diff-keep';
  return <div className={cls} key={index}>{line.block.checked ? <span className="nb-todo-done">{prefix}</span> : prefix}{line.block.text || ' '}</div>;
}

function sameLocalDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function PageHistoryDialog({ workspaceId, pageId, currentRevision, busy, pageReferences, onRestore, onClose }: {
  workspaceId: string; pageId: string; currentRevision: string; busy: boolean;
  pageReferences?: EditorPageReferences | undefined;
  onRestore: (version: PageVersion) => void; onClose: () => void;
}) {
  const [versions, setVersions] = useState<PageVersionSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PageVersion | null>(null);
  const [older, setOlder] = useState<PageVersion | null>(null);
  const [showDiff, setShowDiff] = useState(false);
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
    setPreview(null); setOlder(null); setPreviewError('');
    if (!selected) return;
    const controller = new AbortController(); setPreviewLoading(true);
    void pageClient.version(workspaceId, pageId, selected, controller.signal).then(value => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch(cause => { if (!controller.signal.aborted) setPreviewError(failure(cause)); })
      .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    return () => controller.abort();
  }, [workspaceId, pageId, selected, previewRetry]);
  useEffect(() => {
    if (!showDiff || !selected) { setOlder(null); return; }
    const index = versions.findIndex(item => item.revision === selected);
    const olderSummary = versions[index + 1];
    if (!olderSummary) {
      if (next && index === versions.length - 1) { setCursor(next); }
      return;
    }
    const controller = new AbortController();
    void pageClient.version(workspaceId, pageId, olderSummary.revision, controller.signal).then(value => {
      if (!controller.signal.aborted) setOlder(value);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [workspaceId, pageId, selected, showDiff, versions, next]);

  const groups = (() => {
    const today = new Date(); const yesterday = new Date(Date.now() - 86400_000);
    const buckets: { label: string; items: PageVersionSummary[] }[] = [
      { label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '更早', items: [] }];
    for (const version of versions) {
      const date = new Date(version.savedAt);
      if (sameLocalDay(date, today)) buckets[0]!.items.push(version);
      else if (sameLocalDay(date, yesterday)) buckets[1]!.items.push(version);
      else buckets[2]!.items.push(version);
    }
    return buckets.filter(bucket => bucket.items.length);
  })();

  const index = versions.findIndex(item => item.revision === selected);
  const hasOlder = index >= 0 && (index < versions.length - 1 || Boolean(next));
  const diff = showDiff && preview && older && preview.content.schemaVersion === 1 && older.content.schemaVersion === 1
    && !isWhiteboardContent(preview.content) && !isWhiteboardContent(older.content)
    ? diffVersions(older.content as DocumentContent, preview.content as DocumentContent) : null;
  const titleChanged = showDiff && preview && older && preview.title !== older.title;

  return <Modal title="历史" variant="large" onClose={onClose}>
    <div className="nb-hist">
      <div className="nb-hist-preview">
        <label className="nb-hist-toggle"><input type="checkbox" checked={showDiff} onChange={event => setShowDiff(event.target.checked)} />显示变更</label>
        <div className="nb-hist-preview-scroll">
          {previewLoading && <p role="status">正在读取预览…</p>}
          {previewError && <p role="alert">{previewError}<button onClick={() => setPreviewRetry(value => value + 1)}>重试预览</button></p>}
          {preview && !showDiff && <Preview id={`history:${pageId}:${preview.revision}`} title={preview.title} content={preview.content}
            workspaceId={workspaceId} pageReferences={pageReferences} />}
          {preview && showDiff && <div className="nbase-history-preview">
            <h3>{preview.title || '未命名页面'}</h3>
            {!older && hasOlder && <p role="status">正在读取对比版本…</p>}
            {!hasOlder && <p className="nb-pal-msg">这是最早的版本</p>}
            {diff?.tooLarge && <p className="nb-pal-msg">内容过大，暂不显示变更</p>}
            {diff && <div className="nb-diff">
              {titleChanged && <>
                <div className="nb-diff-block-del nb-diff-title">{older?.title || '未命名页面'}</div>
                <div className="nb-diff-block-add nb-diff-title">{preview.title || '未命名页面'}</div>
              </>}
              {diff.lines.map(diffLineView)}
            </div>}
          </div>}
        </div>
      </div>
      <div className="nb-hist-side">
        <div className="nb-hist-side-list" aria-label="版本列表">
          {groups.map(group => <div key={group.label}>
            <div className="nb-hist-group">{group.label}</div>
            {group.items.map(version => <button key={version.revision}
              className={`nb-hist-item ${selected === version.revision ? 'selected' : ''}`}
              onClick={() => setSelected(version.revision)} disabled={busy}>
              <strong>{new Date(version.savedAt).toLocaleTimeString()} · 修订 {version.revision}
                {version.revision === currentRevision && <span className="nb-hist-cur">当前</span>}</strong>
              <span>{operationNames[version.operation]}{version.deleted ? ' · 已删除' : ''}</span>
            </button>)}
          </div>)}
          {loading && <p role="status">正在读取历史…</p>}
          {error && <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
          {!loading && !error && !versions.length && <p>还没有可读取的历史</p>}
          {next && !loading && <button className="nb-btn nb-btn-quiet" onClick={() => setCursor(next)}>加载更早版本</button>}
        </div>
      </div>
    </div>
    <div className="dialog-actions"><span className="dialog-description" style={{ marginRight: 'auto' }}>恢复会生成新版本，当前内容仍保留在历史中，页面位置和图标不变。</span>
      <button className="nb-btn" onClick={onClose}>关闭</button>
      <button className="nb-btn nb-btn-primary" disabled={busy || !preview || preview.revision === currentRevision || preview.content.schemaVersion !== 1}
        onClick={() => { if (preview) onRestore(preview); }}>{busy ? '正在处理…' : '恢复此版本'}</button></div>
  </Modal>;
}

export function TrashDialog({ workspaceId, busy, pages: activePages, initialPageId, pageReferences, onRestore, onClose }: {
  workspaceId: string; busy: boolean; pages: PageSummary[]; initialPageId?: string | undefined;
  pageReferences?: EditorPageReferences | undefined;
  onRestore: (page: TrashedPageDocument) => void; onClose: () => void;
}) {
  const [pages, setPages] = useState<TrashedPageSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(initialPageId ?? null);
  const [preview, setPreview] = useState<TrashedPageDocument | null>(null);
  const [filter, setFilter] = useState('');
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
      if (!cursor) setSelected(previous => previous ?? response.pages[0]?.id ?? null);
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

  const pathOf = (page: TrashedPageSummary): string => {
    if (!page.parentId) return '原位置：个人空间';
    const names: string[] = [];
    let cursor: string | null = page.parentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = activePages.find(item => item.id === cursor)
        ?? pages.find(item => item.id === cursor);
      if (!parent || !activePages.some(item => item.id === parent.id)) {
        return '原位置：已不在 · 将恢复到根目录';
      }
      names.unshift(parent.title || '未命名页面');
      cursor = parent.parentId;
    }
    return `原位置：${names.join(' / ')}`;
  };
  const siblings = (page: TrashedPageSummary) => pages.filter(item => item.deletionGroupId === page.deletionGroupId && item.id !== page.id).length;
  const needle = filter.trim().toLocaleLowerCase();
  const visible = needle ? pages.filter(page => (page.title || '未命名页面').toLocaleLowerCase().includes(needle)) : pages;

  return <Modal title="回收站" variant="large" hideHeader onClose={onClose}>
    <div className="nb-trash-head"><h2>回收站</h2><p>页面与附件不会自动清理</p></div>
    <div className="nb-trash-filter">
      <input type="text" aria-label="在回收站中搜索" placeholder="在回收站中搜索" value={filter}
        onChange={event => setFilter(event.target.value)} />
    </div>
    <div className="nb-hist">
      <div className="nb-trash-list" aria-label="回收站页面">
        {visible.map(page => <button key={page.id} className={`nb-trash-row ${selected === page.id ? 'selected' : ''}`} disabled={busy}
          onClick={() => setSelected(page.id)}>
          <PageIcon page={page} />
          <span className="nb-trash-main"><strong>{page.title || '未命名页面'}</strong>
            <small>{pathOf(page)} · {relativeTime(page.deletedAt).replace('编辑', '删除')}</small></span>
          {siblings(page) > 0 && <span className="nb-trash-badge">含 {siblings(page)} 个子页面</span>}
          <span className="nb-trash-restore" role="button" tabIndex={0}
            onClick={event => {
              event.stopPropagation();
              if (busy) return;
              if (preview?.id === page.id) { onRestore(preview); return; }
              void pageClient.trashed(workspaceId, page.id).then(doc => onRestore(doc)).catch(() => undefined);
            }}
            onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); event.preventDefault(); (event.currentTarget as HTMLElement).click(); } }}>恢复</span>
        </button>)}
        {loading && <p className="nb-pal-msg" role="status">正在读取回收站…</p>}
        {error && <p className="nb-pal-msg" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {!loading && !error && !pages.length && <p className="nb-pal-msg">回收站是空的</p>}
        {!loading && !error && pages.length > 0 && !visible.length && <p className="nb-pal-msg">没有匹配的页面</p>}
        {next && !loading && <button className="nb-btn nb-btn-quiet" onClick={() => setCursor(next)}>加载更多</button>}
      </div>
      <div className="nb-trash-body">
        {selected && !preview && !previewError && <p role="status">正在读取预览…</p>}
        {previewError && <p role="alert">{previewError}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {preview && <>
          <div className="nb-trash-body-head"><h3 style={{ margin: 0 }}>{preview.title || '未命名页面'}</h3>
            <button className="nb-btn nb-btn-primary" disabled={busy} onClick={() => onRestore(preview)}>
              {busy ? '正在处理…' : '恢复'}</button></div>
          <Preview id={`trash:${preview.id}:${preview.revision}`} title={preview.title} content={preview.content}
            workspaceId={workspaceId} pageReferences={pageReferences} />
        </>}
      </div>
    </div>
  </Modal>;
}
