import { aggregateRows, databaseQueryWindow, databaseSchemaProblem, evaluateView, groupRows, isGroupableProperty, rowValueProblem, type DatabaseDocument, type DatabaseRow,
  type DatabaseView, type PropertyDefinition, type PropertyValue, type RelationCell } from '@nbase/contracts';
import { workspaceReducer, type Action, type Page, type Workspace } from '../workspace/model';
import { DatabaseSourceError, type DatabaseDataSource } from './source';

const epoch = '2026-11-01T08:00:00.000Z';

function rowOf(page: Page): DatabaseRow {
  return { id: page.id, title: page.title, icon: page.icon, properties: page.properties ?? {},
    revision: String(page.revision ?? 1), createdAt: page.createdAt ?? epoch, updatedAt: page.updatedAt ?? page.createdAt ?? epoch };
}

/**
 * Session-only database storage for the demo workspace. Each write runs the workspace reducer
 * on a local copy first, so a read right after a write sees it before React re-renders.
 */
export function createDemoSource(options: {
  state: { current: Workspace };
  dispatch: (action: Action) => void;
  openPage: (id: string) => void;
  notice: (text: string) => void;
}): DatabaseDataSource {
  const apply = (action: Action) => {
    options.state.current = workspaceReducer(options.state.current, action);
    options.dispatch(action);
  };
  const database = (id: string) => {
    const page = options.state.current.pages.find(p => p.id === id && !p.deleted && p.kind === 'database' && p.database);
    if (!page?.database) throw new DatabaseSourceError('NOT_FOUND', '数据库不存在或已移入回收站。');
    return { page, schema: page.database };
  };
  const row = (id: string) => {
    const page = options.state.current.pages.find(p => p.id === id && !p.deleted && p.kind === 'row');
    if (!page?.parentId) throw new DatabaseSourceError('NOT_FOUND', '这一行已不存在。');
    return page;
  };
  const activeRow = (id: string) => options.state.current.pages.find(p => p.id === id && !p.deleted && p.kind === 'row');
  /** Rows with their linked rows; the demo has no link table, so the paired side is found by scanning. */
  const withRelations = (page: Page): DatabaseRow => {
    const result = rowOf(page);
    const parent = options.state.current.pages.find(p => p.id === page.parentId);
    const relations: Record<string, RelationCell> = {};
    for (const def of parent?.database?.properties ?? []) {
      if (def.type !== 'relation' || def.deletedAt || !def.relation) continue;
      const { databaseId, pairedPropertyId, owner } = def.relation;
      const value = page.properties?.[def.id];
      const others = owner ? (Array.isArray(value) ? value : []).flatMap(id => activeRow(id) ?? [])
        : options.state.current.pages.filter(p => p.parentId === databaseId && p.kind === 'row' && !p.deleted
          && (p.properties?.[pairedPropertyId] as string[] | undefined)?.includes(page.id));
      if (others.length) relations[def.id] = { total: others.length, items: others.map(p => ({ id: p.id, title: p.title })) };
    }
    return Object.keys(relations).length ? { ...result, relations } : result;
  };
  const rowsOf = (id: string) => options.state.current.pages.filter(p => p.parentId === id && !p.deleted && p.kind === 'row').map(withRelations);
  return {
    canWrite: true,
    listDatabases: async () => options.state.current.pages.filter(p => p.kind === 'database' && !p.deleted).map(p => ({ id: p.id, title: p.title, icon: p.icon })),
    createRelation: async (id, request) => {
      const target = request.targetDatabaseId;
      const ownerId = crypto.randomUUID();
      const pairedId = crypto.randomUUID();
      const owner: PropertyDefinition = { id: ownerId, name: request.name, type: 'relation', relation: { databaseId: target, pairedPropertyId: pairedId, owner: true } };
      const paired: PropertyDefinition = { id: pairedId, name: request.pairedName, type: 'relation', relation: { databaseId: id, pairedPropertyId: ownerId, owner: false } };
      if (target !== id) {
        const other = database(target).schema;
        apply({ type: 'db-schema', id: target, properties: [...other.properties, paired], views: other.views });
      }
      const { schema } = database(id);
      const properties = [...schema.properties, owner, ...(target === id ? [paired] : [])];
      apply({ type: 'db-schema', id, properties, views: schema.views });
      return { pageId: id, properties, views: schema.views, schemaRevision: String(schema.revision + 1) };
    },
    changeRelation: async (id, rowId, propertyId, request) => {
      const def = database(id).schema.properties.find(p => p.id === propertyId);
      if (!def?.relation) throw new DatabaseSourceError('PROPERTY_INVALID', '字段不存在。');
      const now = new Date().toISOString();
      const edit = (ownerId: string, key: string, add: string[], remove: string[]) => {
        const page = row(ownerId);
        const ids = new Set((page.properties?.[key] as string[] | undefined) ?? []);
        remove.forEach(item => ids.delete(item));
        add.forEach(item => ids.add(item));
        apply({ type: 'row-update', id: ownerId, at: now, properties: { [key]: ids.size ? [...ids] : null } });
      };
      if (def.relation.owner) edit(rowId, def.id, request.add, request.remove);
      else {
        request.add.forEach(ownerId => edit(ownerId, def.relation!.pairedPropertyId, [rowId], []));
        request.remove.forEach(ownerId => edit(ownerId, def.relation!.pairedPropertyId, [], [rowId]));
      }
      const touched = (def.relation.owner ? [rowId] : [...request.add, ...request.remove])
        .map(item => ({ id: item, revision: String(row(item).revision ?? 1), updatedAt: now }));
      return { pageId: id, row: withRelations(row(rowId)), touched, otherDatabaseId: def.relation.databaseId };
    },
    query: async (id, request) => {
      const { schema } = database(id);
      const all = rowsOf(id);
      const view: DatabaseView = { id: 'query', name: 'query', type: 'table', filters: request.filters, sorts: request.sorts,
        hiddenPropertyIds: [], propertyOrder: [], widths: {} };
      const matching = evaluateView(all, schema.properties, view, request.context ?? {}).rows;
      const groupDef = schema.properties.find(p => p.id === request.groupBy && !p.deletedAt && isGroupableProperty(p));
      return structuredClone({ order: matching.map(row => row.id), total: matching.length, allRows: all.length,
        rows: matching.slice(0, databaseQueryWindow), schemaRevision: String(schema.revision), ...(groupDef ? { groups: groupRows(matching, groupDef) } : {}) });
    },
    readRows: async (id, ids) => {
      const byId = new Map(rowsOf(id).map(row => [row.id, row]));
      return structuredClone(ids.flatMap(rowId => { const row = byId.get(rowId); return row ? [row] : []; }));
    },
    aggregate: async (id, request) => {
      const { schema } = database(id);
      const view: DatabaseView = { id: 'query', name: 'query', type: 'table', filters: request.filters, sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} };
      return { values: aggregateRows(evaluateView(rowsOf(id), schema.properties, view, request.context ?? {}).rows, schema.properties, request.items) };
    },
    bulk: async (id, request) => {
      const { schema } = database(id);
      const check = (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) {
          if (rowValueProblem(schema.properties, key, value)) throw new DatabaseSourceError('PROPERTY_INVALID', '值无效。');
        }
      };
      const now = new Date().toISOString();
      const report = (rowIds: string[]) => ({ pageId: id, rows: rowIds.map(rowId => {
        const saved = row(rowId);
        return { id: rowId, revision: String(saved.revision ?? 1), updatedAt: saved.updatedAt ?? now };
      }) });
      const insert = (title: string, properties: Record<string, PropertyValue>, markdown = '') => {
        const page: Page = { id: crypto.randomUUID(), title, parentId: id, markdown, icon: null, cover: null, starred: false,
          deleted: false, dirty: true, kind: 'row', properties, revision: 1, createdAt: now, updatedAt: now };
        apply({ type: 'insert', page });
        return page.id;
      };
      switch (request.operation) {
        case 'create':
          request.rows.forEach(item => check(item.properties));
          return report(request.rows.map(item => insert(item.title, item.properties)));
        case 'patch':
          request.items.forEach(item => check(item.properties ?? {}));
          request.items.forEach(item => apply({ type: 'row-update', id: item.id, at: now,
            ...(item.title !== undefined ? { title: item.title } : {}), ...(item.properties ? { properties: item.properties } : {}) }));
          return report(request.items.map(item => item.id));
        case 'duplicate':
          return report(request.ids.map(rowId => { const source = row(rowId);
            return insert(source.title.trim() ? `${source.title} 副本` : source.title, { ...(source.properties ?? {}) }, source.markdown); }));
        case 'trash': {
          const rows = request.ids.map(rowId => ({ id: rowId, revision: String(row(rowId).revision ?? 1), updatedAt: now }));
          request.ids.forEach(rowId => apply({ type: 'delete', id: rowId }));
          return { pageId: id, rows };
        }
      }
    },
    load: async id => {
      const { page, schema } = database(id);
      const rows = rowsOf(id);
      const document: DatabaseDocument = {
        page: { id: page.id, workspaceId: 'demo', parentId: page.parentId, title: page.title, icon: page.icon, cover: page.cover,
          kind: 'database', revision: '1', createdAt: page.createdAt ?? epoch, updatedAt: page.updatedAt ?? epoch },
        properties: schema.properties, views: schema.views, schemaRevision: String(schema.revision), rows,
      };
      return structuredClone(document);
    },
    saveSchema: async (id, next, expectedRevision) => {
      const { schema } = database(id);
      if (String(schema.revision) !== expectedRevision) throw new DatabaseSourceError('REVISION_CONFLICT', '数据库结构已改变。');
      if (databaseSchemaProblem(next.properties, next.views)) throw new DatabaseSourceError('DATABASE_SCHEMA_INVALID', '设置无效。');
      apply({ type: 'db-schema', id, properties: next.properties, views: next.views });
      return { pageId: id, properties: next.properties, views: next.views, schemaRevision: String(schema.revision + 1) };
    },
    createRow: async (id, title, properties) => {
      const { schema } = database(id);
      for (const [key, value] of Object.entries(properties)) {
        if (rowValueProblem(schema.properties, key, value)) throw new DatabaseSourceError('PROPERTY_INVALID', '值无效。');
      }
      const now = new Date().toISOString();
      const page: Page = { id: crypto.randomUUID(), title, parentId: id, markdown: '', icon: null, cover: null, starred: false,
        deleted: false, dirty: true, kind: 'row', properties, revision: 1, createdAt: now, updatedAt: now };
      apply({ type: 'insert', page });
      return rowOf(page);
    },
    updateRow: async (rowId, expectedRevision, patch) => {
      const page = row(rowId);
      if (String(page.revision ?? 1) !== expectedRevision) throw new DatabaseSourceError('REVISION_CONFLICT', '这一行已改变。');
      const { schema } = database(page.parentId!);
      for (const [key, value] of Object.entries(patch.properties ?? {})) {
        if (rowValueProblem(schema.properties, key, value)) throw new DatabaseSourceError('PROPERTY_INVALID', '值无效。');
      }
      apply({ type: 'row-update', id: rowId, at: new Date().toISOString(),
        ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.properties ? { properties: patch.properties } : {}) });
      return rowOf(row(rowId));
    },
    moveRow: async (id, rowId, afterRowId) => { apply({ type: 'place', id: rowId, placement: { parentId: id, afterId: afterRowId } }); },
    trashRow: async target => { apply({ type: 'delete', id: target.id }); options.notice('已移入回收站，可在当前会话恢复。'); },
    openRow: id => options.openPage(id),
    openDatabase: id => options.openPage(id),
    notice: options.notice,
  };
}
