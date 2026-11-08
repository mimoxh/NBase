import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { activeProperties, databaseColumnWidth, databaseConditionLimit, databasePropertyLimit, databaseViewLimit,
  evaluateView, filterOperatorsFor, operatorNeedsValue, type DatabaseRow, type DatabaseView as View,
  type FilterOperator, type PropertyDefinition, type PropertyType, type PropertyValue, type RowProperties,
  type ViewFilter } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { Popover } from '../components/Popover';
import { EditableCell, OptionTag } from './cells';
import { creatableTypes, nextOptionColor, operatorLabel, typeGlyphs, typeLabels } from './labels';
import { useDatabase, type DatabaseDataSource, type DatabaseState } from './source';
import './database.css';

type Panel = { kind: 'filter' | 'sort' | 'props' | 'add-property' | 'views' } | { kind: 'header'; id: string } | null;

const titleWidth = 280;

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** Values a new row takes so it stays visible under the view's simple equality filters. */
function defaultsFromFilters(view: View, properties: PropertyDefinition[]): RowProperties {
  const values: RowProperties = {};
  for (const filter of view.filters) {
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

function HeaderMenu({ def, view, state, onClose, onSaveProperties }: {
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
      filters: item.filters.filter(f => f.propertyId !== def.id || fits(f)) }));
    onSaveProperties(doc.properties.map(p => p.id === def.id ? next : p), views);
  };
  const remove = () => {
    const views = doc.views.map(item => ({ ...item, filters: item.filters.filter(f => f.propertyId !== def.id),
      sorts: item.sorts.filter(s => s.propertyId !== def.id) }));
    onSaveProperties(doc.properties.map(p => p.id === def.id ? { ...p, deletedAt: new Date().toISOString() } : p), views);
    onClose();
  };
  const sort = (direction: 'asc' | 'desc') => {
    updateView({ sorts: [{ propertyId: def.id, direction }, ...view.sorts.filter(s => s.propertyId !== def.id)]
      .slice(0, Math.max(1, databaseConditionLimit - view.filters.length)) });
    onClose();
  };
  return <Popover label={`字段「${def.name}」`} className="nb-db-pop nb-db-header-pop" portal width={240}
    onClose={() => { commitName(); onClose(); }}>
    <input className="nb-db-input" aria-label="字段名称" value={name} maxLength={100} onChange={event => setName(event.target.value)}
      onBlur={commitName} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { commitName(); onClose(); } }} />
    {def.type !== 'title' && <label className="nb-db-field-row">类型
      <select className="nb-db-select" value={def.type} onChange={event => setType(event.target.value as PropertyType)}>
        {creatableTypes.map(type => <option key={type} value={type}>{typeLabels[type]}</option>)}
      </select></label>}
    <div className="nb-db-menu">
      <button onClick={() => sort('asc')}>升序排列</button>
      <button onClick={() => sort('desc')}>降序排列</button>
      {def.type !== 'title' && <>
        <button disabled={index <= 0} onClick={() => shift(-1)}>向左移动</button>
        <button disabled={index < 0 || index >= columns.length - 1} onClick={() => shift(1)}>向右移动</button>
        <button onClick={() => { updateView({ hiddenPropertyIds: [...view.hiddenPropertyIds, def.id] }); onClose(); }}>在此视图隐藏</button>
        <button className="danger" onClick={remove}>删除字段</button>
      </>}
    </div>
  </Popover>;
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
  const [dragWidth, setDragWidth] = useState<{ id: string; width: number } | null>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [renamingView, setRenamingView] = useState<string | null>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const canWrite = source.canWrite;

  const view = doc ? doc.views.find(item => item.id === (localViewId ?? viewId)) ?? doc.views[0] : undefined;
  const evaluated = useMemo(() => doc && view ? evaluateView(doc.rows, doc.properties, view) : null, [doc, view]);

  if (state.loading && !doc) return <div className="nb-db nb-db-status" role="status">正在读取数据库…</div>;
  if (!doc || !view || !evaluated) return <div className="nb-db nb-db-status" role="alert">{state.error || '数据库暂时无法读取。'}
    <button className="nb-btn nb-btn-quiet" onClick={() => void state.reload()}>重试</button></div>;

  const properties = doc.properties;
  const active = activeProperties(properties);
  const deleted = properties.filter(p => p.deletedAt);
  const save = (nextProperties: PropertyDefinition[], nextViews: View[] = doc.views) =>
    state.saveSchema({ properties: nextProperties, views: nextViews });
  const updateView = (patch: Partial<View>) => save(properties, doc.views.map(item => item.id === view.id ? { ...item, ...patch } : item));
  const selectView = (id: string) => { setLocalViewId(id); onViewChange?.(id); };
  const widthOf = (def: PropertyDefinition) => dragWidth?.id === def.id ? dragWidth.width
    : view.widths[def.id] ?? (def.type === 'title' ? titleWidth : databaseColumnWidth.default);
  const manualOrder = view.sorts.length === 0 && canWrite;
  const conditions = view.filters.length + view.sorts.length;

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
  const startResize = (event: ReactPointerEvent<HTMLSpanElement>, def: PropertyDefinition) => {
    if (!canWrite) return;
    event.preventDefault(); event.stopPropagation();
    resizeStart.current = { x: event.clientX, width: widthOf(def) };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let latest = widthOf(def);
    const move = (moveEvent: PointerEvent) => {
      if (!resizeStart.current) return;
      latest = Math.round(Math.max(databaseColumnWidth.min, Math.min(databaseColumnWidth.max,
        resizeStart.current.width + moveEvent.clientX - resizeStart.current.x)));
      setDragWidth({ id: def.id, width: latest });
    };
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up);
      resizeStart.current = null; setDragWidth(null);
      if (latest !== widthOf(def)) updateView({ widths: { ...view.widths, [def.id]: latest } });
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
  };

  const visibleRows = evaluated.rows.slice(0, limit);
  const filterChips = view.filters.map((filter, index) => {
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
      <div className="nb-db-views" role="tablist" aria-label="视图">
        {doc.views.map(item => renamingView === item.id
          ? <input key={item.id} className="nb-db-input nb-db-view-input" autoFocus defaultValue={item.name} aria-label="视图名称" maxLength={100}
            onBlur={event => { const name = event.target.value.trim(); setRenamingView(null);
              if (name && name !== item.name) void save(properties, doc.views.map(v => v.id === item.id ? { ...v, name } : v)); }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); if (event.key === 'Escape') setRenamingView(null); }} />
          : <button key={item.id} role="tab" aria-selected={item.id === view.id} className={`nb-db-view-tab ${item.id === view.id ? 'active' : ''}`}
            onClick={() => selectView(item.id)} onDoubleClick={() => canWrite && setRenamingView(item.id)}>
            <Icon name="table" size={13} />{item.name}</button>)}
        {canWrite && <span className="nb-db-anchor">
          <button className="nb-db-tool" aria-label="视图设置" onClick={() => setPanel({ kind: 'views' })}><Icon name="more" size={14} /></button>
          {panel?.kind === 'views' && <Popover label="视图设置" className="nb-db-pop" onClose={() => setPanel(null)}>
            <div className="nb-db-menu">
              <button onClick={() => { setRenamingView(view.id); setPanel(null); }}>重命名当前视图</button>
              <button disabled={doc.views.length >= databaseViewLimit} onClick={() => { addView(); setPanel(null); }}>新建表格视图</button>
              <button className="danger" disabled={doc.views.length <= 1} onClick={() => {
                const rest = doc.views.filter(v => v.id !== view.id);
                void save(properties, rest); selectView(rest[0]!.id); setPanel(null);
              }}>删除当前视图</button>
            </div>
          </Popover>}
        </span>}
      </div>
      <div className="nb-db-tools">
        <span className="nb-db-anchor">
          <button className={`nb-db-tool ${view.filters.length ? 'on' : ''}`} onClick={() => setPanel({ kind: 'filter' })}>
            <Icon name="filter" size={14} />筛选{view.filters.length ? ` ${view.filters.length}` : ''}</button>
          {panel?.kind === 'filter' && <Popover label="筛选" className="nb-db-pop nb-db-wide-pop" onClose={() => setPanel(null)}>
            {view.filters.length === 0 && <p className="nb-db-empty-note">还没有筛选条件。所有条件需同时满足。</p>}
            {view.filters.map((filter, index) => {
              const def = active.find(p => p.id === filter.propertyId);
              if (!def) return null;
              const replace = (next: ViewFilter | null) => updateView({ filters: next
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
              updateView({ filters: [...view.filters, { propertyId: def.id, operator: filterOperatorsFor(def.type)[0]! }] });
            }}><Icon name="plus" size={13} /> 添加条件</button>}
          </Popover>}
        </span>
        <span className="nb-db-anchor">
          <button className={`nb-db-tool ${view.sorts.length ? 'on' : ''}`} onClick={() => setPanel({ kind: 'sort' })}>
            <Icon name="sort" size={14} />排序{view.sorts.length ? ` ${view.sorts.length}` : ''}</button>
          {panel?.kind === 'sort' && <Popover label="排序" className="nb-db-pop nb-db-wide-pop" onClose={() => setPanel(null)}>
            {view.sorts.length === 0 && <p className="nb-db-empty-note">按手动顺序显示。添加排序后，拖动排序将停用。</p>}
            {view.sorts.map((sort, index) => <div key={index} className="nb-db-condition">
              <select className="nb-db-select" aria-label="排序字段" value={sort.propertyId} disabled={!canWrite}
                onChange={event => updateView({ sorts: view.sorts.map((s, i) => i === index ? { ...s, propertyId: event.target.value } : s) })}>
                {active.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <select className="nb-db-select" aria-label="排序方向" value={sort.direction} disabled={!canWrite}
                onChange={event => updateView({ sorts: view.sorts.map((s, i) => i === index ? { ...s, direction: event.target.value as 'asc' | 'desc' } : s) })}>
                <option value="asc">升序</option><option value="desc">降序</option></select>
              {canWrite && <button className="nb-db-tool" aria-label="删除排序" onClick={() => updateView({ sorts: view.sorts.filter((_, i) => i !== index) })}>
                <Icon name="close" size={13} /></button>}
            </div>)}
            {canWrite && <button className="nb-btn nb-btn-quiet" disabled={conditions >= databaseConditionLimit} onClick={() => {
              const used = new Set(view.sorts.map(s => s.propertyId));
              const def = active.find(p => !used.has(p.id)) ?? active[0]!;
              updateView({ sorts: [...view.sorts, { propertyId: def.id, direction: 'asc' }] });
            }}><Icon name="plus" size={13} /> 添加排序</button>}
          </Popover>}
        </span>
        <span className="nb-db-anchor">
          <button className="nb-db-tool" onClick={() => setPanel({ kind: 'props' })}><Icon name="settings" size={14} />字段</button>
          {panel?.kind === 'props' && <Popover label="字段" className="nb-db-pop" onClose={() => setPanel(null)}>
            <div className="nb-db-prop-list">
              {active.map(def => <label key={def.id} className="nb-db-prop-row">
                <input type="checkbox" disabled={!canWrite || def.type === 'title'} checked={!view.hiddenPropertyIds.includes(def.id)}
                  onChange={event => updateView({ hiddenPropertyIds: event.target.checked
                    ? view.hiddenPropertyIds.filter(id => id !== def.id) : [...view.hiddenPropertyIds, def.id] })} />
                <span className="nb-db-glyph">{typeGlyphs[def.type]}</span>{def.name}</label>)}
            </div>
            {deleted.length > 0 && <>
              <div className="nb-db-subhead">已删除的字段</div>
              {deleted.map(def => <div key={def.id} className="nb-db-prop-row">
                <span className="nb-db-glyph">{typeGlyphs[def.type]}</span><span className="nb-db-grow">{def.name}</span>
                {canWrite && <button className="nb-btn nb-btn-quiet" disabled={active.length >= databasePropertyLimit}
                  onClick={() => void save(properties.map(p => p.id === def.id ? { id: p.id, name: p.name, type: p.type,
                    ...(p.options ? { options: p.options } : {}) } : p))}>恢复</button>}
              </div>)}
            </>}
          </Popover>}
        </span>
        {canWrite && <button className="nb-btn nb-btn-primary nb-db-new" onClick={() => void addRow()}><Icon name="plus" size={14} />新建</button>}
      </div>
    </div>
    {filterChips.some(Boolean) && <div className="nb-db-chips">{filterChips}</div>}
    <div className="nb-db-scroll">
      <table className="nb-db-table" style={{ width: evaluated.columns.reduce((sum, def) => sum + widthOf(def), 0) + (canWrite ? 76 : 36) }}>
        <colgroup>
          <col style={{ width: 36 }} />
          {evaluated.columns.map(def => <col key={def.id} style={{ width: widthOf(def) }} />)}
          {canWrite && <col style={{ width: 40 }} />}
        </colgroup>
        <thead><tr>
          <th className="nb-db-gutter" aria-label="行操作" />
          {evaluated.columns.map(def => <th key={def.id} scope="col">
            <span className="nb-db-anchor nb-db-th">
              <button className="nb-db-th-button" disabled={!canWrite} onClick={() => setPanel({ kind: 'header', id: def.id })}>
                <span className="nb-db-glyph">{typeGlyphs[def.type]}</span><span className="nb-db-th-name">{def.name}</span>
                {view.sorts.some(s => s.propertyId === def.id) && <span className="nb-db-sorted">
                  {view.sorts.find(s => s.propertyId === def.id)!.direction === 'asc' ? '↑' : '↓'}</span>}
              </button>
              {panel?.kind === 'header' && panel.id === def.id && <HeaderMenu def={def} view={view} state={state}
                onClose={() => setPanel(null)} onSaveProperties={(next, views) => void save(next, views)} />}
            </span>
            {canWrite && <span className="nb-db-resize" role="separator" aria-orientation="vertical" aria-label={`调整「${def.name}」列宽`}
              onPointerDown={event => startResize(event, def)} />}
          </th>)}
          {canWrite && <th className="nb-db-add-col">
            <span className="nb-db-anchor">
              <button className="nb-db-tool" aria-label="添加字段" disabled={active.length >= databasePropertyLimit}
                onClick={() => setPanel({ kind: 'add-property' })}><Icon name="plus" size={14} /></button>
              {panel?.kind === 'add-property' && <Popover label="添加字段" className="nb-db-pop" portal width={200} onClose={() => setPanel(null)}>
                <div className="nb-db-menu">{creatableTypes.map(type => <button key={type} onClick={() => addProperty(type)}>
                  <span className="nb-db-glyph">{typeGlyphs[type]}</span>{typeLabels[type]}</button>)}</div>
              </Popover>}
            </span>
          </th>}
        </tr></thead>
        <tbody>
          {visibleRows.map((row, index) => <tr key={row.id}
            className={`${dropRow === row.id ? 'nb-db-drop' : ''} ${dragRow === row.id ? 'nb-db-dragging' : ''}`}
            onDragOver={event => { if (!dragRow || dragRow === row.id) return; event.preventDefault(); setDropRow(row.id); }}
            onDragLeave={() => setDropRow(previous => previous === row.id ? null : previous)}
            onDrop={event => {
              event.preventDefault();
              const moving = dragRow;
              setDragRow(null); setDropRow(null);
              if (!moving || moving === row.id) return;
              // Dropping on a row below puts the moved row after it; on a row above, before it.
              const order = doc.rows.map(item => item.id);
              const from = order.indexOf(moving);
              const to = order.indexOf(row.id);
              void state.moveRow(moving, from < to ? row.id : order[to - 1] ?? null);
            }}>
            <td className="nb-db-gutter">
              <span className="nb-db-row-actions">
                {manualOrder && <span className="nb-db-handle" draggable aria-label="拖动调整行顺序" title="拖动调整顺序"
                  onDragStart={event => { setDragRow(row.id); event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-nbase-row', row.id); }}
                  onDragEnd={() => { setDragRow(null); setDropRow(null); }}>⋮⋮</span>}
                {!manualOrder && <span className="nb-db-index">{index + 1}</span>}
              </span>
            </td>
            {evaluated.columns.map(def => {
              const pendingKey = `${row.id}:${def.type === 'title' ? 'title' : def.id}`;
              return <td key={def.id} className={`nb-db-cell nb-db-type-${def.type} ${state.pending.has(pendingKey) ? 'pending' : ''}`}>
                <span className="nb-db-anchor nb-db-cell-inner">
                  <EditableCell row={row} def={def} editable={canWrite}
                    onChange={value => setCell(row, def, value)}
                    onTitle={title => void state.updateRow(row.id, { title: title.slice(0, 255) })}
                    onCreateOption={canWrite ? createOption(def) : undefined} />
                  {def.type === 'title' && <button className="nb-db-open" onClick={() => source.openRow(row.id)}>打开</button>}
                </span>
              </td>;
            })}
            {canWrite && <td className="nb-db-row-end">
              <button className="nb-db-tool nb-db-row-delete" aria-label={`删除「${row.title || '未命名'}」`} title="移入回收站"
                onClick={() => void state.trashRow(row.id)}><Icon name="trash" size={13} /></button>
            </td>}
          </tr>)}
        </tbody>
      </table>
      {!evaluated.rows.length && <p className="nb-db-empty-note nb-db-empty-rows">
        {doc.rows.length ? '没有符合筛选条件的行。' : canWrite ? '还没有内容，点击「新建」添加第一行。' : '还没有内容。'}</p>}
    </div>
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
