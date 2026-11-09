import { useState } from 'react';
import { databaseConditionLimit, evaluateView, filterOperatorsFor, flatFilters, operatorNeedsValue, retainFilters, viewColumns, type DatabaseView as View,
  type PropertyDefinition, type PropertyType, type ViewFilter } from '@nbase/contracts';
import { Popover } from '../components/Popover';
import { creatableTypes, typeLabels } from './labels';
import { OptionEditor } from './OptionEditor';
import type { DatabaseState } from './source';

export function HeaderMenu({ def, view, state, onClose, onSaveProperties }: {
  def: PropertyDefinition; view: View; state: DatabaseState; onClose: () => void;
  onSaveProperties: (next: PropertyDefinition[], views?: View[]) => void;
}) {
  const doc = state.doc!;
  const [name, setName] = useState(def.name);
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== def.name) onSaveProperties(doc.properties.map(p => p.id === def.id ? { ...p, name: trimmed.slice(0, 100) } : p));
  };
  const updateView = (patch: Partial<View>) => onSaveProperties(doc.properties,
    doc.views.map(item => item.id === view.id ? { ...item, ...patch } : item));
  const columns = evaluateView([], doc.properties, { ...view, hiddenPropertyIds: [] }).columns.filter(p => p.type !== 'title');
  const index = columns.findIndex(p => p.id === def.id);
  const visibleIndex = viewColumns(doc.properties, view).findIndex(p => p.id === def.id);
  const shift = (step: number) => {
    const ids = columns.map(p => p.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(Math.max(0, Math.min(ids.length, index + step)), 0, moved!);
    updateView({ propertyOrder: ids });
  };
  const setType = (type: PropertyType) => {
    if (type === def.type) return;
    // Options stay on the definition so changing the type back brings them and their row values back.
    const usesOptions = (t: PropertyType) => t === 'select' || t === 'multi_select';
    const next: PropertyDefinition = { id: def.id, name: def.name, type,
      ...(def.options || usesOptions(type) ? { options: def.options ?? [] } : {}) };
    // Conditions written for the old type may not fit the new one; a compared value is an option id only under option types.
    const fits = (f: ViewFilter) => filterOperatorsFor(type).includes(f.operator)
      && (usesOptions(def.type) === usesOptions(type) || !operatorNeedsValue(f.operator));
    const views = doc.views.map(item => ({ ...item,
      filters: retainFilters(item.filters, f => f.propertyId !== def.id || fits(f)) }));
    onSaveProperties(doc.properties.map(p => p.id === def.id ? next : p), views);
  };
  const remove = () => {
    const views = doc.views.map(item => ({ ...item, filters: retainFilters(item.filters, f => f.propertyId !== def.id),
      sorts: item.sorts.filter(s => s.propertyId !== def.id) }));
    onSaveProperties(doc.properties.map(p => p.id === def.id ? { ...p, deletedAt: new Date().toISOString() } : p), views);
    onClose();
  };
  const sort = (direction: 'asc' | 'desc') => {
    updateView({ sorts: [{ propertyId: def.id, direction }, ...view.sorts.filter(s => s.propertyId !== def.id)]
      .slice(0, Math.max(1, databaseConditionLimit - flatFilters(view.filters).length)) });
    onClose();
  };
  return <Popover label={`字段「${def.name}」`} className="nb-db-pop nb-db-header-pop" portal width={240}
    onClose={() => { commitName(); onClose(); }}>
    <input className="nb-db-input" aria-label="字段名称" value={name} maxLength={100} onChange={event => setName(event.target.value)}
      onBlur={commitName} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { commitName(); onClose(); } }} />
    {def.type !== 'title' && def.type !== 'relation' && <label className="nb-db-field-row">类型
      <select className="nb-db-select" value={def.type} onChange={event => setType(event.target.value as PropertyType)}>
        {creatableTypes.map(type => <option key={type} value={type}>{typeLabels[type]}</option>)}
      </select></label>}
    {(def.type === 'select' || def.type === 'multi_select') && <OptionEditor def={doc.properties.find(p => p.id === def.id) ?? def} onChange={(options, removedId) => {
      // A condition on a removed option could never be edited or met again.
      const views = removedId ? doc.views.map(item => ({ ...item, filters: retainFilters(item.filters, f => f.propertyId !== def.id || f.value !== removedId) })) : doc.views;
      onSaveProperties(doc.properties.map(p => p.id === def.id ? { ...p, options } : p), views);
    }} />}
    <div className="nb-db-menu">
      <button onClick={() => sort('asc')}>升序排列</button>
      <button onClick={() => sort('desc')}>降序排列</button>
      <button onClick={() => { updateView({ frozenColumns: (view.frozenColumns ?? 0) === visibleIndex + 1 ? 0 : visibleIndex + 1 }); onClose(); }}>
        {(view.frozenColumns ?? 0) === visibleIndex + 1 ? '取消冻结' : '冻结到此列'}</button>
      {def.type !== 'title' && <>
        <button disabled={index <= 0} onClick={() => shift(-1)}>向左移动</button>
        <button disabled={index < 0 || index >= columns.length - 1} onClick={() => shift(1)}>向右移动</button>
        <button onClick={() => { updateView({ hiddenPropertyIds: [...view.hiddenPropertyIds, def.id] }); onClose(); }}>在此视图隐藏</button>
        <button className="danger" onClick={remove}>删除字段</button>
      </>}
    </div>
  </Popover>;
}
