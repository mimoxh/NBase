import { localDay, resolveFilters, activeProperties, databaseQueryWindow, type DatabaseQueryRequest, type DatabaseQueryResponse,
  type DatabaseRow, type PropertyDefinition, type QueryContext, type ResolvedCondition, type ViewSort } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { databaseRow, type RowRecord } from './schema.js';

/**
 * SQL form of contracts' `evaluateView`. Both run the same `resolveFilters` output, and
 * database-query-db.test.ts compares them case by case. Known differences: URL validity is approximated by
 * a pattern, and ordering of text depends on the ICU version of Node and of PostgreSQL.
 */
const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const datePattern = '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
const rowColumns = `p.id, p.title, p.icon, p.row_properties, p.revision::text AS revision, p.created_at, p.updated_at`;

class Sql {
  readonly values: unknown[] = [];
  add(value: unknown, cast: string): string {
    this.values.push(value);
    return `$${this.values.length}::${cast}`;
  }
}

function optionIds(def: PropertyDefinition): string[] {
  return (def.options ?? []).map(option => option.id);
}

function jsonValue(sql: Sql, def: PropertyDefinition): string {
  return `(p.row_properties -> ${sql.add(def.id, 'text')})`;
}

function textOf(sql: Sql, def: PropertyDefinition): string {
  if (def.type === 'title') return `(CASE WHEN p.title ~ '\\S' THEN p.title END)`;
  const v = jsonValue(sql, def);
  const text = `(${v} #>> '{}')`;
  if (def.type === 'url') {
    return `(CASE WHEN jsonb_typeof(${v}) = 'string' AND char_length(${text}) <= 2048 AND ${text} ~* '^(https?:.+|mailto:.*)$' THEN ${text} END)`;
  }
  // An option id left by an earlier select type reads as empty.
  const notOption = def.options?.length ? ` AND NOT (${text} = ANY(${sql.add(optionIds(def), 'text[]')}))` : '';
  return `(CASE WHEN jsonb_typeof(${v}) = 'string' AND ${text} <> ''${notOption} THEN ${text} END)`;
}

function numberOf(sql: Sql, def: PropertyDefinition): string {
  const v = jsonValue(sql, def);
  return `(CASE WHEN jsonb_typeof(${v}) = 'number' THEN (${v} #>> '{}')::double precision END)`;
}

function checkedOf(sql: Sql, def: PropertyDefinition): string {
  return `COALESCE(${jsonValue(sql, def)} = 'true'::jsonb, false)`;
}

function selectOf(sql: Sql, def: PropertyDefinition): string {
  const v = jsonValue(sql, def);
  return `(CASE WHEN jsonb_typeof(${v}) = 'string' AND (${v} #>> '{}') ~* '${uuidPattern}' THEN ${v} #>> '{}' END)`;
}

function dateValueOf(sql: Sql, def: PropertyDefinition): string {
  const v = jsonValue(sql, def);
  const text = `(${v} #>> '{}')`;
  const year = `substr(${text}, 1, 4)::int`;
  const leap = `(${year} % 4 = 0 AND (${year} % 100 <> 0 OR ${year} % 400 = 0))`;
  // Nested so the year is only read from text that matched the pattern.
  return `(CASE WHEN jsonb_typeof(${v}) = 'string' AND ${text} ~ '${datePattern}' THEN
    CASE WHEN ${text} !~ '-(02-3|(0[469]|11)-31)' AND (${text} !~ '-02-29$' OR ${leap}) THEN ${text} END END)`;
}

function dayOf(sql: Sql, def: PropertyDefinition, timeZone: string): string {
  if (def.type === 'date') return dateValueOf(sql, def);
  const column = def.type === 'created_time' ? 'p.created_at' : 'p.updated_at';
  return `to_char(${column} AT TIME ZONE ${sql.add(timeZone, 'text')}, 'YYYY-MM-DD')`;
}

function emptyOf(sql: Sql, def: PropertyDefinition): string {
  switch (def.type) {
    case 'title': case 'text': case 'url': return `(${textOf(sql, def)} IS NULL)`;
    case 'number': return `(${numberOf(sql, def)} IS NULL)`;
    case 'date': return `(${dateValueOf(sql, def)} IS NULL)`;
    case 'select': {
      const value = selectOf(sql, def);
      return `(${value} IS NULL OR NOT (${value} = ANY(${sql.add(optionIds(def), 'text[]')})))`;
    }
    case 'multi_select': {
      const v = jsonValue(sql, def);
      return `NOT COALESCE(jsonb_typeof(${v}) = 'array' AND ${v} ?| ${sql.add(optionIds(def), 'text[]')}, false)`;
    }
    default: return 'false';
  }
}

