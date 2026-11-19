import type { PageProperty, PropertyDefinition, RowProperties, StoredDocumentContent } from '@nbase/contracts';
import type { Pool } from 'pg';
import { rowIndexText } from '../databases/schema.js';
import { documentIndexText, extractSearchText } from '../pages/search-text.js';

const batchSize = 25;
/** Stored (possibly compressed) bytes of content_json read per batch; a single larger version still goes alone. */
const batchBytes = 8 * 1024 * 1024;

interface PendingVersion { workspace_id: string; page_id: string; revision: string; size: number }
interface VersionContent {
  workspace_id: string; page_id: string; revision: string; content_json: StoredDocumentContent;
  row_properties: RowProperties | null; properties_json: PropertyDefinition[] | null; page_properties: PageProperty[] | null;
}

/**
 * Same text a save of this version would have written to pages.search_text. Row versions take the property
 * definitions their database has now, since versions do not keep the schema they were saved under.
 */
export function versionSearchText(content: StoredDocumentContent, rowProperties: RowProperties | null,
  properties: PropertyDefinition[] | null, pageProperties: PageProperty[] | null = null): string {
  let body: string;
  try { body = extractSearchText(content); } catch { body = ''; }
  if (rowProperties && properties) return rowIndexText(body, properties, rowProperties);
  return documentIndexText(body, pageProperties);
}

/**
 * Derives search text for one batch of versions saved before migration 29. Progress is the NULL column itself, so a
 * restart resumes; only the picked version rows are locked (SKIP LOCKED). Returns false when nothing is waiting.
 */
export async function runHistoryTextBatch(pool: Pool, limit = batchSize): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await client.query<PendingVersion>(`SELECT workspace_id, page_id, revision::text AS revision,
      pg_column_size(content_json) AS size FROM page_versions WHERE search_text IS NULL
      ORDER BY workspace_id, page_id, revision LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    let bytes = 0;
    const picked = pending.rows.filter((row, index) => {
      bytes += row.size;
      return index === 0 || bytes <= batchBytes;
    });
    if (picked.length) {
      const rows = await client.query<VersionContent>(`SELECT h.workspace_id, h.page_id, h.revision::text AS revision,
        h.content_json, h.row_properties, d.properties_json, h.page_properties
        FROM unnest($1::uuid[], $2::uuid[], $3::bigint[]) AS k(workspace_id, page_id, revision)
        JOIN page_versions h ON h.workspace_id = k.workspace_id AND h.page_id = k.page_id AND h.revision = k.revision
        LEFT JOIN databases d ON h.row_properties IS NOT NULL AND d.workspace_id = h.workspace_id AND d.page_id = h.parent_id`,
      [picked.map(row => row.workspace_id), picked.map(row => row.page_id), picked.map(row => row.revision)]);
      await client.query(`UPDATE page_versions h SET search_text = v.text
        FROM unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::text[]) AS v(workspace_id, page_id, revision, text)
        WHERE h.workspace_id = v.workspace_id AND h.page_id = v.page_id AND h.revision = v.revision AND h.search_text IS NULL`, [
        rows.rows.map(row => row.workspace_id), rows.rows.map(row => row.page_id), rows.rows.map(row => row.revision),
        rows.rows.map(row => versionSearchText(row.content_json, row.row_properties, row.properties_json, row.page_properties)),
      ]);
    }
    await client.query('COMMIT');
    return picked.length > 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
