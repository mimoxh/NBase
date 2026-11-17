import { randomUUID } from 'node:crypto';
import { calendarEventLimit, databaseRowLimit, formatDateCell, parseDateCell, type CalendarConflictChoice, type CalendarConflictKind,
  type CalendarEventSnapshot, type CalendarImportWarning, type CalendarImportWarningCode, type CalendarSyncConflict, type CalendarSyncCounts,
  type CalendarSyncFields, type PropertyDefinition, type PropertyValue, type RowProperties } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { markRowsChanged } from '../../databases/computed.js';
import { loadDatabaseSchema, mergeRowProperties, rowIndexText } from '../../databases/schema.js';
import { PageError } from '../../pages/repository.js';
import { extractDocumentIndex } from '../../pages/search-text.js';
import { parseIcs, type IcsEvent } from '../ics.js';
import { buildIcsResource, patchIcsResource, type ResourcePatch } from '../icsWrite.js';
import type { AggregateScope } from '../settings.js';
import { CalendarRouteError, type SourceRow } from '../sources.js';
import { eventHash, SyncFailure, syncChunkSize, type Snapshot } from '../sync.js';
import type { RemoteCalendar } from '../remote.js';
import { hrefKey, type RemoteEtag, type RemoteResource } from './client.js';

/**
 * Two-way sync of one CalDAV calendar (docs/architecture/calendar.md, 二期). A run reads what changed on the
 * server, applies it to the rows, then writes local changes back. Rows are matched by UID through
 * calendar_sync_items, whose content_hash is the digest of the synced fields when both sides last agreed.
 * Network requests never happen inside a transaction; row writes go in chunks under the workspace lock.
 *
 * An aggregate calendar (迁移 v24) also holds rows of other databases: their items name the database and the date
 * property (a scope). Each item is compared and written with the fields of its own scope.
 */

export interface CaldavTarget {
  sourceId: string;
  workspaceId: string;
  databaseId: string;
  fields: CalendarSyncFields;
  actorId: string;
  calendarUrl: URL;
  /** Whether local changes are written back; a read-only calendar is pulled only. */
  writable: boolean;
  timeZone: string;
  now: () => number;
  /** What the aggregate calendar holds; empty when the source is not one. */
  aggregate: AggregateScope[];
}

export interface CaldavRunResult {
  counts: CalendarSyncCounts;
  warnings: CalendarImportWarning[];
  syncToken: string | null;
  ctag: string | null;
  writable: boolean;
}

const resourceBodyLimit = 1024 * 1024;
const etagLimit = 512;
const hrefLimit = 2000;

interface ItemRow {
  uid: string; row_id: string; synced_revision: string; content_hash: Buffer; href: string | null; attendees: boolean;
  database_id: string | null; property_id: string | null;
  title: string; row_properties: RowProperties | null; revision: string; deleted_at: Date | null; in_database: boolean;
}
interface ConflictRow { uid: string; row_id: string; copy_row_id: string | null; kind: CalendarConflictKind }
interface StoredResource { href: string; etag: string | null; body: string | null }
interface State { items: Map<string, ItemRow>; conflicts: Map<string, ConflictRow>; resources: Map<string, StoredResource> }

/** Where rows of a group of items live and which fields of theirs are synced. `propertyId` is null for the source's own database. */
interface Scope { key: string; databaseId: string; propertyId: string | null; fields: CalendarSyncFields; properties: PropertyDefinition[] }
/** Scopes the items refer to or the aggregate wants; only `active` ones are synced, the others are being retired. */
interface Scopes { main: Scope; all: Map<string, Scope>; active: Set<string> }

const mainKey = '';
const scopeKey = (databaseId: string | null, propertyId: string | null) => databaseId && propertyId ? `${databaseId}:${propertyId}` : mainKey;

/** An ordinary database syncs its title and one date property; ids no property has are skipped when values are written. */
function aggregateFields(propertyId: string): CalendarSyncFields {
  return { titleId: '', dateId: propertyId, locationId: '', descriptionId: '', uidId: '' };
}

function activeScope(scopes: Scopes, item: Pick<ItemRow, 'database_id' | 'property_id'>): Scope | undefined {
  const key = scopeKey(item.database_id, item.property_id);
  return scopes.active.has(key) ? scopes.all.get(key) : undefined;
}

const itemPlace = (scope: Scope) => scope.propertyId === null ? { databaseId: null, propertyId: null }
  : { databaseId: scope.databaseId, propertyId: scope.propertyId };

async function loadScopes(db: Pick<Pool, 'query'>, target: CaldavTarget, state: State): Promise<Scopes> {
  const schema = await loadDatabaseSchema(db, target.workspaceId, target.databaseId);
  if (!schema) throw new SyncFailure('GONE');
  const main: Scope = { key: mainKey, databaseId: target.databaseId, propertyId: null, fields: target.fields, properties: schema.properties_json };
  const all = new Map([[mainKey, main]]);
  const active = new Set([mainKey]);
  const wanted = new Set(target.aggregate.map(s => scopeKey(s.databaseId, s.propertyId)));
  const pairs = new Map(target.aggregate.map(s => [scopeKey(s.databaseId, s.propertyId), s] as const));
  for (const item of state.items.values()) {
    if (item.database_id && item.property_id) pairs.set(scopeKey(item.database_id, item.property_id), { databaseId: item.database_id, propertyId: item.property_id });
  }
  const schemas = new Map<string, PropertyDefinition[] | null>();
  for (const [key, pair] of pairs) {
    if (pair.databaseId === target.databaseId) continue;
    if (!schemas.has(pair.databaseId)) schemas.set(pair.databaseId, (await loadDatabaseSchema(db, target.workspaceId, pair.databaseId))?.properties_json ?? null);
    const properties = schemas.get(pair.databaseId);
    const property = properties?.find(p => p.id === pair.propertyId && !p.deletedAt);
    if (!properties || property?.type !== 'date') continue;
    all.set(key, { key, databaseId: pair.databaseId, propertyId: pair.propertyId, fields: aggregateFields(pair.propertyId), properties });
    if (wanted.has(key)) active.add(key);
  }
  return { main, all, active };
}

interface RemoteSide { event: CalendarEventSnapshot; href: string; etag: string | null; body: string | null }

type PullOp =
  | { kind: 'create'; scope: Scope; uid: string; href: string; event: CalendarEventSnapshot; hash: Buffer; attendees: boolean }
  | { kind: 'update'; scope: Scope; uid: string; href: string; rowId: string; expected: string; event: CalendarEventSnapshot; hash: Buffer; attendees: boolean }
  | { kind: 'records'; uid: string; href: string; attendees: boolean }
  | { kind: 'trash'; scope: Scope; uid: string; href: string; rowId: string; expected: string }
  | { kind: 'clean'; uid: string; href: string }
  | { kind: 'conflict'; scope: Scope; uid: string; href: string; rowId: string; conflict: CalendarConflictKind; remote: RemoteSide | null; trashCopy?: string | null }
  | { kind: 'remote'; scope: Scope; uid: string; href: string; open: ConflictRow; remote: RemoteSide };

function zeroCounts(): CalendarSyncCounts {
  return { created: 0, updated: 0, unchanged: 0, removed: 0, conflicts: 0, skipped: 0, pushed: 0 };
}

