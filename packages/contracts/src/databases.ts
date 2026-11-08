import type { PageSummary } from './pages.js';

/**
 * Databases are pages whose children are row pages. The schema and views live in a
 * separate record; each row keeps its own values next to its document body.
 */
export const pageKinds = ['document', 'database', 'row'] as const;
export type PageKind = typeof pageKinds[number];

export const propertyTypes = ['title', 'text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url',
  'created_time', 'updated_time'] as const;
export type PropertyType = typeof propertyTypes[number];

/** Types whose value is stored in `row.properties`. Title lives in the page title; times come from the page. */
export const storedPropertyTypes = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url'] as const;
export type StoredPropertyType = typeof storedPropertyTypes[number];

export const optionColors = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export type OptionColor = typeof optionColors[number];

export const databasePropertyLimit = 100;
export const databaseOptionLimit = 200;
export const databaseViewLimit = 20;
export const databaseConditionLimit = 20;
export const databaseRowLimit = 2000;
export const databaseNameLimit = 100;
export const databaseTextValueLimit = 2000;
export const databaseUrlValueLimit = 2048;
export const databaseMultiSelectLimit = 50;
export const databaseColumnWidth = { min: 60, max: 800, default: 180 } as const;

export interface SelectOption {
  id: string;
  name: string;
  color: OptionColor;
}

export interface PropertyDefinition {
  id: string;
  name: string;
  type: PropertyType;
  /** Only for select and multi_select. Order is the display and sort order. */
  options?: SelectOption[];
  /** Soft delete keeps row values so the property can be restored. */
  deletedAt?: string | null;
}

export type PropertyValue = string | number | boolean | string[];
export type RowProperties = Record<string, PropertyValue>;

export const filterOperators = ['contains', 'not_contains', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte',
  'is_empty', 'is_not_empty', 'is_checked', 'is_not_checked'] as const;
export type FilterOperator = typeof filterOperators[number];

export interface ViewFilter {
  propertyId: string;
  operator: FilterOperator;
  value?: string | number | null;
}

