import type { SearchResponse, SearchResult } from '@nbase/contracts';
import type { Pool } from 'pg';
import { findLiteral, lexemeFilter, pinyinSpan, snippetAt, termWindow, type LexemePositions } from './highlight.js';
import { parseSearchQuery, termTsQuery, type ParsedQuery } from './query.js';

/**
 * Relevance tiers, best first: 0 exact title, 1 title prefix, 2 title substring, 3 every term in the title,
 * 4 body phrase, 5 every term in title or body (closeness, then frequency), 6 every term in the title by
 * text or pinyin, 7 every term anywhere by text or pinyin. Tiers 0–2 and 4 are the literal search, so its
 * results are always included. Rows whose pinyin keys are still NULL only reach the literal tiers.
 */
/** Closeness and frequency are scored on this many leading characters, so huge pages cost the same as small ones. */
const scoreChars = 4000;

export const searchSql = `
WITH q AS (SELECT lower($3::text) AS phrase, lower($6::text) AS compact, ARRAY(SELECT lower(t) FROM unnest($7::text[]) t) AS terms)
-- Rank without carrying page text through the sort, then read text only for the returned rows.
, ranked AS (SELECT p.id, r.tier, s.score, p.updated_at
FROM pages p
JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
CROSS JOIN q
CROSS JOIN LATERAL (SELECT lower(p.title) AS lt, lower(p.search_text) AS lb OFFSET 0) x
CROSS JOIN LATERAL (SELECT CASE
  WHEN q.phrase = '' THEN 2
  WHEN x.lt = q.phrase OR x.lt = q.compact THEN 0
  WHEN starts_with(x.lt, q.phrase) OR starts_with(x.lt, q.compact) THEN 1
  WHEN position(q.phrase in x.lt) > 0 OR position(q.compact in x.lt) > 0 THEN 2
  WHEN cardinality(q.terms) > 1 AND NOT EXISTS (SELECT 1 FROM unnest(q.terms) t WHERE position(t in x.lt) = 0) THEN 3
  WHEN position(q.phrase in x.lb) > 0 OR position(q.compact in x.lb) > 0 THEN 4
  WHEN cardinality(q.terms) > 1 AND NOT EXISTS (SELECT 1 FROM unnest(q.terms) t
    WHERE position(t in x.lt) = 0 AND position(t in x.lb) = 0) THEN 5
  WHEN $8::text[] IS NULL THEN NULL
  WHEN p.search_title_pinyin IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest(q.terms, $8::text[]) t(term, tq)
    WHERE position(t.term in x.lt) = 0 AND (t.tq IS NULL OR NOT p.search_title_pinyin @@ t.tq::tsquery)) THEN 6
  WHEN NOT EXISTS (SELECT 1 FROM unnest(q.terms, $8::text[]) t(term, tq)
    WHERE position(t.term in x.lt) = 0 AND position(t.term in x.lb) = 0 AND (t.tq IS NULL
      OR NOT (coalesce(p.search_title_pinyin @@ t.tq::tsquery, false) OR coalesce(p.search_body_pinyin @@ t.tq::tsquery, false)))) THEN 7
  END AS tier OFFSET 0) r
CROSS JOIN LATERAL (SELECT CASE WHEN r.tier = 5 THEN left(x.lb, ${scoreChars}) END AS head OFFSET 0) h
CROSS JOIN LATERAL (SELECT CASE WHEN r.tier = 5 THEN
  (CASE WHEN $9::text IS NOT NULL AND h.head ~ $9 THEN 1000 ELSE 0 END)
  + (SELECT sum(least(50, (length(h.head) - length(replace(h.head, t, ''))) / length(t))) FROM unnest(q.terms) t)
  WHEN r.tier >= 6 THEN
  (CASE WHEN $10::text IS NOT NULL AND (coalesce(p.search_title_pinyin @@ $10::tsquery, false)
    OR (r.tier = 7 AND coalesce(p.search_body_pinyin @@ $10::tsquery, false))) THEN 1000 ELSE 0 END)
  - least(length(p.title), 999)
  ELSE 0 END AS score) s
WHERE p.workspace_id = $1 AND p.deleted_at IS NULL AND r.tier IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM unnest($5::uuid[]) AS required(tag_id)
    WHERE NOT EXISTS (SELECT 1 FROM page_tags pt
      WHERE pt.workspace_id = p.workspace_id AND pt.page_id = p.id AND pt.tag_id = required.tag_id)
  )
ORDER BY r.tier, s.score DESC, p.updated_at DESC, p.id
LIMIT $4)
SELECT p.id, p.parent_id, p.title, p.icon, p.revision::text AS revision, p.updated_at, p.search_text, ranked.tier
FROM ranked JOIN pages p ON p.workspace_id = $1 AND p.id = ranked.id
ORDER BY ranked.tier, ranked.score DESC, ranked.updated_at DESC, p.id`;

