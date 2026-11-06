import type { StoredDocumentContent } from '@nbase/contracts';
import type { PoolClient, QueryResult } from 'pg';
import { extractDocumentIndex, type IndexedPageReference } from './search-text.js';

/** Replace the saved source's index, leaving rows unchanged when their target and snippet match. */
export async function replacePageLinks(client: PoolClient, workspaceId: string, sourcePageId: string,
  references: IndexedPageReference[]): Promise<void> {
  if (!references.length) {
    await client.query('DELETE FROM page_links WHERE workspace_id = $1 AND source_page_id = $2', [workspaceId, sourcePageId]);
    return;
  }
  await client.query(`
    WITH known AS (
      SELECT ref.target_page_id, ref.occurrence, ref.snippet
      FROM unnest($3::uuid[], $4::int[], $5::text[]) AS ref(target_page_id, occurrence, snippet)
      JOIN pages target ON target.workspace_id = $1 AND target.id = ref.target_page_id
    ), removed AS (
      DELETE FROM page_links old WHERE old.workspace_id = $1 AND old.source_page_id = $2
        AND NOT EXISTS (SELECT 1 FROM known WHERE known.occurrence = old.occurrence)
    )
    INSERT INTO page_links (workspace_id, source_page_id, target_page_id, occurrence, snippet)
    SELECT $1, $2, target_page_id, occurrence, snippet FROM known
    ON CONFLICT (workspace_id, source_page_id, occurrence)
    DO UPDATE SET target_page_id = EXCLUDED.target_page_id, snippet = EXCLUDED.snippet
    WHERE (page_links.target_page_id, page_links.snippet) IS DISTINCT FROM (EXCLUDED.target_page_id, EXCLUDED.snippet)
  `, [workspaceId, sourcePageId, references.map(ref => ref.targetPageId), references.map(ref => ref.occurrence),
    references.map(ref => ref.snippet)]);
}

/** Backfill derived data from the saved body only, including sources that may later be restored. */
export async function backfillPageLinks(client: PoolClient): Promise<void> {
  type SavedPage = { id: string; workspace_id: string; content_json: StoredDocumentContent };
  let after: string | null = null;
  for (;;) {
    const batch: QueryResult<SavedPage> = await client.query<SavedPage>(`
      SELECT id, workspace_id, content_json FROM pages
      WHERE ($1::uuid IS NULL OR id > $1) AND content_schema_version = 1
        AND content_json @? '$.editorState.root.** ? (@.type == "page-reference")'
      ORDER BY id LIMIT 100`, [after]);
    if (!batch.rows.length) return;
    for (const page of batch.rows) {
      const { references, searchText } = extractDocumentIndex(page.content_json);
      if (!references.length) continue;
      await replacePageLinks(client, page.workspace_id, page.id, references);
      await client.query('UPDATE pages SET search_text = $2 WHERE id = $1', [page.id, searchText]);
    }
    after = batch.rows.at(-1)!.id;
  }
}
