import { activeProperties, effectiveType, filterOperatorsFor, flatFilters, retainFilters, type DatabaseSchemaResponse, type DatabaseView,
  type PropertyDefinition } from './databases.js';
import { parseFormula } from './formula.js';

/**
 * Schema history of a database: every save of fields or views leaves a version, see docs/architecture/databases.md.
 * Restoring a version is a new save and leaves its own version; nothing is taken out of the history.
 */
export type DatabaseSchemaOperation = 'baseline' | 'create' | 'update' | 'relation' | 'restore';

export const databaseSchemaHistoryPage = 50;
/** Changes listed with a version in the history list; `changeCount` tells how many there are. */
export const databaseSchemaChangePreview = 6;

export type DatabaseSchemaChangeKind = 'added' | 'removed' | 'restored' | 'renamed' | 'type' | 'options' | 'formula' | 'rollup'
  | 'relation' | 'order' | 'filters' | 'sorts' | 'layout' | 'display';

export interface DatabaseSchemaChange {
  target: 'property' | 'view';
  kind: DatabaseSchemaChangeKind;
  /** Property or view id; empty for a change of order. */
  id: string;
  /** Name in the later version, or in the earlier one when the later has none. */
  name: string;
  /** Renames: old and new name. Type changes: old and new type. */
  from?: string;
  to?: string;
}

export interface DatabaseSchemaActor { id: string; name: string }

export interface DatabaseSchemaVersionSummary {
  revision: string;
  savedAt: string;
  /** Null for versions recorded without a user, such as the baseline of existing databases. */
  actor: DatabaseSchemaActor | null;
  operation: DatabaseSchemaOperation;
  /** For a restore: the version it brought back. */
  restoredFrom: string | null;
  /** Compared with the previous version; the first version lists none. The history list gives the first few, a single version all. */
  changes: DatabaseSchemaChange[];
  changeCount: number;
}

export interface DatabaseSchemaHistoryResponse {
  versions: DatabaseSchemaVersionSummary[];
  /** Pass as `before` for older versions; null at the start of the history. */
  nextBefore: string | null;
}

export interface DatabaseSchemaVersion extends DatabaseSchemaVersionSummary {
  pageId: string;
  properties: PropertyDefinition[];
  views: DatabaseView[];
}

export interface RestoreDatabaseSchemaRequest {
  clientMutationId: string;
  /** The schema revision the reader has, as for a schema save. */
  expectedRevision: string;
}

export type DatabaseSchemaRestoreNoteKind = 'property-missing' | 'relation-target-missing' | 'property-synced' | 'tags-conflict'
  | 'formula-invalid' | 'rollup-invalid' | 'view-adjusted';

/** Something a restore could not bring back as it was, or that will not work after it. */
export interface DatabaseSchemaRestoreNote {
  kind: DatabaseSchemaRestoreNoteKind;
  target: 'property' | 'view';
  id: string;
  name: string;
  /** Formula errors: the parser's message. */
  detail?: string;
}

export interface RestoreDatabaseSchemaResponse extends DatabaseSchemaResponse {
  restoredFrom: string;
  notes: DatabaseSchemaRestoreNote[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRestoreDatabaseSchemaRequest(value: unknown): value is RestoreDatabaseSchemaRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => key === 'clientMutationId' || key === 'expectedRevision')
    && typeof record.clientMutationId === 'string' && uuidPattern.test(record.clientMutationId)
    && typeof record.expectedRevision === 'string' && /^[1-9][0-9]{0,18}$/.test(record.expectedRevision);
}

