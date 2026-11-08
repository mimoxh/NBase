import { randomUUID } from 'node:crypto';
import { databaseRowLimit, type DatabaseBulkRequest, type DatabaseBulkResponse, type PropertyDefinition, type RowProperties } from '@nbase/contracts';
import type { PoolClient } from 'pg';
import { extractDocumentIndex } from '../pages/search-text.js';
import { PageError } from '../pages/repository.js';
import { loadDatabaseSchema, mergeRowProperties, RowPropertiesError, rowIndexText } from './schema.js';

type RowResult = DatabaseBulkResponse['rows'];
type Snapshot = (client: PoolClient, workspaceId: string, ids: string[], actorId: string, operation: 'create' | 'update' | 'trash') => Promise<void>;

const emptyContent = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0,
  direction: null, children: [] } } };

function merge(properties: PropertyDefinition[], current: RowProperties, patch: Parameters<typeof mergeRowProperties>[2]): RowProperties {
  try { return mergeRowProperties(properties, current, patch); } catch (error) {
    if (error instanceof RowPropertiesError) throw new PageError(422, 'PROPERTY_INVALID');
    throw error;
  }
}

function resultRows(rows: { id: string; revision: string; updated_at: Date }[]): RowResult {
  return rows.map(row => ({ id: row.id, revision: row.revision, updatedAt: row.updated_at.toISOString() }));
}

