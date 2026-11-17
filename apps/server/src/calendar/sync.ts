import { createHash, randomUUID } from 'node:crypto';
import { databaseRowLimit, type CalendarSyncCounts, type CalendarSyncFields, type PropertyDefinition, type PropertyValue,
  type RowProperties } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { markRowsChanged } from '../databases/computed.js';
import { loadDatabaseSchema, mergeRowProperties, rowIndexText } from '../databases/schema.js';
import { extractDocumentIndex } from '../pages/search-text.js';
import type { IcsEvent } from './ics.js';

/** Rows written per transaction; the workspace lock is never held for work that grows with the calendar. */
export const syncChunkSize = 500;

/** A run that cannot finish; `code` is recorded as the source's last error. */
export class SyncFailure extends Error {
  constructor(public readonly code: 'ROW_LIMIT' | 'GONE') { super(code); }
}

export type Snapshot = (client: PoolClient, workspaceId: string, ids: string[], actorId: string,
  operation: 'create' | 'update' | 'trash' | 'restore') => Promise<void>;

export interface SyncTarget {
  sourceId: string;
  workspaceId: string;
  databaseId: string;
  fields: CalendarSyncFields;
  /** 'file': rows changed by hand keep their values. 'url': the feed wins, and events it drops go to the trash. */
  mode: 'file' | 'url';
  actorId: string;
}

interface ItemState {
  uid: string; row_id: string; synced_revision: string; content_hash: Buffer; removed_at: Date | null;
  revision: string; deleted_at: Date | null; deletion_group_id: string | null; in_database: boolean;
}

type Op =
  | { kind: 'create'; event: IcsEvent; hash: Buffer }
  | { kind: 'update'; event: IcsEvent; hash: Buffer; rowId: string; expected: string | null; restore: boolean }
  | { kind: 'remove'; uid: string; rowId: string };

/** Digest of the synced fields: title, date value, location and description. */
export function eventHash(event: Pick<IcsEvent, 'title' | 'value' | 'location' | 'description'>): Buffer {
  return createHash('sha256').update(JSON.stringify([event.title, event.value, event.location, event.description])).digest();
}

const emptyContent = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0,
  direction: null, children: [] } } };

function zeroCounts(): CalendarSyncCounts {
  return { created: 0, updated: 0, unchanged: 0, removed: 0, conflicts: 0, skipped: 0 };
}

/** Values the source keeps for one event; fields removed from the schema meanwhile are left alone. */
function eventPatch(properties: PropertyDefinition[], fields: CalendarSyncFields, event: IcsEvent): Record<string, PropertyValue | null> {
  const active = new Set(properties.filter(p => !p.deletedAt).map(p => p.id));
  const patch: Record<string, PropertyValue | null> = {};
  const put = (id: string, value: string) => { if (active.has(id)) patch[id] = value || null; };
  put(fields.dateId, event.value);
  put(fields.locationId, event.location);
  put(fields.descriptionId, event.description);
  put(fields.uidId, event.uid);
  return patch;
}

function merged(properties: PropertyDefinition[], fields: CalendarSyncFields, current: RowProperties, event: IcsEvent): RowProperties | null {
  try { return mergeRowProperties(properties, current, eventPatch(properties, fields, event)); } catch { return null; }
}

/** Decides what each event needs, from a plain read; every write re-checks its rows under the lock. */
function plan(target: SyncTarget, events: IcsEvent[], items: Map<string, ItemState>, counts: CalendarSyncCounts): Op[] {
  const ops: Op[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.uid)) continue;
    seen.add(event.uid);
    const hash = eventHash(event);
    const item = items.get(event.uid);
    if (!item) { ops.push({ kind: 'create', event, hash }); continue; }
    if (!item.in_database) { counts.skipped++; continue; }
    if (item.deleted_at) {
      // Rows the sync put in the trash come back with their event; rows trashed by hand stay there.
      if (target.mode === 'url' && item.removed_at && item.deletion_group_id === item.row_id) {
        ops.push({ kind: 'update', event, hash, rowId: item.row_id, expected: null, restore: true });
      } else counts.skipped++;
      continue;
    }
    if (item.content_hash.equals(hash) && !item.removed_at) { counts.unchanged++; continue; }
    ops.push({ kind: 'update', event, hash, rowId: item.row_id, expected: target.mode === 'file' ? item.synced_revision : null, restore: false });
  }
  if (target.mode === 'url') {
    for (const item of items.values()) {
      if (!seen.has(item.uid) && !item.removed_at && !item.deleted_at && item.in_database) ops.push({ kind: 'remove', uid: item.uid, rowId: item.row_id });
    }
  }
  return ops;
}

