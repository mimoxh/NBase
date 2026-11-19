import { historySearchPendingCap, type HistorySearchMatch, type PageHistorySearchResponse, type PageVersionOperation,
  type WorkspaceHistorySearchResponse } from '@nbase/contracts';
import type { Pool } from 'pg';
import { parseSearchQuery, type ParsedQuery } from './query.js';
import { locate } from './search.js';

/**
 * Tiers 0–5 of the page search (search.ts), over a version's title and search text. History has no pinyin keys,
 * so only the literal and segmented-term tiers apply. A version whose text is not derived yet has '' as its body.
 */
const literalTier = `CASE
  WHEN x.lt = q.phrase OR x.lt = q.compact THEN 0
  WHEN starts_with(x.lt, q.phrase) OR starts_with(x.lt, q.compact) THEN 1
  WHEN position(q.phrase in x.lt) > 0 OR position(q.compact in x.lt) > 0 THEN 2
  WHEN cardinality(q.terms) > 1 AND NOT EXISTS (SELECT 1 FROM unnest(q.terms) t WHERE position(t in x.lt) = 0) THEN 3
  WHEN position(q.phrase in x.lb) > 0 OR position(q.compact in x.lb) > 0 THEN 4
  WHEN cardinality(q.terms) > 1 AND NOT EXISTS (SELECT 1 FROM unnest(q.terms) t
    WHERE position(t in x.lt) = 0 AND position(t in x.lb) = 0) THEN 5
  END`;

const queryCte = `q AS (SELECT lower($3::text) AS phrase, lower($5::text) AS compact, ARRAY(SELECT lower(t) FROM unnest($6::text[]) t) AS terms)`;

/** Characters of search text sent back per match: enough around the first hit for the snippet, never the whole text. */
const excerptChars = 600;
const excerptLead = 200;

// The anchor is found in lower(text) and cut from the original; the lead absorbs the rare case-mapping length change.
const excerptJoins = `
CROSS JOIN LATERAL (SELECT lower(h.search_text) AS lb OFFSET 0) y
CROSS JOIN LATERAL (SELECT greatest(1, coalesce(nullif(position(q.phrase in y.lb), 0), nullif(position(q.compact in y.lb), 0),
  (SELECT min(position(t in y.lb)) FILTER (WHERE position(t in y.lb) > 0) FROM unnest(q.terms) t), 1) - ${excerptLead}) AS start OFFSET 0) e
LEFT JOIN users u ON u.id = h.actor_user_id`;

const matchColumns = `h.revision::text AS revision, h.title, h.saved_at, h.operation, h.deleted_at, h.label, h.note,
  h.actor_user_id, u.login_name, substr(h.search_text, e.start, ${excerptChars}) AS excerpt, e.start,
  coalesce(e.start + ${excerptChars} <= length(h.search_text), false) AS more`;

export const pageHistorySearchSql = `
WITH ${queryCte}
, ranked AS (SELECT h.revision, r.tier
FROM page_versions h
JOIN workspace_memberships m ON m.workspace_id = h.workspace_id AND m.user_id = $2 AND m.removed_at IS NULL
CROSS JOIN q
CROSS JOIN LATERAL (SELECT lower(h.title) AS lt, lower(coalesce(h.search_text, '')) AS lb OFFSET 0) x
CROSS JOIN LATERAL (SELECT ${literalTier} AS tier OFFSET 0) r
WHERE h.workspace_id = $1 AND h.page_id = $7 AND r.tier IS NOT NULL
ORDER BY h.revision DESC
LIMIT $4)
SELECT ${matchColumns}, ranked.tier
FROM ranked
JOIN page_versions h ON h.workspace_id = $1 AND h.page_id = $7 AND h.revision = ranked.revision
CROSS JOIN q
${excerptJoins}
ORDER BY h.revision DESC`;

/**
 * One result per page: its best-tier, newest matching version. Pages whose current state no longer matches come first,
 * since the page search already finds the others. Pages in the trash, databases, and what calendar sources made are
 * left out as in the page search; the tag filter applies to the page's current tags.
 */
