import { useEffect, useMemo, useState } from 'react';
import { cellValue, localDay, type DatabaseRow, type PropertyDefinition } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { monthBounds } from '../labels';
import type { RowStore } from '../rowStore';
import type { DatabaseDataSource } from '../source';

const calendarRowCap = 1000;
const perDay = 3;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

export function shiftMonth(month: string, by: number): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, value - 1 + by, 1)).toISOString().slice(0, 7);
}

/** The Monday-first grid of days covering a month. */
export function monthGrid(month: string): string[] {
  const { first, last } = monthBounds(month);
  const start = new Date(`${first}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const days: string[] = [];
  for (const day = new Date(start); days.length % 7 !== 0 || day.toISOString().slice(0, 10) <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

/** A month of rows by one date field. Only date fields can be set by creating or dragging; times come from the page. */
export default function CalendarView({ source, store, month, onMonth, dateField, canWrite }: {
  source: DatabaseDataSource; store: RowStore; month: string; onMonth: (month: string) => void; dateField: PropertyDefinition; canWrite: boolean;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const writable = canWrite && dateField.type === 'date';
  const today = localDay(new Date());
  const days = useMemo(() => monthGrid(month), [month]);
  useEffect(() => { store.ensure(0, calendarRowCap); }, [store, store.order]);
  const byDay = new Map<string, DatabaseRow[]>();
  store.order.slice(0, calendarRowCap).forEach((_, index) => {
    const row = store.rowAt(index);
    const value = row && cellValue(row, dateField);
    if (!row || value === undefined) return;
    const day = dateField.type === 'date' ? String(value) : localDay(new Date(String(value)));
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  });
  const chip = (row: DatabaseRow) => <button key={row.id} className="nb-db-event" draggable={writable} onClick={() => source.openRow(row.id)}
    onDragStart={() => setDragging(row.id)} onDragEnd={() => { setDragging(null); setDropDay(null); }}>{row.title || '未命名'}</button>;
  return <div className="nb-db-calendar">
    <div className="nb-db-calendar-bar">
      <button className="nb-db-tool" aria-label="上个月" onClick={() => onMonth(shiftMonth(month, -1))}>‹</button>
      <strong>{month.replace('-', ' 年 ')} 月</strong>
      <button className="nb-db-tool" aria-label="下个月" onClick={() => onMonth(shiftMonth(month, 1))}>›</button>
      <button className="nb-btn nb-btn-quiet" onClick={() => onMonth(today.slice(0, 7))}>今天</button>
      {store.total > calendarRowCap && <span className="nb-db-invalid-note" role="status">这个月有 {store.total} 行，只显示前 {calendarRowCap} 行。可以用筛选缩小范围。</span>}
    </div>
    <div className="nb-db-calendar-grid" role="grid" aria-label="日历">
      {weekdays.map(day => <div key={day} className="nb-db-calendar-weekday" role="columnheader">{day}</div>)}
      {days.map(day => {
        const rows = byDay.get(day) ?? [];
        const inMonth = day.startsWith(month);
        return <div key={day} role="gridcell" aria-label={day} className={`nb-db-day ${inMonth ? '' : 'nb-db-day-out'} ${day === today ? 'nb-db-day-today' : ''} ${dropDay === day && dragging ? 'nb-db-board-drop' : ''}`}
          onDragOver={event => { if (dragging && writable) { event.preventDefault(); setDropDay(day); } }}
          onDrop={event => {
            event.preventDefault();
            const moving = dragging;
            setDragging(null); setDropDay(null);
            if (moving) void store.updateRow(moving, { properties: { [dateField.id]: day } });
          }}>
          <div className="nb-db-day-head">
            <span className="nb-db-day-number">{Number(day.slice(8))}</span>
            {writable && <button className="nb-db-tool nb-db-day-add" aria-label={`在 ${day} 新建`} onClick={() => void store.createRow('', { [dateField.id]: day })}><Icon name="plus" size={12} /></button>}
          </div>
          {rows.slice(0, perDay).map(chip)}
          {rows.length > perDay && <span className="nb-db-anchor">
            <button className="nb-db-more" onClick={() => setMore(day)}>还有 {rows.length - perDay} 项</button>
            {more === day && <Popover label={`${day} 的全部项目`} className="nb-db-pop" portal width={220} onClose={() => setMore(null)}>
              <div className="nb-db-day-list">{rows.map(chip)}</div>
            </Popover>}
          </span>}
        </div>;
      })}
    </div>
  </div>;
}