async function loadItems(pool: Pool, target: SyncTarget): Promise<Map<string, ItemState>> {
  const result = await pool.query<ItemState>(`SELECT i.uid, i.row_id, i.synced_revision::text AS synced_revision, i.content_hash,
      i.removed_at, p.revision::text AS revision, p.deleted_at, p.deletion_group_id,
      (p.parent_id IS NOT DISTINCT FROM $3::uuid AND p.kind = 'row') AS in_database
    FROM calendar_sync_items i JOIN pages p ON p.workspace_id = i.workspace_id AND p.id = i.row_id
    WHERE i.workspace_id = $1 AND i.source_id = $2`, [target.workspaceId, target.sourceId, target.databaseId]);
  return new Map(result.rows.map(row => [row.uid, row]));
}

async function saveItems(client: PoolClient, target: SyncTarget, items: { uid: string; rowId: string; revision: string; hash: Buffer }[]): Promise<void> {
  if (!items.length) return;
  await client.query(`INSERT INTO calendar_sync_items (workspace_id, source_id, uid, row_id, synced_revision, content_hash)
    SELECT $1, $2, v.uid, v.row_id, v.revision, decode(v.hash, 'hex')
    FROM unnest($3::text[], $4::uuid[], $5::bigint[], $6::text[]) AS v(uid, row_id, revision, hash)
    ON CONFLICT (source_id, uid) DO UPDATE SET row_id = EXCLUDED.row_id, synced_revision = EXCLUDED.synced_revision,
      content_hash = EXCLUDED.content_hash, removed_at = NULL, updated_at = now()`,
  [target.workspaceId, target.sourceId, items.map(item => item.uid), items.map(item => item.rowId), items.map(item => item.revision),
    items.map(item => item.hash.toString('hex'))]);
}

