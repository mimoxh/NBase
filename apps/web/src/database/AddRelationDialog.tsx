import { useEffect, useState } from 'react';
import type { DatabaseDocument, DatabaseOption } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import type { DatabaseDataSource } from './source';

/** Creates a pair of linked fields: one in this database and its twin in the chosen one. */
export function AddRelationDialog({ source, doc, onCreated, onClose }: {
  source: DatabaseDataSource; doc: DatabaseDocument; onCreated: (otherDatabaseId: string) => void; onClose: () => void;
}) {
  const [databases, setDatabases] = useState<DatabaseOption[]>([]);
  const [target, setTarget] = useState(doc.page.id);
  const [name, setName] = useState('');
  const [pairedName, setPairedName] = useState(doc.page.title || '关联');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { source.listDatabases().then(setDatabases).catch(() => setProblem('数据库列表暂时无法读取。')); }, [source]);
  const targetTitle = databases.find(item => item.id === target)?.title || '未命名数据库';
  const fieldName = name.trim() || targetTitle;
  const submit = async () => {
    setBusy(true);
    setProblem('');
    try {
      await source.createRelation(doc.page.id, { clientMutationId: crypto.randomUUID(), targetDatabaseId: target, name: fieldName.slice(0, 100), pairedName: (pairedName.trim() || doc.page.title || '关联').slice(0, 100) });
      onCreated(target);
    } catch { setProblem('关联字段没有创建，请重试。'); setBusy(false); }
  };
  return <Modal title="添加关联字段" onClose={() => { if (!busy) onClose(); }}>
    <p className="dialog-description">关联是双向的：两边的数据库各有一个字段，在任一边修改，另一边会同步。</p>
    <label className="nb-db-form-row">关联到
      <select className="nb-db-select" value={target} onChange={event => setTarget(event.target.value)}>
        {databases.map(item => <option key={item.id} value={item.id}>{item.title || '未命名数据库'}{item.id === doc.page.id ? '（当前）' : ''}</option>)}
      </select></label>
    <label className="nb-db-form-row">这边的字段名
      <input className="nb-db-input" value={name} maxLength={100} placeholder={targetTitle} onChange={event => setName(event.target.value)} /></label>
    <label className="nb-db-form-row">对面的字段名
      <input className="nb-db-input" value={pairedName} maxLength={100} onChange={event => setPairedName(event.target.value)} /></label>
    {problem && <p className="nb-db-invalid-note" role="alert">{problem}</p>}
    <div className="dialog-actions">
      <button className="nb-btn" disabled={busy} onClick={onClose}>取消</button>
      <button className="nb-btn nb-btn-primary" disabled={busy || !databases.length} onClick={() => void submit()}>创建</button>
    </div>
  </Modal>;
}
