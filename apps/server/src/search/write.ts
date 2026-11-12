import type { PoolClient } from 'pg';
import { pinyinBodyUnitLimit, pinyinTitleUnitLimit, pinyinVector } from './pinyin-index.js';

/**
 * Refreshes derived pinyin keys in the caller's write transaction. The `pages_search_pinyin_reset` trigger
 * has already cleared the keys of whatever title or `search_text` changed; anything a caller does not
 * refill here stays NULL (literal search only) until the background indexer catches up.
 */
export async function refreshPagePinyin(client: Pick<PoolClient, 'query'>, workspaceId: string, pageId: string,
  changed: { title?: string | undefined; searchText?: string | null | undefined }): Promise<void> {
  const title = changed.title === undefined ? null : pinyinVector(changed.title, pinyinTitleUnitLimit);
  const body = changed.searchText == null ? null : pinyinVector(changed.searchText, pinyinBodyUnitLimit);
  if (title === null && body === null) return;
  await client.query(`UPDATE pages SET search_title_pinyin = COALESCE($3::tsvector, search_title_pinyin),
    search_body_pinyin = COALESCE($4::tsvector, search_body_pinyin) WHERE workspace_id = $1 AND id = $2`,
  [workspaceId, pageId, title, body]);
}
