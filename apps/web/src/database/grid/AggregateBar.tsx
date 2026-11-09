import { useEffect, useState, type RefObject } from 'react';
import { aggregatesFor, type AggregateFunction, type AggregateItem, type DatabaseQueryRequest, type DatabaseView as View, type PropertyDefinition } from '@nbase/contracts';
import { Popover } from '../../components/Popover';
import { aggregateLabels, formatNumber, formatTimestamp } from '../labels';
import type { DatabaseDataSource } from '../source';

function display(def: PropertyDefinition, fn: AggregateFunction, value: number | string | null): string {
  if (value === null) return '—';
  if (typeof value === 'number') return formatNumber(fn === 'avg' ? Math.round(value * 100) / 100 : value);
  return def.type === 'created_time' || def.type === 'updated_time' ? formatTimestamp(value) : value;
}

/** Statistics over every matching row. It sits outside the scrolling table so it stays on screen, and follows the table sideways. */
export function AggregateBar({ source, databaseId, request, view, columns, canWrite, version, gutter, end, widthOf, frozen, barRef, onChange }: {
  source: DatabaseDataSource; databaseId: string; request: DatabaseQueryRequest; view: View; columns: PropertyDefinition[]; canWrite: boolean;
  /** Changes when rows change, so totals are recalculated. */
  version: number; gutter: number; end: number; widthOf: (def: PropertyDefinition) => number;
  frozen: { count: number; leftOf: (index: number) => number }; barRef: RefObject<HTMLDivElement | null>;
  onChange: (aggregates: Record<string, AggregateFunction>) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, number | string | null>>({});
  const aggregates = view.aggregates ?? {};
  const items: AggregateItem[] = columns.flatMap(def => aggregates[def.id] ? [{ propertyId: def.id, fn: aggregates[def.id]! }] : []);
  const key = JSON.stringify([items, request.filters]);
  useEffect(() => {
    if (!items.length) { setValues({}); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      source.aggregate(databaseId, { filters: request.filters, ...(request.context ? { context: request.context } : {}), items })
        .then(result => { if (!cancelled) setValues(Object.fromEntries(items.map((item, index) => [item.propertyId, result.values[index] ?? null]))); })
        .catch(() => undefined);
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, version, source, databaseId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canWrite && !items.length) return null;
  const set = (def: PropertyDefinition, fn: AggregateFunction | null) => {
    const next = { ...aggregates };
    if (fn) next[def.id] = fn; else delete next[def.id];
    onChange(next);
    setOpen(null);
  };
  return <div className="nb-db-agg" ref={barRef} aria-label="统计">
    <div className="nb-db-agg-row" style={{ width: gutter + columns.reduce((sum, def) => sum + widthOf(def), 0) + end }}>
      <span className="nb-db-agg-cell nb-db-agg-gutter" style={{ width: gutter }} />
      {columns.map((def, index) => {
        const fn = aggregates[def.id];
        return <span key={def.id} className={`nb-db-agg-cell ${index < frozen.count ? 'nb-db-frozen' : ''}`} style={{ width: widthOf(def), ...(index < frozen.count ? { left: frozen.leftOf(index) } : {}) }}>
          <span className="nb-db-anchor nb-db-agg-anchor">
            <button className={`nb-db-agg-button ${fn ? 'set' : ''}`} disabled={!canWrite} aria-label={`${def.name}的统计`} onClick={() => setOpen(def.id)}>
              {fn ? <><span className="nb-db-agg-label">{aggregateLabels[fn]}</span> {display(def, fn, values[def.id] ?? null)}</> : '统计'}
            </button>
            {open === def.id && <Popover label={`${def.name}的统计`} className="nb-db-pop" portal width={160} onClose={() => setOpen(null)}>
              <div className="nb-db-menu">
                <button onClick={() => set(def, null)}>不统计</button>
                {aggregatesFor(def.type).map(item => <button key={item} onClick={() => set(def, item)}>{aggregateLabels[item]}</button>)}
              </div>
            </Popover>}
          </span>
        </span>;
      })}
    </div>
  </div>;
}