class Warnings {
  private readonly totals = new Map<CalendarImportWarningCode, number>();
  add(code: CalendarImportWarningCode, n = 1): void { this.totals.set(code, (this.totals.get(code) ?? 0) + n); }
  merge(list: CalendarImportWarning[]): void { for (const warning of list) this.add(warning.code, warning.count); }
  list(): CalendarImportWarning[] { return [...this.totals].map(([code, count]) => ({ code, count })); }
}

const textOf = (props: RowProperties | null | undefined, id: string): string => {
  const value = props?.[id];
  return typeof value === 'string' ? value : '';
};

function withoutReminders(value: string): string {
  const cell = parseDateCell(value);
  if (!cell?.reminders?.length) return value;
  return formatDateCell({ ...cell, reminders: undefined }) ?? value;
}

/** Reminders stay in NBase: a new external value keeps the ones the row had. */
function keepReminders(value: string, previous: string): string {
  const old = parseDateCell(previous);
  if (!old?.reminders?.length) return value;
  const cell = parseDateCell(value);
  return cell ? formatDateCell({ ...cell, reminders: old.reminders }) ?? value : value;
}

/** The synced fields of a row; the date value without `remind=`. */
export function rowSnapshot(fields: CalendarSyncFields, title: string, props: RowProperties | null | undefined): CalendarEventSnapshot {
  return { title, value: withoutReminders(textOf(props, fields.dateId)), location: textOf(props, fields.locationId),
    description: textOf(props, fields.descriptionId) };
}

/** Row values holding an event; `uid` null leaves the external ID as it is. Null when the values do not fit the schema. */
function eventValues(properties: PropertyDefinition[], fields: CalendarSyncFields, event: CalendarEventSnapshot, current: RowProperties,
  uid: string | null): RowProperties | null {
  const active = new Set(properties.filter(p => !p.deletedAt).map(p => p.id));
  const patch: Record<string, PropertyValue | null> = {};
  const put = (id: string, value: string) => { if (active.has(id)) patch[id] = value || null; };
  put(fields.dateId, keepReminders(event.value, textOf(current, fields.dateId)));
  put(fields.locationId, event.location);
  put(fields.descriptionId, event.description);
  if (uid !== null) put(fields.uidId, uid);
  try { return mergeRowProperties(properties, current, patch); } catch { return null; }
}

/** An external event as the row would hold it, so both sides are compared after the same normalisation. */
function canonical(scope: Scope, event: IcsEvent): { event: CalendarEventSnapshot; hash: Buffer } | null {
  const values = eventValues(scope.properties, scope.fields, event, {}, event.uid);
  if (!values) return null;
  const snapshot = rowSnapshot(scope.fields, event.title, values);
  return { event: snapshot, hash: eventHash(snapshot) };
}

const fits = (text: string | null, limit: number) => text !== null && text.length > 0 && text.length <= limit ? text : null;
const bodyFits = (body: string | null) => body !== null && Buffer.byteLength(body, 'utf8') <= resourceBodyLimit ? body : null;
const success = (status: number) => status >= 200 && status < 300;

async function loadState(pool: Pool, target: CaldavTarget): Promise<State> {
  const [items, conflicts, resources] = await Promise.all([
    pool.query<ItemRow>(`SELECT i.uid, i.row_id, i.synced_revision::text AS synced_revision, i.content_hash, i.href, i.attendees,
        i.database_id, i.property_id, p.title, p.row_properties, p.revision::text AS revision, p.deleted_at,
        (p.parent_id IS NOT DISTINCT FROM COALESCE(i.database_id, $3::uuid) AND p.kind = 'row') AS in_database
      FROM calendar_sync_items i JOIN pages p ON p.workspace_id = i.workspace_id AND p.id = i.row_id
      WHERE i.workspace_id = $1 AND i.source_id = $2`, [target.workspaceId, target.sourceId, target.databaseId]),
    pool.query<ConflictRow>(`SELECT uid, row_id, copy_row_id, kind FROM calendar_sync_conflicts WHERE source_id = $1`, [target.sourceId]),
    pool.query<StoredResource>(`SELECT href, etag, body FROM calendar_sync_resources WHERE source_id = $1`, [target.sourceId]),
  ]);
  return {
    items: new Map(items.rows.map(row => [row.uid, row])),
    conflicts: new Map(conflicts.rows.map(row => [row.uid, row])),
    resources: new Map(resources.rows.map(row => [hrefKey(row.href), row])),
  };
}

