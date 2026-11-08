import { nextOptionColor } from './labels';
import type { DatabaseRow, PropertyDefinition, PropertyValue } from '@nbase/contracts';
import { RowProperties } from './RowProperties';
import { useDatabase, type DatabaseDataSource } from './source';

/**
 * Row page header block: reads the parent database's schema and lets the host write the
 * row's values, because the host owns the row page's revision and draft state.
 */
export function RowPanel({ source, databaseId, row, editable, pending, onChange }: {
  source: DatabaseDataSource;
  databaseId: string;
  row: DatabaseRow;
  editable: boolean;
  pending: boolean;
  onChange: (propertyId: string, value: PropertyValue | null) => void;
}) {
  const state = useDatabase(source, databaseId);
  if (!state.doc) return state.error ? <p className="nb-db-empty-note" role="alert">{state.error}</p> : null;
  const createOption = async (def: PropertyDefinition, name: string) => {
    const doc = state.doc;
    if (!doc) return null;
    const latest = doc.properties.find(p => p.id === def.id) ?? def;
    const option = { id: crypto.randomUUID(), name: name.slice(0, 100), color: nextOptionColor(latest.options?.length ?? 0) };
    const properties = doc.properties.map(p => p.id === def.id ? { ...p, options: [...(p.options ?? []), option] } : p);
    return await state.saveSchema({ properties, views: doc.views }) ? option.id : null;
  };
  return <RowProperties row={row} properties={state.doc.properties} editable={editable && source.canWrite} pending={pending}
    onChange={onChange} onCreateOption={createOption} databaseTitle={state.doc.page.title} databaseIcon={state.doc.page.icon}
    onOpenDatabase={() => source.openDatabase(databaseId)} />;
}
