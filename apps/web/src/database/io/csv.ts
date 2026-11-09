import { cellText, cellValue, type DatabaseRow, type PropertyDefinition } from '@nbase/contracts';
import { formatTimestamp } from '../labels';

const formulaLead = /^[=+\-@\t\r]/;

/** Spreadsheets run cells starting with these as formulas, so exported text gets a leading apostrophe. */
function guard(text: string): string {
  return formulaLead.test(text) ? `'${text}` : text;
}

export function unguard(text: string): string {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

export function csvCell(row: DatabaseRow, def: PropertyDefinition): string {
  if (def.type === 'number') { const value = cellValue(row, def); return value === undefined ? '' : String(value); }
  if (def.type === 'checkbox') return cellValue(row, def) === true ? '✓' : '';
  if (def.type === 'created_time' || def.type === 'updated_time') return formatTimestamp(String(cellValue(row, def) ?? ''));
  if (def.type === 'date') return cellText(row, def);
  return guard(cellText(row, def));
}

/** RFC 4180 text with a UTF-8 BOM, which Excel needs to read Chinese correctly. */
export function rowsToCsv(rows: DatabaseRow[], columns: PropertyDefinition[]): string {
  const lines = [columns.map(def => quote(guard(def.name))).join(',')];
  for (const row of rows) lines.push(columns.map(def => quote(csvCell(row, def))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function detectDelimiter(text: string): string {
  const line = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', '\t', ';'].map(mark => ({ mark, n: line.split(mark).length }));
  return counts.reduce((best, item) => item.n > best.n ? item : best).mark;
}

const yieldEvery = 5000;

/** Parses RFC 4180 text, yielding now and then so a large file does not freeze the page. */
export async function parseCsv(input: string): Promise<string[][]> {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let start = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') { field += char; continue; }
      if (text[index + 1] === '"') { field += '"'; index += 1; } else quoted = false;
      continue;
    }
    if (char === '"' && start) { quoted = true; start = false; continue; }
    start = false;
    if (char === delimiter) { row.push(field); field = ''; start = true; continue; }
    if (char === '\r' && text[index + 1] === '\n') continue;
    if (char === '\n' || char === '\r') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; field = ''; start = true;
      if (rows.length % yieldEvery === 0) await new Promise(resolve => setTimeout(resolve, 0));
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Files saved by Excel in China are often GBK; a strict UTF-8 attempt tells them apart. */
export function decodeCsv(bytes: ArrayBuffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gbk').decode(bytes); }
}
