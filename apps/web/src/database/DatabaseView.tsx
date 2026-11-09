import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { activeProperties, databasePropertyLimit, databaseViewLimit, effectiveType, isCalendarProperty, isComputedProperty, isFilterGroup, isGroupableProperty, localDay, operatorNeedsValue, viewColumns, type DatabaseQueryRequest, type DatabaseRow,
  type DatabaseView as View, type DatabaseViewType, type PropertyDefinition, type PropertyType, type PropertyValue, type QueryContext, type RelativeDateToken, type RowProperties, type ViewFilter } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { AddRelationDialog } from './AddRelationDialog';
import { BulkBar } from './BulkBar';
import { OptionTag } from './cells';
import { TableView } from './grid/TableView';
import { DataMenu } from './io/DataMenu';
import { monthBounds, nextOptionColor, operatorLabel, relativeDateLabels, typeLabels } from './labels';
import type { Panel } from './panel';
import { useRowStore } from './rowStore';
import { announceDatabaseChange, useDatabase, type DatabaseDataSource } from './source';
import { FieldsPanel } from './toolbar/FieldsPanel';
import { FilterPanel } from './toolbar/FilterPanel';
import { SortPanel } from './toolbar/SortPanel';
import { ViewTabs } from './toolbar/ViewTabs';
import './database.css';

const BoardView = lazy(() => import('./views/BoardView'));
const CalendarView = lazy(() => import('./views/CalendarView'));

