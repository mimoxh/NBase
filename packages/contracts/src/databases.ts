import type { PageSummary } from './pages.js';

/**
 * Databases are pages whose children are row pages. The schema and views live in a
 * separate record; each row keeps its own values next to its document body.
 */
export const pageKinds = ['document', 'database', 'row'] as const;
export type PageKind = typeof pageKinds[number];

export const propertyTypes = ['title', 'text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url',
  'created_time', 'updated_time', 'relation'] as const;
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
export const databaseRowLimit = 30000;
export const databaseBulkLimit = 500;
/** Rows one relation cell of the owning side may point to. */
export const databaseRelationLimit = 500;
/** Related rows returned with each row; `total` tells how many there are. */
export const databaseRelationPreview = 5;
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
  /** Used by select and multi_select; kept under other types so changing back restores them. Order is the display and sort order. */
  options?: SelectOption[];
  /** Soft delete keeps row values so the property can be restored. */
  deletedAt?: string | null;
  /** Only for relation. The two sides of a link are a pair of properties; the owning side stores the row ids. */
  relation?: RelationConfig;
}

export interface RelationConfig {
  databaseId: string;
  pairedPropertyId: string;
  owner: boolean;
}

export interface RelationCell {
  items: { id: string; title: string }[];
  total: number;
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

/** Conditions of which at least one must hold. A view's entries must all hold. */
export interface ViewFilterGroup {
  any: ViewFilter[];
}

export type ViewFilterEntry = ViewFilter | ViewFilterGroup;

export function isFilterGroup(entry: ViewFilterEntry): entry is ViewFilterGroup {
  return 'any' in entry;
}

/** Every condition of a view, wherever it is grouped. */
export function flatFilters(entries: readonly ViewFilterEntry[]): ViewFilter[] {
  return entries.flatMap(entry => isFilterGroup(entry) ? entry.any : [entry]);
}

/** Removes conditions; a group left empty goes too. */
export function retainFilters(entries: readonly ViewFilterEntry[], keep: (filter: ViewFilter) => boolean): ViewFilterEntry[] {
  return entries.flatMap((entry): ViewFilterEntry[] => {
    if (!isFilterGroup(entry)) return keep(entry) ? [entry] : [];
    const any = entry.any.filter(keep);
    return any.length ? [{ any }] : [];
  });
}

/** Filter values on date properties may be one of these, written with a leading `@`. */
export const relativeDateTokens = ['today', 'yesterday', 'tomorrow', 'this_week', 'last_week', 'next_week', 'this_month',
  'last_month', 'next_month', 'last_7_days', 'last_30_days', 'next_7_days', 'next_30_days'] as const;
export type RelativeDateToken = typeof relativeDateTokens[number];

/** What "today" and a day of a timestamp mean for a reader. Missing fields fall back to the runtime's local time. */
export interface QueryContext {
  timeZone?: string;
  today?: string;
  /** 0 is Sunday, 1 is Monday. */
  weekStart?: 0 | 1;
}

export interface ViewSort {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export const databaseViewTypes = ['table', 'board', 'calendar'] as const;
export type DatabaseViewType = typeof databaseViewTypes[number];

export interface DatabaseView {
  id: string;
  name: string;
  type: DatabaseViewType;
  /** Board views: a single-select or checkbox property. */
  groupPropertyId?: string;
  /** Calendar views: a date, created-time or updated-time property. */
  datePropertyId?: string;
  filters: ViewFilterEntry[];
  sorts: ViewSort[];
  hiddenPropertyIds: string[];
  /** Column order after the pinned title column; unknown or missing ids fall back to definition order. */
  propertyOrder: string[];
  widths: Record<string, number>;
  /** How many columns, counted from the title, stay in place when the table scrolls sideways. */
  frozenColumns?: number;
  /** Footer statistic per property. */
  aggregates?: Record<string, AggregateFunction>;
}

export const aggregateFunctions = ['count', 'count_values', 'count_empty', 'sum', 'avg', 'min', 'max'] as const;
export type AggregateFunction = typeof aggregateFunctions[number];

export function aggregatesFor(type: PropertyType): readonly AggregateFunction[] {
  if (type === 'number') return aggregateFunctions;
  if (type === 'date' || type === 'created_time' || type === 'updated_time') return ['count', 'count_values', 'count_empty', 'min', 'max'];
  return ['count', 'count_values', 'count_empty'];
}

export interface DatabaseRow {
  id: string;
  title: string;
  icon: string | null;
  properties: RowProperties;
  revision: string;
  createdAt: string;
  updatedAt: string;
  /** Linked rows per relation property, only in responses that read rows of a database. */
  relations?: Record<string, RelationCell>;
}

export interface CreateRelationRequest {
  clientMutationId: string;
  targetDatabaseId: string;
  name: string;
  pairedName: string;
}

export interface ChangeRelationRequest {
  clientMutationId: string;
  add: string[];
  remove: string[];
}

export interface ChangeRelationResponse {
  pageId: string;
  /** The edited row, with its relation cell re-read. */
  row: DatabaseRow;
  /** Owning rows whose revision changed. */
  touched: { id: string; revision: string; updatedAt: string }[];
  /** Other database affected, for refreshing its open views. */
  otherDatabaseId: string;
}

export interface DatabaseOption { id: string; title: string; icon: string | null }

function isRelationConfig(value: unknown): value is RelationConfig {
  return isRecord(value) && hasOnly(value, ['databaseId', 'pairedPropertyId', 'owner']) && isDatabaseId(value.databaseId)
    && isDatabaseId(value.pairedPropertyId) && typeof value.owner === 'boolean';
}

export function isCreateRelationRequest(value: unknown): value is CreateRelationRequest {
  return isRecord(value) && hasOnly(value, ['clientMutationId', 'targetDatabaseId', 'name', 'pairedName'])
    && isDatabaseId(value.clientMutationId) && isDatabaseId(value.targetDatabaseId) && isName(value.name) && isName(value.pairedName);
}

export function isChangeRelationRequest(value: unknown): value is ChangeRelationRequest {
  if (!isRecord(value) || !hasOnly(value, ['clientMutationId', 'add', 'remove']) || !isDatabaseId(value.clientMutationId)) return false;
  const list = (ids: unknown) => Array.isArray(ids) && ids.length <= 100 && ids.every(isDatabaseId);
  return list(value.add) && list(value.remove) && ((value.add as string[]).length + (value.remove as string[]).length > 0);
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
  if (!isRecord(value) || !hasOnly(value, ['id', 'name', 'type', 'options', 'deletedAt', 'relation'])) return false;
  if (!isDatabaseId(value.id) || !isName(value.name) || !(propertyTypes as readonly unknown[]).includes(value.type)) return false;
  if (value.deletedAt !== undefined && value.deletedAt !== null && !isIsoTime(value.deletedAt)) return false;
  if ((value.type === 'relation') !== (value.relation !== undefined)) return false;
  if (value.relation !== undefined && !isRelationConfig(value.relation)) return false;
  if (value.options === undefined) return true;
  if (!Array.isArray(value.options) || value.options.length > databaseOptionLimit) return false;
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
  relation: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
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

function isFilterEntry(value: unknown): value is ViewFilterEntry {
  if (isFilter(value)) return true;
  return isRecord(value) && hasOnly(value, ['any']) && Array.isArray(value.any) && value.any.length > 0
    && value.any.length <= databaseConditionLimit && value.any.every(isFilter);
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
  if (!isRecord(value) || !hasOnly(value, ['id', 'name', 'type', 'groupPropertyId', 'datePropertyId', 'filters', 'sorts', 'hiddenPropertyIds', 'propertyOrder', 'widths', 'frozenColumns', 'aggregates'])) return false;
  if (value.groupPropertyId !== undefined && !isDatabaseId(value.groupPropertyId)) return false;
  if (value.datePropertyId !== undefined && !isDatabaseId(value.datePropertyId)) return false;
  if (value.frozenColumns !== undefined && !(Number.isInteger(value.frozenColumns) && (value.frozenColumns as number) >= 0 && (value.frozenColumns as number) <= 20)) return false;
  if (value.aggregates !== undefined && !(isRecord(value.aggregates) && Object.keys(value.aggregates).length <= databasePropertyLimit
    && Object.entries(value.aggregates).every(([key, fn]) => isDatabaseId(key) && (aggregateFunctions as readonly unknown[]).includes(fn)))) return false;
  if (!isDatabaseId(value.id) || !isName(value.name) || !(databaseViewTypes as readonly unknown[]).includes(value.type)) return false;
  if (!Array.isArray(value.filters) || !Array.isArray(value.sorts)) return false;
  if (!value.filters.every(isFilterEntry) || !value.sorts.every(isSort)) return false;
  if (flatFilters(value.filters).length + value.sorts.length > databaseConditionLimit) return false;
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
    for (const filter of flatFilters(view.filters)) {
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
  if (def.type === 'relation') {
    const cell = row.relations?.[def.id];
    return cell?.total ? cell.items.map(item => item.title) : undefined;
  }
  if (def.type === 'title') return row.title.trim() ? row.title : undefined;
  if (def.type === 'created_time') return row.createdAt;
  if (def.type === 'updated_time') return row.updatedAt;
  const value = row.properties[def.id];
  // A value written under an earlier type of this property reads as empty until it is replaced.
  // An option id is a valid string, so a former select needs its options checked as well.
  if (def.type === 'text' && def.options?.some(option => option.id === value)) return undefined;
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
  if (def.type === 'relation') return (value as string[]).join(', ');
  return String(value);
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

const pad2 = (n: number) => String(n).padStart(2, '0');
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of an instant for a reader; without a zone, in the runtime's local time. */
export function localDay(time: Date, timeZone?: string): string {
  if (!timeZone) return `${time.getFullYear()}-${pad2(time.getMonth() + 1)}-${pad2(time.getDate())}`;
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter.format(time);
}

/** Calendar day to compare. Page times are UTC instants, shown and filtered as the reader's local day. */
function datePart(def: PropertyDefinition, value: PropertyValue, timeZone?: string): string {
  if (def.type === 'date') return String(value);
  const time = new Date(String(value));
  if (Number.isNaN(time.getTime())) return String(value).slice(0, 10);
  return localDay(time, timeZone);
}

function shiftDay(day: string, days: number): string {
  const time = new Date(`${day}T00:00:00Z`);
  time.setUTCDate(time.getUTCDate() + days);
  return time.toISOString().slice(0, 10);
}

function monthRange(day: string, months: number): DayRange {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(year, month - 1 + months, 1));
  const to = new Date(Date.UTC(year, month + months, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export interface DayRange { from: string; to: string }

/** The inclusive days a relative token covers, or null for an unknown token. */
export function resolveRelativeDate(token: string, today: string, weekStart: 0 | 1 = 1): DayRange | null {
  const single = (offset: number): DayRange => { const day = shiftDay(today, offset); return { from: day, to: day }; };
  const week = (offset: number): DayRange => {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const start = shiftDay(today, -((weekday - weekStart + 7) % 7) + offset * 7);
    return { from: start, to: shiftDay(start, 6) };
  };
  switch (token as RelativeDateToken) {
    case 'today': return single(0);
    case 'yesterday': return single(-1);
    case 'tomorrow': return single(1);
    case 'this_week': return week(0);
    case 'last_week': return week(-1);
    case 'next_week': return week(1);
    case 'this_month': return monthRange(today, 0);
    case 'last_month': return monthRange(today, -1);
    case 'next_month': return monthRange(today, 1);
    case 'last_7_days': return { from: shiftDay(today, -6), to: today };
    case 'last_30_days': return { from: shiftDay(today, -29), to: today };
    case 'next_7_days': return { from: today, to: shiftDay(today, 6) };
    case 'next_30_days': return { from: today, to: shiftDay(today, 29) };
    default: return null;
  }
}

function isEmpty(row: DatabaseRow, def: PropertyDefinition): boolean {
  // Unchecked is a value of its own, so it follows the sort direction.
  if (def.type === 'checkbox') return false;
  const value = cellValue(row, def);
  if (value === undefined) return true;
  if (def.type === 'select') return !def.options?.some(option => option.id === value);
  if (def.type === 'multi_select') return !(value as string[]).some(id => def.options?.some(option => option.id === id));
  return false;
}

/** A condition ready to run: its property is known, its operator fits and its value is complete. */
export interface ResolvedCondition {
  def: PropertyDefinition;
  operator: FilterOperator;
  /** Absent for operators without a value. */
  target?: string | number;
  /** Date conditions compare against these inclusive days. */
  days?: DayRange;
}

/**
 * Turns a view's filters into runnable conditions: the outer list must all hold and each inner list
 * needs one match. Incomplete conditions drop out first, so a half-typed one cannot widen an "or".
 */
export function resolveFilters(entries: readonly ViewFilterEntry[], properties: PropertyDefinition[], context: QueryContext = {}): ResolvedCondition[][] {
  const active = new Map(activeProperties(properties).map(p => [p.id, p]));
  const today = context.today ?? localDay(new Date(), context.timeZone);
  const resolve = (filter: ViewFilter): ResolvedCondition | null => {
    const def = active.get(filter.propertyId);
    if (!def || !operatorsByType[def.type].includes(filter.operator)) return null;
    if (!operatorNeedsValue(filter.operator)) return { def, operator: filter.operator };
    const value = filter.value;
    if (value === undefined || value === null || value === '') return null;
    if (def.type === 'number') {
      const target = Number(value);
      return Number.isFinite(target) ? { def, operator: filter.operator, target } : null;
    }
    if (def.type === 'date' || def.type === 'created_time' || def.type === 'updated_time') {
      const text = String(value);
      if (!text.startsWith('@')) return { def, operator: filter.operator, target: text, days: { from: text, to: text } };
      const days = resolveRelativeDate(text.slice(1), today, context.weekStart);
      return days ? { def, operator: filter.operator, target: text, days } : null;
    }
    return { def, operator: filter.operator, target: String(value) };
  };
  return entries.flatMap(entry => {
    const group = (isFilterGroup(entry) ? entry.any : [entry]).map(resolve).filter((item): item is ResolvedCondition => item !== null);
    return group.length ? [group] : [];
  });
}

function matches(row: DatabaseRow, condition: ResolvedCondition, context: QueryContext): boolean {
  const { def, operator: op, target, days } = condition;
  if (op === 'is_empty') return isEmpty(row, def);
  if (op === 'is_not_empty') return !isEmpty(row, def);
  if (op === 'is_checked') return cellValue(row, def) === true;
  if (op === 'is_not_checked') return cellValue(row, def) !== true;
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
      const t = target as number;
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
    case 'relation': {
      const needle = String(target).toLocaleLowerCase();
      const has = Array.isArray(value) && value.some(title => title.toLocaleLowerCase().includes(needle));
      return op === 'contains' ? has : !has;
    }
    case 'date': case 'created_time': case 'updated_time': {
      if (value === undefined) return false;
      const day = datePart(def, value, context.timeZone);
      const { from, to } = days!;
      return op === 'equals' ? day >= from && day <= to : op === 'gt' ? day > to : op === 'gte' ? day >= from
        : op === 'lt' ? day < from : op === 'lte' ? day <= to : true;
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
    case 'checkbox': return Number(av === true) - Number(bv === true);
    case 'relation': return (a.relations?.[def.id]?.total ?? 0) - (b.relations?.[def.id]?.total ?? 0);
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
export function evaluateView(rows: DatabaseRow[], properties: PropertyDefinition[], view: DatabaseView,
  context: QueryContext = {}): EvaluatedView {
  const active = new Map(activeProperties(properties).map(p => [p.id, p]));
  const groups = resolveFilters(view.filters, properties, context);
  const sorts = view.sorts.flatMap(sort => {
    const def = active.get(sort.propertyId);
    return def ? [{ sort, def }] : [];
  });
  const kept = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => groups.every(group => group.some(condition => matches(row, condition, context))));
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

export interface AggregateItem { propertyId: string; fn: AggregateFunction }
export interface DatabaseAggregateRequest extends Pick<DatabaseQueryRequest, 'filters' | 'context'> { items: AggregateItem[] }
export interface DatabaseAggregateResponse { values: (number | string | null)[] }

export function isDatabaseAggregateRequest(value: unknown): value is DatabaseAggregateRequest {
  if (!isRecord(value) || !hasOnly(value, ['filters', 'context', 'items']) || !Array.isArray(value.items) || value.items.length > databasePropertyLimit) return false;
  if (!value.items.every(item => isRecord(item) && hasOnly(item, ['propertyId', 'fn']) && isDatabaseId(item.propertyId)
    && (aggregateFunctions as readonly unknown[]).includes(item.fn))) return false;
  return isDatabaseQueryRequest({ filters: value.filters, sorts: [], ...(value.context === undefined ? {} : { context: value.context }) });
}

/** Footer statistics over rows that already passed the view's filters. */
export function aggregateRows(rows: DatabaseRow[], properties: PropertyDefinition[], items: AggregateItem[]): (number | string | null)[] {
  const active = new Map(activeProperties(properties).map(p => [p.id, p]));
  return items.map(({ propertyId, fn }) => {
    const def = active.get(propertyId);
    if (!def || !aggregatesFor(def.type).includes(fn)) return null;
    if (fn === 'count') return rows.length;
    const filled = rows.filter(row => !isEmpty(row, def));
    if (fn === 'count_values') return filled.length;
    if (fn === 'count_empty') return rows.length - filled.length;
    if (!filled.length) return null;
    const values = filled.map(row => cellValue(row, def)!);
    if (def.type === 'number') {
      const numbers = values as number[];
      if (fn === 'sum') return numbers.reduce((a, b) => a + b, 0);
      if (fn === 'avg') return numbers.reduce((a, b) => a + b, 0) / numbers.length;
      return fn === 'min' ? Math.min(...numbers) : Math.max(...numbers);
    }
    const sorted = (values as string[]).slice().sort();
    return fn === 'min' ? sorted[0]! : sorted.at(-1)!;
  });
}

export const databaseQueryWindow = 200;

/** A view's conditions, evaluated by the server over the whole database. */
export interface DatabaseQueryRequest {
  filters: ViewFilterEntry[];
  sorts: ViewSort[];
  context?: Pick<QueryContext, 'timeZone' | 'weekStart'>;
  /** Returns `groups` as well: rows split by this single-select or checkbox property. */
  groupBy?: string;
}

/** A board column. `key` is an option id, 'true' or 'false', or null for rows with no group. */
export interface DatabaseRowGroup { key: string | null; ids: string[] }

export function isGroupableProperty(def: PropertyDefinition): boolean {
  return def.type === 'select' || def.type === 'checkbox';
}

export function isCalendarProperty(def: PropertyDefinition): boolean {
  return def.type === 'date' || def.type === 'created_time' || def.type === 'updated_time';
}

/** The group a row belongs to on a board. */
export function rowGroupKey(row: DatabaseRow, def: PropertyDefinition): string | null {
  if (def.type === 'checkbox') return cellValue(row, def) === true ? 'true' : 'false';
  return isEmpty(row, def) ? null : String(cellValue(row, def));
}

/** Splits ordered rows into groups, keeping their order inside each group. */
export function groupRows(rows: DatabaseRow[], def: PropertyDefinition): DatabaseRowGroup[] {
  const groups = new Map<string | null, string[]>();
  for (const row of rows) {
    const key = rowGroupKey(row, def);
    const ids = groups.get(key);
    if (ids) ids.push(row.id); else groups.set(key, [row.id]);
  }
  return [...groups].map(([key, ids]) => ({ key, ids }));
}

export interface DatabaseQueryResponse {
  /** Every matching row id, in view order. */
  order: string[];
  total: number;
  /** Rows in the database, whether or not they match. */
  allRows: number;
  /** The first window of `order`. */
  rows: DatabaseRow[];
  schemaRevision: string;
  groups?: DatabaseRowGroup[];
}

export interface BulkRowPatch {
  id: string;
  /** When present the row must still be at this revision. Without it, only the named fields are overwritten. */
  revision?: string;
  title?: string;
  properties?: Record<string, PropertyValue | null>;
}

export type DatabaseBulkRequest = { clientMutationId: string } & (
  | { operation: 'create'; rows: { title: string; properties: RowProperties }[] }
  | { operation: 'patch'; items: BulkRowPatch[] }
  | { operation: 'trash'; ids: string[] }
  | { operation: 'duplicate'; ids: string[] }
);

export interface DatabaseBulkResponse {
  pageId: string;
  rows: { id: string; revision: string; updatedAt: string }[];
}

function isIdBatch(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= databaseBulkLimit && value.every(isDatabaseId)
    && new Set(value).size === value.length;
}

function isPatchValues(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length <= databasePropertyLimit && Object.keys(value).every(isDatabaseId);
}

/** Checks the shape of a bulk request; values are validated against the schema when applied. */
export function isDatabaseBulkRequest(value: unknown): value is DatabaseBulkRequest {
  if (!isRecord(value) || !isDatabaseId(value.clientMutationId)) return false;
  const title = (t: unknown) => typeof t === 'string' && t.length <= 255;
  switch (value.operation) {
    case 'create':
      return hasOnly(value, ['clientMutationId', 'operation', 'rows']) && Array.isArray(value.rows) && value.rows.length > 0
        && value.rows.length <= databaseBulkLimit
        && value.rows.every(row => isRecord(row) && hasOnly(row, ['title', 'properties']) && title(row.title) && isPatchValues(row.properties));
    case 'patch':
      return hasOnly(value, ['clientMutationId', 'operation', 'items']) && Array.isArray(value.items) && value.items.length > 0
        && value.items.length <= databaseBulkLimit
        && value.items.every(item => isRecord(item) && hasOnly(item, ['id', 'revision', 'title', 'properties']) && isDatabaseId(item.id)
          && (item.revision === undefined || (typeof item.revision === 'string' && /^\d{1,19}$/.test(item.revision)))
          && (item.title === undefined || title(item.title)) && (item.properties === undefined || isPatchValues(item.properties))
          && (item.title !== undefined || item.properties !== undefined))
        && new Set(value.items.map(item => (item as BulkRowPatch).id)).size === value.items.length;
    case 'trash': case 'duplicate':
      return hasOnly(value, ['clientMutationId', 'operation', 'ids']) && isIdBatch(value.ids);
    default: return false;
  }
}

export interface DatabaseRowsRequest { ids: string[] }
export interface DatabaseRowsResponse { rows: DatabaseRow[] }

/** Checks a query body; conditions naming unknown properties are ignored when run, like saved views. */
export function isDatabaseQueryRequest(value: unknown): value is DatabaseQueryRequest {
  if (!isRecord(value) || !hasOnly(value, ['filters', 'sorts', 'context', 'groupBy'])) return false;
  if (!Array.isArray(value.filters) || !Array.isArray(value.sorts)) return false;
  if (!value.filters.every(isFilterEntry) || !value.sorts.every(isSort)) return false;
  // A calendar adds its month range on top of a view's own conditions.
  if (flatFilters(value.filters).length + value.sorts.length > databaseConditionLimit + 2) return false;
  if (value.groupBy !== undefined && !isDatabaseId(value.groupBy)) return false;
  if (value.context === undefined) return true;
  if (!isRecord(value.context) || !hasOnly(value.context, ['timeZone', 'weekStart'])) return false;
  const { timeZone, weekStart } = value.context;
  return (timeZone === undefined || (typeof timeZone === 'string' && timeZone.length <= 64))
    && (weekStart === undefined || weekStart === 0 || weekStart === 1);
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
