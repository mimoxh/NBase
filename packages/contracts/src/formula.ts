import { activeProperties, cellText, cellValue, effectiveType, type DatabaseRow, type PropertyDefinition, type PropertyValue, type RollupFunction } from './databases.js';

/**
 * A small formula language. It is parsed and evaluated here and never reaches eval, so the server,
 * the browser and the demo agree. Formulas only read the row they belong to; rollups read linked rows.
 * Nothing depends on the current time, so cached results stay correct until the row changes.
 */
export type FormulaType = 'number' | 'text' | 'checkbox' | 'date';
export type FormulaValue = number | string | boolean | null;
export const formulaLengthLimit = 2000;

type Node = { type: FormulaType; run: (row: DatabaseRow) => FormulaValue };
export type FormulaResult = { ok: true; node: Node; type: FormulaType } | { ok: false; error: string };

interface Token { kind: 'number' | 'string' | 'name' | 'op' | 'end'; text: string; at: number }

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if (/[0-9.]/.test(char)) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      if (!match) throw new Error(`第 ${index + 1} 个字符附近的数字无效`);
      tokens.push({ kind: 'number', text: match[0], at: index });
      index += match[0].length;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let text = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') end += 1;
        text += source[end] ?? '';
        end += 1;
      }
      if (end >= source.length) throw new Error('字符串缺少结尾的引号');
      tokens.push({ kind: 'string', text, at: index });
      index = end + 1;
      continue;
    }
    const name = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(index));
    if (name) { tokens.push({ kind: 'name', text: name[0], at: index }); index += name[0].length; continue; }
    const op = ['==', '!=', '>=', '<=', '&&', '||'].find(item => source.startsWith(item, index)) ?? (/[-+*/%()<>,!]/.test(char) ? char : null);
    if (!op) throw new Error(`无法识别“${char}”`);
    tokens.push({ kind: 'op', text: op, at: index });
    index += op.length;
  }
  tokens.push({ kind: 'end', text: '', at: source.length });
  return tokens;
}

const finite = (value: number): FormulaValue => Number.isFinite(value) ? value : null;
const addDays = (day: string, amount: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10); };

function addMonths(day: string, amount: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + amount, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}

type Spec = { args: (FormulaType | 'any')[]; variadic?: FormulaType | 'any'; min?: number; result: FormulaType | ((types: FormulaType[]) => FormulaType); call: (args: FormulaValue[]) => FormulaValue };

const text = (value: FormulaValue) => value === null ? '' : value === true ? '✓' : value === false ? '' : String(value);
const numbers = (args: FormulaValue[]) => args.filter((value): value is number => typeof value === 'number');
const whenNumber = (value: FormulaValue, fn: (n: number) => FormulaValue) => typeof value === 'number' ? fn(value) : null;
const whenText = (value: FormulaValue, fn: (s: string) => FormulaValue) => typeof value === 'string' ? fn(value) : null;
const part = (value: FormulaValue, fn: (d: Date) => number) => typeof value === 'string' ? fn(new Date(`${value}T00:00:00Z`)) : null;