const readerContext: Pick<QueryContext, 'timeZone' | 'weekStart'> = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekStart: 1 };

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
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(new Set());
  const canWrite = source.canWrite;

  const view = doc ? doc.views.find(item => item.id === (localViewId ?? viewId)) ?? doc.views[0] : undefined;
  const [month, setMonth] = useState(() => localDay(new Date()).slice(0, 7));
  const activeDefs = doc ? activeProperties(doc.properties) : [];
  const groupDef = view?.type === 'board' ? activeDefs.find(p => p.id === view.groupPropertyId && isGroupableProperty(p)) : undefined;
  const dateDef = view?.type === 'calendar' ? activeDefs.find(p => p.id === view.datePropertyId && isCalendarProperty(p)) : undefined;
  const request = useMemo<DatabaseQueryRequest | null>(() => {
    if (!view) return null;
    if (dateDef) {
      const { first, last } = monthBounds(month);
      return { filters: [...view.filters, { propertyId: dateDef.id, operator: 'gte', value: first }, { propertyId: dateDef.id, operator: 'lte', value: last }],
        sorts: view.sorts, context: readerContext };
    }
    return { filters: view.filters, sorts: view.sorts, context: readerContext, ...(groupDef ? { groupBy: groupDef.id } : {}) };
  }, [view?.filters, view?.sorts, groupDef?.id, dateDef?.id, month]); // eslint-disable-line react-hooks/exhaustive-deps
  const titlePropertyId = doc?.properties.find(p => p.type === 'title')?.id ?? null;
  const computedIds = activeDefs.filter(isComputedProperty).map(p => p.id).join();
  const store = useRowStore(source, databaseId, request, titlePropertyId, computedIds);

  if (state.loading && !doc) return <div className="nb-db nb-db-status" role="status">正在读取数据库…</div>;
  if (!doc || !view) return <div className="nb-db nb-db-status" role="alert">{state.error || '数据库暂时无法读取。'}
    <button className="nb-btn nb-btn-quiet" onClick={() => void state.reload()}>重试</button></div>;
  const columns = viewColumns(doc.properties, view);

  const properties = doc.properties;
  const active = activeProperties(properties);
  const save = (nextProperties: PropertyDefinition[], nextViews: View[] = doc.views) =>
    state.saveSchema({ properties: nextProperties, views: nextViews });
  const updateView = (patch: Partial<View>) => save(properties, doc.views.map(item => item.id === view.id ? { ...item, ...patch } : item));
  const selectView = (id: string) => { setLocalViewId(id); setSelectedRows(new Set()); onViewChange?.(id); };
  const closePanel = () => setPanel(null);
  const openData = () => setPanel({ kind: 'data' });

  const addProperty = (type: PropertyType) => {
    if (active.length >= databasePropertyLimit) return;
    const firstRelation = active.find(p => p.type === 'relation');
    const def: PropertyDefinition = { id: crypto.randomUUID(), name: uniqueName(typeLabels[type], active.map(p => p.name)), type,
      ...(type === 'select' || type === 'multi_select' ? { options: [] } : {}),
      ...(type === 'formula' ? { formula: { expression: '', resultType: 'text' as const } } : {}),
      // Starts as a count of linked rows, which needs no target field; the header menu refines it.
      ...(type === 'rollup' && firstRelation ? { rollup: { relationPropertyId: firstRelation.id, targetPropertyId: firstRelation.id, fn: 'count' as const, resultType: 'number' as const } } : {}) };
    void save([...properties, def], doc.views.map(item => item.id === view.id
      ? { ...item, propertyOrder: [...columns.filter(p => p.type !== 'title').map(p => p.id), def.id] } : item));
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
    void store.updateRow(row.id, { properties: { [def.id]: value } });
  const addRow = async () => {
    const row = await store.createRow('', defaultsFromFilters(view, properties));
    if (row && store.total > limit) setLimit(value => value + 1);
  };
  const addView = (type: DatabaseViewType) => {
    if (doc.views.length >= databaseViewLimit) return;
    const next: View = { id: crypto.randomUUID(), name: uniqueName({ table: '表格', board: '看板', calendar: '日历' }[type], doc.views.map(v => v.name)), type,
      filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: view.propertyOrder, widths: view.widths,
      ...(type === 'board' ? { groupPropertyId: active.find(isGroupableProperty)!.id } : {}),
      ...(type === 'calendar' ? { datePropertyId: active.find(p => p.type === 'date')?.id ?? active.find(isCalendarProperty)!.id } : {}) };
    void save(properties, [...doc.views, next]);
    selectView(next.id);
  };
  const deleteView = () => {
    const rest = doc.views.filter(v => v.id !== view.id);
    void save(properties, rest);
    selectView(rest[0]!.id);
  };

  const conditionText = (filter: ViewFilter) => {
    const def = active.find(p => p.id === filter.propertyId);
    if (!def) return null;
    const optionName = def.options?.find(o => o.id === filter.value)?.name;
    const relative = typeof filter.value === 'string' && filter.value.startsWith('@') ? relativeDateLabels[filter.value.slice(1) as RelativeDateToken] : undefined;
    const valueText = operatorNeedsValue(filter.operator) ? (optionName ?? relative ?? (filter.value === undefined || filter.value === null || filter.value === '' ? '…' : String(filter.value))) : '';
    return `${def.name} ${operatorLabel(effectiveType(def), filter.operator)} ${valueText}`.trim();
  };
  const filterChips = view.filters.map((entry, index) => {
    const text = (isFilterGroup(entry) ? entry.any : [entry]).map(conditionText).filter(Boolean).join(' 或 ');
    return text ? <button key={index} className="nb-db-chip" onClick={() => setPanel({ kind: 'filter' })}>{text}</button> : null;
  });

  return <div className={`nb-db ${compact ? 'nb-db-compact' : ''}`}>
    {heading}
    <div className="nb-db-bar">
      <ViewTabs views={doc.views} view={view} canWrite={canWrite} canBoard={active.some(isGroupableProperty)} canCalendar={active.some(isCalendarProperty)} open={panel?.kind === 'views'} onOpen={() => setPanel({ kind: 'views' })}
        onClose={closePanel} onSelect={selectView} onAdd={addView} onDelete={deleteView}
        onRename={(id, name) => void save(properties, doc.views.map(v => v.id === id ? { ...v, name } : v))} />
      <div className="nb-db-tools">
        {view.type === 'board' && <label className="nb-db-field-row">分组
          <select className="nb-db-select" aria-label="看板分组字段" disabled={!canWrite} value={groupDef?.id ?? ''} onChange={event => void updateView({ groupPropertyId: event.target.value })}>
            {!groupDef && <option value="">选择字段</option>}
            {active.filter(isGroupableProperty).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>}
        {view.type === 'calendar' && <label className="nb-db-field-row">日期
          <select className="nb-db-select" aria-label="日历日期字段" disabled={!canWrite} value={dateDef?.id ?? ''} onChange={event => void updateView({ datePropertyId: event.target.value })}>
            {!dateDef && <option value="">选择字段</option>}
            {active.filter(isCalendarProperty).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>}
        <FilterPanel view={view} active={active} canWrite={canWrite} open={panel?.kind === 'filter'}
          onOpen={() => setPanel({ kind: 'filter' })} onClose={closePanel} onUpdate={patch => void updateView(patch)} />
        <SortPanel view={view} active={active} canWrite={canWrite} open={panel?.kind === 'sort'}
          onOpen={() => setPanel({ kind: 'sort' })} onClose={closePanel} onUpdate={patch => void updateView(patch)} />
        <FieldsPanel view={view} properties={properties} active={active} canWrite={canWrite} open={panel?.kind === 'props'}
          onOpen={() => setPanel({ kind: 'props' })} onClose={closePanel} onUpdate={patch => void updateView(patch)}
          onRestore={id => void save(properties.map(p => p.id === id ? { id: p.id, name: p.name, type: p.type,
            ...(p.options ? { options: p.options } : {}), ...(p.relation ? { relation: p.relation } : {}) } : p))} />
        {!compact && <DataMenu source={source} state={state} store={store} doc={doc} view={view} databaseId={databaseId} canWrite={canWrite}
          open={panel?.kind === 'data'} onOpen={openData} onClose={closePanel} />}
        {canWrite && <button className="nb-btn nb-btn-primary nb-db-new" onClick={() => void addRow()}><Icon name="plus" size={14} />新建</button>}
      </div>
    </div>
    {filterChips.some(Boolean) && <div className="nb-db-chips">{filterChips}</div>}
    {view.type === 'table' && canWrite && selectedRows.size > 0 && <BulkBar store={store} properties={properties} selected={selectedRows} canSort={view.sorts.length === 0}
      onClear={() => setSelectedRows(new Set())} notice={source.notice} />}
    {store.error && <div className="nb-db-status" role="alert">{store.error}
      <button className="nb-btn nb-btn-quiet" onClick={() => void store.refresh()}>重试</button></div>}
    {view.type === 'board' && (groupDef ? <Suspense fallback={null}><BoardView source={source} store={store} doc={doc} view={view} group={groupDef} canWrite={canWrite} /></Suspense>
      : <p className="nb-db-empty-note">请先选择用于分组的单选或复选框字段。</p>)}
    {view.type === 'calendar' && (dateDef ? <Suspense fallback={null}><CalendarView source={source} store={store} month={month} onMonth={setMonth} dateField={dateDef} canWrite={canWrite} /></Suspense>
      : <p className="nb-db-empty-note">请先选择日期字段。</p>)}
    {view.type === 'table' && <TableView source={source} state={state} store={store} view={view} columns={columns} request={request!}
      rowCount={compact ? Math.min(limit, store.total) : store.total} windowed={!compact} canAddProperty={active.length < databasePropertyLimit}
      panel={panel} setPanel={setPanel} selected={selectedRows} onSelect={setSelectedRows} onUpdateView={patch => void updateView(patch)}
      onSave={(next, views) => void save(next, views)} onAddProperty={addProperty} onCell={setCell} onCreateOption={createOption} />}
    {panel?.kind === 'add-relation' && <AddRelationDialog source={source} doc={doc} onClose={closePanel} onCreated={other => {
      closePanel();
      void state.reload().then(() => { void store.refresh(); });
      announceDatabaseChange(other);
    }} />}
    <div className="nb-db-foot">
      {canWrite && view.type === 'table' && <button className="nb-db-add-row" onClick={() => void addRow()}><Icon name="plus" size={14} />新建一行</button>}
      <span className="nb-db-count">{store.loading ? '正在读取…' : store.total === store.allRows ? `共 ${store.allRows} 行`
        : `显示 ${store.total} / ${store.allRows} 行`}</span>
      {store.computing && <span role="status">公式和汇总计算中，结果可能暂时不准</span>}
      {store.orderStale && <button className="nb-btn nb-btn-quiet" onClick={() => void store.refresh()}>结果可能已变化，刷新</button>}
      {compact && store.total > limit && <button className="nb-btn nb-btn-quiet" onClick={() => setLimit(value => value + 200)}>
        再显示 {Math.min(200, store.total - limit)} 行</button>}
      {compact && <button className="nb-btn nb-btn-quiet" onClick={() => source.openDatabase(databaseId)}>打开完整数据库</button>}
    </div>
  </div>;
}

export { OptionTag };
