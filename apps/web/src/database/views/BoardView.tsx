import { useEffect, useMemo, useState } from 'react';
import { viewColumns, type DatabaseDocument, type DatabaseView as View, type PropertyDefinition, type PropertyValue } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { CellValue, OptionTag } from '../cells';
import type { RowStore } from '../rowStore';
import type { DatabaseDataSource } from '../source';

const pageSize = 50;
const cardFields = 3;

interface Column { key: string | null; label: React.ReactNode; value: PropertyValue | null }

function columnsOf(def: PropertyDefinition): Column[] {
  if (def.type === 'checkbox') return [{ key: 'false', label: '未勾选', value: null }, { key: 'true', label: '已勾选', value: true }];
  return [{ key: null, label: `没有${def.name}`, value: null },
    ...(def.options ?? []).map(option => ({ key: option.id, label: <OptionTag option={option} />, value: option.id }))];
}

/** Rows as cards in columns of one single-select or checkbox field. Dragging a card writes that field. */
export default function BoardView({ source, store, doc, view, group, canWrite }: {
  source: DatabaseDataSource; store: RowStore; doc: DatabaseDocument; view: View; group: PropertyDefinition; canWrite: boolean;
}) {
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null | undefined>(undefined);
  const columns = useMemo(() => columnsOf(group), [group]);
  const shown = viewColumns(doc.properties, view).filter(def => def.type !== 'title' && def.id !== group.id).slice(0, cardFields);
  const limitOf = (key: string | null) => limits[String(key)] ?? pageSize;
  const idsOf = (key: string | null) => store.groups.find(item => item.key === key)?.ids ?? [];
  const wanted = columns.flatMap(column => idsOf(column.key).slice(0, limitOf(column.key)));
  const wantedKey = wanted.join();
  useEffect(() => { store.ensureIds(wanted); }, [store, wantedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="nb-db-board" role="list" aria-label="看板">
    {columns.map(column => {
      const ids = idsOf(column.key);
      return <section key={String(column.key)} className={`nb-db-board-column ${dropKey === column.key && dragging ? 'nb-db-board-drop' : ''}`} role="listitem" aria-label={typeof column.label === 'string' ? column.label : undefined}
        onDragOver={event => { if (dragging) { event.preventDefault(); setDropKey(column.key); } }}
        onDrop={event => {
          event.preventDefault();
          setDropKey(undefined);
          const moving = dragging;
          setDragging(null);
          if (moving && !idsOf(column.key).includes(moving)) void store.moveToGroup(moving, column.key, group.id, column.value);
        }}>
        <header className="nb-db-board-head"><span className="nb-db-board-label">{column.label}</span><span className="nb-db-count">{ids.length}</span></header>
        <div className="nb-db-board-cards">
          {ids.slice(0, limitOf(column.key)).map(id => {
            const row = store.rowById(id);
            if (!row) return <div key={id} className="nb-db-card nb-db-card-loading" aria-busy="true" />;
            return <article key={id} className="nb-db-card" draggable={canWrite} onDragStart={() => setDragging(id)} onDragEnd={() => { setDragging(null); setDropKey(undefined); }}>
              <button className="nb-db-card-title" onClick={() => source.openRow(id)}>{row.title || <span className="nb-db-placeholder">未命名</span>}</button>
              {shown.map(def => <div key={def.id} className="nb-db-card-field"><CellValue row={row} def={def} /></div>)}
            </article>;
          })}
          {ids.length > limitOf(column.key) && <button className="nb-btn nb-btn-quiet" onClick={() => setLimits({ ...limits, [String(column.key)]: limitOf(column.key) + pageSize })}>
            再显示 {Math.min(pageSize, ids.length - limitOf(column.key))} 张</button>}
        </div>
        {canWrite && <button className="nb-db-add-row" onClick={() => void store.createRow('', column.value === null ? {} : { [group.id]: column.value }, column.key)}>
          <Icon name="plus" size={14} />新建</button>}
      </section>;
    })}
  </div>;
}
