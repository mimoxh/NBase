import { lazy, Suspense, useEffect, useState } from 'react';
import { activeProperties, databaseQueryWindow, viewColumns, type DatabaseDocument, type DatabaseRow, type DatabaseView as View } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { download } from '../../persistence/fileDownload';
import type { RowStore } from '../rowStore';
import { subscribeDatabaseExport, type DatabaseDataSource, type DatabaseState } from '../source';
import { rowsToCsv } from './csv';

const ImportDialog = lazy(() => import('./ImportDialog'));
const packageRowLimit = 199;

async function collectRows(source: DatabaseDataSource, databaseId: string, order: string[], onProgress: (done: number) => void): Promise<DatabaseRow[]> {
  const rows: DatabaseRow[] = [];
  for (let index = 0; index < order.length; index += databaseQueryWindow) {
    rows.push(...await source.readRows(databaseId, order.slice(index, index + databaseQueryWindow)));
    onProgress(rows.length);
  }
  return rows;
}

/** Import and export for one database. Exports read rows through the same paged calls the table uses. */
export function DataMenu({ source, state, store, doc, view, databaseId, canWrite, open, onOpen, onClose }: {
  source: DatabaseDataSource; state: DatabaseState; store: RowStore; doc: DatabaseDocument; view: View; databaseId: string; canWrite: boolean;
  open: boolean; onOpen: () => void; onClose: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => subscribeDatabaseExport(databaseId, onOpen), [databaseId, onOpen]);
  const title = doc.page.title || '未命名数据库';
  const all = activeProperties(doc.properties);

  const allIds = async () => (await source.query(databaseId, { filters: [], sorts: [] })).order;

  const exportCsv = async (scope: 'view' | 'all') => {
    onClose();
    try {
      const order = scope === 'view' ? store.order : await allIds();
      const rows = await collectRows(source, databaseId, order, done => setProgress(`正在导出 ${done} / ${order.length}`));
      download(title, rowsToCsv(rows, scope === 'view' ? viewColumns(doc.properties, view) : all), 'text/csv', '.csv');
      source.notice(`已导出 ${rows.length} 行。`);
    } catch { source.notice('导出未完成，请重试。'); } finally { setProgress(null); }
  };

  const exportPackage = async () => {
    onClose();
    if (!source.packageRows) return;
    try {
      const order = await allIds();
      if (order.length > packageRowLimit) { source.notice(`含正文的 ZIP 最多 ${packageRowLimit} 行，这个数据库有 ${order.length} 行。请导出 CSV，或使用完整备份保留正文。`); return; }
      const rows = await collectRows(source, databaseId, order, done => setProgress(`正在读取 ${done} / ${order.length}`));
      setProgress('正在打包…');
      await source.packageRows(doc, rows, rowsToCsv(rows, all));
      source.notice('ZIP 已发起下载。');
    } catch (failure) { source.notice(failure instanceof Error && failure.message ? failure.message : '导出未完成，请重试。'); } finally { setProgress(null); }
  };

  return <span className="nb-db-anchor">
    <button className="nb-db-tool" disabled={!!progress} onClick={onOpen}><Icon name="download" size={14} />{progress ?? '导入导出'}</button>
    {open && <Popover label="导入导出" className="nb-db-pop" onClose={onClose}>
      <div className="nb-db-menu">
        {canWrite && <button onClick={() => { onClose(); setImporting(true); }}>导入 CSV…</button>}
        <button onClick={() => void exportCsv('view')}>导出当前视图（CSV）</button>
        <button onClick={() => void exportCsv('all')}>导出全部行和字段（CSV）</button>
        {source.packageRows && <button onClick={() => void exportPackage()}>导出 ZIP（含行正文）</button>}
      </div>
    </Popover>}
    {importing && <Suspense fallback={null}><ImportDialog store={store} state={state} properties={doc.properties} onClose={() => setImporting(false)} /></Suspense>}
  </span>;
}