const functions: Record<string, Spec> = {
  concat: { args: [], variadic: 'any', result: 'text', call: args => args.map(text).join('') },
  text: { args: ['any'], result: 'text', call: ([value]) => text(value ?? null) },
  number: { args: ['text'], result: 'number', call: ([value]) => whenText(value ?? null, s => { const n = Number(s.trim()); return s.trim() && Number.isFinite(n) ? n : null; }) },
  length: { args: ['text'], result: 'number', call: ([value]) => whenText(value ?? null, s => [...s].length) },
  lower: { args: ['text'], result: 'text', call: ([value]) => whenText(value ?? null, s => s.toLocaleLowerCase()) },
  upper: { args: ['text'], result: 'text', call: ([value]) => whenText(value ?? null, s => s.toLocaleUpperCase()) },
  contains: { args: ['text', 'text'], result: 'checkbox', call: ([a, b]) => typeof a === 'string' && typeof b === 'string' && a.includes(b) },
  round: { args: ['number'], variadic: 'number', result: 'number', call: ([value, digits]) => whenNumber(value ?? null, n => { const f = 10 ** (typeof digits === 'number' ? digits : 0); return finite(Math.round(n * f) / f); }) },
  floor: { args: ['number'], result: 'number', call: ([value]) => whenNumber(value ?? null, Math.floor) },
  ceil: { args: ['number'], result: 'number', call: ([value]) => whenNumber(value ?? null, Math.ceil) },
  abs: { args: ['number'], result: 'number', call: ([value]) => whenNumber(value ?? null, Math.abs) },
  min: { args: [], variadic: 'number', min: 1, result: 'number', call: args => { const list = numbers(args); return list.length ? Math.min(...list) : null; } },
  max: { args: [], variadic: 'number', min: 1, result: 'number', call: args => { const list = numbers(args); return list.length ? Math.max(...list) : null; } },
  sum: { args: [], variadic: 'number', min: 1, result: 'number', call: args => finite(numbers(args).reduce((a, b) => a + b, 0)) },
  empty: { args: ['any'], result: 'checkbox', call: ([value]) => value === null || value === '' || value === false },
  year: { args: ['date'], result: 'number', call: ([value]) => part(value ?? null, d => d.getUTCFullYear()) },
  month: { args: ['date'], result: 'number', call: ([value]) => part(value ?? null, d => d.getUTCMonth() + 1) },
  day: { args: ['date'], result: 'number', call: ([value]) => part(value ?? null, d => d.getUTCDate()) },
  dateAdd: { args: ['date', 'number', 'text'], result: 'date', call: ([date, amount, unit]) => {
    if (typeof date !== 'string' || typeof amount !== 'number') return null;
    if (unit === 'days') return addDays(date, amount);
    if (unit === 'months') return addMonths(date, amount);
    if (unit === 'years') return addMonths(date, amount * 12);
    return null;
  } },
  dateDiff: { args: ['date', 'date', 'text'], result: 'number', call: ([a, b, unit]) => {
    if (typeof a !== 'string' || typeof b !== 'string') return null;
    const days = (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
    return unit === 'days' ? days : unit === 'months' ? Math.trunc(days / 30.4375) : unit === 'years' ? Math.trunc(days / 365.25) : null;
  } },
};

export const formulaFunctionNames = Object.keys(functions);

function referenced(def: PropertyDefinition): { type: FormulaType; read: (row: DatabaseRow) => FormulaValue } | null {
  switch (def.type) {
    case 'number': return { type: 'number', read: row => { const value = cellValue(row, def); return typeof value === 'number' ? value : null; } };
    case 'checkbox': return { type: 'checkbox', read: row => cellValue(row, def) === true };
    case 'date': return { type: 'date', read: row => { const value = cellValue(row, def); return typeof value === 'string' ? value : null; } };
    case 'created_time': case 'updated_time': return { type: 'date', read: row => {
      const value = cellValue(row, def);
      const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
    } };
    case 'title': case 'text': case 'url': case 'select': case 'multi_select': return { type: 'text', read: row => cellText(row, def) || null };
    default: return null;
  }
}

/** Parses a stored expression, whose field references are `prop("<field id>")`. */
export function parseFormula(source: string, properties: PropertyDefinition[]): FormulaResult {
  if (!source.trim()) return { ok: false, error: '还没有写公式。' };
  if (source.length > formulaLengthLimit) return { ok: false, error: '公式太长。' };
  const active = new Map(activeProperties(properties).map(def => [def.id, def]));
  let tokens: Token[];
  try { tokens = tokenize(source); } catch (error) { return { ok: false, error: (error as Error).message }; }
  let position = 0;
  const peek = () => tokens[position]!;
  const take = () => tokens[position++]!;
  const fail = (message: string): never => { throw new Error(message); };
  const expect = (op: string) => { if (peek().text !== op || peek().kind !== 'op') fail(`这里应该是“${op}”`); take(); };

  const unify = (a: Node, b: Node, what: string) => { if (a.type !== b.type) fail(`${what}两边的类型不一致`); };
  const binary = (op: string, left: Node, right: Node): Node => {
    const run = (fn: (a: FormulaValue, b: FormulaValue) => FormulaValue) => (row: DatabaseRow) => fn(left.run(row), right.run(row));
    if (op === '&&' || op === '||') {
      if (left.type !== 'checkbox' || right.type !== 'checkbox') fail(`“${op}”两边应该是真假值`);
      return { type: 'checkbox', run: run((a, b) => op === '&&' ? a === true && b === true : a === true || b === true) };
    }
    if (['==', '!=', '>', '>=', '<', '<='].includes(op)) {
      unify(left, right, `“${op}”`);
      return { type: 'checkbox', run: run((a, b) => {
        if (a === null || b === null) return op === '!=' ? a !== b : op === '==' ? a === b : false;
        const [x, y] = typeof a === 'boolean' ? [Number(a), Number(b)] : [a, b as typeof a];
        return op === '==' ? x === y : op === '!=' ? x !== y : op === '>' ? x > y : op === '>=' ? x >= y : op === '<' ? x < y : x <= y;
      }) };
    }
    if (op === '+' && left.type === 'text' && right.type === 'text') return { type: 'text', run: run((a, b) => text(a) + text(b)) };
    if (left.type !== 'number' || right.type !== 'number') fail(`“${op}”两边应该是数字`);
    return { type: 'number', run: run((a, b) => {
      if (typeof a !== 'number' || typeof b !== 'number') return null;
      if ((op === '/' || op === '%') && b === 0) return null;
      return finite(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b);
    }) };
  };

  const levels = [['||'], ['&&'], ['==', '!=', '>', '>=', '<', '<='], ['+', '-'], ['*', '/', '%']];
  const expression = (level = 0): Node => {
    if (level === levels.length) return unary();
    let left = expression(level + 1);
    while (peek().kind === 'op' && levels[level]!.includes(peek().text)) {
      const op = take().text;
      left = binary(op, left, expression(level + 1));
    }
    return left;
  };

  function unary(): Node {
    if (peek().kind === 'op' && peek().text === '-') {
      take();
      const inner = unary();
      if (inner.type !== 'number') fail('“-”后面应该是数字');
      return { type: 'number', run: row => { const value = inner.run(row); return typeof value === 'number' ? -value : null; } };
    }
    if (peek().kind === 'op' && peek().text === '!') {
      take();
      const inner = unary();
      if (inner.type !== 'checkbox') fail('“!”后面应该是真假值');
      return { type: 'checkbox', run: row => inner.run(row) !== true };
    }
    return primary();
  }

  function callArguments(): Node[] {
    expect('(');
    const list: Node[] = [];
    if (peek().text !== ')') {
      list.push(expression());
      while (peek().text === ',') { take(); list.push(expression()); }
    }
    expect(')');
    return list;
  }

  function primary(): Node {
    const token = take();
    if (token.kind === 'number') { const value = Number(token.text); return { type: 'number', run: () => value }; }
    if (token.kind === 'string') return { type: 'text', run: () => token.text };
    if (token.kind === 'op' && token.text === '(') { const inner = expression(); expect(')'); return inner; }
    if (token.kind !== 'name') return fail(token.kind === 'end' ? '公式没有写完' : `这里不应该出现“${token.text}”`);
    if (token.text === 'true' || token.text === 'false') { const value = token.text === 'true'; return { type: 'checkbox', run: () => value }; }
    if (token.text === 'prop') {
      expect('(');
      const id = take();
      if (id.kind !== 'string') fail('prop() 里应该写字段名');
      expect(')');
      const def = active.get(id.text);
      if (!def) return fail(`字段“${id.text}”不存在`);
      const source = referenced(def);
      if (!source) return fail(`不能引用字段“${def.name}”，公式只能读取本行的普通字段`);
      return { type: source.type, run: source.read };
    }
    if (token.text === 'if') {
      const args = callArguments();
      if (args.length !== 3) fail('if() 需要三个参数');
      if (args[0]!.type !== 'checkbox') fail('if() 的第一个参数应该是真假值');
      unify(args[1]!, args[2]!, 'if() 后两个参数');
      return { type: args[1]!.type, run: row => args[0]!.run(row) === true ? args[1]!.run(row) : args[2]!.run(row) };
    }
    const spec = Object.hasOwn(functions, token.text) ? functions[token.text] : undefined;
    if (!spec) return fail(`没有函数“${token.text}”`);
    const args = callArguments();
    const name = token.text;
    if (args.length < (spec.min ?? spec.args.length) || (!spec.variadic && args.length !== spec.args.length)) fail(`${name}() 的参数个数不对`);
    args.forEach((arg, index) => {
      const want = spec.args[index] ?? spec.variadic;
      if (want && want !== 'any' && arg.type !== want) fail(`${name}() 的第 ${index + 1} 个参数类型不对`);
    });
    return { type: typeof spec.result === 'function' ? spec.result(args.map(arg => arg.type)) : spec.result, run: row => spec.call(args.map(arg => arg.run(row))) };
  }

  try {
    const node = expression();
    if (peek().kind !== 'end') return { ok: false, error: `这里不应该出现“${peek().text}”` };
    return { ok: true, node, type: node.type };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}

const quoteName = (name: string) => `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** Field references by id, as stored, shown by name for editing. */
export function formulaToDisplay(expression: string, properties: PropertyDefinition[]): string {
  return expression.replace(/prop\("([^"]*)"\)/g, (whole, id: string) => {
    const def = properties.find(item => item.id === id);
    return def ? `prop(${quoteName(def.name)})` : whole;
  });
}

/** The reverse of `formulaToDisplay`. A name matching no field stays as written, so parsing reports it. */
export function formulaFromDisplay(text: string, properties: PropertyDefinition[]): string {
  return text.replace(/prop\("((?:[^"\\]|\\.)*)"\)/g, (whole, raw: string) => {
    const name = raw.replace(/\\(.)/g, '$1');
    const def = activeProperties(properties).find(item => item.name === name);
    return def ? `prop("${def.id}")` : whole;
  });
}

export interface RollupSource { rows: DatabaseRow[]; schema: PropertyDefinition[]; target: PropertyDefinition }

function rollupOf(fn: RollupFunction, values: (string | number | boolean)[], rowCount: number): FormulaValue {
  if (fn === 'count') return rowCount;
  if (fn === 'count_values') return values.length;
  if (!values.length) return null;
  if (fn === 'min' || fn === 'max') {
    if (typeof values[0] === 'number') return fn === 'min' ? Math.min(...values as number[]) : Math.max(...values as number[]);
    const sorted = values.map(String).sort();
    return fn === 'min' ? sorted[0]! : sorted.at(-1)!;
  }
  const list = values.filter((value): value is number => typeof value === 'number');
  if (!list.length) return null;
  const total = list.reduce((a, b) => a + b, 0);
  return finite(fn === 'sum' ? total : total / list.length);
}

function targetValue(row: DatabaseRow, def: PropertyDefinition, schema: PropertyDefinition[]): string | number | boolean | null {
  if (def.type === 'formula') {
    const parsed = parseFormula(def.formula!.expression, schema);
    return parsed.ok ? parsed.node.run(row) : null;
  }
  if (def.type === 'select' || def.type === 'multi_select' || def.type === 'title' || def.type === 'relation') return cellText(row, def) || null;
  const value: PropertyValue | undefined = cellValue(row, def);
  return value === undefined || Array.isArray(value) ? null : value;
}

/** Formula and rollup results for one row; absent keys are empty. */
export function computeRow(row: DatabaseRow, properties: PropertyDefinition[], rollups: Map<string, RollupSource> = new Map()): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const def of activeProperties(properties)) {
    let value: FormulaValue = null;
    if (def.type === 'formula') {
      const parsed = parseFormula(def.formula!.expression, properties);
      if (parsed.ok) value = parsed.node.run(row);
    } else if (def.type === 'rollup') {
      const source = rollups.get(def.id);
      if (source) {
        const values = source.rows.flatMap(item => { const entry = targetValue(item, source.target, source.schema); return entry === null || entry === '' ? [] : [entry]; });
        value = rollupOf(def.rollup!.fn, values, source.rows.length);
      }
    } else continue;
    if (value !== null && value !== '') result[def.id] = value;
  }
  return result;
}

export { effectiveType };
