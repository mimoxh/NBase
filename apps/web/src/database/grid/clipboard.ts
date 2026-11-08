import { cellText, isDateValue, isUrlValue, type DatabaseRow, type PropertyDefinition, type PropertyValue } from '@nbase/contracts';

/** Text for the clipboard. Tabs and line breaks inside a cell become spaces, so the block stays a rectangle. */
export function toTsv(grid: string[][]): string {
  return grid.map(row => row.map(cell => cell.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\r\n');
}

/** Parses cells copied from spreadsheets, which quote any cell containing a tab, line break or quote. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (body[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === '\t') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

export function cellClipboardText(row: DatabaseRow, def: PropertyDefinition): string {
  return cellText(row, def);
}

function parseDate(text: string): string | null {
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (!match) return null;
  const value = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  return isDateValue(value) ? value : null;
}

const trueWords = new Set(['✓', '√', 'true', 'yes', 'y', '1', '是', '勾选', '已勾选']);
const falseWords = new Set(['', 'false', 'no', 'n', '0', '否', '未勾选']);

export type ParsedCell = { ok: true; value: PropertyValue | null } | { ok: false };

/** Converts text to a field's value. Empty text clears the cell; anything that does not fit is reported, not guessed. */
export function parseCellText(def: PropertyDefinition, raw: string): ParsedCell {
  const text = raw.trim();
  if (def.type === 'checkbox') {
    const word = text.toLowerCase();
    if (trueWords.has(word)) return { ok: true, value: true };
    return falseWords.has(word) ? { ok: true, value: null } : { ok: false };
  }
  if (!text) return { ok: true, value: null };
  switch (def.type) {
    case 'text': return { ok: true, value: text.slice(0, 2000) };
    case 'number': {
      const number = Number(text.replace(/[,，\s]/g, ''));
      return Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
    }
    case 'date': { const value = parseDate(text); return value ? { ok: true, value } : { ok: false }; }
    case 'url': {
      const value = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
      return isUrlValue(value) ? { ok: true, value } : { ok: false };
    }
    case 'select': {
      const option = def.options?.find(item => item.name === text);
      return option ? { ok: true, value: option.id } : { ok: false };
    }
    case 'multi_select': {
      const names = text.split(/[,，、]/).map(name => name.trim()).filter(Boolean);
      const ids = names.flatMap(name => def.options?.find(item => item.name === name)?.id ?? []);
      if (ids.length !== names.length) return { ok: false };
      return { ok: true, value: [...new Set(ids)] };
    }
    default: return { ok: false };
  }
}
