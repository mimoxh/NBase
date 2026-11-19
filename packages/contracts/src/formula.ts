import { parseDateCell, zonedDay } from './dateCells.js';
import { activeProperties, cellText, cellValue, effectiveType, isComputedProperty, type DatabaseRow, type PropertyDefinition, type PropertyValue, type RollupFunction } from './databases.js';

/**
 * A small formula language. It is parsed and evaluated here and never reaches eval, so the server,
 * the browser and the demo agree. Formulas read the row they belong to, including its other formulas and
 * rollups; rollups read linked rows. Nothing depends on the current time, so cached results stay correct
 * until an input changes. Dependencies between computed fields must not form a cycle, see
 * `computedDependencyProblem`.
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

/** A computed field of the same row, as already worked out into `row.computed`. */
function computedRead(id: string, type: FormulaType): (row: DatabaseRow) => FormulaValue {
  return row => {
    const value = row.computed?.[id];
    if (type === 'checkbox') return value === true;
    if (type === 'number') return typeof value === 'number' ? value : null;
    return typeof value === 'string' && value !== '' ? value : null;
  };
}

function referenced(def: PropertyDefinition): { type: FormulaType; read: (row: DatabaseRow) => FormulaValue } | null {
  switch (def.type) {
    case 'formula': { const type = def.formula?.resultType ?? 'text'; return { type, read: computedRead(def.id, type) }; }
    case 'rollup': { const type = def.rollup?.resultType ?? 'number'; return { type, read: computedRead(def.id, type) }; }
    case 'number': return { type: 'number', read: row => { const value = cellValue(row, def); return typeof value === 'number' ? value : null; } };
    case 'checkbox': return { type: 'checkbox', read: row => cellValue(row, def) === true };
    // The start day of a date cell; a timed start counts in the zone it was written in, since the cache has no reader.
    case 'date': return { type: 'date', read: row => {
      const cell = parseDateCell(cellValue(row, def));
      if (!cell) return null;
      return cell.allDay ? cell.start : zonedDay(Date.parse(cell.start), cell.timeZone ?? 'UTC');
    } };
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
      if (!source) return fail(`不能引用字段“${def.name}”，公式不能读取关联和标签字段`);
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
  // A linked row's formula is worked out on the spot; the rollups it may read come from that row's cache.
  if (def.type === 'formula') return computeRow(row, schema, new Map(), def.id)[def.id] ?? null;
  if (def.type === 'select' || def.type === 'multi_select' || def.type === 'title' || def.type === 'relation') return cellText(row, def) || null;
  const value: PropertyValue | undefined = cellValue(row, def);
  return value === undefined || Array.isArray(value) ? null : value;
}

/** Field ids an expression refers to with `prop("<id>")`; none when it cannot be read. */
export function formulaReferences(expression: string): string[] {
  let tokens: Token[];
  try { tokens = tokenize(expression); } catch { return []; }
  const ids = new Set<string>();
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    const [name, open, id, close] = [tokens[index]!, tokens[index + 1]!, tokens[index + 2]!, tokens[index + 3]!];
    if (name.kind === 'name' && name.text === 'prop' && open.text === '(' && id.kind === 'string' && close.text === ')') ids.add(id.text);
  }
  return [...ids];
}

interface ComputePlan { order: PropertyDefinition[]; parsed: Map<string, FormulaResult>; needs: Map<string, string[]> }
const plans = new WeakMap<PropertyDefinition[], ComputePlan>();

/**
 * Active computed fields in an order where each comes after the computed fields of its row it reads. Fields
 * caught in a cycle are left out and stay empty; saving a schema rejects cycles, so only old data can have one.
 */
function computePlan(properties: PropertyDefinition[]): ComputePlan {
  const known = plans.get(properties);
  if (known) return known;
  const computed = new Map(activeProperties(properties).filter(isComputedProperty).map(def => [def.id, def]));
  const parsed = new Map<string, FormulaResult>();
  const needs = new Map<string, string[]>();
  for (const def of computed.values()) {
    if (def.type === 'formula') {
      parsed.set(def.id, parseFormula(def.formula!.expression, properties));
      needs.set(def.id, formulaReferences(def.formula!.expression).filter(id => computed.has(id)));
    } else needs.set(def.id, []);
  }
  const order: PropertyDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done' | 'cyclic'>();
  const visit = (id: string): boolean => {
    const seen = state.get(id);
    if (seen === 'done') return true;
    if (seen) { state.set(id, 'cyclic'); return false; }
    state.set(id, 'visiting');
    let ok = true;
    for (const dep of needs.get(id) ?? []) ok = visit(dep) && ok;
    if (!ok) { state.set(id, 'cyclic'); return false; }
    state.set(id, 'done');
    order.push(computed.get(id)!);
    return true;
  };
  for (const id of computed.keys()) visit(id);
  const plan = { order, parsed, needs };
  plans.set(properties, plan);
  return plan;
}

/**
 * Formula and rollup results for one row; absent keys are empty. Computed fields are worked out in dependency
 * order, so a formula sees the current value of another formula or rollup of the row. A rollup without a source
 * in `rollups` keeps the value `row.computed` already has, which is how linked rows read from a cache are used.
 * With `only`, just that field and what it needs are worked out.
 */