/** One transaction under the workspace lock, after checking that the source and its database are still there. */
async function inWorkspace<T>(pool: Pool, target: CaldavTarget, action: (client: PoolClient, properties: PropertyDefinition[]) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE', [target.workspaceId]);
    const source = await client.query('SELECT 1 FROM calendar_sync_sources WHERE id = $1 FOR UPDATE', [target.sourceId]);
    const database = await client.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND kind = 'database'`,
      [target.workspaceId, target.databaseId]);
    const schema = source.rows[0] && database.rows[0] ? await loadDatabaseSchema(client, target.workspaceId, target.databaseId) : null;
    if (!schema) throw new SyncFailure('GONE');
    const result = await action(client, schema.properties_json);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Properties of a database inside a transaction: the source's own as `inWorkspace` read them, others read now. */
function schemaReader(client: PoolClient, target: CaldavTarget, mainProperties: PropertyDefinition[]) {
  const cache = new Map<string, PropertyDefinition[] | null>([[target.databaseId, mainProperties]]);
  return async (databaseId: string): Promise<PropertyDefinition[] | null> => {
    if (!cache.has(databaseId)) cache.set(databaseId, (await loadDatabaseSchema(client, target.workspaceId, databaseId))?.properties_json ?? null);
    return cache.get(databaseId) ?? null;
  };
}

interface ItemWrite { uid: string; rowId: string; revision: string; hash: Buffer; href: string; attendees: boolean;
  databaseId: string | null; propertyId: string | null }

async function saveItems(client: PoolClient, target: CaldavTarget, items: ItemWrite[]): Promise<void> {
  if (!items.length) return;
  await client.query(`INSERT INTO calendar_sync_items (workspace_id, source_id, uid, row_id, synced_revision, content_hash, href, attendees,
      database_id, property_id)
    SELECT $1, $2, v.uid, v.row_id, v.revision, decode(v.hash, 'hex'), v.href, v.attendees, v.database_id, v.property_id
    FROM unnest($3::text[], $4::uuid[], $5::bigint[], $6::text[], $7::text[], $8::boolean[], $9::uuid[], $10::text[])
      AS v(uid, row_id, revision, hash, href, attendees, database_id, property_id)
    ON CONFLICT (source_id, uid) DO UPDATE SET row_id = EXCLUDED.row_id, synced_revision = EXCLUDED.synced_revision,
      content_hash = EXCLUDED.content_hash, href = EXCLUDED.href, attendees = EXCLUDED.attendees, database_id = EXCLUDED.database_id,
      property_id = EXCLUDED.property_id, removed_at = NULL, updated_at = now()`,
  [target.workspaceId, target.sourceId, items.map(i => i.uid), items.map(i => i.rowId), items.map(i => i.revision),
    items.map(i => i.hash.toString('hex')), items.map(i => i.href), items.map(i => i.attendees), items.map(i => i.databaseId),
    items.map(i => i.propertyId)]);
}

async function saveResources(db: Pick<PoolClient, 'query'>, target: CaldavTarget, resources: StoredResource[]): Promise<void> {
  for (let i = 0; i < resources.length; i += syncChunkSize) {
    const chunk = resources.slice(i, i + syncChunkSize);
    await db.query(`INSERT INTO calendar_sync_resources (workspace_id, source_id, href, etag, body)
      SELECT $1, $2, v.href, v.etag, v.body FROM unnest($3::text[], $4::text[], $5::text[]) AS v(href, etag, body)
      ON CONFLICT (source_id, href) DO UPDATE SET etag = EXCLUDED.etag, body = EXCLUDED.body, updated_at = now()`,
    [target.workspaceId, target.sourceId, chunk.map(r => r.href), chunk.map(r => fits(r.etag, etagLimit)), chunk.map(r => bodyFits(r.body))]);
  }
}

async function deleteResources(db: Pick<PoolClient, 'query'>, target: CaldavTarget, hrefs: string[]): Promise<void> {
  for (let i = 0; i < hrefs.length; i += syncChunkSize) {
    await db.query('DELETE FROM calendar_sync_resources WHERE source_id = $1 AND href = ANY($2::text[])', [target.sourceId, hrefs.slice(i, i + syncChunkSize)]);
  }
}

interface ConflictWrite { uid: string; rowId: string; copyId: string | null; kind: CalendarConflictKind; remote: RemoteSide | null }

async function saveConflicts(client: PoolClient, target: CaldavTarget, conflicts: ConflictWrite[]): Promise<void> {
  if (!conflicts.length) return;
  await client.query(`INSERT INTO calendar_sync_conflicts (workspace_id, source_id, uid, row_id, copy_row_id, kind, remote_href, remote_etag,
      remote_body, remote_json)
    SELECT $1, $2, v.uid, v.row_id, v.copy_row_id, v.kind, v.href, v.etag, v.body, v.json::jsonb
    FROM unnest($3::text[], $4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
      AS v(uid, row_id, copy_row_id, kind, href, etag, body, json)
    ON CONFLICT (source_id, uid) DO UPDATE SET row_id = EXCLUDED.row_id, copy_row_id = EXCLUDED.copy_row_id, kind = EXCLUDED.kind,
      remote_href = EXCLUDED.remote_href, remote_etag = EXCLUDED.remote_etag, remote_body = EXCLUDED.remote_body,
      remote_json = EXCLUDED.remote_json,
      detected_at = CASE WHEN calendar_sync_conflicts.kind = EXCLUDED.kind THEN calendar_sync_conflicts.detected_at ELSE now() END`,
  [target.workspaceId, target.sourceId, conflicts.map(c => c.uid), conflicts.map(c => c.rowId), conflicts.map(c => c.copyId),
    conflicts.map(c => c.kind), conflicts.map(c => c.remote ? fits(c.remote.href, hrefLimit) : null),
    conflicts.map(c => c.remote ? fits(c.remote.etag, etagLimit) : null), conflicts.map(c => c.remote ? bodyFits(c.remote.body) : null),
    conflicts.map(c => c.remote ? JSON.stringify(c.remote.event) : null)]);
}

const emptyContent = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0,
  direction: null, children: [] } } };

/** The database rows are read and written in: the source's own, or one of the aggregate calendar. */
interface Place { workspaceId: string; databaseId: string }

interface LockedRow { id: string; title: string; revision: string; row_properties: RowProperties | null;
  content_json: Parameters<typeof extractDocumentIndex>[0]; deleted_at: Date | null }

async function lockRows(client: PoolClient, place: Place, ids: string[]): Promise<Map<string, LockedRow>> {
  if (!ids.length) return new Map();
  const result = await client.query<LockedRow>(`SELECT id, title, revision::text AS revision, row_properties, content_json, deleted_at
    FROM pages WHERE workspace_id = $1 AND parent_id = $2 AND kind = 'row' AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
  [place.workspaceId, place.databaseId, [...new Set(ids)]]);
  return new Map(result.rows.map(row => [row.id, row]));
}

interface RowUpdate { id: string; title: string; values: RowProperties; search: string; restore?: boolean }

async function updateRows(client: PoolClient, place: Place, rows: RowUpdate[]): Promise<Map<string, string>> {
  if (!rows.length) return new Map();
  const updated = await client.query<{ id: string; revision: string }>(`
    UPDATE pages p SET title = v.title, row_properties = v.props::jsonb, search_text = v.search,
      deleted_at = CASE WHEN v.restore THEN NULL ELSE p.deleted_at END,
      deletion_group_id = CASE WHEN v.restore THEN NULL ELSE p.deletion_group_id END,
      revision = p.revision + 1, updated_at = now()
    FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::boolean[]) AS v(id, title, props, search, restore)
    WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.id = v.id RETURNING p.id, p.revision::text AS revision`,
  [place.workspaceId, place.databaseId, rows.map(r => r.id), rows.map(r => r.title), rows.map(r => JSON.stringify(r.values)),
    rows.map(r => r.search), rows.map(r => r.restore ?? false)]);
  return new Map(updated.rows.map(row => [row.id, row.revision]));
}

/** Each row is its own deletion group, as when rows are trashed by hand. */
async function trashRows(client: PoolClient, place: Place, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const trashed = await client.query<{ id: string }>(`UPDATE pages SET deleted_at = now(), deletion_group_id = id, revision = revision + 1,
      updated_at = now()
    WHERE workspace_id = $1 AND parent_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NULL AND kind = 'row' RETURNING id`,
  [place.workspaceId, place.databaseId, ids]);
  return trashed.rows.map(row => row.id);
}

interface RowInsert { id: string; title: string; values: RowProperties }

