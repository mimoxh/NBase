import { useCallback, useEffect, useMemo, useState } from 'react';
import { databaseRelationPreview, isComputedProperty, type DatabaseRow, type PropertyDefinition, type PropertyValue, type RelationCell } from '@nbase/contracts';
import { nextOptionColor } from './labels';
import type { RelationHost } from './RelationEditor';
import { RowProperties } from './RowProperties';
import { announceDatabaseChange, useDatabase, type DatabaseDataSource } from './source';

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
  const [relations, setRelations] = useState<Record<string, RelationCell> | undefined>();
  const [computed, setComputed] = useState<DatabaseRow['computed']>();
  const needsRead = state.doc?.properties.some(p => (p.type === 'relation' || isComputedProperty(p)) && !p.deletedAt) ?? false;
  const loadDerived = useCallback(async () => {
    const [loaded] = await source.readRows(databaseId, [row.id], databaseRelationPreview);
    setRelations(loaded?.relations ?? {});
    setComputed(loaded?.computed ?? {});
  }, [source, databaseId, row.id]);
  // Reads again when the row's own values change, since formulas depend on them.
  useEffect(() => { if (needsRead) void loadDerived().catch(() => undefined); }, [needsRead, loadDerived, row.revision]);
  const relationFor = useCallback((def: PropertyDefinition): RelationHost => ({
    source, databaseId,
    change: async (add, remove) => {
      const result = await source.changeRelation(databaseId, row.id, def.id, { clientMutationId: crypto.randomUUID(), add, remove });
      setRelations(result.row.relations ?? {});
      announceDatabaseChange(databaseId);
      announceDatabaseChange(result.otherDatabaseId);
    },
  }), [source, databaseId, row.id]);
  const relationHost = useMemo(() => {
    const def = state.doc?.properties.find(p => p.type === 'relation');
    return def ? relationFor : undefined;
  }, [state.doc, relationFor]);
  if (!state.doc) return state.error ? <p className="nb-db-empty-note" role="alert">{state.error}</p> : null;
  const createOption = async (def: PropertyDefinition, name: string) => {
    const doc = state.doc;
    if (!doc) return null;
    const latest = doc.properties.find(p => p.id === def.id) ?? def;
    const option = { id: crypto.randomUUID(), name: name.slice(0, 100), color: nextOptionColor(latest.options?.length ?? 0) };
    const properties = doc.properties.map(p => p.id === def.id ? { ...p, options: [...(p.options ?? []), option] } : p);
    return await state.saveSchema({ properties, views: doc.views }) ? option.id : null;
  };
  return <RowProperties row={{ ...row, ...(relations ? { relations } : {}), ...(computed ? { computed } : {}) }} properties={state.doc.properties} editable={editable && source.canWrite} pending={pending}
    onChange={onChange} onCreateOption={createOption} databaseTitle={state.doc.page.title} databaseIcon={state.doc.page.icon}
    onOpenDatabase={() => source.openDatabase(databaseId)} relationHostFor={relationHost} />;
}