/** Writes one chunk in its own transaction under the workspace lock. */
async function writeChunk(pool: Pool, target: SyncTarget, ops: Op[], counts: CalendarSyncCounts, snapshot: Snapshot): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE', [target.workspaceId]);
    // The source may have been deleted, or its database trashed, since the run began.
    const source = await client.query('SELECT 1 FROM calendar_sync_sources WHERE id = $1 FOR UPDATE', [target.sourceId]);
    const database = await client.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND kind = 'database'`,
      [target.workspaceId, target.databaseId]);
    const schema = source.rows[0] && database.rows[0] ? await loadDatabaseSchema(client, target.workspaceId, target.databaseId) : null;
    if (!schema) throw new SyncFailure('GONE');
    const properties = schema.properties_json;
    const local = zeroCounts();
    const creates: { event: IcsEvent; hash: Buffer; conflict: boolean }[] = ops.flatMap(op => op.kind === 'create' ? [{ event: op.event, hash: op.hash, conflict: false }] : []);
    const updates = ops.filter((op): op is Extract<Op, { kind: 'update' }> => op.kind === 'update');
    const removes = ops.filter((op): op is Extract<Op, { kind: 'remove' }> => op.kind === 'remove');
    const items: { uid: string; rowId: string; revision: string; hash: Buffer }[] = [];
    const changedRows: string[] = [];

    if (updates.length) {
      const current = await client.query<{ id: string; title: string; revision: string; row_properties: RowProperties | null;
        content_json: Parameters<typeof extractDocumentIndex>[0]; deleted_at: Date | null; deletion_group_id: string | null }>(`
        SELECT id, title, revision::text AS revision, row_properties, content_json, deleted_at, deletion_group_id FROM pages
        WHERE workspace_id = $1 AND parent_id = $2 AND kind = 'row' AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
      [target.workspaceId, target.databaseId, updates.map(op => op.rowId)]);
      const byId = new Map(current.rows.map(row => [row.id, row]));
      const writes: { op: Extract<Op, { kind: 'update' }>; title: string; values: RowProperties; search: string }[] = [];
      for (const op of updates) {
        const row = byId.get(op.rowId);
        const usable = row && (op.restore ? row.deleted_at !== null && row.deletion_group_id === row.id : row.deleted_at === null);
        if (!row || !usable) { local.skipped++; continue; }
        if (op.expected !== null && row.revision !== op.expected) {
          // Changed by hand since the last import: that row keeps its values and the event gets a new row.
          creates.push({ event: op.event, hash: op.hash, conflict: true });
          continue;
        }
        const values = merged(properties, target.fields, row.row_properties ?? {}, op.event);
        if (!values) { local.skipped++; continue; }
        writes.push({ op, title: op.event.title, values,
          search: rowIndexText(extractDocumentIndex(row.content_json).searchText, properties, values) });
      }
      if (writes.length) {
        const updated = await client.query<{ id: string; revision: string }>(`
          UPDATE pages p SET title = v.title, row_properties = v.props::jsonb, search_text = v.search,
            deleted_at = CASE WHEN v.restore THEN NULL ELSE p.deleted_at END,
            deletion_group_id = CASE WHEN v.restore THEN NULL ELSE p.deletion_group_id END,
            revision = p.revision + 1, updated_at = now()
          FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::boolean[]) AS v(id, title, props, search, restore)
          WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.id = v.id
          RETURNING p.id, p.revision::text AS revision`,
        [target.workspaceId, target.databaseId, writes.map(w => w.op.rowId), writes.map(w => w.title), writes.map(w => JSON.stringify(w.values)),
          writes.map(w => w.search), writes.map(w => w.op.restore)]);
        const revisions = new Map(updated.rows.map(row => [row.id, row.revision]));
        const restored = writes.filter(w => w.op.restore).map(w => w.op.rowId);
        const plain = writes.filter(w => !w.op.restore).map(w => w.op.rowId);
        if (plain.length) await snapshot(client, target.workspaceId, plain, target.actorId, 'update');
        if (restored.length) await snapshot(client, target.workspaceId, restored, target.actorId, 'restore');
        for (const w of writes) {
          const revision = revisions.get(w.op.rowId);
          if (!revision) continue;
          items.push({ uid: w.op.event.uid, rowId: w.op.rowId, revision, hash: w.op.hash });
          changedRows.push(w.op.rowId);
          local.updated++;
        }
      }
    }

    if (creates.length) {
      const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages
        WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL`, [target.workspaceId, target.databaseId]);
      if ((count.rows[0]?.n ?? 0) + creates.length > databaseRowLimit) throw new SyncFailure('ROW_LIMIT');
      const rows = creates.flatMap(create => {
        const values = merged(properties, target.fields, {}, create.event);
        if (!values) { local.skipped++; return []; }
        return [{ ...create, id: randomUUID(), values }];
      });
      const inserted = await client.query<{ id: string; revision: string }>(`
        INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, kind, row_properties)
        SELECT v.id, $1, $2, v.title, $3::jsonb, 1, v.search, 'row', v.props::jsonb
        FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[]) WITH ORDINALITY AS v(id, title, search, props, position)
        ORDER BY v.position RETURNING id, revision::text AS revision`,
      [target.workspaceId, target.databaseId, JSON.stringify(emptyContent), rows.map(row => row.id), rows.map(row => row.event.title),
        rows.map(row => rowIndexText('', properties, row.values)), rows.map(row => JSON.stringify(row.values))]);
      const revisions = new Map(inserted.rows.map(row => [row.id, row.revision]));
      await snapshot(client, target.workspaceId, inserted.rows.map(row => row.id), target.actorId, 'create');
      for (const row of rows) {
        items.push({ uid: row.event.uid, rowId: row.id, revision: revisions.get(row.id)!, hash: row.hash });
        changedRows.push(row.id);
        if (row.conflict) local.conflicts++; else local.created++;
      }
    }

    if (removes.length) {
      // Same as trashing rows by hand: each row is its own deletion group and can be restored.
      const trashed = await client.query<{ id: string; revision: string }>(`
        UPDATE pages SET deleted_at = now(), deletion_group_id = id, revision = revision + 1, updated_at = now()
        WHERE workspace_id = $1 AND parent_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NULL AND kind = 'row'
        RETURNING id, revision::text AS revision`, [target.workspaceId, target.databaseId, removes.map(op => op.rowId)]);
      await snapshot(client, target.workspaceId, trashed.rows.map(row => row.id), target.actorId, 'trash');
      const revisions = new Map(trashed.rows.map(row => [row.id, row.revision]));
      const gone = removes.filter(op => revisions.has(op.rowId));
      await client.query(`UPDATE calendar_sync_items i SET removed_at = now(), synced_revision = v.revision, updated_at = now()
        FROM unnest($2::text[], $3::bigint[]) AS v(uid, revision) WHERE i.source_id = $1 AND i.uid = v.uid`,
      [target.sourceId, gone.map(op => op.uid), gone.map(op => revisions.get(op.rowId)!)]);
      changedRows.push(...gone.map(op => op.rowId));
      local.removed += gone.length;
      local.skipped += removes.length - gone.length;
    }

    await saveItems(client, target, items);
    if (changedRows.length) await markRowsChanged(client, target.workspaceId, target.databaseId, properties, changedRows);
    await client.query('COMMIT');
    for (const key of Object.keys(local) as (keyof CalendarSyncCounts)[]) counts[key] = (counts[key] ?? 0) + (local[key] ?? 0);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/**
 * Brings a sync database in line with a list of events. Events are matched by UID through
 * calendar_sync_items; an event whose content digest is unchanged is not written at all. Rows are never
 * deleted: a subscription moves rows of vanished events to the trash, where they can be restored.
 */
export async function applyEvents(pool: Pool, target: SyncTarget, events: IcsEvent[], snapshot: Snapshot, skipped = 0): Promise<CalendarSyncCounts> {
  const counts = zeroCounts();
  counts.skipped = skipped;
  const ops = plan(target, events, await loadItems(pool, target), counts);
  // Removals and updates go first so that creations meet the row limit with the room they free.
  ops.sort((a, b) => (a.kind === 'create' ? 1 : 0) - (b.kind === 'create' ? 1 : 0));
  for (let i = 0; i < ops.length; i += syncChunkSize) await writeChunk(pool, target, ops.slice(i, i + syncChunkSize), counts, snapshot);
  return counts;
}
