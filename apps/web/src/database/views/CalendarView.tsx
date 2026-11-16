import { useEffect, useMemo, useState } from 'react';
import { activeProperties, cellValue, type DatabaseDocument, type DatabaseRow, type PropertyDefinition, type PropertyType, type RecurrenceEditScope,
  type RowProperties } from '@nbase/contracts';
import { Calendar } from '../../calendar/Calendar';
import { applyEventChange, newEventValue, type EventSpan, type EventWrite } from '../../calendar/editing';
import type { WeekStart } from '../../calendar/layout';
import { buildEvents, type CalendarEvent, type CalendarEventInput } from '../../calendar/model';
import { RecurrenceScopeDialog } from '../../calendar/RecurrenceScopeDialog';
import type { RowStore } from '../rowStore';
import type { DatabaseDataSource } from '../source';
import { lockedPropertyIds, syncedReadOnlyHint } from '../sync';
import type { CalendarNav } from './calendarNav';

export const calendarRowCap = 1000;
const copiedTypes = new Set<PropertyType>(['text', 'number', 'select', 'multi_select', 'checkbox', 'date', 'url']);

/** Stored values a detached occurrence takes from its series row, leaving out `skip`. */
export function copiedProperties(row: DatabaseRow, properties: PropertyDefinition[], skip: ReadonlySet<string>): RowProperties {
  const out: RowProperties = {};
  for (const def of activeProperties(properties)) {
    if (!copiedTypes.has(def.type) || skip.has(def.id)) continue;
    const value = row.properties[def.id];
    if (value !== undefined && value !== null) out[def.id] = value;
  }
  return out;
}

/** One calendar input per row with a value in the date field. Page times are moments without length. */
export function calendarInputs(rows: readonly DatabaseRow[], dateField: PropertyDefinition, readOnly: boolean): CalendarEventInput[] {
  return rows.flatMap(row => {
    const value = cellValue(row, dateField);
    if (value === undefined || value === null || value === '') return [];
    return [{ sourceId: dateField.id, rowId: row.id, title: row.title, icon: row.icon, value: String(value),
      kind: dateField.type === 'date' ? 'date' as const : 'moment' as const, readOnly }];
  });
}

/**
 * Rows of a database on a calendar by one date-like field. Only `date` fields are written: dragging moves or
 * resizes, and the empty grid creates rows. Repeating events ask which occurrences a change applies to.
 */
export default function CalendarView({ source, store, doc, dateField, canWrite, nav, timeZone, weekStart, defaults }: {
  source: DatabaseDataSource; store: RowStore; doc: DatabaseDocument; dateField: PropertyDefinition; canWrite: boolean;
  nav: CalendarNav; timeZone: string; weekStart: WeekStart; defaults: RowProperties;
}) {
  const locked = lockedPropertyIds(doc);
  const writable = canWrite && dateField.type === 'date' && !locked.has(dateField.id);
  const [pending, setPending] = useState<{ event: CalendarEvent; next: EventSpan } | null>(null);
  useEffect(() => { store.ensure(0, calendarRowCap); }, [store, store.order]);
  const version = store.getVersion();
  const events = useMemo(() => {
    const rows: DatabaseRow[] = [];
    const count = Math.min(store.order.length, calendarRowCap);
    for (let index = 0; index < count; index += 1) { const row = store.rowAt(index); if (row) rows.push(row); }
    return buildEvents(calendarInputs(rows, dateField, !writable), nav.range, timeZone);
  }, [store, version, dateField, writable, nav.range.from, nav.range.to, timeZone]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = async (event: CalendarEvent, change: EventWrite | null) => {
    if (!change) { source.notice('这个日期不能这样修改。'); return; }
    const row = store.rowById(event.rowId);
    if (change.series === null) await store.trashRow(event.rowId);
    else await store.updateRow(event.rowId, { properties: { [dateField.id]: change.series } });
    if (change.detached !== undefined && row) {
      const skip = new Set([...locked, ...(doc.calendarSync ? [doc.calendarSync.fields.uidId] : [])]);
      await store.createRow(row.title, { ...copiedProperties(row, doc.properties, skip), [dateField.id]: change.detached });
    }
  };
  const change = (event: CalendarEvent, next: EventSpan) => {
    if (event.recurring) setPending({ event, next });
    else void write(event, applyEventChange(event, next, 'all', timeZone));
  };
  const choose = (scope: RecurrenceEditScope) => {
    const chosen = pending;
    setPending(null);
    if (chosen) void write(chosen.event, applyEventChange(chosen.event, chosen.next, scope, timeZone));
  };
  const create = (span: EventSpan) => {
    const value = newEventValue(span, timeZone);
    // The new row opens right away so its title can be typed.
    if (value) void store.createRow('', { ...defaults, [dateField.id]: value }).then(row => { if (row) source.openRow(row.id); });
  };

  const status = <>
    {store.loading && <span role="status">正在读取…</span>}
    {store.total > calendarRowCap && <span className="nb-db-invalid-note" role="status">这段时间有 {store.total} 行，只显示前 {calendarRowCap} 行。可以用筛选缩小范围。</span>}
    {canWrite && !writable && <span>{locked.has(dateField.id) ? syncedReadOnlyHint : `${dateField.name}由系统记录，不能在日历上修改。`}</span>}
  </>;
  return <>
    <Calendar mode={nav.mode} anchor={nav.anchor} weekStart={weekStart} timeZone={timeZone} today={nav.today} events={events}
      agendaDays={nav.agendaDays} onMode={nav.setMode} onAnchor={nav.setAnchor} onAgendaMore={nav.loadMore} status={status}
      label={`${dateField.name}日历`} onOpen={event => source.openRow(event.rowId)}
      onCreate={writable ? create : undefined} onChange={writable ? change : undefined} />
    {pending && <RecurrenceScopeDialog onChoose={choose} onClose={() => setPending(null)} />}
  </>;
}
