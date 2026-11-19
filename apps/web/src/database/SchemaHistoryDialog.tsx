import { useCallback, useEffect, useState } from 'react';
import { describeRestoreNote, describeSchemaChange, diffDatabaseSchemas, type DatabaseSchemaOperation,
  type DatabaseSchemaRestoreNote, type DatabaseSchemaVersion, type DatabaseSchemaVersionSummary } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import { announceDatabaseChange, errorCode, failureText, type DatabaseDataSource, type DatabaseState } from './source';

const operationNames: Record<DatabaseSchemaOperation, string> = {
  baseline: '初始结构', create: '新建数据库', update: '修改结构', relation: '新增关联', restore: '恢复版本',
};

const timeOf = (iso: string) => new Date(iso).toLocaleString();

function changeList(changes: DatabaseSchemaVersionSummary['changes'], changeCount: number) {
  return <ul className="nb-db-hist-changes">
    {changes.map((change, index) => <li key={`${change.target}:${change.id}:${change.kind}:${index}`}>{describeSchemaChange(change)}</li>)}
    {changeCount > changes.length && <li>……共 {changeCount} 项修改</li>}
  </ul>;
}

/** Every saved structure of one database, what each save changed, and a way back to an earlier one. */
export default function SchemaHistoryDialog({ source, state, databaseId, onClose }: {
  source: DatabaseDataSource; state: DatabaseState; databaseId: string; onClose: () => void;
}) {
  const [versions, setVersions] = useState<DatabaseSchemaVersionSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DatabaseSchemaVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Kept apart from the selection, so the outcome stays on screen once the new version is selected.
  const [restored, setRestored] = useState<{ revision: string; notes: DatabaseSchemaRestoreNote[] } | null>(null);
  const doc = state.doc;
  const currentRevision = doc?.schemaRevision ?? '';
  const canWrite = source.canWrite && typeof source.restoreSchema === 'function';

  const load = useCallback(async (before: string | null) => {
    if (!source.schemaHistory) return;
    setLoading(true);
    setError('');
    try {
      const response = await source.schemaHistory(databaseId, before);
      setVersions(previous => before ? [...previous, ...response.versions] : response.versions);
      setNext(response.nextBefore);
      setSelected(current => current ?? response.versions[0]?.revision ?? null);
    } catch (failure) {
      setError(failureText(failure, '结构历史暂时无法读取。'));
    } finally { setLoading(false); }
  }, [source, databaseId]);

  useEffect(() => { void load(null); }, [load]);

  useEffect(() => {
    setDetail(null);
    setProblem('');
    if (!selected || !source.schemaVersion) return;
    let cancelled = false;
    source.schemaVersion(databaseId, selected)
      .then(version => { if (!cancelled) setDetail(version); })
      .catch(failure => { if (!cancelled) setProblem(failureText(failure, '这个版本暂时无法读取。')); });
    return () => { cancelled = true; };
  }, [source, databaseId, selected]);

  const compare = detail && doc && detail.revision !== currentRevision
    ? diffDatabaseSchemas({ properties: detail.properties, views: detail.views }, { properties: doc.properties, views: doc.views })
    : [];

  const restore = async () => {
    if (!detail || !doc || !source.restoreSchema) return;
    setBusy(true);
    setProblem('');
    setRestored(null);
    try {
      const result = await source.restoreSchema(databaseId, detail.revision, doc.schemaRevision);
      setRestored({ revision: result.schemaRevision, notes: result.notes });
      source.notice(result.notes.length ? '已恢复，有些设置无法原样还原。' : '已恢复到所选版本。');
      // Every open view of this database reloads, this one included.
      announceDatabaseChange(databaseId);
      setSelected(result.schemaRevision);
      await load(null);
    } catch (failure) {
      setProblem(failureText(failure, '恢复未完成，请重试。'));
      if (errorCode(failure) === 'REVISION_CONFLICT' || errorCode(failure) === 'MUTATION_CONFLICT') await state.reload();
    } finally { setBusy(false); }
  };

  return <Modal title="结构历史" variant="large" onClose={onClose}>
    <div className="nb-hist">
      <div className="nb-hist-preview">
        <div className="nb-hist-preview-scroll">
          {selected && !detail && !problem && <p role="status">正在读取版本…</p>}
          {problem && <p role="alert">{problem}</p>}
          {detail && <>
            <div className="nb-hist-meta-main">
              <strong>修订 {detail.revision}</strong>
              <span>{timeOf(detail.savedAt)} · {detail.actor?.name || '系统'} · {operationNames[detail.operation]}
                {detail.restoredFrom ? ` · 恢复自修订 ${detail.restoredFrom}` : ''}</span>
            </div>
            {detail.changeCount > 0 && <>
              <h3 className="nb-db-hist-head">这次保存的修改</h3>
              {changeList(detail.changes, detail.changeCount)}
            </>}
            <h3 className="nb-db-hist-head">从此版本到当前版本的修改</h3>
            {detail.revision === currentRevision
              ? <p className="nb-db-empty-note">这就是当前版本。</p>
              : compare.length ? changeList(compare, compare.length)
                : <p className="nb-db-empty-note">字段和视图与当前版本一致。</p>}
            {restored?.revision === detail.revision && <div className="nb-db-hist-note" role="status">
              <strong>{restored.notes.length ? '已恢复，以下设置无法原样还原：' : '已恢复，所有设置都已还原。'}</strong>
              {restored.notes.length > 0 && <ul>{restored.notes.map((note, index) => <li key={index}>{describeRestoreNote(note)}</li>)}</ul>}
            </div>}
          </>}
          {!loading && !error && !versions.length && <p className="nb-db-empty-note">还没有结构历史。</p>}
        </div>
      </div>
      <div className="nb-hist-side">
        <div className="nb-hist-side-list" aria-label="版本列表">
          {versions.map(version => <button key={version.revision}
            className={`nb-hist-item ${selected === version.revision ? 'selected' : ''}`}
            aria-current={selected === version.revision ? 'true' : undefined}
            onClick={() => setSelected(version.revision)} disabled={busy}>
            <strong>{timeOf(version.savedAt)} · 修订 {version.revision}
              {version.revision === currentRevision && <span className="nb-hist-cur">当前</span>}</strong>
            <span>{operationNames[version.operation]}{version.actor ? ` · ${version.actor.name}` : ''}</span>
            {version.changeCount > 0 && <span>{version.changes.map(describeSchemaChange).join('；')}
              {version.changeCount > version.changes.length ? ` 等 ${version.changeCount} 项` : ''}</span>}
          </button>)}
          {loading && <p role="status">正在读取历史…</p>}
          {error && <p role="alert">{error}<button onClick={() => void load(next)}>重试</button></p>}
          {next && !loading && <button className="nb-btn nb-btn-quiet" onClick={() => void load(next)}>加载更早版本</button>}
        </div>
      </div>
    </div>
    <div className="dialog-actions">
      <span className="dialog-description" style={{ marginRight: 'auto' }}>恢复会生成一个新版本，当前结构仍保留在历史中。</span>
      <button className="nb-btn" onClick={onClose}>关闭</button>
      {canWrite && <button className="nb-btn nb-btn-primary" disabled={busy || !detail || detail.revision === currentRevision}
        onClick={() => void restore()}>{busy ? '正在恢复…' : '恢复此版本'}</button>}
    </div>
  </Modal>;
}