export function computeRow(row: DatabaseRow, properties: PropertyDefinition[], rollups: Map<string, RollupSource> = new Map(),
  only?: string): Record<string, string | number | boolean> {
  const plan = computePlan(properties);
  let wanted: Set<string> | null = null;
  if (only !== undefined) {
    wanted = new Set();
    const stack = [only];
    while (stack.length) {
      const id = stack.pop()!;
      if (wanted.has(id)) continue;
      wanted.add(id);
      stack.push(...(plan.needs.get(id) ?? []));
    }
  }
  const result: Record<string, string | number | boolean> = {};
  const current: DatabaseRow = { ...row, computed: result };
  for (const def of plan.order) {
    if (wanted && !wanted.has(def.id)) continue;
    let value: FormulaValue = null;
    if (def.type === 'formula') {
      const parsed = plan.parsed.get(def.id)!;
      if (parsed.ok) value = parsed.node.run(current);
    } else {
      const source = rollups.get(def.id);
      if (source) {
        const values = source.rows.flatMap(item => { const entry = targetValue(item, source.target, source.schema); return entry === null || entry === '' ? [] : [entry]; });
        value = rollupOf(def.rollup!.fn, values, source.rows.length);
      } else value = row.computed?.[def.id] ?? null;
    }
    if (value !== null && value !== '') result[def.id] = value;
  }
  return result;
}

/** How long a chain of computed fields reading each other may be. */
export const formulaDepthLimit = 10;

export interface ComputedDependencyNode { databaseId: string; propertyId: string; name: string }
/** A cycle lists its fields in reading order and repeats the first at the end; a chain that is too long lists it from the top. */
export interface ComputedDependencyProblem { kind: 'cycle' | 'depth'; path: ComputedDependencyNode[] }

/** The 422 body of a schema save or restore rejected by `computedDependencyProblem`. */
export interface ComputedDependencyError {
  error: 'DATABASE_FORMULA_CYCLE' | 'DATABASE_FORMULA_DEPTH';
  path: ComputedDependencyNode[];
  depthLimit: number;
}

/** Computed fields a computed field reads directly: formulas of the same row, or the target of a rollup in the linked database. */
export function computedDependencies(databaseId: string, def: PropertyDefinition, schemas: ReadonlyMap<string, PropertyDefinition[]>): { databaseId: string; propertyId: string }[] {
  const properties = schemas.get(databaseId) ?? [];
  const active = new Map(activeProperties(properties).map(item => [item.id, item]));
  if (def.type === 'formula') {
    return formulaReferences(def.formula?.expression ?? '').filter(id => { const ref = active.get(id); return ref !== undefined && isComputedProperty(ref); })
      .map(propertyId => ({ databaseId, propertyId }));
  }
  if (def.type !== 'rollup' || !def.rollup) return [];
  const relation = active.get(def.rollup.relationPropertyId);
  if (relation?.type !== 'relation' || !relation.relation) return [];
  const other = relation.relation.databaseId;
  const target = activeProperties(schemas.get(other) ?? []).find(item => item.id === def.rollup!.targetPropertyId);
  return target && isComputedProperty(target) ? [{ databaseId: other, propertyId: target.id }] : [];
}

/** Databases whose computed fields the rollups of these properties may read. */
export function rollupSourceDatabases(properties: PropertyDefinition[]): string[] {
  const active = new Map(activeProperties(properties).map(item => [item.id, item]));
  const ids = new Set<string>();
  for (const def of active.values()) {
    if (def.type !== 'rollup' || !def.rollup) continue;
    const relation = active.get(def.rollup.relationPropertyId);
    if (relation?.type === 'relation' && relation.relation) ids.add(relation.relation.databaseId);
  }
  return [...ids];
}

/**
 * Checks the computed fields of one database, following rollups into the databases in `schemas`: a cycle, or a
 * chain longer than `limit`, is a problem. Databases missing from `schemas` end a chain.
 */
export function computedDependencyProblem(databaseId: string, schemas: ReadonlyMap<string, PropertyDefinition[]>,
  limit = formulaDepthLimit): ComputedDependencyProblem | null {
  const key = (node: { databaseId: string; propertyId: string }) => `${node.databaseId}:${node.propertyId}`;
  const defOf = (node: { databaseId: string; propertyId: string }) => (schemas.get(node.databaseId) ?? []).find(item => item.id === node.propertyId);
  const describe = (node: { databaseId: string; propertyId: string }): ComputedDependencyNode => ({ ...node, name: defOf(node)?.name ?? node.propertyId });
  const depth = new Map<string, number>();
  const next = new Map<string, { databaseId: string; propertyId: string } | null>();
  const stack: { databaseId: string; propertyId: string }[] = [];
  const onStack = new Set<string>();
  const found: { cycle: ComputedDependencyNode[] | null } = { cycle: null };
  const visit = (node: { databaseId: string; propertyId: string }): number => {
    const id = key(node);
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (onStack.has(id)) {
      const from = stack.findIndex(item => key(item) === id);
      found.cycle = [...stack.slice(from), node].map(describe);
      return 0;
    }
    const def = defOf(node);
    if (!def) return 0;
    onStack.add(id);
    stack.push(node);
    let best = 0;
    let bestNext: { databaseId: string; propertyId: string } | null = null;
    for (const dep of computedDependencies(node.databaseId, def, schemas)) {
      const value = visit(dep);
      if (found.cycle) break;
      if (value > best) { best = value; bestNext = dep; }
    }
    stack.pop();
    onStack.delete(id);
    depth.set(id, best + 1);
    next.set(id, bestNext);
    return best + 1;
  };
  for (const def of activeProperties(schemas.get(databaseId) ?? []).filter(isComputedProperty)) {
    const start = { databaseId, propertyId: def.id };
    const value = visit(start);
    if (found.cycle) return { kind: 'cycle', path: found.cycle };
    if (value > limit) {
      const path: ComputedDependencyNode[] = [];
      for (let node: { databaseId: string; propertyId: string } | null = start; node; node = next.get(key(node)) ?? null) path.push(describe(node));
      return { kind: 'depth', path };
    }
  }
  return null;
}

export { effectiveType };
