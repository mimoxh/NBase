import { localDay, resolveFilters, activeProperties, aggregatesFor, databaseQueryWindow, dateCellLimits, effectiveType, isCalendarProperty, isComputedProperty,
  isGroupableProperty, shiftCalendarDay, type AggregateFunction, type DatabaseAggregateRequest,
  type DatabaseAggregateResponse, type DatabaseQueryRange, type DatabaseRowGroup, type DatabaseQueryRequest, type DatabaseQueryResponse,
  type DatabaseRow, type DayRange, type PropertyDefinition, type QueryContext, type ResolvedCondition, type ViewSort } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { computeValues } from './computed.js';
import { loadRelationCells } from './relations.js';
import { databaseRow, rowTagIdsColumn, type RowRecord } from './schema.js';

/**
 * SQL form of contracts' `evaluateView` and `rowInRange`. Both run the same `resolveFilters` output, and
 * database-query-db.test.ts compares them case by case. Known differences: URL validity is approximated by
 * a pattern, and ordering of text depends on the ICU version of Node and of PostgreSQL.
 *
 * Date cells (see `isDateCellValue`) are checked by the shape of the whole value plus real calendar days and
 * order of the span's two points, and the 31-day limit of recurring spans. Not checked here, so such values
 * count as valid in SQL although JavaScript rejects them: the tz name, the content and canonical form of the
 * RRULE (including the kind of its UNTIL), calendar validity, order and number of exdate points, and the
 * range, order and number of reminders. Timed values before the year 1000 and recurring all-day spans in the
 * year 0000 count as invalid in SQL, which keeps every cast safe. Days of instants come from PostgreSQL's
 * time zone data, which may differ from the ICU data of Node near rule changes.
 */
const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const dayRe = '[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
const instantRe = '[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z';
const ruleRe = '\\|rrule=FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*';
const allDayCellRe = `^${dayRe}(/${dayRe})?(${ruleRe}(\\|exdate=${dayRe}(,${dayRe})*)?)?(\\|remind=-?[0-9]{1,5}(,-?[0-9]{1,5}){0,4})?$`;
const timedCellRe = `^${instantRe}(/${instantRe})?(\\|tz=[A-Za-z0-9_+/-]{1,64})?(${ruleRe}(\\|exdate=${instantRe}(,${instantRe})*)?)?(\\|remind=[0-9]{1,5}(,[0-9]{1,5}){0,4})?$`;
const leapYearRe = '^([0-9]{2}(0[48]|[2468][048]|[13579][26])|(00|0[48]|[2468][048]|[13579][26])00)$';

/** Real calendar day of a point that already matched a day or instant pattern; regexes only, so it never fails. */
const dayOk = (point: string) =>
  `(substr(${point}, 6, 5) !~ '^(02-3|(0[469]|11)-31)' AND (substr(${point}, 6, 5) <> '02-29' OR substr(${point}, 1, 4) ~ '${leapYearRe}'))`;
const rowColumns = `p.id, p.title, p.icon, p.row_properties, p.revision::text AS revision, p.created_at, p.updated_at, ${rowTagIdsColumn}`;
/** Workspace tags of the row page; `select` and `extra` are fixed SQL fragments, never request input. */
const tagSubquery = (select: string, extra = '') =>
  `(SELECT ${select} FROM page_tags pt WHERE pt.workspace_id = p.workspace_id AND pt.page_id = p.id${extra})`;

class Sql {
  readonly values: unknown[] = [];
  /** Ids of formula and rollup properties, read from the cache instead of the row. */
  computed = new Set<string>();
  readsComputed = false;
  /** One lateral subquery per date property, so a cell is parsed once per row however often it is used. */
  readonly dateJoins = new Map<string, { alias: string; sql: string }>();
  private zoneParam: string | null = null;
  constructor(private readonly timeZone: string = 'UTC') {}
  add(value: unknown, cast: string): string {
    this.values.push(value);
    return `$${this.values.length}::${cast}`;
  }
  zone(): string {
    this.zoneParam ??= this.add(this.timeZone, 'text');
    return this.zoneParam;
  }
  joins(): string {
    return [...this.dateJoins.values()].map(join => join.sql).join('\n');
  }
}

