import { databaseConditionLimit, flatFilters, type DatabaseView as View, type PropertyDefinition } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';

export function SortPanel({ view, active, canWrite, open, onOpen, onClose, onUpdate }: {
  view: View; active: PropertyDefinition[]; canWrite: boolean; open: boolean; onOpen: () => void; onClose: () => void;
  onUpdate: (patch: Partial<View>) => void;
}) {
  const conditions = flatFilters(view.filters).length + view.sorts.length;
  return <span className="nb-db-anchor">
    <button className={`nb-db-tool ${view.sorts.length ? 'on' : ''}`} onClick={onOpen}>
      <Icon name="sort" size={14} />排序{view.sorts.length ? ` ${view.sorts.length}` : ''}</button>
    {open && <Popover label="排序" className="nb-db-pop nb-db-wide-pop" onClose={onClose}>
      {view.sorts.length === 0 && <p className="nb-db-empty-note">按手动顺序显示。添加排序后，拖动排序将停用。</p>}
      {view.sorts.map((sort, index) => <div key={index} className="nb-db-condition">
        <select className="nb-db-select" aria-label="排序字段" value={sort.propertyId} disabled={!canWrite}
          onChange={event => onUpdate({ sorts: view.sorts.map((s, i) => i === index ? { ...s, propertyId: event.target.value } : s) })}>
          {active.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select className="nb-db-select" aria-label="排序方向" value={sort.direction} disabled={!canWrite}
          onChange={event => onUpdate({ sorts: view.sorts.map((s, i) => i === index ? { ...s, direction: event.target.value as 'asc' | 'desc' } : s) })}>
          <option value="asc">升序</option><option value="desc">降序</option></select>
        {canWrite && <button className="nb-db-tool" aria-label="删除排序" onClick={() => onUpdate({ sorts: view.sorts.filter((_, i) => i !== index) })}>
          <Icon name="close" size={13} /></button>}
      </div>)}
      {canWrite && <button className="nb-btn nb-btn-quiet" disabled={conditions >= databaseConditionLimit} onClick={() => {
        const used = new Set(view.sorts.map(s => s.propertyId));
        const def = active.find(p => !used.has(p.id)) ?? active[0]!;
        onUpdate({ sorts: [...view.sorts, { propertyId: def.id, direction: 'asc' }] });
      }}><Icon name="plus" size={13} /> 添加排序</button>}
    </Popover>}
  </span>;
}