export interface ViewSort {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export interface DatabaseView {
  id: string;
  name: string;
  type: 'table';
  filters: ViewFilter[];
  sorts: ViewSort[];
  hiddenPropertyIds: string[];
  /** Column order after the pinned title column; unknown or missing ids fall back to definition order. */
  propertyOrder: string[];
  widths: Record<string, number>;
}

export interface DatabaseRow {
  id: string;
  title: string;
  icon: string | null;
  properties: RowProperties;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseDocument {
  page: PageSummary;
  properties: PropertyDefinition[];
  views: DatabaseView[];
  /** Revision of the schema and views, independent of the page revision. */
  schemaRevision: string;
  /** Active rows in manual order. */
  rows: DatabaseRow[];
}

export interface CreateDatabaseRequest {
  clientMutationId: string;
  parentId: string | null;
  title: string;
  icon?: string | null;
}

export interface UpdateDatabaseSchemaRequest {
  clientMutationId: string;
  expectedRevision: string;
  properties: PropertyDefinition[];
  views: DatabaseView[];
}

export interface DatabaseSchemaResponse {
  pageId: string;
  properties: PropertyDefinition[];
  views: DatabaseView[];
  schemaRevision: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function isDatabaseId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= databaseNameLimit
    && !/[\u0000-\u001f\u007f\p{Cs}]/u.test(value);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

export function isDateValue(value: unknown): value is string {
  if (typeof value !== 'string' || !datePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isUrlValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > databaseUrlValueLimit) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function isStoredPropertyType(type: PropertyType): type is StoredPropertyType {
  return (storedPropertyTypes as readonly string[]).includes(type);
}

function hasOnly(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

export function isSelectOption(value: unknown): value is SelectOption {
  return isRecord(value) && hasOnly(value, ['id', 'name', 'color']) && isDatabaseId(value.id) && isName(value.name)
    && (optionColors as readonly unknown[]).includes(value.color);
}

export function isPropertyDefinition(value: unknown): value is PropertyDefinition {
  if (!isRecord(value) || !hasOnly(value, ['id', 'name', 'type', 'options', 'deletedAt'])) return false;
  if (!isDatabaseId(value.id) || !isName(value.name) || !(propertyTypes as readonly unknown[]).includes(value.type)) return false;
  if (value.deletedAt !== undefined && value.deletedAt !== null && !isIsoTime(value.deletedAt)) return false;
  const selectable = value.type === 'select' || value.type === 'multi_select';
  if (value.options === undefined) return true;
  if (!selectable || !Array.isArray(value.options) || value.options.length > databaseOptionLimit) return false;
  if (!value.options.every(isSelectOption)) return false;
  return new Set(value.options.map(option => (option as SelectOption).id)).size === value.options.length;
}

/** Checks a stored value against its property. Option ids of removed options are tolerated. */
export function isPropertyValue(type: PropertyType, value: unknown): value is PropertyValue {
  switch (type) {
    case 'text': return typeof value === 'string' && value.length > 0 && value.length <= databaseTextValueLimit
      && !/[\u0000\p{Cs}]/u.test(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'select': return isDatabaseId(value);
    case 'multi_select': return Array.isArray(value) && value.length > 0 && value.length <= databaseMultiSelectLimit
      && value.every(isDatabaseId) && new Set(value).size === value.length;
    case 'date': return isDateValue(value);
    case 'checkbox': return value === true;
    case 'url': return isUrlValue(value);
    default: return false;
  }
}

const operatorsByType: Record<PropertyType, readonly FilterOperator[]> = {
  title: ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'],
  text: ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'],
  url: ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  select: ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  multi_select: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  date: ['equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  created_time: ['equals', 'gt', 'gte', 'lt', 'lte'],
  updated_time: ['equals', 'gt', 'gte', 'lt', 'lte'],
  checkbox: ['is_checked', 'is_not_checked'],
};

export function filterOperatorsFor(type: PropertyType): readonly FilterOperator[] {
  return operatorsByType[type];
}

export function operatorNeedsValue(operator: FilterOperator): boolean {
  return !['is_empty', 'is_not_empty', 'is_checked', 'is_not_checked'].includes(operator);
}

function isFilter(value: unknown): value is ViewFilter {
  if (!isRecord(value) || !hasOnly(value, ['propertyId', 'operator', 'value'])) return false;
  if (!isDatabaseId(value.propertyId) || !(filterOperators as readonly unknown[]).includes(value.operator)) return false;
  const v = value.value;
  return v === undefined || v === null || (typeof v === 'string' && v.length <= databaseTextValueLimit)
    || (typeof v === 'number' && Number.isFinite(v));
}

function isSort(value: unknown): value is ViewSort {
  return isRecord(value) && hasOnly(value, ['propertyId', 'direction']) && isDatabaseId(value.propertyId)
    && (value.direction === 'asc' || value.direction === 'desc');
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= databasePropertyLimit && value.every(isDatabaseId)
    && new Set(value).size === value.length;
}

export function isDatabaseView(value: unknown): value is DatabaseView {
  if (!isRecord(value) || !hasOnly(value, ['id', 'name', 'type', 'filters', 'sorts', 'hiddenPropertyIds', 'propertyOrder', 'widths'])) return false;
  if (!isDatabaseId(value.id) || !isName(value.name) || value.type !== 'table') return false;
  if (!Array.isArray(value.filters) || !Array.isArray(value.sorts)) return false;
  if (value.filters.length + value.sorts.length > databaseConditionLimit) return false;
  if (!value.filters.every(isFilter) || !value.sorts.every(isSort)) return false;
  if (!isIdList(value.hiddenPropertyIds) || !isIdList(value.propertyOrder) || !isRecord(value.widths)) return false;
  const widths = Object.entries(value.widths);
  return widths.length <= databasePropertyLimit && widths.every(([key, width]) => isDatabaseId(key)
    && typeof width === 'number' && Number.isInteger(width) && width >= databaseColumnWidth.min && width <= databaseColumnWidth.max);
}

/**
 * Validates a whole schema. Returns a short reason, or null when valid. Exactly one
 * active title property is required, and every view condition must name an active
 * property with an operator its type supports.
 */
export function databaseSchemaProblem(properties: unknown, views: unknown): string | null {
  if (!Array.isArray(properties) || properties.length === 0 || properties.length > databasePropertyLimit) return 'property-count';
  if (!properties.every(isPropertyDefinition)) return 'property-invalid';
  const defs = properties as PropertyDefinition[];
  if (new Set(defs.map(p => p.id)).size !== defs.length) return 'property-duplicate';
  const titles = defs.filter(p => p.type === 'title');
  if (titles.length !== 1 || titles[0]?.deletedAt) return 'title-property';
  if (!Array.isArray(views) || views.length === 0 || views.length > databaseViewLimit) return 'view-count';
  if (!views.every(isDatabaseView)) return 'view-invalid';
  const list = views as DatabaseView[];
  if (new Set(list.map(v => v.id)).size !== list.length) return 'view-duplicate';
  const active = new Map(defs.filter(p => !p.deletedAt).map(p => [p.id, p]));
  for (const view of list) {
    for (const filter of view.filters) {
      const def = active.get(filter.propertyId);
      if (!def || !operatorsByType[def.type].includes(filter.operator)) return 'view-filter';
    }
    if (view.sorts.some(sort => !active.has(sort.propertyId))) return 'view-sort';
  }
  return null;
}

/** Problem with a single row value under the current schema, or null when it may be stored. */
export function rowValueProblem(properties: PropertyDefinition[], propertyId: string, value: unknown): string | null {
  const def = properties.find(p => p.id === propertyId);
  if (!def || def.deletedAt) return 'property-unknown';
  if (!isStoredPropertyType(def.type)) return 'property-readonly';
  if (value === null) return null;
  if (!isPropertyValue(def.type, value)) return 'value-invalid';
  if (def.type === 'select' && !def.options?.some(option => option.id === value)) return 'option-unknown';
  if (def.type === 'multi_select' && !(value as string[]).every(id => def.options?.some(option => option.id === id))) return 'option-unknown';
  return null;
}

/** Applies a property patch (null removes) without validation. */
export function applyRowPatch(current: RowProperties, patch: Record<string, PropertyValue | null>): RowProperties {
  const next: RowProperties = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function activeProperties(properties: PropertyDefinition[]): PropertyDefinition[] {
  return properties.filter(p => !p.deletedAt);
}

/** Visible columns: title first, then the view's order, then remaining properties in definition order. */
export function viewColumns(properties: PropertyDefinition[], view: DatabaseView): PropertyDefinition[] {
  const active = activeProperties(properties);
  const title = active.find(p => p.type === 'title');
  const byId = new Map(active.map(p => [p.id, p]));
  const ordered: PropertyDefinition[] = [];
  const seen = new Set<string>(title ? [title.id] : []);
  for (const id of view.propertyOrder) {
    const def = byId.get(id);
    if (def && !seen.has(id)) { ordered.push(def); seen.add(id); }
  }
  for (const def of active) if (!seen.has(def.id)) { ordered.push(def); seen.add(def.id); }
  const hidden = new Set(view.hiddenPropertyIds);
  return [...(title ? [title] : []), ...ordered.filter(def => !hidden.has(def.id))];
}

/** Raw comparable value for a property; undefined means empty. */
export function cellValue(row: DatabaseRow, def: PropertyDefinition): PropertyValue | undefined {
  if (def.type === 'title') return row.title.trim() ? row.title : undefined;
  if (def.type === 'created_time') return row.createdAt;
  if (def.type === 'updated_time') return row.updatedAt;
  const value = row.properties[def.id];
  // A value written under an earlier type of this property reads as empty until it is replaced.
  return value !== undefined && isPropertyValue(def.type, value) ? value : undefined;
}

/** Text used for search, filtering by text and display of select options. */
export function cellText(row: DatabaseRow, def: PropertyDefinition): string {
  const value = cellValue(row, def);
  if (value === undefined) return '';
  if (def.type === 'select') return def.options?.find(option => option.id === value)?.name ?? '';
  if (def.type === 'multi_select') {
    return (value as string[]).map(id => def.options?.find(option => option.id === id)?.name).filter(Boolean).join(', ');
  }
  if (def.type === 'checkbox') return value === true ? '✓' : '';
  return String(value);
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function datePart(def: PropertyDefinition, value: PropertyValue): string {
  return def.type === 'date' ? String(value) : String(value).slice(0, 10);
}

function isEmpty(row: DatabaseRow, def: PropertyDefinition): boolean {
  const value = cellValue(row, def);
  if (value === undefined) return true;
  if (def.type === 'select') return !def.options?.some(option => option.id === value);
  if (def.type === 'multi_select') return !(value as string[]).some(id => def.options?.some(option => option.id === id));
  return false;
}

function matches(row: DatabaseRow, def: PropertyDefinition, filter: ViewFilter): boolean {
  const op = filter.operator;
  if (op === 'is_empty') return isEmpty(row, def);
  if (op === 'is_not_empty') return !isEmpty(row, def);
  if (op === 'is_checked') return cellValue(row, def) === true;
  if (op === 'is_not_checked') return cellValue(row, def) !== true;
  const target = filter.value;
  // An incomplete condition does not hide rows; the toolbar shows it as unfinished.
  if (target === undefined || target === null || target === '') return true;
  const value = cellValue(row, def);
  switch (def.type) {
    case 'title': case 'text': case 'url': {
      const text = cellText(row, def).toLocaleLowerCase();
      const needle = String(target).toLocaleLowerCase();
      if (op === 'contains') return text.includes(needle);
      if (op === 'not_contains') return !text.includes(needle);
      if (op === 'equals') return text === needle;
      if (op === 'not_equals') return text !== needle;
      return true;
    }
    case 'number': {
      if (value === undefined) return op === 'not_equals';
      const n = value as number;
      const t = Number(target);
      if (!Number.isFinite(t)) return true;
      return op === 'equals' ? n === t : op === 'not_equals' ? n !== t : op === 'gt' ? n > t
        : op === 'gte' ? n >= t : op === 'lt' ? n < t : op === 'lte' ? n <= t : true;
    }
    case 'select':
      if (op === 'equals') return value === target;
      if (op === 'not_equals') return value !== target;
      return true;
    case 'multi_select': {
      const has = Array.isArray(value) && value.includes(String(target));
      return op === 'contains' ? has : op === 'not_contains' ? !has : true;
    }
    case 'date': case 'created_time': case 'updated_time': {
      if (value === undefined) return false;
      const day = datePart(def, value);
      const t = String(target);
      return op === 'equals' ? day === t : op === 'gt' ? day > t : op === 'gte' ? day >= t
        : op === 'lt' ? day < t : op === 'lte' ? day <= t : true;
    }
    default: return true;
  }
}

function compare(a: DatabaseRow, b: DatabaseRow, def: PropertyDefinition): number {
  const av = cellValue(a, def);
  const bv = cellValue(b, def);
  const aEmpty = isEmpty(a, def);
  const bEmpty = isEmpty(b, def);
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  switch (def.type) {
    case 'number': return (av as number) - (bv as number);
    case 'checkbox': return 0;
    case 'select': case 'multi_select': {
      const rank = (value: PropertyValue | undefined) => {
        const first = Array.isArray(value) ? value[0] : value;
        const index = def.options?.findIndex(option => option.id === first) ?? -1;
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      return rank(av) - rank(bv);
    }
    case 'date': case 'created_time': case 'updated_time':
      return String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
    default: return collator.compare(cellText(a, def), cellText(b, def));
  }
}

export interface EvaluatedView {
  columns: PropertyDefinition[];
  rows: DatabaseRow[];
}

/**
 * Filters (all conditions must match) and sorts rows for a table view. Rows keep their
 * manual order when no sort applies; empty values sort last in both directions.
 */
export function evaluateView(rows: DatabaseRow[], properties: PropertyDefinition[], view: DatabaseView): EvaluatedView {
  const active = new Map(activeProperties(properties).map(p => [p.id, p]));
  const filters = view.filters.flatMap(filter => {
    const def = active.get(filter.propertyId);
    return def && operatorsByType[def.type].includes(filter.operator) ? [{ filter, def }] : [];
  });
  const sorts = view.sorts.flatMap(sort => {
    const def = active.get(sort.propertyId);
    return def ? [{ sort, def }] : [];
  });
  const kept = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => filters.every(({ filter, def }) => matches(row, def, filter)));
  if (sorts.length) {
    kept.sort((x, y) => {
      for (const { sort, def } of sorts) {
        const emptyX = isEmpty(x.row, def);
        const emptyY = isEmpty(y.row, def);
        if (emptyX !== emptyY) return emptyX ? 1 : -1;
        const result = compare(x.row, y.row, def);
        if (result !== 0) return sort.direction === 'asc' ? result : -result;
      }
      return x.index - y.index;
    });
  }
  return { columns: viewColumns(properties, view), rows: kept.map(({ row }) => row) };
}

/** Plain text of a row's stored properties, for the page search index. */
export function rowSearchText(properties: PropertyDefinition[], values: RowProperties): string {
  const row: DatabaseRow = { id: '', title: '', icon: null, properties: values, revision: '1', createdAt: '', updatedAt: '' };
  return activeProperties(properties)
    .filter(def => def.type === 'text' || def.type === 'url' || def.type === 'select' || def.type === 'multi_select')
    .map(def => cellText(row, def)).filter(Boolean).join('\n');
}

/** A document block that shows a database view. It stores references only, never rows. */
export interface SerializedDatabaseView {
  type: 'database-view';
  version: 1;
  databaseId: string;
  /** null shows the database's first view. */
  viewId: string | null;
}

export function isSerializedDatabaseView(value: unknown): value is SerializedDatabaseView {
  if (!isRecord(value) || !hasOnly(value, ['type', 'version', 'databaseId', 'viewId', '$'])) return false;
  return value.type === 'database-view' && value.version === 1 && isDatabaseId(value.databaseId)
    && value.databaseId === value.databaseId.toLowerCase()
    && (value.viewId === null || (isDatabaseId(value.viewId) && value.viewId === value.viewId.toLowerCase()));
}

/** Default schema for a new database: a title property and one table view. */
export function defaultDatabaseSchema(ids: { title: string; view: string }): { properties: PropertyDefinition[]; views: DatabaseView[] } {
  return {
    properties: [{ id: ids.title, name: '名称', type: 'title' }],
    views: [{ id: ids.view, name: '表格', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} }],
  };
}
