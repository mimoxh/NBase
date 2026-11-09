import { activeProperties, databaseBulkLimit, databaseOptionLimit, type PropertyDefinition, type PropertyType, type PropertyValue, type RowProperties, type SelectOption } from '@nbase/contracts';
import { parseCellText } from '../grid/clipboard';
import { nextOptionColor } from '../labels';
import { unguard } from './csv';

/** What a CSV column turns into: an existing field, a new field of some type, or nothing. */
export type ColumnTarget = { kind: 'skip' } | { kind: 'field'; id: string } | { kind: 'new'; type: PropertyType };

export const importableTypes: PropertyType[] = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url'];
const chunkBytes = 1_400_000;
const encoder = new TextEncoder();

export function guessTarget(header: string, properties: PropertyDefinition[]): ColumnTarget {
  const match = activeProperties(properties).find(p => p.name === header.trim() && !['created_time', 'updated_time', 'relation', 'formula', 'rollup'].includes(p.type));
  return match ? { kind: 'field', id: match.id } : { kind: 'new', type: 'text' };
}

export interface ImportPlan {
  /** Schema after new fields and options are added; null when nothing changes. */
  properties: PropertyDefinition[] | null;
  chunks: { title: string; properties: RowProperties }[][];
  rowCount: number;
  invalidCells: number;
}

/** Turns parsed rows into schema changes and fixed chunks, so a retry after a failure resends identical requests. */
export function planImport(rows: string[][], headers: string[], targets: ColumnTarget[], properties: PropertyDefinition[]): ImportPlan {
  let next = properties;
  let changed = false;
  const defs = targets.map((target, column): PropertyDefinition | null => {
    if (target.kind === 'skip') return null;
    if (target.kind === 'field') return next.find(p => p.id === target.id) ?? null;
    const def: PropertyDefinition = { id: crypto.randomUUID(), name: (headers[column] ?? '').trim().slice(0, 100) || `列 ${column + 1}`, type: target.type,
      ...(target.type === 'select' || target.type === 'multi_select' ? { options: [] } : {}) };
    next = [...next, def];
    changed = true;
    return def;
  });
  const addOptions = (def: PropertyDefinition, names: string[]) => {
    const current = next.find(p => p.id === def.id)!;
    const options: SelectOption[] = [...(current.options ?? [])];
    let added = false;
    for (const name of names) {
      if (!name || options.some(option => option.name === name) || options.length >= databaseOptionLimit) continue;
      options.push({ id: crypto.randomUUID(), name: name.slice(0, 100), color: nextOptionColor(options.length) });
      added = true;
    }
    if (added) { changed = true; next = next.map(p => p.id === def.id ? { ...p, options } : p); }
  };
  defs.forEach((def, column) => {
    if (def?.type === 'select') addOptions(def, [...new Set(rows.map(row => (row[column] ?? '').trim()))]);
    if (def?.type === 'multi_select') addOptions(def, [...new Set(rows.flatMap(row => (row[column] ?? '').split(/[,，、]/).map(name => name.trim())))]);
  });
  const finalDefs = defs.map(def => def ? next.find(p => p.id === def.id) ?? null : null);
  let invalidCells = 0;
  const converted = rows.map(row => {
    let title = '';
    const values: RowProperties = {};
    finalDefs.forEach((def, column) => {
      if (!def) return;
      const text = unguard(row[column] ?? '');
      if (def.type === 'title') { title = text.trim().slice(0, 255); return; }
      const parsed = parseCellText(def, text);
      if (!parsed.ok) { if (text.trim()) invalidCells += 1; return; }
      if (parsed.value !== null) values[def.id] = parsed.value as PropertyValue;
    });
    return { title, properties: values };
  });
  const chunks: ImportPlan['chunks'] = [];
  let chunk: ImportPlan['chunks'][number] = [];
  let bytes = 0;
  for (const item of converted) {
    const size = encoder.encode(JSON.stringify(item)).length;
    if (chunk.length && (chunk.length >= databaseBulkLimit || bytes + size > chunkBytes)) { chunks.push(chunk); chunk = []; bytes = 0; }
    chunk.push(item);
    bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  return { properties: changed ? next : null, chunks, rowCount: converted.length, invalidCells };
}
