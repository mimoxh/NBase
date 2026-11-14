import { useEffect, useRef, useState } from 'react';
import type { DatabaseQueryRequest, DatabaseRow, DatabaseView as View, PropertyDefinition, PropertyType, PropertyValue } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { EditableCell } from '../cells';
import { HeaderMenu } from '../HeaderMenu';
import { creatableTypes, typeGlyphs, typeLabels } from '../labels';
import type { Panel } from '../panel';
import type { RowStore } from '../rowStore';
import type { DatabaseDataSource, DatabaseState } from '../source';
import { useDatabaseTags } from '../tags';
import { AggregateBar } from './AggregateBar';
import { useColumnResize } from './useColumnResize';
import { useGrid } from './useGrid';
import { rowHeight, useWindowedRows } from './useWindowedRows';

export function TableView({ source, state, store, view, columns, rowCount, windowed, canAddProperty, panel, setPanel, request, selected, onSelect,
  onUpdateView, onSave, onAddProperty, onCell, onCreateOption }: {
  source: DatabaseDataSource; state: DatabaseState; store: RowStore; view: View; columns: PropertyDefinition[];
  /** How many rows of the view to show. */
  rowCount: number; windowed: boolean; canAddProperty: boolean; panel: Panel; setPanel: (panel: Panel) => void;
  request: DatabaseQueryRequest;
  selected: ReadonlySet<string>; onSelect: (next: ReadonlySet<string>) => void;
  onUpdateView: (patch: Partial<View>) => void;
  onSave: (properties: PropertyDefinition[], views?: View[]) => void;
  onAddProperty: (type: PropertyType) => void;
  onCell: (row: DatabaseRow, def: PropertyDefinition, value: PropertyValue | null) => void;
  onCreateOption: (def: PropertyDefinition) => (name: string) => Promise<string | null>;
}) {
  const canWrite = source.canWrite;
  const tagHost = useDatabaseTags();
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const { widthOf, startResize } = useColumnResize(view, canWrite, widths => onUpdateView({ widths }));
  const { anchor, start, end } = useWindowedRows(rowCount, windowed);
  useEffect(() => { store.ensure(start, end); }, [store, start, end, store.order]);
  const rootRef = useRef<HTMLDivElement>(null);
  const grid = useGrid({ store, columns, rowCount, canWrite, notice: source.notice, rootRef, bodyRef: anchor });
  const lastTicked = useRef<number | null>(null);
  const tick = (index: number, id: string, shift: boolean) => {
    const next = new Set(selected);
    if (shift && lastTicked.current !== null) {
      const [from, to] = [Math.min(lastTicked.current, index), Math.max(lastTicked.current, index)];
      store.order.slice(from, to + 1).forEach(item => next.add(item));
    } else if (next.has(id)) next.delete(id); else next.add(id);
    lastTicked.current = index;
    onSelect(next);
  };
  const allSelected = store.total > 0 && store.order.every(id => selected.has(id));
  const inRange = (row: number, col: number) => !!grid.range && row >= grid.range.top && row <= grid.range.bottom
    && col >= grid.range.left && col <= grid.range.right;
  const gutterWidth = canWrite ? 52 : 36;
  const frozenCount = Math.min(view.frozenColumns ?? 0, columns.length);
  const frozenLeft = (index: number) => gutterWidth + columns.slice(0, index).reduce((sum, def) => sum + widthOf(def), 0);
  const frozenClass = (index: number) => index < frozenCount ? `nb-db-frozen ${index === frozenCount - 1 ? 'nb-db-frozen-last' : ''}` : '';
  const frozenStyle = (index: number) => index < frozenCount ? { left: frozenLeft(index) } : undefined;
  const gutterClass = `nb-db-gutter ${frozenCount ? 'nb-db-frozen' : ''}`;
  const gutterStyle = frozenCount ? { left: 0 } : undefined;
  const aggregateBar = useRef<HTMLDivElement>(null);
  const manualOrder = view.sorts.length === 0 && canWrite;
  const columnCount = columns.length + (canWrite ? 2 : 1);
  const spacer = (height: number) => height > 0 && <tr aria-hidden="true" className="nb-db-spacer" style={{ height }}><td colSpan={columnCount} /></tr>;
  const visible = store.order.slice(start, end).map((id, offset) => ({ id, index: start + offset, row: store.rowAt(start + offset) }));
  return <><div className="nb-db-scroll" ref={rootRef} onClickCapture={grid.clickCapture}
    onScroll={event => { if (aggregateBar.current) aggregateBar.current.scrollLeft = event.currentTarget.scrollLeft; }}>
    <input ref={grid.sinkRef} className="nb-db-sink" aria-label="表格单元格：方向键移动，回车编辑，直接输入可替换内容" autoComplete="off" spellCheck={false} {...grid.sinkProps} />
    <table className="nb-db-table" style={{ width: columns.reduce((sum, def) => sum + widthOf(def), 0) + (canWrite ? 92 : 36) }}>
      <colgroup>
        <col style={{ width: gutterWidth }} />
        {columns.map(def => <col key={def.id} style={{ width: widthOf(def) }} />)}
        {canWrite && <col style={{ width: 56 }} />}
      </colgroup>
      <thead><tr>
        <th className={gutterClass} style={gutterStyle} aria-label="行操作">
          {canWrite && <input type="checkbox" className="nb-db-row-check nb-db-row-check-all" aria-label="选择全部行" checked={allSelected}
            onChange={event => onSelect(event.target.checked ? new Set(store.order) : new Set())} />}
        </th>
        {columns.map((def, col) => <th key={def.id} scope="col" className={frozenClass(col)} style={frozenStyle(col)}>
          <span className="nb-db-anchor nb-db-th">
            <button className="nb-db-th-button" disabled={!canWrite} onClick={() => setPanel({ kind: 'header', id: def.id })}>
              <span className="nb-db-glyph">{typeGlyphs[def.type]}</span><span className="nb-db-th-name">{def.name}</span>
              {view.sorts.some(s => s.propertyId === def.id) && <span className="nb-db-sorted">
                {view.sorts.find(s => s.propertyId === def.id)!.direction === 'asc' ? '↑' : '↓'}</span>}
            </button>
            {panel?.kind === 'header' && panel.id === def.id && <HeaderMenu def={def} view={view} state={state} source={source}
              onClose={() => setPanel(null)} onSaveProperties={onSave} />}
          </span>
          {canWrite && <span className="nb-db-resize" role="separator" aria-orientation="vertical" aria-label={`调整「${def.name}」列宽`}
            onPointerDown={event => startResize(event, def)} />}
        </th>)}
        {canWrite && <th className="nb-db-add-col">
          <span className="nb-db-anchor">
            <button className="nb-db-tool" aria-label="添加字段" disabled={!canAddProperty}
              onClick={() => setPanel({ kind: 'add-property' })}><Icon name="plus" size={14} /></button>
            {panel?.kind === 'add-property' && <Popover label="添加字段" className="nb-db-pop" portal width={200} onClose={() => setPanel(null)}>
              <div className="nb-db-menu">{creatableTypes.map(type => <button key={type} onClick={() => onAddProperty(type)}>
                <span className="nb-db-glyph">{typeGlyphs[type]}</span>{typeLabels[type]}</button>)}
                <button onClick={() => setPanel({ kind: 'add-relation' })}><span className="nb-db-glyph">{typeGlyphs.relation}</span>{typeLabels.relation}…</button>
                <button onClick={() => onAddProperty('formula')}><span className="nb-db-glyph">{typeGlyphs.formula}</span>{typeLabels.formula}</button>
                <button disabled={!state.doc?.properties.some(p => p.type === 'relation' && !p.deletedAt)} title="需要先添加关联字段" onClick={() => onAddProperty('rollup')}>
                  <span className="nb-db-glyph">{typeGlyphs.rollup}</span>{typeLabels.rollup}</button>
                {tagHost && <button disabled={state.doc?.properties.some(p => p.type === 'tags' && !p.deletedAt)} title="显示并修改页面的工作区标签；每个数据库一个"
                  onClick={() => onAddProperty('tags')}><span className="nb-db-glyph">{typeGlyphs.tags}</span>{typeLabels.tags}</button>}</div>
            </Popover>}
          </span>
        </th>}
      </tr></thead>
      <tbody ref={anchor}>
        {spacer(start * rowHeight)}
        {visible.map(({ id, index, row }) => !row
          ? <tr key={id} className="nb-db-row-loading" aria-busy="true" style={{ height: rowHeight }}><td colSpan={columnCount} /></tr>
          : <tr key={id}
          className={`${dropRow === row.id ? 'nb-db-drop' : ''} ${dragRow === row.id ? 'nb-db-dragging' : ''} ${selected.has(row.id) ? 'nb-db-row-selected' : ''}`}
          onDragOver={event => { if (!dragRow || dragRow === row.id) return; event.preventDefault(); setDropRow(row.id); }}
          onDragLeave={() => setDropRow(previous => previous === row.id ? null : previous)}
          onDrop={event => {
            event.preventDefault();
            const moving = dragRow;
            setDragRow(null); setDropRow(null);
            if (!moving || moving === row.id) return;
            // Dropping on a row below puts the moved row after it; on a row above, before it.
            const order = store.order;
            const from = order.indexOf(moving);
            const to = order.indexOf(row.id);
            void store.moveRow(moving, from < to ? row.id : order[to - 1] ?? null);
          }}>
          <td className={gutterClass} style={gutterStyle}>
            <span className="nb-db-row-actions">
              {canWrite && <input type="checkbox" className="nb-db-row-check" aria-label={`选择「${row.title || '未命名'}」`} checked={selected.has(row.id)}
                onChange={() => undefined} onClick={event => tick(index, row.id, event.shiftKey)} />}
              {manualOrder && <span className="nb-db-handle" draggable aria-label="拖动调整行顺序" title="拖动调整顺序"
                onDragStart={event => { setDragRow(row.id); event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-nbase-row', row.id); }}
                onDragEnd={() => { setDragRow(null); setDropRow(null); }}>⋮⋮</span>}
              {!manualOrder && <span className="nb-db-index">{index + 1}</span>}
            </span>
          </td>
          {columns.map((def, col) => {
            const pendingKey = `${row.id}:${def.type === 'title' ? 'title' : def.id}`;
            const point = { row: index, col };
            const cursor = grid.focus?.row === index && grid.focus.col === col;
            return <td key={def.id} data-r={index} data-c={col} aria-selected={inRange(index, col)} style={frozenStyle(col)}
              onMouseDown={event => grid.cellMouseDown(event, point)} onMouseEnter={event => grid.cellMouseEnter(event, point)}
              className={`nb-db-cell nb-db-type-${def.type} ${frozenClass(col)} ${store.pending.has(pendingKey) ? 'pending' : ''} ${inRange(index, col) ? 'nb-db-in-range' : ''} ${cursor ? 'nb-db-cursor' : ''}`}>
              <span className="nb-db-anchor nb-db-cell-inner">
                <EditableCell row={row} def={def} editable={canWrite} onNavigate={grid.navigate}
                  relationHost={{ source, databaseId: store.databaseId, change: (add, remove) => store.changeRelation(row.id, def.id, add, remove) }}
                  onChange={value => onCell(row, def, value)}
                  onTitle={title => void store.updateRow(row.id, { title: title.slice(0, 255) })}
                  onCreateOption={canWrite ? onCreateOption(def) : undefined} />
                {def.type === 'title' && <button className="nb-db-open" onClick={() => source.openRow(row.id)}>打开</button>}
              </span>
            </td>;
          })}
          {canWrite && <td className="nb-db-row-end">
            <button className="nb-db-tool nb-db-row-delete" aria-label={`复制「${row.title || '未命名'}」`} title="复制这一行"
              onClick={() => void store.duplicateRows([row.id], manualOrder)}><Icon name="copy" size={13} /></button>
            <button className="nb-db-tool nb-db-row-delete" aria-label={`删除「${row.title || '未命名'}」`} title="移入回收站"
              onClick={() => void store.trashRow(row.id)}><Icon name="trash" size={13} /></button>
          </td>}
        </tr>)}
        {spacer((rowCount - end) * rowHeight)}
      </tbody>
    </table>
    {!store.total && !store.loading && <p className="nb-db-empty-note nb-db-empty-rows">
      {store.allRows ? '没有符合筛选条件的行。' : canWrite ? '还没有内容，点击「新建」添加第一行。' : '还没有内容。'}</p>}
  </div>
  <AggregateBar source={source} databaseId={store.databaseId} request={request} view={view} columns={columns} canWrite={canWrite} version={store.getVersion()}
    gutter={gutterWidth} end={canWrite ? 96 : 0} widthOf={widthOf} frozen={{ count: frozenCount, leftOf: frozenLeft }} barRef={aggregateBar}
    onChange={aggregates => onUpdateView({ aggregates })} />
  </>;
}
