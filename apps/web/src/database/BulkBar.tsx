import { useState } from 'react';
import { activeProperties, type DatabaseRow, type PropertyDefinition, type PropertyValue } from '@nbase/contracts';
import { Modal } from '../components/Modal';
import { Popover } from '../components/Popover';
import { EditableCell } from './cells';
import type { RowStore } from './rowStore';

const editable = (def: PropertyDefinition) => def.type !== 'created_time' && def.type !== 'updated_time' && def.type !== 'relation';

/** Actions for the rows ticked in the table. */
export function BulkBar({ store, properties, selected, onClear, canSort, notice }: {
  store: RowStore; properties: PropertyDefinition[]; selected: ReadonlySet<string>; onClear: () => void; canSort: boolean; notice: (text: string) => void;
}) {
  const fields = activeProperties(properties).filter(editable);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? '');
  const [draft, setDraft] = useState<PropertyValue | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const ids = store.order.filter(id => selected.has(id));
  const def = fields.find(p => p.id === fieldId);
  const preview: DatabaseRow = { id: 'bulk', title: draftTitle, icon: null, revision: '1', createdAt: '', updatedAt: '',
    properties: def && draft !== null ? { [def.id]: draft } : {} };
  const report = (done: number) => setProgress(`已处理 ${done} / ${ids.length} 行`);
  const apply = async () => {
    if (!def) return;
    setEditing(false);
    const ok = await store.patchRows(ids.map(id => def.type === 'title' ? { id, title: draftTitle } : { id, properties: { [def.id]: draft } }), report);
    setProgress(null);
    if (ok) notice(`已修改 ${ids.length} 行。`);
  };
  const remove = async () => {
    setConfirming(false);
    const ok = await store.trashRows(ids, report);
    setProgress(null);
    if (ok) { notice(`已将 ${ids.length} 行移入回收站，可以在回收站恢复。`); onClear(); }
  };
  const duplicate = async () => {
    const created = await store.duplicateRows(ids, canSort, report);
    setProgress(null);
    if (created.length) { notice(`已复制 ${created.length} 行。`); onClear(); }
  };
  return <div className="nb-db-bulk" role="toolbar" aria-label="批量操作">
    <span className="nb-db-bulk-count">{progress ?? `已选 ${ids.length} 行`}</span>
    <span className="nb-db-anchor">
      <button className="nb-btn nb-btn-quiet" disabled={!!progress} onClick={() => setEditing(true)}>修改字段</button>
      {editing && <Popover label="批量修改字段" className="nb-db-pop" onClose={() => setEditing(false)}>
        <select className="nb-db-select" aria-label="要修改的字段" value={fieldId} onChange={event => { setFieldId(event.target.value); setDraft(null); setDraftTitle(''); }}>
          {fields.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {def && <div className="nb-db-bulk-value nb-db-anchor">
          <EditableCell key={def.id} row={preview} def={def} editable onChange={setDraft} onTitle={setDraftTitle} />
        </div>}
        <p className="nb-db-empty-note">留空表示清空这一列。</p>
        <button className="nb-btn nb-btn-primary" onClick={() => void apply()}>应用到 {ids.length} 行</button>
      </Popover>}
    </span>
    <button className="nb-btn nb-btn-quiet" disabled={!!progress} onClick={() => void duplicate()}>复制</button>
    <button className="nb-btn nb-btn-quiet" disabled={!!progress} onClick={() => setConfirming(true)}>移入回收站</button>
    <button className="nb-btn nb-btn-quiet" disabled={!!progress} onClick={onClear}>取消选择</button>
    {confirming && <Modal title="移入回收站" onClose={() => setConfirming(false)}>
      <p className="dialog-description">将 {ids.length} 行移入回收站。每一行都可以从回收站单独恢复。</p>
      <div className="dialog-actions">
        <button className="nb-btn" onClick={() => setConfirming(false)}>取消</button>
        <button className="nb-btn nb-btn-primary" onClick={() => void remove()}>移入回收站</button>
      </div>
    </Modal>}
  </div>;
}