async function insertRows(client: PoolClient, place: Place, properties: PropertyDefinition[], rows: RowInsert[]): Promise<Map<string, string>> {
  if (!rows.length) return new Map();
  const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages
    WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL`, [place.workspaceId, place.databaseId]);
  if ((count.rows[0]?.n ?? 0) + rows.length > databaseRowLimit) throw new SyncFailure('ROW_LIMIT');
  const inserted = await client.query<{ id: string; revision: string }>(`
    INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, kind, row_properties)
    SELECT v.id, $1, $2, v.title, $3::jsonb, 1, v.search, 'row', v.props::jsonb
    FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[]) WITH ORDINALITY AS v(id, title, search, props, position)
    ORDER BY v.position RETURNING id, revision::text AS revision`,
  [place.workspaceId, place.databaseId, JSON.stringify(emptyContent), rows.map(r => r.id), rows.map(r => r.title),
    rows.map(r => rowIndexText('', properties, r.values)), rows.map(r => JSON.stringify(r.values))]);
  return new Map(inserted.rows.map(row => [row.id, row.revision]));
}

const searchOf = (properties: PropertyDefinition[], row: LockedRow, values: RowProperties) =>
  rowIndexText(extractDocumentIndex(row.content_json).searchText, properties, values);

const opDatabase = (target: CaldavTarget, op: PullOp) => 'scope' in op ? op.scope.databaseId : target.databaseId;

/**
 * Applies one chunk of pull decisions. Rows are re-checked under the lock; a row changed since the plain read
 * is left alone and its resource marked `dirty`, so it is read and judged again on the next run.
 */
async function applyChunk(pool: Pool, target: CaldavTarget, ops: PullOp[], counts: CalendarSyncCounts, snapshot: Snapshot,
  dirty: Set<string>): Promise<void> {
  await inWorkspace(pool, target, async (client, mainProperties) => {
    const local = zeroCounts();
    const schemaOf = schemaReader(client, target, mainProperties);
    const itemWrites: (Omit<ItemWrite, 'revision'> & { revision?: string })[] = [];
    const records: { uid: string; href: string; attendees: boolean }[] = [];
    const dropItems: string[] = [];
    const dropConflicts: string[] = [];
    const conflicts: ConflictWrite[] = [];
    const revisions = new Map<string, string>();
    const skip = (href: string) => { dirty.add(hrefKey(href)); local.skipped++; };
    const groups = new Map<string, PullOp[]>();
    for (const op of ops) {
      const databaseId = opDatabase(target, op);
      groups.set(databaseId, [...(groups.get(databaseId) ?? []), op]);
    }

    for (const [databaseId, group] of groups) {
      const properties = await schemaOf(databaseId);
      if (!properties) { for (const op of group) skip(op.href); continue; }
      const place: Place = { workspaceId: target.workspaceId, databaseId };
      const rowIds = group.flatMap(op => op.kind === 'update' || op.kind === 'trash' || op.kind === 'conflict' ? [op.rowId, ...(op.kind === 'conflict' && op.trashCopy ? [op.trashCopy] : [])]
        : op.kind === 'remote' && op.open.copy_row_id ? [op.open.copy_row_id] : []);
      const rows = await lockRows(client, place, rowIds);
      const updates: RowUpdate[] = [];
      const inserts: RowInsert[] = [];
      const trash: string[] = [];

      for (const op of group) {
        switch (op.kind) {
          case 'create': {
            const values = eventValues(properties, op.scope.fields, op.event, {}, op.uid);
            if (!values) { local.skipped++; break; }
            const id = randomUUID();
            inserts.push({ id, title: op.event.title, values });
            itemWrites.push({ uid: op.uid, rowId: id, hash: op.hash, href: op.href, attendees: op.attendees, ...itemPlace(op.scope) });
            dropConflicts.push(op.uid);
            local.created++;
            break;
          }
          case 'update': {
            const row = rows.get(op.rowId);
            if (!row || row.deleted_at || row.revision !== op.expected) { skip(op.href); break; }
            const values = eventValues(properties, op.scope.fields, op.event, row.row_properties ?? {}, op.scope.propertyId === null ? op.uid : null);
            if (!values) { local.skipped++; break; }
            updates.push({ id: row.id, title: op.event.title, values, search: searchOf(properties, row, values) });
            itemWrites.push({ uid: op.uid, rowId: row.id, hash: op.hash, href: op.href, attendees: op.attendees, ...itemPlace(op.scope) });
            dropConflicts.push(op.uid);
            local.updated++;
            break;
          }
          case 'records':
            records.push({ uid: op.uid, href: op.href, attendees: op.attendees });
            dropConflicts.push(op.uid);
            break;
          case 'trash': {
            const row = rows.get(op.rowId);
            if (!row || row.deleted_at || row.revision !== op.expected) { skip(op.href); break; }
            trash.push(row.id);
            dropItems.push(op.uid);
            dropConflicts.push(op.uid);
            local.removed++;
            break;
          }
          case 'clean':
            dropItems.push(op.uid);
            dropConflicts.push(op.uid);
            break;
          case 'conflict': {
            const row = rows.get(op.rowId);
            const usable = row && (op.conflict === 'local-deleted' ? row.deleted_at !== null : row.deleted_at === null);
            if (!usable) { skip(op.href); break; }
            let copyId: string | null = null;
            if (op.conflict === 'both-changed' && op.remote) {
              const values = eventValues(properties, op.scope.fields, op.remote.event, {}, null);
              if (!values) { local.skipped++; break; }
              copyId = randomUUID();
              inserts.push({ id: copyId, title: op.remote.event.title, values });
            }
            if (op.trashCopy && rows.get(op.trashCopy)?.deleted_at === null) trash.push(op.trashCopy);
            conflicts.push({ uid: op.uid, rowId: op.rowId, copyId, kind: op.conflict, remote: op.remote });
            local.conflicts++;
            break;
          }
          case 'remote': {
            const copy = op.open.copy_row_id ? rows.get(op.open.copy_row_id) : undefined;
            if (copy && copy.deleted_at === null) {
              const values = eventValues(properties, op.scope.fields, op.remote.event, copy.row_properties ?? {}, null);
              if (values) updates.push({ id: copy.id, title: op.remote.event.title, values, search: searchOf(properties, copy, values) });
            }
            conflicts.push({ uid: op.uid, rowId: op.open.row_id, copyId: op.open.copy_row_id, kind: op.open.kind, remote: op.remote });
            break;
          }
        }
      }

      const updated = await updateRows(client, place, updates);
      if (updated.size) await snapshot(client, target.workspaceId, [...updated.keys()], target.actorId, 'update');
      const trashed = await trashRows(client, place, trash);
      if (trashed.length) await snapshot(client, target.workspaceId, trashed, target.actorId, 'trash');
      const inserted = await insertRows(client, place, properties, inserts);
      if (inserted.size) await snapshot(client, target.workspaceId, [...inserted.keys()], target.actorId, 'create');
      for (const [id, revision] of [...updated, ...inserted]) revisions.set(id, revision);
      const changed = [...updated.keys(), ...inserted.keys(), ...trashed];
      if (changed.length) await markRowsChanged(client, target.workspaceId, databaseId, properties, changed);
    }

    if (dropConflicts.length) await client.query('DELETE FROM calendar_sync_conflicts WHERE source_id = $1 AND uid = ANY($2::text[])', [target.sourceId, dropConflicts]);
    if (dropItems.length) await client.query('DELETE FROM calendar_sync_items WHERE source_id = $1 AND uid = ANY($2::text[])', [target.sourceId, dropItems]);
    await saveItems(client, target, itemWrites.flatMap(item => {
      const revision = revisions.get(item.rowId);
      return revision ? [{ ...item, revision }] : [];
    }));
    if (records.length) {
      await client.query(`UPDATE calendar_sync_items i SET href = v.href, attendees = v.attendees, updated_at = now()
        FROM unnest($2::text[], $3::text[], $4::boolean[]) AS v(uid, href, attendees) WHERE i.source_id = $1 AND i.uid = v.uid`,
      [target.sourceId, records.map(r => r.uid), records.map(r => r.href), records.map(r => r.attendees)]);
    }
    await saveConflicts(client, target, conflicts);
    for (const key of Object.keys(local) as (keyof CalendarSyncCounts)[]) counts[key] = (counts[key] ?? 0) + (local[key] ?? 0);
  });
}

/** The scope a new external event goes to: a changed occurrence of an aggregate series joins its series, anything else the source's database. */
function scopeForNew(scopes: Scopes, state: State, uid: string): Scope {
  const mark = uid.indexOf('#');
  const series = mark > 0 ? state.items.get(uid.slice(0, mark)) : undefined;
  return (series && activeScope(scopes, series)) ?? scopes.main;
}

/** Decides what each fetched or vanished resource means for its rows (the table in the design). */
function planPull(target: CaldavTarget, scopes: Scopes, state: State, found: RemoteResource[], removed: string[],
  counts: CalendarSyncCounts, warnings: Warnings): { ops: PullOp[]; invalid: Set<string> } {
  const ops: PullOp[] = [];
  const invalid = new Set<string>();
  const present = new Map<string, { event: IcsEvent; resource: RemoteResource }>();
  for (const resource of found) {
    if (resource.href.length > hrefLimit) { invalid.add(hrefKey(resource.href)); continue; }
    let events: IcsEvent[];
    try {
      const parsed = parseIcs(resource.body, { timeZone: target.timeZone, details: true });
      warnings.merge(parsed.warnings);
      counts.skipped += parsed.skipped;
      events = parsed.events;
    } catch {
      invalid.add(hrefKey(resource.href));
      warnings.add('EVENT_INVALID');
      continue;
    }
    for (const event of events) if (!present.has(event.uid)) present.set(event.uid, { event, resource });
  }

  const touched = new Set<string>();
  for (const [uid, { event, resource }] of present) {
    const href = resource.href;
    const attendees = event.attendees ?? false;
    const item = state.items.get(uid);
    if (!item) {
      const scope = scopeForNew(scopes, state, uid);
      const remote = canonical(scope, event);
      if (!remote) { counts.skipped++; continue; }
      ops.push({ kind: 'create', scope, uid, href, event: remote.event, hash: remote.hash, attendees });
      continue;
    }
    const scope = activeScope(scopes, item);
    // Rows moved out of their database, and aggregate events being retired, keep only their records.
    if (!scope || !item.in_database) { touched.add(uid); ops.push({ kind: 'records', uid, href, attendees }); counts.skipped++; continue; }
    const remote = canonical(scope, event);
    if (!remote) { counts.skipped++; continue; }
    touched.add(uid);
    const side: RemoteSide = { event: remote.event, href, etag: resource.etag, body: resource.body };
    const open = state.conflicts.get(uid);
    if (open && open.kind !== 'remote-deleted') { ops.push({ kind: 'remote', scope, uid, href, open, remote: side }); continue; }
    const trashed = item.deleted_at !== null;
    const localChanged = trashed || !eventHash(rowSnapshot(scope.fields, item.title, item.row_properties)).equals(item.content_hash);
    if (remote.hash.equals(item.content_hash)) {
      ops.push({ kind: 'records', uid, href, attendees });
      if (!localChanged) counts.unchanged++;
      continue;
    }
    if (trashed) {
      // A read-only calendar behaves like a subscription: rows trashed by hand stay in the trash.
      if (target.writable) ops.push({ kind: 'conflict', scope, uid, href, rowId: item.row_id, conflict: 'local-deleted', remote: side });
      else counts.skipped++;
      continue;
    }
    if (localChanged && target.writable) {
      ops.push({ kind: 'conflict', scope, uid, href, rowId: item.row_id, conflict: 'both-changed', remote: side });
      continue;
    }
    ops.push({ kind: 'update', scope, uid, href, rowId: item.row_id, expected: item.revision, event: remote.event, hash: remote.hash, attendees });
  }

  const gone = new Set([...found.map(r => hrefKey(r.href)).filter(key => !invalid.has(key)), ...removed.map(hrefKey)]);
  for (const item of state.items.values()) {
    if (!item.href || !gone.has(hrefKey(item.href)) || present.has(item.uid)) continue;
    touched.add(item.uid);
    const href = item.href;
    const scope = activeScope(scopes, item);
    const open = state.conflicts.get(item.uid);
    if (!scope) { ops.push({ kind: 'clean', uid: item.uid, href }); continue; }
    if (open?.kind === 'remote-deleted') continue;
    if (open?.kind === 'local-deleted') { ops.push({ kind: 'clean', uid: item.uid, href }); continue; }
    if (open?.kind === 'both-changed') {
      ops.push({ kind: 'conflict', scope, uid: item.uid, href, rowId: item.row_id, conflict: 'remote-deleted', remote: null, trashCopy: open.copy_row_id });
      continue;
    }
    if (!item.in_database || item.deleted_at) { ops.push({ kind: 'clean', uid: item.uid, href }); continue; }
    const localChanged = !eventHash(rowSnapshot(scope.fields, item.title, item.row_properties)).equals(item.content_hash);
    if (localChanged && target.writable) ops.push({ kind: 'conflict', scope, uid: item.uid, href, rowId: item.row_id, conflict: 'remote-deleted', remote: null });
    else ops.push({ kind: 'trash', scope, uid: item.uid, href, rowId: item.row_id, expected: item.revision });
  }

  for (const item of state.items.values()) if (!touched.has(item.uid) && item.in_database && !item.deleted_at) counts.unchanged++;
  const leaving = ops.filter(op => op.kind === 'trash' || op.kind === 'clean').length;
  const adding = ops.filter(op => op.kind === 'create').length;
  if (state.items.size - leaving + adding > calendarEventLimit) throw new SyncFailure('ROW_LIMIT');
  // Removals and updates go first so that creations meet the row limit with the room they free.
  ops.sort((a, b) => (a.kind === 'create' ? 1 : 0) - (b.kind === 'create' ? 1 : 0));
  return { ops, invalid };
}

/** Reads `found` and `removed` resources into the rows, then records what was read. */
async function pullResources(pool: Pool, target: CaldavTarget, snapshot: Snapshot, client: RemoteCalendar, changed: string[], removed: string[],
  counts: CalendarSyncCounts, warnings: Warnings): Promise<void> {
  if (!changed.length && !removed.length) return;
  const fetched = changed.length ? await client.fetchResources(target.calendarUrl, changed) : { found: [], missing: [] };
  const gone = [...removed, ...fetched.missing];
  const state = await loadState(pool, target);
  const scopes = await loadScopes(pool, target, state);
  const { ops, invalid } = planPull(target, scopes, state, fetched.found, gone, counts, warnings);
  const dirty = new Set(invalid);
  for (let i = 0; i < ops.length; i += syncChunkSize) await applyChunk(pool, target, ops.slice(i, i + syncChunkSize), counts, snapshot, dirty);
  await saveResources(pool, target, fetched.found.filter(r => r.href.length <= hrefLimit)
    .map(r => ({ href: r.href, etag: dirty.has(hrefKey(r.href)) ? null : r.etag, body: r.body })));
  const known = new Map([...state.resources.values()].map(r => [hrefKey(r.href), r.href]));
  await deleteResources(pool, target, gone.flatMap(href => known.get(hrefKey(href)) ?? []));
}

/** What changed on the server since the last run: incremental with a sync token, else by comparing ETags. */
async function remoteChanges(client: RemoteCalendar, target: CaldavTarget, source: SourceRow, stored: Map<string, StoredResource>,
  state: { syncToken: string | null; ctag: string | null }): Promise<{ changed: string[]; removed: string[]; syncToken: string | null }> {
  const retry = [...stored.values()].filter(r => r.etag === null).map(r => r.href);
  const differs = (remote: RemoteEtag) => {
    const known = stored.get(hrefKey(remote.href));
    return !known || known.etag === null || remote.etag === null || known.etag !== remote.etag;
  };
  const merge = (changed: string[]) => [...new Map([...changed, ...retry].map(href => [hrefKey(href), href])).values()];
  if (source.sync_token && state.syncToken === source.sync_token) return { changed: merge([]), removed: [], syncToken: state.syncToken };
  if (source.sync_token) {
    const delta = await client.syncChanges(target.calendarUrl, source.sync_token);
    if (delta) {
      return { changed: merge(delta.changed.filter(differs).map(c => c.href)),
        removed: delta.removed.filter(href => stored.has(hrefKey(href))), syncToken: delta.syncToken };
    }
  } else if (state.ctag && state.ctag === source.ctag && !state.syncToken) {
    return { changed: merge([]), removed: [], syncToken: null };
  }
  const listed = await client.listEtags(target.calendarUrl);
  if (listed.length > calendarEventLimit) throw new SyncFailure('ROW_LIMIT');
  const keys = new Set(listed.map(item => hrefKey(item.href)));
  return { changed: merge(listed.filter(differs).map(item => item.href)),
    removed: [...stored.values()].filter(r => !keys.has(hrefKey(r.href))).map(r => r.href), syncToken: state.syncToken };
}

type PushStatus = 'done' | 'stale' | 'rejected' | 'idle';

interface PushWork { href: string; edits: ItemRow[]; trashed: ItemRow[] }

/** Changed rows of events that may be written back, by resource. */
function pushWork(scopes: Scopes, state: State): Map<string, PushWork> {
  const blocked = new Set<string>();
  for (const conflict of state.conflicts.values()) {
    blocked.add(conflict.row_id);
    if (conflict.copy_row_id) blocked.add(conflict.copy_row_id);
  }
  const work = new Map<string, PushWork>();
  for (const item of state.items.values()) {
    const scope = activeScope(scopes, item);
    // Events with attendees are never written: a change could send updates to every attendee.
    if (!scope || !item.in_database || item.attendees || !item.href || blocked.has(item.row_id) || state.conflicts.has(item.uid)) continue;
    const trashed = item.deleted_at !== null;
    const local = rowSnapshot(scope.fields, item.title, item.row_properties);
    if (!trashed && eventHash(local).equals(item.content_hash)) continue;
    // An aggregate row whose date was cleared is retired instead.
    if (!trashed && scope.propertyId !== null && !parseDateCell(local.value)) continue;
    const key = hrefKey(item.href);
    const entry = work.get(key) ?? { href: item.href, edits: [], trashed: [] };
    work.set(key, entry);
    (trashed ? entry.trashed : entry.edits).push(item);
  }
  return work;
}

async function pushResource(pool: Pool, target: CaldavTarget, snapshot: Snapshot, client: RemoteCalendar, scopes: Scopes, state: State,
  work: PushWork, counts: CalendarSyncCounts): Promise<PushStatus> {
  const stored = state.resources.get(hrefKey(work.href));
  if (!stored?.body || !stored.etag) return 'idle';
  let events: IcsEvent[];
  try { events = parseIcs(stored.body, { timeZone: target.timeZone, details: true }).events; } catch { return 'idle'; }
  const byUid = new Map(events.map(event => [event.uid, event]));
  const series = events.find(event => event.overrides !== undefined);

  if (series && work.trashed.some(item => item.uid === series.uid)) {
    const result = await client.delete(stored.href, stored.etag);
    if (result.status === 412) return 'stale';
    if (!success(result.status) && result.status !== 404 && result.status !== 410) return 'rejected';
    const members = [...state.items.values()].filter(item => item.href && hrefKey(item.href) === hrefKey(stored.href));
    await inWorkspace(pool, target, async (db, properties) => {
      // Changed occurrences go with their series, as they did on the server.
      const schemaOf = schemaReader(db, target, properties);
      const byDatabase = new Map<string, string[]>();
      for (const item of members.filter(member => member.in_database && !member.deleted_at)) {
        const databaseId = item.database_id ?? target.databaseId;
        byDatabase.set(databaseId, [...(byDatabase.get(databaseId) ?? []), item.row_id]);
      }
      for (const [databaseId, ids] of byDatabase) {
        const trashed = await trashRows(db, { workspaceId: target.workspaceId, databaseId }, ids);
        const schema = await schemaOf(databaseId);
        if (trashed.length) {
          await snapshot(db, target.workspaceId, trashed, target.actorId, 'trash');
          if (schema) await markRowsChanged(db, target.workspaceId, databaseId, schema, trashed);
        }
      }
      await db.query('DELETE FROM calendar_sync_items WHERE source_id = $1 AND uid = ANY($2::text[])', [target.sourceId, members.map(item => item.uid)]);
      await deleteResources(db, target, [stored.href]);
    });
    counts.pushed = (counts.pushed ?? 0) + 1;
    return 'done';
  }

  const blockedSeries = !series || !state.items.has(series.uid) || state.items.get(series.uid)!.attendees || state.conflicts.has(series.uid);
  const editsSeries = series !== undefined && work.edits.some(item => item.uid === series.uid);
  const patch: ResourcePatch = { edits: [], drop: [], exclude: [] };
  const dropped: string[] = [];
  const droppedUids: string[] = [];
  for (const item of work.trashed) {
    const event = byUid.get(item.uid);
    if (event?.component === undefined) continue;
    const point = series && item.uid.startsWith(`${series.uid}#`) ? item.uid.slice(series.uid.length + 1) : null;
    // Without its series rewritten, dropping a changed occurrence would bring the plain occurrence back.
    if (point !== null && blockedSeries && !editsSeries) continue;
    patch.drop.push(event.component);
    droppedUids.push(item.uid);
    if (point !== null) dropped.push(point);
  }
  const written: { uid: string; revision: string; hash: Buffer }[] = [];
  for (const item of work.edits) {
    const event = byUid.get(item.uid);
    const scope = activeScope(scopes, item);
    if (event?.component === undefined || !scope) continue;
    const local = rowSnapshot(scope.fields, item.title, item.row_properties);
    if (!parseDateCell(local.value)) { counts.skipped++; continue; }
    // Ordinary databases have no location or description: the external values stay.
    const text = scope.propertyId === null ? local : { ...local, location: event.location, description: event.description };
    const keep = event.overrides?.filter(point => !dropped.includes(point));
    patch.edits.push({ component: event.component, event: text, ...(keep ? { keep } : {}) });
    written.push({ uid: item.uid, revision: item.revision, hash: eventHash(local) });
  }
  if (dropped.length && series?.component !== undefined && !editsSeries) patch.exclude!.push({ component: series.component, points: dropped });
  if (!patch.edits.length && !patch.drop.length) return 'idle';
  let text: string;
  try { text = patchIcsResource(stored.body, patch, target.now()); } catch { counts.skipped++; return 'idle'; }
  const result = await client.put(stored.href, text, { ifMatch: stored.etag });
  if (result.status === 412 || result.status === 404 || result.status === 410) return 'stale';
  if (!success(result.status)) return 'rejected';
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (written.length) {
      await db.query(`UPDATE calendar_sync_items i SET content_hash = decode(v.hash, 'hex'), synced_revision = v.revision, updated_at = now()
        FROM unnest($2::text[], $3::bigint[], $4::text[]) AS v(uid, revision, hash) WHERE i.source_id = $1 AND i.uid = v.uid`,
      [target.sourceId, written.map(w => w.uid), written.map(w => w.revision), written.map(w => w.hash.toString('hex'))]);
    }
    if (droppedUids.length) await db.query('DELETE FROM calendar_sync_items WHERE source_id = $1 AND uid = ANY($2::text[])', [target.sourceId, droppedUids]);
    // Without an ETag in the answer the resource is read again next time, and found equal.
    await saveResources(db, target, [{ href: stored.href, etag: result.etag, body: text }]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { db.release(); }
  counts.pushed = (counts.pushed ?? 0) + 1;
  return 'done';
}