export interface DatabaseSchemaSnapshot { properties: PropertyDefinition[]; views: DatabaseView[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What changed from one version to the next, properties first, each list in the later version's order. */
export function diffDatabaseSchemas(before: DatabaseSchemaSnapshot, after: DatabaseSchemaSnapshot): DatabaseSchemaChange[] {
  const changes: DatabaseSchemaChange[] = [];
  const earlier = new Map(before.properties.map(def => [def.id, def]));
  for (const def of after.properties) {
    const old = earlier.get(def.id);
    const base = { target: 'property' as const, id: def.id, name: def.name };
    if (!old) { if (!def.deletedAt) changes.push({ ...base, kind: 'added' }); continue; }
    if (old.deletedAt && def.deletedAt) continue;
    if (!old.deletedAt && def.deletedAt) { changes.push({ ...base, kind: 'removed' }); continue; }
    if (old.deletedAt && !def.deletedAt) changes.push({ ...base, kind: 'restored' });
    if (old.name !== def.name) changes.push({ ...base, kind: 'renamed', from: old.name, to: def.name });
    if (old.type !== def.type) changes.push({ ...base, kind: 'type', from: old.type, to: def.type });
    if (!same(old.options, def.options)) changes.push({ ...base, kind: 'options' });
    if (!same(old.formula, def.formula)) changes.push({ ...base, kind: 'formula' });
    if (!same(old.rollup, def.rollup)) changes.push({ ...base, kind: 'rollup' });
    if (!same(old.relation, def.relation)) changes.push({ ...base, kind: 'relation' });
  }
  const later = new Set(after.properties.map(def => def.id));
  for (const def of before.properties) {
    if (!later.has(def.id) && !def.deletedAt) changes.push({ target: 'property', kind: 'removed', id: def.id, name: def.name });
  }
  const order = (list: PropertyDefinition[]) => activeProperties(list).map(def => def.id);
  const kept = (ids: string[], other: Set<string>) => ids.filter(id => other.has(id));
  const beforeOrder = order(before.properties);
  const afterOrder = order(after.properties);
  if (!same(kept(beforeOrder, new Set(afterOrder)), kept(afterOrder, new Set(beforeOrder)))) {
    changes.push({ target: 'property', kind: 'order', id: '', name: '' });
  }

  const views = new Map(before.views.map(view => [view.id, view]));
  for (const view of after.views) {
    const old = views.get(view.id);
    const base = { target: 'view' as const, id: view.id, name: view.name };
    if (!old) { changes.push({ ...base, kind: 'added' }); continue; }
    if (old.name !== view.name) changes.push({ ...base, kind: 'renamed', from: old.name, to: view.name });
    if (old.type !== view.type) changes.push({ ...base, kind: 'type', from: old.type, to: view.type });
    if (!same(old.filters, view.filters)) changes.push({ ...base, kind: 'filters' });
    if (!same(old.sorts, view.sorts)) changes.push({ ...base, kind: 'sorts' });
    if (old.groupPropertyId !== view.groupPropertyId || old.datePropertyId !== view.datePropertyId) changes.push({ ...base, kind: 'layout' });
    if (!same(old.hiddenPropertyIds, view.hiddenPropertyIds) || !same(old.propertyOrder, view.propertyOrder) || !same(old.widths, view.widths)
      || old.frozenColumns !== view.frozenColumns || !same(old.aggregates, view.aggregates)) changes.push({ ...base, kind: 'display' });
  }
  const laterViews = new Set(after.views.map(view => view.id));
  for (const view of before.views) {
    if (!laterViews.has(view.id)) changes.push({ target: 'view', kind: 'removed', id: view.id, name: view.name });
  }
  const viewOrder = (list: DatabaseView[], other: Set<string>) => list.map(view => view.id).filter(id => other.has(id));
  if (!same(viewOrder(before.views, laterViews), viewOrder(after.views, new Set(before.views.map(view => view.id))))) {
    changes.push({ target: 'view', kind: 'order', id: '', name: '' });
  }
  return changes;
}

const typeNames: Record<string, string> = {
  title: '标题', text: '文本', number: '数字', select: '单选', multi_select: '多选', date: '日期', checkbox: '复选框', url: '网址',
  created_time: '创建时间', updated_time: '更新时间', relation: '关联', formula: '公式', rollup: '汇总', tags: '标签',
  table: '表格', board: '看板', calendar: '日历',
};

/** One line of Chinese for the history list and the comparison. */
export function describeSchemaChange(change: DatabaseSchemaChange): string {
  const what = change.target === 'property' ? '字段' : '视图';
  const name = `${what}“${change.name}”`;
  switch (change.kind) {
    case 'added': return `新增${name}`;
    case 'removed': return `删除${name}`;
    case 'restored': return `恢复${name}`;
    case 'renamed': return `${what}“${change.from}”改名为“${change.to}”`;
    case 'type': return `${name}的类型从${typeNames[change.from ?? ''] ?? change.from}改为${typeNames[change.to ?? ''] ?? change.to}`;
    case 'options': return `修改${name}的选项`;
    case 'formula': return `修改${name}的公式`;
    case 'rollup': return `修改${name}的汇总设置`;
    case 'relation': return `修改${name}的关联设置`;
    case 'order': return `调整${what}顺序`;
    case 'filters': return `修改${name}的筛选`;
    case 'sorts': return `修改${name}的排序`;
    case 'layout': return `修改${name}的分组或日期字段`;
    case 'display': return `修改${name}的显示设置`;
  }
}

export interface SchemaRestoreContext {
  /** Databases that are still there and not in the trash; a relation to any other stays as it is. */
  activeDatabaseIds: ReadonlySet<string>;
  /** Fields a calendar source writes, which keep their current definition. */
  managedPropertyIds: ReadonlySet<string>;
  /** Time written into fields the restore deletes. */
  now: string;
}

export interface SchemaRestorePlan extends DatabaseSchemaSnapshot { notes: DatabaseSchemaRestoreNote[] }

function withDeleted(def: PropertyDefinition, deletedAt: string | null | undefined): PropertyDefinition {
  const { deletedAt: _old, ...rest } = def;
  void _old;
  return deletedAt ? { ...rest, deletedAt } : rest;
}

/**
 * The schema that brings back `target` on top of `current`. Fields are never dropped: fields added since the
 * version are soft-deleted and keep their row values, deleted fields the version had come back. Relations keep
 * their pairing and calendar fields their definition; what cannot come back, or will not work, is in `notes`.
 */
export function planSchemaRestore(current: DatabaseSchemaSnapshot, target: DatabaseSchemaSnapshot, context: SchemaRestoreContext): SchemaRestorePlan {
  const notes: DatabaseSchemaRestoreNote[] = [];
  const now = new Map(current.properties.map(def => [def.id, def]));
  const properties: PropertyDefinition[] = [];
  const placed = new Set<string>();
  for (const old of target.properties) {
    const def = now.get(old.id);
    if (!def) { notes.push({ kind: 'property-missing', target: 'property', id: old.id, name: old.name }); continue; }
    placed.add(def.id);
    if (context.managedPropertyIds.has(def.id)) {
      if (!same(withDeleted(def, null), withDeleted(old, null)) || Boolean(def.deletedAt) !== Boolean(old.deletedAt)) {
        notes.push({ kind: 'property-synced', target: 'property', id: def.id, name: def.name });
      }
      properties.push(def);
      continue;
    }
    if (def.type === 'title') { properties.push({ ...withDeleted(old, null), type: 'title' }); continue; }
    const deletedAt = old.deletedAt ? (def.deletedAt ?? context.now) : null;
    if (def.type === 'relation' || old.type === 'relation') {
      // The pairing cannot change through a save; only the name and whether it is deleted come back.
      if (!deletedAt && def.deletedAt && def.relation && !context.activeDatabaseIds.has(def.relation.databaseId)) {
        notes.push({ kind: 'relation-target-missing', target: 'property', id: def.id, name: old.name });
        properties.push({ ...def, name: old.name });
        continue;
      }
      properties.push(withDeleted({ ...def, name: old.name }, deletedAt));
      continue;
    }
    properties.push(withDeleted(old, deletedAt));
  }
  for (const def of current.properties) {
    if (placed.has(def.id)) continue;
    if (def.deletedAt || def.type === 'title') { properties.push(def); continue; }
    if (context.managedPropertyIds.has(def.id)) {
      notes.push({ kind: 'property-synced', target: 'property', id: def.id, name: def.name });
      properties.push(def);
      continue;
    }
    properties.push(withDeleted(def, context.now));
  }
  // A database has at most one active tags field; the one listed first wins.
  let tags = false;
  for (const [index, def] of properties.entries()) {
    if (def.type !== 'tags' || def.deletedAt) continue;
    if (!tags) { tags = true; continue; }
    properties[index] = withDeleted(def, context.now);
    notes.push({ kind: 'tags-conflict', target: 'property', id: def.id, name: def.name });
  }

  const active = new Map(activeProperties(properties).map(def => [def.id, def]));
  for (const def of active.values()) {
    if (def.type === 'formula') {
      const parsed = parseFormula(def.formula!.expression, properties);
      if (!parsed.ok) notes.push({ kind: 'formula-invalid', target: 'property', id: def.id, name: def.name, detail: parsed.error });
    } else if (def.type === 'rollup') {
      const relation = active.get(def.rollup!.relationPropertyId);
      if (relation?.type !== 'relation' || !relation.relation || !context.activeDatabaseIds.has(relation.relation.databaseId)) {
        notes.push({ kind: 'rollup-invalid', target: 'property', id: def.id, name: def.name });
      }
    }
  }
  const usable = (propertyId: string, operator?: string) => {
    const def = active.get(propertyId);
    return def !== undefined && (operator === undefined || (filterOperatorsFor(effectiveType(def)) as readonly string[]).includes(operator));
  };
  const views = target.views.map(view => {
    const filters = retainFilters(view.filters, filter => usable(filter.propertyId, filter.operator));
    const sorts = view.sorts.filter(sort => usable(sort.propertyId));
    if (flatFilters(filters).length === flatFilters(view.filters).length && sorts.length === view.sorts.length) return view;
    notes.push({ kind: 'view-adjusted', target: 'view', id: view.id, name: view.name });
    return { ...view, filters, sorts };
  });
  return { properties, views, notes };
}

/** One line of Chinese per restore note. */
export function describeRestoreNote(note: DatabaseSchemaRestoreNote): string {
  switch (note.kind) {
    case 'property-missing': return `字段“${note.name}”已不存在，未恢复`;
    case 'relation-target-missing': return `关联字段“${note.name}”的目标数据库已删除或在回收站中，保持删除`;
    case 'property-synced': return `字段“${note.name}”由日历同步维护，保持当前设置`;
    case 'tags-conflict': return `字段“${note.name}”与另一个标签字段冲突，保持删除`;
    case 'formula-invalid': return `公式“${note.name}”无法计算：${note.detail ?? '引用的字段不可用'}`;
    case 'rollup-invalid': return `汇总“${note.name}”的关联字段不可用，结果为空`;
    case 'view-adjusted': return `视图“${note.name}”中引用已删除字段的筛选或排序已移除`;
  }
}