export const workspaceHistorySearchSql = `
WITH ${queryCte}
, hits AS (SELECT h.page_id, h.revision, h.saved_at, r.tier
FROM page_versions h
JOIN workspace_memberships m ON m.workspace_id = h.workspace_id AND m.user_id = $2 AND m.removed_at IS NULL
JOIN pages p ON p.workspace_id = h.workspace_id AND p.id = h.page_id
CROSS JOIN q
CROSS JOIN LATERAL (SELECT lower(h.title) AS lt, lower(coalesce(h.search_text, '')) AS lb OFFSET 0) x
CROSS JOIN LATERAL (SELECT ${literalTier} AS tier OFFSET 0) r
WHERE h.workspace_id = $1 AND p.deleted_at IS NULL AND p.kind <> 'database' AND r.tier IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM databases cd WHERE cd.workspace_id = p.workspace_id AND cd.page_id IN (p.id, p.parent_id) AND cd.calendar_hidden)
  AND NOT EXISTS (
    SELECT 1 FROM unnest($7::uuid[]) AS required(tag_id)
    WHERE NOT EXISTS (SELECT 1 FROM page_tags pt
      WHERE pt.workspace_id = p.workspace_id AND pt.page_id = p.id AND pt.tag_id = required.tag_id)
  ))
, best AS (SELECT DISTINCT ON (page_id) page_id, revision, saved_at, tier, count(*) OVER (PARTITION BY page_id) AS matches
FROM hits ORDER BY page_id, tier, revision DESC)
, ranked AS (SELECT b.page_id, b.revision, b.saved_at, b.tier, b.matches, c.still
FROM best b
JOIN pages p ON p.workspace_id = $1 AND p.id = b.page_id
CROSS JOIN q
CROSS JOIN LATERAL (SELECT lower(p.title) AS lt, lower(p.search_text) AS lb OFFSET 0) x
CROSS JOIN LATERAL (SELECT (${literalTier}) IS NOT NULL AS still OFFSET 0) c
ORDER BY c.still, b.tier, b.saved_at DESC, b.page_id
LIMIT $4)
SELECT ranked.page_id, p.title AS page_title, p.icon, p.parent_id, ranked.matches::int AS matches, ranked.still, ranked.tier,
  ${matchColumns}
FROM ranked
JOIN pages p ON p.workspace_id = $1 AND p.id = ranked.page_id
JOIN page_versions h ON h.workspace_id = $1 AND h.page_id = ranked.page_id AND h.revision = ranked.revision
CROSS JOIN q
${excerptJoins}
ORDER BY ranked.still, ranked.tier, ranked.saved_at DESC, ranked.page_id`;

interface MatchRow {
  revision: string; title: string; saved_at: Date; operation: PageVersionOperation; deleted_at: Date | null;
  label: string | null; note: string | null; actor_user_id: string | null; login_name: string | null;
  excerpt: string | null; start: number; more: boolean; tier: number;
}

interface WorkspaceRow extends MatchRow {
  page_id: string; page_title: string; icon: string | null; parent_id: string | null; matches: number; still: boolean;
}

function toMatch(row: MatchRow, query: ParsedQuery): HistorySearchMatch {
  const excerpt = row.excerpt ?? '';
  const located = locate({ title: row.title, search_text: excerpt, tier: row.tier }, query);
  let snippet = located.snippet;
  if (excerpt) {
    if (row.start > 1 && !snippet.startsWith('…')) snippet = `…${snippet}`;
    if (row.more && !snippet.endsWith('…')) snippet = `${snippet}…`;
  }
  return {
    revision: row.revision, title: row.title, savedAt: row.saved_at.toISOString(), operation: row.operation,
    deleted: row.deleted_at !== null, label: row.label ?? null, note: row.note ?? null,
    actor: row.actor_user_id ? { userId: row.actor_user_id, loginName: row.login_name ?? '' } : null,
    snippet, matchField: located.matchField,
    ...(located.highlight && located.highlight !== query.phrase ? { highlight: located.highlight } : {}),
  };
}

function queryParams(query: ParsedQuery): [string | null, string[]] {
  return [query.compact, query.terms.map(term => term.text)];
}

async function pendingVersions(pool: Pool, workspaceId: string, actorId: string, pageId: string | null): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM (
    SELECT 1 FROM page_versions h
    WHERE h.workspace_id = $1 AND ($3::uuid IS NULL OR h.page_id = $3) AND h.search_text IS NULL
      AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL)
    LIMIT $4) pending`, [workspaceId, actorId, pageId, historySearchPendingCap]);
  return result.rows[0]?.count ?? 0;
}

export async function searchPageHistory(pool: Pool, workspaceId: string, actorId: string, pageId: string,
  phrase: string, limit: number): Promise<PageHistorySearchResponse> {
  const query = parseSearchQuery(phrase);
  const [result, pending] = await Promise.all([
    pool.query<MatchRow>(pageHistorySearchSql, [workspaceId, actorId, phrase, limit + 1, ...queryParams(query), pageId]),
    pendingVersions(pool, workspaceId, actorId, pageId),
  ]);
  return { versions: result.rows.slice(0, limit).map(row => toMatch(row, query)), truncated: result.rows.length > limit,
    pendingVersions: pending };
}

export async function searchWorkspaceHistory(pool: Pool, workspaceId: string, actorId: string, phrase: string,
  limit: number, tagIds: string[]): Promise<WorkspaceHistorySearchResponse> {
  const query = parseSearchQuery(phrase);
  const [result, pending] = await Promise.all([
    pool.query<WorkspaceRow>(workspaceHistorySearchSql, [workspaceId, actorId, phrase, limit + 1, ...queryParams(query), tagIds]),
    pendingVersions(pool, workspaceId, actorId, null),
  ]);
  return {
    results: result.rows.slice(0, limit).map(row => ({ pageId: row.page_id, title: row.page_title, icon: row.icon ?? null,
      parentId: row.parent_id, version: toMatch(row, query), matchingVersions: row.matches, currentMatches: row.still })),
    truncated: result.rows.length > limit,
    pendingVersions: pending,
  };
}