interface NewRow { id: string; title: string; row_properties: RowProperties | null; revision: string }

/**
 * Live rows that are not events yet: made in NBase, split off a series, or the kept copy of a resolved conflict.
 * In an aggregate scope, rows whose date property has a value.
 */
async function newRows(pool: Pool, target: CaldavTarget, scope: Scope): Promise<NewRow[]> {
  const result = await pool.query<NewRow>(`SELECT p.id, p.title, p.row_properties, p.revision::text AS revision FROM pages p
    WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.kind = 'row' AND p.deleted_at IS NULL
      AND ($4::text IS NULL OR p.row_properties ? $4::text)
      AND NOT EXISTS (SELECT 1 FROM calendar_sync_items i WHERE i.source_id = $3 AND i.row_id = p.id
        AND i.property_id IS NOT DISTINCT FROM $4::text)
      AND NOT EXISTS (SELECT 1 FROM calendar_sync_conflicts c WHERE c.source_id = $3 AND (c.row_id = p.id OR c.copy_row_id = p.id))
    ORDER BY p.sort_position, p.id`, [target.workspaceId, scope.databaseId, target.sourceId, scope.propertyId]);
  return result.rows;
}

async function pushNewRow(pool: Pool, target: CaldavTarget, snapshot: Snapshot, client: RemoteCalendar, scope: Scope, row: NewRow,
  counts: CalendarSyncCounts, warnings: Warnings): Promise<void> {
  const local = rowSnapshot(scope.fields, row.title, row.row_properties);
  if (!parseDateCell(local.value)) return;
  const id = randomUUID();
  const uid = `${id}@nbase`;
  const href = new URL(`${id}.ics`, target.calendarUrl).toString();
  let text: string;
  try { text = buildIcsResource(uid, local, target.now()); } catch { counts.skipped++; return; }
  const result = await client.put(href, text, { ifNoneMatch: '*' });
  if (!success(result.status)) { warnings.add('WRITE_REJECTED'); return; }
  const createdHref = result.href ?? href;
  const createdUid = result.uid ?? uid;
  // A server that named the event itself holds other text than `text`: without an ETag it is read again next run.
  const createdEtag = createdUid === uid ? result.etag : null;
  await inWorkspace(pool, target, async (db, properties) => {
    let revision: string | undefined;
    // Only the source's own database has an external ID field to hold the UID.
    if (scope.propertyId === null) {
      const rows = await lockRows(db, target, [row.id]);
      const current = rows.get(row.id);
      if (current && !current.deleted_at) {
        const values = eventValues(properties, target.fields, rowSnapshot(target.fields, current.title, current.row_properties),
          current.row_properties ?? {}, createdUid);
        if (values) {
          const updated = await updateRows(db, target, [{ id: current.id, title: current.title, values, search: searchOf(properties, current, values) }]);
          revision = updated.get(current.id);
          if (revision) {
            await snapshot(db, target.workspaceId, [current.id], target.actorId, 'update');
            await markRowsChanged(db, target.workspaceId, target.databaseId, properties, [current.id]);
          }
        }
      }
    }
    if (!revision) {
      const found = await db.query<{ revision: string }>('SELECT revision::text AS revision FROM pages WHERE workspace_id = $1 AND id = $2',
        [target.workspaceId, row.id]);
      revision = found.rows[0]?.revision;
    }
    if (!revision) return;
    await saveItems(db, target, [{ uid: createdUid, rowId: row.id, revision, hash: eventHash(local), href: createdHref, attendees: false,
      ...itemPlace(scope) }]);
    await saveResources(db, target, [{ href: createdHref, etag: createdEtag, body: text }]);
  });
  counts.pushed = (counts.pushed ?? 0) + 1;
}