const comparison: Record<string, string> = { equals: '=', not_equals: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function conditionSql(sql: Sql, condition: ResolvedCondition, timeZone: string): string {
  const { def, operator: op, target, days } = condition;
  if (op === 'is_empty') return emptyOf(sql, def);
  if (op === 'is_not_empty') return `NOT ${emptyOf(sql, def)}`;
  if (op === 'is_checked') return checkedOf(sql, def);
  if (op === 'is_not_checked') return `NOT ${checkedOf(sql, def)}`;
  switch (def.type) {
    case 'title': case 'text': case 'url': {
      const text = `lower(COALESCE(${textOf(sql, def)}, ''))`;
      const needle = `lower(${sql.add(target, 'text')})`;
      if (op === 'contains') return `position(${needle} in ${text}) > 0`;
      if (op === 'not_contains') return `position(${needle} in ${text}) = 0`;
      return `${text} ${comparison[op]} ${needle}`;
    }
    case 'number':
      return `COALESCE(${numberOf(sql, def)} ${comparison[op]} ${sql.add(target, 'double precision')}, ${op === 'not_equals'})`;
    case 'select': {
      const value = selectOf(sql, def);
      return op === 'equals' ? `COALESCE(${value} = ${sql.add(target, 'text')}, false)`
        : `${value} IS DISTINCT FROM ${sql.add(target, 'text')}`;
    }
    case 'multi_select': {
      const v = jsonValue(sql, def);
      const has = `COALESCE(jsonb_typeof(${v}) = 'array' AND ${v} ? ${sql.add(target, 'text')}, false)`;
      return op === 'contains' ? has : `NOT ${has}`;
    }
    case 'date': case 'created_time': case 'updated_time': {
      const day = `(${dayOf(sql, def, timeZone)} COLLATE "C")`;
      const from = () => sql.add(days!.from, 'text');
      const to = () => sql.add(days!.to, 'text');
      const test = op === 'equals' ? `${day} >= ${from()} AND ${day} <= ${to()}` : op === 'gt' ? `${day} > ${to()}`
        : op === 'gte' ? `${day} >= ${from()}` : op === 'lt' ? `${day} < ${from()}` : `${day} <= ${to()}`;
      return `COALESCE(${test}, false)`;
    }
    default: return 'true';
  }
}

function sortSql(sql: Sql, def: PropertyDefinition, direction: 'asc' | 'desc'): string {
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
  const nullsLast = (expression: string) => `${expression} ${dir} NULLS LAST`;
  switch (def.type) {
    case 'number': return nullsLast(numberOf(sql, def));
    case 'checkbox': return `${checkedOf(sql, def)} ${dir}`;
    case 'date': return nullsLast(`(${dateValueOf(sql, def)} COLLATE "C")`);
    case 'created_time': return `date_trunc('milliseconds', p.created_at) ${dir}`;
    case 'updated_time': return `date_trunc('milliseconds', p.updated_at) ${dir}`;
    case 'select': case 'multi_select': {
      const first = def.type === 'select' ? selectOf(sql, def) : `(${jsonValue(sql, def)} ->> 0)`;
      const rank = `COALESCE(array_position(${sql.add(optionIds(def), 'text[]')}, ${first}), 2147483647)`;
      return nullsLast(`(CASE WHEN ${emptyOf(sql, def)} THEN NULL ELSE ${rank} END)`);
    }
    default: return nullsLast(`(${textOf(sql, def)} COLLATE nbase_zh)`);
  }
}

function compile(sql: Sql, properties: PropertyDefinition[], request: DatabaseQueryRequest, context: QueryContext, timeZone: string) {
  const active = new Map(activeProperties(properties).map(p => [p.id, p]));
  const where = resolveFilters(request.filters, properties, context)
    .map(group => `(${group.map(condition => conditionSql(sql, condition, timeZone)).join(' OR ')})`);
  const order = request.sorts.flatMap((sort: ViewSort) => {
    const def = active.get(sort.propertyId);
    return def ? [sortSql(sql, def, sort.direction)] : [];
  });
  return { where: where.length ? `AND ${where.join(' AND ')}` : '', order: [...order, 'p.sort_position ASC', 'p.id ASC'].join(', ') };
}

const checkedZones = new Map<string, boolean>();

async function zoneIsUsable(client: Pick<PoolClient, 'query'>, zone: string): Promise<boolean> {
  const known = checkedZones.get(zone);
  if (known !== undefined) return known;
  let usable = false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    usable = (await client.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [zone])).rows.length > 0;
  } catch { usable = false; }
  if (checkedZones.size < 1000) checkedZones.set(zone, usable);
  return usable;
}