async function assertRoom(client: PoolClient, workspaceId: string, databaseId: string, adding: number): Promise<void> {
  const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages
    WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL`, [workspaceId, databaseId]);
  if ((count.rows[0]?.n ?? 0) + adding > databaseRowLimit) throw new PageError(409, 'DATABASE_ROW_LIMIT');
}

/** Applies one chunk with set-based statements, so its cost grows with the chunk and not with the database. */
export async function applyBulk(client: PoolClient, workspaceId: string, actorId: string, databaseId: string,
  body: DatabaseBulkRequest, snapshot: Snapshot): Promise<DatabaseBulkResponse> {
  const active = await client.query(`SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND kind = 'database'`,
    [workspaceId, databaseId]);
  const schema = active.rows[0] ? await loadDatabaseSchema(client, workspaceId, databaseId) : null;
  if (!schema) throw new PageError(404, 'NOT_FOUND');
  const properties = schema.properties_json;
  const done = (rows: RowResult): DatabaseBulkResponse => ({ pageId: databaseId, rows });

  if (body.operation === 'create') {
    await assertRoom(client, workspaceId, databaseId, body.rows.length);
    const values = body.rows.map(row => merge(properties, {}, row.properties));
    const inserted = await client.query<{ id: string; revision: string; updated_at: Date }>(`
      INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text, kind, row_properties)
      SELECT v.id, $1, $2, v.title, $3::jsonb, 1, v.search, 'row', v.props::jsonb
      FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[]) WITH ORDINALITY AS v(id, title, search, props, position)
      ORDER BY v.position RETURNING id, revision::text AS revision, updated_at`,
    [workspaceId, databaseId, JSON.stringify(emptyContent), body.rows.map(() => randomUUID()), body.rows.map(row => row.title),
      values.map(value => rowIndexText('', properties, value)), values.map(value => JSON.stringify(value))]);
    await snapshot(client, workspaceId, inserted.rows.map(row => row.id), actorId, 'create');
    return done(resultRows(inserted.rows));
  }

  if (body.operation === 'patch') {
    const searchable = new Set(properties.filter(p => ['text', 'url', 'select', 'multi_select'].includes(p.type)).map(p => p.id));
    // Number, date and checkbox edits leave search text alone, so the row bodies need not be read.
    const touchesSearch = body.items.some(item => Object.keys(item.properties ?? {}).some(id => searchable.has(id)));
    const current = await client.query<{ id: string; title: string; revision: string; row_properties: RowProperties;
      content_json: Parameters<typeof extractDocumentIndex>[0] | null; search_text: string }>(`
      SELECT id, title, revision::text AS revision, row_properties, ${touchesSearch ? 'content_json' : 'NULL::jsonb AS content_json'}, search_text
      FROM pages WHERE workspace_id = $1 AND parent_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NULL AND kind = 'row'
      ORDER BY id FOR UPDATE`, [workspaceId, databaseId, body.items.map(item => item.id)]);
    const byId = new Map(current.rows.map(row => [row.id, row]));
    const merged = body.items.flatMap(item => {
      const row = byId.get(item.id.toLowerCase());
      if (!row) return []; // Trashed meanwhile; the caller re-reads the view.
      if (item.revision !== undefined && item.revision !== row.revision) throw new PageError(409, 'REVISION_CONFLICT', row.revision);
      const values = item.properties ? merge(properties, row.row_properties, item.properties) : row.row_properties;
      const search = item.properties && touchesSearch
        ? rowIndexText(extractDocumentIndex(row.content_json!).searchText, properties, values) : row.search_text;
      return [{ id: row.id, title: item.title ?? row.title, values, search }];
    });
    if (!merged.length) return done([]);
    const updated = await client.query<{ id: string; revision: string; updated_at: Date }>(`
      UPDATE pages p SET title = v.title, row_properties = v.props::jsonb, search_text = v.search, revision = p.revision + 1, updated_at = now()
      FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[]) AS v(id, title, props, search)
      WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.id = v.id
      RETURNING p.id, p.revision::text AS revision, p.updated_at`,
    [workspaceId, databaseId, merged.map(row => row.id), merged.map(row => row.title), merged.map(row => JSON.stringify(row.values)), merged.map(row => row.search)]);
    await snapshot(client, workspaceId, updated.rows.map(row => row.id), actorId, 'update');
    return done(resultRows(updated.rows));
  }

  if (body.operation === 'trash') {
    // Each row is its own deletion group, so it can be restored on its own.
    const trashed = await client.query<{ id: string; revision: string; updated_at: Date }>(`
      UPDATE pages SET deleted_at = now(), deletion_group_id = id, revision = revision + 1, updated_at = now()
      WHERE workspace_id = $1 AND parent_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NULL AND kind = 'row'
      RETURNING id, revision::text AS revision, updated_at`, [workspaceId, databaseId, body.ids]);
    await snapshot(client, workspaceId, trashed.rows.map(row => row.id), actorId, 'trash');
    return done(resultRows(trashed.rows));
  }

  await assertRoom(client, workspaceId, databaseId, body.ids.length);
  const pairs = body.ids.map(id => ({ source: id.toLowerCase(), copy: randomUUID() }));
  const sources = pairs.map(pair => pair.source);
  const copies = pairs.map(pair => pair.copy);
  const inserted = await client.query<{ id: string; revision: string; updated_at: Date }>(`
    INSERT INTO pages (id, workspace_id, parent_id, title, icon, cover, content_json, content_schema_version, search_text, kind, row_properties)
    SELECT v.copy, p.workspace_id, p.parent_id, CASE WHEN btrim(p.title) = '' THEN p.title ELSE left(p.title || ' 副本', 255) END,
      p.icon, p.cover, p.content_json, p.content_schema_version, p.search_text, p.kind, p.row_properties
    FROM unnest($3::uuid[], $4::uuid[]) WITH ORDINALITY AS v(source, copy, position)
    JOIN pages p ON p.workspace_id = $1 AND p.parent_id = $2 AND p.id = v.source AND p.deleted_at IS NULL AND p.kind = 'row'
    ORDER BY v.position RETURNING id, revision::text AS revision, updated_at`, [workspaceId, databaseId, sources, copies]);
  await client.query(`INSERT INTO page_tags (workspace_id, page_id, tag_id)
    SELECT t.workspace_id, v.copy, t.tag_id FROM unnest($2::uuid[], $3::uuid[]) AS v(source, copy)
    JOIN page_tags t ON t.workspace_id = $1 AND t.page_id = v.source JOIN pages p ON p.workspace_id = $1 AND p.id = v.copy`, [workspaceId, sources, copies]);
  await client.query(`INSERT INTO page_links (workspace_id, source_page_id, target_page_id, occurrence, snippet)
    SELECT l.workspace_id, v.copy, l.target_page_id, l.occurrence, l.snippet FROM unnest($2::uuid[], $3::uuid[]) AS v(source, copy)
    JOIN page_links l ON l.workspace_id = $1 AND l.source_page_id = v.source JOIN pages p ON p.workspace_id = $1 AND p.id = v.copy`, [workspaceId, sources, copies]);
  await snapshot(client, workspaceId, inserted.rows.map(row => row.id), actorId, 'create');
  return done(resultRows(inserted.rows));
}