async function repull(pool: Pool, target: CaldavTarget, snapshot: Snapshot, client: RemoteCalendar, href: string,
  counts: CalendarSyncCounts, warnings: Warnings): Promise<void> {
  const resource = await client.get(href);
  const fetched = resource ? [resource] : [];
  const state = await loadState(pool, target);
  const scopes = await loadScopes(pool, target, state);
  const { ops, invalid } = planPull(target, scopes, state, fetched, resource ? [] : [href], counts, warnings);
  const dirty = new Set(invalid);
  for (let i = 0; i < ops.length; i += syncChunkSize) await applyChunk(pool, target, ops.slice(i, i + syncChunkSize), counts, snapshot, dirty);
  if (resource) await saveResources(pool, target, [{ href: resource.href, etag: dirty.has(hrefKey(href)) ? null : resource.etag, body: resource.body }]);
  else await deleteResources(pool, target, [...state.resources.values()].filter(r => hrefKey(r.href) === hrefKey(href)).map(r => r.href));
}

/**
 * Deletes the external events of aggregate items that left the aggregate: their database or property is no longer
 * shown, the row left its database, or its date was cleared. A resource goes only when all its events leave.
 */
async function retire(pool: Pool, target: CaldavTarget, scopes: Scopes, client: RemoteCalendar, counts: CalendarSyncCounts,
  warnings: Warnings): Promise<void> {
  const state = await loadState(pool, target);
  const leaving = new Set<string>();
  for (const item of state.items.values()) {
    if (!item.database_id) continue;
    const scope = activeScope(scopes, item);
    const cleared = scope && item.in_database && !item.deleted_at
      && !parseDateCell(rowSnapshot(scope.fields, item.title, item.row_properties).value);
    if (!scope || !item.in_database || cleared) leaving.add(item.uid);
  }
  if (!leaving.size) return;
  const byHref = new Map<string, ItemRow[]>();
  for (const item of state.items.values()) {
    const key = item.href ? hrefKey(item.href) : `uid:${item.uid}`;
    byHref.set(key, [...(byHref.get(key) ?? []), item]);
  }
  for (const members of byHref.values()) {
    if (!members.every(member => leaving.has(member.uid))) continue;
    const href = members[0]!.href;
    if (href) {
      const result = await client.delete(href, null);
      if (!success(result.status) && result.status !== 404 && result.status !== 410) { warnings.add('WRITE_REJECTED'); continue; }
      counts.pushed = (counts.pushed ?? 0) + 1;
    }
    const uids = members.map(member => member.uid);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('DELETE FROM calendar_sync_conflicts WHERE source_id = $1 AND uid = ANY($2::text[])', [target.sourceId, uids]);
      await db.query('DELETE FROM calendar_sync_items WHERE source_id = $1 AND uid = ANY($2::text[])', [target.sourceId, uids]);
      if (href) await deleteResources(db, target, [...state.resources.values()].filter(r => hrefKey(r.href) === hrefKey(href)).map(r => r.href));
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { db.release(); }
  }
}

