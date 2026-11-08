import { databaseConditionLimit, filterOperatorsFor, operatorNeedsValue, type DatabaseView as View, type FilterOperator,
  type PropertyDefinition, type ViewFilter } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { operatorLabel } from '../labels';

function FilterValue({ def, filter, onChange }: { def: PropertyDefinition; filter: ViewFilter; onChange: (value: string | number | null) => void }) {
  if (!operatorNeedsValue(filter.operator)) return null;
  const value = filter.value ?? '';
  if (def.type === 'select' || def.type === 'multi_select') {
    return <select className="nb-db-select" aria-label="筛选值" value={String(value)} onChange={event => onChange(event.target.value || null)}>
      <option value="">选择选项</option>
      {(def.options ?? []).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>;
  }
  const type = def.type === 'number' ? 'number' : ['date', 'created_time', 'updated_time'].includes(def.type) ? 'date' : 'text';
  return <input className="nb-db-input" aria-label="筛选值" type={type} value={String(value)} placeholder="值"
    onChange={event => onChange(type === 'number' ? (event.target.value === '' ? null : Number(event.target.value))
      : event.target.value || null)} />;
}

export function FilterPanel({ view, active, canWrite, open, onOpen, onClose, onUpdate }: {
  view: View; active: PropertyDefinition[]; canWrite: boolean; open: boolean; onOpen: () => void; onClose: () => void;
  onUpdate: (patch: Partial<View>) => void;
}) {
  const conditions = view.filters.length + view.sorts.length;
  return <span className="nb-db-anchor">
    <button className={`nb-db-tool ${view.filters.length ? 'on' : ''}`} onClick={onOpen}>
      <Icon name="filter" size={14} />筛选{view.filters.length ? ` ${view.filters.length}` : ''}</button>
    {open && <Popover label="筛选" className="nb-db-pop nb-db-wide-pop" onClose={onClose}>
      {view.filters.length === 0 && <p className="nb-db-empty-note">还没有筛选条件。所有条件需同时满足。</p>}
      {view.filters.map((filter, index) => {
        const def = active.find(p => p.id === filter.propertyId);
        if (!def) return null;
        const replace = (next: ViewFilter | null) => onUpdate({ filters: next
          ? view.filters.map((item, i) => i === index ? next : item) : view.filters.filter((_, i) => i !== index) });
        return <div key={index} className="nb-db-condition">
          <select className="nb-db-select" aria-label="筛选字段" value={def.id} disabled={!canWrite} onChange={event => {
            const nextDef = active.find(p => p.id === event.target.value)!;
            replace({ propertyId: nextDef.id, operator: filterOperatorsFor(nextDef.type)[0]! });
          }}>{active.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select className="nb-db-select" aria-label="筛选条件" value={filter.operator} disabled={!canWrite}
            onChange={event => replace({ ...filter, operator: event.target.value as FilterOperator })}>
            {filterOperatorsFor(def.type).map(op => <option key={op} value={op}>{operatorLabel(def.type, op)}</option>)}
          </select>
          {canWrite && <FilterValue def={def} filter={filter} onChange={value => replace(value === null
            ? { propertyId: filter.propertyId, operator: filter.operator } : { ...filter, value })} />}
          {canWrite && <button className="nb-db-tool" aria-label="删除条件" onClick={() => replace(null)}><Icon name="close" size={13} /></button>}
        </div>;
      })}
      {canWrite && <button className="nb-btn nb-btn-quiet" disabled={conditions >= databaseConditionLimit} onClick={() => {
        const def = active[0]!;
        onUpdate({ filters: [...view.filters, { propertyId: def.id, operator: filterOperatorsFor(def.type)[0]! }] });
      }}><Icon name="plus" size={13} /> 添加条件</button>}
    </Popover>}
  </span>;
}
