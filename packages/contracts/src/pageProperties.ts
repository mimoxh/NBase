import { databaseNameLimit, databaseTextValueLimit, isDatabaseId, isSelectOption, type SelectOption } from './databases.js';
import { isDateCellValue } from './dateCells.js';

/**
 * Properties an ordinary document page defines for itself. Each page keeps its own fields and values;
 * database rows use the schema of their database instead. Values follow the database cell formats:
 * a select stores an option id, a date the grammar of `isDateCellValue`.
 */
export const pagePropertyTypes = ['text', 'number', 'date', 'select'] as const;
export type PagePropertyType = typeof pagePropertyTypes[number];

export const pagePropertyLimit = 50;
export const pagePropertyOptionLimit = 100;
/** Front matter keys with their own meaning; a property may not take them as its name. */
export const pagePropertyReservedNames = ['title', 'tags', 'date'] as const;

export interface PageProperty {
  id: string;
  name: string;
  type: PagePropertyType;
  value: string | number | null;
  /** Select only. */
  options?: SelectOption[];
}

/** Names compare without case, so they map to distinct front matter keys. */
export function pagePropertyNameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

export function isPagePropertyName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && [...value].length <= databaseNameLimit
    && !/[\u0000-\u001f\u007f\p{Cs}]/u.test(value)
    && !(pagePropertyReservedNames as readonly string[]).includes(pagePropertyNameKey(value));
}

function isPropertyValue(property: Record<string, unknown>): boolean {
  const value = property.value;
  if (value === null) return true;
  switch (property.type) {
    case 'text': return typeof value === 'string' && value.length > 0 && value.length <= databaseTextValueLimit
      && !/[\u0000\p{Cs}]/u.test(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'date': return isDateCellValue(value);
    case 'select': return Array.isArray(property.options) && property.options.some(option => (option as SelectOption).id === value);
    default: return false;
  }
}

export function isPageProperty(value: unknown): value is PageProperty {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!Object.keys(item).every(key => ['id', 'name', 'type', 'value', 'options'].includes(key))) return false;
  if (!isDatabaseId(item.id) || item.id !== item.id.toLowerCase() || !isPagePropertyName(item.name)
    || !(pagePropertyTypes as readonly unknown[]).includes(item.type) || !Object.hasOwn(item, 'value')) return false;
  if (item.options !== undefined) {
    if (item.type !== 'select' || !Array.isArray(item.options) || item.options.length > pagePropertyOptionLimit
      || !item.options.every(isSelectOption)) return false;
    if (new Set(item.options.map(option => (option as SelectOption).id)).size !== item.options.length) return false;
  }
  return isPropertyValue(item);
}

export function isPageProperties(value: unknown): value is PageProperty[] {
  if (!Array.isArray(value) || value.length > pagePropertyLimit || !value.every(isPageProperty)) return false;
  return new Set(value.map(item => item.id)).size === value.length
    && new Set(value.map(item => pagePropertyNameKey(item.name))).size === value.length;
}

/** What a reader sees: the option name for a select, the stored value otherwise. */
export function pagePropertyDisplayValue(property: PageProperty): string | number | null {
  if (property.value === null) return null;
  if (property.type === 'select') return property.options?.find(option => option.id === property.value)?.name ?? null;
  return property.value;
}

/** Name and value of each property, for the page's search text. */
export function pagePropertiesSearchText(properties: readonly PageProperty[]): string {
  return properties.map(property => {
    const shown = pagePropertyDisplayValue(property);
    return shown === null ? property.name : `${property.name} ${shown}`;
  }).join('\n');
}