/** Writes local changes back. A 412 means the server changed meanwhile: the resource is read and judged again, then retried once. */
async function push(pool: Pool, target: CaldavTarget, snapshot: Snapshot, client: RemoteCalendar, counts: CalendarSyncCounts,
  warnings: Warnings): Promise<void> {
  let state = await loadState(pool, target);
  const scopes = await loadScopes(pool, target, state);
  await retire(pool, target, scopes, client, counts, warnings);
  state = await loadState(pool, target);
  for (const [key, first] of pushWork(scopes, state)) {
    let work: PushWork | undefined = first;
    for (let attempt = 0; work && attempt < 2; attempt++) {
      const status = await pushResource(pool, target, snapshot, client, scopes, state, work, counts);
      if (status === 'rejected') warnings.add('WRITE_REJECTED');
      if (status !== 'stale') break;
      await repull(pool, target, snapshot, client, work.href, counts, warnings);
      state = await loadState(pool, target);
      work = pushWork(scopes, state).get(key);
    }
  }
  let room = calendarEventLimit - (await loadState(pool, target)).items.size;
  for (const scope of [scopes.main, ...[...scopes.active].flatMap(key => key === mainKey ? [] : [scopes.all.get(key)!])]) {
    for (const row of await newRows(pool, target, scope)) {
      if (room <= 0) return;
      const before = counts.pushed ?? 0;
      await pushNewRow(pool, target, snapshot, client, scope, row, counts, warnings);
      if ((counts.pushed ?? 0) > before) room--;
    }
  }
}