const positionsSql = `
SELECT p.id, f.field, u.lexeme, u.positions
FROM pages p
CROSS JOIN LATERAL (VALUES ('title', p.search_title_pinyin), ('body', p.search_body_pinyin)) f(field, vector)
CROSS JOIN LATERAL unnest(f.vector) u
WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[])
  AND (u.lexeme = ANY($3::text[]) OR EXISTS (SELECT 1 FROM unnest($4::text[]) x WHERE starts_with(u.lexeme, x)))`;

interface Row { id: string; parent_id: string | null; title: string; icon: string | null; revision: string;
  updated_at: Date; search_text: string; tier: number }

type Located = Pick<SearchResult, 'snippet' | 'matchField'> & { highlight: string };

async function pinyinPositions(pool: Pool, workspaceId: string, ids: string[], query: ParsedQuery) {
  const byRow = new Map<string, { title: LexemePositions; body: LexemePositions }>();
  if (!ids.length) return byRow;
  const { exact, prefixes } = lexemeFilter(query.joined ? [query.joined, ...query.terms] : query.terms);
  const result = await pool.query<{ id: string; field: 'title' | 'body'; lexeme: string; positions: number[] }>(
    positionsSql, [workspaceId, ids, exact, prefixes]);
  for (const row of result.rows) {
    const entry = byRow.get(row.id) ?? { title: new Map(), body: new Map() };
    entry[row.field].set(row.lexeme, new Set(row.positions));
    byRow.set(row.id, entry);
  }
  return byRow;
}

function locate(row: Row, query: ParsedQuery, positions?: { title: LexemePositions; body: LexemePositions }): Located {
  const { title, search_text: body } = row;
  const terms = query.terms.map(term => term.text);
  const phraseIn = (text: string) => findLiteral(text, query.phrase) >= 0 ? query.phrase : query.compact ?? query.phrase;
  const around = (needle: string) => snippetAt(body, findLiteral(body, needle), needle.length);
  if (row.tier <= 2) { const hl = phraseIn(title); return { matchField: 'title', highlight: hl, snippet: around(hl) }; }
  if (row.tier === 3) {
    const hl = termWindow(title, terms)?.term ?? query.phrase;
    const inBody = termWindow(body, terms);
    return { matchField: 'title', highlight: hl, snippet: inBody ? snippetAt(body, inBody.at, inBody.term.length) : snippetAt(body, -1, 0) };
  }
  if (row.tier === 4) { const hl = phraseIn(body); return { matchField: 'content', highlight: hl, snippet: around(hl) }; }
  const window = termWindow(body, terms);
  if (row.tier === 5 && window) return { matchField: 'content', highlight: window.term, snippet: snippetAt(body, window.at, window.term.length) };
  const pinyinTerms = [...(query.joined ? [query.joined] : []), ...query.terms.filter(term => term.parses.length)];
  const inTitle = positions ? pinyinSpan(title, 'title', pinyinTerms, positions.title) : null;
  const inBody = row.tier === 7 && positions ? pinyinSpan(body, 'body', pinyinTerms, positions.body) : null;
  if (inBody) return { matchField: 'content', highlight: inBody.text, snippet: snippetAt(body, inBody.at, inBody.text.length) };
  if (row.tier === 7 && window) return { matchField: 'content', highlight: window.term, snippet: snippetAt(body, window.at, window.term.length) };
  return { matchField: 'title', highlight: inTitle?.text ?? '', snippet: snippetAt(body, -1, 0) };
}

export async function searchPages(pool: Pool, workspaceId: string, actorId: string, phrase: string, limit: number,
  tagIds: string[]): Promise<SearchResponse> {
  const query = parseSearchQuery(phrase);
  const tsQueries = query.terms.map(termTsQuery);
  const result = await pool.query<Row>(searchSql, [workspaceId, actorId, phrase, limit + 1, tagIds, query.compact,
    query.terms.map(term => term.text), tsQueries.some(Boolean) ? tsQueries : null, query.near,
    query.joined ? termTsQuery(query.joined) : null]);
  const rows = result.rows.slice(0, limit);
  const positions = await pinyinPositions(pool, workspaceId, rows.filter(row => row.tier >= 6).map(row => row.id), query);
  return {
    results: rows.map(row => {
      const located = locate(row, query, positions.get(row.id));
      return { pageId: row.id, title: row.title, icon: row.icon ?? null, parentId: row.parent_id, revision: row.revision,
        updatedAt: row.updated_at.toISOString(), snippet: located.snippet, matchField: located.matchField,
        ...(located.highlight && located.highlight !== phrase ? { highlight: located.highlight } : {}) };
    }),
    truncated: result.rows.length > limit,
  };
}