function optionIds(def: PropertyDefinition): string[] {
  return (def.options ?? []).map(option => option.id);
}

function jsonValue(sql: Sql, def: PropertyDefinition): string {
  const computed = sql.computed.has(def.id);
  if (computed) sql.readsComputed = true;
  return `(${computed ? 'c.values_json' : 'p.row_properties'} -> ${sql.add(def.id, 'text')})`;
}

/** Computed properties are filtered and sorted like a stored property of their result type. */
function asValue(def: PropertyDefinition): PropertyDefinition {
  return isComputedProperty(def) ? { id: def.id, name: def.name, type: effectiveType(def) } : def;
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

/**
 * The stored value when it is a date cell, or NULL. Nested CASEs keep every cast behind the checks that
 * make it safe, because PostgreSQL does not promise the order in which AND evaluates its operands.
 */
function validDateCell(sql: Sql, def: PropertyDefinition): string {
  const v = jsonValue(sql, def);
  const raw = `(${v} #>> '{}')`;
  const head = `split_part(${raw}, '|', 1)`;
  const s = `split_part(${head}, '/', 1)`;
  const e = `split_part(${head}, '/', 2)`;
  return `(CASE WHEN jsonb_typeof(${v}) = 'string' AND char_length(${raw}) <= ${dateCellLimits.length}
      AND (${raw} ~ '${allDayCellRe}' OR ${raw} ~ '${timedCellRe}') THEN
    CASE WHEN ${dayOk(s)} AND (${e} = '' OR (${dayOk(e)} AND (${e} COLLATE "C") > ${s})) THEN
      CASE WHEN position('|rrule=' in ${raw}) = 0 OR ${e} = '' THEN ${raw}
        WHEN length(${s}) = 10 THEN CASE WHEN ${s} ~ '^0000' OR ${e} ~ '^0000' THEN NULL
          WHEN ${e}::date - ${s}::date <= ${dateCellLimits.recurringSpanDays} THEN ${raw} END
        WHEN extract(epoch FROM ${e}::timestamptz) - extract(epoch FROM ${s}::timestamptz) <= ${dateCellLimits.recurringSpanDays * 86400} THEN ${raw}
      END END END)`;
}

/**
 * Columns of a date property for the current row: `cell` (valid value or NULL), `start_point`, `first_day` and
 * `last_day` of the first occurrence for the reader (a timed end is exclusive), `recurring` and `until_day`,
 * as in contracts' `dateCellDays` and `dateCellUntilDay`.
 */
function dateColumns(sql: Sql, def: PropertyDefinition): string {
  const known = sql.dateJoins.get(def.id);
  if (known) return known.alias;
  const alias = `dc${sql.dateJoins.size}`;
  const tz = sql.zone();
  const until = 'y.u';
  const untilDay = `(substr(${until}, 1, 4) || '-' || substr(${until}, 5, 2) || '-' || substr(${until}, 7, 2))`;
  const untilInstant = `(${untilDay} || 'T' || substr(${until}, 10, 2) || ':' || substr(${until}, 12, 2) || ':' || substr(${until}, 14, 2) || 'Z')`;
  const join = `CROSS JOIN LATERAL (SELECT y.cell, y.s AS start_point,
      CASE WHEN length(y.s) = 10 THEN y.s ELSE to_char(y.s::timestamptz AT TIME ZONE ${tz}, 'YYYY-MM-DD') END AS first_day,
      CASE WHEN length(y.s) = 10 THEN COALESCE(NULLIF(y.e, ''), y.s)
        ELSE to_char(GREATEST(y.s::timestamptz, NULLIF(y.e, '')::timestamptz - interval '1 second') AT TIME ZONE ${tz}, 'YYYY-MM-DD') END AS last_day,
      position('|rrule=' in y.cell) > 0 AS recurring,
      CASE WHEN ${until} IS NULL THEN NULL WHEN length(${until}) = 8 THEN ${untilDay}
        WHEN ${untilInstant} ~ '^${instantRe}$' AND ${dayOk(untilInstant)} THEN to_char(${untilInstant}::timestamptz AT TIME ZONE ${tz}, 'YYYY-MM-DD')
      END AS until_day
    FROM (SELECT x.cell, split_part(split_part(x.cell, '|', 1), '/', 1) AS s, split_part(split_part(x.cell, '|', 1), '/', 2) AS e,
        substring(x.cell FROM 'UNTIL=([0-9]{8}(?:T[0-9]{6}Z)?)') AS u
      FROM (SELECT ${validDateCell(sql, def)} AS cell) x) y) ${alias}`;
  sql.dateJoins.set(def.id, { alias, sql: join });
  return alias;
}

/** First and last day a date-like value covers for the reader, as text; NULL when empty. */
function daysOf(sql: Sql, def: PropertyDefinition): { first: string; last: string } {
  if (def.type === 'date') {
    const alias = dateColumns(sql, def);
    return { first: `(${alias}.first_day COLLATE "C")`, last: `(${alias}.last_day COLLATE "C")` };
  }
  const column = def.type === 'created_time' ? 'p.created_at' : 'p.updated_at';
  const day = `(to_char(${column} AT TIME ZONE ${sql.zone()}, 'YYYY-MM-DD') COLLATE "C")`;
  return { first: day, last: day };
}

/** SQL form of contracts' `rowInRange`. */
function rangeSql(sql: Sql, properties: PropertyDefinition[], range: DatabaseQueryRange): string {
  const def = activeProperties(properties).find(p => p.id === range.propertyId);
  if (!def || !isCalendarProperty(def)) return 'false';
  const from = sql.add(range.from, 'text');
  const to = sql.add(range.to, 'text');
  if (def.type !== 'date') {
    const { first } = daysOf(sql, def);
    return `(${first} >= ${from} AND ${first} <= ${to})`;
  }
  const alias = dateColumns(sql, def);
  const reach = sql.add(shiftCalendarDay(range.from, -dateCellLimits.recurringSpanDays), 'text');
  return `COALESCE((${alias}.first_day COLLATE "C") <= ${to} AND CASE WHEN ${alias}.recurring
    THEN ${alias}.until_day IS NULL OR (${alias}.until_day COLLATE "C") >= ${reach} ELSE (${alias}.last_day COLLATE "C") >= ${from} END, false)`;
}

function emptyOf(sql: Sql, def: PropertyDefinition): string {
  switch (def.type) {
    case 'relation': return `NOT EXISTS ${relationSubquery(sql, def, '1')}`;
    case 'tags': return `NOT EXISTS ${tagSubquery('1')}`;
    case 'title': case 'text': case 'url': return `(${textOf(sql, def)} IS NULL)`;
    case 'number': return `(${numberOf(sql, def)} IS NULL)`;
    case 'date': return `(${dateColumns(sql, def)}.cell IS NULL)`;
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

function conditionSql(sql: Sql, condition: ResolvedCondition): string {
  const { operator: op, target, days } = condition;
  const def = asValue(condition.def);
  if (op === 'is_empty') return emptyOf(sql, def);
  if (op === 'is_not_empty') return `NOT ${emptyOf(sql, def)}`;
  if (op === 'is_checked') return checkedOf(sql, def);
  if (op === 'is_not_checked') return `NOT ${checkedOf(sql, def)}`;
  switch (def.type) {
    case 'relation': {
      const has = `EXISTS ${relationSubquery(sql, def, '1', ` AND position(lower(${sql.add(target, 'text')}) in lower(o.title)) > 0`)}`;
      return op === 'contains' ? has : `NOT ${has}`;
    }
    case 'tags': {
      const has = `EXISTS ${tagSubquery('1', ` AND pt.tag_id::text = lower(${sql.add(target, 'text')})`)}`;
      return op === 'contains' ? has : `NOT ${has}`;
    }
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
      // A span matches when any of its days does, as in contracts' `matches`.
      const { first, last } = daysOf(sql, def);
      const from = () => sql.add(days!.from, 'text');
      const to = () => sql.add(days!.to, 'text');
      const test = op === 'equals' ? `${first} <= ${to()} AND ${last} >= ${from()}` : op === 'gt' ? `${last} > ${to()}`
        : op === 'gte' ? `${last} >= ${from()}` : op === 'lt' ? `${first} < ${from()}` : `${first} <= ${to()}`;
      return `COALESCE(${test}, false)`;
    }
    default: return 'true';
  }
}

function sortSql(sql: Sql, rawDef: PropertyDefinition, direction: 'asc' | 'desc'): string {
  const def = asValue(rawDef);
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
  const nullsLast = (expression: string) => `${expression} ${dir} NULLS LAST`;
  switch (def.type) {
    case 'number': return nullsLast(numberOf(sql, def));
    case 'relation': return nullsLast(`NULLIF(${relationSubquery(sql, def, 'count(*)')}, 0)`);
    case 'tags': return nullsLast(`NULLIF(${tagSubquery('count(*)')}, 0)`);
    case 'checkbox': return `${checkedOf(sql, def)} ${dir}`;
    case 'date': return nullsLast(`(${dateColumns(sql, def)}.start_point COLLATE "C")`);
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

function groupKeySql(sql: Sql, def: PropertyDefinition): string {
  if (def.type === 'checkbox') return `(CASE WHEN ${checkedOf(sql, def)} THEN 'true' ELSE 'false' END)`;
  return `(CASE WHEN ${emptyOf(sql, def)} THEN NULL ELSE ${selectOf(sql, def)} END)`;
}

function compile(sql: Sql, properties: PropertyDefinition[], request: DatabaseQueryRequest, context: QueryContext) {
  const active = new Map(activeProperties(properties).map(p => [p.id, p]));
  sql.computed = new Set(activeProperties(properties).filter(isComputedProperty).map(p => p.id));
  const where = resolveFilters(request.filters, properties, context)
    .map(group => `(${group.map(condition => conditionSql(sql, condition)).join(' OR ')})`);
  if (request.range) where.push(rangeSql(sql, properties, request.range));
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

async function rowsById(client: Pick<PoolClient, 'query'>, workspaceId: string, databaseId: string, ids: string[], properties: PropertyDefinition[], relationPreview?: number): Promise<DatabaseRow[]> {
  if (!ids.length) return [];
  const result = await client.query<RowRecord>(`SELECT ${rowColumns} FROM pages p
    WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.id = ANY($3::uuid[]) AND p.deleted_at IS NULL AND p.kind = 'row'`,
  [workspaceId, databaseId, ids]);
  const cells = await loadRelationCells(client, workspaceId, properties, ids, relationPreview);
  const plain = result.rows.map(databaseRow);
  // Shown values are worked out on the spot, so a cell is never out of date even while the cache catches up.
  const computed = await computeValues(client, workspaceId, properties, plain);
  const byId = new Map(plain.map(row => [row.id, { ...row, ...(cells.has(row.id) ? { relations: cells.get(row.id)! } : {}),
    ...(computed.has(row.id) ? { computed: computed.get(row.id)! } : {}) }]));
  return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
}

function relationSubquery(sql: Sql, def: PropertyDefinition, select: string, extra = ''): string {
  const relation = def.relation!;
  const propertyId = sql.add(relation.owner ? def.id : relation.pairedPropertyId, 'uuid');
  const [self, other] = relation.owner ? ['source_row_id', 'target_row_id'] : ['target_row_id', 'source_row_id'];
  return `(SELECT ${select} FROM database_row_links l JOIN pages o ON o.workspace_id = l.workspace_id AND o.id = l.${other} AND o.deleted_at IS NULL
    WHERE l.workspace_id = p.workspace_id AND l.property_id = ${propertyId} AND l.${self} = p.id${extra})`;
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

async function computedCachePending(client: PoolClient, workspaceId: string, databaseId: string): Promise<boolean> {
  const pending = await client.query(`SELECT 1 FROM databases d WHERE d.workspace_id = $1 AND d.page_id = $2
    AND (d.computed_done_generation < d.computed_generation OR EXISTS (SELECT 1 FROM database_computed_dirty x WHERE x.workspace_id = d.workspace_id AND x.database_id = d.page_id))`,
  [workspaceId, databaseId]);
  return pending.rows.length > 0;
}

export function runDatabaseQuery(pool: Pool, workspaceId: string, actorId: string, databaseId: string,
  request: DatabaseQueryRequest): Promise<DatabaseQueryResponse | null> {
  return queryGate.run(() => readTransaction(pool, async client => {
    const head = await loadHead(client, workspaceId, actorId, databaseId);
    if (!head) return null;
    const timeZone = await resolveZone(client, workspaceId, request.context?.timeZone);
    const context: QueryContext = { timeZone, today: localDay(new Date(), timeZone), weekStart: request.context?.weekStart ?? 1 };
    const sql = new Sql(timeZone);
    const scope = `p.workspace_id = ${sql.add(workspaceId, 'uuid')} AND p.parent_id = ${sql.add(databaseId, 'uuid')}
      AND p.deleted_at IS NULL AND p.kind = 'row'`;
    const { where, order } = compile(sql, head.properties_json, request, context);
    const hasComputed = head.properties_json.some(p => isComputedProperty(p) && !p.deletedAt);
    const computedJoin = hasComputed ? 'LEFT JOIN database_computed c ON c.workspace_id = p.workspace_id AND c.row_id = p.id' : '';
    const groupDef = request.groupBy ? activeProperties(head.properties_json).find(p => p.id === request.groupBy && isGroupableProperty(p)) : undefined;
    const groupColumn = groupDef ? `, ${groupKeySql(sql, groupDef)} AS group_key` : '';
    const ordered = await client.query<{ id: string; group_key?: string | null }>(`SELECT p.id${groupColumn} FROM pages p ${computedJoin} ${sql.joins()}
      WHERE ${scope} ${where} ORDER BY ${order}`, sql.values);
    const computedStale = hasComputed && await computedCachePending(client, workspaceId, databaseId);
    const ids = ordered.rows.map(row => row.id);
    let groups: DatabaseRowGroup[] | undefined;
    if (groupDef) {
      const byKey = new Map<string | null, string[]>();
      for (const row of ordered.rows) {
        const key = row.group_key ?? null;
        const list = byKey.get(key);
        if (list) list.push(row.id); else byKey.set(key, [row.id]);
      }
      groups = [...byKey].map(([key, list]) => ({ key, ids: list }));
    }
    const allRows = where ? (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages
      WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL AND kind = 'row'`, [workspaceId, databaseId])).rows[0]!.n : ids.length;
    return { order: ids, total: ids.length, allRows, rows: await rowsById(client, workspaceId, databaseId, ids.slice(0, databaseQueryWindow), head.properties_json),
      schemaRevision: head.schema_revision, ...(groups ? { groups } : {}), ...(computedStale ? { computedStale } : {}) };
  }));
}

function aggregateSql(sql: Sql, rawDef: PropertyDefinition, fn: AggregateFunction): string {
  const def = asValue(rawDef);
  if (!aggregatesFor(def.type).includes(fn)) return 'NULL';
  if (fn === 'count') return 'count(*)::int';
  if (fn === 'count_values') return `(count(*) FILTER (WHERE NOT ${emptyOf(sql, def)}))::int`;
  if (fn === 'count_empty') return `(count(*) FILTER (WHERE ${emptyOf(sql, def)}))::int`;
  if (def.type === 'number') return `${fn}(${numberOf(sql, def)})`;
  if (def.type === 'date') return `${fn}(${dateColumns(sql, def)}.start_point COLLATE "C")`;
  const column = def.type === 'created_time' ? 'p.created_at' : 'p.updated_at';
  return `to_char(${fn}(${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export function runDatabaseAggregate(pool: Pool, workspaceId: string, actorId: string, databaseId: string,
  request: DatabaseAggregateRequest): Promise<DatabaseAggregateResponse | null> {
  return queryGate.run(() => readTransaction(pool, async client => {
    const head = await loadHead(client, workspaceId, actorId, databaseId);
    if (!head) return null;
    if (!request.items.length) return { values: [] };
    const timeZone = await resolveZone(client, workspaceId, request.context?.timeZone);
    const context: QueryContext = { timeZone, today: localDay(new Date(), timeZone), weekStart: request.context?.weekStart ?? 1 };
    const sql = new Sql(timeZone);
    const scope = `p.workspace_id = ${sql.add(workspaceId, 'uuid')} AND p.parent_id = ${sql.add(databaseId, 'uuid')}
      AND p.deleted_at IS NULL AND p.kind = 'row'`;
    const { where } = compile(sql, head.properties_json, { filters: request.filters, sorts: [] }, context);
    const active = new Map(activeProperties(head.properties_json).map(p => [p.id, p]));
    const columns = request.items.map((item, index) => {
      const def = active.get(item.propertyId);
      return `${def ? aggregateSql(sql, def, item.fn) : 'NULL'} AS a${index}`;
    });
    const computedJoin = sql.readsComputed
      ? 'LEFT JOIN database_computed c ON c.workspace_id = p.workspace_id AND c.row_id = p.id' : '';
    const result = await client.query<Record<string, number | string | null>>(`SELECT ${columns.join(', ')} FROM pages p ${computedJoin} ${sql.joins()}
      WHERE ${scope} ${where}`, sql.values);
    const computedStale = sql.readsComputed && await computedCachePending(client, workspaceId, databaseId);
    return { values: request.items.map((_, index) => result.rows[0]?.[`a${index}`] ?? null), ...(computedStale ? { computedStale } : {}) };
  }));
}

export function readDatabaseRows(pool: Pool, workspaceId: string, actorId: string, databaseId: string, ids: string[], relationPreview?: number): Promise<DatabaseRow[] | null> {
  return readTransaction(pool, async client => {
    const head = await loadHead(client, workspaceId, actorId, databaseId);
    return head ? rowsById(client, workspaceId, databaseId, ids, head.properties_json, relationPreview) : null;
  });
}

export interface CalendarRangeSource { databaseId: string; propertyId: string }
export interface CalendarRangeRow { id: string; title: string; icon: string | null; revision: string; value: string }
export interface CalendarRangeResult { source: CalendarRangeSource; def: PropertyDefinition; rows: CalendarRangeRow[] }

/** A read-only transaction behind the same gate as view queries. */
export function calendarRead<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return queryGate.run(() => readTransaction(pool, work));
}

export { resolveZone };

/**
 * Rows of each source that may show on the days, as `rowInRange` decides, ordered by start and at most
 * `limit` each. Sources whose database is gone or whose property is no longer a date-like one are left out.
 */
export async function readCalendarRanges(client: PoolClient, workspaceId: string, sources: CalendarRangeSource[], days: DayRange,
  timeZone: string, limit: number): Promise<CalendarRangeResult[]> {
  if (!sources.length) return [];
  const heads = await client.query<{ page_id: string; properties_json: PropertyDefinition[] }>(`SELECT d.page_id, d.properties_json FROM databases d
    JOIN pages p ON p.workspace_id = d.workspace_id AND p.id = d.page_id AND p.deleted_at IS NULL AND p.kind = 'database'
    WHERE d.workspace_id = $1 AND d.page_id = ANY($2::uuid[])`, [workspaceId, [...new Set(sources.map(source => source.databaseId))]]);
  const schemas = new Map(heads.rows.map(row => [row.page_id, row.properties_json]));
  const results: CalendarRangeResult[] = [];
  for (const source of sources) {
    const properties = schemas.get(source.databaseId);
    const def = properties && activeProperties(properties).find(p => p.id === source.propertyId && isCalendarProperty(p));
    if (!properties || !def) continue;
    const sql = new Sql(timeZone);
    const scope = `p.workspace_id = ${sql.add(workspaceId, 'uuid')} AND p.parent_id = ${sql.add(source.databaseId, 'uuid')}
      AND p.deleted_at IS NULL AND p.kind = 'row'`;
    const where = rangeSql(sql, properties, { propertyId: def.id, from: days.from, to: days.to });
    const column = def.type === 'created_time' ? 'p.created_at' : 'p.updated_at';
    const value = def.type === 'date' ? `${dateColumns(sql, def)}.cell`
      : `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const order = def.type === 'date' ? `(${dateColumns(sql, def)}.start_point COLLATE "C")` : column;
    const cap = sql.add(limit, 'int');
    const rows = await client.query<CalendarRangeRow>(`SELECT p.id, p.title, p.icon, p.revision::text AS revision, ${value} AS value
      FROM pages p ${sql.joins()} WHERE ${scope} AND ${where} ORDER BY ${order}, p.id LIMIT ${cap}`, sql.values);
    results.push({ source, def, rows: rows.rows });
  }
  return results;
}