/** One full run for a claimed CalDAV source. Network and server failures throw CalDavError; see the scheduler. */
export async function syncCaldav(pool: Pool, snapshot: Snapshot, source: SourceRow, client: RemoteCalendar,
  options: { timeZone: string; now?: () => number; aggregate?: AggregateScope[] }): Promise<CaldavRunResult> {
  const config = source.caldav_json!;
  const calendarUrl = new URL(config.calendarUrl);
  const remote = await client.calendarState(calendarUrl);
  const writable = remote.writable ?? config.writable;
  const target: CaldavTarget = { sourceId: source.id, workspaceId: source.workspace_id, databaseId: source.database_id, fields: source.fields_json,
    actorId: source.created_by, calendarUrl, writable, timeZone: options.timeZone, now: options.now ?? Date.now,
    aggregate: writable ? options.aggregate ?? [] : [] };
  const counts = zeroCounts();
  const warnings = new Warnings();
  const stored = (await loadState(pool, target)).resources;
  const changes = await remoteChanges(client, target, source, stored, remote);
  await pullResources(pool, target, snapshot, client, changes.changed, changes.removed, counts, warnings);
  if (writable) await push(pool, target, snapshot, client, counts, warnings);
  return { counts, warnings: warnings.list(), syncToken: changes.syncToken, ctag: remote.ctag, writable };
}

// ---------------------------------------------------------------------------------------------------------
// Conflicts

interface ConflictDetail { uid: string; row_id: string; copy_row_id: string | null; kind: CalendarConflictKind; remote_json: CalendarEventSnapshot | null;
  detected_at: Date; title: string; row_properties: RowProperties | null; database_id: string | null; property_id: string | null }

const conflictFields = (source: SourceRow, row: Pick<ConflictDetail, 'database_id' | 'property_id'>) =>
  row.database_id && row.property_id ? aggregateFields(row.property_id) : source.fields_json;

export async function listConflicts(db: Pick<Pool, 'query'>, source: SourceRow): Promise<CalendarSyncConflict[]> {
  const result = await db.query<ConflictDetail>(`SELECT c.uid, c.row_id, c.copy_row_id, c.kind, c.remote_json, c.detected_at, p.title,
      p.row_properties, i.database_id, i.property_id
    FROM calendar_sync_conflicts c JOIN pages p ON p.workspace_id = c.workspace_id AND p.id = c.row_id
    LEFT JOIN calendar_sync_items i ON i.source_id = c.source_id AND i.uid = c.uid
    WHERE c.source_id = $1 ORDER BY c.detected_at, c.row_id`, [source.id]);
  return result.rows.map(row => ({
    rowId: row.row_id, copyRowId: row.copy_row_id, kind: row.kind,
    local: row.kind === 'local-deleted' ? null : rowSnapshot(conflictFields(source, row), row.title, row.row_properties),
    remote: row.kind === 'remote-deleted' ? null : row.remote_json,
    detectedAt: row.detected_at.toISOString(),
  }));
}

/**
 * Resolves one conflict inside the caller's transaction, which holds the workspace lock. Whatever must reach
 * the server is written by the next run: the row's hash then differs from the item's, or the row has no item.
 */
export async function resolveConflict(client: PoolClient, snapshot: Snapshot, source: SourceRow, rowId: string,
  choice: CalendarConflictChoice, actorId: string): Promise<void> {
  const found = await client.query<ConflictDetail>(`SELECT c.uid, c.row_id, c.copy_row_id, c.kind, c.remote_json, c.detected_at, p.title,
      p.row_properties, i.database_id, i.property_id
    FROM calendar_sync_conflicts c JOIN pages p ON p.workspace_id = c.workspace_id AND p.id = c.row_id
    LEFT JOIN calendar_sync_items i ON i.source_id = c.source_id AND i.uid = c.uid
    WHERE c.source_id = $1 AND c.row_id = $2 FOR UPDATE OF c`, [source.id, rowId]);
  const conflict = found.rows[0];
  if (!conflict) throw new PageError(404, 'NOT_FOUND');
  if (choice === 'both' && conflict.kind !== 'both-changed') throw new CalendarRouteError(422, 'CONFLICT_CHOICE_INVALID');
  const databaseId = conflict.database_id && conflict.property_id ? conflict.database_id : source.database_id;
  const fields = conflictFields(source, conflict);
  const place: Place = { workspaceId: source.workspace_id, databaseId };
  const schema = await loadDatabaseSchema(client, source.workspace_id, databaseId);
  if (!schema) throw new PageError(404, 'NOT_FOUND');
  const properties = schema.properties_json;
  const rows = await lockRows(client, place, [conflict.row_id, ...(conflict.copy_row_id ? [conflict.copy_row_id] : [])]);
  const changed: string[] = [];
  const trashed: string[] = [];
  const dropItem = () => client.query('DELETE FROM calendar_sync_items WHERE source_id = $1 AND uid = $2', [source.id, conflict.uid]);

  if (choice !== 'both' && conflict.copy_row_id && rows.get(conflict.copy_row_id)?.deleted_at === null) trashed.push(conflict.copy_row_id);
  if (choice === 'local' && conflict.kind === 'remote-deleted') await dropItem();
  if (choice === 'remote') {
    const row = rows.get(conflict.row_id);
    if (conflict.kind === 'remote-deleted') {
      if (row && !row.deleted_at) trashed.push(row.id);
      await dropItem();
    } else if (row && conflict.remote_json) {
      const values = eventValues(properties, fields, conflict.remote_json, row.row_properties ?? {}, null);
      if (!values) throw new PageError(422, 'PROPERTY_INVALID');
      const restore = conflict.kind === 'local-deleted' && row.deleted_at !== null;
      const updated = await updateRows(client, place, [{ id: row.id, title: conflict.remote_json.title, values,
        search: searchOf(properties, row, values), restore }]);
      const revision = updated.get(row.id);
      if (revision) {
        await snapshot(client, source.workspace_id, [row.id], actorId, restore ? 'restore' : 'update');
        changed.push(row.id);
        await client.query(`UPDATE calendar_sync_items SET content_hash = $3, synced_revision = $4, updated_at = now()
          WHERE source_id = $1 AND uid = $2`, [source.id, conflict.uid, eventHash(rowSnapshot(fields, conflict.remote_json.title, values)), revision]);
      }
    }
  }
  const gone = await trashRows(client, place, trashed);
  if (gone.length) await snapshot(client, source.workspace_id, gone, actorId, 'trash');
  await client.query('DELETE FROM calendar_sync_conflicts WHERE source_id = $1 AND uid = $2', [source.id, conflict.uid]);
  if (changed.length || gone.length) await markRowsChanged(client, source.workspace_id, databaseId, properties, [...changed, ...gone]);
}
