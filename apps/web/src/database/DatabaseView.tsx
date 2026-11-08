import { useMemo, useState, type ReactNode } from 'react';
import { activeProperties, databasePropertyLimit, databaseViewLimit, evaluateView, isFilterGroup, operatorNeedsValue, type DatabaseRow,
  type DatabaseView as View, type PropertyDefinition, type PropertyType, type PropertyValue, type RowProperties } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { OptionTag } from './cells';
import { TableView } from './grid/TableView';
import { nextOptionColor, operatorLabel, typeLabels } from './labels';
import type { Panel } from './panel';
import { useDatabase, type DatabaseDataSource } from './source';
import { FieldsPanel } from './toolbar/FieldsPanel';
import { FilterPanel } from './toolbar/FilterPanel';
import { SortPanel } from './toolbar/SortPanel';
import { ViewTabs } from './toolbar/ViewTabs';
import './database.css';

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** Values a new row takes so it stays visible under the view's simple equality filters. */
function defaultsFromFilters(view: View, properties: PropertyDefinition[]): RowProperties {
  const values: RowProperties = {};
  for (const filter of view.filters) {
    if (isFilterGroup(filter)) continue;
    const def = properties.find(p => p.id === filter.propertyId && !p.deletedAt);
    if (!def || values[def.id] !== undefined) continue;
    if (filter.operator === 'is_checked' && def.type === 'checkbox') values[def.id] = true;
    if (filter.operator !== 'equals' && filter.operator !== 'contains') continue;
    const v = filter.value;
    if (v === undefined || v === null || v === '') continue;
    if (def.type === 'select' && filter.operator === 'equals' && def.options?.some(o => o.id === v)) values[def.id] = String(v);
    if (def.type === 'multi_select' && def.options?.some(o => o.id === v)) values[def.id] = [String(v)];
    if ((def.type === 'text' || def.type === 'date') && filter.operator === 'equals') values[def.id] = String(v);
    if (def.type === 'number' && filter.operator === 'equals' && Number.isFinite(Number(v))) values[def.id] = Number(v);
  }
  return values;
}

export interface DatabaseViewProps {
  source: DatabaseDataSource;
  databaseId: string;
  /** Inline blocks pin a view; null or missing uses the first one. */
  viewId?: string | null;
  compact?: boolean;
  /** Inline blocks only: lets the block remember which view it shows. */
  onViewChange?: (viewId: string) => void;
  heading?: ReactNode;
}

