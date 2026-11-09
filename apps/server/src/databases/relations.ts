import { randomUUID } from 'node:crypto';
import { activeProperties, databaseRelationLimit, databaseRelationPreview, type ChangeRelationRequest, type ChangeRelationResponse, type CreateRelationRequest,
  type DatabaseRow, type DatabaseSchemaResponse, type PropertyDefinition, type RelationCell, type RowProperties } from '@nbase/contracts';
import type { PoolClient } from 'pg';
import { PageError } from '../pages/repository.js';
import { databaseRow, loadDatabaseSchema, syncRelationLinks, type RowRecord } from './schema.js';

type Snapshot = (client: PoolClient, workspaceId: string, ids: string[], actorId: string, operation: 'update') => Promise<void>;

async function activeDatabase(client: PoolClient, workspaceId: string, databaseId: string) {
  const page = await client.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND kind = 'database'`, [workspaceId, databaseId]);
  return page.rows[0] ? loadDatabaseSchema(client, workspaceId, databaseId, true) : null;
}

/** Adds the paired fields to both databases in one transaction. Rows are locked in id order, so two pairings cannot deadlock. */
export async function createRelation(client: PoolClient, workspaceId: string, databaseId: string, body: CreateRelationRequest): Promise<DatabaseSchemaResponse> {
  const target = body.targetDatabaseId.toLowerCase();
  const [first, second] = [databaseId, target].sort() as [string, string];
  const firstSchema = await activeDatabase(client, workspaceId, first);
  const secondSchema = first === second ? firstSchema : await activeDatabase(client, workspaceId, second);
  const source = databaseId === first ? firstSchema : secondSchema;
  const other = databaseId === first ? secondSchema : firstSchema;
  if (!source || !other) throw new PageError(404, 'NOT_FOUND');
  const ownerId = randomUUID();
  const pairedId = randomUUID();
  const owner: PropertyDefinition = { id: ownerId, name: body.name, type: 'relation', relation: { databaseId: target, pairedPropertyId: pairedId, owner: true } };
  const paired: PropertyDefinition = { id: pairedId, name: body.pairedName, type: 'relation', relation: { databaseId, pairedPropertyId: ownerId, owner: false } };
  const write = async (id: string, properties: PropertyDefinition[]) => (await client.query<{ revision: string }>(`UPDATE databases SET properties_json = $3::jsonb,
    revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND page_id = $2 RETURNING revision::text AS revision`,
  [workspaceId, id, JSON.stringify(properties)])).rows[0]!.revision;
  if (target === databaseId) {
    const properties = [...source.properties_json, owner, paired];
    return { pageId: databaseId, properties, views: source.views_json as DatabaseSchemaResponse['views'], schemaRevision: await write(databaseId, properties) };
  }
  await write(target, [...other.properties_json, paired]);
  const properties = [...source.properties_json, owner];
  return { pageId: databaseId, properties, views: source.views_json as DatabaseSchemaResponse['views'], schemaRevision: await write(databaseId, properties) };
}

/** A relation field's soft delete or restore applies to its pair, which may live in another database. */
export async function mirrorRelationDeletion(client: PoolClient, workspaceId: string, before: PropertyDefinition[], after: PropertyDefinition[]): Promise<PropertyDefinition[]> {
  let result = after;
  for (const def of after) {
    if (def.type !== 'relation' || !def.relation) continue;
    const previous = before.find(item => item.id === def.id);
    if (!previous || (previous.deletedAt ?? null) === (def.deletedAt ?? null)) continue;
    const { pairedPropertyId } = def.relation;
    const apply = (item: PropertyDefinition): PropertyDefinition => {
      if (item.id !== pairedPropertyId) return item;
      const { deletedAt: _deleted, ...rest } = item;
      void _deleted;
      return def.deletedAt ? { ...rest, deletedAt: def.deletedAt } : rest;
    };
    if (result.some(item => item.id === pairedPropertyId)) { result = result.map(apply); continue; }
    const other = await loadDatabaseSchema(client, workspaceId, def.relation.databaseId, true);
    if (other) {
      await client.query(`UPDATE databases SET properties_json = $3::jsonb, revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND page_id = $2`,
        [workspaceId, def.relation.databaseId, JSON.stringify(other.properties_json.map(apply))]);
    }
  }
  return result;
}

/** Relation fields keep their identity: the pairing and the type cannot be edited through a schema save. */
export function relationsUnchanged(before: PropertyDefinition[], after: PropertyDefinition[]): boolean {
  const added = after.filter(def => def.type === 'relation' && !before.some(item => item.id === def.id));
  if (added.length) return false;
  return before.every(def => {
    const next = after.find(item => item.id === def.id);
    if (!next) return true;
    if ((def.type === 'relation') !== (next.type === 'relation')) return false;
    return JSON.stringify(def.relation ?? null) === JSON.stringify(next.relation ?? null);
  });
}

/** Linked rows for a window of rows, active ones only, with a short preview and the full count. */
export async function loadRelationCells(client: Pick<PoolClient, 'query'>, workspaceId: string, properties: PropertyDefinition[],
  ids: string[], preview = databaseRelationPreview): Promise<Map<string, Record<string, RelationCell>>> {
  const cells = new Map<string, Record<string, RelationCell>>();
  if (!ids.length) return cells;
  for (const def of activeProperties(properties)) {
    if (def.type !== 'relation' || !def.relation) continue;
    const propertyId = def.relation.owner ? def.id : def.relation.pairedPropertyId;
    const [self, other] = def.relation.owner ? ['source_row_id', 'target_row_id'] : ['target_row_id', 'source_row_id'];
    const result = await client.query<{ row_id: string; total: number; item_ids: string[]; titles: string[] }>(`
      SELECT l.${self} AS row_id, count(*)::int AS total,
        (array_agg(o.id::text ORDER BY o.sort_position, o.id))[1:${Math.trunc(preview)}] AS item_ids,
        (array_agg(o.title ORDER BY o.sort_position, o.id))[1:${Math.trunc(preview)}] AS titles
      FROM database_row_links l JOIN pages o ON o.workspace_id = l.workspace_id AND o.id = l.${other} AND o.deleted_at IS NULL
      WHERE l.workspace_id = $1 AND l.property_id = $2 AND l.${self} = ANY($3::uuid[]) GROUP BY l.${self}`, [workspaceId, propertyId, ids]);
    for (const row of result.rows) {
      const entry = cells.get(row.row_id) ?? {};
      entry[def.id] = { total: row.total, items: row.item_ids.map((id, index) => ({ id, title: row.titles[index] ?? '' })) };
      cells.set(row.row_id, entry);
    }
  }
  return cells;
}

/** Adds or removes links from either side. The owning rows change, so they get a new revision and a snapshot. */
export async function changeRelation(client: PoolClient, workspaceId: string, actorId: string, databaseId: string, rowId: string, propertyId: string,
  body: ChangeRelationRequest, snapshot: Snapshot): Promise<ChangeRelationResponse> {
  const schema = await activeDatabase(client, workspaceId, databaseId);
  if (!schema) throw new PageError(404, 'NOT_FOUND');
  const def = activeProperties(schema.properties_json).find(item => item.id === propertyId && item.type === 'relation');
  if (!def?.relation) throw new PageError(422, 'PROPERTY_INVALID');
  const current = await client.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND parent_id = $3 AND kind = 'row' AND deleted_at IS NULL`, [workspaceId, rowId, databaseId]);
  if (!current.rows[0]) throw new PageError(404, 'NOT_FOUND');
  const otherDatabaseId = def.relation.databaseId;
  const add = body.add.map(id => id.toLowerCase());
  const remove = body.remove.map(id => id.toLowerCase());
  const others = await client.query<{ id: string }>(`SELECT id FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND parent_id = $3 AND kind = 'row' AND deleted_at IS NULL`,
    [workspaceId, add, otherDatabaseId]);
  if (others.rows.length !== new Set(add).size) throw new PageError(422, 'PROPERTY_INVALID');

  const ownerDatabaseId = def.relation.owner ? databaseId : otherDatabaseId;
  const ownerPropertyId = def.relation.owner ? def.id : def.relation.pairedPropertyId;
  const ownerSchema = ownerDatabaseId === databaseId ? schema : await activeDatabase(client, workspaceId, ownerDatabaseId);
  if (!ownerSchema) throw new PageError(422, 'DATABASE_UNAVAILABLE');
  // Normalised to edits of owning rows: from the owning side one row changes, from the paired side each named row does.
  const edits = new Map<string, { add: string[]; remove: string[] }>();
  if (def.relation.owner) edits.set(rowId, { add, remove });
  else {
    for (const id of add) edits.set(id, { add: [rowId], remove: [] });
    for (const id of remove) edits.set(id, { add: [...(edits.get(id)?.add ?? [])], remove: [rowId] });
  }
  const owners = await client.query<{ id: string; row_properties: RowProperties }>(`SELECT id, row_properties FROM pages
    WHERE workspace_id = $1 AND parent_id = $2 AND id = ANY($3::uuid[]) AND kind = 'row' AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
  [workspaceId, ownerDatabaseId, [...edits.keys()]]);
  const updated = owners.rows.map(owner => {
    const edit = edits.get(owner.id)!;
    const value = owner.row_properties[ownerPropertyId];
    const ids = new Set(Array.isArray(value) ? value : []);
    edit.remove.forEach(id => ids.delete(id));
    edit.add.forEach(id => ids.add(id));
    if (ids.size > databaseRelationLimit) throw new PageError(422, 'PROPERTY_INVALID');
    const values: RowProperties = { ...owner.row_properties };
    if (ids.size) values[ownerPropertyId] = [...ids]; else delete values[ownerPropertyId];
    return { id: owner.id, values };
  });
  const written = updated.length ? await client.query<{ id: string; revision: string; updated_at: Date }>(`
    UPDATE pages p SET row_properties = v.props::jsonb, revision = p.revision + 1, updated_at = now()
    FROM unnest($2::uuid[], $3::text[]) AS v(id, props) WHERE p.workspace_id = $1 AND p.id = v.id
    RETURNING p.id, p.revision::text AS revision, p.updated_at`,
  [workspaceId, updated.map(row => row.id), updated.map(row => JSON.stringify(row.values))]) : { rows: [] };
  await syncRelationLinks(client, workspaceId, ownerSchema.properties_json, updated);
  if (written.rows.length) await snapshot(client, workspaceId, written.rows.map(row => row.id), actorId, 'update');

  const record = await client.query<RowRecord>(`SELECT id, title, icon, row_properties, revision::text AS revision, created_at, updated_at FROM pages WHERE workspace_id = $1 AND id = $2`, [workspaceId, rowId]);
  const row: DatabaseRow = databaseRow(record.rows[0]!);
  const cells = await loadRelationCells(client, workspaceId, schema.properties_json, [rowId]);
  row.relations = cells.get(rowId) ?? {};
  return { pageId: databaseId, row, otherDatabaseId,
    touched: written.rows.map(item => ({ id: item.id, revision: item.revision, updatedAt: item.updated_at.toISOString() })) };
}