/** The reader's zone when both JavaScript and PostgreSQL understand it, otherwise the workspace's. */
async function resolveZone(client: Pick<PoolClient, 'query'>, workspaceId: string, requested: string | undefined): Promise<string> {
  if (requested && await zoneIsUsable(client, requested)) return requested;
  const row = await client.query<{ zone: string }>('SELECT note_time_zone AS zone FROM workspaces WHERE id = $1', [workspaceId]);
  return row.rows[0]?.zone ?? 'UTC';
}

async function rowsById(client: Pick<PoolClient, 'query'>, workspaceId: string, databaseId: string, ids: string[]): Promise<DatabaseRow[]> {
  if (!ids.length) return [];
  const result = await client.query<RowRecord>(`SELECT ${rowColumns} FROM pages p
    WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.id = ANY($3::uuid[]) AND p.deleted_at IS NULL AND p.kind = 'row'`,
  [workspaceId, databaseId, ids]);
  const byId = new Map(result.rows.map(row => [row.id, databaseRow(row)]));
  return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
}

/** Keeps a few heavy reads from taking every pooled connection that document saves also need. */
class Gate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.running += 1;
    try { return await task(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.running -= 1;
    }
  }
}

const queryGate = new Gate(3);

async function readTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '20s'`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function loadHead(client: PoolClient, workspaceId: string, actorId: string, databaseId: string) {
  const head = await client.query<{ properties_json: PropertyDefinition[]; schema_revision: string }>(`
    SELECT d.properties_json, d.revision::text AS schema_revision FROM databases d
    JOIN pages p ON p.workspace_id = d.workspace_id AND p.id = d.page_id AND p.deleted_at IS NULL
    JOIN workspace_memberships m ON m.workspace_id = d.workspace_id AND m.user_id = $2
    WHERE d.workspace_id = $1 AND d.page_id = $3`, [workspaceId, actorId, databaseId]);
  return head.rows[0] ?? null;
}

export function runDatabaseQuery(pool: Pool, workspaceId: string, actorId: string, databaseId: string,
  request: DatabaseQueryRequest): Promise<DatabaseQueryResponse | null> {
  return queryGate.run(() => readTransaction(pool, async client => {
    const head = await loadHead(client, workspaceId, actorId, databaseId);
    if (!head) return null;
    const timeZone = await resolveZone(client, workspaceId, request.context?.timeZone);
    const context: QueryContext = { timeZone, today: localDay(new Date(), timeZone), weekStart: request.context?.weekStart ?? 1 };
    const sql = new Sql();
    const scope = `p.workspace_id = ${sql.add(workspaceId, 'uuid')} AND p.parent_id = ${sql.add(databaseId, 'uuid')}
      AND p.deleted_at IS NULL AND p.kind = 'row'`;
    const { where, order } = compile(sql, head.properties_json, request, context, timeZone);
    const ordered = await client.query<{ id: string }>(`SELECT p.id FROM pages p WHERE ${scope} ${where} ORDER BY ${order}`, sql.values);
    const ids = ordered.rows.map(row => row.id);
    const allRows = where ? (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages
      WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL AND kind = 'row'`, [workspaceId, databaseId])).rows[0]!.n : ids.length;
    return { order: ids, total: ids.length, allRows, rows: await rowsById(client, workspaceId, databaseId, ids.slice(0, databaseQueryWindow)),
      schemaRevision: head.schema_revision };
  }));
}

export function readDatabaseRows(pool: Pool, workspaceId: string, actorId: string, databaseId: string, ids: string[]): Promise<DatabaseRow[] | null> {
  return readTransaction(pool, async client => {
    const head = await loadHead(client, workspaceId, actorId, databaseId);
    return head ? rowsById(client, workspaceId, databaseId, ids) : null;
  });
}
