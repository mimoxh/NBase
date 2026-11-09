import { useEffect, useState } from 'react';
import { activeProperties, databaseRelationLimit, type DatabaseRow, type PropertyDefinition } from '@nbase/contracts';
import { Popover } from '../components/Popover';
import { takeCellEditSeed } from './cells';
import type { DatabaseDataSource } from './source';

const resultLimit = 30;

export interface RelationHost {
  source: DatabaseDataSource;
  databaseId: string;
  change: (add: string[], remove: string[]) => Promise<void>;
}

/** Picks rows of the linked database. Each toggle is saved at once, from whichever side the field is on. */
export function RelationEditor({ row, def, host, onClose }: { row: DatabaseRow; def: PropertyDefinition; host: RelationHost; onClose: () => void }) {
  const [query, setQuery] = useState(() => takeCellEditSeed() ?? '');
  const [results, setResults] = useState<{ id: string; title: string }[]>([]);
  const [linked, setLinked] = useState<{ id: string; title: string }[]>(row.relations?.[def.id]?.items ?? []);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const targetId = def.relation!.databaseId;

  // The row in the table carries only a preview, so the full list is read when the editor opens.
  useEffect(() => {
    let cancelled = false;
    host.source.readRows(host.databaseId, [row.id], databaseRelationLimit)
      .then(rows => { if (!cancelled) setLinked(rows[0]?.relations?.[def.id]?.items ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [host, row.id, def.id]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const schema = await host.source.load(targetId);
        const titleField = activeProperties(schema.properties).find(p => p.type === 'title')!;
        const text = query.trim();
        const found = await host.source.query(targetId, { filters: text ? [{ propertyId: titleField.id, operator: 'contains', value: text }] : [], sorts: [] });
        const rows = await host.source.readRows(targetId, found.order.slice(0, resultLimit));
        if (!cancelled) { setResults(rows.map(item => ({ id: item.id, title: item.title }))); setProblem(''); }
      } catch { if (!cancelled) setProblem('关联的数据库暂时无法读取，可能已移入回收站。'); }
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [host, targetId, query]);

  const toggle = async (item: { id: string; title: string }) => {
    if (busy) return;
    const on = linked.some(entry => entry.id === item.id);
    setBusy(true);
    setProblem('');
    try {
      await host.change(on ? [] : [item.id], on ? [item.id] : []);
      setLinked(on ? linked.filter(entry => entry.id !== item.id) : [...linked, item]);
    } catch { setProblem('关联未保存。'); } finally { setBusy(false); }
  };

  return <Popover label={`选择${def.name}`} className="nb-db-pop nb-db-select-pop" portal width={280} onClose={onClose}>
    {linked.length > 0 && <div className="nb-db-tags nb-db-selected">{linked.map(item => <button key={item.id} className="nb-db-tag-button" aria-label={`移除 ${item.title || '未命名'}`}
      onClick={() => void toggle(item)}><span className="nb-db-tag nb-db-color-default">{item.title || '未命名'}</span> ×</button>)}</div>}
    <input className="nb-db-input" autoFocus aria-label="搜索关联的行" placeholder="搜索行" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="nb-db-option-list" role="listbox" aria-multiselectable="true">
      {results.map(item => { const on = linked.some(entry => entry.id === item.id);
        return <button key={item.id} role="option" aria-selected={on} disabled={busy} className={`nb-db-option ${on ? 'selected' : ''}`} onClick={() => void toggle(item)}>
          <span className="nb-db-tag nb-db-color-default">{item.title || '未命名'}</span>{on && <span className="nb-db-option-check">✓</span>}</button>; })}
      {!results.length && <p className="nb-db-empty-note">没有可选的行</p>}
    </div>
    {problem && <p className="nb-db-invalid-note" role="alert">{problem}</p>}
  </Popover>;
}
