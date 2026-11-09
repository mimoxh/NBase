import { databaseConditionLimit, filterOperatorsFor, flatFilters, isFilterGroup, operatorNeedsValue, relativeDateTokens, type DatabaseView as View, type FilterOperator,
  type PropertyDefinition, type ViewFilter, type ViewFilterEntry } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { operatorLabel, relativeDateLabels } from '../labels';

function DateValue({ filter, onChange }: { filter: ViewFilter; onChange: (value: string | null) => void }) {
  const value = typeof filter.value === 'string' ? filter.value : '';
  const relative = value.startsWith('@') ? value : '';
  return <span className="nb-db-date-value">
    <select className="nb-db-select" aria-label="日期范围" value={relative} onChange={event => onChange(event.target.value || null)}>
      <option value="">具体日期</option>
      {relativeDateTokens.map(token => <option key={token} value={`@${token}`}>{relativeDateLabels[token]}</option>)}
    </select>
    {!relative && <input className="nb-db-input" aria-label="筛选值" type="date" value={value} onChange={event => onChange(event.target.value || null)} />}
  </span>;
}

function FilterValue({ def, filter, onChange }: { def: PropertyDefinition; filter: ViewFilter; onChange: (value: string | number | null) => void }) {
  if (!operatorNeedsValue(filter.operator)) return null;
  const value = filter.value ?? '';
  if (def.type === 'select' || def.type === 'multi_select') {
    return <select className="nb-db-select" aria-label="筛选值" value={String(value)} onChange={event => onChange(event.target.value || null)}>
      <option value="">选择选项</option>
      {(def.options ?? []).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>;
  }
  if (['date', 'created_time', 'updated_time'].includes(def.type)) return <DateValue filter={filter} onChange={onChange} />;
  const type = def.type === 'number' ? 'number' : 'text';
  return <input className="nb-db-input" aria-label="筛选值" type={type} value={String(value)} placeholder="值"
    onChange={event => onChange(type === 'number' ? (event.target.value === '' ? null : Number(event.target.value))
      : event.target.value || null)} />;
}

function Condition({ filter, active, canWrite, onReplace }: {
  filter: ViewFilter; active: PropertyDefinition[]; canWrite: boolean; onReplace: (next: ViewFilter | null) => void;
}) {
  const def = active.find(p => p.id === filter.propertyId);
  if (!def) return null;
  return <div className="nb-db-condition">
    <select className="nb-db-select" aria-label="筛选字段" value={def.id} disabled={!canWrite} onChange={event => {
      const nextDef = active.find(p => p.id === event.target.value)!;
      onReplace({ propertyId: nextDef.id, operator: filterOperatorsFor(nextDef.type)[0]! });
    }}>{active.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <select className="nb-db-select" aria-label="筛选条件" value={filter.operator} disabled={!canWrite}
      onChange={event => onReplace({ ...filter, operator: event.target.value as FilterOperator })}>
      {filterOperatorsFor(def.type).map(op => <option key={op} value={op}>{operatorLabel(def.type, op)}</option>)}
    </select>
    {canWrite && <FilterValue def={def} filter={filter} onChange={value => onReplace(value === null
      ? { propertyId: filter.propertyId, operator: filter.operator } : { ...filter, value })} />}
    {canWrite && <button className="nb-db-tool" aria-label="删除条件" onClick={() => onReplace(null)}><Icon name="close" size={13} /></button>}
  </div>;
}

export function FilterPanel({ view, active, canWrite, open, onOpen, onClose, onUpdate }: {
  view: View; active: PropertyDefinition[]; canWrite: boolean; open: boolean; onOpen: () => void; onClose: () => void;
  onUpdate: (patch: Partial<View>) => void;
}) {
  const count = flatFilters(view.filters).length;
  const full = count + view.sorts.length >= databaseConditionLimit;
  const blank = (): ViewFilter => { const def = active[0]!; return { propertyId: def.id, operator: filterOperatorsFor(def.type)[0]! }; };
  const setEntries = (filters: ViewFilterEntry[]) => onUpdate({ filters });
  const replaceEntry = (index: number, next: ViewFilterEntry | null) =>
    setEntries(next ? view.filters.map((item, i) => i === index ? next : item) : view.filters.filter((_, i) => i !== index));
  return <span className="nb-db-anchor">
    <button className={`nb-db-tool ${count ? 'on' : ''}`} onClick={onOpen}>
      <Icon name="filter" size={14} />筛选{count ? ` ${count}` : ''}</button>
    {open && <Popover label="筛选" className="nb-db-pop nb-db-wide-pop" onClose={onClose}>
      {view.filters.length === 0 && <p className="nb-db-empty-note">还没有筛选条件。条件之间需同时满足；“任一”组内满足一条即可。</p>}
      {view.filters.map((entry, index) => isFilterGroup(entry)
        ? <div key={index} className="nb-db-group" role="group" aria-label="满足任一条件">
          <div className="nb-db-subhead">满足任一条件</div>
          {entry.any.map((filter, inner) => <Condition key={inner} filter={filter} active={active} canWrite={canWrite} onReplace={next => {
            const any = next ? entry.any.map((item, i) => i === inner ? next : item) : entry.any.filter((_, i) => i !== inner);
            replaceEntry(index, any.length ? { any } : null);
          }} />)}
          {canWrite && <button className="nb-btn nb-btn-quiet" disabled={full} onClick={() => replaceEntry(index, { any: [...entry.any, blank()] })}>
            <Icon name="plus" size={13} /> 添加“或”条件</button>}
        </div>
        : <Condition key={index} filter={entry} active={active} canWrite={canWrite} onReplace={next => replaceEntry(index, next)} />)}
      {canWrite && <div className="nb-db-filter-actions">
        <button className="nb-btn nb-btn-quiet" disabled={full} onClick={() => setEntries([...view.filters, blank()])}><Icon name="plus" size={13} /> 添加条件</button>
        <button className="nb-btn nb-btn-quiet" disabled={full} onClick={() => setEntries([...view.filters, { any: [blank()] }])}><Icon name="plus" size={13} /> 添加“任一”组</button>
      </div>}
    </Popover>}
  </span>;
}