export function DatabaseView({ source, databaseId, viewId = null, compact = false, onViewChange, heading }: DatabaseViewProps) {
  const state = useDatabase(source, databaseId);
  const { doc } = state;
  const [localViewId, setLocalViewId] = useState<string | null>(viewId);
  const [panel, setPanel] = useState<Panel>(null);
  const [limit, setLimit] = useState(compact ? 50 : 200);
  const canWrite = source.canWrite;

  const view = doc ? doc.views.find(item => item.id === (localViewId ?? viewId)) ?? doc.views[0] : undefined;
  const evaluated = useMemo(() => doc && view ? evaluateView(doc.rows, doc.properties, view) : null, [doc, view]);

  if (state.loading && !doc) return <div className="nb-db nb-db-status" role="status">正在读取数据库…</div>;
  if (!doc || !view || !evaluated) return <div className="nb-db nb-db-status" role="alert">{state.error || '数据库暂时无法读取。'}
    <button className="nb-btn nb-btn-quiet" onClick={() => void state.reload()}>重试</button></div>;

  const properties = doc.properties;
  const active = activeProperties(properties);
  const save = (nextProperties: PropertyDefinition[], nextViews: View[] = doc.views) =>
    state.saveSchema({ properties: nextProperties, views: nextViews });
  const updateView = (patch: Partial<View>) => save(properties, doc.views.map(item => item.id === view.id ? { ...item, ...patch } : item));
  const selectView = (id: string) => { setLocalViewId(id); onViewChange?.(id); };
  const closePanel = () => setPanel(null);

  const addProperty = (type: PropertyType) => {
    if (active.length >= databasePropertyLimit) return;
    const def: PropertyDefinition = { id: crypto.randomUUID(), name: uniqueName(typeLabels[type], active.map(p => p.name)), type,
      ...(type === 'select' || type === 'multi_select' ? { options: [] } : {}) };
    void save([...properties, def], doc.views.map(item => item.id === view.id
      ? { ...item, propertyOrder: [...evaluated.columns.filter(p => p.type !== 'title').map(p => p.id), def.id] } : item));
    setPanel({ kind: 'header', id: def.id });
  };
  const createOption = (def: PropertyDefinition) => async (name: string) => {
    const latest = state.doc?.properties.find(p => p.id === def.id) ?? def;
    if ((latest.options?.length ?? 0) >= 200) { source.notice('选项数量已达上限。'); return null; }
    const option = { id: crypto.randomUUID(), name: name.slice(0, 100), color: nextOptionColor(latest.options?.length ?? 0) };
    const next = (state.doc?.properties ?? properties).map(p => p.id === def.id ? { ...p, options: [...(p.options ?? []), option] } : p);
    return await state.saveSchema({ properties: next, views: state.doc?.views ?? doc.views }) ? option.id : null;
  };
  const setCell = (row: DatabaseRow, def: PropertyDefinition, value: PropertyValue | null) =>
    void state.updateRow(row.id, { properties: { [def.id]: value } });
  const addRow = async () => {
    const row = await state.createRow('', defaultsFromFilters(view, properties));
    if (row && evaluated.rows.length >= limit) setLimit(value => value + 1);
  };
  const addView = () => {
    if (doc.views.length >= databaseViewLimit) return;
    const next: View = { id: crypto.randomUUID(), name: uniqueName('表格', doc.views.map(v => v.name)), type: 'table',
      filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: view.propertyOrder, widths: view.widths };
    void save(properties, [...doc.views, next]);
    selectView(next.id);
  };
  const deleteView = () => {
    const rest = doc.views.filter(v => v.id !== view.id);
    void save(properties, rest);
    selectView(rest[0]!.id);
  };

  const filterChips = view.filters.map((filter, index) => {
    if (isFilterGroup(filter)) return null;
    const def = active.find(p => p.id === filter.propertyId);
    if (!def) return null;
    const optionName = def.options?.find(o => o.id === filter.value)?.name;
    const valueText = operatorNeedsValue(filter.operator) ? (optionName ?? (filter.value === undefined || filter.value === null || filter.value === '' ? '…' : String(filter.value))) : '';
    return <button key={index} className="nb-db-chip" onClick={() => setPanel({ kind: 'filter' })}>
      {def.name} {operatorLabel(def.type, filter.operator)} {valueText}</button>;
  });

  return <div className={`nb-db ${compact ? 'nb-db-compact' : ''}`}>
    {heading}
    <div className="nb-db-bar">
      <ViewTabs views={doc.views} view={view} canWrite={canWrite} open={panel?.kind === 'views'} onOpen={() => setPanel({ kind: 'views' })}
        onClose={closePanel} onSelect={selectView} onAdd={addView} onDelete={deleteView}
        onRename={(id, name) => void save(properties, doc.views.map(v => v.id === id ? { ...v, name } : v))} />
      <div className="nb-db-tools">
        <FilterPanel view={view} active={active} canWrite={canWrite} open={panel?.kind === 'filter'}
          onOpen={() => setPanel({ kind: 'filter' })} onClose={closePanel} onUpdate={patch => void updateView(patch)} />
        <SortPanel view={view} active={active} canWrite={canWrite} open={panel?.kind === 'sort'}
          onOpen={() => setPanel({ kind: 'sort' })} onClose={closePanel} onUpdate={patch => void updateView(patch)} />
        <FieldsPanel view={view} properties={properties} active={active} canWrite={canWrite} open={panel?.kind === 'props'}
          onOpen={() => setPanel({ kind: 'props' })} onClose={closePanel} onUpdate={patch => void updateView(patch)}
          onRestore={id => void save(properties.map(p => p.id === id ? { id: p.id, name: p.name, type: p.type,
            ...(p.options ? { options: p.options } : {}) } : p))} />
        {canWrite && <button className="nb-btn nb-btn-primary nb-db-new" onClick={() => void addRow()}><Icon name="plus" size={14} />新建</button>}
      </div>
    </div>
    {filterChips.some(Boolean) && <div className="nb-db-chips">{filterChips}</div>}
    <TableView source={source} state={state} view={view} columns={evaluated.columns} rows={evaluated.rows.slice(0, limit)}
      allRowCount={doc.rows.length} matchingRowCount={evaluated.rows.length} canAddProperty={active.length < databasePropertyLimit}
      panel={panel} setPanel={setPanel} onUpdateView={patch => void updateView(patch)}
      onSave={(next, views) => void save(next, views)} onAddProperty={addProperty} onCell={setCell} onCreateOption={createOption} />
    <div className="nb-db-foot">
      {canWrite && <button className="nb-db-add-row" onClick={() => void addRow()}><Icon name="plus" size={14} />新建一行</button>}
      <span className="nb-db-count">{evaluated.rows.length === doc.rows.length ? `共 ${doc.rows.length} 行`
        : `显示 ${evaluated.rows.length} / ${doc.rows.length} 行`}</span>
      {evaluated.rows.length > limit && <button className="nb-btn nb-btn-quiet" onClick={() => setLimit(value => value + 200)}>
        再显示 {Math.min(200, evaluated.rows.length - limit)} 行</button>}
      {compact && <button className="nb-btn nb-btn-quiet" onClick={() => source.openDatabase(databaseId)}>打开完整数据库</button>}
    </div>
  </div>;
}

export { OptionTag };
